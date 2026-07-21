# ROS 2 and simulation integration

## Integration principle

Treat ROS 2 as a local robot bus, not as the public control-plane API. A small
edge gateway runs beside the robot or simulator, joins the ROS domain, and opens
an outbound authenticated connection to NEXUS. The core dashboard, API, and
database remain useful when no robotics software is installed.

The dependency-free library in `robotics/` holds deterministic algorithms. Thin
`rclcpp` adapters should translate strongly typed messages into that library and
publish results; business policy and approval state stay in the API.

## Current virtual fleet versus a real ROS fleet

The dashboard currently displays three deterministic virtual robots moving
through a metric three-floor building. Their `robots.state.updated` WebSocket
events and `GET /api/v1/projects/{id}/spatial` snapshot are a display and
simulation contract. They are not ROS messages and do not prove that `/tf`,
`/odom`, sensors, Nav2, Gazebo, Raspberry Pi, or motor controllers are connected.

The spatial response makes the boundary machine-readable:

- `simulationOnly` is always `true`;
- `physicalExecutionEnabled` is always `false`;
- a physical-mode request creates a critical approval request;
- approval may connect the configured Demo Spot or real Spot observation link,
  but the adapter remains read-only and sends no command;
- emergency stop cancels the simulation and latches control-plane state, but it
  is not an acknowledgement from a robot edge or an independent physical
  emergency stop.

The current Spot observation link can read identity, battery state, camera
sources, and images. A future ROS observation edge may translate transforms and diagnostics into
the same metric `building_enu` scene. It must preserve source timestamps, frame
identifiers, covariance/freshness information, and per-robot identity. It must
not turn the display WebSocket into a command path. See
[Digital twin and realtime](digital-twin.md) for the current scene and sequence
contract. The control plane also supports persistent text/map robot jobs and a
fully visible simulation pipeline; see [Memory-backed robot jobs](robot-jobs.md).

## Edge gateway responsibilities

The gateway must:

- authenticate the robot with a distinct, rotatable identity using mTLS or an
  equivalent hardware-backed credential;
- accept only versioned command intents from a fixed schema and allowlist;
- verify the intent signature, robot identifier, capability, approval scope,
  expiry, nonce/idempotency key, and monotonic sequence;
- check local mode, localization quality, battery, speed/area limits, watchdog,
  and emergency-stop state;
- map allowed intents to a minimal set of ROS actions or lifecycle transitions;
- stream rate-limited telemetry and signed command receipts back to NEXUS;
- fail safe on disconnect, stale commands, clock anomalies, or policy mismatch.

It must not evaluate generated Python/C++, accept shell commands, expose the ROS
graph publicly, or treat a control-plane request as proof that an action is safe.

## Suggested ROS interface

Start with observation-only topics and simulation:

| Direction | Interface | Purpose |
| --- | --- | --- |
| Robot to gateway | `/tf`, `/tf_static`, `/odom` | Pose and transforms |
| Robot to gateway | `/scan` or depth/point cloud topic | Mapping input |
| Robot to gateway | `/diagnostics`, battery state | Health and risk checks |
| Gateway to robot | Nav2 action client | Bounded navigation goal |
| Gateway to robot | Lifecycle and cancel services | Controlled activation and stop |

Do not expose arbitrary topic names in the remote API. Define a domain command
such as `navigate_to_pose` with bounded coordinates and duration, then map it to
the local Nav2 action only after all checks pass. Direct remote `/cmd_vel` should
remain prohibited; teleoperation requires a dedicated low-latency safety design.

Choose QoS deliberately: sensor data is commonly best-effort with bounded depth,
while commands, approvals, and receipts require reliable delivery and explicit
deduplication. DDS reliability alone does not make an action exactly once.

## Simulation progression

1. Unit-test algorithms without ROS.
2. Replay recorded, non-sensitive sensor fixtures.
3. Run deterministic headless Gazebo worlds with fixed seeds where possible.
4. Add fault injection: stale transforms, sensor dropout, blocked paths, low
   battery, process crash, high latency, and lost connectivity.
5. Require the same command schema and gateway checks in simulation and hardware;
   change only the adapter target and capability grant.
6. Use hardware-in-the-loop with actuators disabled or the robot lifted and a
   physical operator present.
7. Permit bounded floor testing only after named approval and a documented stop
   test.

Simulation passing is evidence, not proof of physical safety. Record the world,
robot model, plugin versions, seed, resource limits, source revision, container
digests, and result artifacts for reproducibility.

## Gazebo deployment

Gazebo is intentionally absent from `compose.yaml`. GUI/GPU passthrough and ROS
middleware differ across Linux, Windows/WSL2, and macOS, and bundling them would
make the core stack slow and brittle.

For CI, use a dedicated Linux runner image pinned by digest and launch only the
headless simulator needed by the scenario. For local development, run the
supported ROS 2 distribution and Gazebo pairing on the host or in a separate
profile, then connect a simulated edge gateway to the NEXUS API. Never mount the
Docker daemon into the API to start simulations.

## Network and safety controls

- Give each lab or robot an isolated `ROS_DOMAIN_ID`; do not rely on the domain
  ID as a security control.
- Use SROS2/DDS security on networks where other participants may be present.
- Keep the robot VLAN isolated and deny unsolicited inbound Internet traffic.
- Make the gateway connection outbound-only through an explicit egress rule.
- Rate-limit telemetry and send large bags/maps through resumable object storage.
- Keep emergency stop, motor enable, collision limits, and watchdogs local and
  independent of NEXUS, Wi-Fi, ROS, and the AI model.
- Default every new robot identity to observation-only and simulation-only.
