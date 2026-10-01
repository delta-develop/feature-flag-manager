# Decision Log

Lightweight record of the decisions behind this project: what we chose, what we gave up, and why.
Newest decisions are appended at the end. Design details live in
[`superpowers/specs/2026-09-30-feature-flag-manager-design.md`](superpowers/specs/2026-09-30-feature-flag-manager-design.md).

---

### D1 — Build the Feature Flag Manager (Option 3)
**Decision:** Build a feature flag manager rather than the other options.
**Why:** Small enough for a one-hour box, useful, and it naturally exercises API design, validation,
error handling and observability. It also leads to good "larger platform" discussions
(SDKs, targeting, environments).

### D2 — Stack: FastAPI + SQLModel + SQLite, React + TypeScript + Vite
**Decision:** Python/FastAPI backend with SQLModel as the ORM, SQLite storage, React + TS frontend.
**Why:** It's the stack we're most productive in. FastAPI has no ORM of its own. SQLModel
(SQLAlchemy + Pydantic) lets one class serve as both table and API schema, which cuts boilerplate.
SQLite needs no server.
**Tradeoff:** SQLite serializes writes. That's fine at this scale, but the evaluation event table
would be the first thing to move to Postgres or a log pipeline.

### D3 — One React app with two routes, not two apps
**Decision:** `/admin` (operator dashboard) and `/demo` (simulated consumer) live in one Vite app.
**Why:** Two apps would double the scaffolding, build config and Docker setup for no extra learning.
Conceptually they are still two independent consumers of the API.
**Tradeoff:** The demo isn't a truly separate deployable. Splitting it out later is mechanical.

### D4 — A generic ops panel for the demo, not a storefront; invest the saved time in evaluation events
**Decision:** The demo is a plain "internal ops panel" whose widgets are gated by flags. We
deliberately did not build a realistic online store to show consumption. The time saved went into
recording every evaluation in an event table and making it visible in the dashboard.
**Why:** The demo's purpose is to show *how a system consumes flags* (asks for values, uses them,
survives failures), not to look like a product. Evaluation events add something the CRUD screen
can't show: whether a flag is actually in use.

### D5 — Evaluation events table instead of counters
**Decision:** Append one row per evaluated key to `flag_evaluation`. Per-flag counts and last-seen
times are computed with `GROUP BY`. The dashboard shows a live feed.
**Alternative considered:** `evaluation_count` / `last_evaluated_at` columns on `flag`. Faster to
build, but no history and no per-client view.
**Tradeoff:** The table grows unbounded and adds a write per evaluation. A real system would
aggregate (time buckets) and apply a retention policy.

### D6 — Separate Admin API and Evaluation API
**Decision:** `/api/flags*` for management, `/api/evaluate` for consumers.
**Why:** The two have different consumers, scaling profiles, caching and auth needs. Separating them
now keeps those concerns from tangling later. For example, evaluation could move to an edge cache
or an SDK with local snapshots without touching admin.

### D7 — Flag `key` is the identifier and is immutable
**Decision:** URLs use `/api/flags/{key}`. Keys cannot be renamed.
**Why:** Keys are what consumer code references. Renaming one silently breaks every client.
"Rename" is create-new + migrate + delete-old.

### D8 — Safe defaults: unknown → false, new → disabled
**Decision:** Evaluating an unknown key returns `false` (and is still recorded). New flags are
created disabled.
**Why:** A missing or mistyped flag must never turn a feature on by accident. Recording unknown keys
surfaces typos and flags deleted while code still uses them.

### D9 — `GET /api/evaluate` even though it writes events
**Decision:** Evaluation is a `GET` with query params.
**Why:** For the consumer it is a read. The event write is telemetry, like an access log.
**Tradeoff:** If responses are ever cached by a proxy, cached hits won't be recorded. At that point
recording would move to the SDK or the edge.

### D10 — One error envelope everywhere, with request ID
**Decision:** Every non-2xx response, including FastAPI's default 422, uses
`{"error": {code, message, request_id, details}}`.
**Why:** Clients handle one shape. The request ID ties a user-visible error to the exact server log
line.

### D11 — Lightweight, dependency-free observability
**Decision:** Request ID middleware, JSON logs via stdlib `logging`, in-memory HTTP metrics keyed by
route template, `/healthz`. Metrics are visible in the dashboard.
**Not chosen:** Prometheus, OpenTelemetry, Grafana: the right production path, but too much
infrastructure for this scope. Percentiles: averages and max are enough for an MVP.
**Tradeoff:** Metrics reset on restart and are per-process.

### D12 — Docker Compose for a one-command run
**Decision:** Ship `docker-compose.yml` (backend + nginx-served frontend, SQLite on a volume).
The README also documents running without Docker.
**Why:** The brief says Docker isn't required to impress. We include it because the reviewer gets the
whole system (two processes, seeded DB) with one command. The API docs (`/docs`, OpenAPI) come from
FastAPI and are available with or without Docker.

### D13 — Same origin through a proxy; no CORS
**Decision:** Vite's dev proxy (local) and nginx (Docker) forward `/api`, `/healthz`, `/docs`,
`/openapi.json` to the backend.
**Why:** Removes CORS configuration and its failure modes entirely.

### D14 — Explicitly out of scope
- **Authentication/authorization:** internal tool. The brief advises against adding it. The first
  production step would be SSO for admin and per-client tokens for evaluation.
- **Environments, targeting, percentage rollouts:** the most valuable next features, but each one
  reshapes the data model. Better designed deliberately than rushed.
- **Audit trail of flag changes:** high value, deferred. The event-table pattern from D5 would apply.
- **Pagination, API versioning:** dozens of flags, brand-new internal API.
- **SSE/WebSockets:** polling (2–5s) is simpler and good enough. Push would matter at scale.

### D15 — Backend tests only
**Decision:** pytest covers the API contract (CRUD, validation, error envelope, evaluation recording,
request IDs, health). The frontend is verified by `tsc` plus a manual walkthrough.
**Why:** The API is the contract other teams depend on. That's where tests buy the most in an hour.

### D16 — Frontend libraries: react-router + TanStack Query, plain CSS
**Decision:** `react-router` (v7) for routes, `@tanstack/react-query` for fetching, polling and
cache invalidation. No component library.
**Why:** Hand-rolling polling, loading/error states and refetch-after-mutation is more code and more
bugs than one well-known library. A component library would be weight we don't need.

### D17 — Admin sidebar with nested routes
**Decision:** `/admin/flags`, `/admin/health`, `/admin/evaluations` behind a simple sidebar.
**Why:** Separates operator concerns (managing flags vs. watching the system) and keeps each page
component small.

### D18 — Documentation in English
**Decision:** All repository documentation is in English.

### D19 — One branch and one PR per ticket
**Decision:** Nothing is committed straight to `main`. Design docs and the plan go through
`docs/design-spec`. Each ticket gets its own branch (`feat/t1-backend`, `feat/t2-admin-dashboard`,
`feat/t3-demo-consumer`, `chore/t4-packaging-docs`) and is merged through a PR. Commits are
prefixed with the ticket ID.
**Why:** It mirrors how a team would work, keeps each review small, and makes the work breakdown
visible in the Git history and on GitHub.
