import re
from datetime import datetime, timezone
from typing import Annotated

from pydantic import AfterValidator, StringConstraints, model_validator
from sqlmodel import Field, SQLModel

KEY_PATTERN = r"^[a-z0-9]+(-[a-z0-9]+)*$"
_KEY_RE = re.compile(KEY_PATTERN)

FlagKey = Annotated[str, StringConstraints(min_length=2, max_length=64, pattern=KEY_PATTERN)]


def is_valid_key(key: str) -> bool:
    return 2 <= len(key) <= 64 and _KEY_RE.fullmatch(key) is not None


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    # SQLite drops tzinfo; values are stored in UTC, so re-attach it on the way out.
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


UtcDatetime = Annotated[datetime, AfterValidator(_as_utc)]


class Flag(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    key: str = Field(index=True, unique=True, max_length=64)
    description: str = Field(default="", max_length=280)
    enabled: bool = False
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class FlagCreate(SQLModel):
    key: FlagKey
    description: str = Field(default="", max_length=280)
    enabled: bool = False


class FlagUpdate(SQLModel):
    description: str | None = Field(default=None, max_length=280)
    enabled: bool | None = None

    @model_validator(mode="after")
    def _at_least_one_field(self):
        if self.description is None and self.enabled is None:
            raise ValueError("Provide 'description' and/or 'enabled'")
        return self


class FlagRead(SQLModel):
    key: str
    description: str
    enabled: bool
    created_at: UtcDatetime
    updated_at: UtcDatetime
    evaluation_count: int = 0
    last_evaluated_at: UtcDatetime | None = None


class FlagEvaluation(SQLModel, table=True):
    __tablename__ = "flag_evaluation"

    id: int | None = Field(default=None, primary_key=True)
    # Plain text, not a foreign key: history survives deletes and unknown keys are recorded.
    flag_key: str = Field(index=True, max_length=64)
    result: bool
    flag_exists: bool
    client: str = Field(default="unknown", max_length=64)
    evaluated_at: datetime = Field(default_factory=utcnow, index=True)


class EvaluationRead(SQLModel):
    id: int
    flag_key: str
    result: bool
    flag_exists: bool
    client: str
    evaluated_at: UtcDatetime


class EvaluateResponse(SQLModel):
    flags: dict[str, bool]


class EvaluationTimeseries(SQLModel):
    bucket_seconds: int
    buckets: list[UtcDatetime]
    series: dict[str, list[int]]
    unknown_keys: list[str]
