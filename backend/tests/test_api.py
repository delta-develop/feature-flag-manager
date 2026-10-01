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
