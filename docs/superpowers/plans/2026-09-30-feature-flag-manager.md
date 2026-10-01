# Feature Flag Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a small feature flag service: a FastAPI backend with Admin and Evaluation APIs, an admin dashboard, and a demo consumer that reacts to flags live.

**Architecture:** FastAPI + SQLModel on SQLite. Flags live in one table and every evaluation is appended to an event table. One Vite/React/TS app serves `/admin/*` (operator dashboard with sidebar) and `/demo` (simulated consumer). The browser always talks to the same origin: Vite proxies in dev, nginx in Docker. Observability comes from a request-ID middleware, JSON logs, in-memory HTTP metrics and `/healthz`.

**Tech Stack:** Python ≥3.11, uv, FastAPI (`fastapi[standard]`), SQLModel, pytest · Node, Vite 8, React 19, TypeScript, react-router 7, TanStack Query 5 · Docker Compose, nginx.

**Spec:** [`docs/superpowers/specs/2026-09-30-feature-flag-manager-design.md`](../specs/2026-09-30-feature-flag-manager-design.md) · **Decisions:** [`docs/decisions.md`](../../decisions.md)

## Global Constraints

- All documentation, code comments and commit messages in **English**.
- Flag key format: 2–64 chars, regex `^[a-z0-9]+(-[a-z0-9]+)*$`. Description max 280 chars. Client name max 64 chars. `/api/evaluate` accepts 1–50 keys.
- Every non-2xx response under `/api` uses `{"error": {"code", "message", "request_id", "details"}}`.
- Unknown flags evaluate to `false`. New flags are created disabled.
- No dependencies beyond those listed in Tech Stack.
- **Branch per ticket**, created from fresh `origin/main` (`git fetch origin && git switch -c <branch> origin/main`). The user merges each ticket's PR before the next ticket starts.
- Commit messages are prefixed with the ticket ID (`T1: ...`) and end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Time box: ~60 min total build time (T1 ~20, T2 ~15, T3 ~10, T4 ~10). If a ticket overruns, cut scope and note it in the README instead of extending.

## File Map

```
backend/
  pyproject.toml, uv.lock, Dockerfile, .dockerignore
  app/__init__.py
  app/main.py            FastAPI app, lifespan, middleware, /healthz, /api/metrics, router wiring
  app/errors.py          ApiError, error_response(), register_error_handlers()
  app/observability.py   request-ID contextvar, JSON log formatter, HttpMetrics
  app/db.py              engine, get_session/SessionDep, init_db(), seed()
  app/models.py          Flag, FlagEvaluation tables; FlagCreate/FlagUpdate/FlagRead/EvaluationRead/EvaluateResponse
  app/routes/__init__.py
  app/routes/admin.py    /api/flags CRUD, /api/evaluations
  app/routes/evaluate.py /api/evaluate
  tests/conftest.py      in-memory DB + TestClient fixtures
  tests/test_api.py
frontend/
  package.json, package-lock.json, tsconfig.json, vite.config.ts, index.html, Dockerfile, nginx.conf, .dockerignore
  src/main.tsx           router + QueryClient
  src/api.ts             types, typed fetch client, ApiError, errorText(), KEY_PATTERN
  src/format.ts          timeAgo(), formatUptime()
  src/useFlags.ts        SDK-like batch evaluation hook
  src/styles.css
  src/admin/Layout.tsx   sidebar + <Outlet/>
  src/admin/FlagsPage.tsx
  src/admin/HealthPage.tsx
  src/admin/EvaluationsPage.tsx
  src/demo/DemoPage.tsx
docker-compose.yml
README.md
.gitignore
```

---

# Ticket T1 — Backend (branch `feat/t1-backend`)

### Task 1: Backend scaffold, error envelope and observability

**Files:**
- Create: `.gitignore`, `backend/pyproject.toml`, `backend/app/__init__.py`, `backend/app/observability.py`, `backend/app/errors.py`, `backend/app/db.py`, `backend/app/models.py` (empty module for now), `backend/app/routes/__init__.py`, `backend/app/main.py`
- Test: `backend/tests/conftest.py`, `backend/tests/test_api.py`

**Interfaces:**
- Produces: `app.main.app` (FastAPI) · `app.db.get_session`, `app.db.SessionDep`, `app.db.engine`, `app.db.init_db()` · `app.errors.ApiError(status: int, code: str, message: str, details: list | None = None)` · `app.observability.request_id_var`, `app.observability.metrics` (`HttpMetrics` with `.record(key: str, status: int, duration_ms: float)` and `.snapshot() -> dict`) · test fixtures `session`, `client`.

- [ ] **Step 1: Create the branch and project files**

```bash
git fetch origin && git switch -c feat/t1-backend origin/main
mkdir -p backend/app/routes backend/tests
touch backend/app/__init__.py backend/app/routes/__init__.py backend/app/models.py
```

`.gitignore`:
```gitignore
__pycache__/
.venv/
*.db
.pytest_cache/
node_modules/
dist/
.DS_Store
```

`backend/pyproject.toml`:
```toml
[project]
name = "feature-flags-backend"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "fastapi[standard]>=0.115",
    "sqlmodel>=0.0.22",
]

[dependency-groups]
dev = ["pytest>=8"]

[tool.pytest.ini_options]
pythonpath = ["."]
```

Run: `cd backend && uv sync`
Expected: creates `.venv` and `uv.lock` without errors.

- [ ] **Step 2: Write the failing tests**

`backend/tests/conftest.py`:
```python
import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app.db import get_session
from app.main import app


@pytest.fixture
def session():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


@pytest.fixture
def client(session):
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app)
    app.dependency_overrides.clear()
```

`backend/tests/test_api.py`:
```python
from app.main import app


def test_healthz_ok(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_request_id_generated_when_absent(client):
    r = client.get("/healthz")
    assert len(r.headers["x-request-id"]) == 32


def test_request_id_reused_when_provided(client):
    r = client.get("/healthz", headers={"X-Request-ID": "abc-123"})
    assert r.headers["x-request-id"] == "abc-123"


def test_invalid_request_id_is_replaced(client):
    r = client.get("/healthz", headers={"X-Request-ID": "bad id!"})
    assert r.headers["x-request-id"] != "bad id!"


def test_unknown_api_route_uses_error_envelope(client):
    r = client.get("/api/nope", headers={"X-Request-ID": "rid-1"})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"
    assert r.json()["error"]["request_id"] == "rid-1"


def test_unhandled_exception_returns_500_envelope(client):
    def boom():
        raise RuntimeError("boom")

    app.add_api_route("/api/_boom", boom)
    try:
        r = client.get("/api/_boom")
    finally:
        app.router.routes.pop()
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "internal_error"
    assert "boom" not in r.text


def test_metrics_counts_requests_by_route_template(client):
    client.get("/healthz")
    body = client.get("/api/metrics").json()
    assert body["routes"]["GET /healthz"]["count"] >= 1
    assert body["uptime_seconds"] >= 0
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && uv run pytest -q`
Expected: collection error (`ImportError: cannot import name 'get_session' from 'app.db'` or `No module named app.db`).

- [ ] **Step 4: Implement observability**

