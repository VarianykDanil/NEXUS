# Security, safety, and audit model

## Trust boundaries

NEXUS handles unusually risky inputs: natural-language objectives, generated
code, third-party dependencies, sensor data, and commands that may eventually
move hardware. Treat the model, generated output, project files, simulation
assets, browser client, and robot telemetry as untrusted. PostgreSQL is durable
state, not an independent integrity witness.

The primary boundaries are browser to API, API to executor, executor to network
and host, API to robot gateway, gateway to ROS 2, and services to the signing-key
store. Authenticate and authorize at each boundary; network location is not an
identity.

## Capability and approval model

Classify work by capability, with policy evaluated on the server:

1. read project state;
2. propose requirements, code, or plans;
3. run a network-disabled software test;
4. access approved external dependencies or datasets;
5. run simulation;
6. connect to a robot in observation-only mode;
7. issue a bounded, reversible physical intent;
8. issue a high-energy, destructive, privacy-sensitive, or otherwise dangerous
   action.

Higher capabilities never follow automatically from lower ones. An approval is
a signed grant to a named actor for one project, action digest, robot/simulator,
limits, and short time window. Editing any material input invalidates it. Enforce
separation of duties for dangerous actions, support revocation, and record both
denials and expirations.

The dashboard is only a view. API policy and the robot edge independently reject
missing, stale, replayed, out-of-scope, or already-consumed grants.

### Current simulation-only boundary

There is no robot edge in the current Compose stack. Spatial snapshots declare
`simulationOnly: true` and `physicalExecutionEnabled: false`; the displayed
three-robot fleet is virtual. A physical request produces an approval record,
and an approval produces at most a hardware-ready, adapter-denied state. It does
not publish ROS, GPIO, motor, or network commands.

The dashboard reports an emergency stop as confirmed only after the API has
latched project state and cancelled simulation work. That confirmation is not a
signed edge receipt and must never be presented as proof that physical actuators
stopped. Any future edge needs its own local latch, watchdog, independent stop,
and explicit acknowledgement protocol.

## Running generated code

The API container and ordinary Docker Compose isolation are not a safe sandbox
for adversarial generated code. Build a separate executor service before this
feature is enabled. At minimum each job needs:

- an ephemeral, rootless container with a read-only root filesystem;
- no host Docker socket, privileged mode, device access, host PID/IPC namespace,
  or writable source checkout;
- all Linux capabilities dropped, `no-new-privileges`, a restrictive seccomp
  profile, and AppArmor/SELinux where available;
- CPU, memory, process, disk, output, and wall-clock limits;
- no network by default; approved egress goes through a recording allowlist
  proxy and never reaches metadata, control-plane, database, or robot networks;
- no ambient secrets; short-lived job credentials grant access only to specific
  inputs and artifact outputs;
- immutable base-image and dependency digests plus malware/license scanning;
- a stronger boundary such as gVisor, Kata Containers, or a microVM when running
  hostile workloads or serving multiple tenants.

Parse logs and artifacts as hostile data. Limit their size, escape them in the
browser, and never execute a generated report as active HTML.

## Tamper-evident audit trail

Each committed state transition appends a canonical event with actor and
credential identity, action, target, reason, policy result, approval reference,
source/model/tool versions, causal identifiers, timestamp, and relevant content
digests. Compute a chain such as:

```text
event_hash = SHA-256(previous_hash || canonical_event_bytes)
signature  = HMAC-SHA-256(versioned_signing_key, event_hash)
```

Canonicalization and byte encoding are part of the versioned format. Sequence
allocation, state mutation, audit insert, and outbox insert occur in one database
transaction. A verifier must detect gaps, forks, duplicate sequences, invalid
signatures, unknown key versions, and changed payloads.

An HMAC chain detects accidental or unauthorized database edits only while the
key remains separate. It is not public proof: an operator who controls both the
database and HMAC key can rewrite history. Production should keep signing keys in
a KMS/HSM and use asymmetric signatures where third-party verification matters.
Periodically publish a signed checkpoint to independent append-only storage with
object lock or an external transparency service. Retain old public keys and key
metadata after rotation.

Audit storage is append-only through a dedicated database role. Application
roles receive `INSERT` and read access but no `UPDATE`, `DELETE`, or table-owner
privileges. Backups, restores, exports, verification failures, key operations,
and administrator reads are themselves audited.

## Secrets and identity

- `.env.example` contains names and local placeholders only. Never commit real
  credentials.
- Production secrets come from a secret manager and are injected as files or
  short-lived credentials, not image layers or frontend variables.
- Use separate database roles for migrations, runtime reads/writes, audit append,
  and read-only analytics.
- Use phishing-resistant MFA for human approvers and workload identities for
  services and robots.
- Redact authorization headers, cookies, tokens, model prompts containing
  secrets, and sensitive sensor frames from logs.
- Rotate credentials and signing keys with version identifiers and tested
  revocation procedures.

### External model boundary

The optional OpenAI Engineering Review sends a bounded project-evidence
projection to an external provider. Operators must not put credentials,
regulated sensor content, or unrelated personal data in an objective or the
optional evidence field. The API key remains server-side; production should
inject it from a secret manager rather than ordinary Compose environment
configuration.

The request uses a typed Structured Output, disables tools, sets `store=False`,
and treats every evidence value as untrusted data. A canonical input digest,
model identifier, and prompt version enter the tamper-evident audit record, but
model prose and operator evidence do not enter audit or WebSocket events. This
boundary reduces accidental disclosure and false authority; it does not make
model output correct. Human review, deterministic tests, and simulation remain
required.

## Core Compose posture

The checked-in Compose stack reduces common local-development exposure by
binding published ports to loopback, separating the internal database network,
dropping container capabilities, setting `no-new-privileges`, and making API/web
filesystems read-only with bounded temporary filesystems.

It remains a development stack. The local database password and audit key
defaults are deliberately obvious placeholders; TLS, authentication, backup,
WAF/rate limits, centralized identity, external secrets, image signatures,
production orchestration, and independent audit checkpoints must be supplied by
a deployment platform.

## Release gate

Before any non-local deployment, require threat-model review, dependency and
container scanning, SBOMs, pinned image digests, authenticated API and WebSocket
connections, TLS, backup/restore rehearsal, audit-chain verification, least-
privilege database roles, rate and size limits, retention policy, incident
runbook, and removal of all placeholder secrets.

Before any physical test, additionally require an identified operator, approved
area and time window, robot-specific limits, preflight checklist, independent
emergency stop, communications-loss test, rollback/stop behavior, and an audit
receipt for every command outcome.
