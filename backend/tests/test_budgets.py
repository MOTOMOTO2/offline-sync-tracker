"""Budgets and their alerts, money coming in, and leftovers from disconnected banks."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app import notify

from .conftest import USER_B, Device, auth
from .test_bank import connect, deposit_in, etransfer_out, live, plaid, txn  # noqa: F401 - fixtures
from .test_notify import subscribe

TODAY = date.today().isoformat()
MONTH = TODAY[:7]


@pytest.fixture
def outbox(monkeypatch):
    sent: list[dict] = []
    monkeypatch.setattr(notify, "send", lambda device, payload: sent.append(payload))
    return sent


def set_budget(client, category, cents, headers=None):
    response = client.put(f"/api/budgets/{category}", json={"amount_cents": cents}, headers=headers)
    assert response.status_code == 200, response.text


# -- budgets ---------------------------------------------------------------------------


def test_budgets_are_set_listed_changed_and_removed(client):
    set_budget(client, "eating out", 40000)
    set_budget(client, "groceries", 60000)
    set_budget(client, "eating out", 35000)
    assert client.get("/api/budgets").json()["budgets"] == [
        {"category": "eating out", "amount_cents": 35000},
        {"category": "groceries", "amount_cents": 60000},
    ]
    client.delete("/api/budgets/groceries")
    assert [b["category"] for b in client.get("/api/budgets").json()["budgets"]] == ["eating out"]
    assert client.get("/api/budgets", headers=auth(USER_B)).json()["budgets"] == []


@pytest.mark.parametrize("cents", [0, -5])
def test_a_budget_must_be_positive(client, cents):
    assert client.put("/api/budgets/fun", json={"amount_cents": cents}).status_code == 422


def test_alerts_at_80_and_100_percent_each_once(client, phone, outbox):
    subscribe(client)
    set_budget(client, "eating out", 10000)

    phone.create("a", occurred_on=TODAY, amount_cents=5000, category="eating out")
    assert outbox == []
    phone.create("b", occurred_on=TODAY, amount_cents=3500, category="eating out")      # 85%
    assert [p["title"] for p in outbox] == ["Eating out: 80% of your budget"]
    assert outbox[0]["body"] == "$85.00 of $100.00, $15.00 left this month."
    phone.create("c", occurred_on=TODAY, amount_cents=500, category="eating out")       # 90%: nothing new
    assert len(outbox) == 1
    phone.create("d", occurred_on=TODAY, amount_cents=2000, category="eating out")      # 110%
    assert [p["title"] for p in outbox][-1] == "Eating out is over budget"
    phone.create("e", occurred_on=TODAY, amount_cents=100, category="eating out")
    assert len(outbox) == 2


def test_jumping_straight_past_the_budget_says_so_once(client, phone, outbox):
    subscribe(client)
    set_budget(client, "fun", 5000)
    phone.create("a", occurred_on=TODAY, amount_cents=9000, category="fun")
    assert [p["title"] for p in outbox] == ["Fun is over budget"]


def test_last_months_spending_and_other_categories_dont_count(client, phone, outbox):
    subscribe(client)
    set_budget(client, "fun", 5000)
    last_month = (date.today().replace(day=1) - timedelta(days=1)).isoformat()
    phone.create("old", occurred_on=last_month, amount_cents=9000, category="fun")
    phone.create("other", occurred_on=TODAY, amount_cents=9000, category="groceries")
    assert outbox == []


def test_bank_charges_count_towards_budgets(client, plaid, outbox):  # noqa: F811
    subscribe(client)
    set_budget(client, "shopping", 10000)
    plaid.queue(added=[txn("t1", 95.0, TODAY, merchant="Winners")])
    connect(client)
    assert [p["title"] for p in outbox] == ["Shopping: 80% of your budget"]


def test_one_persons_spending_never_alerts_another(client, outbox):
    subscribe(client)
    set_budget(client, "fun", 5000)
    Device(client, "b-phone", USER_B).create("x", occurred_on=TODAY, amount_cents=9000, category="fun")
    assert outbox == []


# -- money coming in -------------------------------------------------------------------


def test_money_in_separates_income_from_everything_else(client, plaid):  # noqa: F811
    plaid.queue(added=[
        txn("pay", -2400.0, TODAY, merchant="Acme Payroll", primary="INCOME"),
        txn("friend", -30.0, TODAY, merchant="E-Transfer from Sam", primary="TRANSFER_IN"),
        etransfer_out("out", 500.0, TODAY), deposit_in("in", 500.0, TODAY),   # your own money moving
        txn("cardpay", -300.0, TODAY, merchant="Payment thank you", account="card-1",
            primary="LOAN_PAYMENTS"),
        txn("coffee", 4.5, TODAY, merchant="Cafe"),
    ])
    plaid.pages[0]["accounts"].append({"account_id": "card-1", "name": "Visa", "mask": "9", "type": "credit"})
    connect(client)

    items = client.get("/api/bank/money-in").json()["items"]
    assert sorted((i["kind"], i["amount_cents"]) for i in items) == [("income", 240000), ("other", 3000)]
    assert client.get("/api/bank/money-in", headers=auth(USER_B)).json()["items"] == []


def test_a_disconnected_banks_money_in_goes_with_it(client, plaid):  # noqa: F811
    plaid.queue(added=[txn("pay", -999.0, TODAY, primary="INCOME")])
    connect(client)
    client.delete("/api/bank/items/item-pub-1")
    assert client.get("/api/bank/money-in").json()["items"] == []


def test_money_in_only_covers_the_months_asked_for(client, plaid):  # noqa: F811
    old = (date.today() - timedelta(days=200)).isoformat()
    plaid.queue(added=[txn("pay1", -100.0, old, primary="INCOME"), txn("pay2", -100.0, TODAY, primary="INCOME")])
    connect(client)
    assert len(client.get("/api/bank/money-in", params={"months": 1}).json()["items"]) == 1


# -- leftovers from disconnected banks ---------------------------------------------------


def test_leftovers_from_a_disconnected_bank_can_be_cleared(client, plaid, phone):  # noqa: F811
    plaid.queue(added=[txn("t1", 10.0, TODAY, merchant="United Airlines"), txn("t2", 20.0, TODAY)])
    connect(client)
    assert client.get("/api/bank/leftovers").json()["entries"] == []   # still connected

    client.delete("/api/bank/items/item-pub-1")
    plaid.queue(added=[txn("t9", 5.0, TODAY, merchant="Real bank")])
    connect(client, public_token="pub-2", institution="Scotiabank")
    phone.create("typed", occurred_on=TODAY, amount_cents=777)

    body = client.get("/api/bank/leftovers").json()
    assert sorted(e["entry_id"] for e in body["entries"]) == ["plaid-t1", "plaid-t2"]
    assert body["total_cents"] == 3000

    # Asking to remove more than the leftovers removes only the leftovers.
    removed = client.post("/api/bank/leftovers/remove",
                          json={"entry_ids": ["plaid-t1", "plaid-t2", "plaid-t9", "typed"]}).json()
    assert removed == {"removed": 2}
    assert set(live(phone.pull())) == {"plaid-t9", "typed"}
    assert client.post("/api/bank/leftovers/remove", json={"entry_ids": ["plaid-t9"]},
                       headers=auth(USER_B)).json() == {"removed": 0}