`backend/app/observability.py`:
```python
import json
import logging
import re
import time
import uuid
from collections import defaultdict
from contextvars import ContextVar

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")

_VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def resolve_request_id(incoming: str | None) -> str:
    """Reuse a caller-provided request ID if it is safe to log, otherwise mint one."""
    if incoming and _VALID_REQUEST_ID.match(incoming):
        return incoming
    return uuid.uuid4().hex


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": request_id_var.get(),
            **getattr(record, "fields", {}),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.INFO)
    # Our middleware writes the access log (with request ID); avoid duplicates.
    logging.getLogger("uvicorn.access").disabled = True


class HttpMetrics:
    # ponytail: in-memory and per-process, reset on restart. Upgrade path: Prometheus/OpenTelemetry.
    # Only touched from the event loop (middleware), so no lock is needed.
    def __init__(self) -> None:
        self.started = time.monotonic()
        self.routes: dict[str, dict] = defaultdict(
            lambda: {"count": 0, "errors_4xx": 0, "errors_5xx": 0, "total_ms": 0.0, "max_ms": 0.0}
        )

    def record(self, key: str, status: int, duration_ms: float) -> None:
        m = self.routes[key]
        m["count"] += 1
        m["total_ms"] += duration_ms
        m["max_ms"] = max(m["max_ms"], duration_ms)
        if 400 <= status < 500:
            m["errors_4xx"] += 1
        elif status >= 500:
            m["errors_5xx"] += 1

    def snapshot(self) -> dict:
        return {
            "uptime_seconds": round(time.monotonic() - self.started, 1),
            "routes": {
                key: {
                    "count": m["count"],
                    "errors_4xx": m["errors_4xx"],
                    "errors_5xx": m["errors_5xx"],
                    "avg_ms": round(m["total_ms"] / m["count"], 2),
                    "max_ms": round(m["max_ms"], 2),
                }
                for key, m in self.routes.items()
            },
        }


metrics = HttpMetrics()
```

- [ ] **Step 5: Implement the error envelope**

`backend/app/errors.py`:
```python
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.observability import request_id_var

_HTTP_CODES = {404: "not_found", 405: "method_not_allowed"}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: list | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details or []


def error_response(status: int, code: str, message: str, details: list | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={
            "error": {
                "code": code,
                "message": message,
                "request_id": request_id_var.get(),
                "details": details or [],
            }
        },
    )


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return error_response(exc.status, exc.code, exc.message, exc.details)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):
        # Keep only JSON-safe fields; pydantic's "ctx" may hold exception objects.
        details = [{"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
        return error_response(422, "validation_error", "Request validation failed", details)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException):
        return error_response(exc.status_code, _HTTP_CODES.get(exc.status_code, "http_error"), str(exc.detail))
```

- [ ] **Step 6: Implement the DB module**

`backend/app/db.py`:
```python
import os
from typing import Annotated

from fastapi import Depends
from sqlmodel import Session, SQLModel, create_engine

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./flags.db")

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


def get_session():
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]


def init_db() -> None:
    SQLModel.metadata.create_all(engine)
```

- [ ] **Step 7: Implement the app**

`backend/app/main.py`:
```python
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.db import SessionDep, init_db
from app.errors import error_response, register_error_handlers
from app.observability import configure_logging, metrics, request_id_var, resolve_request_id

logger = logging.getLogger("app")


@asynccontextmanager
async def lifespan(_: FastAPI):
    configure_logging()
    init_db()
    logger.info("startup complete")
    yield


app = FastAPI(
    title="Feature Flag Manager",
    description="Admin API for managing flags and Evaluation API for consumer systems.",
    version="0.1.0",
    lifespan=lifespan,
)
register_error_handlers(app)


@app.middleware("http")
async def observe_requests(request: Request, call_next):
    request_id = resolve_request_id(request.headers.get("x-request-id"))
    token = request_id_var.set(request_id)
    start = time.perf_counter()
    try:
        try:
            response = await call_next(request)
        except Exception:
            logger.exception("unhandled error")
            response = error_response(500, "internal_error", "Internal server error")
        duration_ms = (time.perf_counter() - start) * 1000
        route = request.scope.get("route")
        # Route template (not raw path) keeps metric cardinality bounded.
        template = getattr(route, "path", "unmatched")
        metrics.record(f"{request.method} {template}", response.status_code, duration_ms)
        logger.info(
            "request",
            extra={
                "fields": {
                    "method": request.method,
                    "path": request.url.path,
                    "route": template,
                    "status": response.status_code,
                    "duration_ms": round(duration_ms, 2),
                }
            },
        )
        response.headers["X-Request-ID"] = request_id
        return response
    finally:
        request_id_var.reset(token)


@app.get("/healthz", tags=["system"])
def healthz(session: SessionDep):
    try:
        session.connection().execute(text("SELECT 1"))
    except Exception:
        logger.exception("health check failed")
        return JSONResponse(status_code=503, content={"status": "unavailable"})
    return {"status": "ok"}


@app.get("/api/metrics", tags=["system"])
def get_metrics():
    return metrics.snapshot()
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd backend && uv run pytest -q`
Expected: `7 passed`.

- [ ] **Step 9: Commit**

```bash
git add .gitignore backend
git commit -m "T1: backend scaffold with error envelope, request IDs, JSON logs and HTTP metrics

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Flag model, seed data and Admin CRUD API

**Files:**
- Modify: `backend/app/models.py`, `backend/app/db.py`, `backend/app/main.py`
- Create: `backend/app/routes/admin.py`
- Test: `backend/tests/test_api.py` (append)

**Interfaces:**
- Consumes: `SessionDep`, `ApiError`, `engine` (Task 1).
- Produces: `app.models.Flag`, `FlagEvaluation` (table used by Task 3), `FlagCreate`, `FlagUpdate`, `FlagRead`, `KEY_PATTERN: str`, `is_valid_key(key: str) -> bool`, `utcnow()`, `UtcDatetime` · `app.db.seed(session)`, `app.db.SEED_FLAGS` · `app.routes.admin.router`, `app.routes.admin.evaluation_stats(session, keys: list[str] | None = None) -> dict[str, tuple[int, datetime]]`.
- JSON shape of a flag (consumed by T2): `{key, description, enabled, created_at, updated_at, evaluation_count, last_evaluated_at}`. Timestamps are ISO-8601 UTC.

- [ ] **Step 1: Write the failing tests**

Add to the imports at the top of `backend/tests/test_api.py`:
```python
from datetime import datetime

from sqlmodel import select

from app.db import SEED_FLAGS, seed
from app.models import Flag
```

Append:
```python
def create(client, key="new-checkout", **extra):
    return client.post("/api/flags", json={"key": key, "description": "New checkout flow", **extra})


def test_create_get_and_list_flag(client):
    r = create(client)
    assert r.status_code == 201
    body = r.json()
    assert body["key"] == "new-checkout"
    assert body["enabled"] is False
    assert body["evaluation_count"] == 0
    assert body["last_evaluated_at"] is None
    assert body["created_at"].endswith(("Z", "+00:00"))
    assert client.get("/api/flags/new-checkout").json()["description"] == "New checkout flow"
    assert [f["key"] for f in client.get("/api/flags").json()] == ["new-checkout"]


def test_duplicate_key_returns_409_envelope(client):
    create(client)
    r = create(client)
    assert r.status_code == 409
    error = r.json()["error"]
    assert error["code"] == "flag_already_exists"
    assert error["request_id"] == r.headers["x-request-id"]


def test_invalid_key_returns_422_envelope(client):
    r = create(client, key="Not Valid")
    assert r.status_code == 422
    error = r.json()["error"]
    assert error["code"] == "validation_error"
    assert error["details"][0]["loc"] == ["body", "key"]


def test_patch_toggles_enabled_and_bumps_updated_at(client):
    created = create(client).json()
    r = client.patch("/api/flags/new-checkout", json={"enabled": True})
    assert r.status_code == 200
    assert r.json()["enabled"] is True
    assert datetime.fromisoformat(r.json()["updated_at"]) > datetime.fromisoformat(created["updated_at"])


