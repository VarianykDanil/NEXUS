from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from nexus_api import __version__
from nexus_api.ai_review import EngineeringReviewProvider
from nexus_api.config import Settings, get_settings
from nexus_api.dashboard import dashboard_projection
from nexus_api.database import create_database, initialize_database
from nexus_api.events import EventBroker
from nexus_api.robot_adapter import RobotAdapter, RobotAdapterError, create_robot_adapter
from nexus_api.schemas import (
    ApprovalDecisionRequest,
    ApprovalDecisionResponse,
    AuditEntryRead,
    AuditVerification,
    DashboardApprovalDecisionRequest,
    DemoMotionCommand,
    DemoMotionStatus,
    EmergencyStopResponse,
    EngineeringReviewRequest,
    EngineeringReviewResponse,
    HealthResponse,
    LaunchRequest,
    LaunchResponse,
    OperatingModeRequest,
    ProjectCreate,
    ProjectDetail,
    ProjectSummary,
    ReadinessResponse,
    RobotJobCreate,
    RobotJobExecuteResponse,
    RobotJobRead,
    RobotLinkConnectResponse,
    RobotLinkStatus,
    RobotMemoryRead,
    SpatialSnapshotRead,
    TelemetryRead,
)
from nexus_api.service import (
    AIReviewProviderError,
    AIReviewUnavailableError,
    ApprovalNotFoundError,
    NexusService,
    ProjectNotFoundError,
    RobotJobNotFoundError,
    StateConflictError,
)
from nexus_api.spatial import build_spatial_snapshot

logger = logging.getLogger("nexus_api")
API_PREFIX = "/api/v1"


