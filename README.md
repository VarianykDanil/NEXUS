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
events and reconcile from an authoritative REST snapshot. When demo motion is
enabled, all three robots continuously follow closed, collision-checked routes
at four authoritative updates per second. The Digital Twin shows the live rate
and provides explicit start/stop controls.

The **Live robot camera** panel has a built-in Demo Spot feed for presentations
and an optional Boston Dynamics Spot SDK 5.1.4 adapter for real robot identity,
battery telemetry, camera discovery, and current images. Both adapters are
read-only and keep robot motion locked.

The **Memory-backed autonomy** panel accepts a natural-language job or an exact
2D map target. NEXUS recalls room and procedure memory, assigns a virtual robot,
calculates a wall/door/connector-safe route, displays a six-stage execution
pipeline, runs it in the digital twin, and stores the completed experience for
reuse. Physical jobs can be planned but remain motion-gated. See the
[robot jobs guide](docs/robot-jobs.md).

## Hackathon reviewer quick start

NEXUS is a standalone web application, not a browser plugin. The supported
development/demo platforms are macOS (Intel or Apple Silicon), Windows with
Docker Desktop using Linux containers, and Linux with Docker Engine and Compose
v2. A reviewer needs Docker only; OpenAI credentials, Spot credentials, ROS,
Gazebo, Node.js, and Python are optional for the default demo.

```sh
git clone https://github.com/VarianykDanil/NEXUS.git
cd NEXUS
cp .env.example .env
docker compose up --build --detach --wait
```

Open <http://localhost:3006>. On the first empty database, NEXUS automatically
creates the **Sentinel Mapper - Building Hazard Reconnaissance** sample project,
three continuously moving virtual robots, a three-floor metric building, known
hazards, robot memory, and a changing Demo Spot camera. No account or external
service is required. After the initial installation, restart the same demo
without rebuilding it:

```sh
docker compose up --detach --wait
```

The complete reviewer path is documented in the
[hackathon demo guide](docs/hackathon-demo.md). The organizer-specific final
checks are tracked in the [submission checklist](docs/submission-checklist.md).

## Start the local stack on Windows

Install and start Docker Desktop, select Linux containers, and ensure Docker
Compose v2 is available. In PowerShell or Windows Terminal, run the command from
the directory that contains `compose.yaml`:

```powershell
Set-Location "C:\path\to\NEXUS"
docker compose config --quiet
docker compose up --build --detach --wait
docker compose ps
Start-Process "http://localhost:3006"
```

Do not run `docker compose up` from your home directory, the parent directory,
or `apps\dashboard`; run it from the cloned `NEXUS` repository root. If Docker
reports that it cannot connect to `dockerDesktopLinuxEngine`, start Docker
Desktop and wait until its engine is ready before retrying.

The dashboard is <http://localhost:3006>. The API health endpoint is
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
open http://localhost:3006
```

The Compose stack uses multi-architecture upstream images and does not pin an
`amd64` platform, so Docker Desktop can select native images on both Intel and
Apple Silicon Macs. The named PostgreSQL volume is local to each computer: the
Git repository transfers source and configuration, not the Windows Docker
database. To move existing project records as well, export and restore a
PostgreSQL dump separately rather than committing database files.

Copy `.env.example` to `.env` to override API/database ports or credentials.
The dashboard port is fixed at `3006`. Values in the example file are not
production secrets.

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
- a natural-language job composer and **Choose on map** mode with persistent
  location, procedure, and completed-experience memory;
- an explainable robot assignment, verified route, six-stage live pipeline,
  per-stage evidence, and simulation execution.

Mission Control also includes a derived Mission Assurance brief. Its seven
checks use the current data source, fleet state, displayed route geometry,
simulation evidence, requirements, approvals, and verified audit events; it is
not a fabricated readiness score.

For the hackathon robot feed, keep `NEXUS_ROBOT_ADAPTER=demo`, open **Digital
twin**, verify **VIRTUAL FLEET LIVE**, and connect the robot link. Virtual fleet
motion starts automatically, remains smooth while job stages execute, and is
clearly labeled simulation-only. To use a real Spot, follow the
[Spot robot-link guide](docs/spot-robot-link.md); the robot password stays in the
server-side `.env` file.

Continuous movement is configured with `NEXUS_DEMO_MOTION_AUTOSTART`,
`NEXUS_DEMO_MOTION_FRAME_INTERVAL_SECONDS`, and
`NEXUS_DEMO_MOTION_SPEED_MULTIPLIER`. Defaults are `true`, `0.25`, and `1.0`.
See the [continuous demo-motion guide](docs/demo-motion.md).

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

Live project events use `ws://localhost:3006/ws/projects/{projectId}` through
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

## How Codex and GPT-5.6 were used

Codex was the primary development environment for the hackathon build. Working
from the existing Windows-oriented repository, Codex was used to inspect and
migrate the project to macOS, fix the dashboard on port `3006`, implement the
FastAPI/PostgreSQL/React changes, build the continuous virtual fleet and
memory-backed job workflow, integrate the read-only Spot adapter, write tests
and operating documentation, rebuild Docker, and exercise the final UI in a
real browser. The human developer supplied the product goals, chose the safety
boundary, reviewed visible behavior, and remains responsible for submission and
physical-robot decisions.

GPT-5.6 was used through Codex for repository reasoning, implementation,
debugging, test generation, documentation, and acceptance-test planning. NEXUS
also has a distinct optional product feature configured with
`NEXUS_OPENAI_MODEL=gpt-5.6`: a server-side Responses API engineering reviewer
that receives a bounded evidence snapshot and returns schema-validated findings.
That reviewer receives no tools, cannot change project state, cannot approve a
physical action, and is disabled when `OPENAI_API_KEY` is absent. The
deterministic planner, demo robots, job execution, camera feed, approvals, and
audit verification continue to work without an API key.

All AI-assisted changes were checked with deterministic automated tests, strict
type checking, production builds, Docker health checks, route-geometry audits,
and browser acceptance tests. Codex output is treated as a proposed engineering
change, not as safety evidence or physical motion authority. Before submission,
the exact Codex session identifier and model provenance must be copied from the
official `/feedback` result into the submission form.

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
`physicalExecutionEnabled: false`. The three robots in the metric map remain
virtual. A separate read-only robot link can connect either the Demo Spot feed
or one real Spot's telemetry and image services. Selecting **Request physical**
creates a control-plane approval request; approval may connect that observation
link, but it sends no hardware command. The dashboard emergency stop confirms a
control-plane latch, not an independent physical emergency stop or robot-edge
acknowledgement. No motion-command path is enabled in this repository.

Read [the architecture](docs/architecture.md),
[developer guide](docs/development.md),
[digital-twin guide](docs/digital-twin.md),
[continuous demo-motion guide](docs/demo-motion.md),
[hackathon demo guide](docs/hackathon-demo.md),
[timed demo video script](docs/demo-video-script.md),
[final submission checklist](docs/submission-checklist.md),
[memory-backed robot jobs](docs/robot-jobs.md),
[Spot robot-link guide](docs/spot-robot-link.md),
[infrastructure roadmap](docs/infrastructure-roadmap.md),
[robotics integration guide](docs/robotics-integration.md), and
[security and audit model](docs/security-and-audit.md) before extending the
system.
