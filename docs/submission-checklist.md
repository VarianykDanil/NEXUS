# NEXUS final submission checklist

Use this page for the organizer's final pass. Do not put API keys, robot
passwords, GitHub tokens, or other secrets in this file or in the submission
form.

## Submission record

| Field | Value |
| --- | --- |
| Repository | `https://github.com/VarianykDanil/NEXUS` |
| Demo URL | `http://localhost:3006` after local setup |
| YouTube demo URL | `TBD — paste the public or unlisted URL` |
| Codex `/feedback` session ID | `TBD — paste the result from the official Codex session` |
| Submitted commit SHA | `TBD — fill after the final commit is pushed` |
| Submission state | `DRAFT — change only after Devpost shows Submitted in green` |

## Organizer requirements

| # | Requirement | Repository evidence / current status | Final action |
| --- | --- | --- | --- |
| 1 | Project runs and works as described when tested fresh | **Ready on 2026-07-21.** The exact checkout was rebuilt with Docker, all three services became healthy, the dashboard returned HTTP 200 on port 3006, and the automated and live checks below passed. | Repeat the short health and browser checks immediately before recording. |
| 2 | Demo video is on YouTube and linked in the submission | The timed [recording script](demo-video-script.md) keeps the demo below three minutes. | Record with voiceover, watch the exported file, upload as **Public** or **Unlisted**, and paste the URL above and into Devpost. |
| 3 | Required voiceover explains the build, Codex, and GPT-5.6 | The recording script contains explicit Codex and GPT-5.6 narration. | Do not remove those lines during editing. Confirm speech is audible on headphones and speakers. |
| 4 | Codex Session ID from `/feedback` is in the submission | The README documents how Codex and GPT-5.6 were used. | In the official Codex interface for the session where most work happened, run `/feedback`, copy the Session ID above, and paste it into Devpost. |
| 5 | Private repository is shared with both organizer accounts | **Not applicable while public.** GitHub reported `VarianykDanil/NEXUS` as `PUBLIC` on 2026-07-21. | Keep it public through judging. If its visibility is changed to private, invite `testing@devpost.com` and `build-week-event@openai.com` before submitting. |
| 6 | README contains setup, sample data, and Codex/GPT-5.6 use | **Ready.** The README has supported platforms, Docker setup, automatic sample data, test commands, and a dedicated Codex/GPT-5.6 section. | Recheck the README at the exact pushed commit. |
| 7 | A plugin/developer tool has install instructions, supported platforms, and a no-rebuild test path | NEXUS is a standalone developer web application, not a plugin. The README lists macOS, Windows, and Linux; Docker installation; seeded demo data; and `docker compose up --detach --wait` for reuse without rebuilding. | In Devpost, describe NEXUS as a standalone web developer tool and link directly to the reviewer quick start. |
| 8 | Every team member is added and has accepted | This lives only in the Devpost account and cannot be proven from the repository. | Open the submission's team section and confirm every person is listed as accepted. Remove stale pending invitations if appropriate. |
| 9 | The project is submitted rather than left as a draft | This lives only in Devpost. | Save, press **Submit**, return to **My projects**, and verify the project is labelled **Submitted** in green. |

## Fresh local verification

From a new terminal in the repository root:

```sh
if [ ! -f .env ]; then cp .env.example .env; fi
docker compose config --quiet
docker compose up --build --detach --wait
docker compose ps
curl --fail http://localhost:8000/api/v1/health
curl --fail http://localhost:8000/api/v1/ready
```

Open <http://localhost:3006> in a private browser window and verify:

- the seeded **Sentinel Mapper - Building Hazard Reconnaissance** project opens;
- three virtual robots move smoothly and the live rate is about four updates per
  second;
- **Stop virtual movement** freezes every pose and **Start virtual movement**
  resumes it;
- **Connect robot link** displays changing frames labelled **Demo Spot**;
- a map-selected destination creates a memory-backed route and pipeline;
- `Inspect the Electrical Plant for heat and record evidence` builds a job and
  **Run in digital twin** completes all six stages;
- the app makes no physical-motion claim and a physical request remains gated by
  human approval;
- no browser console errors appear.

When finished, keep the stack available for recording or stop it with
`docker compose down`.

### Latest verification record — 2026-07-21

- Backend: **43 passed**; Ruff passed; strict Mypy passed across 15 source files.
- Dashboard: **78 passed** across 11 test files; TypeScript passed; the Vite
  production build completed successfully.
- C++ navigation: **1/1 CTest passed** with a read-only source mount in an
  isolated Ubuntu 24.04 build container.
- Compose: configuration valid; PostgreSQL, API, and web services rebuilt and
  reported healthy.
- HTTP: API health returned `ok`, readiness returned `ready`, and the dashboard
  returned HTTP 200 at `http://localhost:3006`.
- Live WebSocket: four consecutive frames were captured; all three robots had
  nonzero speeds and their poses changed between frames.
- Live controls: the UI changed from **VIRTUAL FLEET LIVE** to **VIRTUAL FLEET
  STOPPED**, showed zero moving robots, and returned to three moving robots at
  four updates per second.
- Robot job: the Electrical Plant instruction recalled location and hazard
  procedure memory, selected **Hazard Surveyor 02**, completed all six stages at
  100%, and stored experience memory with `hardware_command_sent: false`.
- Camera: the Demo Spot adapter connected read-only with three camera sources;
  two frames captured one second apart had different hashes.
- Browser: live API data loaded for **NEXUS Hackathon Live Demo**, the audit chain
  was verified, and no warning or error console entries were recorded.

## Account-bound final pass

These actions require the project owner's signed-in accounts and must be done by
the owner:

1. Run `/feedback` in this Codex session and save the returned Session ID.
2. Push the final tested commit to the repository used by Devpost.
3. Confirm the repository is still public. If it was made private, grant the two
   organizer accounts access.
4. Record and upload the video, then watch the actual YouTube upload from start
   to finish.
5. Paste the YouTube URL, repository URL, and Codex Session ID into Devpost.
6. Confirm all team invitations are accepted.
7. Save, submit, and verify **Submitted** in green under **My projects**.
