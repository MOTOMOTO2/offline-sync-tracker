"""Notifications: a day before a subscription renews, and when one is charged.

Sent with Web Push, so they arrive with the app closed - on an iPhone only
once Tally is on the Home Screen (iOS 16.4+). Each device that allows them
leaves a ``PushSubscription``; a notification goes to all of a person's
devices, and ``NotificationSent`` makes sure nothing is said twice.

* **Renewing tomorrow** - ``/api/notify/daily``, run once a day by Vercel Cron
  (see vercel.json), which signs its call with ``CRON_SECRET``.
* **Charged** - from the bank import, when a new charge matches one of the
  person's subscriptions by merchant (see ``notify_charges``).

Needs ``VAPID_PUBLIC_KEY`` and ``VAPID_PRIVATE_KEY`` (a P-256 key pair,
base64url; ``tools/make_vapid_keys.py`` makes one), and ``VAPID_SUBJECT``, a
``mailto:`` address push services can reach the sender at.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
from datetime import date, datetime, timedelta
from typing import Annotated, Any, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Body, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import UserDep
from .banking import subscription_streams, text_key
from .db import get_session
from .models import NotificationSent, PushSubscription
from .plaid import client_from_env
from .sync import utc_now

log = logging.getLogger("tally.notify")

router = APIRouter(prefix="/api/notify")

SessionDep = Annotated[Session, Depends(get_session)]

# A charge older than this when it arrives (the first import's history, say)
# is news to nobody.
CHARGE_FRESH_DAYS = 3


class PushGone(Exception):
    """The push service says this subscription no longer exists."""


def _webpush(sub: PushSubscription, payload: dict[str, Any]) -> None:
    from pywebpush import WebPushException, webpush

    try:
        webpush(
            subscription_info={"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}},
            data=json.dumps(payload),
            vapid_private_key=os.environ["VAPID_PRIVATE_KEY"],
            vapid_claims={"sub": os.environ.get("VAPID_SUBJECT", "mailto:tally@example.com")},
            ttl=24 * 3600,
            timeout=10,
        )
    except WebPushException as exc:
        status = exc.response.status_code if exc.response is not None else 0
        if status in (404, 410):
            raise PushGone() from None
        raise


# Swapped out in tests.
send: Callable[[PushSubscription, dict[str, Any]], None] = _webpush


def configured() -> bool:
    return bool(os.environ.get("VAPID_PUBLIC_KEY") and os.environ.get("VAPID_PRIVATE_KEY"))


def _devices(session: Session, user_id: str) -> list[PushSubscription]:
    return list(
        session.execute(select(PushSubscription).where(PushSubscription.user_id == user_id)).scalars()
    )


def notify(session: Session, user_id: str, key: str, title: str, body: str, url: str = "/") -> bool:
    """Tell every one of this person's devices, once per ``key``. True if it went out."""
    if not configured() or session.get(NotificationSent, (user_id, key)) is not None:
        return False
    devices = _devices(session, user_id)
    if not devices:
        return False
    delivered = False
    for device in devices:
        try:
            send(device, {"title": title, "body": body, "url": url, "tag": key})
            delivered = True
        except PushGone:
            session.delete(device)  # uninstalled, or permission withdrawn
        except Exception as exc:  # noqa: BLE001 - one bad device mustn't stop the rest
            log.warning("push to %s failed: %s", device.id, exc)
    if delivered:
        session.add(NotificationSent(user_id=user_id, key=key[:200], at=utc_now()))
    session.commit()
    return delivered


def _money(cents: int) -> str:
    return f"${cents / 100:,.2f}"


def _today_in(tz: str) -> date:
    try:
        return datetime.now(ZoneInfo(tz)).date()
    except (ZoneInfoNotFoundError, ValueError):
        return datetime.utcnow().date()


def remind_renewals(session: Session, user_id: str, today: date | None = None) -> int:
    """Subscriptions renewing tomorrow, where this person is. Returns how many were sent."""
    devices = _devices(session, user_id)
    if not devices:
        return 0
    today = today or _today_in(devices[0].timezone)
    tomorrow = (today + timedelta(days=1)).isoformat()
    _source, streams = subscription_streams(session, user_id, client_from_env())
    sent = 0
    for stream in streams:
        if stream.get("next_date") != tomorrow:
            continue
        name = stream["merchant"] or stream["category"]
        if notify(
            session, user_id, f"renew:{text_key(name)}:{tomorrow}",
            f"{name} renews tomorrow",
            f"{_money(stream['amount_cents'])} will be charged.",
            "/?tab=subscriptions",
        ):
            sent += 1
    return sent


