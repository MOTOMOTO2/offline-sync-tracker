"""A small client for the parts of Plaid's API that Tally uses.

Plaid's API is plain JSON over POST, so this is the standard library rather
than the SDK: one function per endpoint, and a ``PlaidError`` carrying Plaid's
own ``error_code`` so callers can tell "this login needs fixing" from "Plaid is
down".

Configured from the environment:

* ``PLAID_CLIENT_ID`` and ``PLAID_SECRET`` - from dashboard.plaid.com.
* ``PLAID_ENV`` - ``sandbox`` (the default, fake banks) or ``production``.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

import jwt

ENVIRONMENTS = {"sandbox", "production"}

# A webhook older than this is refused, so a captured one can't be replayed later.
WEBHOOK_MAX_AGE_S = 5 * 60


class PlaidError(Exception):
    def __init__(self, code: str, message: str, status: int = 0):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status = status


class PlaidClient:
    def __init__(self, client_id: str, secret: str, env: str = "sandbox", timeout: float = 30):
        if env not in ENVIRONMENTS:
            raise ValueError(f"PLAID_ENV must be one of {sorted(ENVIRONMENTS)}")
        self.client_id = client_id
        self.secret = secret
        self.env = env
        self.base_url = f"https://{env}.plaid.com"
        self.timeout = timeout
        self._webhook_keys: dict[str, dict] = {}

    def call(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        payload = {"client_id": self.client_id, "secret": self.secret, **body}
        request = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Plaid-Version": "2020-09-14"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            try:
                error = json.loads(exc.read())
            except ValueError:
                error = {}
            raise PlaidError(
                error.get("error_code", "HTTP_ERROR"),
                error.get("error_message", f"Plaid answered {exc.code}"),
                exc.code,
            ) from None
        except (urllib.error.URLError, TimeoutError) as exc:
            raise PlaidError("UNREACHABLE", str(exc)) from None

    # -- Link -----------------------------------------------------------------

    def link_token_create(
        self,
        user_id: str,
        *,
        webhook: str | None = None,
        redirect_uri: str | None = None,
        access_token: str | None = None,
    ) -> str:
        """A token for opening Link: to connect a new bank, or to fix an existing login.

        With ``access_token`` it opens Link in update mode for that Item, which is
        how someone signs back in after their bank asked them to.
        """
        body: dict[str, Any] = {
            "client_name": "Tally",
            "language": "en",
            "country_codes": ["US", "CA"],
            "user": {"client_user_id": user_id},
        }
        if access_token:
            body["access_token"] = access_token
        else:
            body["products"] = ["transactions"]
            body["transactions"] = {"days_requested": 90}
        if webhook:
            body["webhook"] = webhook
        if redirect_uri:
            body["redirect_uri"] = redirect_uri
        return self.call("/link/token/create", body)["link_token"]

    def exchange_public_token(self, public_token: str) -> tuple[str, str]:
        """(access_token, item_id) for the public token Link handed the browser."""
        result = self.call("/item/public_token/exchange", {"public_token": public_token})
        return result["access_token"], result["item_id"]

    def item_remove(self, access_token: str) -> None:
        self.call("/item/remove", {"access_token": access_token})

    # -- Transactions ---------------------------------------------------------

    def transactions_sync(self, access_token: str, cursor: str | None, count: int = 250) -> dict:
        body: dict[str, Any] = {"access_token": access_token, "count": count}
        if cursor:
            body["cursor"] = cursor
        return self.call("/transactions/sync", body)

    def transactions_recurring_get(self, access_token: str) -> dict:
        return self.call("/transactions/recurring/get", {"access_token": access_token})

    # -- Webhooks -------------------------------------------------------------

    def webhook_key(self, key_id: str) -> dict:
        if key_id not in self._webhook_keys:
            result = self.call("/webhook_verification_key/get", {"key_id": key_id})
            self._webhook_keys[key_id] = result["key"]
        return self._webhook_keys[key_id]

    def verify_webhook(self, body: bytes, verification: str | None) -> bool:
        """Whether a webhook really came from Plaid.

        Plaid signs each webhook with an ES256 JWT in the ``Plaid-Verification``
        header; the JWT carries the SHA-256 of the body it was sent with. The
        webhook URL is public, so without this anyone could make Tally sync or
        mark a bank as needing a sign-in.
        """
        if not verification:
            return False
        try:
            header = jwt.get_unverified_header(verification)
            if header.get("alg") != "ES256" or not header.get("kid"):
                return False
            key_data = self.webhook_key(header["kid"])
            if key_data.get("expired_at"):
                return False
            key = jwt.PyJWK(key_data, algorithm="ES256").key
            claims = jwt.decode(
                verification, key, algorithms=["ES256"], options={"require": ["iat"]}
            )
        except (jwt.PyJWTError, PlaidError, KeyError, ValueError):
            return False

        if time.time() - int(claims["iat"]) > WEBHOOK_MAX_AGE_S:
            return False
        expected = str(claims.get("request_body_sha256", ""))
        return hmac.compare_digest(hashlib.sha256(body).hexdigest(), expected)


def client_from_env() -> PlaidClient | None:
    client_id = os.environ.get("PLAID_CLIENT_ID")
    secret = os.environ.get("PLAID_SECRET")
    if not client_id or not secret:
        return None
    return PlaidClient(client_id, secret, os.environ.get("PLAID_ENV", "sandbox"))
