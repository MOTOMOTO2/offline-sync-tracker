"""Monthly budgets per category, and the alerts when spending nears them.

A budget is a limit for one category's spending in a calendar month. When a
month's spending in a category reaches 80% of its budget, and again at 100%,
every device with notifications on hears about it - once per category, month
and threshold. The check runs after anything that changes spending: a push
from a device, and a bank import.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import UserDep
from .db import get_session
from .models import Budget, Entry
from .sync import utc_now

router = APIRouter(prefix="/api/budgets")

SessionDep = Annotated[Session, Depends(get_session)]

THRESHOLDS = (80, 100)


def _view(budget: Budget) -> dict:
    return {"category": budget.category, "amount_cents": budget.amount_cents}


def month_spending(session: Session, user_id: str, month: str) -> dict[str, int]:
    """Each category's spending in ``month`` (YYYY-MM)."""
    totals: dict[str, int] = {}
    rows = session.execute(
        select(Entry).where(Entry.user_id == user_id, Entry.deleted.is_(False))
    ).scalars()
    for entry in rows:
        fields = entry.fields or {}
        if str(fields.get("occurred_on", "")).startswith(month):
            category = fields.get("category") or "other"
            totals[category] = totals.get(category, 0) + int(fields.get("amount_cents", 0))
    return totals


def check_budgets(session: Session, user_id: str, month: str | None = None) -> int:
    """Send any budget alerts now due. Returns how many went out."""
    from .notify import _money, configured, notify  # notify reaches back into banking

    budgets = session.execute(select(Budget).where(Budget.user_id == user_id)).scalars().all()
    if not budgets or not configured():
        return 0
    month = month or date.today().isoformat()[:7]
    spent = month_spending(session, user_id, month)
    sent = 0
    for budget in budgets:
        used = spent.get(budget.category, 0)
        reached = [t for t in THRESHOLDS if used * 100 >= budget.amount_cents * t]
        if not reached:
            continue
        top = reached[-1]
        name = budget.category.capitalize()
        if top >= 100:
            title = f"{name} is over budget"
            body = f"{_money(used)} spent of {_money(budget.amount_cents)} this month."
        else:
            title = f"{name}: {top}% of your budget"
            body = f"{_money(used)} of {_money(budget.amount_cents)}, {_money(budget.amount_cents - used)} left this month."
        # Keyed by threshold, so 80% is said once and 100% once - and if both
        # were crossed at once, only the 100% one is worth saying.
        if notify(session, user_id, f"budget:{budget.category}:{month}:{top}", title, body, "/?tab=spending"):
            sent += 1
        for lower in reached[:-1]:
            notify_key_only(session, user_id, f"budget:{budget.category}:{month}:{lower}")
    return sent


def notify_key_only(session: Session, user_id: str, key: str) -> None:
    """Record an alert as said without sending it (it was overtaken by a bigger one)."""
    from .models import NotificationSent

    if session.get(NotificationSent, (user_id, key)) is None:
        session.add(NotificationSent(user_id=user_id, key=key, at=utc_now()))
        session.commit()


def check_budgets_quietly(session: Session, user_id: str) -> None:
    """For callers whose own work mustn't fail because an alert did."""
    try:
        check_budgets(session, user_id)
    except Exception:  # noqa: BLE001
        session.rollback()


@router.get("")
def budgets(session: SessionDep, user_id: UserDep) -> dict:
    rows = session.execute(
        select(Budget).where(Budget.user_id == user_id).order_by(Budget.category)
    ).scalars()
    return {"budgets": [_view(row) for row in rows]}


@router.put("/{category}")
def set_budget(
    session: SessionDep,
    user_id: UserDep,
    category: str,
    amount_cents: Annotated[int, Body(embed=True, gt=0, le=100_000_000)],
) -> dict:
    category = category.strip()
    if not category or len(category) > 40:
        raise HTTPException(status_code=422, detail="not a category")
    budget = session.get(Budget, (user_id, category)) or Budget(user_id=user_id, category=category)
    budget.amount_cents = amount_cents
    budget.updated_at = utc_now()
    session.add(budget)
    session.commit()
    check_budgets_quietly(session, user_id)
    return _view(budget)


@router.delete("/{category}")
def remove_budget(session: SessionDep, user_id: UserDep, category: str) -> dict:
    budget = session.get(Budget, (user_id, category))
    if budget is not None:
        session.delete(budget)
        session.commit()
    return {"removed": category}
