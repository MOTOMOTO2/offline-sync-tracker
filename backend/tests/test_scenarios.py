"""End-to-end stories, written the way they actually happen on a phone.

These read as narratives on purpose: the interesting behaviour of this system is
not any single endpoint, it is what happens to a queue of writes that was built
up with no signal and then lands on a server that moved on without it.
"""

from __future__ import annotations

from .conftest import Device


def test_a_week_offline_then_a_single_sync(client):
    """The ordinary happy path: log things with no signal, sync once, all land."""
    phone = Device(client, "phone")

    queued = [
        {
            "op_id": f"offline-{i}",
            "entry_id": f"e{i}",
            "kind": "create",
            "base_rev": 0,
            "fields": {
                "occurred_on": f"2026-10-0{i + 1}",
                "amount_cents": 500 + i * 125,
                "category": "groceries",
                "merchant": f"Shop {i}",
            },
        }
        for i in range(5)
    ]

    results = phone.push(queued)
    assert all(r["status"] == "applied" for r in results)

    # Everything shows up for a second device on its first ever pull.
    laptop = Device(client, "laptop")
    assert len(laptop.pull()) == 5


def test_both_phones_edit_the_same_expense_offline(client):
    """The case last-write-wins gets wrong, start to finish."""
    phone = Device(client, "phone")
    partner = Device(client, "partner-phone")

    # Logged and synced while both devices were online.
    phone.create("dinner", amount_cents=4200, merchant="Osteria", category="eating out")
    assert [c["id"] for c in partner.pull()] == ["dinner"]

    # Both go offline. The partner finds the receipt and corrects the amount.
    partner_result = partner.update("dinner", base_rev=1, amount_cents=4650)
    assert partner_result["status"] == "applied"

    # The phone, still offline, had typed a different correction.
    phone_result = phone.update("dinner", base_rev=1, amount_cents=4400)
    assert phone_result["status"] == "conflict"

    conflict = phone_result["conflict"]
    assert conflict["reason"] == "field_overlap"
    assert conflict["my_fields"]["amount_cents"] == 4400
    assert conflict["server_fields"]["amount_cents"] == 4650

    # Under last-write-wins the 4650 would now be gone with no trace. Instead
    # the server is untouched and the user gets to choose.
    assert phone.pull()[-1]["fields"]["amount_cents"] == 4650

    # The user keeps the receipt value but adds their note on top.
    resolution = phone.push(
        [
            {
                "op_id": "resolve-dinner",
                "entry_id": "dinner",
                "kind": "update",
                "base_rev": conflict["server_rev"],
                "fields": {"amount_cents": 4650, "note": "receipt in the glovebox"},
                "resolves": conflict.get("op_id", "phone-update-2"),
            }
        ]
    )[0]
    assert resolution["status"] == "applied"
    assert resolution["entry"]["fields"]["amount_cents"] == 4650
    assert resolution["entry"]["fields"]["note"] == "receipt in the glovebox"


def test_two_devices_touch_different_fields_and_both_win(client):
    """Concurrent edits are not automatically a conflict."""
    phone = Device(client, "phone")
    partner = Device(client, "partner-phone")

    phone.create("taxi", amount_cents=1800, merchant="", note="")
    partner.pull()

    # Partner fills in where it was; phone fixes the amount. Disjoint fields.
    assert partner.update("taxi", base_rev=1, merchant="City Cabs")["status"] == "applied"
    phone_result = phone.update("taxi", base_rev=1, amount_cents=2050)

    assert phone_result["status"] == "merged"
    assert phone_result["entry"]["fields"]["merchant"] == "City Cabs"
    assert phone_result["entry"]["fields"]["amount_cents"] == 2050


def test_flaky_connection_retries_do_not_duplicate(client):
    """Push succeeds server-side but the response never arrives; client retries."""
    phone = Device(client, "phone")

    op = {
        "op_id": "coffee-create",
        "entry_id": "coffee",
        "kind": "create",
        "base_rev": 0,
        "fields": {"amount_cents": 380, "merchant": "Kaffi"},
    }

    # Three attempts, as the radio drops in and out.
    statuses = [phone.push([op])[0] for _ in range(3)]
    assert [s["status"] for s in statuses] == ["applied"] * 3
    assert statuses[0].get("duplicate") is None
    assert all(s["duplicate"] for s in statuses[1:])

    # One entry, one revision.
    changes = phone.pull()
    assert len(changes) == 1
    assert changes[0]["rev"] == 1


def test_delete_on_one_device_edit_on_the_other(client):
    """Neither side gets to silently win a delete-versus-edit race."""
    phone = Device(client, "phone")
    partner = Device(client, "partner-phone")

    phone.create("duplicate-charge", amount_cents=999, note="probably a mistake")
    partner.pull()

    # Partner decides it was a genuine charge and annotates it.
    partner.update("duplicate-charge", base_rev=1, note="it was real, bank confirmed")

    # The phone had queued a delete while offline.
    result = phone.delete("duplicate-charge", base_rev=1)
    assert result["status"] == "conflict"
    assert result["conflict"]["reason"] == "delete_vs_update"
    assert "note" in result["conflict"]["overlapping_fields"]
    assert result["entry"]["deleted"] is False

    # User reads the partner's note and drops their delete; to confirm the
    # delete instead they would re-send it against the current rev.
    confirmed = phone.delete("duplicate-charge", base_rev=result["conflict"]["server_rev"])
    assert confirmed["status"] == "applied"
    assert confirmed["entry"]["deleted"] is True

    # The tombstone propagates on the next pull.
    assert partner.pull()[-1]["deleted"] is True
