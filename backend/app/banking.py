"""Bank transactions into the ledger.

The import writes through the same sync protocol a phone does: every change is
an op pushed by the device ``bank``, at the entry's current revision. So bank
transactions reach every device on their next pull, and an offline edit made
meanwhile merges with them (or conflicts) exactly as an edit from another phone
would. Nothing here writes to ``entries`` directly.

What one Plaid transaction does:

* **Already known** (seen before, or the posted version of a pending one we
  have): an entry the import made follows the bank's amount and date; an entry
  someone typed in is left alone.
* **New, and it looks like an expense already typed in** - same amount, within
  ``MATCH_WINDOW_DAYS`` - that entry gets the bank label instead of a twin.
* **New otherwise:** a new entry.
* **Removed** (a pending charge that dropped off): an imported entry is
  deleted; a typed-in one just loses its bank label.

Only money going out is imported. Income, refunds and moves between your own
accounts are skipped, and so are credit card payments - the purchases on the
card are already in the ledger, so the payment would count them twice.
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
import statistics
from datetime import date, timedelta
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import BankItem, BankTransaction, Entry
from .plaid import PlaidClient, PlaidError
from .schemas import Op
from .sync import apply_push, utc_now

BANK_DEVICE = "bank"
MATCH_WINDOW_DAYS = 3

# Plaid's personal_finance_category values that aren't spending.
SKIPPED_PRIMARY = {"INCOME", "TRANSFER_IN", "TRANSFER_OUT"}
SKIPPED_DETAILED = {"LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"}

CATEGORY_BY_PRIMARY = {
    "FOOD_AND_DRINK": "eating out",
    "TRANSPORTATION": "transport",
    "TRAVEL": "transport",
    "RENT_AND_UTILITIES": "bills",
    "LOAN_PAYMENTS": "bills",
    "BANK_FEES": "bills",
    "MEDICAL": "health",
    "ENTERTAINMENT": "fun",
    "HOME_IMPROVEMENT": "home",
}

# Logins Plaid can't read until their owner signs in again through Link.
LOGIN_REQUIRED_CODES = {"ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT"}


class BankNotConfigured(RuntimeError):
    pass


# -- access tokens at rest -----------------------------------------------------


def _cipher() -> Fernet:
    secret = os.environ.get("TALLY_SECRET_KEY")
    if not secret:
        raise BankNotConfigured("TALLY_SECRET_KEY is not set, so bank logins can't be stored")
    # Any string works as the secret; Fernet wants 32 url-safe base64 bytes.
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest()))


def seal(access_token: str) -> str:
    return _cipher().encrypt(access_token.encode()).decode()


def unseal(sealed: str) -> str:
    try:
        return _cipher().decrypt(sealed.encode()).decode()
    except InvalidToken:
        raise BankNotConfigured("a stored bank login can't be decrypted: was TALLY_SECRET_KEY changed?") from None


# -- one transaction -----------------------------------------------------------


def _short_id(prefix: str, transaction_id: str) -> str:
    """Op and entry ids are at most 64 characters; Plaid's ids normally fit."""
    candidate = prefix + transaction_id
    if len(candidate) <= 64:
        return candidate
    return prefix + hashlib.sha256(transaction_id.encode()).hexdigest()[:40]


def entry_id_for(transaction_id: str) -> str:
    return _short_id("plaid-", transaction_id)


def is_spending(txn: dict) -> bool:
    if float(txn.get("amount") or 0) <= 0:  # Plaid: positive is money out
        return False
    pfc = txn.get("personal_finance_category") or {}
    return pfc.get("primary") not in SKIPPED_PRIMARY and pfc.get("detailed") not in SKIPPED_DETAILED


def category_for(txn: dict) -> str:
    pfc = txn.get("personal_finance_category") or {}
    if pfc.get("detailed") == "FOOD_AND_DRINK_GROCERIES":
        return "groceries"
    return CATEGORY_BY_PRIMARY.get(pfc.get("primary", ""), "other")


def spent_on(txn: dict) -> str:
    # The day the card was used, not the day it posted, when the bank says.
    return txn.get("authorized_date") or txn["date"]


