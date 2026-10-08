"""The sync protocol: push with explicit conflict detection, and cursor pull.

Design notes
------------
Every write a client makes is an *op* carrying a ``base_rev``: "I am changing
this entry, and the newest version I had seen was rev N". The server compares
that against the entry's current rev and takes one of four paths:

* ``applied``  - base_rev matched. Clean fast-forward.
* ``merged``   - base_rev was stale, but the fields the server changed in the
                 meantime and the fields the client changed are disjoint, so
                 both edits survive. A real merge, not a pick.
* ``conflict`` - both sides touched the same fields, or one side deleted while
                 the other edited. Nothing is applied; the client is handed both
                 versions and has to resolve explicitly.
* ``invalid``  - malformed or nonsensical (unknown entry, bad field value).

Nothing here ever silently drops a write, which is the whole point. A
last-write-wins server would happily accept every op above and quietly destroy
whichever edit lost the race.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .models import AppliedOp, Entry, EntryChange, SyncState
from .schemas import FieldValidationError, Op, default_fields, validate_patch


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def next_seq(session: Session) -> int:
    """Hand out the next global sequence number.

    UPDATE ... RETURNING keeps this atomic even if two devices push at the same
    moment, which matters because the sequence doubles as every client's pull
    cursor - a gap or a reuse would make a client silently miss a change.
    """
    row = session.execute(
        text("UPDATE sync_state SET seq = seq + 1 WHERE id = 1 RETURNING seq")
    ).first()
    if row is None:  # first ever write
        session.add(SyncState(id=1, seq=1))
        session.flush()
        return 1
    return int(row[0])


def current_seq(session: Session) -> int:
    state = session.get(SyncState, 1)
    return int(state.seq) if state else 0


def _changes_since(
    session: Session, entry_id: str, base_rev: int
) -> tuple[set[str], bool, list[str]]:
    """What did the server do to this entry after base_rev?

    Returns (changed field names, whether a delete landed, devices involved).
    """
    rows = (
        session.execute(
            select(EntryChange)
            .where(EntryChange.entry_id == entry_id, EntryChange.rev > base_rev)
            .order_by(EntryChange.rev)
        )
        .scalars()
        .all()
    )

    changed: set[str] = set()
    deleted = False
    devices: list[str] = []
    for row in rows:
        changed.update(row.changed_fields or [])
        if row.kind == "delete":
            deleted = True
        elif row.kind == "restore":
            deleted = False
        if row.device_id not in devices:
            devices.append(row.device_id)
    return changed, deleted, devices


def _record_change(
    session: Session,
    entry: Entry,
    kind: str,
    changed_fields: list[str],
    device_id: str,
    at: str,
) -> None:
    session.add(
        EntryChange(
            entry_id=entry.id,
            rev=entry.rev,
            kind=kind,
            changed_fields=sorted(changed_fields),
            device_id=device_id,
            at=at,
        )
    )


def _conflict(
    op: Op,
    entry: Entry,
    reason: str,
    overlapping: list[str] | None = None,
    server_changed: list[str] | None = None,
    message: str = "",
) -> dict[str, Any]:
    return {
        "op_id": op.op_id,
        "entry_id": op.entry_id,
        "status": "conflict",
        "entry": entry.snapshot(),
        "conflict": {
            "reason": reason,
            "base_rev": op.base_rev,
            "server_rev": entry.rev,
            "server_deleted": entry.deleted,
            "server_fields": dict(entry.fields or {}),
            "server_updated_at": entry.updated_at,
            "server_updated_by": entry.updated_by,
            "my_kind": op.kind,
            "my_fields": dict(op.fields or {}),
            "my_changed_fields": sorted((op.fields or {}).keys()),
            "server_changed_fields": sorted(server_changed or []),
            "overlapping_fields": sorted(overlapping or []),
        },
        "message": message,
    }


def _ok(op: Op, entry: Entry, status: str, message: str = "", **extra: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "op_id": op.op_id,
        "entry_id": op.entry_id,
        "status": status,
        "entry": entry.snapshot(),
        "conflict": None,
        "message": message,
    }
    result.update(extra)
    return result


def _invalid(op: Op, message: str) -> dict[str, Any]:
    return {
        "op_id": op.op_id,
        "entry_id": op.entry_id,
        "status": "invalid",
        "entry": None,
        "conflict": None,
        "message": message,
    }


def apply_push(session: Session, device_id: str, ops: list[Op]) -> list[dict[str, Any]]:
    """Apply a batch of queued client ops, in order, returning a result per op."""
    results: list[dict[str, Any]] = []

    # The rev an entry sat at when *this batch* first touched it. A client that
    # was offline for a while may queue several ops for one entry, all stamped
    # with the same base_rev; without this, the second op would look stale
    # against the rev its own predecessor had just created.
    batch_origin_rev: dict[str, int] = {}
    # Once an entry conflicts we stop processing later ops for it - they were
    # authored against a version the user is about to reconcile by hand.
    blocked: set[str] = set()

    for op in ops:
        prior = session.get(AppliedOp, op.op_id)
        if prior is not None:
            replay = dict(prior.result)
            replay["duplicate"] = True
            results.append(replay)
            continue

        if op.entry_id in blocked:
            results.append(
                {
                    "op_id": op.op_id,
                    "entry_id": op.entry_id,
                    "status": "blocked",
                    "entry": None,
                    "conflict": None,
                    "message": "an earlier op for this entry conflicted; resolve that first",
                }
            )
            continue

        try:
            patch = validate_patch(op.fields or {})
        except FieldValidationError as exc:
            results.append(_invalid(op, str(exc)))
            continue

        result = _apply_one(session, device_id, op, patch, batch_origin_rev)

        if result["status"] == "conflict":
            blocked.add(op.entry_id)
        if result["status"] in {"applied", "merged", "conflict"}:
            # Conflicts go in the ledger too: a retry of the same op must get
            # the same answer rather than be re-judged against a moved target.
            session.add(
                AppliedOp(
                    op_id=op.op_id,
                    device_id=device_id,
                    entry_id=op.entry_id,
                    result=result,
                    at=utc_now(),
                )
            )
        results.append(result)

    session.commit()
    return results


def _apply_one(
    session: Session,
    device_id: str,
    op: Op,
    patch: dict[str, Any],
    batch_origin_rev: dict[str, int],
) -> dict[str, Any]:
    now = utc_now()
    entry = session.get(Entry, op.entry_id)

    if op.kind == "create":
        if entry is not None:
            return _conflict(
                op,
                entry,
                reason="create_exists",
                overlapping=sorted(set(patch) & set(entry.fields or {})),
                server_changed=sorted((entry.fields or {}).keys()),
                message="an entry with this id already exists on the server",
            )
        fields = default_fields()
        fields.update(patch)
        entry = Entry(
            id=op.entry_id,
            rev=1,
            server_seq=next_seq(session),
            deleted=False,
            fields=fields,
            created_at=now,
            updated_at=now,
            updated_by=device_id,
        )
        session.add(entry)
        session.flush()
        batch_origin_rev.setdefault(op.entry_id, 0)
        _record_change(session, entry, "create", list(fields.keys()), device_id, now)
        return _ok(op, entry, "applied")

    if entry is None:
        return _invalid(op, "entry does not exist on the server")

    origin_rev = batch_origin_rev.setdefault(op.entry_id, entry.rev)
    # Either the client is current, or the only revs it is missing are ones this
    # very batch just created.
    fast_forward = op.base_rev == entry.rev or op.base_rev == origin_rev

    if op.base_rev > entry.rev:
        return _conflict(
            op,
            entry,
            reason="diverged",
            server_changed=sorted((entry.fields or {}).keys()),
            message="client claims a revision the server never issued",
        )

    server_changed, deleted_since, _devices = _changes_since(session, op.entry_id, op.base_rev)

    if op.kind == "delete":
        if entry.deleted:
            # Already gone, so the intent is satisfied. No point manufacturing a
            # conflict the user would have to click through for nothing.
            return _ok(op, entry, "applied", message="entry was already deleted")
        if not fast_forward:
            return _conflict(
                op,
                entry,
                reason="delete_vs_update",
                overlapping=sorted(server_changed),
                server_changed=sorted(server_changed),
                message="another device edited this entry after you deleted it",
            )
        entry.deleted = True
        entry.rev += 1
        entry.server_seq = next_seq(session)
        entry.updated_at = now
        entry.updated_by = device_id
        session.flush()
        _record_change(session, entry, "delete", [], device_id, now)
        return _ok(op, entry, "applied")

    if op.kind == "restore":
        if not fast_forward:
            return _conflict(
                op,
                entry,
                reason="diverged",
                overlapping=sorted(set(patch) & server_changed),
                server_changed=sorted(server_changed),
                message="the entry changed again before your restore arrived",
            )
        fields = dict(entry.fields or {})
        fields.update(patch)
        entry.fields = fields
        entry.deleted = False
        entry.rev += 1
        entry.server_seq = next_seq(session)
        entry.updated_at = now
        entry.updated_by = device_id
        session.flush()
        _record_change(session, entry, "restore", list(patch.keys()), device_id, now)
        return _ok(op, entry, "applied")

    # ---- update ----------------------------------------------------------
    if entry.deleted:
        if fast_forward:
            return _invalid(op, "entry is deleted; send a restore op to bring it back")
        return _conflict(
            op,
            entry,
            reason="update_vs_delete",
            overlapping=sorted(patch.keys()),
            server_changed=sorted(server_changed),
            message="another device deleted this entry while you were editing it",
        )

    if deleted_since and not fast_forward:
        return _conflict(
            op,
            entry,
            reason="update_vs_delete",
            overlapping=sorted(patch.keys()),
            server_changed=sorted(server_changed),
            message="this entry was deleted and brought back while you were offline",
        )

    if not fast_forward:
        overlapping = set(patch) & server_changed
        if overlapping:
            return _conflict(
                op,
                entry,
                reason="field_overlap",
                overlapping=sorted(overlapping),
                server_changed=sorted(server_changed),
                message="you and another device changed the same fields",
            )
        # Disjoint edits, so keep both. The server's concurrent change stays put
        # and the client's lands on top of it.
        fields = dict(entry.fields or {})
        fields.update(patch)
        entry.fields = fields
        entry.rev += 1
        entry.server_seq = next_seq(session)
        entry.updated_at = now
        entry.updated_by = device_id
        session.flush()
        _record_change(session, entry, "update", list(patch.keys()), device_id, now)
        return _ok(
            op,
            entry,
            "merged",
            message="merged with concurrent changes to other fields",
            merged_with=sorted(server_changed),
        )

    fields = dict(entry.fields or {})
    fields.update(patch)
    entry.fields = fields
    entry.rev += 1
    entry.server_seq = next_seq(session)
    entry.updated_at = now
    entry.updated_by = device_id
    session.flush()
    _record_change(session, entry, "update", list(patch.keys()), device_id, now)
    return _ok(op, entry, "applied")


def pull_changes(session: Session, since: int, limit: int) -> dict[str, Any]:
    """Everything that changed after cursor ``since``, tombstones included."""
    rows = (
        session.execute(
            select(Entry)
            .where(Entry.server_seq > since)
            .order_by(Entry.server_seq)
            .limit(limit + 1)
        )
        .scalars()
        .all()
    )

    has_more = len(rows) > limit
    page = rows[:limit]
    cursor = page[-1].server_seq if page else since

    return {
        "server_time": utc_now(),
        "cursor": int(cursor),
        "has_more": has_more,
        "changes": [row.snapshot() for row in page],
    }
