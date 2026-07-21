# NEXUS Devpost submission pack

This document contains copy-ready content for the Devpost **Project details**
page and the exact recording plan for the required demo video.

## About the project — paste this Markdown into Devpost

## Inspiration

Robots can enter hazardous buildings before responders, but today's mission
software is fragmented: objectives live in chat, maps live in another tool,
robot telemetry lives in vendor software, and safety decisions are difficult to
audit. The dangerous shortcut is to let a powerful model directly command
hardware without showing what it remembered, why it chose a route, or where
human authority begins.

We built **NEXUS** to explore a better pattern: useful autonomy with visible
evidence and explicit authority boundaries.

## What it does

NEXUS is a safety-first robot mission control plane that turns a
plain-language field objective into a reviewable mission:

1. An operator describes a job in text or selects a destination on the map.
2. NEXUS recalls persistent location, procedure, and previous-experience memory.
3. It deterministically assigns the best robot and explains why.
4. It calculates a route through a metric three-floor digital twin, accounting
   for walls, door openings, robot clearance, stairs, and lifts.
5. A six-stage pipeline makes intent, memory, safety validation, navigation,
   inspection, evidence, and learning visible.
6. The job runs in simulation and stores experience memory for future work.
7. Any physical request remains human-gated and records
   `hardware_command_sent: false`.

The live demo includes three continuously moving virtual robots streamed over a
sequenced WebSocket at four updates per second. Judges can stop and restart the
fleet to prove the scene is live. The same spatial model is rendered as an
interactive north-up 2D plan and a navigable 3D building.

NEXUS also includes a changing **Demo Spot** camera feed for reliable judging and
an optional server-side Boston Dynamics Spot adapter for real identity, battery,
camera discovery, and current images. The adapter is deliberately read-only: it
does not acquire a lease, power motors, or send movement commands.

An optional OpenAI Responses API feature uses **GPT-5.6** with Structured Outputs
to produce a bounded engineering review from current project evidence. The
reviewer receives no tools and cannot approve or execute a physical action. The
complete deterministic demo works without an API key.

## How we built it

The control plane is a **FastAPI** service backed by **PostgreSQL**, SQLAlchemy,
and Pydantic. It owns objectives, requirements, robot memory, jobs, approvals,
telemetry, WebSocket events, and a SHA-256 hash-linked audit chain.

The operator console is built with **React**, **TypeScript**, **Vite**, and
**Three.js**. It renders the shared metric building model, live robot paths,
mission assurance, job explanations, camera state, approvals, and audit evidence.

The navigation foundation includes a dependency-free **C++** occupancy-grid
core. Docker Compose starts PostgreSQL, the API, and the production dashboard on
the fixed demo URL `http://localhost:3006`. A seeded project, three robots,
building geometry, hazards, memory, and Demo Spot feed make the reviewer path
repeatable without external services.

## How we used Codex and GPT-5.6

**Codex was the primary development environment for the hackathon build.** We
used it to inspect and migrate the original Windows-oriented repository to
macOS; implement the FastAPI, PostgreSQL, React, Docker, virtual-fleet,
memory-backed job, and read-only Spot changes; diagnose integration issues;
write regression tests and operating documentation; rebuild the full stack; and
exercise the final UI in a real browser.

**GPT-5.6 was used through Codex** for repository reasoning, implementation,
debugging, test generation, documentation, and acceptance-test planning. The
human developer supplied the product goals, chose the safety boundary, reviewed
the visible behavior, and remains responsible for submission and all
physical-robot decisions.

AI-generated changes were treated as proposed engineering work, not as safety
evidence. We verified them with deterministic tests, strict typing, production
builds, Docker health checks, route-geometry audits, WebSocket sampling, camera
frame checks, and browser acceptance tests.

## Challenges we ran into

- Migrating a Windows-first project to a repeatable macOS and Docker workflow.
- Making three simulated robots move smoothly while keeping the server as the
  authoritative source of truth.
