"""The bank endpoints: connect a bank through Plaid Link, keep it synced, list
repeating charges.

New transactions arrive two ways. Plaid calls ``/api/bank/webhook`` when it
has some (a few times a day, depending on the bank), and the app calls
``/api/bank/refresh`` when it opens, in case a webhook was missed. Either way
they land as entries through the sync protocol (see banking.py), so devices
see them on their next pull.

Besides Plaid's own variables (see plaid.py) this needs ``TALLY_SECRET_KEY``,
which encrypts stored bank logins. Optional: ``PLAID_WEBHOOK_URL`` (otherwise
worked out from the request) and ``PLAID_REDIRECT_URI``, which banks that sign
in through their own site (OAuth) need in production; it has to be registered
in the Plaid dashboard and point at this app's ``/``.
"""

from __future__ import annotations

import logging
import os
from datetime import date, datetime, timedelta
from typing import Literal
from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .auth import UserDep
from .banking import (
    BANK_DEVICE,
    BankNotConfigured,
    PER_MONTH,
    apply_transfer_rule,
    balance_sheet,
    bank_text,
    imported_entries,
    next_renewal,
    reads_like_transfer,
    detect_recurring,
    plaid_recurring,
    seal,
    sync_item,
    text_key,
    unseal,
)
from .db import get_session
from .models import BankItem, BankSeen, BankTransaction, CustomSubscription, Entry, TransferRule
from .plaid import PlaidClient, PlaidError, client_from_env
from .schemas import Op
from .sync import apply_push
from .sync import utc_now

log = logging.getLogger("tally.bank")

router = APIRouter(prefix="/api/bank")

SessionDep = Annotated[Session, Depends(get_session)]

# A refresh this soon after the last sync is skipped: Plaid has nothing newer.
REFRESH_AFTER_S = 60


def get_plaid() -> PlaidClient | None:
    return client_from_env()


def require_plaid(plaid: Annotated[PlaidClient | None, Depends(get_plaid)]) -> PlaidClient:
    if plaid is None or not os.environ.get("TALLY_SECRET_KEY"):
        raise HTTPException(status_code=503, detail="connecting banks isn't set up on this server")
    return plaid


PlaidDep = Annotated[PlaidClient, Depends(require_plaid)]


def _item_view(item: BankItem) -> dict:
    return {
        "item_id": item.item_id,
        "institution": item.institution,
        "accounts": [
            {"name": a.get("name", ""), "mask": a.get("mask", ""), "subtype": a.get("subtype", "")}
            for a in item.accounts or []
        ],
        "status": item.status,
        "status_detail": item.status_detail,
        "last_synced_at": item.last_synced_at,
    }


def _items(session: Session, user_id: str) -> list[BankItem]:
    return list(
        session.execute(
            select(BankItem).where(BankItem.user_id == user_id).order_by(BankItem.created_at)
        ).scalars()
    )


def _own_item(session: Session, user_id: str, item_id: str) -> BankItem:
    item = session.get(BankItem, item_id)
    if item is None or item.user_id != user_id:
        raise HTTPException(status_code=404, detail="no such bank connection")
    return item


def _plaid_failure(exc: PlaidError) -> HTTPException:
    log.warning("plaid: %s", exc)
    return HTTPException(status_code=502, detail=f"the bank service said: {exc.message}")


def _webhook_url(request: Request) -> str | None:
    configured = os.environ.get("PLAID_WEBHOOK_URL")
    if configured:
        return configured
    host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    # Plaid only calls https URLs, and localhost is no use to it anyway.
    if proto != "https" or not host or host.startswith(("localhost", "127.")):
        return None
    return f"https://{host}/api/bank/webhook"


@router.get("/status")
def status(
    session: SessionDep,
    user_id: UserDep,
    plaid: Annotated[PlaidClient | None, Depends(get_plaid)],
) -> dict:
    return {
        "configured": plaid is not None and bool(os.environ.get("TALLY_SECRET_KEY")),
        "environment": plaid.env if plaid else None,
        "items": [_item_view(item) for item in _items(session, user_id)],
    }


@router.post("/link-token")
def link_token(
    request: Request,
    session: SessionDep,
    user_id: UserDep,
    plaid: PlaidDep,
    item_id: Annotated[str | None, Body(embed=True)] = None,
) -> dict:
    """A token for Plaid Link. With ``item_id``, for signing back in to that bank."""
    access_token = unseal(_own_item(session, user_id, item_id).access_token) if item_id else None
    try:
        token = plaid.link_token_create(
            user_id,
            webhook=_webhook_url(request),
            redirect_uri=os.environ.get("PLAID_REDIRECT_URI") or None,
            access_token=access_token,
        )
    except PlaidError as exc:
        raise _plaid_failure(exc) from None
    return {"link_token": token}


