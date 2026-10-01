from datetime import datetime

from sqlmodel import select

from app.db import SEED_FLAGS, seed
from app.main import app
from app.models import Flag


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
