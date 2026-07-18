# Developer guide

## Prerequisites

- Docker Desktop or Docker Engine with a recent Compose v2 plugin
- Python 3.11 or newer for native API development
- Node.js 22 with Corepack for native dashboard development
- CMake 3.16+ and a C++17 compiler for the robotics core

ROS 2 and Gazebo are optional. The base application does not require either.

## Configuration

Compose reads `.env` automatically when it exists. Start from the documented
development values:

```powershell
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env`. Keep `.env` untracked. Replace
database credentials and the audit signing key in every shared environment.

Important controls default to their safest useful local values:

- `NEXUS_REQUIRE_ACTION_APPROVAL=true`
- `NEXUS_SIMULATION_ONLY=true`
- all published ports bind to `127.0.0.1`

`OPENAI_API_KEY` is optional and blank in `.env.example`. Set it only when
testing the read-only Engineering Review endpoint. `NEXUS_OPENAI_MODEL` defaults
to `gpt-5.6`, and `NEXUS_OPENAI_TIMEOUT_SECONDS` bounds the provider call. These
values are consumed by the API container and are never Vite build arguments or
browser environment variables.

## Container workflow

### Exact Windows workspace command

For this workspace, open PowerShell or Windows Terminal and change to the
repository root that contains `compose.yaml`:

```powershell
Set-Location "C:\path\to\NEXUS"
docker version
docker compose version
docker compose config --quiet
docker compose up --build --detach --wait
docker compose ps
Start-Process "http://localhost:3000"
```

Docker Desktop must be running with its Linux engine ready. A message mentioning
`dockerDesktopLinuxEngine` or a missing named pipe means the engine is not
running; start Docker Desktop, wait for **Engine running**, and retry. Running
the Compose command from `apps\dashboard`, `backend`, or the parent `Documents`
directory will not select this repository's Compose file.

Validate the fully interpolated configuration before starting it:

```sh
docker compose config --quiet
docker compose up --build --detach --wait
docker compose ps
```

The dashboard is at <http://localhost:3000>, the API at
<http://localhost:8000>, and PostgreSQL at `localhost:5432`. Browser traffic to
`/api/` and `/ws/` goes through the dashboard proxy, so the production build can
use same-origin URLs.

The canonical spatial scene is available at
`GET /api/v1/projects/{id}/spatial`; the interactive 2D/3D control reference is
in [Digital twin and realtime](digital-twin.md).

Useful commands:

```sh
docker compose logs --follow --tail=200
docker compose logs --follow api
docker compose exec db psql -U nexus -d nexus
docker compose down --remove-orphans
```

`docker compose down` preserves the named database volume. Removing volumes is
an explicit destructive operation and is intentionally absent from the Makefile.

## Native API workflow

From the repository root:

```sh
python -m venv .venv
python -m pip install -e "./backend[dev]"
python -m uvicorn nexus_api.main:app --reload --port 8000
```

The API may use its documented SQLite development default when PostgreSQL is not
running. Set `DATABASE_URL` to exercise PostgreSQL behavior.

Windows PowerShell without virtual-environment activation:

```powershell
Set-Location "C:\path\to\NEXUS"
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e ".\backend[dev]"
.\.venv\Scripts\python.exe -m uvicorn nexus_api.main:app --reload --port 8000
```

Checks used by CI:

```sh
ruff check backend
mypy backend/src
pytest -q backend
```

Equivalent explicit Windows commands are:

```powershell
.\.venv\Scripts\python.exe -m ruff check backend
.\.venv\Scripts\python.exe -m mypy backend/src
.\.venv\Scripts\python.exe -m pytest -q backend
```

Database schema changes must eventually use Alembic revisions reviewed alongside
the model change. Production startup must run migrations as a separate one-shot
release job, never concurrently in every API replica.

## Native dashboard workflow

From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @nexus/dashboard dev --host 0.0.0.0 --port 5173
```

The dashboard defaults to same-origin API and WebSocket paths. For native Vite
development, set `VITE_API_BASE_URL` and `VITE_WS_BASE_URL` only when the Vite
proxy is not being used. These values are public build-time configuration, not
secrets.

Run the package's lint, type-check, test, and build scripts before opening a pull
request.

```powershell
pnpm --filter @nexus/dashboard typecheck
pnpm --filter @nexus/dashboard test
pnpm --filter @nexus/dashboard build
```

The dashboard tests cover coordinate projection, floor layout, control
truthfulness, API normalization, event reconciliation, and safety-state flows.

## C++ navigation workflow

```sh
cmake -S robotics -B build/robotics -DNEXUS_BUILD_TESTS=ON
cmake --build build/robotics --config Release
ctest --test-dir build/robotics --build-config Release --output-on-failure
```

Keep deterministic algorithms in the dependency-free library. A future ROS 2
package should be a thin adapter so core behavior remains unit-testable without
a ROS installation.

## Definition of done

A change is complete when its acceptance criterion is testable, automated checks
pass, new configuration is documented, logs contain causal identifiers without
secrets, and changes to capabilities or action policy include a threat-model and
audit review. Robot-facing changes also require a simulation scenario, failure
case, rollback or stop behavior, and named human approver.

## Running-stack smoke verification

From the repository root after `docker compose up --build --detach --wait`:

```powershell
$health = Invoke-RestMethod "http://localhost:8000/api/v1/health"
$ready = Invoke-RestMethod "http://localhost:8000/api/v1/ready"
$projects = Invoke-RestMethod "http://localhost:8000/api/v1/projects"
$id = $projects[0].id
$spatial = Invoke-RestMethod "http://localhost:8000/api/v1/projects/$id/spatial"

$health
$ready
$spatial.schemaVersion
$spatial.simulationOnly
$spatial.physicalExecutionEnabled
$spatial.building.floors.Count
$spatial.robots.Count
```

The expected safety and shape values are schema `1.0`, `simulationOnly` equal to
`True`, `physicalExecutionEnabled` equal to `False`, three floors, and three
virtual robots. Open <http://localhost:3000>, select **Digital twin**, exercise
2D/3D mode, floor/all-floor selection, camera presets, zoom/reset, follow,
layers, and robot/hazard selection, then start a simulation with **SIM** to
observe sequenced fleet updates.

## Troubleshooting

- If `api` remains unhealthy, inspect `docker compose logs api db` and confirm
  `/api/v1/health` responds inside the container.
- If the dashboard returns `502`, check that `api` is healthy; nginx resolves it
  on the Compose `edge` network.
- If port 5432 is already occupied, change `NEXUS_DB_PORT` in `.env`. Internal
  services still use `db:5432`.
- If a pnpm build cannot find a workspace package, add that package's manifest to
  the dependency-copy stage in `docker/web.Dockerfile` before the install step.
- On Apple Silicon or Windows, run Gazebo/ROS separately from the core stack and
  follow the edge-adapter guidance rather than changing the default Compose file.