@router.post("/exchange")
def exchange(
    session: SessionDep,
    user_id: UserDep,
    plaid: PlaidDep,
    public_token: Annotated[str, Body(embed=True, min_length=1, max_length=200)],
    institution: Annotated[str, Body(embed=True, max_length=80)] = "",
) -> dict:
    """Keep the login Link just made, and import what Plaid already has."""
    try:
        access_token, item_id = plaid.exchange_public_token(public_token)
    except PlaidError as exc:
        raise _plaid_failure(exc) from None

    item = session.get(BankItem, item_id)
    if item is not None and item.user_id != user_id:
        raise HTTPException(status_code=409, detail="that bank login belongs to another account")
    if item is None:
        item = BankItem(item_id=item_id, user_id=user_id, created_at=utc_now())
        session.add(item)
    item.institution = institution.strip() or item.institution or "Bank"
    item.access_token = seal(access_token)
    item.status = "ok"
    session.commit()

    # Plaid is often still fetching history at this point; whatever isn't
    # ready yet comes in by webhook, or on the next refresh.
    imported = None
    try:
        imported = sync_item(session, plaid, item)
    except PlaidError as exc:
        log.warning("first sync of %s: %s", item_id, exc)
    return {"item": _item_view(item), "imported": imported}


@router.post("/refresh")
def refresh(
    session: SessionDep,
    user_id: UserDep,
    plaid: PlaidDep,
    force: Annotated[bool, Body(embed=True)] = False,
    from_start: Annotated[bool, Body(embed=True)] = False,
) -> dict:
    """Pull in anything new from every connected bank. A failing bank doesn't stop the others.

    ``from_start`` re-reads each bank's whole history (see ``sync_item``).
    """
    totals = {"added": 0, "matched": 0, "updated": 0, "removed": 0, "transfers": 0}
    now = utc_now()
    for item in _items(session, user_id):
        if item.status == "revoked":
            continue
        if not (force or from_start) and item.last_synced_at and _seconds_between(item.last_synced_at, now) < REFRESH_AFTER_S:
            continue
        try:
            counts = sync_item(session, plaid, item, from_start=from_start)
        except PlaidError as exc:
            log.warning("refresh of %s: %s", item.item_id, exc)
            continue
        for key, value in counts.items():
            totals[key] += value
    return {"imported": totals, "items": [_item_view(item) for item in _items(session, user_id)]}


def _seconds_between(earlier: str, later: str) -> float:
    def parse(value: str) -> datetime:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    return (parse(later) - parse(earlier)).total_seconds()


@router.get("/balances")
def balances(session: SessionDep, user_id: UserDep) -> dict:
    """What you have and what you owe, from each bank's last sync."""
    return balance_sheet([item for item in _items(session, user_id) if item.status != "revoked"])


def _rule_view(rule: TransferRule) -> dict:
    return {"id": rule.id, "label": rule.label, "pattern": rule.pattern, "created_at": rule.created_at}


@router.get("/transfer-rules")
def transfer_rules(session: SessionDep, user_id: UserDep) -> dict:
    rules = session.execute(
        select(TransferRule).where(TransferRule.user_id == user_id).order_by(TransferRule.id)
    ).scalars()
    return {"rules": [_rule_view(rule) for rule in rules]}


def _pattern_for(session: Session, user_id: str, entry: Entry) -> str:
    link = session.execute(
        select(BankTransaction).where(
            BankTransaction.user_id == user_id, BankTransaction.entry_id == entry.id
        )
    ).scalars().first()
    if link is not None:
        return bank_text(session, user_id, link, entry)
    return text_key((entry.fields or {}).get("merchant", ""))


def _brief(entry: Entry) -> dict:
    fields = entry.fields or {}
    return {
        "entry_id": entry.id,
        "merchant": fields.get("merchant", ""),
        "amount_cents": fields.get("amount_cents", 0),
        "occurred_on": fields.get("occurred_on", ""),
        "bank": fields.get("bank", ""),
    }


