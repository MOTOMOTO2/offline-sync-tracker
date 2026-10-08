"""Request/response models and the entry field schema.

Entry bodies are stored as a JSON blob so the conflict machinery can stay
field-generic, but every patch is still validated against ``FIELD_SPECS`` before
it touches the database.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, Field

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

MAX_OPS_PER_PUSH = 500
MAX_PULL_LIMIT = 500


class FieldSpec(BaseModel):
    kind: Literal["date", "int", "text"]
    default: Any = ""
    max_length: int | None = None
    minimum: int | None = None
    maximum: int | None = None


FIELD_SPECS: dict[str, FieldSpec] = {
    "occurred_on": FieldSpec(kind="date", default="1970-01-01"),
    "amount_cents": FieldSpec(kind="int", default=0, minimum=-100_000_000, maximum=100_000_000),
    "category": FieldSpec(kind="text", default="other", max_length=40),
    "merchant": FieldSpec(kind="text", default="", max_length=80),
    "note": FieldSpec(kind="text", default="", max_length=280),
}

# Offered in the UI; free text is still accepted so the list is a convenience,
# not a constraint the sync protocol has to agree on.
SUGGESTED_CATEGORIES = [
    "groceries",
    "eating out",
    "transport",
    "bills",
    "health",
    "fun",
    "home",
    "other",
]


def default_fields() -> dict[str, Any]:
    return {name: spec.default for name, spec in FIELD_SPECS.items()}


class FieldValidationError(ValueError):
    pass


def validate_patch(patch: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalise a partial field patch. Raises on bad input."""
    if not isinstance(patch, dict):
        raise FieldValidationError("fields must be an object")

    clean: dict[str, Any] = {}
    for name, value in patch.items():
        spec = FIELD_SPECS.get(name)
        if spec is None:
            raise FieldValidationError(f"unknown field {name!r}")
        if value is None:
            raise FieldValidationError(f"field {name!r} must not be null")

        if spec.kind == "int":
            if isinstance(value, bool) or not isinstance(value, int):
                raise FieldValidationError(f"field {name!r} must be an integer")
            if spec.minimum is not None and value < spec.minimum:
                raise FieldValidationError(f"field {name!r} is below the minimum")
            if spec.maximum is not None and value > spec.maximum:
                raise FieldValidationError(f"field {name!r} is above the maximum")
            clean[name] = value
        elif spec.kind == "date":
            if not isinstance(value, str) or not ISO_DATE.match(value):
                raise FieldValidationError(f"field {name!r} must be a YYYY-MM-DD date")
            clean[name] = value
        else:
            if not isinstance(value, str):
                raise FieldValidationError(f"field {name!r} must be a string")
            trimmed = value.strip()
            if spec.max_length is not None and len(trimmed) > spec.max_length:
                raise FieldValidationError(
                    f"field {name!r} is longer than {spec.max_length} characters"
                )
            clean[name] = trimmed

    return clean


class Op(BaseModel):
    op_id: str = Field(min_length=1, max_length=64)
    entry_id: str = Field(min_length=1, max_length=64)
    kind: Literal["create", "update", "delete", "restore"]
    base_rev: int = Field(default=0, ge=0)
    fields: dict[str, Any] = Field(default_factory=dict)
    client_ts: str | None = Field(default=None, max_length=32)
    # op_id of the conflict this op is the explicit resolution for. Purely
    # informational on the server; the client uses it to close out its own
    # conflict record.
    resolves: str | None = Field(default=None, max_length=64)


class PushRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=64)
    ops: list[Op] = Field(default_factory=list, max_length=MAX_OPS_PER_PUSH)


class PushResponse(BaseModel):
    server_time: str
    cursor: int
    results: list[dict[str, Any]]


class PullResponse(BaseModel):
    server_time: str
    cursor: int
    has_more: bool
    changes: list[dict[str, Any]]
