from __future__ import annotations

import asyncio
import html
import importlib
import math
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from nexus_api.config import Settings
from nexus_api.schemas import RobotCameraSourceRead, RobotLinkStatus


class RobotAdapterError(RuntimeError):
    """A safe, credential-free error that can be returned to an operator."""


@dataclass(frozen=True)
class RobotCameraFrame:
    content: bytes
    media_type: str


class RobotAdapter(Protocol):
    @property
    def kind(self) -> str: ...

    @property
    def configured(self) -> bool: ...

    async def status(self) -> RobotLinkStatus: ...

    async def connect(self) -> RobotLinkStatus: ...

    async def capture(self, source: str) -> RobotCameraFrame: ...


class DemoSpotAdapter:
    """An in-process Spot-shaped edge link for a reliable, credential-free demo."""

    _sources = (
        RobotCameraSourceRead(
            name="frontleft_fisheye_image", label="Front-left fisheye", width=960, height=540
        ),
        RobotCameraSourceRead(
            name="frontright_fisheye_image", label="Front-right fisheye", width=960, height=540
        ),
        RobotCameraSourceRead(
            name="back_fisheye_image", label="Rear fisheye", width=960, height=540
        ),
    )

    def __init__(self) -> None:
        self._connected = False
        self._last_seen_at: datetime | None = None

    @property
    def kind(self) -> str:
        return "demo"

    @property
    def configured(self) -> bool:
        return True

    async def status(self) -> RobotLinkStatus:
        return RobotLinkStatus(
            adapter="demo",
            configured=True,
            connected=self._connected,
            read_only=True,
            robot_name="NEXUS Demo Spot",
            serial_number="DEMO-SPOT-001",
            software_version="sim-1.0",
            battery_percent=87.0,
            camera_sources=list(self._sources),
            last_seen_at=self._last_seen_at,
            message=(
                "Demo Spot edge link is live. Camera frames are generated locally."
                if self._connected
                else "Demo Spot is ready to connect."
            ),
        )

    async def connect(self) -> RobotLinkStatus:
        self._connected = True
        self._last_seen_at = datetime.now(UTC)
        return await self.status()

    async def capture(self, source: str) -> RobotCameraFrame:
        if not self._connected:
            await self.connect()
        camera = next((item for item in self._sources if item.name == source), None)
        if camera is None:
            raise RobotAdapterError(f"Unknown demo camera source: {source}")

        now = datetime.now(UTC)
        self._last_seen_at = now
        phase = now.timestamp() % 8 / 8
        scan_x = 80 + int(800 * phase)
        robot_x = 510 + int(math.sin(phase * math.tau) * 105)
        label = html.escape(camera.label)
        timestamp = html.escape(now.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3] + " UTC")
        svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"
viewBox="0 0 960 540">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop stop-color="#07151d"/><stop offset="1" stop-color="#122a33"/>
  </linearGradient>
  <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
    <path d="M48 0H0V48" fill="none" stroke="#5ce1e633" stroke-width="1"/>
  </pattern>
</defs>
<rect width="960" height="540" fill="url(#bg)"/><rect width="960" height="540" fill="url(#grid)"/>
<path d="M0 390 L165 305 L340 360 L510 245 L700 330 L960 220 V540 H0Z"
  fill="#163d45" stroke="#4bc7cf" stroke-width="2" opacity=".8"/>
<g transform="translate({robot_x} 286)" fill="none" stroke="#e7f9f8"
  stroke-width="5" stroke-linecap="round">
  <rect x="-55" y="-28" width="110" height="56" rx="20" fill="#17323b"/>
  <path d="M-38 23l-18 76M-10 24l-8 77M36 23l20 76M9 24l8 77"/>
  <circle cx="-29" cy="-7" r="6" fill="#65f1d0" stroke="none"/>
  <circle cx="0" cy="-7" r="6" fill="#65f1d0" stroke="none"/>
</g>
<line x1="{scan_x}" y1="54" x2="{scan_x}" y2="468" stroke="#66f2d0" stroke-width="2" opacity=".75"/>
<rect x="28" y="24" width="418" height="62" rx="8" fill="#031016cc" stroke="#4bc7cf66"/>
<text x="48" y="50" fill="#65f1d0" font-family="monospace" font-size="15">
  NEXUS ROBOT LINK · LIVE DEMO