@router.post("/transfer-rules/preview")
def preview_transfer_rule(
    session: SessionDep,
    user_id: UserDep,
    entry_id: Annotated[str, Body(embed=True, min_length=1, max_length=64)],
) -> dict:
    """What marking this expense a transfer would also take out, before anything is."""
    entry = session.get(Entry, (user_id, entry_id))
    if entry is None:
        raise HTTPException(status_code=404, detail="unknown entry")
    pattern = _pattern_for(session, user_id, entry)
    others = [
        _brief(other)
        for _link, other, text in imported_entries(session, user_id)
        if pattern and pattern in text and other.id != entry_id
    ]
    return {
        "pattern": pattern,
        "others": others,
        "others_total_cents": sum(o["amount_cents"] for o in others),
    }


# How far back the transfer suggestions look.
SUGGEST_DAYS = 90


@router.get("/transfer-suggestions")
def transfer_suggestions(session: SessionDep, user_id: UserDep) -> dict:
    """Imported expenses that read like moving money ("e-Transfer", "TFR"), newest first."""
    since = (date.today() - timedelta(days=SUGGEST_DAYS)).isoformat()
    found = []
    for link, entry, text in imported_entries(session, user_id):
        seen = session.get(BankSeen, (user_id, link.transaction_id))
        if (entry.fields or {}).get("occurred_on", "") < since:
            continue
        if reads_like_transfer(text, seen.category if seen else ""):
            found.append({**_brief(entry), "description": text})
    found.sort(key=lambda f: f["occurred_on"], reverse=True)
    return {"suggestions": found[:30]}


@router.post("/transfer-rules")
def add_transfer_rule(
    session: SessionDep,
    user_id: UserDep,
    entry_id: Annotated[str, Body(embed=True, min_length=1, max_length=64)],
) -> dict:
    """"This expense is me moving my own money": it goes, and so does everything described like it.

    The rule is the bank's own description of the expense, so later ones that
    read the same are never imported.
    """
    entry = session.get(Entry, (user_id, entry_id))
    if entry is None:
        raise HTTPException(status_code=404, detail="unknown entry")
    merchant = (entry.fields or {}).get("merchant", "")
    pattern = _pattern_for(session, user_id, entry)
    if not pattern:
        raise HTTPException(status_code=422, detail="this expense has no description to go by")

    rule = session.execute(
        select(TransferRule).where(TransferRule.user_id == user_id, TransferRule.pattern == pattern)
    ).scalars().first()
    if rule is None:
        rule = TransferRule(user_id=user_id, pattern=pattern, label=(merchant or pattern)[:80],
                            created_at=utc_now())
        session.add(rule)
        session.flush()
    removed = apply_transfer_rule(session, user_id, pattern)

    # The one they pointed at goes even if they'd typed it in themselves.
    session.refresh(entry)
    if not entry.deleted:
        apply_push(session, user_id, BANK_DEVICE, [Op(
            op_id=f"px-{entry.id}-{entry.rev}"[:64], entry_id=entry.id, kind="delete", base_rev=entry.rev,
        )])
        removed += 1
    session.commit()
    return {"rule": _rule_view(rule), "removed": removed}


@router.delete("/transfer-rules/{rule_id}")
def remove_transfer_rule(session: SessionDep, user_id: UserDep, rule_id: int) -> dict:
    """Stop treating these as transfers from now on. What was taken out stays out."""
    rule = session.get(TransferRule, rule_id)
    if rule is None or rule.user_id != user_id:
        raise HTTPException(status_code=404, detail="no such rule")
    session.delete(rule)
    session.commit()
    return {"removed": rule_id}


@router.delete("/items/{item_id}")
def remove_item(session: SessionDep, user_id: UserDep, plaid: PlaidDep, item_id: str) -> dict:
    """Disconnect a bank. Expenses it brought in stay in the ledger."""
    item = _own_item(session, user_id, item_id)
    try:
        plaid.item_remove(unseal(item.access_token))
    except PlaidError as exc:
        if exc.code != "ITEM_NOT_FOUND":
            raise _plaid_failure(exc) from None
    session.execute(
        delete(BankTransaction).where(
            BankTransaction.user_id == user_id, BankTransaction.item_id == item_id
        )
    )
    session.delete(item)
    session.commit()
    return {"removed": item_id}


Frequency = Literal["weekly", "biweekly", "monthly", "quarterly", "annually"]


def _custom_stream(sub: CustomSubscription) -> dict:
    return {
        "id": sub.id,
        "merchant": sub.name,
        "category": sub.category,
        "frequency": sub.frequency,
        "amount_cents": sub.amount_cents,
        "monthly_cents": round(sub.amount_cents * PER_MONTH.get(sub.frequency, 0)),
        "last_date": "",
        "next_date": next_renewal(sub.next_date, sub.frequency),
        "source": "manual",
    }


