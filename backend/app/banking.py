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

A move between your own accounts is spotted three ways (see ``_Transfers``):
Plaid calls it a transfer; it matches a transfer rule you made ("charges
described like this are me moving money"); or the same amount leaves one of
your connected accounts and arrives in another within ``TRANSFER_WINDOW_DAYS``,
and one side reads like a transfer. Spotted late - the money arriving after the
charge was imported - the imported entry is deleted.
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

from .models import BankItem, BankSeen, BankTransaction, Entry, EntryChange, TransferRule
from .plaid import PlaidClient, PlaidError
from .schemas import Op
from .sync import apply_push, utc_now

BANK_DEVICE = "bank"
MATCH_WINDOW_DAYS = 3
TRANSFER_WINDOW_DAYS = 4

# Plaid's personal_finance_category values that aren't spending.
SKIPPED_PRIMARY = {"INCOME", "TRANSFER_IN", "TRANSFER_OUT"}
SKIPPED_DETAILED = {"LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"}

CATEGORY_BY_PRIMARY = {
    "FOOD_AND_DRINK": "eating out",
    "TRANSPORTATION": "transport",
    "TRAVEL": "travel",
    "GENERAL_MERCHANDISE": "shopping",
    "RENT_AND_UTILITIES": "bills",
    "LOAN_PAYMENTS": "bills",
    "BANK_FEES": "fees",
    "MEDICAL": "health",
    "PERSONAL_CARE": "personal care",
    "ENTERTAINMENT": "fun",
    "HOME_IMPROVEMENT": "home",
    "GENERAL_SERVICES": "services",
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


def _person_chose_category(session: Session, user_id: str, entry_id: str) -> bool:
    """Whether anyone but the import ever set this entry's category."""
    rows = session.execute(
        select(EntryChange.device_id, EntryChange.changed_fields).where(
            EntryChange.user_id == user_id, EntryChange.entry_id == entry_id
        )
    )
    return any(device != BANK_DEVICE and "category" in (fields or []) for device, fields in rows)


# -- moves between your own accounts --------------------------------------------

# Words a bank uses for moving money: "INTERAC E-TRANSFER", "TFR TO", "TRF".
_TRANSFER_WORDS = {"transfer", "transfers", "tfr", "trf", "interac", "etransfer"}


def text_key(name: str) -> str:
    """Lowercased letters only: "E-TRANSFER 0042 SEND" and "e-Transfer send" read alike."""
    return re.sub(r"[^a-z]+", " ", name.lower()).strip()


def txn_text(txn: dict) -> str:
    return text_key(f"{txn.get('name') or ''} {txn.get('merchant_name') or ''}")[:200]


def _reads_like_transfer(text: str, category: str) -> bool:
    return category.startswith("TRANSFER") or bool(_TRANSFER_WORDS & set(text.split()))


class _Transfers:
    """Decides whether a transaction is just money moving between your own accounts."""

    def __init__(self, session: Session, user_id: str):
        self.session = session
        self.user_id = user_id
        self.patterns = [
            rule.pattern
            for rule in session.execute(
                select(TransferRule).where(TransferRule.user_id == user_id)
            ).scalars()
            if rule.pattern
        ]

    def by_rule(self, text: str) -> bool:
        return any(pattern in text for pattern in self.patterns)

    def counterparts(self, txn: dict) -> list[BankSeen]:
        """Seen transactions on your other accounts for the same money going the other way."""
        amount = cents(txn)
        day = date.fromisoformat(spent_on(txn))
        text = txn_text(txn)
        category = (txn.get("personal_finance_category") or {}).get("primary", "")
        rows = self.session.execute(
            select(BankSeen).where(BankSeen.user_id == self.user_id, BankSeen.amount_cents == -amount)
        ).scalars()
        return [
            row
            for row in rows
            if row.account_id != txn.get("account_id")
            and abs((date.fromisoformat(row.on) - day).days) <= TRANSFER_WINDOW_DAYS
            and (_reads_like_transfer(text, category) or _reads_like_transfer(row.text, row.category))
        ]

    def is_transfer_out(self, txn: dict) -> bool:
        return cents(txn) > 0 and (self.by_rule(txn_text(txn)) or bool(self.counterparts(txn)))


def _remember_seen(session: Session, item: BankItem, upserts: list[dict], removed_ids: list[str]) -> None:
    for txn in upserts:
        session.merge(BankSeen(
            user_id=item.user_id,
            transaction_id=txn["transaction_id"],
            item_id=item.item_id,
            account_id=txn.get("account_id") or "",
            amount_cents=cents(txn),
            on=spent_on(txn),
            text=txn_text(txn),
            category=(txn.get("personal_finance_category") or {}).get("primary", "")[:64],
        ))
    for tid in removed_ids:
        row = session.get(BankSeen, (item.user_id, tid))
        if row is not None:
            session.delete(row)
    session.flush()


def _delete_imported(session: Session, user_id: str, link: BankTransaction, op_prefix: str) -> Op | None:
    """The op that takes an imported entry back out of the ledger, if it's still there."""
    if link.matched:
        return None  # typed in by hand: theirs to delete
    entry = session.get(Entry, (user_id, link.entry_id))
    if entry is None or entry.deleted:
        return None
    return Op(op_id=_short_id(f"{op_prefix}{entry.rev}-", link.transaction_id),
              entry_id=entry.id, kind="delete", base_rev=entry.rev)


def apply_transfer_rule(session: Session, user_id: str, pattern: str) -> int:
    """Take out every imported expense the new rule covers. Returns how many."""
    ops: list[Op] = []
    links = session.execute(
        select(BankTransaction).where(BankTransaction.user_id == user_id)
    ).scalars().all()
    for link in links:
        seen = session.get(BankSeen, (user_id, link.transaction_id))
        if seen is not None:
            text = seen.text
        else:
            # Imported before descriptions were kept: the merchant is what there is.
            entry = session.get(Entry, (user_id, link.entry_id))
            text = text_key((entry.fields or {}).get("merchant", "")) if entry else ""
        if pattern and pattern in text:
            op = _delete_imported(session, user_id, link, "px")
            if op is not None:
                ops.append(op)
    apply_push(session, user_id, BANK_DEVICE, ops)
    return len(ops)


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
    counts = {"added": 0, "matched": 0, "updated": 0, "removed": 0, "transfers": 0}
    ops: list[Op] = []
    transfers = _Transfers(session, user_id)
    _remember_seen(session, item, upserts, removed_ids)

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
            if transfers.is_transfer_out(txn):
                op = _delete_imported(session, user_id, link, "pt")
                if op is not None:
                    ops.append(op)
                    counts["transfers"] += 1
                continue
            entry = session.get(Entry, (user_id, link.entry_id))
            if entry is None or entry.deleted:
                continue
            patch = {
                name: value
                for name, value in (("amount_cents", cents(txn)), ("occurred_on", spent_on(txn)))
                if (entry.fields or {}).get(name) != value
            }
            category = category_for(txn)
            if (entry.fields or {}).get("category") != category and not _person_chose_category(
                session, user_id, entry.id
            ):
                patch["category"] = category
            if patch:
                ops.append(Op(
                    op_id=_short_id(f"pu{entry.rev}-", tid), entry_id=entry.id,
                    kind="update", base_rev=entry.rev, fields=patch,
                ))
                counts["updated"] += 1
            continue

        if cents(txn) < 0:
            # Money arriving. If the same amount left another of your accounts,
            # that charge was a transfer, not spending.
            for row in transfers.counterparts(txn):
                link_out = session.get(BankTransaction, (user_id, row.transaction_id))
                op = _delete_imported(session, user_id, link_out, "pt") if link_out else None
                if op is not None and all(o.op_id != op.op_id for o in ops):
                    ops.append(op)
                    counts["transfers"] += 1
            continue
        if not is_spending(txn):
            continue
        if transfers.is_transfer_out(txn):
            counts["transfers"] += 1
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


def _to_cents(value: Any) -> int | None:
    return None if value is None else round(float(value) * 100)


def _remember_accounts(item: BankItem, accounts: list[dict]) -> None:
    if not accounts:
        return
    item.accounts = [
        {
            "account_id": a["account_id"],
            "name": a.get("name") or a.get("official_name") or "",
            "mask": a.get("mask") or "",
            "type": a.get("type") or "",
            "subtype": a.get("subtype") or "",
            "balance": {
                "current_cents": _to_cents((a.get("balances") or {}).get("current")),
                "available_cents": _to_cents((a.get("balances") or {}).get("available")),
                "limit_cents": _to_cents((a.get("balances") or {}).get("limit")),
                "currency": (a.get("balances") or {}).get("iso_currency_code")
                or (a.get("balances") or {}).get("unofficial_currency_code")
                or "",
            },
        }
        for a in accounts
    ]


# Plaid account types: what's yours, and what you owe.
OWED_TYPES = {"credit", "loan"}


def balance_sheet(items: list[BankItem]) -> dict[str, Any]:
    """Every account's balance, and totals of what you have and what you owe, per currency.

    A credit card or loan's balance is what's owed on it; any other account's
    is money you have. Balances are as of each bank's last sync.
    """
    accounts = []
    totals: dict[str, dict[str, int]] = {}
    for item in items:
        for account in item.accounts or []:
            balance = account.get("balance") or {}
            current = balance.get("current_cents")
            if current is None:
                continue
            owed = account.get("type") in OWED_TYPES
            currency = balance.get("currency") or "CAD"
            total = totals.setdefault(currency, {"have_cents": 0, "owe_cents": 0})
            total["owe_cents" if owed else "have_cents"] += current
            accounts.append({
                "item_id": item.item_id,
                "institution": item.institution,
                "name": account.get("name", ""),
                "mask": account.get("mask", ""),
                "type": account.get("type", ""),
                "subtype": account.get("subtype", ""),
                "owed": owed,
                "current_cents": current,
                "available_cents": balance.get("available_cents"),
                "limit_cents": balance.get("limit_cents"),
                "currency": currency,
                "as_of": item.last_synced_at,
            })
    return {
        "accounts": accounts,
        "totals": [
            {"currency": c, **t, "net_cents": t["have_cents"] - t["owe_cents"]}
            for c, t in sorted(totals.items(), key=lambda kv: -(kv[1]["have_cents"] + kv[1]["owe_cents"]))
        ],
    }


def sync_item(
    session: Session, plaid: PlaidClient, item: BankItem, *, from_start: bool = False
) -> dict[str, int]:
    """Bring one bank login up to date. Records a broken login on the item.

    ``from_start`` reads the whole history again rather than what's new: known
    transactions make no new entries, but pick up anything the import now does
    differently - a finer category, say.
    """
    totals = {"added": 0, "matched": 0, "updated": 0, "removed": 0, "transfers": 0}
    candidates = _Candidates(session, item.user_id)
    access_token = unseal(item.access_token)
    cursor = None if from_start else item.cursor
    start_cursor = cursor
    restarts = 0
    saw_accounts = False

    while True:
        try:
            page = plaid.transactions_sync(access_token, cursor)
        except PlaidError as exc:
            if exc.code == "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" and restarts < 3:
                # Plaid's data moved under us: start again from the saved cursor.
                restarts += 1
                cursor = start_cursor
                continue
            item.status = "login_required" if exc.code in LOGIN_REQUIRED_CODES else "error"
            item.status_detail = exc.message[:500]
            session.commit()
            raise

        _remember_accounts(item, page.get("accounts") or [])
        saw_accounts = saw_accounts or bool(page.get("accounts"))
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
    if not saw_accounts:
        try:
            _remember_accounts(item, plaid.accounts_get(access_token))
        except PlaidError:
            pass  # balances stay as last seen; transactions are what matter here
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