- Preventing visual routes from cutting through walls while still allowing
  valid door and vertical-connector transitions.
- Turning natural-language intent into explainable, memory-backed jobs without
  hiding assignment or safety decisions inside a black box.
- Supporting a convincing hardware story without falsely claiming that virtual
  telemetry came from a physical robot.
- Preserving a hard safety boundary: camera and telemetry access must never imply
  motor or lease authority.

## Accomplishments that we're proud of

- A complete text-or-map-to-job pipeline with visible memory recall, assignment,
  verified route, six execution stages, evidence, and learning.
- Three live virtual robots with smooth four-Hz WebSocket movement and explicit
  stop/restart controls.
- A reliable changing Demo Spot feed plus an optional real Spot read-only camera
  adapter.
- A derived Mission Assurance view instead of a fabricated readiness score.
- Human approval gates, emergency-stop semantics, and a verified hash-linked
  decision history.
- A fresh full-stack verification with **43 backend tests, 78 frontend tests,
  and the C++ navigation test passing**, plus clean lint, strict typing,
  production builds, healthy Docker services, and zero browser console errors.

## What we learned

The most useful unit of autonomy is not a generated command; it is an
inspectable evidence chain. Memory, planning, route geometry, simulation,
approval, and audit data must agree before a physical decision is even
considered. Models are most valuable when they help engineers reason over that
evidence—not when they bypass the control plane.

## What's next for NEXUS

The next milestone is a Gazebo/ROS 2 simulation profile with signed scenario
artifacts and repeatable failure fixtures. A physical pilot would follow only
after authentication, durable jobs and events, expiring capability grants,
robot-edge allowlists, watchdogs, an independent emergency stop, signed command
receipts, and formal safety-case review are implemented and tested.

NEXUS is a simulation-first engineering foundation, not a certified robot
controller—but it demonstrates how AI-assisted mission planning can remain
useful, explainable, and human-controlled.

## Built with — add these as individual tags

1. OpenAI API
2. GPT-5.6
3. Codex
4. Python
5. FastAPI
6. Pydantic
7. SQLAlchemy
8. PostgreSQL
9. React
10. TypeScript
11. Three.js
12. WebSockets
13. Docker
14. Docker Compose
15. C++
16. CMake
17. Boston Dynamics Spot SDK
18. Nginx
19. Vite
20. Vitest
21. Pytest
22. Ruff
23. Mypy
24. GitHub Actions
25. Structured Outputs

## Try it out links

Add this repository link:

`https://github.com/VarianykDanil/NEXUS`

Do not add `localhost:3006` as a public link. It is the fixed local reviewer URL,
not an internet deployment.

## Image gallery upload order

Upload these five 3:2 images in this order:

1. `docs/assets/gallery/01-nexus-mission-control-devpost.jpg` — live Mission
   Control and metric digital twin.
2. `docs/assets/gallery/02-nexus-live-digital-twin-devpost.jpg` — three moving
   robots, four updates/sec, and simulation-only controls.
3. `docs/assets/gallery/03-nexus-memory-job-devpost.jpg` — completed
   memory-backed Electrical Plant job and explainable assignment.
4. `docs/assets/gallery/04-nexus-robot-camera-devpost.jpg` — completed evidence
   stages and connected read-only Demo Spot camera.
5. `docs/assets/gallery/05-nexus-audit-chain-devpost.jpg` — verified SHA-256
   decision chain.

The separate project thumbnail is:
`docs/assets/nexus-devpost-thumbnail.png`.

## Video demo link

Upload the finished recording to YouTube as **Public** or **Unlisted**, wait for
HD processing, watch the uploaded version, and paste that YouTube URL into the
required **Video demo link** field.

## Exact 2:50 demo recording runbook

Before recording:

