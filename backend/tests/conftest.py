"""Test fixtures.

The database URL has to be set before ``app.db`` is imported, since the engine
is built at import time - hence the env poke at the top of the module.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

TMP_DIR = Path(tempfile.mkdtemp(prefix="tally-tests-"))
os.environ["TALLY_DATABASE_URL"] = f"sqlite+pysqlite:///{(TMP_DIR / 'test.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base, SyncState  # noqa: E402


@pytest.fixture
def client():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        session.add(SyncState(id=1, seq=0))
        session.commit()
    with TestClient(app) as test_client:
        yield test_client


class Device:
    """A tiny stand-in for one phone: builds ops and pushes them."""

    def __init__(self, client: TestClient, device_id: str):
        self.client = client
        self.device_id = device_id
        self.cursor = 0
        self._op_counter = 0

    def op_id(self, label: str = "op") -> str:
        self._op_counter += 1
        return f"{self.device_id}-{label}-{self._op_counter}"

    def push(self, ops: list[dict]) -> list[dict]:
        response = self.client.post(
            "/api/sync/push", json={"device_id": self.device_id, "ops": ops}
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
        response = self.client.get("/api/sync/pull", params={"since": self.cursor})
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
