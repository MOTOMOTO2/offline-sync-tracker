"""Database engine / session wiring.

Two databases, picked by ``TALLY_DATABASE_URL``:

* SQLite (the default, in ``backend/data/tally.db``) for running it on one
  machine. One file, no setup.
* Postgres for the hosted app - Supabase's, through its connection pooler. A
  serverless function can't keep a pool of its own between requests, so it
  opens one connection per request and lets the pooler do the pooling.

The only thing either is leaned on for beyond the basics is
``UPDATE ... RETURNING`` (SQLite 3.35+) to hand out sync sequence numbers
atomically.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "tally.db"


def database_url() -> str:
    override = os.environ.get("TALLY_DATABASE_URL")
    if override:
        # Supabase hands out postgres:// URLs; SQLAlchemy wants the driver named.
        for prefix in ("postgres://", "postgresql://"):
            if override.startswith(prefix):
                return "postgresql+psycopg://" + override[len(prefix):]
        return override
    if os.environ.get("VERCEL"):
        # A function's disk is read-only and gone after the request, so a
        # default SQLite file there would only ever fail, and fail obscurely.
        raise RuntimeError("TALLY_DATABASE_URL is not set: point it at the Supabase pooler")
    DEFAULT_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite+pysqlite:///{DEFAULT_DB_PATH}"


URL = database_url()
IS_SQLITE = URL.startswith("sqlite")

if IS_SQLITE:
    engine = create_engine(
        URL,
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
else:
    engine = create_engine(
        URL,
        future=True,
        poolclass=NullPool,
        # Supabase's transaction-mode pooler can't hold prepared statements
        # across the connections it hands out.
        connect_args={"prepare_threshold": None},
    )


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
