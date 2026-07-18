# NEXUS Operations Console

Responsive React and TypeScript control surface for autonomous engineering missions. It provides live mission, map, telemetry, build pipeline, requirements, approvals, and cryptographic audit views without requiring a backend to render.

## Run locally

From the repository root:

```bash
pnpm install
pnpm dev
```

The dashboard runs on `http://localhost:5173`. Vite proxies `/api` and `/ws` to `http://127.0.0.1:8000` during development.

## Verify

```bash
pnpm --filter @nexus/dashboard lint
pnpm --filter @nexus/dashboard typecheck
pnpm --filter @nexus/dashboard test
pnpm --filter @nexus/dashboard build
```

The production output is `apps/dashboard/dist`.

## API integration

- REST base: `/api/v1`
- Dashboard snapshot: `GET /api/v1/projects/{id}/dashboard`
- Project stream: `WS /ws/projects/{id}`
- Optional build variables: `VITE_API_BASE_URL` and `VITE_WS_BASE_URL`

The client accepts snake_case backend envelopes and normalizes them into a typed dashboard model. It starts with a complete seeded mission, attempts to reconcile with the REST snapshot, and applies WebSocket events when the stream connects. If the API is unavailable, every view and operator interaction remains demonstrable and is clearly marked `DEMO DATA`.

Physical mode, approvals, and emergency-stop actions are optimistic in the UI and sent to the API. Production authorization and interlocks must always remain authoritative on the backend and robot safety controller.
