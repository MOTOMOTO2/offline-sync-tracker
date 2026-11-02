"""Sign-in and the line between accounts.

A request either carries a valid Supabase token or gets a 401, and two accounts
never see, change or replay each other's data - not even when their devices
happen to make the same ids.
"""

from __future__ import annotations

import pytest

from .conftest import USER_A, USER_B, Device, token_for


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# -- who may ask -----------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/meta"),
        ("get", "/api/sync/pull"),
        ("post", "/api/sync/push"),
        ("get", "/api/demo/entries"),
    ],
)
def test_every_data_route_needs_a_sign_in(client, method, path):
    kwargs = {"json": {"device_id": "d", "ops": []}} if method == "post" else {}
    response = getattr(client, method)(path, headers={"Authorization": ""}, **kwargs)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_health_is_open_so_the_app_can_tell_offline_from_signed_out(client):
    assert client.get("/api/health", headers={"Authorization": ""}).status_code == 200


@pytest.mark.parametrize(
    ("token", "why"),
    [
        (token_for(USER_A, expires_in=-60), "expired"),
        (token_for(USER_A, secret="someone-elses-secret-0123456789abcdef"), "forged"),
        (token_for(USER_A, aud="anon"), "anon key, not a user"),
        (token_for(USER_A, iss="https://other.supabase.co/auth/v1"), "other project"),
        ("not.a.jwt", "garbage"),
    ],
)
def test_a_bad_token_is_refused(client, token, why):
    response = client.get("/api/sync/pull", headers=bearer(token))
    assert response.status_code == 401, why


def test_an_expired_sign_in_says_so(client):
    response = client.get("/api/meta", headers=bearer(token_for(USER_A, expires_in=-60)))
    assert response.json()["detail"] == "your sign-in has expired"


def test_dev_user_only_applies_when_no_token_is_sent(client, monkeypatch):
    monkeypatch.setenv("TALLY_DEV_USER", "local-dev")
    assert client.get("/api/meta", headers={"Authorization": ""}).status_code == 200
    # A token that is present still has to be good.
    bad = bearer(token_for(USER_A, expires_in=-60))
    assert client.get("/api/meta", headers=bad).status_code == 401


# -- one account's data is its own ---------------------------------------


def test_accounts_do_not_see_each_others_entries(client):
    alice = Device(client, "alice-phone", USER_A)
    bob = Device(client, "bob-phone", USER_B)

    alice.create("a1", amount_cents=1200, merchant="Loblaws")
    bob.create("b1", amount_cents=999, merchant="Netflix")

    assert [c["id"] for c in alice.pull()] == ["a1"]
    assert [c["id"] for c in bob.pull()] == ["b1"]


def test_the_same_entry_id_in_two_accounts_is_two_entries(client):
    alice = Device(client, "alice-phone", USER_A)
    bob = Device(client, "bob-phone", USER_B)

    first = alice.create("same-id", amount_cents=100)
    second = bob.create("same-id", amount_cents=200)

    # Bob's create is not a "create_exists" conflict against Alice's row.
    assert first["status"] == second["status"] == "applied"
    assert alice.pull()[0]["fields"]["amount_cents"] == 100
    assert bob.pull()[0]["fields"]["amount_cents"] == 200


def test_an_id_from_another_account_cannot_be_edited_or_deleted(client):
    alice = Device(client, "alice-phone", USER_A)
    bob = Device(client, "bob-phone", USER_B)
    alice.create("a1", amount_cents=1200)

    assert bob.update("a1", base_rev=1, amount_cents=1)["status"] == "invalid"
    assert bob.delete("a1", base_rev=1)["status"] == "invalid"
    assert alice.pull()[0]["fields"]["amount_cents"] == 1200
    assert alice.pull() == []  # and nothing changed under Alice since


def test_an_op_id_is_only_a_replay_within_one_account(client):
    alice = Device(client, "phone", USER_A)
    bob = Device(client, "phone", USER_B)
    op = {"op_id": "op-1", "entry_id": "e1", "kind": "create", "base_rev": 0,
          "fields": {"amount_cents": 500}}

    assert alice.push([op])[0]["status"] == "applied"
    # Bob's device made the same op id: his write is applied, not answered with
    # Alice's stored result.
    result = bob.push([op])[0]
    assert result["status"] == "applied"
    assert not result.get("duplicate")


def test_each_account_has_its_own_cursor(client):
    alice = Device(client, "alice-phone", USER_A)
    bob = Device(client, "bob-phone", USER_B)
    for i in range(3):
        alice.create(f"a{i}", amount_cents=100)
    bob.create("b1", amount_cents=100)

    assert client.get("/api/meta", headers=alice.headers).json()["cursor"] == 3
    assert client.get("/api/meta", headers=bob.headers).json()["cursor"] == 1


def test_demo_routes_only_reach_your_own_entries(client):
    alice = Device(client, "alice-phone", USER_A)
    bob = Device(client, "bob-phone", USER_B)
    alice.create("a1", amount_cents=1200)

    edit = client.post(
        "/api/demo/other-device-edit",
        json={"entry_id": "a1", "fields": {"amount_cents": 1}},
        headers=bob.headers,
    )
    delete = client.post(
        "/api/demo/other-device-delete", json={"entry_id": "a1"}, headers=bob.headers
    )
    listing = client.get("/api/demo/entries", headers=bob.headers).json()

    assert edit.status_code == delete.status_code == 404
    assert listing["entries"] == []
    assert alice.pull()[0]["fields"]["amount_cents"] == 1200


# -- newer projects: asymmetric keys from the JWKS endpoint ---------------


def test_a_token_signed_with_the_projects_published_key_is_accepted(client, monkeypatch):
    import os
    import time

    import jwt
    from cryptography.hazmat.primitives.asymmetric import ec

    from app import auth

    private_key = ec.generate_private_key(ec.SECP256R1())
    impostor_key = ec.generate_private_key(ec.SECP256R1())

    class FakeJwks:
        def get_signing_key_from_jwt(self, _token):
            return type("Key", (), {"key": private_key.public_key()})()

    monkeypatch.delenv("SUPABASE_JWT_SECRET")
    monkeypatch.setattr(auth, "_jwks_client", lambda: FakeJwks())

    def signed_by(key):
        claims = {"sub": USER_B, "aud": "authenticated",
                  "iss": f"{os.environ['SUPABASE_URL']}/auth/v1",
                  "exp": int(time.time()) + 600}
        return jwt.encode(claims, key, algorithm="ES256")

    good = client.get("/api/meta", headers=bearer(signed_by(private_key)))
    forged = client.get("/api/meta", headers=bearer(signed_by(impostor_key)))
    assert good.status_code == 200
    assert forged.status_code == 401


# -- the allowlist -----------------------------------------------------------


def test_only_listed_accounts_may_use_the_server(client, monkeypatch):
    monkeypatch.setenv("TALLY_ALLOWED_USERS", f" {USER_A} ,someone-else")
    alice = Device(client, "alice-phone", USER_A)
    bob = Device(client, "bob-phone", USER_B)

    assert client.get("/api/meta", headers=alice.headers).status_code == 200
    refused = client.get("/api/meta", headers=bob.headers)
    assert refused.status_code == 403
    assert refused.json()["detail"] == "this account can't use Tally"


def test_no_allowlist_means_any_signed_in_account(client, monkeypatch):
    monkeypatch.delenv("TALLY_ALLOWED_USERS", raising=False)
    bob = Device(client, "bob-phone", USER_B)
    assert client.get("/api/meta", headers=bob.headers).status_code == 200
