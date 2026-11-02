"""Credit scores, kept by hand.

Neither Plaid nor any bank API hands out a person's credit score - in Canada
it comes from Equifax or TransUnion, which offer no consumer API. So scores
are entered as read off a bank app or Borrowell/Credit Karma, and kept as a
history. What can be worked out from the connected banks is credit
utilisation: how much of the cards' limits is in use, one of the biggest
things a score depends on.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import UserDep
from .banking import balance_sheet
from .db import get_session
from .models import BankItem, CreditScore
from .sync import utc_now

router = APIRouter(prefix="/api/credit")

SessionDep = Annotated[Session, Depends(get_session)]

# Canadian scores run 300-900; American ones 300-850.
MIN_SCORE, MAX_SCORE = 300, 900


def _view(score: CreditScore) -> dict:
    return {"id": score.id, "score": score.score, "on": score.on, "source": score.source}


def utilization(session: Session, user_id: str) -> dict | None:
    """Card balances against card limits, across every connected credit card."""
    items = session.execute(
        select(BankItem).where(BankItem.user_id == user_id, BankItem.status != "revoked")
    ).scalars().all()
    cards = [
        a for a in balance_sheet(list(items))["accounts"]
        if a["type"] == "credit" and a["limit_cents"]
    ]
    if not cards:
        return None
    balance = sum(max(a["current_cents"], 0) for a in cards)
    limit = sum(a["limit_cents"] for a in cards)
    return {"balance_cents": balance, "limit_cents": limit, "ratio": balance / limit, "cards": len(cards)}


@router.get("")
def scores(session: SessionDep, user_id: UserDep) -> dict:
    rows = session.execute(
        select(CreditScore).where(CreditScore.user_id == user_id).order_by(CreditScore.on, CreditScore.id)
    ).scalars()
    return {"scores": [_view(row) for row in rows], "utilization": utilization(session, user_id)}


@router.post("")
def add_score(
    session: SessionDep,
    user_id: UserDep,
    score: Annotated[int, Body(embed=True, ge=MIN_SCORE, le=MAX_SCORE)],
    on: Annotated[str, Body(embed=True, pattern=r"^\d{4}-\d{2}-\d{2}$")],
    source: Annotated[str, Body(embed=True, max_length=40)] = "",
) -> dict:
    try:
        when = date.fromisoformat(on)
    except ValueError:
        raise HTTPException(status_code=422, detail="not a real date") from None
    if when > date.today():
        raise HTTPException(status_code=422, detail="that date hasn't happened yet")
    row = CreditScore(user_id=user_id, score=score, on=on, source=source.strip(), created_at=utc_now())
    session.add(row)
    session.commit()
    return _view(row)


@router.delete("/{score_id}")
def remove_score(session: SessionDep, user_id: UserDep, score_id: int) -> dict:
    row = session.get(CreditScore, score_id)
    if row is None or row.user_id != user_id:
        raise HTTPException(status_code=404, detail="no such score")
    session.delete(row)
    session.commit()
    return {"removed": score_id}
