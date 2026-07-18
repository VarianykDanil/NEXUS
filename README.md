# NEXUS

NEXUS is an engineering control plane for turning a real-world objective into
requirements, plans, isolated software experiments, simulation results, and
human-approved robot actions. The first milestone is intentionally small: a
Python API, a React dashboard, PostgreSQL, and a dependency-free C++ navigation
core. ROS 2 and Gazebo connect through an optional edge adapter rather than
being required to run the core product.

An optional server-side OpenAI Engineering Review uses the Responses API and
Structured Outputs to examine the current project evidence. It is advisory,
receives no tools, records provenance in the audit chain, and remains disabled
unless `OPENAI_API_KEY` is configured. Deterministic planning and simulation do
not depend on an external model.

The current simulation includes a canonical, metre-based digital twin of a
24 m by 16 m building with three floors, rooms, walls, doors, stairs, a lift,
located hazards, and three virtual robots. The dashboard renders the same model
as an interactive north-up 2D plan and a navigable 3D building. Robot state is
streamed through a sequenced WebSocket contract so a client can detect missed
events and reconcile from an authoritative REST snapshot.

## Start the local stack on Windows

Install and start Docker Desktop, select Linux containers, and ensure Docker
Compose v2 is available. In PowerShell or Windows Terminal, run the command from
the directory that contains `compose.yaml`:

```powershell
Set-Location "C:\path\to\NEXUS"
docker compose config --quiet
docker compose up --build --detach --wait
docker compose ps
Start-Process "http://localhost:3000"
```

Do not run `docker compose up` from your home directory, the parent directory,
or `apps\dashboard`; run it from the cloned `NEXUS` repository root. If Docker
reports that it cannot connect to `dockerDesktopLinuxEngine`, start Docker
Desktop and wait until its engine is ready before retrying.

The dashboard is <http://localhost:3000>. The API health endpoint is
<http://localhost:8000/api/v1/health>. PostgreSQL, the API, and the dashboard
bind to loopback only in the development Compose file.

On macOS or Linux, change to the cloned repository root and run the same
`docker compose config` and `docker compose up` commands in a terminal.

### Move the project to a MacBook through GitHub

Install and start Docker Desktop for Mac, then clone the repository. Because the
repository is private, authenticate with your GitHub account when Git prompts
you (or sign in first with GitHub CLI).

```sh
git clone https://github.com/VarianykDanil/NEXUS.git
cd NEXUS
cp .env.example .env
docker compose config --quiet
docker compose up --build --detach --wait
docker compose ps
open http://localhost:3000
```

The Compose stack uses multi-architecture upstream images and does not pin an
`amd64` platform, so Docker Desktop can select native images on both Intel and
Apple Silicon Macs. The named PostgreSQL volume is local to each computer: the
Git repository transfers source and configuration, not the Windows Docker
database. To move existing project records as well, export and restore a
PostgreSQL dump separately rather than committing database files.

Copy `.env.example` to `.env` to override local ports or credentials. Values in
the example file are not production secrets.

```powershell
docker compose logs --follow
docker compose down
```

The same commands are available as `make up`, `make logs`, and `make down` on
systems with Make installed.

## Explore the digital twin

Open **Digital twin** in the left navigation. The viewer provides:

- **2D plan** and **3D building** modes;
- Ground Floor, Level 1, Level 2, or **All floors**;
- top, isometric, and whole-building camera presets;
- zoom in/out, reset, orbit/pan in 3D, and selected-robot follow mode;
- room, label, trail, hazard, and stair/lift layer toggles;
- selectable robots and hazards with metric position and live status details;
- wall-safe routes that account for wall thickness, robot clearance, declared
  door openings, and co-located vertical connectors;
- smooth 2D and 3D robot motion that snaps rather than animating an unsafe or
  cross-floor straight-line transition;
- an accessible fleet list and automatic fallback to 2D when WebGL is
  unavailable.

Mission Control also includes a derived Mission Assurance brief. Its seven
checks use the current data source, fleet state, displayed route geometry,
simulation evidence, requirements, approvals, and verified audit events; it is
not a fabricated readiness score.

The scene uses the `building_enu` frame: metres, `x` east, `y` north, `z` up,
and dashboard yaw in degrees. See [Digital twin and realtime](docs/digital-twin.md)
for the complete data and event contract.

## API quick check

FastAPI documentation is available at <http://localhost:8000/api/v1/docs>.
The following PowerShell reads the first project and its canonical spatial
snapshot:

```powershell
$projects = Invoke-RestMethod "http://localhost:8000/api/v1/projects"
$projectId = $projects[0].id
$spatial = Invoke-RestMethod "http://localhost:8000/api/v1/projects/$projectId/spatial"
$spatial | ConvertTo-Json -Depth 12
```

Live project events use `ws://localhost:3000/ws/projects/{projectId}` through
the dashboard proxy, or `ws://localhost:8000/ws/projects/{projectId}` directly.
See [the architecture](docs/architecture.md) for the endpoint inventory and
sequencing rules.

## Optional OpenAI Engineering Review

Set `OPENAI_API_KEY` in a local `.env` file, rebuild the API container, and use
**Run OpenAI review** on the Requirements page. The default model can be changed
with `NEXUS_OPENAI_MODEL`; the browser never receives the API key. A direct
PowerShell check is:

```powershell
$projects = Invoke-RestMethod "http://localhost:8000/api/v1/projects"
$projectId = $projects[0].id
$body = @{ requested_by = "demo.operator" } | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:8000/api/v1/projects/$projectId/ai-review" `
  -ContentType "application/json" -Body $body
```

Without a key, the endpoint returns a clear `503` and does not add an audit
record or substitute a fake model result. The design rationale is captured in
[ADR 0004](docs/decisions/0004-openai-engineering-review.md).

## Verify the repository

From the cloned `NEXUS` repository root:

```powershell
pnpm --filter @nexus/dashboard typecheck
pnpm --filter @nexus/dashboard test
pnpm --filter @nexus/dashboard build

ruff check backend
mypy backend/src
pytest -q backend

cmake -S robotics -B build/robotics -DNEXUS_BUILD_TESTS=ON
cmake --build build/robotics --config Release
ctest --test-dir build/robotics --build-config Release --output-on-failure
```

Native verification requires the development dependencies described in the
[developer guide](docs/development.md). Compose smoke checks are:

```powershell
docker compose config --quiet
docker compose up --build --detach --wait
Invoke-RestMethod "http://localhost:8000/api/v1/health"
Invoke-RestMethod "http://localhost:8000/api/v1/ready"
docker compose ps
```

## Safety boundary

The current repository is a software and simulation foundation, not a certified
robot controller. A generated command must never reach physical hardware merely
because a model proposed it. Physical integrations must enforce authorization,
an allowlist, an expiring human approval, limits at the robot edge, and an
independent emergency stop.

Every spatial response explicitly reports `simulationOnly: true` and
`physicalExecutionEnabled: false`. The three displayed robots are virtual.
Selecting **Request physical** creates a control-plane approval request; even an
approved request only reaches a hardware-ready, adapter-denied state. The
dashboard emergency stop confirms a control-plane latch, not an independent
physical emergency stop or robot-edge acknowledgement. No hardware command path
is enabled in this repository.

Read [the architecture](docs/architecture.md),
[developer guide](docs/development.md),
[digital-twin guide](docs/digital-twin.md),
[hackathon demo guide](docs/hackathon-demo.md),
[infrastructure roadmap](docs/infrastructure-roadmap.md),
[robotics integration guide](docs/robotics-integration.md), and
[security and audit model](docs/security-and-audit.md) before extending the
system.
