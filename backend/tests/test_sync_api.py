"""Protocol-level tests for push/pull, conflict detection and idempotency."""

from __future__ import annotations


def test_health_and_meta(client):
    health = client.get("/api/health").json()
    assert health["ok"] is True
    assert health["cursor"] == 0

    meta = client.get("/api/meta").json()
    assert "amount_cents" in meta["fields"]
    assert "groceries" in meta["categories"]


def test_create_then_pull(phone):
    result = phone.create("e1", amount_cents=1250, merchant="Coop", category="groceries")
    assert result["status"] == "applied"
    assert result["entry"]["rev"] == 1
    # Unset fields are filled from the schema defaults so snapshots are complete.
    assert result["entry"]["fields"]["note"] == ""

    changes = phone.pull()
    assert [c["id"] for c in changes] == ["e1"]
    assert changes[0]["fields"]["amount_cents"] == 1250


def test_pull_is_incremental(phone):
    phone.create("e1", amount_cents=100)
    assert len(phone.pull()) == 1
    # Cursor advanced, so nothing comes back a second time.
    assert phone.pull() == []
    phone.create("e2", amount_cents=200)
    assert [c["id"] for c in phone.pull()] == ["e2"]


def test_pull_pagination_reports_has_more(client, phone):
    for index in range(5):
        phone.create(f"e{index}", amount_cents=index)

    body = client.get("/api/sync/pull", params={"since": 0, "limit": 2}).json()
    assert len(body["changes"]) == 2
    assert body["has_more"] is True

    body2 = client.get("/api/sync/pull", params={"since": body["cursor"], "limit": 10}).json()
    assert len(body2["changes"]) == 3
    assert body2["has_more"] is False


def test_replayed_op_is_idempotent(phone):
    """A write that times out in flight gets retried with the same op_id."""
    op = {
        "op_id": "fixed-op-1",
        "entry_id": "e1",
        "kind": "create",
        "base_rev": 0,
        "fields": {"amount_cents": 500},
    }
    first = phone.push([op])[0]
    second = phone.push([op])[0]

    assert first["status"] == "applied"
    assert second["status"] == "applied"
    assert second["duplicate"] is True
    # Crucially: still rev 1. The retry did not create a second revision.
    assert second["entry"]["rev"] == 1
    assert len(phone.pull()) == 1


def test_disjoint_field_edits_auto_merge(phone, laptop):
    phone.create("e1", amount_cents=1000, merchant="Coop", note="")
    base = 1

    # Laptop edits the note while the phone is offline.
    assert laptop.update("e1", base_rev=base, note="split with Sam")["status"] == "applied"

    # Phone comes back and pushes its queued amount edit, still based on rev 1.
    result = phone.update("e1", base_rev=base, amount_cents=1199)
    assert result["status"] == "merged"
    assert result["merged_with"] == ["note"]

    # Both edits survived. Neither side's work was thrown away.
    fields = result["entry"]["fields"]
    assert fields["amount_cents"] == 1199
    assert fields["note"] == "split with Sam"


def test_overlapping_field_edits_conflict(phone, laptop):
    phone.create("e1", amount_cents=1000, merchant="Coop")
    laptop.update("e1", base_rev=1, amount_cents=1500)

    result = phone.update("e1", base_rev=1, amount_cents=1250)
    assert result["status"] == "conflict"

    conflict = result["conflict"]
    assert conflict["reason"] == "field_overlap"
    assert conflict["overlapping_fields"] == ["amount_cents"]
    assert conflict["my_fields"]["amount_cents"] == 1250
    assert conflict["server_fields"]["amount_cents"] == 1500
    assert conflict["server_rev"] == 2

    # Nothing was applied: the server still holds the laptop's value.
    assert result["entry"]["fields"]["amount_cents"] == 1500
    assert result["entry"]["rev"] == 2


