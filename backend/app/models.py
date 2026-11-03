"""Server-side storage for the sync protocol.

Three tables carry the whole protocol:

``entries``
    Current state of every record, including tombstones. ``rev`` is the
    optimistic-concurrency version; ``server_seq`` is a per-user monotonic
    counter clients use as a pull cursor.

``entry_changes``
    Append-only log of *which fields* changed at each rev. This is what makes
    conflict handling better than last-write-wins: given a client's ``base_rev``
    we can work out exactly what the server changed in the meantime and compare
    it against what the client changed.

``applied_ops``
    Idempotency ledger. A queued write that times out mid-flight gets retried
    with the same ``op_id``; we replay the stored result instead of applying it
    twice.

Every table is keyed by ``user_id`` first. Entry and op ids are made on the
device, so an id alone proves nothing about whose it is - keyed this way, the
same id from two accounts is simply two rows, and no lookup can reach across.

``TALLY_DB_SCHEMA`` puts every table in a Postgres schema of its own. The hosted
app shares a Supabase project with other things, and a schema Supabase's Data
API doesn't expose keeps Tally's rows reachable only through this server.
"""

from __future__ import annotations

import os

from sqlalchemy import JSON, Boolean, Index, Integer, MetaData, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

SCHEMA = os.environ.get("TALLY_DB_SCHEMA") or None


class Base(DeclarativeBase):
    metadata = MetaData(schema=SCHEMA)


class Entry(Base):
    __tablename__ = "entries"
    __table_args__ = (Index("ix_entries_user_seq", "user_id", "server_seq"),)

    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    rev: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    server_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    fields: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_by: Mapped[str] = mapped_column(String(64), nullable=False)

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "rev": self.rev,
            "server_seq": self.server_seq,
            "deleted": self.deleted,
            "fields": dict(self.fields or {}),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "updated_by": self.updated_by,
        }


class EntryChange(Base):
    __tablename__ = "entry_changes"
    __table_args__ = (UniqueConstraint("user_id", "entry_id", "rev", name="uq_entry_rev"),)

    pk: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    entry_id: Mapped[str] = mapped_column(String(64), nullable=False)
    rev: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    changed_fields: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    at: Mapped[str] = mapped_column(String(32), nullable=False)


class AppliedOp(Base):
    __tablename__ = "applied_ops"

    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    op_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    entry_id: Mapped[str] = mapped_column(String(64), nullable=False)
    result: Mapped[dict] = mapped_column(JSON, nullable=False)
    at: Mapped[str] = mapped_column(String(32), nullable=False)


class SyncState(Base):
    """One row per user, holding that user's sequence counter."""

    __tablename__ = "sync_state"

    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class BankItem(Base):
    """One bank login connected through Plaid (an "Item" in Plaid's terms).

    ``access_token`` is encrypted (see banking.py): it reads that login's
    transactions until the Item is removed. ``cursor`` is where the next
    /transactions/sync picks up.
    """

    __tablename__ = "bank_items"

    item_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    institution: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    access_token: Mapped[str] = mapped_column(Text, nullable=False)
    cursor: Mapped[str | None] = mapped_column(Text, nullable=True)
    accounts: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # ok | login_required | revoked | error
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="ok")
    status_detail: Mapped[str] = mapped_column(Text, nullable=False, default="")
    last_synced_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)


class BankTransaction(Base):
    """Which entry a bank transaction became, or was matched to.

    ``matched`` means the entry was typed in by hand and the bank transaction
    was linked to it; otherwise the import created the entry. Pending
    transactions hand their row on to the posted one that replaces them.
    """

    __tablename__ = "bank_transactions"
    __table_args__ = (Index("ix_bank_txn_entry", "user_id", "entry_id"),)

    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    transaction_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    item_id: Mapped[str] = mapped_column(String(64), nullable=False)
    entry_id: Mapped[str] = mapped_column(String(64), nullable=False)
    matched: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    pending: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    at: Mapped[str] = mapped_column(String(32), nullable=False)


class BankSeen(Base):
    """Every transaction a bank has sent, imported or not - money in included.

    This is what transfers between your own accounts are spotted from: money
    leaving one account and the same amount arriving in another. ``amount_cents``
    keeps Plaid's sign, positive for money out.
    """

    __tablename__ = "bank_seen"
    __table_args__ = (Index("ix_bank_seen_amount", "user_id", "amount_cents"),)

    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    transaction_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    item_id: Mapped[str] = mapped_column(String(64), nullable=False)
    account_id: Mapped[str] = mapped_column(String(64), nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    on: Mapped[str] = mapped_column(String(10), nullable=False)
    # The bank's own description, lowercased letters only (see banking.text_key).
    text: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    category: Mapped[str] = mapped_column(String(64), nullable=False, default="")


class TransferRule(Base):
    """"Charges described like this are me moving my own money": never spending."""

    __tablename__ = "transfer_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    pattern: Mapped[str] = mapped_column(String(200), nullable=False)
    label: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)


class CustomSubscription(Base):
    """A repeating charge someone added by hand, alongside the detected ones."""

    __tablename__ = "custom_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    frequency: Mapped[str] = mapped_column(String(16), nullable=False)
    # The renewal date given when it was added; later ones follow from the frequency.
    next_date: Mapped[str] = mapped_column(String(10), nullable=False)
    category: Mapped[str] = mapped_column(String(40), nullable=False, default="other")
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)


class CreditScore(Base):
    """A credit score someone read off their bank or credit bureau app, and when."""

    __tablename__ = "credit_scores"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    score: Mapped[int] = mapped_column(Integer, nullable=False)
    on: Mapped[str] = mapped_column(String(10), nullable=False)
    source: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)


class PushSubscription(Base):
    """One device's permission to be sent notifications (the Web Push subscription)."""

    __tablename__ = "push_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    p256dh: Mapped[str] = mapped_column(String(200), nullable=False)
    auth: Mapped[str] = mapped_column(String(100), nullable=False)
    # The device's time zone, so "renews tomorrow" means tomorrow where they are.
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="UTC")
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)


class NotificationSent(Base):
    """What someone has already been told, so no reminder or charge is sent twice."""

    __tablename__ = "notifications_sent"

    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    at: Mapped[str] = mapped_column(String(32), nullable=False)


class Budget(Base):
    """A monthly spending limit for one category."""

    __tablename__ = "budgets"

    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    category: Mapped[str] = mapped_column(String(40), primary_key=True)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)


class ServerNote(Base):
    """Free-form key/value slot used by the demo endpoints and health checks."""

    __tablename__ = "server_notes"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
