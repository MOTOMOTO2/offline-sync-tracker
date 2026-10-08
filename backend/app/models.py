"""Server-side storage for the sync protocol.

Three tables carry the whole protocol:

``entries``
    Current state of every record, including tombstones. ``rev`` is the
    optimistic-concurrency version; ``server_seq`` is a global monotonic counter
    clients use as a pull cursor.

``entry_changes``
    Append-only log of *which fields* changed at each rev. This is what makes
    conflict handling better than last-write-wins: given a client's ``base_rev``
    we can work out exactly what the server changed in the meantime and compare
    it against what the client changed.

``applied_ops``
    Idempotency ledger. A queued write that times out mid-flight gets retried
    with the same ``op_id``; we replay the stored result instead of applying it
    twice.
"""

from __future__ import annotations

from sqlalchemy import JSON, Boolean, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Entry(Base):
    __tablename__ = "entries"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    rev: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    server_seq: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
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
    __table_args__ = (UniqueConstraint("entry_id", "rev", name="uq_entry_rev"),)

    pk: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entry_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    rev: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    changed_fields: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    at: Mapped[str] = mapped_column(String(32), nullable=False)


class AppliedOp(Base):
    __tablename__ = "applied_ops"

    op_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    entry_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    result: Mapped[dict] = mapped_column(JSON, nullable=False)
    at: Mapped[str] = mapped_column(String(32), nullable=False)


class SyncState(Base):
    """Single-row table holding the global sequence counter."""

    __tablename__ = "sync_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class ServerNote(Base):
    """Free-form key/value slot used by the demo endpoints and health checks."""

    __tablename__ = "server_notes"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