def test_conflict_resolution_applies_cleanly(phone, laptop):
    phone.create("e1", amount_cents=1000, merchant="Coop")
    laptop.update("e1", base_rev=1, amount_cents=1500)
    conflict = phone.update("e1", base_rev=1, amount_cents=1250)["conflict"]

    # The user picks their own value; the resolution is based on the rev the
    # server actually holds, so it fast-forwards.
    resolution = phone.push(
        [
            {
                "op_id": "resolve-1",
                "entry_id": "e1",
                "kind": "update",
                "base_rev": conflict["server_rev"],
                "fields": {"amount_cents": 1250},
                "resolves": "phone-a-update-2",
            }
        ]
    )[0]
    assert resolution["status"] == "applied"
    assert resolution["entry"]["fields"]["amount_cents"] == 1250
    assert resolution["entry"]["rev"] == 3


def test_retrying_a_conflicted_op_gives_the_same_answer(phone, laptop):
    """A conflict must be stable, not re-judged against a moving target."""
    phone.create("e1", amount_cents=1000)
    laptop.update("e1", base_rev=1, amount_cents=1500)

    op = {
        "op_id": "stale-op",
        "entry_id": "e1",
        "kind": "update",
        "base_rev": 1,
        "fields": {"amount_cents": 1250},
    }
    first = phone.push([op])[0]
    laptop.update("e1", base_rev=2, note="moved on")
    second = phone.push([op])[0]

    assert first["status"] == "conflict"
    assert second["status"] == "conflict"
    assert second["duplicate"] is True
    assert second["conflict"]["server_rev"] == first["conflict"]["server_rev"]


def test_delete_vs_update_conflicts(phone, laptop):
    phone.create("e1", amount_cents=1000, merchant="Coop")
    laptop.update("e1", base_rev=1, amount_cents=4200)

    # Phone queued a delete back when it only knew rev 1.
    result = phone.delete("e1", base_rev=1)
    assert result["status"] == "conflict"
    assert result["conflict"]["reason"] == "delete_vs_update"
    # It tells you what you would be destroying.
    assert result["conflict"]["overlapping_fields"] == ["amount_cents"]
    assert result["entry"]["deleted"] is False


def test_update_vs_delete_conflicts(phone, laptop):
    phone.create("e1", amount_cents=1000)
    laptop.delete("e1", base_rev=1)

    result = phone.update("e1", base_rev=1, note="receipt in glovebox")
    assert result["status"] == "conflict"
    assert result["conflict"]["reason"] == "update_vs_delete"
    assert result["conflict"]["server_deleted"] is True


def test_restore_brings_back_a_deleted_entry(phone, laptop):
    phone.create("e1", amount_cents=1000, note="keep me")
    laptop.delete("e1", base_rev=1)
    head = laptop.pull()[-1]

    result = phone.push(
        [
            {
                "op_id": "restore-1",
                "entry_id": "e1",
                "kind": "restore",
                "base_rev": head["rev"],
                "fields": {"note": "keep me"},
            }
        ]
    )[0]
    assert result["status"] == "applied"
    assert result["entry"]["deleted"] is False
    assert result["entry"]["fields"]["note"] == "keep me"


def test_deleting_twice_is_not_a_conflict(phone, laptop):
    phone.create("e1", amount_cents=1000)
    laptop.delete("e1", base_rev=1)

    result = phone.delete("e1", base_rev=1)
    assert result["status"] == "applied"
    assert result["entry"]["deleted"] is True


def test_queued_ops_for_one_entry_chain_without_false_conflicts(phone):
    """Several offline edits to one entry all carry the same base_rev."""
    phone.create("e1", amount_cents=1000)
    results = phone.push(
        [
            {
                "op_id": "chain-1",
                "entry_id": "e1",
                "kind": "update",
                "base_rev": 1,
                "fields": {"amount_cents": 1100},
            },
            {
                "op_id": "chain-2",
                "entry_id": "e1",
                "kind": "update",
                "base_rev": 1,
                "fields": {"merchant": "Coop"},
            },
            {
                "op_id": "chain-3",
                "entry_id": "e1",
                "kind": "update",
                "base_rev": 1,
                "fields": {"amount_cents": 1250},
            },
        ]
    )
    assert [r["status"] for r in results] == ["applied", "applied", "applied"]
    assert results[-1]["entry"]["fields"] == {
        **results[-1]["entry"]["fields"],
        "amount_cents": 1250,
        "merchant": "Coop",
    }


