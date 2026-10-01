import logging
from datetime import datetime

from fastapi import APIRouter
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, func, select

from app.db import SessionDep
from app.errors import ApiError
from app.models import Flag, FlagCreate, FlagEvaluation, FlagRead, FlagUpdate, utcnow

logger = logging.getLogger("app.admin")
router = APIRouter(prefix="/api", tags=["admin"])


def get_flag_or_404(session: Session, key: str) -> Flag:
    flag = session.exec(select(Flag).where(Flag.key == key)).first()
    if flag is None:
        raise ApiError(404, "flag_not_found", f"Flag '{key}' not found")
    return flag


def evaluation_stats(session: Session, keys: list[str] | None = None) -> dict[str, tuple[int, datetime]]:
    stmt = select(
        FlagEvaluation.flag_key, func.count(), func.max(FlagEvaluation.evaluated_at)
    ).group_by(FlagEvaluation.flag_key)
    if keys is not None:
        stmt = stmt.where(col(FlagEvaluation.flag_key).in_(keys))
    return {key: (count, last) for key, count, last in session.exec(stmt)}


def to_read(flag: Flag, stats: dict[str, tuple[int, datetime]]) -> FlagRead:
    count, last = stats.get(flag.key, (0, None))
    return FlagRead(**flag.model_dump(), evaluation_count=count, last_evaluated_at=last)


@router.get("/flags", response_model=list[FlagRead])
def list_flags(session: SessionDep):
    flags = session.exec(select(Flag).order_by(Flag.key)).all()
    stats = evaluation_stats(session)
    return [to_read(flag, stats) for flag in flags]


@router.post("/flags", response_model=FlagRead, status_code=201)
def create_flag(data: FlagCreate, session: SessionDep):
    flag = Flag.model_validate(data)
    session.add(flag)
    try:
        session.commit()
    except IntegrityError:  # unique(key): also covers concurrent creates
        session.rollback()
        raise ApiError(409, "flag_already_exists", f"Flag '{data.key}' already exists")
    session.refresh(flag)
    logger.info("flag created", extra={"fields": {"flag_key": flag.key, "enabled": flag.enabled}})
    return to_read(flag, {})


@router.get("/flags/{key}", response_model=FlagRead)
def get_flag(key: str, session: SessionDep):
    return to_read(get_flag_or_404(session, key), evaluation_stats(session, [key]))


@router.patch("/flags/{key}", response_model=FlagRead)
def update_flag(key: str, data: FlagUpdate, session: SessionDep):
    flag = get_flag_or_404(session, key)
    changes = data.model_dump(exclude_none=True)
    flag.sqlmodel_update(changes)
    flag.updated_at = utcnow()
    session.add(flag)
    session.commit()
    session.refresh(flag)
    logger.info("flag updated", extra={"fields": {"flag_key": key, "changes": changes}})
    return to_read(flag, evaluation_stats(session, [key]))


@router.delete("/flags/{key}", status_code=204)
def delete_flag(key: str, session: SessionDep) -> None:
    session.delete(get_flag_or_404(session, key))
    session.commit()
    logger.info("flag deleted", extra={"fields": {"flag_key": key}})
