"""Notifications: renewing tomorrow, charged just now, and never twice.

Push delivery itself is swapped for a list, so these check who would be told
what - not Apple's or Google's push services.
"""

from __future__ import annotations

import os
from datetime import date, timedelta

import pytest

from app import notify
from app.notify import PushGone

from .conftest import USER_A, USER_B, auth
from .test_bank import connect, etransfer_out, plaid, refresh, txn  # noqa: F401 - fixtures

os.environ["VAPID_PUBLIC_KEY"] = "test-public"
os.environ["VAPID_PRIVATE_KEY"] = "test-private"
os.environ["CRON_SECRET"] = "cron-secret"

ENDPOINT = "https://push.example.com/device-a"


@pytest.fixture
def outbox(monkeypatch):
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(notify, "send", lambda device, payload: sent.append((device.endpoint, payload)))
    return sent


def subscribe(client, endpoint=ENDPOINT, headers=None, timezone="America/Toronto"):
    response = client.post(
        "/api/notify/subscribe",
        json={"endpoint": endpoint, "keys": {"p256dh": "p", "auth": "a"}, "timezone": timezone},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def add_sub(client, name, next_date, amount=1649, headers=None):
    response = client.post("/api/bank/subscriptions/custom", json={
        "name": name, "amount_cents": amount, "frequency": "monthly", "next_date": next_date}, headers=headers)
    assert response.status_code == 200, response.text


def run_daily(client, secret="cron-secret"):
    return client.get("/api/notify/daily", headers={"Authorization": f"Bearer {secret}"})


def test_the_public_key_is_open_to_fetch(client):
    body = client.get("/api/notify/config", headers={"Authorization": ""}).json()
    assert body == {"configured": True, "public_key": "test-public"}


def test_only_the_scheduler_can_run_the_daily_job(client, outbox):
    assert run_daily(client, secret="guess").status_code == 401
    assert client.get("/api/notify/daily", headers={"Authorization": ""}).status_code == 401


def test_a_reminder_goes_out_the_day_before_a_renewal_and_only_once(client, outbox, monkeypatch):
    today = date(2026, 11, 2)
    monkeypatch.setattr(notify, "_today_in", lambda tz: today)
    subscribe(client)
    add_sub(client, "Netflix", "2026-11-03")
    add_sub(client, "Crave", "2026-11-10")

    assert run_daily(client).json() == {"users": 1, "sent": 1}
    assert [(e, p["title"], p["body"]) for e, p in outbox] == [
        (ENDPOINT, "Netflix renews tomorrow", "$16.49 will be charged.")
    ]
    assert run_daily(client).json()["sent"] == 0  # a second run that day says nothing new


def test_reminders_go_to_every_device_and_only_their_owner(client, outbox, monkeypatch):
    monkeypatch.setattr(notify, "_today_in", lambda tz: date(2026, 11, 2))
    subscribe(client, "https://push.example.com/phone")
    subscribe(client, "https://push.example.com/laptop")
    subscribe(client, "https://push.example.com/b-phone", headers=auth(USER_B))
    add_sub(client, "Netflix", "2026-11-03")

    run_daily(client)
    assert sorted(e for e, _ in outbox) == ["https://push.example.com/laptop", "https://push.example.com/phone"]


def test_a_device_that_is_gone_is_forgotten(client, monkeypatch):
    monkeypatch.setattr(notify, "_today_in", lambda tz: date(2026, 11, 2))

    def gone(device, payload):
        raise PushGone()

    monkeypatch.setattr(notify, "send", gone)
    subscribe(client)
    add_sub(client, "Netflix", "2026-11-03")
    run_daily(client)
    assert client.post("/api/notify/test").status_code in (409,)


def test_a_new_charge_for_a_subscription_is_announced(client, plaid, outbox):  # noqa: F811
    subscribe(client)
    today = date.today().isoformat()
    add_sub(client, "Netflix", (date.today() + timedelta(days=20)).isoformat())
    plaid.queue(added=[txn("t1", 16.49, today, merchant="Netflix"), txn("t2", 4.5, today, merchant="Cafe")])
    connect(client)

    assert [p["title"] for _, p in outbox] == ["Netflix charged $16.49"]
    assert outbox[0][1]["body"] == "Chase ••1234"


def test_old_charges_from_the_first_import_stay_quiet(client, plaid, outbox):  # noqa: F811
    subscribe(client)
    add_sub(client, "Netflix", date.today().isoformat())
    long_ago = (date.today() - timedelta(days=40)).isoformat()
    plaid.queue(added=[txn("t1", 16.49, long_ago, merchant="Netflix")])
    connect(client)
    assert outbox == []


def test_a_failing_push_never_breaks_the_import(client, plaid, phone, monkeypatch):  # noqa: F811
    def broken(device, payload):
        raise RuntimeError("push service down")

    monkeypatch.setattr(notify, "send", broken)
    subscribe(client)
    add_sub(client, "Netflix", date.today().isoformat())
    plaid.queue(added=[txn("t1", 16.49, date.today().isoformat(), merchant="Netflix")])
    assert connect(client)["imported"]["added"] == 1
    assert any(c["id"] == "plaid-t1" for c in phone.pull())


def test_turning_notifications_off_stops_them(client, outbox):
    subscribe(client)
    assert client.post("/api/notify/test").status_code == 200
    client.post("/api/notify/unsubscribe", json={"endpoint": ENDPOINT})
    assert client.post("/api/notify/test").status_code == 409
    assert len(outbox) == 1


def test_signing_in_as_someone_else_moves_the_device_to_them(client, outbox):
    subscribe(client)
    subscribe(client, headers=auth(USER_B))
    assert client.post("/api/notify/test").status_code == 409            # A: not any more
    assert client.post("/api/notify/test", headers=auth(USER_B)).status_code == 200


@pytest.mark.parametrize("bad", [{"endpoint": "http://insecure.example.com/x"}, {"keys": {"p256dh": "p"}}])
def test_bad_subscriptions_are_refused(client, bad):
    body = {"endpoint": ENDPOINT, "keys": {"p256dh": "p", "auth": "a"}, **bad}
    assert client.post("/api/notify/subscribe", json=body).status_code == 422
