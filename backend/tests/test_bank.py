"""Bank transactions: import, matching typed-in expenses, pending charges
posting, webhooks, and repeating charges.

Plaid itself is replaced by ``FakePlaid``, which hands out scripted pages of
/transactions/sync. Everything after that - the ops, the protocol, the pull a
phone does - is the real thing.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import date, timedelta

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from app.bank_api import get_plaid
from app.banking import detect_recurring
from app.main import app
from app.models import Entry
from app.plaid import PlaidClient, PlaidError

from .conftest import USER_B, Device, auth

os.environ["TALLY_SECRET_KEY"] = "test-key-for-sealing-bank-logins"


def txn(tid, amount, day, *, merchant="Corner Shop", pending=False, pending_id=None,
        primary="GENERAL_MERCHANDISE", detailed="", account="acc-1"):
    return {
        "transaction_id": tid,
        "account_id": account,
        "amount": amount,
        "date": day,
        "authorized_date": day,
        "merchant_name": merchant,
        "name": merchant.upper(),
        "pending": pending,
        "pending_transaction_id": pending_id,
        "personal_finance_category": {"primary": primary, "detailed": detailed},
    }


class FakePlaid(PlaidClient):
    def __init__(self):
        super().__init__("client", "secret", "sandbox")
        self.pages: list[dict] = []
        self.recurring: dict | PlaidError = PlaidError("PRODUCT_NOT_ENABLED", "not enabled")
        self.removed_items: list[str] = []
        self.signing_key = ec.generate_private_key(ec.SECP256R1())
        self.item_counter = 0

    # Link and items
    def link_token_create(self, user_id, **kwargs):
        self.last_link = {"user_id": user_id, **kwargs}
        return "link-sandbox-token"

    def exchange_public_token(self, public_token):
        self.item_counter += 1
        return f"access-{public_token}", f"item-{public_token}"

    def item_remove(self, access_token):
        self.removed_items.append(access_token)

    # Transactions
    def queue(self, added=(), modified=(), removed=(), *, has_more=False):
        self.pages.append({
            "added": list(added), "modified": list(modified),
            "removed": [{"transaction_id": t} for t in removed],
            "accounts": [{"account_id": "acc-1", "name": "Checking", "mask": "1234",
                          "type": "depository", "subtype": "checking"}],
            "has_more": has_more,
        })

    def transactions_sync(self, access_token, cursor, count=250):
        assert access_token.startswith("access-"), "token should be unsealed before use"
        if not self.pages:
            return {"added": [], "modified": [], "removed": [], "accounts": [],
                    "has_more": False, "next_cursor": cursor or "c0"}
        page = self.pages.pop(0)
        return {**page, "next_cursor": f"c-{len(self.pages)}-{time.time_ns()}"}

    def transactions_recurring_get(self, access_token):
        if isinstance(self.recurring, PlaidError):
            raise self.recurring
        return self.recurring

    # Webhooks, signed with our own key the way Plaid signs with theirs
    def webhook_key(self, key_id):
        jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(self.signing_key.public_key()))
        return {**jwk, "alg": "ES256", "kid": key_id, "expired_at": None}

    def sign(self, body: bytes, *, iat=None, key=None) -> str:
        return jwt.encode(
            {"iat": iat or int(time.time()), "request_body_sha256": hashlib.sha256(body).hexdigest()},
            key or self.signing_key, algorithm="ES256", headers={"kid": "k1"},
        )


@pytest.fixture
def plaid(client):
    fake = FakePlaid()
    app.dependency_overrides[get_plaid] = lambda: fake
    yield fake
    app.dependency_overrides.pop(get_plaid, None)


def connect(client, public_token="pub-1", institution="Chase", headers=None):
    response = client.post(
        "/api/bank/exchange",
        json={"public_token": public_token, "institution": institution},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def refresh(client, headers=None):
    response = client.post("/api/bank/refresh", json={"force": True}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["imported"]


def live(changes):
    return {c["id"]: c for c in changes if not c["deleted"]}


# -- connecting ------------------------------------------------------------------


def test_status_says_when_the_server_has_no_plaid_keys(client):
    app.dependency_overrides[get_plaid] = lambda: None
    try:
        body = client.get("/api/bank/status").json()
        assert body == {"configured": False, "environment": None, "items": []}
        assert client.post("/api/bank/link-token", json={}).status_code == 503
    finally:
        app.dependency_overrides.pop(get_plaid, None)


def test_bank_routes_need_a_sign_in(client, plaid):
    for method, path in [("get", "/api/bank/status"), ("post", "/api/bank/refresh"),
                         ("get", "/api/bank/subscriptions"), ("post", "/api/bank/link-token")]:
        kwargs = {"json": {}} if method == "post" else {}
        assert getattr(client, method)(path, headers={"Authorization": ""}, **kwargs).status_code == 401


def test_connecting_imports_spending_and_skips_everything_else(client, plaid, phone):
    plaid.queue(added=[
        txn("t1", 12.5, "2026-10-01", merchant="Whole Foods", detailed="FOOD_AND_DRINK_GROCERIES",
            primary="FOOD_AND_DRINK"),
        txn("t2", 40.0, "2026-10-02", merchant="Uber", primary="TRANSPORTATION"),
        txn("pay", -2000.0, "2026-10-01", merchant="Payroll", primary="INCOME"),
        txn("cc", 300.0, "2026-10-03", merchant="Card payment", primary="LOAN_PAYMENTS",
            detailed="LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"),
        txn("mv", 100.0, "2026-10-03", merchant="To savings", primary="TRANSFER_OUT"),
        txn("refund", -5.0, "2026-10-04", merchant="Amazon"),
    ])
    body = connect(client)

    assert body["imported"] == {"added": 2, "matched": 0, "updated": 0, "removed": 0, "transfers": 0}
    assert body["item"]["institution"] == "Chase"
    assert body["item"]["accounts"] == [{"name": "Checking", "mask": "1234", "subtype": "checking"}]

    entries = live(phone.pull())
    assert set(entries) == {"plaid-t1", "plaid-t2"}
    assert entries["plaid-t1"]["fields"] == {
        "occurred_on": "2026-10-01", "amount_cents": 1250, "category": "groceries",
        "merchant": "Whole Foods", "note": "", "bank": "Chase ••1234",
    }
    assert entries["plaid-t2"]["fields"]["category"] == "transport"
    assert entries["plaid-t1"]["updated_by"] == "bank"


def test_the_access_token_is_not_stored_in_the_clear(client, plaid):
    connect(client)
    from app.db import SessionLocal
    from app.models import BankItem

    with SessionLocal() as session:
        stored = session.get(BankItem, "item-pub-1").access_token
    assert "access-pub-1" not in stored


def test_a_typed_in_expense_is_matched_not_doubled(client, plaid, phone):
    phone.create("coffee", occurred_on="2026-10-05", amount_cents=450, merchant="Cafe")
    plaid.queue(added=[txn("t1", 4.5, "2026-10-07", merchant="BLUE BOTTLE")])
    assert connect(client)["imported"]["matched"] == 1

    entries = live(phone.pull())
    assert set(entries) == {"coffee"}
    # Their merchant and date stand; only the bank label is added.
    assert entries["coffee"]["fields"]["merchant"] == "Cafe"
    assert entries["coffee"]["fields"]["occurred_on"] == "2026-10-05"
    assert entries["coffee"]["fields"]["bank"] == "Chase ••1234"


def test_matching_needs_the_same_amount_within_three_days(client, plaid, phone):
    phone.create("early", occurred_on="2026-10-01", amount_cents=450)
    phone.create("other-amount", occurred_on="2026-10-07", amount_cents=451)
    plaid.queue(added=[txn("t1", 4.5, "2026-10-07")])
    connect(client)

    entries = live(phone.pull())
    assert set(entries) == {"early", "other-amount", "plaid-t1"}
    assert entries["early"]["fields"].get("bank", "") == ""


def test_one_expense_matches_only_one_bank_charge(client, plaid, phone):
    phone.create("coffee", occurred_on="2026-10-05", amount_cents=450)
    plaid.queue(added=[txn("t1", 4.5, "2026-10-05"), txn("t2", 4.5, "2026-10-05")])
    imported = connect(client)["imported"]
    assert (imported["matched"], imported["added"]) == (1, 1)


def test_a_pending_charge_posting_keeps_the_entry_and_its_edits(client, plaid, phone):
    plaid.queue(added=[txn("p1", 40.0, "2026-10-10", merchant="Bistro", pending=True,
                           primary="FOOD_AND_DRINK")])
    connect(client)
    entry = live(phone.pull())["plaid-p1"]
    phone.update("plaid-p1", entry["rev"], note="team lunch")

    # The tip goes on when it posts: a new id, pointing back at the pending one.
    plaid.queue(added=[txn("t1", 48.0, "2026-10-10", merchant="Bistro", pending_id="p1",
                           primary="FOOD_AND_DRINK")], removed=["p1"])
    assert refresh(client) == {"added": 0, "matched": 0, "updated": 1, "removed": 0, "transfers": 0}

    entries = live(phone.pull())
    assert set(entries) == {"plaid-p1"}
    assert entries["plaid-p1"]["fields"]["amount_cents"] == 4800
    assert entries["plaid-p1"]["fields"]["note"] == "team lunch"


def test_a_pending_charge_that_drops_off_goes_away(client, plaid, phone):
    phone.create("typed", occurred_on="2026-10-10", amount_cents=999)
    plaid.queue(added=[txn("p1", 25.0, "2026-10-10", pending=True),
                       txn("p2", 9.99, "2026-10-10", pending=True)])
    connect(client)
    phone.pull()

    plaid.queue(removed=["p1", "p2"])
    assert refresh(client)["removed"] == 2

    changes = {c["id"]: c for c in phone.pull()}
    assert changes["plaid-p1"]["deleted"] is True        # imported: gone
    assert changes["typed"]["deleted"] is False          # typed in: stays,
    assert changes["typed"]["fields"]["bank"] == ""      # just unlinked


def test_an_offline_edit_merges_with_a_bank_update(client, plaid, phone):
    plaid.queue(added=[txn("p1", 40.0, "2026-10-10", pending=True)])
    connect(client)
    stale_rev = live(phone.pull())["plaid-p1"]["rev"]

    plaid.queue(added=[txn("t1", 48.0, "2026-10-10", pending_id="p1")], removed=["p1"])
    refresh(client)

    # The phone was offline and edited the category against the old revision.
    result = phone.update("plaid-p1", stale_rev, category="fun")
    assert result["status"] == "merged"
    assert result["entry"]["fields"]["amount_cents"] == 4800
    assert result["entry"]["fields"]["category"] == "fun"


def test_running_the_same_page_twice_changes_nothing(client, plaid, phone):
    page = [txn("t1", 10.0, "2026-10-01"), txn("t2", 20.0, "2026-10-02")]
    plaid.queue(added=page)
    connect(client)
    first = phone.pull()

    plaid.queue(added=page)  # a sync that died before saving its cursor, retried
    assert refresh(client) == {"added": 0, "matched": 0, "updated": 0, "removed": 0, "transfers": 0}
    assert phone.pull() == []
    assert len(first) == 2


def test_several_pages_are_all_imported(client, plaid, phone):
    plaid.queue(added=[txn("t1", 10.0, "2026-10-01")], has_more=True)
    plaid.queue(added=[txn("t2", 20.0, "2026-10-02")])
    assert connect(client)["imported"]["added"] == 2


def test_a_broken_login_is_recorded_and_other_banks_still_refresh(client, plaid):
    connect(client)

    def broken(*_args, **_kwargs):
        raise PlaidError("ITEM_LOGIN_REQUIRED", "the login details have changed")

    plaid.transactions_sync = broken
    refresh(client)
    item = client.get("/api/bank/status").json()["items"][0]
    assert item["status"] == "login_required"

    # Signing back in goes through Link in update mode for that item.
    assert client.post("/api/bank/link-token", json={"item_id": item["item_id"]}).status_code == 200
    assert plaid.last_link["access_token"] == "access-pub-1"


def test_accounts_never_see_each_others_banks(client, plaid):
    connect(client)
    other = auth(USER_B)
    assert client.get("/api/bank/status", headers=other).json()["items"] == []
    assert client.delete("/api/bank/items/item-pub-1", headers=other).status_code == 404
    assert client.post("/api/bank/link-token", json={"item_id": "item-pub-1"},
                       headers=other).status_code == 404


def test_bank_charges_only_match_your_own_expenses(client, plaid):
    Device(client, "b-phone", USER_B).create("coffee", occurred_on="2026-10-05", amount_cents=450)
    plaid.queue(added=[txn("t1", 4.5, "2026-10-05")])
    assert connect(client)["imported"] == {"added": 1, "matched": 0, "updated": 0, "removed": 0, "transfers": 0}


def test_disconnecting_keeps_the_expenses(client, plaid, phone):
    plaid.queue(added=[txn("t1", 10.0, "2026-10-01")])
    connect(client)
    assert client.delete("/api/bank/items/item-pub-1").status_code == 200
    assert plaid.removed_items == ["access-pub-1"]
    assert client.get("/api/bank/status").json()["items"] == []
    assert "plaid-t1" in live(phone.pull())


# -- webhooks --------------------------------------------------------------------


def post_webhook(client, plaid, payload, **sign_kwargs):
    body = json.dumps(payload).encode()
    return client.post(
        "/api/bank/webhook", content=body,
        headers={"Authorization": "", "Content-Type": "application/json",
                 "Plaid-Verification": plaid.sign(body, **sign_kwargs)},
    )


def test_a_signed_webhook_brings_in_new_transactions(client, plaid, phone):
    connect(client)
    plaid.queue(added=[txn("t9", 7.0, "2026-10-20")])
    response = post_webhook(client, plaid, {"webhook_type": "TRANSACTIONS",
                                            "webhook_code": "SYNC_UPDATES_AVAILABLE",
                                            "item_id": "item-pub-1"})
    assert response.status_code == 200
    assert "plaid-t9" in live(phone.pull())


def test_a_webhook_flags_a_login_that_needs_signing_in_again(client, plaid):
    connect(client)
    post_webhook(client, plaid, {"webhook_type": "ITEM", "webhook_code": "ERROR",
                                 "item_id": "item-pub-1",
                                 "error": {"error_code": "ITEM_LOGIN_REQUIRED"}})
    assert client.get("/api/bank/status").json()["items"][0]["status"] == "login_required"


@pytest.mark.parametrize("forgery", ["unsigned", "wrong_key", "too_old", "body_changed"])
def test_webhooks_plaid_did_not_sign_are_refused(client, plaid, forgery):
    connect(client)
    payload = {"webhook_type": "ITEM", "webhook_code": "USER_PERMISSION_REVOKED",
               "item_id": "item-pub-1"}
    body = json.dumps(payload).encode()
    headers = {"Authorization": "", "Content-Type": "application/json"}
    if forgery == "wrong_key":
        headers["Plaid-Verification"] = plaid.sign(body, key=ec.generate_private_key(ec.SECP256R1()))
    elif forgery == "too_old":
        headers["Plaid-Verification"] = plaid.sign(body, iat=int(time.time()) - 600)
    elif forgery == "body_changed":
        headers["Plaid-Verification"] = plaid.sign(b'{"something": "else"}')
    response = client.post("/api/bank/webhook", content=body, headers=headers)
    assert response.status_code == 401
    assert client.get("/api/bank/status").json()["items"][0]["status"] == "ok"


# -- repeating charges -------------------------------------------------------------


def test_subscriptions_come_from_plaid_when_it_has_them(client, plaid):
    connect(client)
    plaid.recurring = {"outflow_streams": [
        {"merchant_name": "Netflix", "frequency": "MONTHLY", "is_active": True, "status": "MATURE",
         "last_amount": {"amount": 15.49}, "last_date": "2026-10-12",
         "predicted_next_date": "2026-11-12",
         "personal_finance_category": {"primary": "ENTERTAINMENT"}},
        {"merchant_name": "Gym", "frequency": "WEEKLY", "is_active": True, "status": "MATURE",
         "last_amount": {"amount": 10}, "last_date": "2026-10-30"},
        {"merchant_name": "Old thing", "frequency": "MONTHLY", "is_active": False,
         "status": "TOMBSTONED", "last_amount": {"amount": 5}, "last_date": "2025-01-01"},
    ]}
    body = client.get("/api/bank/subscriptions").json()
    assert body["source"] == "plaid"
    assert [s["merchant"] for s in body["streams"]] == ["Gym", "Netflix"]
    assert body["streams"][1]["category"] == "fun"
    assert body["monthly_total_cents"] == round(1000 * 52 / 12) + 1549


def test_subscriptions_fall_back_to_the_ledger_without_plaid_recurring(client, plaid, phone):
    connect(client)  # FakePlaid's recurring answers PRODUCT_NOT_ENABLED
    today = date.today()
    for months_ago in (3, 2, 1):
        day = (today - timedelta(days=30 * months_ago)).isoformat()
        phone.create(f"spot-{months_ago}", occurred_on=day, amount_cents=1199, merchant="Spotify")
    body = client.get("/api/bank/subscriptions").json()
    assert body["source"] == "history"
    assert [(s["merchant"], s["frequency"]) for s in body["streams"]] == [("Spotify", "monthly")]


def _entries(*charges):
    return [
        Entry(user_id="u", id=f"e{i}", rev=1, server_seq=i, deleted=False,
              fields={"merchant": m, "amount_cents": a, "occurred_on": d, "category": "fun"},
              created_at="", updated_at="", updated_by="")
        for i, (m, a, d) in enumerate(charges)
    ]


def test_detection_wants_a_steady_gap_and_a_steady_price():
    today = date(2026, 11, 2)
    found = detect_recurring(_entries(
        ("NETFLIX.COM 123", 1549, "2026-08-12"), ("Netflix.com", 1549, "2026-09-12"),
        ("netflix com", 1549, "2026-10-12"),
        # Same shop, all over the place: groceries, not a subscription.
        ("Tesco", 4200, "2026-10-01"), ("Tesco", 1800, "2026-10-04"), ("Tesco", 6100, "2026-10-20"),
        # Monthly, but stopped in the summer.
        ("Old gym", 3000, "2026-05-01"), ("Old gym", 3000, "2026-06-01"),
        ("Old gym", 3000, "2026-07-01"),
    ), today)
    assert [(s["merchant"], s["frequency"], s["next_date"]) for s in found] == [
        ("netflix com", "monthly", "2026-11-11")
    ]


# -- balances and finer categories ---------------------------------------------------


def test_balances_split_what_you_have_from_what_you_owe(client, plaid):
    plaid.queue()
    plaid.pages[0]["accounts"] = [
        {"account_id": "chq", "name": "Chequing", "mask": "1111", "type": "depository",
         "subtype": "checking", "balances": {"current": 2500.10, "available": 2400, "iso_currency_code": "CAD"}},
        {"account_id": "sav", "name": "Savings", "mask": "2222", "type": "depository",
         "subtype": "savings", "balances": {"current": 1000, "iso_currency_code": "CAD"}},
        {"account_id": "visa", "name": "Visa", "mask": "3333", "type": "credit",
         "subtype": "credit card", "balances": {"current": 640.55, "limit": 5000, "iso_currency_code": "CAD"}},
        {"account_id": "loan", "name": "Car loan", "mask": "4444", "type": "loan",
         "subtype": "auto", "balances": {"current": 9000, "iso_currency_code": "CAD"}},
    ]
    connect(client, institution="Scotiabank")

    body = client.get("/api/bank/balances").json()
    assert body["totals"] == [{"currency": "CAD", "have_cents": 350010, "owe_cents": 964055,
                               "net_cents": 350010 - 964055}]
    visa = next(a for a in body["accounts"] if a["mask"] == "3333")
    assert (visa["owed"], visa["current_cents"], visa["limit_cents"]) == (True, 64055, 500000)
    assert client.get("/api/bank/balances", headers=auth(USER_B)).json() == {"accounts": [], "totals": []}


def test_balances_come_from_accounts_get_when_sync_sends_none(client, plaid):
    plaid.accounts_get = lambda token: [
        {"account_id": "chq", "name": "Chequing", "mask": "1111", "type": "depository",
         "balances": {"current": 12.34, "iso_currency_code": "CAD"}},
    ]
    connect(client)  # FakePlaid's empty page carries no accounts
    assert client.get("/api/bank/balances").json()["totals"][0]["have_cents"] == 1234


def test_reading_from_the_start_resorts_categories_nobody_chose(client, plaid, phone):
    shop = txn("t1", 30.0, "2026-10-01", merchant="Winners", primary="GENERAL_MERCHANDISE")
    kept = txn("t2", 20.0, "2026-10-02", merchant="Shoppers", primary="PERSONAL_CARE")
    plaid.queue(added=[shop, kept])
    connect(client)
    entries = live(phone.pull())
    # Imported under the old, coarser rules, and one re-sorted by hand since.
    from app.db import SessionLocal

    with SessionLocal() as session:
        for entry_id in ("plaid-t1", "plaid-t2"):
            entry = session.get(Entry, ("11111111-1111-1111-1111-111111111111", entry_id))
            entry.fields = {**entry.fields, "category": "other"}
        session.commit()
    phone.update("plaid-t2", entries["plaid-t2"]["rev"], category="health")

    plaid.queue(added=[shop, kept])
    response = client.post("/api/bank/refresh", json={"from_start": True})
    assert response.status_code == 200

    entries = live(phone.pull())
    assert entries["plaid-t1"]["fields"]["category"] == "shopping"
    assert entries["plaid-t2"]["fields"]["category"] == "health"


# -- moving money between your own accounts -----------------------------------------


def etransfer_out(tid, amount, day, account="acc-1"):
    return txn(tid, amount, day, merchant="", account=account, primary="GENERAL_SERVICES") | {
        "merchant_name": None, "name": "INTERAC E-TRANSFER SEND"}


def deposit_in(tid, amount, day, account="ws-1"):
    return txn(tid, -amount, day, merchant="", account=account, primary="TRANSFER_IN") | {
        "merchant_name": None, "name": "E-Transfer received"}


def test_money_moved_to_another_of_your_accounts_is_not_spending(client, plaid, phone):
    plaid.queue(added=[etransfer_out("out1", 500.0, "2026-10-10"), deposit_in("in1", 500.0, "2026-10-10"),
                       txn("t1", 12.0, "2026-10-10")])
    imported = connect(client)["imported"]
    assert (imported["added"], imported["transfers"]) == (1, 1)
    assert set(live(phone.pull())) == {"plaid-t1"}


def test_a_transfer_spotted_when_the_money_arrives_later_is_taken_out(client, plaid, phone):
    plaid.queue(added=[etransfer_out("out1", 500.0, "2026-10-10")])
    connect(client)                                   # Scotiabank: looks like spending, for now
    assert "plaid-out1" in live(phone.pull())

    plaid.queue(added=[deposit_in("in1", 500.0, "2026-10-12")])
    connect(client, public_token="pub-2", institution="Wealthsimple")
    changes = {c["id"]: c for c in phone.pull()}
    assert changes["plaid-out1"]["deleted"] is True


def test_same_amount_in_without_any_sign_of_a_transfer_is_left_alone(client, plaid, phone):
    # $50 at a shop, and a friend paying you $50 back: not a transfer.
    plaid.queue(added=[txn("t1", 50.0, "2026-10-10", merchant="Shop"),
                       txn("in1", -50.0, "2026-10-10", merchant="Friend", account="acc-2",
                           primary="INCOME")])
    connect(client)
    assert "plaid-t1" in live(phone.pull())


def test_marking_one_expense_a_transfer_takes_out_its_kind_and_stops_more(client, plaid, phone):
    plaid.queue(added=[etransfer_out("out1", 200.0, "2026-10-01"), etransfer_out("out2", 300.0, "2026-10-15"),
                       txn("t1", 9.0, "2026-10-15", merchant="Cafe")])
    connect(client)
    assert set(live(phone.pull())) == {"plaid-out1", "plaid-out2", "plaid-t1"}

    response = client.post("/api/bank/transfer-rules", json={"entry_id": "plaid-out1"})
    assert response.status_code == 200, response.text
    assert response.json()["removed"] == 2
    changes = {c["id"]: c for c in phone.pull()}
    assert {k for k, c in changes.items() if c["deleted"]} == {"plaid-out1", "plaid-out2"}
    assert "plaid-t1" not in changes  # the coffee stays put

    plaid.queue(added=[etransfer_out("out3", 400.0, "2026-10-20")])
    assert refresh(client)["transfers"] == 1
    entries = {c["id"]: c for c in phone.pull()}
    assert "plaid-out3" not in entries

    rules = client.get("/api/bank/transfer-rules").json()["rules"]
    assert [r["pattern"] for r in rules] == ["interac e transfer send"]
    assert client.get("/api/bank/transfer-rules", headers=auth(USER_B)).json()["rules"] == []
    assert client.delete(f"/api/bank/transfer-rules/{rules[0]['id']}", headers=auth(USER_B)).status_code == 404
    assert client.delete(f"/api/bank/transfer-rules/{rules[0]['id']}").status_code == 200


def test_a_typed_in_expense_marked_as_a_transfer_goes_too(client, plaid, phone):
    phone.create("ws", occurred_on="2026-10-01", amount_cents=10000, merchant="Wealthsimple")
    response = client.post("/api/bank/transfer-rules", json={"entry_id": "ws"})
    assert response.status_code == 200
    changes = {c["id"]: c for c in phone.pull()}
    assert changes["ws"]["deleted"] is True


def test_a_preview_says_what_else_a_rule_would_take_out(client, plaid, phone):
    plaid.queue(added=[etransfer_out("out1", 200.0, "2026-10-01"), etransfer_out("out2", 300.0, "2026-10-15"),
                       txn("t1", 9.0, "2026-10-15", merchant="Cafe")])
    connect(client)
    body = client.post("/api/bank/transfer-rules/preview", json={"entry_id": "plaid-out1"}).json()
    assert body["pattern"] == "interac e transfer send"
    assert [o["entry_id"] for o in body["others"]] == ["plaid-out2"]
    assert body["others_total_cents"] == 30000
    assert "plaid-out1" in live(phone.pull())  # nothing taken out yet


def test_suggestions_list_imported_expenses_that_read_like_transfers(client, plaid):
    today = date.today().isoformat()
    plaid.queue(added=[etransfer_out("out1", 200.0, today), txn("t1", 9.0, today, merchant="Cafe"),
                       txn("t2", 75.0, today, merchant="TFR-TO 8812 SAVINGS")])
    connect(client)
    found = client.get("/api/bank/transfer-suggestions").json()["suggestions"]
    assert sorted(s["entry_id"] for s in found) == ["plaid-out1", "plaid-t2"]
    assert client.get("/api/bank/transfer-suggestions", headers=auth(USER_B)).json()["suggestions"] == []


# -- subscriptions added by hand -------------------------------------------------------


def test_a_subscription_added_by_hand_is_listed_and_rolls_forward(client):
    added = client.post("/api/bank/subscriptions/custom", json={
        "name": "Crave", "amount_cents": 2199, "frequency": "monthly", "next_date": "2020-01-31",
        "category": "fun"})
    assert added.status_code == 200, added.text
    body = client.get("/api/bank/subscriptions").json()
    crave = next(s for s in body["streams"] if s["merchant"] == "Crave")
    assert crave["source"] == "manual" and crave["monthly_cents"] == 2199
    assert crave["next_date"] >= date.today().isoformat()
    assert body["monthly_total_cents"] >= 2199

    assert client.get("/api/bank/subscriptions", headers=auth(USER_B)).json()["streams"] == []
    assert client.delete(f"/api/bank/subscriptions/custom/{crave['id']}", headers=auth(USER_B)).status_code == 404
    assert client.delete(f"/api/bank/subscriptions/custom/{crave['id']}").status_code == 200
    assert client.get("/api/bank/subscriptions").json()["streams"] == []


def test_a_hand_added_subscription_replaces_the_detected_one(client, phone):
    for months_ago in (3, 2, 1):
        day = (date.today() - timedelta(days=30 * months_ago)).isoformat()
        phone.create(f"spot-{months_ago}", occurred_on=day, amount_cents=1199, merchant="Spotify")
    client.post("/api/bank/subscriptions/custom", json={
        "name": "spotify", "amount_cents": 1299, "frequency": "monthly",
        "next_date": date.today().isoformat()})
    streams = client.get("/api/bank/subscriptions").json()["streams"]
    assert [(s["merchant"], s["amount_cents"], s["source"]) for s in streams] == [("spotify", 1299, "manual")]


@pytest.mark.parametrize("bad", [
    {"amount_cents": 0}, {"frequency": "daily"}, {"next_date": "2026-02-30"}, {"name": ""},
])
def test_bad_subscriptions_are_refused(client, bad):
    body = {"name": "X", "amount_cents": 100, "frequency": "monthly", "next_date": "2026-11-01", **bad}
    assert client.post("/api/bank/subscriptions/custom", json=body).status_code == 422


def test_renewals_roll_forward_by_their_frequency():
    from app.banking import next_renewal

    today = date(2026, 11, 2)
    assert next_renewal("2026-01-31", "monthly", today) == "2026-11-30"
    assert next_renewal("2026-02-28", "monthly", today) == "2026-11-28"
    assert next_renewal("2025-12-25", "annually", today) == "2026-12-25"
    assert next_renewal("2026-10-26", "weekly", today) == "2026-11-02"
    assert next_renewal("2026-12-01", "monthly", today) == "2026-12-01"


# -- credit scores ------------------------------------------------------------------------


def test_credit_scores_are_kept_per_account_with_card_utilisation(client, plaid):
    plaid.queue()
    plaid.pages[0]["accounts"] = [
        {"account_id": "visa", "name": "Visa", "mask": "3333", "type": "credit",
         "balances": {"current": 1250, "limit": 5000, "iso_currency_code": "CAD"}},
        {"account_id": "mc", "name": "Mastercard", "mask": "4444", "type": "credit",
         "balances": {"current": 250, "limit": 1000, "iso_currency_code": "CAD"}},
    ]
    connect(client)
    for score, on in ((702, "2026-08-01"), (731, "2026-10-01")):
        assert client.post("/api/credit", json={"score": score, "on": on, "source": "TransUnion"}).status_code == 200

    body = client.get("/api/credit").json()
    assert [s["score"] for s in body["scores"]] == [702, 731]
    assert body["utilization"] == {"balance_cents": 150000, "limit_cents": 600000, "ratio": 0.25, "cards": 2}
    assert client.get("/api/credit", headers=auth(USER_B)).json() == {"scores": [], "utilization": None}
    first = body["scores"][0]["id"]
    assert client.delete(f"/api/credit/{first}", headers=auth(USER_B)).status_code == 404
    assert client.delete(f"/api/credit/{first}").status_code == 200


@pytest.mark.parametrize("bad", [{"score": 299}, {"score": 901}, {"on": "2099-01-01"}, {"on": "nope"}])
def test_impossible_credit_scores_are_refused(client, bad):
    assert client.post("/api/credit", json={"score": 700, "on": "2026-10-01", **bad}).status_code == 422


def test_credit_routes_need_a_sign_in(client):
    assert client.get("/api/credit", headers={"Authorization": ""}).status_code == 401


def test_money_pulled_by_your_other_bank_is_a_transfer_too(client, plaid, phone):
    # Wealthsimple pulls from Scotiabank: no "transfer" on either side, but the
    # Scotiabank side names a bank you've connected.
    plaid.queue(added=[txn("out1", 300.0, "2026-10-10", merchant="", primary="GENERAL_SERVICES")
                       | {"merchant_name": None, "name": "WEALTHSIMPLE MSP"}])
    connect(client, institution="Scotiabank")
    plaid.queue(added=[txn("in1", -300.0, "2026-10-11", merchant="", account="ws-1", primary="OTHER")
                       | {"merchant_name": None, "name": "Deposit"}])
    connect(client, public_token="pub-2", institution="Wealthsimple")
    changes = {c["id"]: c for c in phone.pull()}
    assert changes["plaid-out1"]["deleted"] is True


def test_naming_a_bank_you_have_not_connected_proves_nothing(client, plaid, phone):
    plaid.queue(added=[txn("out1", 300.0, "2026-10-10", merchant="", primary="GENERAL_SERVICES")
                       | {"merchant_name": None, "name": "QUESTRADE"},
                       txn("in1", -300.0, "2026-10-11", merchant="", account="acc-2", primary="OTHER")
                       | {"merchant_name": None, "name": "Deposit"}])
    connect(client, institution="Scotiabank")
    assert "plaid-out1" in live(phone.pull())