def test_patch_requires_at_least_one_field(client):
    create(client)
    r = client.patch("/api/flags/new-checkout", json={})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


def test_delete_flag_then_get_returns_404(client):
    create(client)
    assert client.delete("/api/flags/new-checkout").status_code == 204
    r = client.get("/api/flags/new-checkout")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "flag_not_found"


def test_seed_inserts_defaults_only_once(session):
    seed(session)
    seed(session)
    keys = sorted(f.key for f in session.exec(select(Flag)))
    assert keys == sorted(f["key"] for f in SEED_FLAGS)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest -q`
Expected: collection error `ImportError: cannot import name 'SEED_FLAGS' from 'app.db'`.

- [ ] **Step 3: Implement the models**

`backend/app/models.py`:
```python
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
```

- [ ] **Step 4: Add seed data to the DB module**

In `backend/app/db.py`, replace the imports and `init_db` with:
```python
import os
from typing import Annotated

from fastapi import Depends
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import Flag

# ... DATABASE_URL, engine, get_session, SessionDep unchanged ...

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
```

- [ ] **Step 5: Implement the Admin router**

`backend/app/routes/admin.py`:
```python
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
```


- [ ] **Step 6: Wire the router**

In `backend/app/main.py`, add `from app.routes import admin` to the imports and, after `register_error_handlers(app)`:
```python
app.include_router(admin.router)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && uv run pytest -q`
Expected: `14 passed`.

- [ ] **Step 8: Commit**

```bash
git add backend
git commit -m "T1: flag model, seed data and admin CRUD API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Evaluation API, evaluations feed and per-flag stats

**Files:**
- Modify: `backend/app/models.py`, `backend/app/routes/admin.py`, `backend/app/main.py`
- Create: `backend/app/routes/evaluate.py`
- Test: `backend/tests/test_api.py` (append)

**Interfaces:**
- Consumes: `Flag`, `FlagEvaluation`, `is_valid_key`, `UtcDatetime`, `ApiError`, `SessionDep`.
- Produces: `GET /api/evaluate?keys=a,b&client=x` → `{"flags": {key: bool}}` · `GET /api/evaluations?limit=N` → `[{id, flag_key, result, flag_exists, client, evaluated_at}]`, newest first.

- [ ] **Step 1: Write the failing tests**

Change the models import at the top of `backend/tests/test_api.py` to `from app.models import Flag, FlagEvaluation`, then append:
```python
def test_evaluate_known_and_unknown_keys_records_events(client, session):
    client.post("/api/flags", json={"key": "beta-search", "enabled": True})
    r = client.get("/api/evaluate", params={"keys": "beta-search,ghost-flag", "client": "tests"})
    assert r.status_code == 200
    assert r.json() == {"flags": {"beta-search": True, "ghost-flag": False}}
    rows = session.exec(select(FlagEvaluation).order_by(FlagEvaluation.flag_key)).all()
    assert [(e.flag_key, e.result, e.flag_exists, e.client) for e in rows] == [
        ("beta-search", True, True, "tests"),
        ("ghost-flag", False, False, "tests"),
    ]


def test_evaluate_rejects_invalid_keys(client):
    r = client.get("/api/evaluate", params={"keys": "Bad Key"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


def test_list_shows_evaluation_stats(client):
    client.post("/api/flags", json={"key": "beta-search"})
    client.get("/api/evaluate", params={"keys": "beta-search"})
    client.get("/api/evaluate", params={"keys": "beta-search"})
    flag = client.get("/api/flags").json()[0]
    assert flag["evaluation_count"] == 2
    assert flag["last_evaluated_at"] is not None


def test_evaluations_feed_is_newest_first(client):
    client.get("/api/evaluate", params={"keys": "a-1"})
    client.get("/api/evaluate", params={"keys": "b-2"})
    feed = client.get("/api/evaluations", params={"limit": 1}).json()
    assert [e["flag_key"] for e in feed] == ["b-2"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest -q`
Expected: the 4 new tests FAIL with 404 (`/api/evaluate` and `/api/evaluations` don't exist yet).

- [ ] **Step 3: Add response schemas** (append to `backend/app/models.py`)

```python
class EvaluationRead(SQLModel):
    id: int
    flag_key: str
    result: bool
    flag_exists: bool
    client: str
    evaluated_at: UtcDatetime


class EvaluateResponse(SQLModel):
    flags: dict[str, bool]
```

- [ ] **Step 4: Implement the Evaluation router**

`backend/app/routes/evaluate.py`:
```python
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
```

- [ ] **Step 5: Add the evaluations feed** (append to `backend/app/routes/admin.py`)

Add `Query` to the fastapi import and `EvaluationRead` to the models import (`from typing import Annotated` too), then:
```python
@router.get("/evaluations", response_model=list[EvaluationRead])
def list_evaluations(session: SessionDep, limit: Annotated[int, Query(ge=1, le=200)] = 50):
    stmt = select(FlagEvaluation).order_by(col(FlagEvaluation.id).desc()).limit(limit)
    return session.exec(stmt).all()
```

- [ ] **Step 6: Wire the router**

In `backend/app/main.py` change the import to `from app.routes import admin, evaluate` and add:
```python
app.include_router(evaluate.router)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && uv run pytest -q`
Expected: `18 passed`.

- [ ] **Step 8: Smoke test against a real server**

```bash
cd backend && rm -f flags.db && (uv run fastapi dev app/main.py --port 8000 &) && sleep 4
curl -s localhost:8000/api/flags | head -c 300; echo
curl -s "localhost:8000/api/evaluate?keys=beta-search,ghost&client=curl"; echo
curl -si localhost:8000/api/flags/nope | grep -i -E "x-request-id|flag_not_found"
pkill -f "fastapi dev app/main.py"
```
Expected: four seeded flags, `{"flags":{"beta-search":true,"ghost":false}}`, a 404 with `X-Request-ID` header and `flag_not_found` code. The server console shows JSON log lines.

- [ ] **Step 9: Commit, push and open the PR**

```bash
git add backend
git commit -m "T1: evaluation API with recorded events, evaluations feed and per-flag stats

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/t1-backend
gh pr create --base main --head feat/t1-backend --title "T1: Backend API" --body "$(cat <<'EOF'
Implements ticket T1 from the [plan](docs/superpowers/plans/2026-09-30-feature-flag-manager.md).

- Admin API: `/api/flags` CRUD, `/api/evaluations` feed
- Evaluation API: `/api/evaluate` (unknown → false, every evaluation recorded)
- One error envelope with `request_id`; request-ID middleware; JSON logs; in-memory HTTP metrics (`/api/metrics`); `/healthz`
- Seed flags on empty DB
- 18 pytest tests (`cd backend && uv run pytest`)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Ticket T2 — Admin dashboard (branch `feat/t2-admin-dashboard`)

### Task 4: Frontend scaffold, API client, sidebar layout and Flags page

**Files:**
- Create: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/api.ts`, `frontend/src/format.ts`, `frontend/src/styles.css`, `frontend/src/admin/Layout.tsx`, `frontend/src/admin/FlagsPage.tsx`

**Interfaces:**
- Consumes: Admin API JSON shapes from T1.
- Produces (used by Tasks 5–6): `api` object (`listFlags`, `createFlag`, `updateFlag`, `deleteFlag`, `listEvaluations`, `getMetrics`, `health`, `evaluate(keys: string[], client: string)`), types `Flag`, `Evaluation`, `Metrics`, `RouteMetrics`, class `ApiError {status, code, message, requestId, details}`, `errorText(err: unknown): string`, `KEY_PATTERN: RegExp`, `timeAgo(iso: string | null): string`, `formatUptime(seconds: number): string`. CSS classes: `card`, `error`, `visually-hidden`, `switch on|off`, `badge on|off|warn`, `tiles`/`tile`.

Verification for frontend tasks is `npm run build` (runs `tsc`) plus the manual check listed. No frontend unit tests (decision D15).

- [ ] **Step 1: Create the branch and install dependencies**

```bash
git fetch origin && git switch -c feat/t2-admin-dashboard origin/main
mkdir -p frontend/src/admin frontend/src/demo
```

`frontend/package.json`:
```json
{
  "name": "feature-flags-frontend",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  }
}
```

```bash
cd frontend
npm install react@19 react-dom@19 react-router@7 @tanstack/react-query@5
npm install -D vite@8 @vitejs/plugin-react typescript @types/react @types/react-dom
```
Expected: `package-lock.json` created, no errors.

- [ ] **Step 2: Tooling config**

`frontend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`frontend/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = "http://localhost:8000";

// Same-origin in dev: proxy API and docs to the backend, so no CORS is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": backend,
      "/healthz": backend,
      "/docs": backend,
      "/openapi.json": backend,
    },
  },
});
```

`frontend/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Feature Flags</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: API client and formatting helpers**

