# Memory-backed robot jobs

## Delivered workflow

The **Digital twin** page now turns either a natural-language instruction or a
point selected on the 2D plan into a persistent, explainable robot job. The
same workflow works without an OpenAI API key because job planning is
deterministic and grounded in the canonical NEXUS spatial model.

An operator can:

1. describe a job such as `Inspect the Electrical Plant for heat and record
   camera evidence`;
2. optionally press **Choose on map** and select an exact metric destination;
3. choose an executable simulation or a physical plan whose motion remains
   gated;
4. inspect the selected procedure, assigned robot, destination, route length,
   waypoints, matched memory records, risk, and assignment rationale;
5. run the six-stage pipeline in the digital twin; and
6. inspect per-stage evidence and the experience memory written on completion.

Map points are converted from rendered SVG coordinates back into
`building_enu` metres. The API remains authoritative: it verifies the floor
and bounds, snaps the requested point to a navigable location, identifies the
containing room, and recalculates the safe route.

## Planner pipeline

Every new job is planned into these visible stages:

| Stage | Purpose | Current evidence |
| --- | --- | --- |
| Understand intent | Bound the operator instruction and execution contract | Stored original instruction |
| Recall memory | Match a known room and a procedure | Persistent memory keys |
| Validate safety | Check target, route, robot state, known hazards, and stop state | Deterministic route summary |
| Navigate | Follow floor-aware, wall/door/connector-safe waypoints | Simulated navigation evidence |
| Perform | Run the selected bounded capability | Capability-specific simulated evidence |
| Report and remember | Record result, target, robot, and evidence | New `experience:*` memory record and audit entry |

The planner recognizes bounded inspection, hazard survey, mapping, patrol,
delivery rehearsal, and return/dock intent. Hazard terms have priority over a
generic inspection term, so `inspect for heat` selects the safer hazard-standoff
procedure. Named rooms are matched from the same spatial memory shown in the
dashboard. An explicit map target takes precedence over a room name.

Robot assignment is deterministic. It first prefers a robot role that matches
the selected capability, then compares floor proximity, metric distance, and a
stable robot identifier. The result includes a human-readable
`whyThisRobot` explanation.

Route generation uses the existing NEXUS route planner. It treats walls as
solid geometry, subtracts declared door openings, preserves robot clearance,
and permits floor transitions only through co-located vertical connectors. A
browser-selected coordinate is never accepted as a direct command.

## Persistent memory

Memory is scoped to a project and stored in PostgreSQL:

| Kind | Key example | Source |
| --- | --- | --- |
| Location | `location:ground:g-plant` | Rooms and coordinates in the canonical digital twin |
| Procedure | `procedure:hazard` | Versioned NEXUS procedure library |
| Experience | `experience:<job-id>` | A completed simulation job |

Location memory contains floor and room identity, bounds, centre, room kind,
coverage-derived confidence, and source metadata. Procedure memory contains
keywords, capability, action contract, and the simulation/physical safety
boundary. Experience memory contains the original instruction, assigned robot,
target, and result.

Memory does not currently contain learned executable code, arbitrary prompts,
robot credentials, or unreviewed physical commands. A future retrieval system
can rank past experiences, but it must keep versioned procedures and edge safety
policy authoritative.

## REST API

All paths are below `/api/v1`.

| Method and path | Behavior |
| --- | --- |
| `GET /projects/{id}/robot-memory` | Seeds and lists location/procedure memory plus completed experiences |
| `GET /projects/{id}/jobs` | Lists newest jobs first |
| `POST /projects/{id}/jobs` | Validates intent/target and stores a planned job |
| `POST /projects/{id}/jobs/{job_id}/execute` | Starts a planned simulation job |

Example job request:

```json
{
  "instruction": "Inspect the Electrical Plant for heat and record evidence",
  "execution_mode": "simulation",
  "requested_by": "dashboard.operator",
  "target": {
    "floor_id": "ground",
    "x": 18.2,
    "y": 4.5,
    "room_id": "g-plant",
    "room_label": "Electrical Plant"
  }
}
```

The response contains the job state, assignment, metric target, progress,
`memory_context`, six steps, results, and timestamps. Planning and execution
also publish `robot.job.planned`, `robot.job.started`, `robot.job.updated`, and
`robot.job.completed` events through the existing project stream.

## Execution and safety behavior

Simulation execution advances one stored stage at a time, updates progress,
emits evidence events, projects the final virtual pose, appends a
tamper-evident audit record, and writes reusable experience memory. The
emergency-stop flow cancels running jobs and prevents new jobs from starting
while its latch is active.

`execution_mode: physical` can be planned so a judge can see the intended
contract, but the execute endpoint returns a conflict until a certified command
adapter exists. The current Spot adapter remains observation-only: it can read
identity, battery, camera sources, and images but never acquires a lease,
enables motors, or sends motion.

## Path to a real Boston Dynamics robot

Real navigation is a separate edge milestone, not a flag in the dashboard. A
production Spot command adapter should run near the robot and must add, at
minimum:

1. authenticated robot and operator identities;
2. time synchronization and localization in a validated frame;
3. Spot lease ownership, E-Stop endpoint registration, motor power state, and
   keepalive/watchdog handling;
4. an allowlisted command schema such as bounded `navigate_to_pose`, never
   arbitrary code or remote shell access;
5. target/route transformation from `building_enu` into the robot's localized
   frame, with graph-nav/map validation;
6. battery, localization, obstacle, area, speed, timeout, and connection
   preconditions at the edge;
7. expiring human approval bound to robot, capability, target, limits, nonce,
   and job digest;
8. signed command acceptance, progress, cancellation, and completion receipts;
9. an independent physical E-Stop and trained operator; and
10. simulation, fault injection, hardware-in-the-loop, and bounded-floor test
    evidence before deployment.

The dashboard camera can already point at the real Spot adapter while job motion
continues in the digital twin. This is the recommended hackathon setup: a
genuinely live read-only robot feed beside a fully working, inspectable mission
pipeline without overstating physical autonomy.

## Verification coverage

Backend tests cover text-to-room/procedure matching, map targets, simulation
completion, experience-memory creation, and rejection of physical execution.
Frontend tests cover metric projection round trips, map-click target creation,
API snake/camel-case mapping, and the visible job composer. Full dashboard
tests and a production build run alongside the existing spatial, audit,
simulation, and C++ navigation checks.
