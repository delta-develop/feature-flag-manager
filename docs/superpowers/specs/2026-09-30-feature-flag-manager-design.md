# Feature Flag Manager — Design

- **Date:** 2026-09-30
- **Status:** Approved in brainstorming, pending written-spec review
- **Context:** Santex take-home ("Option 3, Feature Flag Manager"). Time box: ~60 minutes of build time.
- **Decision log:** [`docs/decisions.md`](../../decisions.md)

## 1. Goal

A first iteration of an internal feature flag service that teammates could keep building on:

- Operators can **create, view, edit, toggle and delete** flags from an admin dashboard.
- Client systems **evaluate** flags through a dedicated API; a demo panel shows a consumer reacting live.
- Every evaluation is recorded, so the dashboard can answer *"is anyone using this flag?"*.
- The service is observable: request IDs, structured logs, HTTP metrics, health check.

### Non-goals (deliberately out of scope)

Authentication/authorization, environments (dev/staging/prod), user targeting / percentage rollouts,
flag history/audit trail, pagination, API versioning, SSE/WebSockets, Prometheus/OpenTelemetry,
frontend automated tests, CI/CD. Rationale for each lives in the decision log.

## 2. Architecture

```
┌──────────────── browser ────────────────┐
│  React app (Vite + TS)                  │
│   /admin/*  operator dashboard          │
│   /demo     simulated consumer system   │
└───────────────┬─────────────────────────┘
                │ same origin: /api/*, /healthz, /docs
     dev: Vite proxy · docker: nginx proxy
                │
┌───────────────▼─────────────────────────┐
│  FastAPI + SQLModel                     │
│   Admin API       /api/flags, ...       │
│   Evaluation API  /api/evaluate         │
│   middleware: request ID, JSON logs,    │
│               in-memory HTTP metrics    │
└───────────────┬─────────────────────────┘
                │
          SQLite (file; docker volume)
```

Same-origin via proxy means **no CORS configuration** anywhere.

### Repository layout

```
backend/
  app/
    main.py             app factory, middleware, exception handlers, router wiring
    db.py               engine, session dependency, create tables, seed on empty DB
    models.py           Flag, FlagEvaluation tables + request/response schemas
    observability.py    request-ID contextvar, JSON log formatter, HTTP metrics store
    routes/admin.py     /api/flags, /api/evaluations, /api/metrics
    routes/evaluate.py  /api/evaluate
  tests/test_api.py
  pyproject.toml        managed with uv
  Dockerfile
frontend/
  src/
    main.tsx            router + QueryClient
    api.ts              typed fetch client, ApiError carrying request_id
    useFlags.ts         SDK-like batch evaluation hook
    admin/Layout.tsx    sidebar + <Outlet/>
    admin/FlagsPage.tsx create form + flags table
    admin/HealthPage.tsx
    admin/EvaluationsPage.tsx
    demo/DemoPage.tsx
    styles.css
  nginx.conf
  Dockerfile
docker-compose.yml
docs/decisions.md
docs/superpowers/specs/  docs/superpowers/plans/
README.md
```

## 3. Data model

**`flag`**

| column | type | notes |
|---|---|---|
| id | int PK | internal only |
| key | str, unique, indexed | public identifier, immutable |
| description | str | default `""`, max 280 |
| enabled | bool | default `false` |
| created_at / updated_at | datetime (UTC) | |

**`flag_evaluation`** (append-only event table)

| column | type | notes |
|---|---|---|
| id | int PK | |
| flag_key | str, indexed | plain text, **not** a FK: history survives deletes and records unknown keys |
| result | bool | value returned to the client |
| flag_exists | bool | `false` when the key was unknown |
| client | str | caller name, default `"unknown"`, max 64 |
| evaluated_at | datetime (UTC), indexed | |

Per-flag metrics (`evaluation_count`, `last_evaluated_at`) are computed with a `GROUP BY` over
`flag_evaluation`. The table grows unbounded — accepted for an MVP (see decision log).

### Seed data (only when the `flag` table is empty)

| key | enabled | used by demo for |
|---|---|---|
| `announcement-banner` | true | top banner |
| `new-reports` | false | new vs. legacy reports widget |
| `beta-search` | true | search bar |
| `maintenance-mode` | false | kill switch covering the whole panel |

## 4. API

The flag `key` is the URL identifier. Keys are immutable because consumers depend on them.

