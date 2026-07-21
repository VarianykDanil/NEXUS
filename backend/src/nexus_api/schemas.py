from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class APIModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class RequestModel(BaseModel):
    """Normalize and reject unsafe text before it reaches persistence or the audit log."""

    model_config = ConfigDict(str_strip_whitespace=True)

    @field_validator("*", mode="after")
    @classmethod
    def reject_nul_characters(cls, value: Any) -> Any:
        # PostgreSQL rejects NUL bytes in text fields. Returning a validation
        # error here keeps malformed requests from becoming internal errors.
        if isinstance(value, str) and "\x00" in value:
            raise ValueError("text fields must not contain NUL characters")
        return value


class RequirementRead(APIModel):
    id: str
    title: str
    description: str
    category: str
    priority: str
    acceptance_criteria: str
    position: int


class ArchitectureComponentRead(APIModel):
    id: str
    name: str
    kind: str
    technology: str
    responsibility: str
    position: int


class TaskRead(APIModel):
    id: str
    title: str
    description: str
    status: str
    risk: str
    requires_approval: bool
    progress: float
    position: int


class ApprovalRead(APIModel):
    id: str
    project_id: str
    action: str
    status: str
    risk: str
    requested_by: str
    decided_by: str | None
    comment: str | None
    requested_at: datetime
    decided_at: datetime | None


class RobotStateRead(APIModel):
    connection: str
    mode: str
    pose_x: float
    pose_y: float
    pose_z: float
    yaw: float
    velocity: float
    battery_percent: float
    map_coverage_percent: float
    hazards_detected: int
    emergency_stopped: bool
    last_seen_at: datetime


class TelemetryRead(APIModel):
    id: str
    project_id: str
    recorded_at: datetime
    metric: str
    value: float
    unit: str
    details: dict[str, Any]


class AuditEntryRead(APIModel):
    id: str
    project_id: str
    sequence: int
    recorded_at: datetime
    actor: str
    action: str
    entity_type: str
    entity_id: str
    details: dict[str, Any]
    previous_hash: str
    entry_hash: str
    signature: str | None


class ProjectCreate(RequestModel):
    name: str = Field(min_length=3, max_length=160)
    objective: str = Field(min_length=20, max_length=5000)


class ProjectSummary(APIModel):
    id: str
    name: str
    objective: str
    status: str
    progress: float
    active_mode: str | None
    created_at: datetime
    updated_at: datetime
    battery_percent: float | None = None
    map_coverage_percent: float | None = None
    hazards_detected: int = 0
    pending_approvals: int = 0


class ProjectDetail(ProjectSummary):
    requirements: list[RequirementRead]
    architecture_components: list[ArchitectureComponentRead]
    tasks: list[TaskRead]
    approvals: list[ApprovalRead]
    robot_state: RobotStateRead | None
    recent_telemetry: list[TelemetryRead]
    recent_audit: list[AuditEntryRead]
    physical_execution_enabled: bool = False


class LaunchRequest(RequestModel):
    mode: Literal["simulation", "physical"]
    requested_by: str = Field(default="dashboard.user", min_length=2, max_length=120)


class LaunchResponse(BaseModel):
    project: ProjectDetail
    approval: ApprovalRead | None = None
    message: str
    hardware_command_sent: Literal[False] = False


class ApprovalDecisionRequest(RequestModel):
    decision: Literal["approved", "rejected"]
    decided_by: str = Field(min_length=2, max_length=120)
    comment: str | None = Field(default=None, max_length=2000)


class DashboardApprovalDecisionRequest(RequestModel):
    decision: Literal["approved", "rejected"]
    decided_by: str = Field(default="operator", min_length=2, max_length=120)
    reason: str | None = Field(default=None, max_length=2000)
    comment: str | None = Field(default=None, max_length=2000)


class OperatingModeRequest(RequestModel):
    mode: Literal["SIMULATION", "PHYSICAL"]
    requested_by: str = Field(default="operator", min_length=2, max_length=120)


class ApprovalDecisionResponse(BaseModel):
    project: ProjectDetail
    approval: ApprovalRead
    message: str
    hardware_command_sent: Literal[False] = False


class EmergencyStopResponse(BaseModel):
    project: ProjectDetail
    message: str
    hardware_command_sent: Literal[False] = False


