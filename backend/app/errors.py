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
