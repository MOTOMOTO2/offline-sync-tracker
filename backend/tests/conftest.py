"""Test fixtures.

The database URL has to be set before ``app.db`` is imported, since the engine
is built at import time - hence the env poke at the top of the module.

Sign-in is checked for real: the tests mint HS256 tokens with a test secret, the
way an older Supabase project signs them, so the same code that guards the
deployment guards every test request. The client sends user A's token unless a
request says otherwise.
"""

from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path

TMP_DIR = Path(tempfile.mkdtemp(prefix="tally-tests-"))
os.environ["TALLY_DATABASE_URL"] = f"sqlite+pysqlite:///{(TMP_DIR / 'test.db').as_posix()}"
os.environ["SUPABASE_URL"] = "https://tally-test.supabase.co"
os.environ["SUPABASE_JWT_SECRET"] = "test-secret-not-used-anywhere-real-0123456789"
os.environ.pop("TALLY_DEV_USER", None)

import jwt  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db import engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base  # noqa: E402

USER_A = "11111111-1111-1111-1111-111111111111"
USER_B = "22222222-2222-2222-2222-222222222222"


def token_for(user_id: str, *, expires_in: int = 3600, secret: str | None = None, **extra) -> str:
    claims = {
        "sub": user_id,
        "aud": "authenticated",
        "iss": f"{os.environ['SUPABASE_URL']}/auth/v1",
        "exp": int(time.time()) + expires_in,
        **extra,
    }
    return jwt.encode(claims, secret or os.environ["SUPABASE_JWT_SECRET"], algorithm="HS256")


def auth(user_id: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token_for(user_id)}"}


@pytest.fixture
def client():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with TestClient(app, headers=auth(USER_A)) as test_client:
        yield test_client


class Device:
    """A tiny stand-in for one phone: builds ops and pushes them."""

    def __init__(self, client: TestClient, device_id: str, user_id: str = USER_A):
        self.client = client
        self.device_id = device_id
        self.headers = auth(user_id)
        self.cursor = 0
        self._op_counter = 0

    def op_id(self, label: str = "op") -> str:
        self._op_counter += 1
        return f"{self.device_id}-{label}-{self._op_counter}"

    def push(self, ops: list[dict]) -> list[dict]:
        response = self.client.post(
            "/api/sync/push",
            json={"device_id": self.device_id, "ops": ops},
            headers=self.headers,
        )
        assert response.status_code == 200, response.text
        return response.json()["results"]

    def create(self, entry_id: str, **fields) -> dict:
        return self.push(
            [
                {
                    "op_id": self.op_id("create"),
                    "entry_id": entry_id,
                    "kind": "create",
                    "base_rev": 0,
                    "fields": fields,
                }
            ]
        )[0]

    def update(self, entry_id: str, base_rev: int, **fields) -> dict:
        return self.push(
            [
                {
                    "op_id": self.op_id("update"),
                    "entry_id": entry_id,
                    "kind": "update",
                    "base_rev": base_rev,
                    "fields": fields,
                }
            ]
        )[0]

    def delete(self, entry_id: str, base_rev: int) -> dict:
        return self.push(
            [
                {
                    "op_id": self.op_id("delete"),
                    "entry_id": entry_id,
                    "kind": "delete",
                    "base_rev": base_rev,
                }
            ]
        )[0]

    def pull(self) -> list[dict]:
        response = self.client.get(
            "/api/sync/pull", params={"since": self.cursor}, headers=self.headers
        )
        assert response.status_code == 200, response.text
        body = response.json()
        self.cursor = body["cursor"]
        return body["changes"]


@pytest.fixture
def phone(client):
    return Device(client, "phone-a")


@pytest.fixture
def laptop(client):
    return Device(client, "laptop-b")