class RobotCameraSourceRead(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    label: str = Field(min_length=1, max_length=200)
    width: int = Field(ge=1, le=16384)
    height: int = Field(ge=1, le=16384)


class RobotLinkStatus(BaseModel):
    adapter: Literal["demo", "spot", "disabled"]
    configured: bool
    connected: bool
    read_only: Literal[True] = True
    robot_name: str | None = None
    serial_number: str | None = None
    software_version: str | None = None
    battery_percent: float | None = Field(default=None, ge=0, le=100)
    camera_sources: list[RobotCameraSourceRead]
    last_seen_at: datetime | None = None
    message: str


class RobotLinkConnectResponse(BaseModel):
    status: RobotLinkStatus
    message: str
    hardware_command_sent: Literal[False] = False


class DemoMotionStatus(BaseModel):
    enabled: bool
    running: bool
    simulation_only: Literal[True] = True
    frame_interval_seconds: float = Field(ge=0.1, le=2.0)
    speed_multiplier: float = Field(ge=0.1, le=4.0)
    message: str
    hardware_command_sent: Literal[False] = False


class DemoMotionCommand(RequestModel):
    requested_by: str = Field(default="dashboard.operator", min_length=2, max_length=120)


class RobotJobTargetRequest(BaseModel):
    floor_id: str = Field(min_length=1, max_length=80)
    x: float = Field(ge=0, le=1000, allow_inf_nan=False)
    y: float = Field(ge=0, le=1000, allow_inf_nan=False)
    room_id: str | None = Field(default=None, max_length=100)
    room_label: str | None = Field(default=None, max_length=160)


class RobotJobCreate(RequestModel):
    instruction: str = Field(min_length=8, max_length=2000)
    execution_mode: Literal["simulation", "physical"] = "simulation"
    requested_by: str = Field(default="dashboard.operator", min_length=2, max_length=120)
    target: RobotJobTargetRequest | None = None


class RobotJobStepRead(BaseModel):
    id: str
    title: str
    detail: str
    status: Literal["queued", "running", "completed", "blocked", "failed"]
    capability: str
    evidence: str | None = None


class RobotJobRead(APIModel):
    id: str
    project_id: str
    instruction: str
    status: Literal["planned", "running", "completed", "blocked", "failed", "cancelled"]
    execution_mode: Literal["simulation", "physical"]
    risk: Literal["low", "medium", "high", "critical"]
    requested_by: str
    assigned_robot_id: str
    assigned_robot_name: str
    target_floor_id: str
    target_room_id: str | None
    target_room_label: str | None
    target_x: float
    target_y: float
    progress: float = Field(ge=0, le=100)
    memory_context: dict[str, Any]
    steps: list[RobotJobStepRead]
    result: dict[str, Any]
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


class RobotJobExecuteResponse(BaseModel):
    job: RobotJobRead
    message: str
    hardware_command_sent: Literal[False] = False


class RobotMemoryRead(APIModel):
    id: str
    project_id: str
    key: str
    kind: Literal["location", "procedure", "experience"]
    label: str
    content: dict[str, Any]
    confidence: float = Field(ge=0, le=1)
    source: str
    created_at: datetime
    updated_at: datetime


class EngineeringReviewReadiness(StrEnum):
    BLOCKED = "blocked"
    NEEDS_WORK = "needs_work"
    READY_FOR_SIMULATION = "ready_for_simulation"


class EngineeringFindingSeverity(StrEnum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class EngineeringFindingDomain(StrEnum):
    REQUIREMENTS = "requirements"
    ARCHITECTURE = "architecture"
    SOFTWARE = "software"
    HARDWARE = "hardware"
    SAFETY = "safety"
    SIMULATION = "simulation"
    TESTING = "testing"
    OPERATIONS = "operations"
    SECURITY = "security"


class EngineeringReviewFinding(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    severity: EngineeringFindingSeverity
    domain: EngineeringFindingDomain
    evidence: str = Field(min_length=3, max_length=600)
    recommendation: str = Field(min_length=3, max_length=600)
    requires_human_approval: bool


class EngineeringReviewContent(BaseModel):
    """Provider-authored fields; bounds also become the structured-output schema."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    readiness: EngineeringReviewReadiness
    summary: str = Field(min_length=10, max_length=480)
    findings: list[EngineeringReviewFinding] = Field(min_length=1, max_length=8)
    next_experiment: str = Field(min_length=10, max_length=600)


class EngineeringReviewRequest(RequestModel):
    requested_by: str = Field(default="dashboard.user", min_length=2, max_length=120)
    evidence: str | None = Field(default=None, min_length=1, max_length=6000)


class EngineeringReviewResponse(EngineeringReviewContent):
    project_id: str
    provider: Literal["openai"] = "openai"
    model: str = Field(min_length=1, max_length=100)
    prompt_version: Literal["engineering-review-v1"] = "engineering-review-v1"
    input_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    generated_at: datetime
    audit_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    advisory_only: Literal[True] = True
    simulation_only: Literal[True] = True
    physical_execution_enabled: Literal[False] = False
    hardware_command_sent: Literal[False] = False


class AuditVerification(BaseModel):
    valid: bool
    entries_checked: int
    head_hash: str | None
    broken_sequence: int | None = None
    reason: str | None = None


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: str = "nexus-api"
    version: str
    environment: str


class ReadinessResponse(BaseModel):
    status: Literal["ready"] = "ready"
    database: Literal["ready"] = "ready"


class ErrorResponse(BaseModel):
    detail: str


class EventEnvelope(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    stream_id: str
    # A process may restart with existing projects and a fresh stream. Its
    # authoritative first snapshot is sequence zero; published deltas start at one.
    sequence: int = Field(ge=0)
    type: str
    project_id: str
    emitted_at: datetime
    timestamp: datetime
    data: dict[str, Any]


class SpatialAPIModel(BaseModel):
    """Strict, read-only spatial data serialized with dashboard-facing aliases."""

    model_config = ConfigDict(populate_by_name=True)


class SpatialTrailPointRead(SpatialAPIModel):
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    z: float = Field(allow_inf_nan=False)
    floor_id: str = Field(serialization_alias="floorId", min_length=1, max_length=80)


class SpatialRobotPoseRead(SpatialTrailPointRead):
    yaw: float = Field(allow_inf_nan=False)


class SpatialRobotRead(SpatialAPIModel):
    id: str
    name: str
    model: str
    role: str
    status: Literal["nominal", "warning", "critical", "offline"]
    connection: str
    battery: float = Field(ge=0, le=100, allow_inf_nan=False)
    speed: float = Field(ge=0, allow_inf_nan=False)
    localization: float = Field(ge=0, le=100, allow_inf_nan=False)
    mission: str
    pose: SpatialRobotPoseRead
    trail: list[SpatialTrailPointRead] = Field(max_length=120)


class SpatialRoomRead(SpatialAPIModel):
    id: str
    label: str
    kind: str
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    width: float = Field(gt=0, allow_inf_nan=False)
    depth: float = Field(gt=0, allow_inf_nan=False)
    explored: float = Field(ge=0, le=100, allow_inf_nan=False)


class SpatialWallRead(SpatialAPIModel):
    id: str
    x1: float = Field(allow_inf_nan=False)
    y1: float = Field(allow_inf_nan=False)
    x2: float = Field(allow_inf_nan=False)
    y2: float = Field(allow_inf_nan=False)
    thickness: float = Field(gt=0, le=1, allow_inf_nan=False)
    height: float = Field(gt=0, le=10, allow_inf_nan=False)


class SpatialDoorRead(SpatialAPIModel):
    id: str
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    width: float = Field(gt=0, le=5, allow_inf_nan=False)
    orientation: Literal["horizontal", "vertical"]


class SpatialConnectorRead(SpatialAPIModel):
    id: str
    kind: Literal["stairs", "elevator"]
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    width: float = Field(gt=0, allow_inf_nan=False)
    depth: float = Field(gt=0, allow_inf_nan=False)
    target_floor_ids: list[str] = Field(
        serialization_alias="targetFloorIds", min_length=1, max_length=12
    )


class SpatialHazardRead(SpatialAPIModel):
    id: str
    type: str
    severity: Literal["low", "medium", "high"]
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    z: float = Field(allow_inf_nan=False)
    confidence: float = Field(ge=0, le=100, allow_inf_nan=False)
    detected_at: datetime = Field(serialization_alias="detectedAt")


class SpatialFloorRead(SpatialAPIModel):
    id: str
    label: str
    level: int
    elevation: float = Field(allow_inf_nan=False)
    height: float = Field(gt=0, le=10, allow_inf_nan=False)
    width: float = Field(gt=0, allow_inf_nan=False)
    depth: float = Field(gt=0, allow_inf_nan=False)
    coverage: float = Field(ge=0, le=100, allow_inf_nan=False)
    rooms: list[SpatialRoomRead] = Field(max_length=100)
    walls: list[SpatialWallRead] = Field(max_length=200)
    doors: list[SpatialDoorRead] = Field(max_length=100)
    connectors: list[SpatialConnectorRead] = Field(max_length=20)
    hazards: list[SpatialHazardRead] = Field(max_length=100)
    path: list[SpatialTrailPointRead] = Field(max_length=120)


class SpatialBuildingRead(SpatialAPIModel):
    id: str
    name: str
    width: float = Field(gt=0, allow_inf_nan=False)
    depth: float = Field(gt=0, allow_inf_nan=False)
    floor_height: float = Field(
        serialization_alias="floorHeight", gt=0, le=10, allow_inf_nan=False
    )
    frame: Literal["building_enu"] = "building_enu"
    floors: list[SpatialFloorRead] = Field(min_length=1, max_length=12)


class SpatialSnapshotRead(SpatialAPIModel):
    schema_version: Literal["1.0"] = Field(default="1.0", serialization_alias="schemaVersion")
    project_id: str = Field(serialization_alias="projectId")
    generated_at: datetime = Field(serialization_alias="generatedAt")
    revision: int = Field(ge=0)
    stream_id: str = Field(serialization_alias="streamId")
    event_sequence: int = Field(serialization_alias="eventSequence", ge=0)
    simulation_only: Literal[True] = Field(default=True, serialization_alias="simulationOnly")
    physical_execution_enabled: Literal[False] = Field(
        default=False, serialization_alias="physicalExecutionEnabled"
    )
    building: SpatialBuildingRead
    robots: list[SpatialRobotRead] = Field(min_length=1, max_length=32)
