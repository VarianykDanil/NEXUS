# Boston Dynamics Spot robot link

NEXUS includes two camera-and-telemetry adapters behind the same API and
dashboard panel:

- `demo` is the default. It exposes a changing, local camera scene, identity,
  battery state, and three Spot-shaped camera sources. It needs no credentials
  or network and is the reliable hackathon path.
- `spot` authenticates to one real Boston Dynamics Spot and reads robot ID,
  battery state, image sources, and current JPEG frames through Spot SDK 5.1.4.
- `disabled` turns the robot link off.

All three modes are command-deny by design. The Spot adapter does not acquire a
body lease, register an E-stop endpoint, request motor power, or call the robot
command service. Connecting a camera therefore cannot silently grant motion
authority.

## Reliable demo mode

The checked-in configuration defaults to:

```dotenv
NEXUS_ROBOT_ADAPTER=demo
```

Start NEXUS from the repository root:

```sh
cp .env.example .env
docker compose up --build --detach --wait
open http://localhost:3006
```

Open **Digital twin**, find **Live robot camera**, and select **Connect robot
link**. The feed refreshes about once per second and the camera selector changes
between front-left, front-right, and rear views. The panel clearly labels the
adapter as `Demo Spot` and its authority as `Read-only`.

Requesting **Physical** still creates a critical human approval. When approved,
the configured demo adapter connects automatically and the audit event records
`hardware_command_sent: false`. This is useful for demonstrating the complete
approval and physical-edge handshake without claiming a simulated robot moved.

## Connect one real Spot

Use a dedicated, least-privilege Spot account. Connect the Mac running NEXUS to
the same routed IP network as the robot, then put these values only in the local
`.env` file:

```dotenv
NEXUS_ROBOT_ADAPTER=spot
NEXUS_SPOT_HOSTNAME=192.168.80.3
NEXUS_SPOT_USERNAME=nexus-demo
NEXUS_SPOT_PASSWORD=replace-locally
NEXUS_SPOT_TIMEOUT_SECONDS=8
```

Do not commit `.env`. Rebuild and restart the API:

```sh
docker compose up --build --detach --wait
```

Open <http://localhost:3006>, select **Digital twin**, and press **Connect robot
link**. A successful connection shows the robot nickname, serial number,
battery, and every non-depth image source returned by Spot. Choose a source to
view live frames. Credentials remain server-side and never enter the dashboard
bundle or its API responses.

The current connector targets one Spot per NEXUS API instance. A fleet rollout
should move credentials and SDK clients into per-robot edge agents with distinct
identities rather than adding multiple shared passwords to the control plane.

## macOS and Docker networking

The API container must be able to route to the Spot hostname on TCP 443. This
usually works on a normal routed LAN. A direct robot Wi-Fi or unusual VPN may be
reachable from macOS but not from Docker Desktop's Linux VM.

If that happens, run the API and dashboard directly on macOS so the SDK uses the
host network. Install dependencies once:

```sh
make native-install
```

Stop the containerized API and web services, then use two terminals from the
repository root:

```sh
docker compose stop api web
.venv/bin/uvicorn nexus_api.main:app --app-dir backend/src --host 127.0.0.1 --port 8000
```

```sh
./scripts/pnpm.sh --dir apps/dashboard exec vite --host 127.0.0.1 --port 3006
```

The root `.env` file is still loaded, and the demo remains fixed at
<http://localhost:3006>.

## Robot-link API

For a project ID `{id}`:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/projects/{id}/robot-link` | Adapter configuration and last known status |
| `POST /api/v1/projects/{id}/robot-link/connect` | Authenticate and connect read-only services |
| `GET /api/v1/projects/{id}/robot-link/cameras/{source}/frame` | Current SVG demo or JPEG Spot frame |

Every connect acknowledgement contains `hardware_command_sent: false`. Camera
responses use `Cache-Control: no-store` so browsers do not display stale robot
images.

## What is intentionally not implemented

Real Spot motion is not enabled by this integration. A safe command adapter
needs, at minimum, an independently supervised software/hardware E-stop path,
a body lease with keepalive and comms-loss handling, time synchronization,
motor-power checks, bounded command allowlists, expiring operator approval,
edge-side limits, and command receipts. Those controls must be tested with a
trained on-site operator before NEXUS may expose even stand, sit, or navigation
commands.