def test_later_ops_are_blocked_after_a_conflict(phone, laptop):
    phone.create("e1", amount_cents=1000)
    laptop.update("e1", base_rev=1, amount_cents=9999)

    results = phone.push(
        [
            {
                "op_id": "b-1",
                "entry_id": "e1",
                "kind": "update",
                "base_rev": 1,
                "fields": {"amount_cents": 1111},
            },
            {
                "op_id": "b-2",
                "entry_id": "e1",
                "kind": "update",
                "base_rev": 1,
                "fields": {"note": "second edit"},
            },
            {
                "op_id": "b-3",
                "entry_id": "e2",
                "kind": "create",
                "base_rev": 0,
                "fields": {"amount_cents": 300},
            },
        ]
    )
    assert results[0]["status"] == "conflict"
    assert results[1]["status"] == "blocked"
    # An unrelated entry in the same batch still goes through.
    assert results[2]["status"] == "applied"


def test_invalid_fields_are_rejected(phone):
    bad = phone.push(
        [
            {
                "op_id": "bad-1",
                "entry_id": "e1",
                "kind": "create",
                "base_rev": 0,
                "fields": {"amount_cents": "lots"},
            }
        ]
    )[0]
    assert bad["status"] == "invalid"
    assert "integer" in bad["message"]

    unknown = phone.push(
        [
            {
                "op_id": "bad-2",
                "entry_id": "e2",
                "kind": "create",
                "base_rev": 0,
                "fields": {"colour": "red"},
            }
        ]
    )[0]
    assert unknown["status"] == "invalid"

    bad_date = phone.push(
        [
            {
                "op_id": "bad-3",
                "entry_id": "e3",
                "kind": "create",
                "base_rev": 0,
                "fields": {"occurred_on": "yesterday"},
            }
        ]
    )[0]
    assert bad_date["status"] == "invalid"


def test_update_to_unknown_entry_is_invalid(phone):
    result = phone.update("nope", base_rev=3, note="hi")
    assert result["status"] == "invalid"


def test_creating_an_existing_id_conflicts(phone, laptop):
    phone.create("e1", amount_cents=1000)
    result = laptop.create("e1", amount_cents=2000)
    assert result["status"] == "conflict"
    assert result["conflict"]["reason"] == "create_exists"


def test_claiming_a_future_rev_is_a_conflict(phone):
    phone.create("e1", amount_cents=1000)
    result = phone.update("e1", base_rev=99, note="from the future")
    assert result["status"] == "conflict"
    assert result["conflict"]["reason"] == "diverged"


def test_text_fields_are_trimmed_and_length_checked(phone):
    ok = phone.create("e1", merchant="   Coop   ")
    assert ok["entry"]["fields"]["merchant"] == "Coop"

    too_long = phone.push(
        [
            {
                "op_id": "len-1",
                "entry_id": "e2",
                "kind": "create",
                "base_rev": 0,
                "fields": {"note": "x" * 500},
            }
        ]
    )[0]
    assert too_long["status"] == "invalid"


def test_demo_other_device_endpoints(client, phone):
    phone.create("e1", amount_cents=1000)

    edited = client.post(
        "/api/demo/other-device-edit",
        json={"entry_id": "e1", "fields": {"amount_cents": 7777}},
    )
    assert edited.status_code == 200
    assert edited.json()["result"]["status"] == "applied"

    deleted = client.post("/api/demo/other-device-delete", json={"entry_id": "e1"})
    assert deleted.status_code == 200
    assert deleted.json()["result"]["entry"]["deleted"] is True

    missing = client.post(
        "/api/demo/other-device-edit",
        json={"entry_id": "ghost", "fields": {"amount_cents": 1}},
    )
    assert missing.status_code == 404


def test_unknown_api_route_is_404_not_the_app_shell(client):
    assert client.get("/api/does-not-exist").status_code == 404