- run `docker compose up --build --detach --wait`;
- open `http://localhost:3006` and select **NEXUS Hackathon Live Demo**;
- wait for **LIVE SIMULATION DATA** and **LIVE WEBSOCKET**;
- connect the Demo Spot link if it is not already connected;
- turn on Do Not Disturb and hide email, bookmarks, credentials, and other tabs;
- do **not** press Emergency Stop during the recording because the safety latch
  intentionally remains active for that project;
- pre-copy `Inspect the Electrical Plant for heat and record evidence`.

### 0:00–0:18 — problem and product

**Show:** Mission Control, objective, live status, and three-robot indicator.

**Say:**

> NEXUS is a safety-first robot mission control plane. It turns a plain-language
> field objective into measurable requirements, a memory-backed robot job, live
> digital-twin evidence, and a human-gated physical decision.

### 0:18–0:40 — required Codex and GPT-5.6 explanation

**Show:** The navigation and Mission Assurance section while continuing to move
the cursor deliberately.

**Say:**

> I built and finalized NEXUS with Codex and GPT-5.6. I used Codex to migrate the
> original Windows project to macOS, implement and debug the FastAPI,
> PostgreSQL, React, Docker, robot simulation, job memory, and read-only Spot
> integration, and to create tests and browser acceptance checks. GPT-5.6
> supported repository reasoning, implementation, debugging, test generation,
> and documentation. I reviewed the behavior and kept every physical action
> behind a human safety boundary.

### 0:40–1:10 — prove the fleet is genuinely live

**Do:** Open **Digital twin**. Show the three robots. Click **Stop virtual
motion**, pause for two seconds, then click **Start virtual motion**. Briefly
switch to **3D building**, then back to the clearest view.

**Say:**

> This is not a prerecorded map animation. Three server-controlled virtual
> robots stream sequenced poses at four updates per second along
> collision-checked routes. Stop freezes their authoritative poses, and start
> resumes smooth movement. The 2D and 3D views share the same metric building,
> doors, hazards, stairs, and route geometry.

### 1:10–1:52 — text, map selection, memory, and explainability

**Do:** Scroll to **Tell the fleet what job to do**. Briefly point at **Choose on
map**. Paste the prepared Electrical Plant instruction and click **Build job
pipeline**. Point to Assigned, Destination, Procedure, Verified route, Why this
plan, and the two recalled memory keys.

**Say:**

> An operator can describe a job in text or choose its destination directly on
> the map. NEXUS resolves the location, recalls room and procedure memory,
> selects the best robot, verifies a wall-safe route, and explains the
> assignment. This six-stage pipeline makes intent, navigation, inspection,
> evidence, and memory updates visible before execution.

### 1:52–2:15 — execute and learn

**Do:** Click **Run in digital twin**. Show the six stages completing and the
experience-memory count increasing. If completion is instant, pause on the
completed evidence rather than repeating the action.

**Say:**

> Running the job advances every stage in the digital twin, records evidence,
> and stores completed experience for future assignments. The plan and result
> remain inspectable instead of becoming an unexplained robot command.

### 2:15–2:35 — Demo Spot and real hardware boundary

**Do:** Show **Live robot camera**, its changing frame, **CONNECTED**, Demo Spot,
and **Authority: Read-only**.

**Say:**

> The changing Demo Spot feed makes the presentation reliable without hardware.
> With local Boston Dynamics credentials, the same server-side adapter can read
> a real Spot's identity, battery, camera services, and current images. It is
> deliberately read-only: it never acquires a lease, powers motors, or sends a
> movement command. Physical requests still require explicit human approval.

### 2:35–2:50 — finish on proof

**Do:** Open **Audit log** and point to **All visible events verified**.

**Say:**

> NEXUS combines useful autonomy with visible evidence and authority limits:
> plan in language, prove it in simulation, learn from the result, and keep the
> human in control of the physical world.

Stop the recording immediately. Cut loading, typing, cursor searching, and any
silence. Keep the exported video under three minutes and make sure the final
voiceover still explicitly says **Codex** and **GPT-5.6**.
