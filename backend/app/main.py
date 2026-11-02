"""FastAPI app: the sync endpoints plus static hosting for the built PWA.

Serving the frontend from the same origin as the API is not just convenience -
a service worker can only control pages on its own origin, so this is what makes
the installed app and its offline shell work without a second server.
"""

from __future__ import annotations

import mimetypes
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Body, Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateSchema

from .auth import UserDep
from .db import engine, get_session
from .models import SCHEMA, Base, Entry
from .schemas import (
    FIELD_SPECS,
    MAX_PULL_LIMIT,
    SUGGESTED_CATEGORIES,
    FieldValidationError,
    Op,
    PushRequest,
    validate_patch,
)
from .sync import apply_push, current_seq, next_seq, pull_changes, utc_now

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")

@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    init_db()
    yield


app = FastAPI(
    lifespan=lifespan,
    title="Tally sync API",
    description="Offline-first expense tracker: queued writes, explicit conflicts.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SessionDep = Annotated[Session, Depends(get_session)]


def init_db() -> None:
    # Each user's sync_state row is made by their first write (see next_seq).
    if SCHEMA:
        with engine.begin() as conn:
            conn.execute(CreateSchema(SCHEMA, if_not_exists=True))
    Base.metadata.create_all(bind=engine)


# --------------------------------------------------------------------------
# Sync API - everything below health is one signed-in user's (see auth.py)
# --------------------------------------------------------------------------


@app.get("/api/health")
def health() -> dict:
    # Open to anyone: the app uses it to tell "no signal" from "signed out".
    return {"ok": True, "server_time": utc_now()}


@app.get("/api/meta")
def meta(session: SessionDep, user_id: UserDep) -> dict:
    """Field schema + category suggestions, so the client has one source of truth."""
    return {
        "server_time": utc_now(),
        "cursor": current_seq(session, user_id),
        "fields": {name: spec.model_dump() for name, spec in FIELD_SPECS.items()},
        "categories": SUGGESTED_CATEGORIES,
    }


@app.post("/api/sync/push")
def sync_push(payload: PushRequest, session: SessionDep, user_id: UserDep) -> dict:
    results = apply_push(session, user_id, payload.device_id, payload.ops)
    return {
        "server_time": utc_now(),
        "cursor": current_seq(session, user_id),
        "results": results,
    }


@app.get("/api/sync/pull")
def sync_pull(
    session: SessionDep,
    user_id: UserDep,
    since: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=MAX_PULL_LIMIT),
) -> dict:
    return pull_changes(session, user_id, since, limit)


# --------------------------------------------------------------------------
# Demo helpers
#
# Conflict handling is impossible to show off with a single browser, so these
# let the server act as "the other device" - they write straight to the current
# head revision, exactly as a second phone that had already synced would.
# --------------------------------------------------------------------------


@app.get("/api/demo/entries")
def demo_entries(session: SessionDep, user_id: UserDep) -> dict:
    rows = (
        session.query(Entry)
        .filter(Entry.user_id == user_id)
        .order_by(Entry.server_seq.desc())
        .limit(50)
        .all()
    )
    return {"entries": [row.snapshot() for row in rows]}


@app.post("/api/demo/other-device-edit")
def demo_other_device_edit(
    session: SessionDep,
    user_id: UserDep,
    entry_id: Annotated[str, Body(embed=True)],
    fields: Annotated[dict, Body(embed=True)],
    device_id: Annotated[str, Body(embed=True)] = "other-phone",
) -> dict:
    entry = session.get(Entry, (user_id, entry_id))
    if entry is None:
        raise HTTPException(status_code=404, detail="unknown entry")
    try:
        patch = validate_patch(fields)
    except FieldValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not patch:
        raise HTTPException(status_code=422, detail="no fields given")

    op = Op(
        op_id=f"demo-{entry_id}-{entry.rev}-{next_seq(session, user_id)}",
        entry_id=entry_id,
        kind="update",
        base_rev=entry.rev,
        fields=patch,
    )
    results = apply_push(session, user_id, device_id, [op])
    return {"result": results[0]}


@app.post("/api/demo/other-device-delete")
def demo_other_device_delete(
    session: SessionDep,
    user_id: UserDep,
    entry_id: Annotated[str, Body(embed=True)],
    device_id: Annotated[str, Body(embed=True)] = "other-phone",
) -> dict:
    entry = session.get(Entry, (user_id, entry_id))
    if entry is None:
        raise HTTPException(status_code=404, detail="unknown entry")
    op = Op(
        op_id=f"demo-del-{entry_id}-{entry.rev}-{next_seq(session, user_id)}",
        entry_id=entry_id,
        kind="delete",
        base_rev=entry.rev,
    )
    results = apply_push(session, user_id, device_id, [op])
    return {"result": results[0]}


# --------------------------------------------------------------------------
# Static hosting for the built PWA
# --------------------------------------------------------------------------

# The service worker must never be served from cache, or a stale worker can pin
# users to an old app shell indefinitely.
NO_STORE = {"Cache-Control": "no-cache, no-store, must-revalidate"}


def _file_response(path: Path, headers: dict[str, str] | None = None) -> FileResponse:
    media_type, _ = mimetypes.guess_type(path.name)
    return FileResponse(path, media_type=media_type, headers=headers)


@app.get("/sw.js", include_in_schema=False)
def service_worker() -> Response:
    path = FRONTEND_DIST / "sw.js"
    if not path.is_file():
        return JSONResponse({"detail": "frontend not built"}, status_code=404)
    return _file_response(
        path,
        headers={**NO_STORE, "Service-Worker-Allowed": "/"},
    )


@app.get("/", include_in_schema=False)
def index() -> Response:
    path = FRONTEND_DIST / "index.html"
    if not path.is_file():
        return JSONResponse(
            {
                "detail": "frontend not built",
                "hint": "run: cd frontend && npm install && npm run build",
            },
            status_code=503,
        )
    return _file_response(path, headers=NO_STORE)


@app.get("/{full_path:path}", include_in_schema=False)
def spa_fallback(full_path: str) -> Response:
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="unknown API route")

    candidate = (FRONTEND_DIST / full_path).resolve()
    try:
        candidate.relative_to(FRONTEND_DIST.resolve())
    except ValueError:
        raise HTTPException(status_code=404, detail="not found") from None

    if candidate.is_file():
        # Hashed asset names make long-lived caching safe; everything else gets
        # revalidated so a deploy is picked up on the next load.
        long_cache = "/assets/" in candidate.as_posix()
        headers = (
            {"Cache-Control": "public, max-age=31536000, immutable"}
            if long_cache
            else {"Cache-Control": "no-cache"}
        )
        return _file_response(candidate, headers=headers)

    return index()