def cents(txn: dict) -> int:
    return round(float(txn["amount"]) * 100)


def account_label(item: BankItem, account_id: str) -> str:
    account = next((a for a in item.accounts or [] if a.get("account_id") == account_id), None)
    mask = (account or {}).get("mask")
    label = f"{item.institution} ••{mask}" if mask else item.institution or "Bank"
    return label[:60]


def fields_for(txn: dict, label: str) -> dict[str, Any]:
    return {
        "occurred_on": spent_on(txn),
        "amount_cents": cents(txn),
        "category": category_for(txn),
        "merchant": (txn.get("merchant_name") or txn.get("name") or "")[:80].strip(),
        "note": "",
        "bank": label,
    }


# -- matching against expenses typed in by hand --------------------------------


class _Candidates:
    """Typed-in, unlinked, live entries, by amount, for one import run."""

    def __init__(self, session: Session, user_id: str):
        linked = set(
            session.execute(
                select(BankTransaction.entry_id).where(BankTransaction.user_id == user_id)
            ).scalars()
        )
        rows = session.execute(
            select(Entry).where(Entry.user_id == user_id, Entry.deleted.is_(False))
        ).scalars()
        self.by_amount: dict[int, list[Entry]] = {}
        for entry in rows:
            fields = entry.fields or {}
            if entry.id in linked or fields.get("bank") or entry.id.startswith("plaid-"):
                continue
            self.by_amount.setdefault(int(fields.get("amount_cents", 0)), []).append(entry)

    def take(self, amount_cents: int, on: str) -> Entry | None:
        day = date.fromisoformat(on)
        best: tuple[int, Entry] | None = None
        for entry in self.by_amount.get(amount_cents, []):
            try:
                gap = abs((date.fromisoformat(entry.fields["occurred_on"]) - day).days)
            except (KeyError, ValueError):
                continue
            if gap <= MATCH_WINDOW_DAYS and (best is None or gap < best[0]):
                best = (gap, entry)
        if best is None:
            return None
        self.by_amount[amount_cents].remove(best[1])
        return best[1]


# -- one page of /transactions/sync ---------------------------------------------