`frontend/src/api.ts`:
```ts
export type Flag = {
  key: string;
  description: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  evaluation_count: number;
  last_evaluated_at: string | null;
};

export type Evaluation = {
  id: number;
  flag_key: string;
  result: boolean;
  flag_exists: boolean;
  client: string;
  evaluated_at: string;
};

export type RouteMetrics = {
  count: number;
  errors_4xx: number;
  errors_5xx: number;
  avg_ms: number;
  max_ms: number;
};

export type Metrics = { uptime_seconds: number; routes: Record<string, RouteMetrics> };

export type FieldError = { loc: (string | number)[]; msg: string; type: string };

export type FlagChanges = Partial<Pick<Flag, "description" | "enabled">>;

export class ApiError extends Error {
  status: number;
  code: string;
  requestId: string | null;
  details: FieldError[];

  constructor(status: number, code: string, message: string, requestId: string | null, details: FieldError[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

/** Mirrors the backend key rule: 2–64 chars, lowercase kebab-case. */
export const KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    throw new ApiError(0, "network_error", "Can't reach the flag service", null);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body?.error;
    throw new ApiError(
      res.status,
      e?.code ?? "http_error",
      e?.message ?? `Request failed (${res.status})`,
      e?.request_id ?? res.headers.get("x-request-id"),
      e?.details ?? [],
    );
  }
  return body as T;
}

const flagPath = (key: string) => `/api/flags/${encodeURIComponent(key)}`;

export const api = {
  listFlags: () => request<Flag[]>("/api/flags"),
  createFlag: (data: { key: string; description: string }) =>
    request<Flag>("/api/flags", { method: "POST", body: JSON.stringify(data) }),
  updateFlag: (key: string, changes: FlagChanges) =>
    request<Flag>(flagPath(key), { method: "PATCH", body: JSON.stringify(changes) }),
  deleteFlag: (key: string) => request<void>(flagPath(key), { method: "DELETE" }),
  listEvaluations: (limit = 50) => request<Evaluation[]>(`/api/evaluations?limit=${limit}`),
  getMetrics: () => request<Metrics>("/api/metrics"),
  health: () => request<{ status: string }>("/healthz"),
  evaluate: (keys: string[], client: string) =>
    request<{ flags: Record<string, boolean> }>(
      `/api/evaluate?${new URLSearchParams({ keys: keys.join(","), client })}`,
    ),
};

/** User-facing error text; includes a short request ID so operators can find the log line. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return err.requestId ? `${err.message} (ref: ${err.requestId.slice(0, 8)})` : err.message;
  }
  return "Unexpected error";
}
```

`frontend/src/format.ts`:
```ts
export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}
```

- [ ] **Step 4: Styles**

`frontend/src/styles.css`:
```css
:root {
  --bg: #f6f7f9;
  --surface: #fff;
  --text: #1c2430;
  --muted: #5b6676;
  --border: #dde2e8;
  --accent: #005f62;
  --on: #1a7f37;
  --off: #6e7781;
  --danger: #b42318;
  --warn-bg: #fff4d6;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--text);
  background: var(--bg);
}
* { box-sizing: border-box; }
body { margin: 0; }
h1 { margin: 0 0 1rem; font-size: 1.5rem; }
h2 { font-size: 1.1rem; margin: 0 0 0.75rem; }
code { font-family: ui-monospace, monospace; font-size: 0.9em; }
button, input { font: inherit; }
button { cursor: pointer; border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: 0.35rem 0.75rem; }
button:disabled { opacity: 0.6; cursor: default; }
button[type="submit"] { background: var(--accent); color: #fff; border-color: var(--accent); }
input { border: 1px solid var(--border); border-radius: 6px; padding: 0.4rem 0.6rem; }
:focus-visible { outline: 3px solid #4c9ffe; outline-offset: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.error { color: var(--danger); margin: 0.25rem 0 0; }
.error:empty { display: none; }
.muted { color: var(--muted); }

/* Admin layout */
.admin { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
.sidebar { background: #0e2a2b; color: #e6f0f0; padding: 1.25rem 1rem; display: flex; flex-direction: column; gap: 1rem; }
.brand { font-weight: 700; margin: 0; }
.sidebar ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; }
.sidebar a { color: inherit; text-decoration: none; display: block; padding: 0.45rem 0.6rem; border-radius: 6px; }
.sidebar a:hover { background: rgba(255, 255, 255, 0.08); }
.sidebar a[aria-current="page"] { background: rgba(255, 255, 255, 0.16); font-weight: 600; }
.demo-link { margin-top: auto; }
.content { padding: 1.5rem 2rem; max-width: 1100px; }
@media (max-width: 700px) {
  .admin { grid-template-columns: 1fr; }
  .content { padding: 1rem; }
}

/* Cards, forms, tables */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1.25rem; }
.form-row { display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-start; }
.field { display: grid; gap: 0.25rem; min-width: 220px; }
.field small { color: var(--muted); }
.inline-form { display: flex; gap: 0.4rem; }
table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
thead th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
caption { text-align: left; padding: 0.5rem 0; color: var(--muted); }
button.link { border: none; background: none; color: var(--accent); padding: 0 0.25rem; text-decoration: underline; }
button.danger { color: var(--danger); border-color: var(--danger); }
.switch { min-width: 4rem; font-weight: 700; color: #fff; border: none; }
.switch.on { background: var(--on); }
.switch.off { background: var(--off); }
.badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600; color: #fff; }
.badge.on { background: var(--on); }
.badge.off { background: var(--off); }
.badge.warn { background: var(--warn-bg); color: #7a4b00; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin-bottom: 1.25rem; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 0.9rem 1rem; }
.tile p { margin: 0; color: var(--muted); font-size: 0.85rem; }
.tile strong { font-size: 1.6rem; }
```

- [ ] **Step 5: Layout and router**

`frontend/src/admin/Layout.tsx`:
```tsx
import { NavLink, Outlet } from "react-router";

export default function Layout() {
  return (
    <div className="admin">
      <aside className="sidebar">
        <p className="brand">Feature Flags</p>
        <nav aria-label="Admin">
          <ul>
            <li><NavLink to="/admin/flags">Flags</NavLink></li>
            <li><NavLink to="/admin/health">System health</NavLink></li>
            <li><NavLink to="/admin/evaluations">Evaluations</NavLink></li>
          </ul>
        </nav>
        <a className="demo-link" href="/demo" target="_blank" rel="noreferrer">
          Open demo panel ↗
        </a>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
```

