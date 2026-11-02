"""Who is asking: every sync request is scoped to one signed-in user.

Sign-in itself happens in the browser, against Supabase Auth. What reaches this
server is the access token Supabase issued - a JWT whose ``sub`` is the user's
id - in an ``Authorization: Bearer`` header. All this module does is check that
token and hand back the id; it never sees a password.

Two ways to check it, depending on the Supabase project:

* ``SUPABASE_URL`` alone - newer projects sign tokens with an asymmetric key and
  publish the public half at ``/auth/v1/.well-known/jwks.json``. Fetched once
  and cached; nothing secret lives here.
* ``SUPABASE_JWT_SECRET`` as well - older projects sign with a shared HS256
  secret instead. Used when set.

For local development without a Supabase project, ``TALLY_DEV_USER=<name>``
makes every request that carries no token run as that user. It is ignored when
unset, so a deployment can't fall into it by accident.
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Annotated

import jwt
from fastapi import Depends, Header, HTTPException

AUDIENCE = "authenticated"


def _supabase_url() -> str:
    return os.environ.get("SUPABASE_URL", "").rstrip("/")


@lru_cache(maxsize=1)
def _jwks_client() -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"{_supabase_url()}/auth/v1/.well-known/jwks.json", cache_keys=True)


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=401, detail=detail, headers={"WWW-Authenticate": "Bearer"}
    )


def verify_token(token: str) -> str:
    """The user id inside a Supabase access token, or 401."""
    secret = os.environ.get("SUPABASE_JWT_SECRET")
    base = _supabase_url()
    if not secret and not base:
        raise _unauthorized("sign-in is not configured on this server")

    options = {"require": ["exp", "sub"]}
    issuer = f"{base}/auth/v1" if base else None
    try:
        if secret:
            claims = jwt.decode(
                token, secret, algorithms=["HS256"], audience=AUDIENCE,
                issuer=issuer, options=options,
            )
        else:
            key = _jwks_client().get_signing_key_from_jwt(token).key
            claims = jwt.decode(
                token, key, algorithms=["ES256", "RS256"], audience=AUDIENCE,
                issuer=issuer, options=options,
            )
    except jwt.ExpiredSignatureError:
        raise _unauthorized("your sign-in has expired") from None
    except jwt.PyJWTError:
        raise _unauthorized("not a valid sign-in") from None

    user_id = str(claims["sub"])
    if not user_id or len(user_id) > 64:
        raise _unauthorized("not a valid sign-in")
    return user_id


def _allowed(user_id: str) -> bool:
    """TALLY_ALLOWED_USERS, when set, is the comma-separated list of who may use this server.

    The hosted app shares its Supabase project - and so its accounts - with
    another app. Signing in proves who someone is; this decides whether this
    ledger is theirs to use, so an account made for anything else can't open it.
    """
    allowed = {u.strip() for u in os.environ.get("TALLY_ALLOWED_USERS", "").split(",") if u.strip()}
    return not allowed or user_id in allowed


def current_user(authorization: Annotated[str | None, Header()] = None) -> str:
    if authorization and authorization.lower().startswith("bearer "):
        user_id = verify_token(authorization[7:].strip())
        if not _allowed(user_id):
            raise HTTPException(status_code=403, detail="this account can't use Tally")
        return user_id
    dev_user = os.environ.get("TALLY_DEV_USER")
    if dev_user:
        return dev_user
    raise _unauthorized("sign in first")


UserDep = Annotated[str, Depends(current_user)]