def apply_page(
    session: Session,
    item: BankItem,
    upserts: list[dict],
    removed_ids: list[str],
    candidates: _Candidates,
) -> dict[str, int]:
    """Turn one page of Plaid changes into ops, and push them.

    Safe to run twice on the same page: a transaction that already has a row
    makes no new op unless the bank changed it, so retrying a sync that died
    halfway through only re-does what didn't land.
    """
    user_id = item.user_id
    now = utc_now()
    counts = {"added": 0, "matched": 0, "updated": 0, "removed": 0}
    ops: list[Op] = []

    wanted = [t["transaction_id"] for t in upserts] + [
        t.get("pending_transaction_id") for t in upserts if t.get("pending_transaction_id")
    ] + list(removed_ids)
    links = {
        row.transaction_id: row
        for row in session.execute(
            select(BankTransaction).where(
                BankTransaction.user_id == user_id,
                BankTransaction.transaction_id.in_(wanted or [""]),
            )
        ).scalars()
    }

    for txn in upserts:
        tid = txn["transaction_id"]
        link = links.get(tid)
        pending_id = txn.get("pending_transaction_id")
        if link is None and pending_id and pending_id in links:
            # The posted version of a pending charge: it takes over the entry,
            # so edits made to the pending one carry across.
            prior = links.pop(pending_id)
            link = BankTransaction(
                user_id=user_id, transaction_id=tid, item_id=item.item_id,
                entry_id=prior.entry_id, matched=prior.matched, pending=False, at=now,
            )
            session.delete(prior)
            session.add(link)
            links[tid] = link

        if link is not None:
            link.pending = bool(txn.get("pending"))
            if link.matched:
                continue  # typed in by hand: their amount and date stand
            entry = session.get(Entry, (user_id, link.entry_id))
            if entry is None or entry.deleted:
                continue
            patch = {
                name: value
                for name, value in (("amount_cents", cents(txn)), ("occurred_on", spent_on(txn)))
                if (entry.fields or {}).get(name) != value
            }
            if patch:
                ops.append(Op(
                    op_id=_short_id(f"pu{entry.rev}-", tid), entry_id=entry.id,
                    kind="update", base_rev=entry.rev, fields=patch,
                ))
                counts["updated"] += 1
            continue

        if not is_spending(txn):
            continue
        fields = fields_for(txn, account_label(item, txn.get("account_id", "")))
        match = candidates.take(fields["amount_cents"], fields["occurred_on"])
        if match is not None:
            link = BankTransaction(
                user_id=user_id, transaction_id=tid, item_id=item.item_id,
                entry_id=match.id, matched=True, pending=bool(txn.get("pending")), at=now,
            )
            ops.append(Op(
                op_id=_short_id("pm-", tid), entry_id=match.id,
                kind="update", base_rev=match.rev, fields={"bank": fields["bank"]},
            ))
            counts["matched"] += 1
        else:
            link = BankTransaction(
                user_id=user_id, transaction_id=tid, item_id=item.item_id,
                entry_id=entry_id_for(tid), matched=False, pending=bool(txn.get("pending")), at=now,
            )
            ops.append(Op(
                op_id=_short_id("pa-", tid), entry_id=link.entry_id,
                kind="create", base_rev=0, fields=fields,
            ))
            counts["added"] += 1
        session.add(link)
        links[tid] = link

    for tid in removed_ids:
        link = links.pop(tid, None)
        if link is None:
            continue  # never imported, or already handed on to its posted version
        session.delete(link)
        entry = session.get(Entry, (user_id, link.entry_id))
        if entry is None or entry.deleted:
            continue
        if link.matched:
            op = Op(op_id=_short_id("pr-", tid), entry_id=entry.id, kind="update",
                    base_rev=entry.rev, fields={"bank": ""})
        else:
            op = Op(op_id=_short_id("pr-", tid), entry_id=entry.id, kind="delete",
                    base_rev=entry.rev)
        ops.append(op)
        counts["removed"] += 1

    apply_push(session, user_id, BANK_DEVICE, ops)  # commits the link rows too
    return counts


def _remember_accounts(item: BankItem, accounts: list[dict]) -> None:
    if not accounts:
        return
    item.accounts = [
        {
            "account_id": a["account_id"],
            "name": a.get("official_name") or a.get("name") or "",
            "mask": a.get("mask") or "",
            "type": a.get("type") or "",
            "subtype": a.get("subtype") or "",
        }
        for a in accounts
    ]


def sync_item(session: Session, plaid: PlaidClient, item: BankItem) -> dict[str, int]:
    """Bring one bank login up to date. Records a broken login on the item."""
    totals = {"added": 0, "matched": 0, "updated": 0, "removed": 0}
    candidates = _Candidates(session, item.user_id)
    access_token = unseal(item.access_token)
    cursor = item.cursor
    restarts = 0

    while True:
        try:
            page = plaid.transactions_sync(access_token, cursor)
        except PlaidError as exc:
            if exc.code == "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" and restarts < 3:
                # Plaid's data moved under us: start again from the saved cursor.
                restarts += 1
                cursor = item.cursor
                continue
            item.status = "login_required" if exc.code in LOGIN_REQUIRED_CODES else "error"
            item.status_detail = exc.message[:500]
            session.commit()
            raise

        _remember_accounts(item, page.get("accounts") or [])
        counts = apply_page(
            session, item,
            (page.get("added") or []) + (page.get("modified") or []),
            [r["transaction_id"] for r in page.get("removed") or []],
            candidates,
        )
        for key, value in counts.items():
            totals[key] += value
        cursor = page.get("next_cursor") or cursor
        if not page.get("has_more"):
            break

    # Saved only once every page is in. A run that dies earlier starts over
    # from the old cursor, and apply_page makes the repeated pages no-ops.
    item.cursor = cursor
    item.status = "ok"
    item.status_detail = ""
    item.last_synced_at = utc_now()
    session.commit()
    return totals


# -- subscriptions and other repeating charges ----------------------------------

