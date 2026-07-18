# NEXUS API

The NEXUS API is the safety-first control plane behind the engineering dashboard. This MVP
turns an objective into deterministic requirements, architecture, and tasks; runs an observable
digital-twin mission; records telemetry and a tamper-evident audit chain; and requires a named
human decision before a project may enter `physical_ready`.

An optional OpenAI-powered engineering review can analyze the bounded project evidence and return
a structured, advisory-only assurance report. It is disabled unless `OPENAI_API_KEY` is configured
and is not required for API or dashboard startup.

Physical execution is deliberately unavailable. Approval never issues a robot or actuator
command: the response always contains `hardware_command_sent: false`, the robot connection stays
`adapter_denied`, and `physical_execution_enabled` stays `false`.

## Run locally

Python 3.11 or newer is required.

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -e ".[dev]"
uvicorn nexus_api.main:app --reload --host 0.0.0.0 --port 8000
```

On Windows, activate with `.venv\Scripts\activate`. The default database is
`sqlite+aiosqlite:///./nexus.db`. PostgreSQL is selected with an async SQLAlchemy URL:

```bash
DATABASE_URL=postgresql+asyncpg://nexus:password@localhost:5432/nexus
```

Tables are created idempotently at startup for this vertical-slice MVP. A production deployment
should replace startup `create_all` with versioned Alembic migrations.

API documentation is available at `/api/v1/docs`. On the first startup against an empty database,
one building-hazard-mapper project is seeded.

## API contract

All REST endpoints use `/api/v1`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Process liveness |
| `GET` | `/ready` | Database readiness |
| `GET` | `/projects` | Project summaries |
| `POST` | `/projects` | Create and deterministically decompose an objective |
| `GET` | `/projects/{id}` | Full dashboard-ready domain detail |
| `GET` | `/projects/{id}/dashboard` | Dashboard compatibility projection |
| `GET` | `/projects/{id}/spatial` | Canonical metre-based building and robot snapshot |
| `POST` | `/projects/{id}/ai-review` | Optional structured, read-only engineering review |
| `POST` | `/projects/{id}/launch` | Start simulation or request physical approval |
| `POST` | `/projects/{id}/mode` | Dashboard mode alias using uppercase mode values |
| `POST` | `/approvals/{id}/decision` | Approve or reject a pending action |
| `POST` | `/projects/{id}/approvals/{approval_id}/decision` | Project-scoped dashboard alias |
| `POST` | `/projects/{id}/emergency-stop` | Latch stop and cancel active work |
| `GET` | `/projects/{id}/telemetry` | Recent telemetry, newest first |
| `GET` | `/projects/{id}/audit` | Recent audit records, newest first |
| `GET` | `/projects/{id}/audit/verify` | Verify the complete SHA-256 chain |

Live events use `WS /ws/projects/{id}`. The first frame is a `dashboard.snapshot`; later frames
contain both `data` and the frontend-compatible `payload` fields. Every envelope includes a
process `stream_id`, a project-scoped monotonic `sequence`, and identical `emitted_at` and
`timestamp` values. A sequence gap tells a client to reconcile with the REST snapshot. Slow
subscribers use a bounded queue and receive the newest state rather than unbounded backlog.

The dashboard response remains backward compatible with its original singular `robot` and
pixel-oriented `map`. It also exposes additive `building` and `robots` fields for the spatial
viewer. The initial WebSocket subscription is registered before the authoritative dashboard
snapshot is constructed, so an event committed during projection is queued and replayed instead
of being lost.

## Spatial digital-twin contract

`GET /projects/{id}/spatial` is a read-only, simulation-only scene snapshot. It is deliberately
synthesized from the existing project and legacy robot state in this iteration; it does not add a
robot command, map upload, database table, or hardware integration path. The response explicitly
keeps `simulationOnly: true` and `physicalExecutionEnabled: false`.

The scene uses metres in a right-handed building ENU frame (`x` east, `y` north, `z` up) and
degrees for dashboard yaw. Its bounded shape is:

- `building`: 24 m by 16 m, three floors at elevations 0.0, 3.4, and 6.8 m, with rooms, walls,
  doors, stairs/lift connectors, per-floor hazards, and a bounded primary route;
- `robots`: three stable virtual robots with full floor-aware pose, battery, speed, localization,
  mission, connection state, and at most 120 trail points each;
