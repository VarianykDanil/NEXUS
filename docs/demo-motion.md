# Continuous virtual fleet motion

## Purpose

NEXUS provides a continuously moving, simulation-only fleet so a live demo does
not depend on a physical robot, a cloud service, or prerecorded animation. The
API calculates each pose from a monotonic clock and sends the complete
three-robot state over the existing sequenced project WebSocket. The 2D and 3D
clients interpolate the short distance between frames.

This feed is not physical telemetry. Every robot reports
`connection: virtual_demo_stream_live`; every control response reports
`simulation_only: true` and `hardware_command_sent: false`. Spatial events also
report `physicalExecutionEnabled: false`.

## Motion model

Each virtual robot has a stable identity, role, nominal speed, and phase offset.
Its closed patrol is expanded by the same visibility-graph planner used by job
planning. Consequently:

- same-floor segments retain 0.18 m robot clearance from wall solids;
- wall crossings occur only through declared door openings;
- floor changes are co-located inside the declared stair connector;
- routes loop without an end-of-demo reset;
- battery changes slowly and deterministically instead of jumping randomly;
- each frame carries a bounded 12-second trail; and
- movement continues while the visible memory-backed job pipeline executes.

The default frame interval is 0.25 seconds (4 updates per second). Robot speeds
are 0.62, 0.48, and 0.38 m/s before applying the configured multiplier. These
short frame-to-frame distances stay inside the dashboard's safe interpolation
limit, producing smooth movement without animating through a wall or between
floors.

## Dashboard control

Open **Digital twin** and find **Virtual fleet motion**. The control reports:

- `VIRTUAL FLEET LIVE` or `VIRTUAL FLEET STOPPED`;
- the number of robots currently observed moving;
- the authoritative update rate;
- the route-speed multiplier; and
- the fixed simulation/no-hardware boundary.

**Stop virtual motion** cancels only the virtual stream, publishes one static
fleet replacement, and records an audit event. **Start virtual motion** creates
a new worker and records a corresponding audit event. Mission simulation,
physical-mode requests, and the emergency-stop latch take precedence and cancel
the continuous worker when their authority boundary requires it. After a normal
mission simulation completes, autostart mode restores continuous movement.

## Configuration

The following server-side environment variables are available:

| Variable | Default | Bounds | Meaning |
| --- | ---: | ---: | --- |
| `NEXUS_DEMO_MOTION_AUTOSTART` | `true` | boolean | Start motion for eligible existing and newly created projects |
| `NEXUS_DEMO_MOTION_FRAME_INTERVAL_SECONDS` | `0.25` | 0.1–2.0 | Delay between authoritative frames |
| `NEXUS_DEMO_MOTION_SPEED_MULTIPLIER` | `1.0` | 0.1–4.0 | Multiplier applied to bounded virtual speeds |

Compose passes all three values into the API. A manually stopped worker starts
again after an API restart when autostart remains enabled; manual stop is an
operational demo control, not a persisted safety policy.

## REST API

All paths are below `/api/v1`:

| Method and path | Result |
| --- | --- |
| `GET /projects/{id}/demo-motion` | Current worker status and configured rate |
| `POST /projects/{id}/demo-motion/start` | Starts simulation-only movement |
| `POST /projects/{id}/demo-motion/stop` | Stops movement and emits a static fleet state |

Start and stop accept an optional JSON actor record:

```json
{
  "requested_by": "dashboard.operator"
}
```

Starting is rejected while emergency stop is latched, while physical mode is
requested, or while the checkpoint mission simulation owns the spatial stream.
The worker also self-terminates if an eligible project later becomes physically
scoped or emergency-stopped.

## Verification

Backend tests prove that all closed routes remain collision checked, every
vertical transition uses a declared connector, poses change over time, values
stay bounded, and the WebSocket sends three live virtual robots. Frontend tests
cover response normalization, live status, update-rate presentation, and the
stop command. The browser acceptance check samples robot poses across multiple
frames and verifies that stop freezes and restart restores movement.
