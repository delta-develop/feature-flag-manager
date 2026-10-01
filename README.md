# Feature Flag Manager

A small internal feature flag service, built as the first iteration of something a team would keep developing.

- **Admin dashboard** (`/admin`): create, edit, toggle and delete flags; watch system health, a live evaluation feed and charts (evaluations per minute by flag, per-flag activity sparklines, latency by endpoint).
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
| Backend | FastAPI, SQLModel, SQLite, uv | `backend/app`: `routes/admin.py` (management), `routes/evaluate.py` (consumers), `observability.py`, `errors.py` |
| Frontend | React 19, TypeScript, Vite, react-router, TanStack Query | One app, two areas: `src/admin/*` and `src/demo/*`; `useFlags` is the SDK-like consumer hook |
| Packaging | Docker Compose, nginx | nginx serves the SPA and proxies the API, so the browser stays same-origin (no CORS) |

### API at a glance

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/flags` | List (with evaluation stats) / create |
| GET / PATCH / DELETE | `/api/flags/{key}` | Read / update `description`, `enabled` / delete |
| GET | `/api/evaluate?keys=a,b&client=name` | Evaluate flags for a consumer → `{"flags": {"a": true, "b": false}}` |
| GET | `/api/evaluations?limit=50` | Recent evaluations, newest first |
| GET | `/api/evaluations/timeseries?minutes=30` | Evaluations per minute per flag (zero-filled), plus which keys don't exist |
| GET | `/api/metrics` | In-memory HTTP metrics per endpoint |
| GET | `/healthz` | Liveness + DB check |

Every error under `/api` has the same shape: `{"error": {"code", "message", "request_id", "details"}}`.

### Observability

- `X-Request-ID` on every response (reused from the caller or nginx if present). Error bodies include it, and the dashboard shows it as `ref: …` so a user report leads straight to the log line.
- JSON logs: one access line per request (method, route, status, duration), plus admin changes (`flag created/updated/deleted`).
- HTTP metrics (count, 4xx, 5xx, avg/max latency per route template) and product metrics (evaluations per flag, live feed), both visible in the dashboard.
- Charts, hand-drawn in SVG (no chart library): evaluations per minute stacked by flag, evaluations by flag (unknown keys highlighted), activity sparklines in the flags table, latency by endpoint. Each flag keeps its colour across every chart, and every chart has a legend and a data-table fallback.

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

Built with an AI pair (Claude Code) using a spec → plan → tickets workflow that lives in the repo:

1. **Brainstorm → spec:** requirements and design decided together, section by section → [`docs/superpowers/specs/`](docs/superpowers/specs/)
2. **Decision log:** every choice with its rationale and tradeoff → [`docs/decisions.md`](docs/decisions.md)
3. **Plan:** 8 test-first tasks grouped into 4 tickets, with the contracts between tickets spelled out → [`docs/superpowers/plans/`](docs/superpowers/plans/)
4. **Parallel execution:** T1–T3 were built by separate agents in isolated worktrees, one branch + PR per ticket (T3 stacked on T2). See D20.
5. **Review & integration:** each PR checked against the plan, then all branches combined and exercised end to end before merging. That step caught and fixed one metrics bug.

## Time spent

Wall-clock times from the Git history.

| Phase | Window | Time |
|---|---|---|
| Planning: brainstorm, spec, decisions, plan | 22:08–22:50 | ~42 min |
| T1–T3 build (parallel agents, two waves) | 22:50–22:56 | ~6 min |
| Integration review, fix, merges | 22:56–23:03 | ~7 min |
| T4 packaging & docs (incl. resolving a local Docker Desktop conflict) | 23:03–23:10 | ~7 min |

**Total: ~62 min.** Planning took most of the hour on purpose: once the contracts were written down, the build could be parallelized.

**After the time box: T5, charts (~15 min, 23:11–23:26).** The first version showed metrics only as tables. We added charts afterwards and track them separately so the one-hour scope stays honest. The evaluation event table (D5) is what made per-minute charts possible.
