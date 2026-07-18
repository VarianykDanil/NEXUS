# Digital twin and realtime contract

## Delivered scope

NEXUS exposes one canonical metric scene to the 2D plan, 3D building, REST API,
and live event reducer. This iteration is a deterministic digital-twin
simulation synthesized from project state. It is not a SLAM map, BIM import,
point cloud, Gazebo world, ROS transform tree, or physical-robot connection.

The delivered scene contains:

- one 24 m by 16 m building in the `building_enu` frame;
- Ground Floor, Level 1, and Level 2 at elevations 0.0, 3.4, and 6.8 m;
- bounded room rectangles, wall segments, doors, stairs, and lift connectors;
- per-floor coverage, route/trail points, and located hazards;
- three virtual robots with stable identifiers, roles, floor-aware 3D poses,
  heading, battery, speed, localization, mission, connection, and bounded trails;
- 12 floor-aware mission checkpoints expanded into collision-checked paths
  across all three floors.

All distances are metres. The right-handed ENU frame uses `x` east, `y` north,
and `z` up. Dashboard yaw is expressed in degrees. Consumers must use the frame
and unit metadata rather than treating spatial values as SVG pixels.

The route planner treats walls as solid rectangles using each wall's thickness,
then subtracts declared door intervals. A robot centre must retain 0.18 m of
clearance beyond the wall surface. Same-floor checkpoints are connected with a
deterministic visibility graph through navigable doorway approaches. A floor
change is valid only when adjacent trail points share the same metric coordinate
inside a declared stair connector. Backend and frontend regression tests audit
every fallback route, emitted floor path, and displayed robot trail against
these rules.

## Operator controls

The Mission Control page embeds a compact spatial viewer. The **Digital twin**
page presents the full viewer and fleet details. Both use the same state.

### View and floor

- **2D plan** renders a north-up metric plan. Selecting **All floors** produces
  readable small multiples; selecting one floor fills the viewport.
- **3D building** lazily loads the Three.js scene. If WebGL initialization or
  context recovery fails, NEXUS returns to the live 2D plan and displays the
  reason.
- The floor menu selects **All floors**, **Ground Floor**, **Level 1**, or
  **Level 2**, including each floor's current coverage.

### Camera and navigation

- **Top camera** frames a plan view. In 2D it resets to north-up; in 3D it moves
  the perspective camera above the selected floor set.
- **Isometric camera** switches from 2D to 3D when necessary and frames the
  selected floor set obliquely.
- **Frame whole building** shows the complete building, independent of the
  current single-floor selection.
- **Zoom in**, **Zoom out**, and **Reset view** work in both modes.
- Desktop 3D supports orbit, pan, and zoom. On coarse-pointer devices, the
  **Interact with 3D / Done** control prevents camera gestures from trapping
  normal page scrolling.
- **Follow robot** follows the selected robot, or the active robot when none is
  selected. Selecting a robot from the plan, 3D scene, or fleet list changes the
  follow target.
- Short, same-floor 2D updates interpolate along a directly validated segment
  and use the shortest heading rotation. Floor changes, reduced-motion mode,
  large jumps, and wall-unsafe direct updates snap to the authoritative pose.
  The 3D scene independently interpolates toward the same pose state.

### Layers and selection

The **Layers** menu independently controls rooms, labels, robot/mission trails,
hazards, and vertical connectors. Structural walls and doors remain visible so
the plan does not lose its safety-relevant boundary.

The 3D renderer splits wall meshes at the same declared door openings used by
the route planner. Door leaves occupy those gaps, so a legal doorway crossing
does not visually appear to pass through a continuous wall.

Robots and hazards are selectable. The inspector reports robot model, floor,
metric `x/y`, yaw, battery, and speed, or hazard floor, position, type, severity,
and confidence. The fleet list provides a keyboard-accessible alternative to
selecting objects directly in the graphics view.

## REST spatial snapshot