</text>
<text x="48" y="73" fill="#d7eeee" font-family="monospace" font-size="17">{label}</text>
<rect x="28" y="474" width="500" height="40" rx="7" fill="#031016cc"/>
<text x="47" y="500" fill="#d7eeee" font-family="monospace" font-size="15">{timestamp}</text>
<circle cx="901" cy="55" r="8" fill="#ff5b67"/>
<text x="870" y="82" fill="#ffd8db" font-family="monospace" font-size="13">REC</text>
</svg>"""
        return RobotCameraFrame(svg.encode("utf-8"), "image/svg+xml")


class DisabledRobotAdapter:
    def __init__(
        self,
        kind: Literal["demo", "spot", "disabled"] = "disabled",
        message: str | None = None,
    ) -> None:
        self._kind = kind
        self._message = message or "Robot linking is disabled by configuration."

    @property
    def kind(self) -> str:
        return self._kind

    @property
    def configured(self) -> bool:
        return False

    async def status(self) -> RobotLinkStatus:
        return RobotLinkStatus(
            adapter=self._kind,
            configured=False,
            connected=False,
            read_only=True,
            camera_sources=[],
            message=self._message,
        )

    async def connect(self) -> RobotLinkStatus:
        raise RobotAdapterError(self._message)

    async def capture(self, source: str) -> RobotCameraFrame:
        del source
        raise RobotAdapterError(self._message)


class SpotReadOnlyAdapter:
    """Read-only Boston Dynamics Spot telemetry and camera integration.

    SDK calls are blocking, so every public method runs them in a worker thread.
    The adapter never acquires a lease, registers an E-stop endpoint, powers motors,
    or sends a robot command.
    """

    def __init__(self, settings: Settings) -> None:
        self._hostname = settings.spot_hostname.strip()
        self._username = settings.spot_username.strip()
        self._password = settings.spot_password_value
        self._timeout = settings.spot_timeout_seconds
        self._lock = asyncio.Lock()
        self._robot: Any | None = None
        self._image_client: Any | None = None
        self._status = RobotLinkStatus(
            adapter="spot",
            configured=self.configured,
            connected=False,
            read_only=True,
            camera_sources=[],
            message=(
                "Spot is configured and ready to connect."
                if self.configured
                else "Set NEXUS_SPOT_HOSTNAME, NEXUS_SPOT_USERNAME, and NEXUS_SPOT_PASSWORD."
            ),
        )

    @property
    def kind(self) -> str:
        return "spot"

    @property
    def configured(self) -> bool:
        return bool(self._hostname and self._username and self._password)

    async def status(self) -> RobotLinkStatus:
        return self._status

    async def connect(self) -> RobotLinkStatus:
        if not self.configured:
            raise RobotAdapterError(
                "Spot credentials are incomplete. Configure hostname, username, and password."
            )
        async with self._lock:
            try:
                self._status = await asyncio.to_thread(self._connect_blocking)
            except Exception as exc:
                self._robot = None
                self._image_client = None
                self._status = self._status.model_copy(
                    update={
                        "connected": False,
                        "last_seen_at": datetime.now(UTC),
                        "message": f"Spot connection failed ({type(exc).__name__}).",
                    }
                )
                raise RobotAdapterError(self._status.message) from exc
            return self._status

    def _connect_blocking(self) -> RobotLinkStatus:
        bosdyn_client = importlib.import_module("bosdyn.client")
        sdk = bosdyn_client.create_standard_sdk("NEXUS-ReadOnly-Robot-Link")
        robot = sdk.create_robot(self._hostname)
        robot.authenticate(self._username, self._password)

        robot_id = robot.ensure_client("robot-id").get_id(timeout=self._timeout)
        robot_state = robot.ensure_client("robot-state").get_robot_state(timeout=self._timeout)
        image_client = robot.ensure_client("image")
        sources = image_client.list_image_sources(timeout=self._timeout)

        cameras = [
            RobotCameraSourceRead(
                name=str(source.name),
                label=str(source.name).replace("_", " ").title(),
                width=max(1, int(getattr(source, "cols", 1))),
                height=max(1, int(getattr(source, "rows", 1))),
            )
            for source in sources
            if "depth" not in str(source.name).lower()
        ]
        battery_percent: float | None = None
        battery_states = getattr(robot_state, "battery_states", [])
        if battery_states:
            charge = getattr(battery_states[0], "charge_percentage", None)
            if charge is not None:
                battery_percent = float(getattr(charge, "value", 0.0))

        version = getattr(getattr(robot_id, "software_release", None), "version", None)
        version_text = None
        if version is not None:
            version_text = ".".join(
                str(getattr(version, field, 0))
                for field in ("major_version", "minor_version", "patch_level")
            )

        self._robot = robot
        self._image_client = image_client
        now = datetime.now(UTC)
        return RobotLinkStatus(
            adapter="spot",
            configured=True,
            connected=True,
            read_only=True,
            robot_name=str(getattr(robot_id, "nickname", "Spot")) or "Spot",
            serial_number=str(getattr(robot_id, "serial_number", "")) or None,
            software_version=version_text,
            battery_percent=battery_percent,
            camera_sources=cameras,
            last_seen_at=now,
            message="Connected to Spot telemetry and image services in read-only mode.",
        )

    async def capture(self, source: str) -> RobotCameraFrame:
        if not self._status.connected:
            await self.connect()
        allowed = {camera.name for camera in self._status.camera_sources}
        if source not in allowed:
            raise RobotAdapterError(f"Unknown Spot camera source: {source}")
        try:
            return await asyncio.to_thread(self._capture_blocking, source)
        except RobotAdapterError:
            raise
        except Exception as exc:
            raise RobotAdapterError(f"Spot camera request failed ({type(exc).__name__}).") from exc

    def _capture_blocking(self, source: str) -> RobotCameraFrame:
        if self._image_client is None:
            raise RobotAdapterError("Spot image service is not connected.")
        image_module = importlib.import_module("bosdyn.client.image")
        image_pb2 = importlib.import_module("bosdyn.api.image_pb2")
        request = image_module.build_image_request(
            source,
            quality_percent=72,
            image_format=image_pb2.Image.FORMAT_JPEG,
        )
        responses = self._image_client.get_image([request], timeout=self._timeout)
        if not responses:
            raise RobotAdapterError("Spot returned no camera frame.")
        image = responses[0].shot.image
        if int(image.format) != int(image_pb2.Image.FORMAT_JPEG):
            raise RobotAdapterError("Spot camera did not return a JPEG frame.")
        self._status = self._status.model_copy(update={"last_seen_at": datetime.now(UTC)})
        return RobotCameraFrame(bytes(image.data), "image/jpeg")


def create_robot_adapter(settings: Settings) -> RobotAdapter:
    if settings.robot_adapter == "demo":
        return DemoSpotAdapter()
    if settings.robot_adapter == "spot":
        return SpotReadOnlyAdapter(settings)
    return DisabledRobotAdapter()