def notify_charges(session: Session, user_id: str, charges: list[tuple[str, dict[str, Any]]]) -> int:
    """New bank charges that are one of this person's subscriptions: say so.

    ``charges`` is (transaction id, entry fields) for what an import just added.
    """
    if not charges or not configured() or not _devices(session, user_id):
        return 0
    fresh_from = (date.today() - timedelta(days=CHARGE_FRESH_DAYS)).isoformat()
    _source, streams = subscription_streams(session, user_id, None)
    known = {text_key(s["merchant"]): s for s in streams if s["merchant"]}
    sent = 0
    for transaction_id, fields in charges:
        if fields.get("occurred_on", "") < fresh_from:
            continue
        stream = known.get(text_key(fields.get("merchant", "")))
        if stream is None:
            continue
        name = stream["merchant"]
        if notify(
            session, user_id, f"charge:{transaction_id}",
            f"{name} charged {_money(int(fields['amount_cents']))}",
            fields.get("bank") or "Your subscription renewed.",
            "/?tab=subscriptions",
        ):
            sent += 1
    return sent


# -- routes ------------------------------------------------------------------------


@router.get("/config")
def config() -> dict:
    """The public key a browser subscribes with. Open: it's public by design."""
    return {"configured": configured(), "public_key": os.environ.get("VAPID_PUBLIC_KEY", "")}


@router.post("/subscribe")
def subscribe(
    session: SessionDep,
    user_id: UserDep,
    endpoint: Annotated[str, Body(embed=True, min_length=10, max_length=2000)],
    keys: Annotated[dict[str, str], Body(embed=True)],
    timezone: Annotated[str, Body(embed=True, max_length=64)] = "UTC",
) -> dict:
    if not endpoint.startswith("https://"):
        raise HTTPException(status_code=422, detail="not a push endpoint")
    if not keys.get("p256dh") or not keys.get("auth"):
        raise HTTPException(status_code=422, detail="the subscription is missing its keys")
    existing = session.execute(
        select(PushSubscription).where(PushSubscription.endpoint == endpoint)
    ).scalars().first()
    device = existing or PushSubscription(endpoint=endpoint, created_at=utc_now())
    # The same browser signing in as someone else now notifies them, not the last account.
    device.user_id = user_id
    device.p256dh = keys["p256dh"][:200]
    device.auth = keys["auth"][:100]
    device.timezone = timezone or "UTC"
    session.add(device)
    session.commit()
    return {"ok": True, "devices": len(_devices(session, user_id))}


@router.post("/unsubscribe")
def unsubscribe(
    session: SessionDep,
    user_id: UserDep,
    endpoint: Annotated[str, Body(embed=True, max_length=2000)],
) -> dict:
    device = session.execute(
        select(PushSubscription).where(
            PushSubscription.endpoint == endpoint, PushSubscription.user_id == user_id
        )
    ).scalars().first()
    if device is not None:
        session.delete(device)
        session.commit()
    return {"ok": True}


@router.post("/test")
def test(session: SessionDep, user_id: UserDep) -> dict:
    """A notification right now, to check they arrive."""
    if not configured():
        raise HTTPException(status_code=503, detail="notifications aren't set up on this server")
    sent = notify(session, user_id, f"test:{utc_now()}", "Notifications are on",
                  "You'll hear about renewals the day before, and charges as they come in.")
    if not sent:
        raise HTTPException(status_code=409, detail="no device of yours could be reached")
    return {"ok": True}


@router.get("/daily", include_in_schema=False)
def daily(session: SessionDep, authorization: Annotated[str | None, Header()] = None) -> dict:
    """Vercel Cron's once-a-day call: tomorrow's renewals for everyone with notifications on."""
    secret = os.environ.get("CRON_SECRET")
    if not secret or not hmac.compare_digest(authorization or "", f"Bearer {secret}"):
        raise HTTPException(status_code=401, detail="not the scheduler")
    users = set(session.execute(select(PushSubscription.user_id)).scalars())
    sent = 0
    for user_id in users:
        try:
            sent += remind_renewals(session, user_id)
        except Exception as exc:  # noqa: BLE001 - one person's failure mustn't stop the rest
            log.warning("renewal reminders for %s: %s", user_id, exc)
            session.rollback()
    return {"users": len(users), "sent": sent}