`GET /api/v1/projects/{project_id}/spatial` returns the read-only canonical
scene. Important top-level fields are:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Spatial schema version; currently `1.0` |
| `projectId` | Owning project |
| `generatedAt` | UTC snapshot generation time |
| `revision` | Project-derived spatial revision |
| `streamId` | Current API-process live-stream identity |
| `eventSequence` | Latest project sequence known when the snapshot was made |
| `simulationOnly` | Always `true` in this implementation |
| `physicalExecutionEnabled` | Always `false` in this implementation |
| `building` | Metric building and its floors |
| `robots` | Full replacement state for the three virtual robots |

Each floor contains `rooms`, `walls`, `doors`, `connectors`, `hazards`, and a
bounded primary `path`. Every robot pose and trail point carries `floorId` and
`x/y/z`; trails are limited to 120 points. Arrays and numeric ranges are bounded
and non-finite values are rejected by the API schema.

The compatibility endpoint
`GET /api/v1/projects/{project_id}/dashboard` also includes additive `building`
and `robots` fields. Its original singular `robot` and pixel-oriented `map`
remain temporarily available for older clients; new spatial UI should use the
metric fields.

Example from PowerShell after starting Compose:

```powershell
$projects = Invoke-RestMethod "http://localhost:8000/api/v1/projects"
$id = $projects[0].id
Invoke-RestMethod "http://localhost:8000/api/v1/projects/$id/spatial" |
  ConvertTo-Json -Depth 12
```

## Sequenced WebSocket stream

Connect to `WS /ws/projects/{project_id}`. Through Compose, browser clients use
the same-origin path `ws://localhost:3000/ws/projects/{project_id}`; direct API
clients may use port 8000.

The server subscribes before constructing the first authoritative snapshot, so
an event committed during snapshot projection is queued and delivered afterward.
The first frame is `dashboard.snapshot`. Subsequent frames use this envelope:

```json
{
  "schema_version": "1.0",
  "stream_id": "process-uuid",
  "sequence": 42,
  "type": "robots.state.updated",
  "project_id": "project-id",
  "emitted_at": "2026-07-12T19:00:00Z",
  "timestamp": "2026-07-12T19:00:00Z",
  "data": {},
  "payload": {}
}
```

`data` and `payload` contain identical values for backend and dashboard client
compatibility. `sequence` increases monotonically per project within one
`stream_id`. A changed `stream_id` identifies an API-process restart. Duplicate
or older events are ignored. A sequence gap causes the dashboard to fetch an
authoritative dashboard snapshot, queue events received during reconciliation,
then replay them on the refreshed state.

The in-process broker has a bounded subscriber queue. If a slow client falls
behind, the oldest queued event is discarded; the resulting sequence gap makes
the loss detectable rather than allowing unbounded memory growth. The dashboard
reconnects with bounded exponential backoff after a socket closes.

During simulation the relevant spatial events are:

| Event | Payload behavior |
| --- | --- |
| `dashboard.snapshot` | Authoritative full dashboard, including building and fleet |
| `simulation.started` | Simulation state transition |
| `simulation.progress` | Legacy-compatible progress plus floor-aware `x/y/z/yaw/floorId` pose |
| `robots.state.updated` | Full replacement state for all three robots plus dynamic floor coverage, per-room explored percentage, hazards, and paths; static room/wall/door/connector geometry is not repeated |
| `simulation.completed` | Final progress and pose; a final fleet event follows |
| `safety.emergency_stop` | Critical, zero-speed stopped state |

The broker is process-local and events are not durable. A production deployment
still needs the transactional outbox and external event transport described in
the infrastructure roadmap.

## Safety boundary

The spatial endpoint, displayed fleet, movement, hazards, and emergency-stop
effects are simulations. `robots.state.updated` is telemetry-like display state,
not a command channel.

- **Request physical** creates a critical human approval request.
- Approval records a control-plane decision and may mark the project
  `physical_ready`, but the adapter remains denied and no actuator command is
  transmitted.
- The dashboard emergency stop can confirm only that the API latched the
  project stop and cancelled its simulation worker. It is not proof that a
  future robot edge, motor controller, or independent physical emergency stop
  acknowledged anything.
- A real integration must add an authenticated edge gateway, bounded command
  schema, local interlocks and watchdogs, signed receipts, and an independent
  emergency stop before physical execution can be considered.

Do not change `simulationOnly` or `physicalExecutionEnabled` merely to make the
UI appear live. They describe an enforced capability boundary, not a presentation
mode.