`frontend/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Layout from "./admin/Layout";
import FlagsPage from "./admin/FlagsPage";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/admin" element={<Layout />}>
            <Route index element={<Navigate to="flags" replace />} />
            <Route path="flags" element={<FlagsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/admin/flags" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 6: Flags page (create form + table with toggle, inline edit, delete)**

`frontend/src/admin/FlagsPage.tsx`:
```tsx
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText, KEY_PATTERN, type Flag, type FlagChanges } from "../api";
import { timeAgo } from "../format";

const FLAGS_QUERY = ["flags"];

export default function FlagsPage() {
  // Refetch so evaluation counts move while the demo is running.
  const flags = useQuery({ queryKey: FLAGS_QUERY, queryFn: api.listFlags, refetchInterval: 5000 });

  return (
    <>
      <h1>Flags</h1>
      <CreateFlagForm />
      <section aria-labelledby="flags-heading">
        <h2 id="flags-heading">All flags</h2>
        {flags.isPending && <p>Loading…</p>}
        {flags.isError && <p role="alert" className="error">{errorText(flags.error)}</p>}
        {flags.data?.length === 0 && <p className="muted">No flags yet. Create the first one above.</p>}
        {flags.data && flags.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Description</th>
                <th scope="col">Status</th>
                <th scope="col">Evaluations</th>
                <th scope="col">Last evaluated</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {flags.data.map((flag) => <FlagRow key={flag.key} flag={flag} />)}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function CreateFlagForm() {
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: api.createFlag,
    onSuccess: () => {
      setKey("");
      setDescription("");
      queryClient.invalidateQueries({ queryKey: FLAGS_QUERY });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "flag_already_exists") setKeyError(err.message);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (key.length < 2 || key.length > 64 || !KEY_PATTERN.test(key)) {
      setKeyError("Use 2–64 lowercase letters, numbers and single hyphens (e.g. new-checkout).");
      return;
    }
    setKeyError(null);
    create.mutate({ key, description });
  }

  const isKeyConflict = create.error instanceof ApiError && create.error.code === "flag_already_exists";
  const formError = create.isError && !isKeyConflict ? errorText(create.error) : "";

  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="create-heading">
      <h2 id="create-heading">Create flag</h2>
      <div className="form-row">
        <div className="field">
          <label htmlFor="flag-key">Key</label>
          <input
            id="flag-key"
            value={key}
            onChange={(e) => setKey(e.target.value.trim())}
            placeholder="new-checkout"
            autoComplete="off"
            aria-invalid={keyError ? true : undefined}
            aria-describedby="flag-key-hint flag-key-error"
          />
          <small id="flag-key-hint">Lowercase, hyphen-separated. Can't be renamed later.</small>
          <p id="flag-key-error" className="error" aria-live="polite">{keyError}</p>
        </div>
        <div className="field">
          <label htmlFor="flag-description">Description</label>
          <input
            id="flag-description"
            value={description}
            maxLength={280}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
      <button type="submit" disabled={create.isPending}>
        {create.isPending ? "Creating…" : "Create flag"}
      </button>
      <p className="error" role="alert">{formError}</p>
    </form>
  );
}

function FlagRow({ flag }: { flag: Flag }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(flag.description);
  const refresh = () => queryClient.invalidateQueries({ queryKey: FLAGS_QUERY });

  const update = useMutation({
    mutationFn: (changes: FlagChanges) => api.updateFlag(flag.key, changes),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: () => api.deleteFlag(flag.key), onSuccess: refresh });
  const error = update.error ?? remove.error;

  function confirmDelete() {
    if (window.confirm(`Delete "${flag.key}"? Clients still using it will receive false.`)) remove.mutate();
  }

  return (
    <tr>
      <th scope="row">
        <code>{flag.key}</code>
        {error && <p role="alert" className="error">{errorText(error)}</p>}
      </th>
      <td>
        {editing ? (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({ description: draft });
            }}
          >
            <label className="visually-hidden" htmlFor={`desc-${flag.key}`}>Description of {flag.key}</label>
            <input
              id={`desc-${flag.key}`}
              value={draft}
              maxLength={280}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={update.isPending}>Save</button>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        ) : (
          <>
            {flag.description || <span className="muted">No description</span>}
            <button
              type="button"
              className="link"
              aria-label={`Edit description of ${flag.key}`}
              onClick={() => {
                setDraft(flag.description);
                setEditing(true);
              }}
            >
              Edit
            </button>
          </>
        )}
      </td>
      <td>
        <button
          type="button"
          role="switch"
          aria-checked={flag.enabled}
          aria-label={`${flag.key} enabled`}
          className={`switch ${flag.enabled ? "on" : "off"}`}
          disabled={update.isPending}
          onClick={() => update.mutate({ enabled: !flag.enabled })}
        >
          {flag.enabled ? "ON" : "OFF"}
        </button>
      </td>
      <td>{flag.evaluation_count}</td>
      <td>{timeAgo(flag.last_evaluated_at)}</td>
      <td>
        <button type="button" className="danger" disabled={remove.isPending} onClick={confirmDelete}>
          Delete
        </button>
      </td>
    </tr>
  );
}
```

- [ ] **Step 7: Build to verify types**

Run: `cd frontend && npm run build`
Expected: `tsc` passes, Vite prints `✓ built in …`.

- [ ] **Step 8: Manual check**

Run backend (`cd backend && uv run fastapi dev app/main.py`) and frontend (`cd frontend && npm run dev`). Open `http://localhost:5173/admin/flags` and verify:
- the four seed flags are listed
- toggling flips ON/OFF
- editing a description saves
- creating `Bad Key` shows the inline format error
- creating an existing key shows "already exists" under the field
- deleting asks for confirmation and removes the row
- stopping the backend shows an error alert instead of a blank page

- [ ] **Step 9: Commit**

```bash
git add frontend
git commit -m "T2: frontend scaffold, typed API client, sidebar layout and flags CRUD page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: System health and evaluations pages

**Files:**
- Create: `frontend/src/admin/HealthPage.tsx`, `frontend/src/admin/EvaluationsPage.tsx`
- Modify: `frontend/src/main.tsx`

**Interfaces:**
- Consumes: `api.getMetrics`, `api.health`, `api.listEvaluations`, `errorText`, `timeAgo`, `formatUptime`, types `Metrics`, `Evaluation` (Task 4).

- [ ] **Step 1: Health page**

`frontend/src/admin/HealthPage.tsx`:
```tsx
import { useQuery } from "@tanstack/react-query";
import { api, errorText } from "../api";
import { formatUptime } from "../format";

