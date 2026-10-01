from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlmodel import col, select

from app.db import SessionDep
from app.errors import ApiError
from app.models import EvaluateResponse, Flag, FlagEvaluation, is_valid_key

router = APIRouter(prefix="/api", tags=["evaluation"])

MAX_KEYS = 50


def parse_keys(
    keys: Annotated[str, Query(description="Comma-separated flag keys, e.g. `beta-search,new-reports`")],
) -> list[str]:
    parsed = list(dict.fromkeys(k.strip() for k in keys.split(",") if k.strip()))
    if not 1 <= len(parsed) <= MAX_KEYS:
        raise ApiError(422, "validation_error", f"Provide between 1 and {MAX_KEYS} keys")
    invalid = [k for k in parsed if not is_valid_key(k)]
    if invalid:
        raise ApiError(
            422,
            "validation_error",
            "Invalid flag keys",
            [{"loc": ["query", "keys"], "msg": f"Invalid key: {k}", "type": "value_error"} for k in invalid],
        )
    return parsed


@router.get("/evaluate", response_model=EvaluateResponse)
def evaluate(
    session: SessionDep,
    keys: Annotated[list[str], Depends(parse_keys)],
    client: Annotated[str, Query(max_length=64, description="Name of the calling system")] = "unknown",
):
    """Evaluate flags for a consumer. Unknown keys return `false`. Every evaluation is recorded."""
    found = {f.key: f.enabled for f in session.exec(select(Flag).where(col(Flag.key).in_(keys)))}
    results = {k: found.get(k, False) for k in keys}
    session.add_all(
        FlagEvaluation(flag_key=k, result=results[k], flag_exists=k in found, client=client) for k in keys
    )
    session.commit()
    return EvaluateResponse(flags=results)