def create_app(
    settings: Settings | None = None,
    *,
    engineering_review_provider: EngineeringReviewProvider | None = None,
    robot_adapter: RobotAdapter | None = None,
) -> FastAPI:
    runtime_settings = settings or get_settings()
    logging.basicConfig(
        level=getattr(logging, runtime_settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    engine, session_factory = create_database(runtime_settings.database_url)
    events = EventBroker()
    runtime_robot_adapter = robot_adapter or create_robot_adapter(runtime_settings)
    service = NexusService(
        runtime_settings,
        session_factory,
        events,
        engineering_review_provider=engineering_review_provider,
        robot_adapter=runtime_robot_adapter,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await initialize_database(engine)
        await service.seed_demo_if_empty()
        await service.autostart_demo_motion()
        try:
            yield
        finally:
            await service.shutdown()
            await engine.dispose()

    application = FastAPI(
        title="NEXUS Control Plane API",
        summary="Safety-first orchestration for autonomous engineering missions",
        description=(
            "Plans engineering objectives, runs a deterministic digital-twin workflow, "
            "and enforces human approval before any physical-ready transition."
        ),
        version=__version__,
        lifespan=lifespan,
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=f"{API_PREFIX}/redoc",
    )
    application.state.settings = runtime_settings
    application.state.engine = engine
    application.state.session_factory = session_factory
    application.state.service = service
    application.state.events = events
    application.state.robot_adapter = runtime_robot_adapter

    origins = runtime_settings.cors_origin_list
    application.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials="*" not in origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    )

    @application.exception_handler(ProjectNotFoundError)
    async def project_not_found(_: Request, exc: ProjectNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": f"Project {exc} was not found"})

    @application.exception_handler(ApprovalNotFoundError)
    async def approval_not_found(_: Request, exc: ApprovalNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": f"Approval {exc} was not found"})

    @application.exception_handler(RobotJobNotFoundError)
    async def robot_job_not_found(_: Request, exc: RobotJobNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": f"Robot job {exc} was not found"})

    @application.exception_handler(StateConflictError)
    async def state_conflict(_: Request, exc: StateConflictError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @application.exception_handler(AIReviewUnavailableError)
    async def ai_review_unavailable(_: Request, __: AIReviewUnavailableError) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={
                "detail": "Engineering review is unavailable until OPENAI_API_KEY is configured"
            },
        )

    @application.exception_handler(AIReviewProviderError)
    async def ai_review_provider_error(_: Request, __: AIReviewProviderError) -> JSONResponse:
        return JSONResponse(
            status_code=502,
            content={"detail": "Engineering review provider could not complete the request"},
        )

    @application.exception_handler(RobotAdapterError)
    async def robot_adapter_error(_: Request, exc: RobotAdapterError) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @application.get(f"{API_PREFIX}/health", response_model=HealthResponse, tags=["system"])
    async def health() -> HealthResponse:
        return HealthResponse(version=__version__, environment=runtime_settings.environment)

    @application.get(f"{API_PREFIX}/ready", response_model=ReadinessResponse, tags=["system"])
    async def ready() -> ReadinessResponse:
        try:
            await service.readiness_check()
        except Exception as exc:
            logger.exception("Readiness check failed")
            raise HTTPException(status_code=503, detail="Database is not ready") from exc
        return ReadinessResponse()

    @application.get(
        f"{API_PREFIX}/projects", response_model=list[ProjectSummary], tags=["projects"]
    )
    async def list_projects() -> list[ProjectSummary]:
        return await service.list_projects()

    @application.post(
        f"{API_PREFIX}/projects",
        response_model=ProjectDetail,
        status_code=201,
        tags=["projects"],
    )
    async def create_project(payload: ProjectCreate) -> ProjectDetail:
        return await service.create_project(payload.name, payload.objective)

    @application.get(
        f"{API_PREFIX}/projects/{{project_id}}",
        response_model=ProjectDetail,
        tags=["projects"],
    )
    async def get_project(project_id: str) -> ProjectDetail:
        return await service.get_project(project_id)

    @application.get(
        f"{API_PREFIX}/projects/{{project_id}}/dashboard",
        response_model=dict[str, Any],
        tags=["projects"],
    )
    async def get_project_dashboard(project_id: str) -> dict[str, Any]:
        project = await service.get_project(project_id)
        verification = await service.verify_audit(project_id)
        return dashboard_projection(project, audit_valid=verification.valid)

    @application.get(
        f"{API_PREFIX}/projects/{{project_id}}/spatial",
        response_model=SpatialSnapshotRead,
        tags=["operations"],
    )
    async def get_project_spatial(project_id: str) -> SpatialSnapshotRead:
        project = await service.get_project(project_id)
        return build_spatial_snapshot(
            project,
            stream_id=events.stream_id,
            event_sequence=events.current_sequence(project_id),
        )

    @application.get(
        f"{API_PREFIX}/projects/{{project_id}}/robot-memory",
        response_model=list[RobotMemoryRead],
        tags=["robot jobs"],
        summary="List persistent map, procedure, and experience memory",
    )
    async def get_robot_memory(project_id: str) -> list[RobotMemoryRead]:
        return await service.list_robot_memory(project_id)

    @application.get(
        f"{API_PREFIX}/projects/{{project_id}}/jobs",
        response_model=list[RobotJobRead],
        tags=["robot jobs"],
    )
    async def list_robot_jobs(project_id: str) -> list[RobotJobRead]:
        return await service.list_robot_jobs(project_id)

    @application.post(
        f"{API_PREFIX}/projects/{{project_id}}/jobs",
        response_model=RobotJobRead,
        status_code=201,
        tags=["robot jobs"],
        summary="Plan a text or map-targeted robot job from persistent memory",
    )
    async def create_robot_job(project_id: str, payload: RobotJobCreate) -> RobotJobRead:
        return await service.create_robot_job(project_id, payload)

    @application.post(
        f"{API_PREFIX}/projects/{{project_id}}/jobs/{{job_id}}/execute",
        response_model=RobotJobExecuteResponse,
        status_code=202,
        tags=["robot jobs"],
        summary="Execute a planned job in the digital twin",
    )
    async def execute_robot_job(project_id: str, job_id: str) -> RobotJobExecuteResponse:
        job = await service.execute_robot_job(project_id, job_id)
        return RobotJobExecuteResponse(
            job=job,
            message="Job simulation started; no physical hardware command was sent.",
        )

    @application.get(
        f"{API_PREFIX}/projects/{{project_id}}/robot-link",
        response_model=RobotLinkStatus,
        tags=["robot link"],
        summary="Inspect the configured demo or Spot edge link",
    )
    async def get_robot_link(project_id: str) -> RobotLinkStatus:
        await service.get_project(project_id)
        return await runtime_robot_adapter.status()

    @application.get(
        f"{API_PREFIX}/projects/{{project_id}}/demo-motion",
        response_model=DemoMotionStatus,
        tags=["missions"],
        summary="Inspect continuous simulation-only virtual fleet motion",
    )
    async def get_demo_motion(project_id: str) -> DemoMotionStatus:
        return await service.get_demo_motion_status(project_id)

    @application.post(
        f"{API_PREFIX}/projects/{{project_id}}/demo-motion/start",
        response_model=DemoMotionStatus,
        tags=["missions"],
        summary="Start smooth collision-checked virtual fleet motion",
    )
    async def start_demo_motion(
        project_id: str, payload: DemoMotionCommand
    ) -> DemoMotionStatus:
        return await service.start_demo_motion(
            project_id,
            actor=payload.requested_by,
        )

    @application.post(
        f"{API_PREFIX}/projects/{{project_id}}/demo-motion/stop",
        response_model=DemoMotionStatus,
        tags=["missions"],
        summary="Stop virtual fleet motion without contacting hardware",
    )
    async def stop_demo_motion(
        project_id: str, payload: DemoMotionCommand
    ) -> DemoMotionStatus:
        return await service.stop_demo_motion(
            project_id,
            actor=payload.requested_by,
        )

    @application.post(
        f"{API_PREFIX}/projects/{{project_id}}/robot-link/connect",
        response_model=RobotLinkConnectResponse,
        tags=["robot link"],
        summary="Connect read-only telemetry and camera services",
    )
    async def connect_robot_link(project_id: str) -> RobotLinkConnectResponse:
        await service.get_project(project_id)
        status = await runtime_robot_adapter.connect()
        await service.record_robot_link(project_id, status)
        return RobotLinkConnectResponse(
            status=status,
            message=status.message,
        )

    @application.get(
        f"{API_PREFIX}/projects/{{project_id}}/robot-link/cameras/{{source}}/frame",
        response_class=Response,
        tags=["robot link"],
        summary="Capture one current camera frame",
    )
    async def get_robot_camera_frame(project_id: str, source: str) -> Response:
        await service.get_project(project_id)
        frame = await runtime_robot_adapter.capture(source)
        return Response(
            content=frame.content,
            media_type=frame.media_type,
            headers={"Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff"},
        )

    @application.post(
        f"{API_PREFIX}/projects/{{project_id}}/ai-review",
        response_model=EngineeringReviewResponse,
        tags=["assurance"],
        summary="Generate a read-only structured engineering review",
        description=(
            "Optionally calls the OpenAI Responses API with tools disabled, records a compact "
            "audit entry, and never authorizes or executes physical actions. Returns 503 when "
            "OPENAI_API_KEY is not configured."
        ),
        responses={
            502: {"description": "The provider could not complete a structured review"},
            503: {"description": "The optional provider is not configured"},
        },
    )
    async def create_engineering_review(
        project_id: str, payload: EngineeringReviewRequest
    ) -> EngineeringReviewResponse:
        return await service.generate_engineering_review(
            project_id,
            requested_by=payload.requested_by,
            operator_evidence=payload.evidence,
        )

    @application.post(
        f"{API_PREFIX}/projects/{{project_id}}/launch",
        response_model=LaunchResponse,
        status_code=202,
        tags=["missions"],
    )
    async def launch_project(project_id: str, payload: LaunchRequest) -> LaunchResponse:
        project, approval, message = await service.launch_project(
            project_id, payload.mode, requested_by=payload.requested_by
        )
        return LaunchResponse(project=project, approval=approval, message=message)

    @application.post(
        f"{API_PREFIX}/projects/{{project_id}}/mode",
        response_model=LaunchResponse,
        status_code=202,
        tags=["missions"],
    )
    async def set_operating_mode(project_id: str, payload: OperatingModeRequest) -> LaunchResponse:
        project, approval, message = await service.launch_project(
            project_id, payload.mode.lower(), requested_by=payload.requested_by
        )
        return LaunchResponse(project=project, approval=approval, message=message)

    @application.post(
        f"{API_PREFIX}/approvals/{{approval_id}}/decision",
        response_model=ApprovalDecisionResponse,
        tags=["safety"],
    )
    async def decide_approval(
        approval_id: str, payload: ApprovalDecisionRequest
    ) -> ApprovalDecisionResponse:
        project, approval, message = await service.decide_approval(
            approval_id,
            payload.decision,
            decided_by=payload.decided_by,
            comment=payload.comment,
        )
        return ApprovalDecisionResponse(project=project, approval=approval, message=message)

    @application.post(
        f"{API_PREFIX}/projects/{{project_id}}/approvals/{{approval_id}}/decision",
        response_model=ApprovalDecisionResponse,
        tags=["safety"],
    )
    async def decide_project_approval(
        project_id: str,
        approval_id: str,
        payload: DashboardApprovalDecisionRequest,
    ) -> ApprovalDecisionResponse:
        project, approval, message = await service.decide_approval(
            approval_id,
            payload.decision,
            decided_by=payload.decided_by,
            comment=payload.comment or payload.reason,
            expected_project_id=project_id,
        )
        return ApprovalDecisionResponse(project=project, approval=approval, message=message)

    @application.post(
        f"{API_PREFIX}/projects/{{project_id}}/emergency-stop",
        response_model=EmergencyStopResponse,
        tags=["safety"],
    )
    async def emergency_stop(project_id: str) -> EmergencyStopResponse:
        project = await service.emergency_stop(project_id)
        return EmergencyStopResponse(
            project=project,
            message="Emergency stop latched. All execution remains denied.",
        )

    @application.get(
        f"{API_PREFIX}/projects/{{project_id}}/telemetry",
        response_model=list[TelemetryRead],
        tags=["operations"],
    )
    async def get_telemetry(
        project_id: str, limit: int = Query(default=100, ge=1, le=1000)
    ) -> list[TelemetryRead]:
        return await service.list_telemetry(project_id, limit)

    @application.get(
        f"{API_PREFIX}/projects/{{project_id}}/audit",
        response_model=list[AuditEntryRead],
        tags=["assurance"],
    )
    async def get_audit(
        project_id: str, limit: int = Query(default=100, ge=1, le=1000)
    ) -> list[AuditEntryRead]:
        return await service.list_audit(project_id, limit)

    @application.get(
        f"{API_PREFIX}/projects/{{project_id}}/audit/verify",
        response_model=AuditVerification,
        tags=["assurance"],
    )
    async def verify_audit(project_id: str) -> AuditVerification:
        return await service.verify_audit(project_id)

    @application.websocket("/ws/projects/{project_id}")
    async def project_events(websocket: WebSocket, project_id: str) -> None:
        # CORS middleware does not apply to WebSocket handshakes. Enforce the
        # same browser-origin boundary here while continuing to allow non-browser
        # clients that do not send an Origin header.
        origin = websocket.headers.get("origin")
        if origin is not None and "*" not in origins and origin not in origins:
            await websocket.close(code=4403, reason="Origin not allowed")
            return
        try:
            project = await service.get_project(project_id)
        except ProjectNotFoundError:
            await websocket.close(code=4404, reason="Project not found")
            return
        await websocket.accept()
        try:
            async with events.subscribe(project_id) as subscription:
                # Subscribe before constructing the authoritative snapshot. Events
                # committed during projection remain queued and are replayed after it.
                project = await service.get_project(project_id)
                verification = await service.verify_audit(project_id)
                snapshot = dashboard_projection(project, audit_valid=verification.valid)
                emitted_at = datetime.now(UTC)
                snapshot_data = {"dashboard": snapshot}
                await websocket.send_json(
                    jsonable_encoder(
                        {
                            "schema_version": "1.0",
                            "stream_id": events.stream_id,
                            "sequence": subscription.start_sequence,
                            "type": "dashboard.snapshot",
                            "project_id": project_id,
                            "emitted_at": emitted_at,
                            "timestamp": emitted_at,
                            "data": snapshot_data,
                            "payload": snapshot_data,
                        }
                    )
                )
                while True:
                    event = await subscription.queue.get()
                    encoded = event.model_dump(mode="json")
                    encoded["payload"] = encoded["data"]
                    await websocket.send_json(jsonable_encoder(encoded))
        except WebSocketDisconnect:
            return

    return application


app = create_app()


def run() -> None:
    uvicorn.run("nexus_api.main:app", host="0.0.0.0", port=8000, reload=False)


if __name__ == "__main__":
    run()