PER_MONTH = {
    "weekly": 52 / 12,
    "biweekly": 26 / 12,
    "semi_monthly": 2,
    "monthly": 1,
    "quarterly": 1 / 3,
    "annually": 1 / 12,
}


def _stream(merchant: str, category: str, frequency: str, amount_cents: int,
            last_date: str, next_date: str | None, source: str) -> dict[str, Any]:
    return {
        "merchant": merchant,
        "category": category,
        "frequency": frequency,
        "amount_cents": amount_cents,
        "monthly_cents": round(amount_cents * PER_MONTH.get(frequency, 0)),
        "last_date": last_date,
        "next_date": next_date,
        "source": source,
    }


def plaid_recurring(plaid: PlaidClient, items: list[BankItem]) -> list[dict[str, Any]]:
    """Repeating charges as Plaid sees them. Raises PlaidError if it can't say."""
    streams = []
    for item in items:
        result = plaid.transactions_recurring_get(unseal(item.access_token))
        for stream in result.get("outflow_streams") or []:
            if not stream.get("is_active") or stream.get("status") == "TOMBSTONED":
                continue
            frequency = str(stream.get("frequency", "")).lower()
            if frequency not in PER_MONTH:
                continue
            amount = (stream.get("last_amount") or stream.get("average_amount") or {}).get("amount", 0)
            streams.append(_stream(
                (stream.get("merchant_name") or stream.get("description") or "")[:80],
                category_for(stream), frequency, round(abs(float(amount)) * 100),
                stream.get("last_date", ""), stream.get("predicted_next_date"), "plaid",
            ))
    return streams


# (frequency, typical gap in days, how many charges it takes to believe it)
_CADENCES = [
    ("weekly", 7, 3),
    ("biweekly", 14, 3),
    ("monthly", 30.4, 3),
    ("quarterly", 91, 3),
    ("annually", 365, 2),
]


def _merchant_key(name: str) -> str:
    # "NETFLIX.COM 8443" and "Netflix.com" are the same subscription.
    return re.sub(r"[^a-z]+", " ", name.lower()).strip()


def detect_recurring(entries: list[Entry], today: date | None = None) -> list[dict[str, Any]]:
    """Repeating charges found in the ledger itself: the fallback when Plaid can't say.

    A merchant counts when its charges come at a steady gap (within a quarter of
    one of the cadences above), cost about the same (within 20%), and the next
    one isn't long overdue. Works on typed-in expenses as well as bank ones.
    """
    today = today or date.today()
    groups: dict[str, list[tuple[date, int, dict]]] = {}
    for entry in entries:
        fields = entry.fields or {}
        key = _merchant_key(fields.get("merchant", ""))
        if entry.deleted or not key or int(fields.get("amount_cents", 0)) <= 0:
            continue
        try:
            day = date.fromisoformat(fields["occurred_on"])
        except (KeyError, ValueError):
            continue
        groups.setdefault(key, []).append((day, int(fields["amount_cents"]), fields))

    streams = []
    for charges in groups.values():
        charges.sort(key=lambda c: c[0])
        gaps = [(b[0] - a[0]).days for a, b in zip(charges, charges[1:])]
        if not gaps:
            continue
        gap = statistics.median(gaps)
        cadence = next(
            (c for c in _CADENCES if abs(gap - c[1]) <= c[1] * 0.25 and len(charges) >= c[2]),
            None,
        )
        if cadence is None or any(abs(g - cadence[1]) > cadence[1] * 0.25 for g in gaps):
            continue
        amounts = [c[1] for c in charges]
        typical = statistics.median(amounts)
        if any(abs(a - typical) > typical * 0.2 for a in amounts):
            continue
        last_day, last_amount, fields = charges[-1]
        next_day = last_day + timedelta(days=round(cadence[1]))
        if (today - next_day).days > cadence[1] * 0.5:
            continue  # stopped: the next charge is well overdue
        streams.append(_stream(
            fields.get("merchant", ""), fields.get("category", "other"), cadence[0],
            last_amount, last_day.isoformat(), next_day.isoformat(), "history",
        ))
    return streams
