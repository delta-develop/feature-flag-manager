from datetime import datetime, timedelta

from sqlmodel import select

from app.db import SEED_FLAGS, seed
from app.main import app
from app.models import Flag, FlagEvaluation, utcnow


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


def test_metrics_label_docs_routes_by_path_not_unmatched(client):
    client.get("/openapi.json")
    client.get("/api/does-not-exist")
    routes = client.get("/api/metrics").json()["routes"]
    assert "GET /openapi.json" in routes
    assert "GET unmatched" in routes


def test_timeseries_buckets_per_minute_and_lists_unknown_keys(client):
    client.post("/api/flags", json={"key": "beta-search"})
    client.get("/api/evaluate", params={"keys": "beta-search,ghost"})
    client.get("/api/evaluate", params={"keys": "beta-search"})
    body = client.get("/api/evaluations/timeseries", params={"minutes": 5}).json()
    assert body["bucket_seconds"] == 60
    assert len(body["buckets"]) == 5
    assert body["buckets"][0].endswith(("Z", "+00:00"))
    assert sum(body["series"]["beta-search"]) == 2
    assert sum(body["series"]["ghost"]) == 1
    assert body["unknown_keys"] == ["ghost"]


def test_timeseries_excludes_evaluations_outside_window(client, session):
    session.add(
        FlagEvaluation(
            flag_key="old-flag", result=False, flag_exists=False, evaluated_at=utcnow() - timedelta(hours=2)
        )
    )
    session.commit()
    body = client.get("/api/evaluations/timeseries", params={"minutes": 30}).json()
    assert "old-flag" not in body["series"]


def test_timeseries_rejects_out_of_range_window(client):
    r = client.get("/api/evaluations/timeseries", params={"minutes": 1})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"