- `schemaVersion`, `revision`, `streamId`, and `eventSequence`: reconciliation metadata for live
  clients.

During simulation, the server continues to emit the legacy `simulation.progress` and
`simulation.completed` events. Their `pose` now additively includes `z` and `floorId`. Each
keyframe also emits `robots.state.updated` containing full replacement state for all three
virtual robots and dynamic floor coverage, room exploration, hazards, and paths; static
room/wall/door/connector geometry is not repeated. The deterministic mission contains 12
floor-aware keyframes while retaining four persisted telemetry/audit checkpoints. Emergency stop
cancels the worker before returning and projects every virtual robot as stopped with zero speed.

Physical launch flow:

1. `POST /projects/{id}/launch` with `{"mode":"physical"}` creates a pending critical approval.
2. `POST /approvals/{approval_id}/decision` records a named human decision.
3. Approval changes the project to `physical_ready`; it does not execute hardware.
4. Emergency stop is latched and blocks subsequent launches for that project.

## Optional OpenAI engineering review

`POST /api/v1/projects/{id}/ai-review` accepts a normalized operator identity and optional bounded
evidence:

```json
{
  "requested_by": "human.reviewer",
  "evidence": "Simulation run SIM-42 passed the emergency-stop replay."
}
```

The server builds a canonical JSON evidence packet from the objective, requirements,
architecture, task state, robot state, recent telemetry, audit verification, and the optional
operator evidence. The objective and every evidence value are explicitly marked as untrusted
prompt data. The operator identity is used for the local audit record and is not sent to the
model.

The official OpenAI Python SDK calls the Responses API structured-output parser with a bounded
Pydantic schema. The request is stateless, uses `store=false`, provides no tools, permits no
hardware command path, disables automatic SDK retries, and applies the configured timeout. The
response contains only a bounded readiness enum, concise summary, at most eight findings, and one
next experiment, plus provider/model metadata, the SHA-256 digest of the exact prompt and evidence,
generation time, and the resulting audit-chain hash. Safety-critical, hardware, operations, and
security findings are forced through a human-approval flag even if provider output omits it.

Successful reviews append the compact `engineering.review.completed` audit action and publish a
metadata-only WebSocket event. Full prompt data and model prose are not copied into the audit or
event. Provider errors return a stable secret-free `502`; a missing key returns `503`. Neither path
changes project execution state. Every response keeps `advisory_only: true`, `simulation_only:
true`, `physical_execution_enabled: false`, and `hardware_command_sent: false`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | SQLite file | Async SQLAlchemy database URL |
| `NEXUS_ENVIRONMENT` | `development` | Environment label in health output |
| `NEXUS_LOG_LEVEL` | `INFO` | Python log level |
| `NEXUS_CORS_ORIGINS` | Local dashboard origins | JSON list or comma-separated origins; blank disables CORS |
| `NEXUS_AUDIT_HMAC_KEY` | empty | HMAC-SHA256 secret; required and at least 32 bytes in production |
| `NEXUS_REQUIRE_ACTION_APPROVAL` | `true` | Reserved policy setting; physical launch is always gated |
| `NEXUS_SIMULATION_ONLY` | `true` | Declares the intended safe runtime mode |
| `NEXUS_SEED_DEMO` | `true` | Seed the demo when the projects table is empty |
| `NEXUS_SIMULATION_STEP_DELAY_SECONDS` | `0.2` | Delay between digital-twin updates |
| `OPENAI_API_KEY` | unset | Enables the optional engineering-review provider |
| `NEXUS_OPENAI_MODEL` | `gpt-5.6` | Responses API model used for structured review |
| `NEXUS_OPENAI_TIMEOUT_SECONDS` | `30` | Provider timeout, constrained to 1-120 seconds |

Audit entries use canonical JSON, monotonically increasing project sequence numbers, a previous
hash, and a SHA-256 entry hash. If configured, each hash also receives an HMAC-SHA256 signature.
Production startup rejects an empty, short, or checked-in placeholder signing key. A wildcard
CORS origin cannot be combined with explicit origins, preventing an accidentally credentialed
wildcard policy.
Audit-bearing transactions are serialized with a bounded in-process project-keyed lock stripe.
Before deploying
multiple API replicas, add database-level audit-head serialization (for example, a project audit
head row selected `FOR UPDATE`) so separate processes cannot fork the chain.

## Quality checks

```bash
ruff check .
mypy src
pytest -q
```
