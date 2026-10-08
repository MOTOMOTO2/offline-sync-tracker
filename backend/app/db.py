"""Database engine / session wiring.

SQLite is plenty for a single-user tracker, and keeping it in one file makes the
whole thing trivially portable. The only thing we lean on SQLite for beyond the
basics is ``UPDATE ... RETURNING`` (3.35+) to hand out sync sequence numbers
atomically.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "tally.db"


def database_url() -> str:
    override = os.environ.get("TALLY_DATABASE_URL")
    if override:
        return override
    DEFAULT_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite+pysqlite:///{DEFAULT_DB_PATH}"


engine = create_engine(
    database_url(),
    future=True,
    # A phone syncing over flaky mobile data means lots of short-lived writes;
    # WAL + a busy timeout keeps concurrent pushes from tripping over each other.
    connect_args={"check_same_thread": False, "timeout": 15},
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_connection, _record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
