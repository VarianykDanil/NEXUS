# NEXUS hackathon demo guide

## The one-sentence story

NEXUS turns a real-world engineering objective into reviewable requirements,
simulation evidence, collision-checked robot motion, and a human-gated physical
deployment decision without letting a model directly command hardware.

## What makes the demo credible

The strongest NEXUS demo is not a collection of static dashboard cards. It is a
single evidence chain:

1. An engineer enters an objective in plain language.
2. NEXUS creates measurable requirements and an execution pipeline.
3. The OpenAI Engineering Review produces a schema-validated, read-only review
   when `OPENAI_API_KEY` is configured.
4. Simulation moves the virtual fleet through a metric three-floor building.
5. Every displayed route is checked against wall solids, door openings, robot
   clearance, and co-located stair transitions.
6. Mission Assurance derives its status from the current data source, route
   audits, fleet state, requirements, simulation, approvals, and audit chain.
7. A physical request becomes a pending human approval; even approval leaves
   the hardware adapter denied in this repository.
8. The audit page verifies the complete hash-linked decision history.

This sequence makes each claim inspectable. The dashboard must continue to say
`simulation only` and must not imply that virtual telemetry came from hardware.

## A focused three-minute presentation

### 0:00-0:30 — objective and stakes

Create a project with an objective such as:

> Explore a three-floor office after an alarm, map every accessible area,
> identify heat and smoke hazards, preserve a safe egress route, and require a
> human decision before any physical deployment.

Explain the problem in one line: autonomous engineering systems need useful
agency, but their evidence and authority boundaries must remain visible.

### 0:30-1:10 — plan and AI review

Open **Requirements** to show measurable acceptance criteria, then request an
**OpenAI Engineering Review**. Point out the readiness state, evidence-backed
findings, next experiment, model identifier, input digest, and audit receipt.
The review has no tools and cannot approve or execute a physical action.

If no API key is configured, skip this call rather than pretending a local
result came from OpenAI. The deterministic project plan and all simulation
features remain available offline.

### 1:10-2:05 — spatial proof

Start the simulation and open **Digital twin**:

- switch between the north-up 2D plan and the 3D building;
- use **All floors** and **Home** to frame the complete structure;
- follow a robot while it moves through actual door openings;
- select a robot or hazard and read its metric pose and live state;
- show that stair transitions occur at the declared vertical core;
- point to **Route geometry** in Mission Assurance: it is computed from the
  displayed wall, door, path, and trail data rather than a synthetic score.

### 2:05-2:40 — failure and recovery

Use the emergency-stop flow. The API cancels simulation, projects zero robot
speed, records a safety event, and blocks relaunch while the stop is latched.
For a code-level demo, run the route regression tests to show that a direct
wall-cutting path fails and is replanned through doors.

### 2:40-3:00 — governance proof

Request **Physical** mode. Show the pending approval and the explicit
`hardware_command_sent: false` result. Finish on **Audit log**, where the
hash-linked chain proves which objective, simulation, review, and decision
events were recorded.

## Judge questions to answer directly

| Question | NEXUS answer |
| --- | --- |
| Where is OpenAI used? | An optional server-side Responses API call creates a bounded structured engineering review from current project evidence. |
| Can the model move a robot? | No. The reviewer receives no tools, and this repository has no enabled hardware command path. |
| Is the map real? | It is a deterministic metric digital twin and is labeled simulation-only; it is not represented as SLAM or BIM input. |
| Why trust the route? | Backend and frontend route auditors subtract declared door openings from wall solids, enforce clearance, and test all displayed paths and trails. |
| What happens without internet or an API key? | Deterministic planning, dashboard, simulation, route checks, approvals, and audit verification continue to work; only OpenAI review is unavailable. |
| What is genuinely live? | Sequenced WebSocket project and robot state from the local control plane. Sequence gaps trigger an authoritative REST reconciliation. |
| Is it production-ready? | No. It is a simulation-first engineering foundation; authentication, durable jobs/events, a real simulator, and a certified robot edge remain explicit roadmap work. |

## Pre-demo checklist

Run these commands from the repository root:

```powershell
Set-Location "C:\path\to\NEXUS"
docker compose config --quiet
docker compose up --build --detach --wait
docker compose ps
Invoke-RestMethod "http://localhost:8000/api/v1/health"
Invoke-RestMethod "http://localhost:8000/api/v1/ready"
```

Then verify:

- the browser has no console errors;
- the page is using live API data rather than the offline demo fallback;
- 2D and 3D routes pass through visible door openings;
- **Home**, floor selection, layer controls, robot selection, follow mode, zoom,
  approvals, new objective, and emergency stop all respond;
- the OpenAI key is available only to the API container, never bundled into the
  dashboard;
- the latest backend, frontend, C++ navigation, and Compose checks are green;
- the presenter can explain every simulation-only limitation without hedging.

## Honest next steps after the hackathon

The next credible milestone is a Gazebo/ROS 2 simulation profile with signed
artifact manifests and repeatable scenario fixtures. A physical pilot should
come only after authentication, expiring capability grants, robot-edge
allowlists, watchdogs, independent emergency stop, durable command receipts,
and safety-case review are implemented and tested.