### Admin API (used by the dashboard)

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/api/flags` | 200 list, each with `evaluation_count`, `last_evaluated_at` | — |
| POST | `/api/flags` | 201 created flag | 409 duplicate key, 422 invalid |
| GET | `/api/flags/{key}` | 200 | 404 |
| PATCH | `/api/flags/{key}` | 200; body: `description?`, `enabled?` (at least one) | 404, 422 |
| DELETE | `/api/flags/{key}` | 204 | 404 |
| GET | `/api/evaluations?limit=50` | 200 newest first; `limit` 1–200 | 422 |
| GET | `/api/metrics` | 200 HTTP metrics (see §5) | — |

### Evaluation API (used by consumer systems)

`GET /api/evaluate?keys=a,b&client=demo-panel` → `200 {"flags": {"a": true, "b": false}}`

- `keys`: comma-separated, 1–50 keys, each must match the key format.
- Unknown key → `false` (safe default), still recorded with `flag_exists=false`.
- One `flag_evaluation` row per key per call.

### System

- `GET /healthz` → 200 `{"status": "ok"}` if a `SELECT 1` succeeds, else 503 `{"status": "unavailable"}`
  (plain status body, not the error envelope — it is read by orchestrators, not API clients).
- `GET /docs`, `GET /openapi.json` — generated by FastAPI.

### Validation

- `key`: 2–64 chars, `^[a-z0-9]+(-[a-z0-9]+)*$` (kebab-case).
- `description`: optional, max 280 chars.
- New flags are created **disabled** unless `enabled` is explicitly sent.

### Error envelope (every non-2xx under `/api`, including FastAPI's 422)

```json
{
  "error": {
    "code": "flag_already_exists",
    "message": "Flag 'beta-search' already exists",
    "request_id": "3f2c9a...",
    "details": []
  }
}
```

Codes: `flag_not_found`, `flag_already_exists`, `validation_error` (with `details` = field errors),
`internal_error` (500, message is generic; stack trace only in logs).

## 5. Observability

- **Request ID:** middleware reads `X-Request-ID` (reused if ≤128 chars of `[A-Za-z0-9._-]`),
  otherwise generates a UUID4 hex. Stored in a contextvar, echoed in the response header and in every
  error body. The dashboard shows it in error messages: *"Couldn't save flag (ref: 3f2c9a)"*.
- **Structured logs:** stdlib `logging` with a JSON formatter, one access line per request:
  `request_id, method, path, route, status, duration_ms`. Unhandled exceptions logged with traceback.
- **HTTP metrics (in memory):** keyed by **route template** (`/api/flags/{key}`, not the raw path, to
  keep cardinality bounded): `count, errors_4xx, errors_5xx, avg_ms, max_ms`, plus `uptime_seconds`.
  Reset on restart and per-process — documented limitation; upgrade path is Prometheus/OpenTelemetry.
- **Product metrics:** per-flag evaluation counts and the live evaluations feed (from §3).
- **Health:** `/healthz` doubles as the docker-compose healthcheck.

## 6. Frontend

Single Vite + React + TypeScript app. Libraries: `react-router-dom`, `@tanstack/react-query`. Plain CSS.

### Routes

- `/` → redirect to `/admin/flags`
- `/admin` layout with a simple **sidebar** (`<nav aria-label="Admin">`, `NavLink` → `aria-current`):
  - `/admin/flags` — create form + flags table
  - `/admin/health` — HTTP metrics table (refetch every 5s)
  - `/admin/evaluations` — live feed of last 50 evaluations (refetch every 2s)
  - link to `/demo`
- `/demo` — simulated consumer

### Admin: flags page

- **Create form:** `key`, `description`. Client-side validation mirrors the server regex; server errors
  shown next to the field (409 on `key`) or as a form-level alert with the request ID.
- **Table:** key, inline-editable description, ON/OFF switch, evaluation count, "last evaluated 5s ago",
  delete (native confirm). Refetch every 5s so counts move while the demo runs.

### Demo: "Internal Ops Panel"

- `useFlags(keys, {client: "demo-panel"})` issues **one batch request** to `/api/evaluate` every 3s.
- Widgets gated by the four seed flags (§3).
- On API failure the hook **keeps last known values** (or `false` if never loaded) and the panel shows
  a "flags stale" indicator — a resilient consumer never crashes because the flag service is down.

### Accessibility

Semantic HTML; the toggle is `<button role="switch" aria-checked>` with visible ON/OFF text (not color
alone); every input has a `<label>`; errors announced via `aria-live`; fully keyboard operable.

## 7. Error handling summary

| Situation | Backend | Frontend |
|---|---|---|
| Invalid input | 422 envelope with field `details` | field-level messages |
| Duplicate key | 409 | message on `key` field |
| Missing flag | 404 | alert with request ID |
| Unexpected error | 500 generic message, traceback in logs | alert with request ID |
| Flag service down | — | admin: error state; demo: stale values + indicator |

## 8. Testing

Backend only, `pytest` + FastAPI `TestClient` against in-memory SQLite (~8–10 tests):

1. create → get → list includes it
2. duplicate key → 409 with envelope + `request_id`
3. invalid key → 422 envelope with `details`
4. patch toggles `enabled` and updates `updated_at`
5. delete → 204, then get → 404
6. evaluate known + unknown keys → correct values, rows recorded with `flag_exists`
7. list shows `evaluation_count` / `last_evaluated_at` after evaluations
8. `X-Request-ID` generated when absent, reused when provided
9. `/healthz` → 200

Frontend: `tsc` during build + manual walkthrough (documented tradeoff).

## 9. Running

- **Docker:** `docker compose up --build` → app on `http://localhost:8080`, API docs at `/docs`.
- **Local:** `cd backend && uv run fastapi dev app/main.py` (port 8000) and
  `cd frontend && npm install && npm run dev` (Vite proxies `/api`, `/healthz`, `/docs`, `/openapi.json`).
- Config: `DATABASE_URL` env var (default `sqlite:///./flags.db`; docker uses `/data/flags.db` on a volume).

## 10. Tickets

| Ticket | Scope | Budget |
|---|---|---|
| **T1 — Backend** | models, DB + seed, Admin & Evaluation APIs, validation, error envelope, request ID, JSON logs, metrics, healthz, tests | ~20 min |
| **T2 — Admin dashboard** | app scaffold, typed client, sidebar layout, flags CRUD page, health page, evaluations page | ~15 min |
| **T3 — Demo consumer** | `useFlags` hook, ops panel widgets, stale-on-failure behavior | ~10 min |
| **T4 — Packaging & docs** | Dockerfiles, nginx config, docker-compose, README, finalize decision log | ~10 min |

Commits are prefixed with the ticket ID (`T1: ...`) so history mirrors the breakdown.
The README reports actual time spent, including planning.
