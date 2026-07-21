# NEXUS demo video script

Target duration: **2 minutes 50 seconds**. The voiceover is required. Keep the
screen recording below three minutes even after adding a title or end card.

## Before recording

- Start the stack with `docker compose up --build --detach --wait` and open
  <http://localhost:3006>.
- On this Mac, select **NEXUS Hackathon Live Demo**. On a brand-new database,
  the automatically seeded **Sentinel Mapper - Building Hazard Reconnaissance**
  project provides the same demo features.
- Connect the Demo Spot feed and let the UI settle before recording.
- Set browser zoom so the digital twin, job composer, and pipeline are legible.
- Turn on Do Not Disturb; hide bookmarks, email, account tabs, tokens, `.env`
  files, and robot credentials.
- Pre-copy this instruction so typing can be cut from the final edit:
  `Inspect the Electrical Plant for heat and record evidence`.
- Record the screen and microphone together. Do not use background music that
  competes with the narration.

## Timed recording and exact narration

### 0:00-0:18 — the product

**Screen:** Start on Mission Control, then open the Digital twin.

**Say:**

> NEXUS is a safety-first engineering control plane. It turns a plain-language
> field objective into measurable requirements, a memory-backed robot job,
> live digital-twin evidence, and a human-gated physical decision.

### 0:18-0:40 — Codex and GPT-5.6

**Screen:** Briefly show the project navigation and Mission Assurance summary.

**Say:**

> I built and finalized NEXUS with Codex and GPT-5.6. I used Codex to migrate
> the Windows project to macOS, implement and debug the FastAPI, PostgreSQL,
> React, Docker, robot simulation, job-memory and read-only Spot integration,
> and to create tests and browser acceptance checks. GPT-5.6 supported the
> repository reasoning, implementation, debugging, test generation and
> documentation. I reviewed the behavior and kept every physical action behind
> a human safety boundary.

### 0:40-1:12 — prove the fleet is live

**Screen:** Show all three virtual robots moving in the 2D plan. Point to the
live update rate, stop movement for two seconds, then restart it. Switch briefly
to the 3D building.

**Say:**

> This is not a prerecorded map animation. Three server-controlled virtual
> robots stream sequenced poses at four updates per second along
> collision-checked routes. Stop freezes their authoritative poses, and start
> resumes smooth movement. The 2D and 3D views share the same metric building,
> doors, hazards, stairs and route geometry.

### 1:12-1:52 — natural language, map choice, and memory

**Screen:** In **Tell the fleet what job to do**, paste the prepared Electrical
Plant instruction and build the pipeline. Point to recalled memory, robot
assignment, route status and the six stages. If time permits, briefly turn on
**Choose on map** and select a room before returning to the prepared job.

**Say:**

> An operator can describe a job in text or choose its destination directly on
> the map. NEXUS resolves the location, recalls room and procedure memory,
> selects the best robot, verifies a wall-safe route, and explains the
> assignment. This six-stage pipeline makes perception, navigation, inspection,
> evidence and memory updates visible before execution.

### 1:52-2:15 — run and learn

**Screen:** Press **Run in digital twin** and show the stages completing. Point
to the evidence and updated experience-memory count.

**Say:**

> Running the job advances every stage in the digital twin, records evidence,
> and stores completed experience for future assignments. The plan and its
> result remain inspectable instead of becoming an unexplained robot command.

### 2:15-2:36 — camera and real Spot boundary

**Screen:** Show the changing Live robot camera and its **Demo Spot** label.
Briefly show the physical-request control or approval state.

**Say:**

> The changing Demo Spot feed makes the presentation reliable without hardware.
> With local Boston Dynamics credentials, the same server-side adapter can read
> a real Spot's identity, battery, camera services and current images. It is
> deliberately read-only: it never acquires a lease, powers motors, or sends a
> movement command. Physical requests still require explicit human approval.

### 2:36-2:50 — close on evidence

**Screen:** Finish on Mission Assurance or the verified audit log.

**Say:**

> NEXUS combines useful autonomy with visible evidence and authority limits:
> plan in language, prove it in simulation, learn from the result, and keep the
> human in control of the physical world.

## Edit and upload check

- Cut all loading, typing, tab switching, cursor searching, and repeated clicks.
- Never claim the virtual robots are physical or that NEXUS currently commands
  a real Spot.
- Watch the final export once with headphones and once at normal speaker volume.
- Confirm the first frame, last frame, text legibility, and voiceover are clean.
- Confirm the final duration is under three minutes.
- Upload to YouTube as **Public** or **Unlisted**, wait for HD processing, and
  watch the uploaded version before placing its URL in the submission.
- Make sure the narration still explicitly says **Codex** and **GPT-5.6**.
