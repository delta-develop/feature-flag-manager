import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.db import SessionDep, init_db
from app.errors import error_response, register_error_handlers
from app.observability import configure_logging, metrics, request_id_var, resolve_request_id
from app.routes import admin, evaluate

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
app.include_router(admin.router)
app.include_router(evaluate.router)


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