@router.post("/subscriptions/custom")
def add_subscription(
    session: SessionDep,
    user_id: UserDep,
    name: Annotated[str, Body(embed=True, min_length=1, max_length=80)],
    amount_cents: Annotated[int, Body(embed=True, gt=0, le=100_000_000)],
    frequency: Annotated[Frequency, Body(embed=True)],
    next_date: Annotated[str, Body(embed=True, pattern=r"^\d{4}-\d{2}-\d{2}$")],
    category: Annotated[str, Body(embed=True, max_length=40)] = "other",
) -> dict:
    try:
        date.fromisoformat(next_date)
    except ValueError:
        raise HTTPException(status_code=422, detail="next_date is not a real date") from None
    sub = CustomSubscription(
        user_id=user_id, name=name.strip(), amount_cents=amount_cents, frequency=frequency,
        next_date=next_date, category=category.strip() or "other", created_at=utc_now(),
    )
    session.add(sub)
    session.commit()
    return _custom_stream(sub)


@router.delete("/subscriptions/custom/{sub_id}")
def remove_subscription(session: SessionDep, user_id: UserDep, sub_id: int) -> dict:
    sub = session.get(CustomSubscription, sub_id)
    if sub is None or sub.user_id != user_id:
        raise HTTPException(status_code=404, detail="no such subscription")
    session.delete(sub)
    session.commit()
    return {"removed": sub_id}


@router.get("/subscriptions")
def subscriptions(
    session: SessionDep,
    user_id: UserDep,
    plaid: Annotated[PlaidClient | None, Depends(get_plaid)],
) -> dict:
    """Repeating charges: Plaid's view when it has one, else spotted in the ledger, plus any added by hand."""
    items = [item for item in _items(session, user_id) if item.status != "revoked"]
    streams = None
    if plaid is not None and items:
        try:
            streams = plaid_recurring(plaid, items)
        except (PlaidError, BankNotConfigured) as exc:
            # Recurring transactions is a separate Plaid product, and not every
            # account has it switched on.
            log.info("recurring from plaid unavailable: %s", exc)
    source = "plaid"
    if streams is None:
        entries = session.execute(
            select(Entry).where(Entry.user_id == user_id, Entry.deleted.is_(False))
        ).scalars()
        streams = detect_recurring(list(entries))
        source = "history"
    custom = session.execute(
        select(CustomSubscription).where(CustomSubscription.user_id == user_id)
    ).scalars().all()
    # Added by hand beats detected, for the same merchant.
    yours = {text_key(sub.name) for sub in custom}
    streams = [s for s in streams if text_key(s["merchant"]) not in yours]
    streams += [_custom_stream(sub) for sub in custom]
    streams.sort(key=lambda s: -s["monthly_cents"])
    return {
        "source": source,
        "streams": streams,
        "monthly_total_cents": sum(s["monthly_cents"] for s in streams),
    }


@router.post("/webhook", include_in_schema=False)
async def webhook(
    request: Request,
    session: SessionDep,
    plaid: Annotated[PlaidClient | None, Depends(get_plaid)],
) -> dict:
    """Plaid saying something changed. No sign-in: it's checked by Plaid's signature instead."""
    body = await request.body()
    if plaid is None or not plaid.verify_webhook(body, request.headers.get("plaid-verification")):
        raise HTTPException(status_code=401, detail="not a verified Plaid webhook")

    payload = await request.json()
    item = session.get(BankItem, str(payload.get("item_id", "")))
    if item is None:
        return {"ok": True}  # an Item since removed; nothing to do

    kind = (payload.get("webhook_type"), payload.get("webhook_code"))
    error_code = (payload.get("error") or {}).get("error_code")
    if kind == ("TRANSACTIONS", "SYNC_UPDATES_AVAILABLE"):
        try:
            sync_item(session, plaid, item)
        except PlaidError as exc:
            log.warning("webhook sync of %s: %s", item.item_id, exc)
    elif kind in {("ITEM", "PENDING_EXPIRATION"), ("ITEM", "PENDING_DISCONNECT")} or (
        kind == ("ITEM", "ERROR") and error_code == "ITEM_LOGIN_REQUIRED"
    ):
        item.status = "login_required"
        item.status_detail = "the bank wants you to sign in again"
        session.commit()
    elif kind == ("ITEM", "LOGIN_REPAIRED"):
        item.status = "ok"
        item.status_detail = ""
        session.commit()
    elif kind == ("ITEM", "USER_PERMISSION_REVOKED"):
        item.status = "revoked"
        item.status_detail = "access was withdrawn at the bank"
        session.commit()
    return {"ok": True}
