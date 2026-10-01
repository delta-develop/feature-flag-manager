import os
from typing import Annotated

from fastapi import Depends
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import Flag

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./flags.db")

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


def get_session():
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]

SEED_FLAGS = [
    {"key": "announcement-banner", "enabled": True, "description": "Top banner on the ops panel"},
    {"key": "new-reports", "enabled": False, "description": "New reports widget (v2)"},
    {"key": "beta-search", "enabled": True, "description": "Search bar beta"},
    {"key": "maintenance-mode", "enabled": False, "description": "Kill switch: disables the ops panel"},
]


def seed(session: Session) -> None:
    """Insert demo flags on an empty database so the demo works on first run."""
    if session.exec(select(Flag)).first() is None:
        session.add_all(Flag(**data) for data in SEED_FLAGS)
        session.commit()


def init_db() -> None:
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        seed(session)
