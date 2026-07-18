# Infrastructure roadmap

This sequence keeps early feedback fast while deferring dangerous capabilities
until their enforcement and evidence paths exist. Each phase has a concrete exit
gate; a demo alone is not completion.

## Phase 0: core developer stack

Status: implemented local baseline.

- API, dashboard, and PostgreSQL start through one loopback-bound Compose file.
- Health checks order startup and nginx proxies same-origin REST/WebSocket paths.
- Python, TypeScript, and dependency-free C++ checks run in CI.
- A deterministic three-floor metric scene, three virtual robots, and shared
  2D/3D viewer exercise the spatial UI without requiring ROS, Gazebo, or
  hardware.
- Project WebSocket envelopes carry stream identity and monotonic sequence;
  clients detect gaps, reconcile through REST, and reconnect with bounded
  backoff. Delivery is still process-local and non-durable.
- Environment names, security boundaries, and material architecture decisions
  are documented.

Exit gate: a fresh checkout can build, become healthy, create/read a project,
show dashboard state, and shut down without losing database state. CI passes on
the default branch.

## Phase 1: durable control plane

- Replace development-time schema creation with reviewed Alembic migrations and
  separate migration/runtime database roles.
- Add authenticated human and service identities, project roles, and server-side
  capability policy.
- Add transactional outbox delivery for WebSocket events and background work.
- Make approvals scoped, digest-bound, expiring, revocable, and idempotent.
- Serialize per-project audit sequence allocation, persist signing-key versions,
  and ship an offline verifier plus external checkpoint job.
- Add object storage for content-addressed artifacts and a retention worker.

Exit gate: concurrent state/audit tests, migration upgrade/rollback rehearsal,
authorization matrix tests, restore test, and independent chain verification all
pass.

## Phase 2: isolated experiment executor

- Define a versioned job manifest: source/input digests, image digest, command,
  tests, quotas, deadline, network policy, output contract, and correlation IDs.
- Run jobs outside the API in rootless disposable workers without the host Docker
  socket or ambient credentials.
- Default-deny egress; proxy and record narrowly approved dependency access.
- Capture logs, exit reason, resource usage, test reports, SBOM, and artifact
  digests. Enforce size and retention limits.
- Add cancellation, stuck-job reconciliation, idempotent retries, and worker
  compromise/timeout drills.

Exit gate: adversarial fixtures cannot reach the host, control plane, metadata
service, database, secret store, or robot network; quota and cancellation tests
are repeatable.

## Phase 3: reproducible simulation

- Build pinned headless Gazebo runner images on dedicated Linux workers.
- Version worlds, robot models, plugins, seeds, scenarios, and expected metrics.
- Add replay and fault injection for sensors, transforms, network, power, and
  process failures.
- Keep simulation as a separate capability and record every run manifest and
  artifact.

Exit gate: the same source revision and scenario reproduce accepted metrics
within declared tolerances, and all stop/fault cases pass in CI or a controlled
simulation runner.

## Phase 4: observation-only robotics edge

- Provision per-robot workload identities and an outbound mTLS gateway session.
- Implement a versioned telemetry envelope, backpressure, reconnect/resume, and
  content-addressed large uploads.
- Join ROS 2 only on the robot LAN; enable SROS2 where participants are not fully
  trusted.
- Expose an allowlisted, observation-only ROS adapter first.

Exit gate: credential rotation/revocation, network loss, stale telemetry, schema
mismatch, and robot isolation tests pass without enabling any actuator command.

## Phase 5: bounded physical intents

- Introduce one reversible intent at a time, normally navigation goal plus cancel.
- Verify signed approval and policy at the API and again at the edge.
- Enforce local workspace, velocity, duration, localization, battery, watchdog,
  and collision limits with a hardware-independent emergency stop.
- Sign receipts for accepted, rejected, cancelled, timed-out, and completed
  intents; reconcile uncertain outcomes instead of retrying blindly.

Exit gate: safety review, supervised hardware-in-the-loop evidence, communication
loss/dead-man tests, independent emergency-stop test, rollback plan, and named
operator approval exist for the exact robot and test area.

## Phase 6: operational hardening

- Production orchestration, TLS, external secrets/KMS, network policies, signed
  images, SBOM/provenance attestations, vulnerability policy, backups, and
  retention-locked audit checkpoints.
- Metrics and alerts for queue age, job failure, WebSocket lag, robot heartbeat,
  denied commands, audit verification, storage, backup age, and key expiry.
- Incident, restore, key compromise, robot loss, executor compromise, and safe
  shutdown runbooks with regular exercises.
- Capacity tests and cost/retention budgets for telemetry and simulation assets.

Exit gate: a production readiness review and rehearsed recovery objectives, not
feature completeness, determine deployment approval.