export default function HealthPage() {
  const health = useQuery({ queryKey: ["healthz"], queryFn: api.health, refetchInterval: 5000, retry: false });
  const metrics = useQuery({ queryKey: ["metrics"], queryFn: api.getMetrics, refetchInterval: 5000 });

  const routes = Object.entries(metrics.data?.routes ?? {}).sort(([, a], [, b]) => b.count - a.count);
  const total = routes.reduce((sum, [, m]) => sum + m.count, 0);
  const errors5xx = routes.reduce((sum, [, m]) => sum + m.errors_5xx, 0);
  const status = health.isSuccess ? "Healthy" : health.isError ? "Unavailable" : "Checking…";

  return (
    <>
      <h1>System health</h1>
      <div className="tiles">
        <div className="tile">
          <p>Status</p>
          <strong className={health.isError ? "error" : undefined}>{status}</strong>
        </div>
        <div className="tile">
          <p>Uptime</p>
          <strong>{metrics.data ? formatUptime(metrics.data.uptime_seconds) : "—"}</strong>
        </div>
        <div className="tile">
          <p>Requests</p>
          <strong>{total}</strong>
        </div>
        <div className="tile">
          <p>5xx error rate</p>
          <strong>{total ? `${((errors5xx / total) * 100).toFixed(1)}%` : "—"}</strong>
        </div>
      </div>
      {metrics.isError && <p role="alert" className="error">{errorText(metrics.error)}</p>}
      <table>
        <caption>HTTP metrics per endpoint since the last restart (in-memory, refreshed every 5s)</caption>
        <thead>
          <tr>
            <th scope="col">Endpoint</th>
            <th scope="col">Requests</th>
            <th scope="col">4xx</th>
            <th scope="col">5xx</th>
            <th scope="col">Avg ms</th>
            <th scope="col">Max ms</th>
          </tr>
        </thead>
        <tbody>
          {routes.map(([route, m]) => (
            <tr key={route}>
              <th scope="row"><code>{route}</code></th>
              <td>{m.count}</td>
              <td>{m.errors_4xx}</td>
              <td className={m.errors_5xx ? "error" : undefined}>{m.errors_5xx}</td>
              <td>{m.avg_ms}</td>
              <td>{m.max_ms}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
```

- [ ] **Step 2: Evaluations page**

`frontend/src/admin/EvaluationsPage.tsx`:
```tsx
import { useQuery } from "@tanstack/react-query";
import { api, errorText } from "../api";
import { timeAgo } from "../format";

export default function EvaluationsPage() {
  const feed = useQuery({
    queryKey: ["evaluations"],
    queryFn: () => api.listEvaluations(50),
    refetchInterval: 2000,
  });

  return (
    <>
      <h1>Evaluations</h1>
      <p className="muted">Every time a client system asks for a flag value, it shows up here.</p>
      {feed.isError && <p role="alert" className="error">{errorText(feed.error)}</p>}
      {feed.data?.length === 0 && (
        <p className="muted">No evaluations yet. Open the demo panel to generate some.</p>
      )}
      {feed.data && feed.data.length > 0 && (
        <table>
          <caption>Last 50 evaluations, newest first (refreshed every 2s)</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Client</th>
              <th scope="col">Flag</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {feed.data.map((e) => (
              <tr key={e.id}>
                <td>{timeAgo(e.evaluated_at)}</td>
                <td>{e.client}</td>
                <th scope="row">
                  <code>{e.flag_key}</code>{" "}
                  {!e.flag_exists && <span className="badge warn">unknown flag</span>}
                </th>
                <td><span className={`badge ${e.result ? "on" : "off"}`}>{e.result ? "ON" : "OFF"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
```

- [ ] **Step 3: Add the routes**

In `frontend/src/main.tsx`, add the imports:
```tsx
import HealthPage from "./admin/HealthPage";
import EvaluationsPage from "./admin/EvaluationsPage";
```
and inside the `/admin` route, after the `flags` route:
```tsx
            <Route path="health" element={<HealthPage />} />
            <Route path="evaluations" element={<EvaluationsPage />} />
```

- [ ] **Step 4: Build and manual check**

Run: `cd frontend && npm run build`
Expected: build succeeds.

Then, with both servers running, check:
- `/admin/health` shows the status tiles and per-endpoint rows, which update every 5s
- running `curl "localhost:8000/api/evaluate?keys=beta-search&client=curl"` makes a row appear on `/admin/evaluations` within ~2s
- evaluating `ghost` shows the "unknown flag" badge
- sidebar highlights the active page; Tab key navigates all links and controls

- [ ] **Step 5: Commit, push and open the PR**

```bash
git add frontend
git commit -m "T2: system health and evaluations pages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/t2-admin-dashboard
gh pr create --base main --head feat/t2-admin-dashboard --title "T2: Admin dashboard" --body "$(cat <<'EOF'
Implements ticket T2 from the [plan](docs/superpowers/plans/2026-09-30-feature-flag-manager.md).

- Vite + React + TS app, same-origin dev proxy (no CORS)
- Sidebar layout: Flags / System health / Evaluations
- Flags: create (client-side validation mirroring the API), inline edit, ON/OFF switch, delete with confirmation, evaluation stats
- System health: status, uptime, request totals, 5xx rate, per-endpoint metrics
- Evaluations: live feed with unknown-flag badge
- Errors show a short request ID for log correlation; accessible switch/labels/live regions

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Ticket T3 — Demo consumer (branch `feat/t3-demo-consumer`)

### Task 6: `useFlags` hook and Ops Panel demo

**Files:**
- Create: `frontend/src/useFlags.ts`, `frontend/src/demo/DemoPage.tsx`
- Modify: `frontend/src/main.tsx`, `frontend/src/styles.css` (append)

**Interfaces:**
- Consumes: `api.evaluate(keys, client)` (Task 4).
- Produces: `useFlags<K extends string>(keys: readonly K[], opts: { client: string; intervalMs?: number }) => { flags: Record<K, boolean>; ready: boolean; stale: boolean; lastUpdated: number }`.

- [ ] **Step 1: Create the branch**

```bash
git fetch origin && git switch -c feat/t3-demo-consumer origin/main
```

- [ ] **Step 2: The hook**

`frontend/src/useFlags.ts`:
```ts
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * SDK-like flag hook for consumer systems: one batch request per interval.
 * - Unknown or never-loaded flags are `false` (safe default).
 * - If the flag service fails, the last known values are kept and `stale` is true.
 */
export function useFlags<K extends string>(
  keys: readonly K[],
  { client, intervalMs = 3000 }: { client: string; intervalMs?: number },
) {
  const query = useQuery({
    queryKey: ["evaluate", client, ...keys],
    queryFn: () => api.evaluate([...keys], client),
    refetchInterval: intervalMs,
    // A real service keeps evaluating even when nobody is looking at it.
    refetchIntervalInBackground: true,
    retry: false,
  });

  const flags = Object.fromEntries(keys.map((k) => [k, query.data?.flags[k] ?? false])) as Record<K, boolean>;
  return { flags, ready: query.data !== undefined, stale: query.isError, lastUpdated: query.dataUpdatedAt };
}
```

- [ ] **Step 3: The demo page**

`frontend/src/demo/DemoPage.tsx`:
```tsx
import { useFlags } from "../useFlags";

const FLAG_KEYS = ["announcement-banner", "new-reports", "beta-search", "maintenance-mode"] as const;

export default function DemoPage() {
  const { flags, ready, stale, lastUpdated } = useFlags(FLAG_KEYS, { client: "demo-panel" });

  return (
    <div className="demo">
      <header className="demo-header">
        <div>
          <h1>Ops Panel</h1>
          <p className="muted">
            Demo consumer — every widget is gated by a feature flag evaluated by <code>client=demo-panel</code>.
          </p>
        </div>
        <p className="muted">{ready ? `Flags synced at ${new Date(lastUpdated).toLocaleTimeString()}` : "Loading flags…"}</p>
      </header>

      {stale && (
        <p role="alert" className="stale">
          ⚠ Flag service unreachable — using last known values{ready ? "" : " (defaults: all off)"}.
        </p>
      )}

      {!ready && !stale ? null : flags["maintenance-mode"] ? (
        <section className="maintenance" aria-labelledby="maintenance-title">
          <h2 id="maintenance-title">Down for maintenance</h2>
          <p>This panel is disabled by the <code>maintenance-mode</code> kill switch.</p>
        </section>
      ) : (
        <>
          {flags["announcement-banner"] && (
            <div className="banner" role="note">
              📣 Quarterly planning starts Monday — check the new roadmap.
              <FlagTag flagKey="announcement-banner" />
            </div>
          )}
          {flags["beta-search"] && (
            <div className="card search">
              <label htmlFor="demo-search">Search (beta)</label>
              <input id="demo-search" type="search" placeholder="Search incidents, services, people…" />
              <FlagTag flagKey="beta-search" />
            </div>
          )}
          <div className="widgets">
            <section className="card" aria-labelledby="incidents-title">
              <h2 id="incidents-title">Open incidents</h2>
              <p className="big">3</p>
            </section>
            {flags["new-reports"] ? <NewReports /> : <LegacyReports />}
            <section className="card" aria-labelledby="deploys-title">
              <h2 id="deploys-title">Deploys today</h2>
              <p className="big">12</p>
            </section>
          </div>
        </>
      )}

      <footer className="card">
        <h2>Flag values seen by this client</h2>
        <ul className="flag-values">
          {FLAG_KEYS.map((key) => (
            <li key={key}>
              <code>{key}</code>{" "}
              <span className={`badge ${flags[key] ? "on" : "off"}`}>{flags[key] ? "ON" : "OFF"}</span>
            </li>
          ))}
        </ul>
      </footer>
    </div>
  );
}

function FlagTag({ flagKey }: { flagKey: string }) {
  return <span className="flag-tag">flag: {flagKey}</span>;
}

const REPORT_DATA = [
  { team: "Payments", tickets: 42 },
  { team: "Search", tickets: 27 },
  { team: "Auth", tickets: 18 },
];

function NewReports() {
  const max = Math.max(...REPORT_DATA.map((r) => r.tickets));
  return (
    <section className="card" aria-labelledby="reports-title">
      <h2 id="reports-title">Reports v2 <FlagTag flagKey="new-reports" /></h2>
      <ul className="bars">
        {REPORT_DATA.map((r) => (
          <li key={r.team}>
            <span>{r.team}</span>
            <span className="bar" style={{ width: `${(r.tickets / max) * 100}%` }} aria-hidden="true" />
            <span>{r.tickets}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LegacyReports() {
  return (
    <section className="card" aria-labelledby="reports-title">
      <h2 id="reports-title">Reports (legacy)</h2>
      <table>
        <tbody>
          {REPORT_DATA.map((r) => (
            <tr key={r.team}>
              <th scope="row">{r.team}</th>
              <td>{r.tickets}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 4: Demo styles** (append to `frontend/src/styles.css`)

```css
/* Demo consumer */
.demo { max-width: 960px; margin: 0 auto; padding: 1.5rem; }
.demo-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
.demo-header h1 { margin: 0; }
.stale { background: var(--warn-bg); color: #7a4b00; padding: 0.6rem 1rem; border-radius: 8px; }
.banner { background: var(--accent); color: #fff; padding: 0.75rem 1rem; border-radius: 10px; margin-bottom: 1.25rem; display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.search { display: grid; gap: 0.4rem; }
.widgets { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; }
.widgets .card { margin: 0; }
.big { font-size: 2.2rem; font-weight: 700; margin: 0; }
.bars { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.5rem; }
.bars li { display: grid; grid-template-columns: 5rem 1fr 2.5rem; align-items: center; gap: 0.5rem; }
.bar { display: block; height: 0.8rem; background: var(--accent); border-radius: 4px; }
.flag-tag { font-size: 0.75rem; font-family: ui-monospace, monospace; background: rgba(0, 0, 0, 0.08); padding: 0.1rem 0.4rem; border-radius: 4px; font-weight: 400; }
.banner .flag-tag { background: rgba(255, 255, 255, 0.2); }
.maintenance { background: #2b2b2b; color: #fff; padding: 3rem 1.5rem; border-radius: 10px; text-align: center; }
.flag-values { list-style: none; padding: 0; margin: 0; display: flex; gap: 1.25rem; flex-wrap: wrap; }
.demo > footer { margin-top: 1.25rem; }
```

- [ ] **Step 5: Add the route**

In `frontend/src/main.tsx`, add `import DemoPage from "./demo/DemoPage";` and, before the `*` route:
```tsx
          <Route path="/demo" element={<DemoPage />} />
```

- [ ] **Step 6: Build and manual check**

Run: `cd frontend && npm run build`
Expected: build succeeds.

Open `/admin/flags` and `/demo` side by side, then verify:
- toggling `announcement-banner`, `beta-search` and `new-reports` changes the demo within ~3s
- `maintenance-mode` ON replaces the panel
- `/admin/evaluations` fills with `demo-panel` rows, and evaluation counts rise on the flags page
- deleting `beta-search` hides the search box, and the feed shows the "unknown flag" badge
- stopping the backend shows the stale warning while the panel keeps the last values; restarting clears it

- [ ] **Step 7: Commit, push and open the PR**

```bash
git add frontend
git commit -m "T3: useFlags hook and ops panel demo consumer with stale-on-failure behavior

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/t3-demo-consumer
gh pr create --base main --head feat/t3-demo-consumer --title "T3: Demo consumer" --body "$(cat <<'EOF'
Implements ticket T3 from the [plan](docs/superpowers/plans/2026-09-30-feature-flag-manager.md).

- `useFlags` hook: SDK-like batch evaluation every 3s via the Evaluation API
- Ops Panel demo: banner, beta search, new vs legacy reports, maintenance kill switch
- Resilient consumer: unknown → false, keeps last known values and shows a stale warning when the API is down

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Ticket T4 — Packaging & docs (branch `chore/t4-packaging-docs`)

### Task 7: Docker images and Compose

**Files:**
- Create: `backend/Dockerfile`, `backend/.dockerignore`, `frontend/Dockerfile`, `frontend/.dockerignore`, `frontend/nginx.conf`, `docker-compose.yml`

**Interfaces:**
- Consumes: `DATABASE_URL` env var (Task 1), `/healthz` (Task 1), `npm run build` output in `frontend/dist` (Task 4).
- Produces: `docker compose up --build` → app on `http://localhost:8080`, backend on `http://localhost:8000`.

- [ ] **Step 1: Create the branch and make sure Docker is running**

```bash
git fetch origin && git switch -c chore/t4-packaging-docs origin/main
docker info --format '{{.ServerVersion}}'
```
Expected: a version number. If it errors, start Docker Desktop first.

- [ ] **Step 2: Backend image**

`backend/Dockerfile`:
```dockerfile
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY app ./app

ENV PATH="/app/.venv/bin:$PATH" \
    DATABASE_URL=sqlite:////data/flags.db
RUN mkdir -p /data
EXPOSE 8000
CMD ["fastapi", "run", "app/main.py", "--port", "8000"]
```

`backend/.dockerignore`:
```
.venv
__pycache__
.pytest_cache
*.db
tests
```

- [ ] **Step 3: Frontend image**

`frontend/nginx.conf`:
```nginx
# Reuse the caller's X-Request-ID, otherwise use nginx's own, so proxy and API logs correlate.
map $http_x_request_id $req_id {
    default $http_x_request_id;
    ""      $request_id;
}

server {
    listen 80;
    root /usr/share/nginx/html;

    location ~ ^/(api/|healthz$|docs|openapi\.json$) {
        proxy_pass http://backend:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Request-ID $req_id;
    }

    # SPA fallback for /admin/* and /demo.
    location / {
        try_files $uri /index.html;
    }
}
```

`frontend/Dockerfile`:
```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

`frontend/.dockerignore`:
```
node_modules
dist
```

- [ ] **Step 4: Compose**

`docker-compose.yml`:
```yaml
services:
  backend:
    build: ./backend
    ports: ["8000:8000"]
    volumes:
      - flags-data:/data
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz')"]
      interval: 5s
      timeout: 3s
      retries: 5

  frontend:
    build: ./frontend
    ports: ["8080:80"]
    depends_on:
      backend:
        condition: service_healthy

volumes:
  flags-data:
```

- [ ] **Step 5: Verify end to end**

```bash
docker compose up --build -d
docker compose ps
curl -s localhost:8080/healthz; echo
curl -s localhost:8080/api/flags | head -c 200; echo
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/admin/flags
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/docs
docker compose logs backend | tail -5
docker compose down
```
Expected:
- `backend` is `healthy`
- `{"status":"ok"}`
- the seed flags JSON
- `200` for `/admin/flags` and `/docs`
- JSON log lines in the backend logs

- [ ] **Step 6: Commit**

```bash
git add backend/Dockerfile backend/.dockerignore frontend/Dockerfile frontend/.dockerignore frontend/nginx.conf docker-compose.yml
git commit -m "T4: docker images and compose for one-command run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: README and decision log wrap-up

**Files:**
- Create: `README.md`
- Modify: `docs/decisions.md` (append any decision taken during implementation that isn't already logged)

- [ ] **Step 1: Measure actual time spent**

Run: `git fetch origin && git log --reverse --format='%ad  %s' --date=format:'%H:%M' HEAD`
Use the timestamps to fill in the "Time spent" section below with real numbers per ticket.

- [ ] **Step 2: Write the README**

`README.md`:
````markdown
# Feature Flag Manager

A small internal feature flag service, built as the first iteration of something a team would keep developing.

- **Admin dashboard** (`/admin`): create, edit, toggle and delete flags; watch system health and a live evaluation feed.
- **Evaluation API** (`/api/evaluate`): what client systems call. Unknown flags are `false`, and every evaluation is recorded.
- **Demo consumer** (`/demo`): an "ops panel" whose widgets are gated by flags and react within seconds.

## Run it

**Docker (recommended):**

```bash
docker compose up --build
```

- App: http://localhost:8080 (admin at `/admin`, demo at `/demo`; open them side by side)
- API docs (OpenAPI / Swagger UI): http://localhost:8080/docs

**Without Docker** (Python ≥3.11 with [uv](https://docs.astral.sh/uv/), Node ≥20.19):

```bash
cd backend && uv run fastapi dev app/main.py     # http://localhost:8000
cd frontend && npm install && npm run dev        # http://localhost:5173
```

**Tests:** `cd backend && uv run pytest`

The database is seeded with four demo flags on first run. Set `DATABASE_URL` to change where SQLite lives.

## How it's built

| Part | Stack | Notes |
|---|---|---|
| Backend | FastAPI, SQLModel, SQLite | `backend/app`: `routes/admin.py` (management), `routes/evaluate.py` (consumers), `observability.py`, `errors.py` |
| Frontend | React 19, TypeScript, Vite, react-router, TanStack Query | One app, two areas: `src/admin/*` and `src/demo/*`; `useFlags` is the SDK-like consumer hook |
| Packaging | Docker Compose, nginx | nginx serves the SPA and proxies the API, so the browser stays same-origin (no CORS) |

### API at a glance

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/flags` | List (with evaluation stats) / create |
| GET / PATCH / DELETE | `/api/flags/{key}` | Read / update `description`, `enabled` / delete |
| GET | `/api/evaluate?keys=a,b&client=name` | Evaluate flags for a consumer → `{"flags": {"a": true, "b": false}}` |
| GET | `/api/evaluations?limit=50` | Recent evaluations, newest first |
| GET | `/api/metrics` | In-memory HTTP metrics per endpoint |
| GET | `/healthz` | Liveness + DB check |

Every error under `/api` has the same shape: `{"error": {"code", "message", "request_id", "details"}}`.

### Observability

- `X-Request-ID` on every response (reused from the caller or nginx if present). Error bodies include it, and the dashboard shows it as `ref: …` so a user report leads straight to the log line.
- JSON logs: one access line per request (method, route, status, duration), plus admin changes (`flag created/updated/deleted`).
- HTTP metrics (count, 4xx, 5xx, avg/max latency per route template) and product metrics (evaluations per flag, live feed), both visible in the dashboard.

## Assumptions

- Internal tool used by a handful of operators. Dozens of flags, not thousands.
- Flags are global booleans: no environments, no per-user targeting.
- Consumers poll. A few seconds of propagation delay is acceptable.

## Tradeoffs I chose deliberately

The full list with reasoning is in [`docs/decisions.md`](docs/decisions.md). Highlights:

- **No auth.** Internal tool, and the brief advises against it. First production step: SSO for admin, per-client tokens for evaluation.
- **Event table for evaluations.** History and a per-client view instead of bare counters. It grows unbounded, and production would aggregate and apply retention.
- **In-memory metrics** instead of Prometheus/OpenTelemetry. Zero infrastructure, but they reset on restart and are per-process.
- **Generic demo panel** instead of a realistic storefront. The point is to show consumption, and the time went into evaluation tracking.
- **Backend tests only.** The API is the contract other teams depend on. The frontend is checked by `tsc` plus manual walkthrough.
- **Polling** instead of SSE/WebSockets. Simpler and good enough at this scale.

## If I had another day

1. Audit log of flag changes (who/when/what), reusing the event-table pattern.
2. Environments (dev/staging/prod) and percentage rollouts. Both reshape the data model, so they need deliberate design.
3. Evaluation aggregation (per-minute buckets) + retention, and a "stale flag" view (not evaluated in N days → candidate for removal).
4. Auth: SSO for the dashboard, API tokens per client.
5. Frontend tests (component tests for the flags page, an e2e smoke test of admin → demo).
6. Prometheus metrics endpoint and OpenTelemetry tracing.

## How we worked

This was built with an AI pair (Claude Code), using a spec → plan → tickets workflow kept in the repo:

- Design spec: [`docs/superpowers/specs/`](docs/superpowers/specs/)
- Implementation plan, split into 4 tickets: [`docs/superpowers/plans/`](docs/superpowers/plans/)
- Decision log: [`docs/decisions.md`](docs/decisions.md)
- One branch + PR per ticket (T1 backend, T2 admin dashboard, T3 demo consumer, T4 packaging & docs)

## Time spent

| Phase | Time |
|---|---|
| Planning (brainstorm, spec, plan) | _from git log_ |
| T1 Backend | _from git log_ |
| T2 Admin dashboard | _from git log_ |
| T3 Demo consumer | _from git log_ |
| T4 Packaging & docs | _from git log_ |
````

Replace each `_from git log_` cell with the measured duration from Step 1 before committing.

- [ ] **Step 3: Update the decision log**

Append to `docs/decisions.md` any decision made during implementation that is not already D1–D19, using the same format (`### D20 — Title`, **Decision**, **Why**, **Tradeoff**). If there are none, leave the file unchanged.

- [ ] **Step 4: Commit, push and open the PR**

```bash
git add README.md docs/decisions.md
git commit -m "T4: README with run instructions, assumptions, tradeoffs and next steps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin chore/t4-packaging-docs
gh pr create --base main --head chore/t4-packaging-docs --title "T4: Packaging & docs" --body "$(cat <<'EOF'
Implements ticket T4 from the [plan](docs/superpowers/plans/2026-09-30-feature-flag-manager.md).

- Backend and frontend Docker images; nginx serves the SPA and proxies the API (request IDs propagated)
- `docker compose up --build` runs everything with a healthchecked backend and a persistent SQLite volume
- README: how to run, assumptions, deliberate tradeoffs, next steps, workflow and time spent

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
