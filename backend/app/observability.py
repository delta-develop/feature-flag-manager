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
