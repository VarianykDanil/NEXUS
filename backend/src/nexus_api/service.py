from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from nexus_api.ai_review import (
    ENGINEERING_REVIEW_PROMPT_VERSION,
    EngineeringReviewProvider,
    EngineeringReviewProviderRequest,
    OpenAIEngineeringReviewProvider,
    build_engineering_evidence,
)
from nexus_api.audit import append_audit_entry, verify_project_audit
from nexus_api.config import Settings
from nexus_api.events import EventBroker
from nexus_api.job_planner import (
    location_memory_records,
    plan_robot_job,
    procedure_memory_records,
)
from nexus_api.models import (
    Approval,
    ArchitectureComponent,
    AuditEntry,
    Project,
    Requirement,
    RobotJob,
    RobotMemory,
    RobotState,
    Task,
    Telemetry,
    utc_now,
)
from nexus_api.planner import decompose_objective
from nexus_api.robot_adapter import RobotAdapter, RobotAdapterError
from nexus_api.schemas import (
    ApprovalRead,
    ArchitectureComponentRead,
    AuditEntryRead,
    AuditVerification,
    DemoMotionStatus,
    EngineeringFindingDomain,
    EngineeringFindingSeverity,
    EngineeringReviewContent,
    EngineeringReviewResponse,
    ProjectDetail,
    ProjectSummary,
    RequirementRead,
    RobotJobCreate,
    RobotJobRead,
    RobotLinkStatus,
    RobotMemoryRead,
    RobotStateRead,
    SpatialSnapshotRead,
    TaskRead,
    TelemetryRead,
)
from nexus_api.spatial import (
    FLOOR_HEIGHT_M,
    FLOOR_IDS,
    build_demo_motion_snapshot,
    build_spatial_snapshot,
)

logger = logging.getLogger(__name__)
PROJECT_LOCK_STRIPES = 64


class ProjectNotFoundError(LookupError):
    pass


class ApprovalNotFoundError(LookupError):
    pass


class RobotJobNotFoundError(LookupError):
    pass


class StateConflictError(RuntimeError):
    pass


class AIReviewUnavailableError(RuntimeError):
    pass


class AIReviewProviderError(RuntimeError):
    pass


PROJECT_LOAD_OPTIONS = (
    selectinload(Project.requirements),
    selectinload(Project.architecture_components),
    selectinload(Project.tasks),
    selectinload(Project.approvals),
    selectinload(Project.robot_state),
)


class NexusService:
    def __init__(
        self,
        settings: Settings,
        session_factory: async_sessionmaker[AsyncSession],
        events: EventBroker,
        engineering_review_provider: EngineeringReviewProvider | None = None,
        robot_adapter: RobotAdapter | None = None,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.events = events
        self._engineering_review_provider = engineering_review_provider
        if robot_adapter is None:
            raise ValueError("NexusService requires a robot adapter")
        self.robot_adapter = robot_adapter
        self._simulation_tasks: dict[str, asyncio.Task[None]] = {}
        self._demo_motion_tasks: dict[str, asyncio.Task[None]] = {}
        self._job_tasks: dict[str, asyncio.Task[None]] = {}
        self._job_projects: dict[str, str] = {}
        # Serializes audit-bearing transactions per project inside one API process.
        # PostgreSQL deployments with multiple API replicas should additionally use
        # an audit-head row locked with SELECT FOR UPDATE (documented in README).
        # A fixed stripe set avoids retaining one lock forever for every arbitrary
        # project id sent to a public endpoint. Collisions only serialize unrelated
        # projects; the same project always selects the same lock.
        self._project_locks = tuple(asyncio.Lock() for _ in range(PROJECT_LOCK_STRIPES))

    def _lock_for_project(self, project_id: str) -> asyncio.Lock:
        return self._project_locks[hash(project_id) % len(self._project_locks)]

    async def readiness_check(self) -> None:
        async with self.session_factory() as session:
            await session.execute(text("SELECT 1"))

    async def list_projects(self) -> list[ProjectSummary]:
        async with self.session_factory() as session:
            projects = list(
                (
                    await session.scalars(
                        select(Project)
                        .options(*PROJECT_LOAD_OPTIONS)
                        .order_by(Project.updated_at.desc())
                    )
                ).all()
            )
            return [self._project_summary(project) for project in projects]

    async def get_project(self, project_id: str) -> ProjectDetail:
        async with self.session_factory() as session:
            project = await self._load_project(session, project_id)
            return await self._project_detail(session, project)

    def _get_engineering_review_provider(self) -> EngineeringReviewProvider:
        if self._engineering_review_provider is not None:
            return self._engineering_review_provider
        api_key = self.settings.openai_api_key_value
        if api_key is None:
            raise AIReviewUnavailableError
        try:
            self._engineering_review_provider = OpenAIEngineeringReviewProvider(
                api_key=api_key,
                timeout_seconds=self.settings.openai_timeout_seconds,
            )
        except Exception as exc:
            logger.warning(
                "Engineering review provider initialization failed (%s)",
                type(exc).__name__,
            )
            raise AIReviewProviderError from None
        return self._engineering_review_provider

    async def generate_engineering_review(
        self,
        project_id: str,
        *,
        requested_by: str,
        operator_evidence: str | None,
    ) -> EngineeringReviewResponse:
        project = await self.get_project(project_id)
        verification = await self.verify_audit(project_id)
        provider = self._get_engineering_review_provider()
        evidence_json = build_engineering_evidence(
            project,
            audit_valid=verification.valid,
            audit_head_hash=verification.head_hash,
            operator_evidence=operator_evidence,
        )
        provider_request = EngineeringReviewProviderRequest(
            model=self.settings.openai_model,
            evidence_json=evidence_json,
        )
        try:
            generated = await provider.generate(provider_request)
            content = EngineeringReviewContent.model_validate(generated)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Provider exception messages may contain request details. Log only
            # the class name and return a stable, secret-free API error.
            logger.warning(
                "Engineering review provider failed for project %s (%s)",
                project_id,
                type(exc).__name__,
            )
            raise AIReviewProviderError from None

        protected_domains = {
            EngineeringFindingDomain.HARDWARE,
            EngineeringFindingDomain.SAFETY,
            EngineeringFindingDomain.OPERATIONS,
            EngineeringFindingDomain.SECURITY,
        }
        protected_severities = {
            EngineeringFindingSeverity.CRITICAL,
            EngineeringFindingSeverity.HIGH,
        }
        content = content.model_copy(
            update={
                "findings": [
                    finding.model_copy(update={"requires_human_approval": True})
                    if finding.domain in protected_domains
                    or finding.severity in protected_severities
                    else finding
                    for finding in content.findings
                ]
            }
        )
        generated_at = datetime.now(UTC)
        severity_counts: dict[str, int] = {}
        for finding in content.findings:
            severity = finding.severity.value
            severity_counts[severity] = severity_counts.get(severity, 0) + 1

        async with self._lock_for_project(project_id):
            async with self.session_factory() as session:
                stored = await self._load_project(session, project_id)
                audit_entry = await append_audit_entry(
                    session,
                    project_id=stored.id,
                    actor=requested_by,
                    action="engineering.review.completed",
                    entity_type="engineering_review",
                    entity_id=stored.id,
                    details={
                        "provider": "openai",
                        "model": provider_request.model,
                        "prompt_version": ENGINEERING_REVIEW_PROMPT_VERSION,
                        "input_sha256": provider_request.input_sha256,
                        "readiness": content.readiness.value,
                        "finding_count": len(content.findings),
                        "severity_counts": severity_counts,
                        "advisory_only": True,
                        "physical_execution_enabled": False,
                        "hardware_command_sent": False,
                    },
                    audit_hmac_key=self.settings.audit_hmac_key,
                )
                await session.commit()
                audit_hash = audit_entry.entry_hash

        response = EngineeringReviewResponse(
            **content.model_dump(),
            project_id=project_id,
            model=provider_request.model,
            input_sha256=provider_request.input_sha256,
            generated_at=generated_at,
            audit_hash=audit_hash,
        )
        await self.events.publish(
            project_id,
            "engineering.review.completed",
            {
                "provider": "openai",
                "model": response.model,
                "readiness": response.readiness.value,
                "findingCount": len(response.findings),
                "inputSha256": response.input_sha256,
                "generatedAt": response.generated_at.isoformat(),
                "auditHash": response.audit_hash,
                "advisoryOnly": True,
                "physicalExecutionEnabled": False,
                "hardwareCommandSent": False,
            },
        )
        return response

    async def create_project(
        self, name: str, objective: str, *, actor: str = "dashboard.user"
    ) -> ProjectDetail:
        plan = decompose_objective(objective)
        async with self.session_factory() as session:
            project = Project(
                name=name.strip(),
                objective=objective.strip(),
                status="planned",
                progress=8.0,
            )
            session.add(project)
            await session.flush()

            for position, requirement_plan in enumerate(plan.requirements, start=1):
                session.add(
                    Requirement(
                        project_id=project.id,
                        title=requirement_plan.title,
                        description=requirement_plan.description,
                        category=requirement_plan.category,
                        priority=requirement_plan.priority,
                        acceptance_criteria=requirement_plan.acceptance_criteria,
                        position=position,
                    )
                )
            for position, component_plan in enumerate(plan.components, start=1):
                session.add(
                    ArchitectureComponent(
                        project_id=project.id,
                        name=component_plan.name,
                        kind=component_plan.kind,
                        technology=component_plan.technology,
                        responsibility=component_plan.responsibility,
                        position=position,
                    )
                )
            for position, task_plan in enumerate(plan.tasks, start=1):
                session.add(
                    Task(
                        project_id=project.id,
                        title=task_plan.title,
                        description=task_plan.description,
                        status="complete" if position == 1 else "pending",
                        risk=task_plan.risk,
                        requires_approval=task_plan.requires_approval,
                        progress=100.0 if position == 1 else 0.0,
                        position=position,
                    )
                )
            session.add(RobotState(project_id=project.id))
            await append_audit_entry(
                session,
                project_id=project.id,
                actor=actor,
                action="project.created",
                entity_type="project",
                entity_id=project.id,
                details={
                    "objective": project.objective,
                    "planner": "deterministic-rules-v1",
                    "requirements": len(plan.requirements),
                    "tasks": len(plan.tasks),
                },
                audit_hmac_key=self.settings.audit_hmac_key,
            )
            await session.commit()

        detail = await self.get_project(project.id)
        await self.events.publish(
            project.id, "project.created", {"project": detail.model_dump(mode="json")}
        )
        if self.settings.demo_motion_autostart and actor != "system.seed":
            self._start_demo_motion_task(project.id, detail)
        return detail

    async def seed_demo_if_empty(self) -> None:
        if not self.settings.seed_demo:
            return
        async with self.session_factory() as session:
            project_count = await session.scalar(select(func.count(Project.id)))
        if project_count:
            return

        project = await self.create_project(
            "Sentinel Mapper - Building Hazard Reconnaissance",
            (
                "Design a small robot that can safely explore a multi-storey building, "
                "detect heat, smoke and gas hazards, and create a metric 3D map for responders."
            ),
            actor="system.seed",
        )
        async with self.session_factory() as session:
            stored = await self._load_project(session, project.id)
            stored.progress = 18.0
            if stored.robot_state is not None:
                stored.robot_state.connection = "digital_twin_ready"
                stored.robot_state.mode = "standby"
                stored.robot_state.battery_percent = 98.0
                stored.robot_state.map_coverage_percent = 12.0
            session.add_all(
                [
                    Telemetry(
                        project_id=stored.id,
                        metric="battery",
                        value=98.0,
                        unit="percent",
                        details={"source": "digital_twin"},
                    ),
                    Telemetry(
                        project_id=stored.id,
                        metric="map_coverage",
                        value=12.0,
                        unit="percent",
                        details={"floor": "ground", "source": "baseline_scan"},
                    ),
                    Telemetry(
                        project_id=stored.id,
                        metric="air_quality_index",
                        value=24.0,
                        unit="AQI",
                        details={"source": "virtual_gas_array"},
                    ),
                ]
            )
            await append_audit_entry(
                session,
                project_id=stored.id,
                actor="system.seed",
                action="digital_twin.ready",
                entity_type="simulation",
                entity_id=stored.id,
                details={
                    "scenario": "three-storey-office-v1",
                    "known_hazards": 3,
                    "physical_adapter": "denied",
                },
                audit_hmac_key=self.settings.audit_hmac_key,
            )
            await session.commit()

    async def _load_project(self, session: AsyncSession, project_id: str) -> Project:
        project = (
            await session.scalars(
                select(Project).where(Project.id == project_id).options(*PROJECT_LOAD_OPTIONS)
            )
        ).one_or_none()
        if project is None:
            raise ProjectNotFoundError(project_id)
        return project

    def _project_summary(self, project: Project) -> ProjectSummary:
        robot = project.robot_state
        return ProjectSummary(
            id=project.id,
            name=project.name,
            objective=project.objective,
            status=project.status,
            progress=round(project.progress, 1),
            active_mode=project.active_mode,
            created_at=project.created_at,
            updated_at=project.updated_at,
            battery_percent=robot.battery_percent if robot else None,
            map_coverage_percent=robot.map_coverage_percent if robot else None,
            hazards_detected=robot.hazards_detected if robot else 0,
            pending_approvals=sum(approval.status == "pending" for approval in project.approvals),
        )

    async def _project_detail(
        self, session: AsyncSession, project: Project, *, recent_limit: int = 30
    ) -> ProjectDetail:
        telemetry = list(
            (
                await session.scalars(
                    select(Telemetry)
                    .where(Telemetry.project_id == project.id)
                    .order_by(Telemetry.recorded_at.desc())
                    .limit(recent_limit)
                )
            ).all()
        )
        audit = list(
            (
                await session.scalars(
                    select(AuditEntry)
                    .where(AuditEntry.project_id == project.id)
                    .order_by(AuditEntry.sequence.desc())
                    .limit(recent_limit)
                )
            ).all()
        )
        summary = self._project_summary(project)
        return ProjectDetail(
            **summary.model_dump(),
            requirements=[
                RequirementRead.model_validate(item)
                for item in sorted(project.requirements, key=lambda item: item.position)
            ],
            architecture_components=[
                ArchitectureComponentRead.model_validate(item)
                for item in sorted(project.architecture_components, key=lambda item: item.position)
            ],
            tasks=[
                TaskRead.model_validate(item)
                for item in sorted(project.tasks, key=lambda item: item.position)
            ],
            approvals=[
                ApprovalRead.model_validate(item)
                for item in sorted(
                    project.approvals,
                    key=lambda item: item.requested_at,
                    reverse=True,
                )
            ],
            robot_state=RobotStateRead.model_validate(project.robot_state)
            if project.robot_state
            else None,
            recent_telemetry=[TelemetryRead.model_validate(item) for item in telemetry],
            recent_audit=[AuditEntryRead.model_validate(item) for item in audit],
            physical_execution_enabled=False,
        )

    async def launch_project(
        self, project_id: str, mode: str, *, requested_by: str
    ) -> tuple[ProjectDetail, ApprovalRead | None, str]:
        async with self._lock_for_project(project_id):
            if mode == "simulation":
                return await self._launch_simulation(project_id, requested_by=requested_by)
            if mode == "physical":
                return await self._request_physical_launch(project_id, requested_by=requested_by)
            raise StateConflictError(f"Unsupported launch mode: {mode}")

    async def _launch_simulation(
        self, project_id: str, *, requested_by: str
    ) -> tuple[ProjectDetail, None, str]:
        await self._cancel_simulation(project_id)
        await self._cancel_demo_motion(project_id)
        async with self.session_factory() as session:
            project = await self._load_project(session, project_id)
            if project.status == "emergency_stopped" or (
                project.robot_state is not None and project.robot_state.emergency_stopped
            ):
                raise StateConflictError(
                    "Emergency stop is latched; this project cannot launch a simulation"
                )
            project.status = "simulation_running"
            project.active_mode = "simulation"
            project.progress = 5.0
            if project.robot_state is not None:
                project.robot_state.connection = "digital_twin_connected"
                project.robot_state.mode = "simulation"
                project.robot_state.velocity = 0.0
                project.robot_state.emergency_stopped = False
                project.robot_state.last_seen_at = utc_now()
            for task in project.tasks:
                if task.title == "Run safety-qualified simulation":
                    task.status = "in_progress"
                    task.progress = 5.0
            await append_audit_entry(
                session,
                project_id=project.id,
                actor=requested_by,
                action="simulation.started",
                entity_type="simulation",
                entity_id=project.id,
                details={"mode": "simulation", "hardware_command_sent": False},
                audit_hmac_key=self.settings.audit_hmac_key,
            )
            await session.commit()

        detail = await self.get_project(project_id)
        await self.events.publish(
            project_id,
            "simulation.started",
            {"status": detail.status, "progress": detail.progress},
        )
        self._start_simulation(project_id)
        return detail, None, "Digital-twin run started; no physical hardware was contacted."

    async def _request_physical_launch(
        self, project_id: str, *, requested_by: str
    ) -> tuple[ProjectDetail, ApprovalRead, str]:
        await self._cancel_simulation(project_id)
        await self._cancel_demo_motion(project_id)
        async with self.session_factory() as session:
            project = await self._load_project(session, project_id)
            if project.status == "emergency_stopped" or (
                project.robot_state is not None and project.robot_state.emergency_stopped
            ):
                raise StateConflictError(
                    "Emergency stop is latched; physical launch approval cannot be requested"
                )
            pending = next(
                (
                    item
                    for item in project.approvals
                    if item.action == "physical_launch" and item.status == "pending"
                ),
                None,
            )
            approval = pending or Approval(
                project_id=project.id,
                action="physical_launch",
                status="pending",
                risk="critical",
                requested_by=requested_by,
            )
            if pending is None:
                session.add(approval)
                await session.flush()
                await append_audit_entry(
                    session,
                    project_id=project.id,
                    actor=requested_by,
                    action="approval.requested",
                    entity_type="approval",
                    entity_id=approval.id,
                    details={
                        "requested_action": "physical_launch",
                        "risk": "critical",
                        "hardware_command_sent": False,
                    },
                    audit_hmac_key=self.settings.audit_hmac_key,
                )
            project.status = "awaiting_approval"
            project.active_mode = "physical"
            if project.robot_state is not None:
                project.robot_state.connection = (
                    f"{self.robot_adapter.kind}_available"
                    if self.robot_adapter.configured
                    else "adapter_unconfigured"
                )
                project.robot_state.mode = "safety_locked"
                project.robot_state.velocity = 0.0
                project.robot_state.last_seen_at = utc_now()
            for task in project.tasks:
                if task.requires_approval:
                    task.status = "awaiting_approval"
            await session.commit()
            approval_read = ApprovalRead.model_validate(approval)

        detail = await self.get_project(project_id)
        await self.events.publish(
            project_id,
            "approval.requested",
            {"approval": approval_read.model_dump(mode="json"), "hardware_command_sent": False},
        )
        return (
            detail,
            approval_read,
            "Human approval is required before the configured robot link can become active.",
        )

    async def decide_approval(
        self,
        approval_id: str,
        decision: str,
        *,
        decided_by: str,
        comment: str | None,
        expected_project_id: str | None = None,
    ) -> tuple[ProjectDetail, ApprovalRead, str]:
        async with self.session_factory() as session:
            project_id = await session.scalar(
                select(Approval.project_id).where(Approval.id == approval_id)
            )
        if project_id is None or (
            expected_project_id is not None and project_id != expected_project_id
        ):
            raise ApprovalNotFoundError(approval_id)
        async with self._lock_for_project(project_id):
            if decision == "approved":
                await self._cancel_simulation(project_id)
            robot_link: RobotLinkStatus | None = None
            if decision == "approved":
                try:
                    robot_link = await self.robot_adapter.connect()
                except RobotAdapterError:
                    robot_link = await self.robot_adapter.status()
            return await self._decide_approval_unlocked(
                approval_id,
                decision,
                decided_by=decided_by,
                comment=comment,
                expected_project_id=expected_project_id,
                robot_link=robot_link,
            )

    async def _decide_approval_unlocked(
        self,
        approval_id: str,
        decision: str,
        *,
        decided_by: str,
        comment: str | None,
        expected_project_id: str | None = None,
        robot_link: RobotLinkStatus | None = None,
    ) -> tuple[ProjectDetail, ApprovalRead, str]:
        async with self.session_factory() as session:
            approval = await session.get(Approval, approval_id)
            if approval is None:
                raise ApprovalNotFoundError(approval_id)
            if expected_project_id is not None and approval.project_id != expected_project_id:
                raise ApprovalNotFoundError(approval_id)
            if approval.status != "pending":
                raise StateConflictError(
                    f"Approval {approval.id} has already been decided as {approval.status}"
                )
            project = await self._load_project(session, approval.project_id)
            if decision == "approved" and (
                project.status == "emergency_stopped"
                or (project.robot_state is not None and project.robot_state.emergency_stopped)
            ):
                raise StateConflictError(
                    "Emergency stop is latched; approval cannot make the project physical-ready"
                )
            approval.status = decision
            approval.decided_by = decided_by
            approval.comment = comment
            approval.decided_at = datetime.now(UTC)

            if decision == "approved":
                project.status = "physical_ready"
                project.active_mode = "physical"
                if project.robot_state is not None:
                    project.robot_state.connection = (
                        f"{robot_link.adapter}_connected"
                        if robot_link is not None and robot_link.connected
                        else "adapter_offline"
                    )
                    project.robot_state.mode = (
                        "physical_observe"
                        if robot_link is not None and robot_link.connected
                        else "physical_ready_safe"
                    )
                    project.robot_state.velocity = 0.0
                    if robot_link is not None and robot_link.battery_percent is not None:
                        project.robot_state.battery_percent = robot_link.battery_percent
                    project.robot_state.last_seen_at = utc_now()
                for task in project.tasks:
                    if task.requires_approval:
                        task.status = "ready"
                if robot_link is not None and robot_link.connected:
                    message = (
                        f"Approval recorded. {robot_link.robot_name or robot_link.adapter} is "
                        "connected for live telemetry and cameras; no motion command was sent."
                    )
                else:
                    message = (
                        "Approval recorded, but the robot link is offline. No physical command "
                        "was sent."
                    )
            else:
                project.status = "approval_rejected"
                project.active_mode = None
                if project.robot_state is not None:
                    project.robot_state.connection = "virtual_ready"
                    project.robot_state.mode = "standby"
                    project.robot_state.velocity = 0.0
                    project.robot_state.last_seen_at = utc_now()
                for task in project.tasks:
                    if task.requires_approval:
                        task.status = "blocked"
                message = "Physical launch was rejected; the adapter remains denied."

            await append_audit_entry(
                session,
                project_id=project.id,
                actor=decided_by,
                action=f"approval.{decision}",
                entity_type="approval",
                entity_id=approval.id,
                details={
                    "requested_action": approval.action,
                    "comment": comment,
                    "robot_adapter": robot_link.adapter if robot_link is not None else None,
                    "robot_connected": robot_link.connected if robot_link is not None else False,
                    "hardware_command_sent": False,
                },
                audit_hmac_key=self.settings.audit_hmac_key,
            )
            await session.commit()
            approval_read = ApprovalRead.model_validate(approval)

        detail = await self.get_project(approval.project_id)
        await self.events.publish(
            approval.project_id,
            f"approval.{decision}",
            {
                "approval": approval_read.model_dump(mode="json"),
                "status": detail.status,
                "hardware_command_sent": False,
            },
        )
        return detail, approval_read, message

    async def record_robot_link(
        self,
        project_id: str,
        status: RobotLinkStatus,
        *,
        actor: str = "dashboard.operator",
    ) -> ProjectDetail:
        """Persist a read-only edge connection without granting motion authority."""

        async with self._lock_for_project(project_id):
            async with self.session_factory() as session:
                project = await self._load_project(session, project_id)
                if project.robot_state is not None:
                    project.robot_state.connection = (
                        f"{status.adapter}_connected" if status.connected else "adapter_offline"
                    )
                    if status.battery_percent is not None:
                        project.robot_state.battery_percent = status.battery_percent
                    project.robot_state.last_seen_at = utc_now()
                await append_audit_entry(
                    session,
                    project_id=project.id,
                    actor=actor,
                    action="robot.link_connected",
                    entity_type="robot_adapter",
                    entity_id=project.id,
                    details={
                        "adapter": status.adapter,
                        "read_only": status.read_only,
                        "robot_name": status.robot_name,
                        "camera_sources": [source.name for source in status.camera_sources],
                        "hardware_command_sent": False,
                    },
                    audit_hmac_key=self.settings.audit_hmac_key,
                )
                await session.commit()

            detail = await self.get_project(project_id)
            await self.events.publish(
                project_id,
                "robot.link_connected",
                {
                    "adapter": status.adapter,
                    "connected": status.connected,
                    "read_only": True,
                    "hardware_command_sent": False,
                },
            )
            return detail

    async def _ensure_robot_memory(
        self,
        session: AsyncSession,
        project_id: str,
        spatial: Any,
    ) -> None:
        existing = await session.scalar(
            select(func.count(RobotMemory.id)).where(RobotMemory.project_id == project_id)
        )
        if existing:
            return
        records = [*location_memory_records(spatial), *procedure_memory_records()]
        session.add_all(
            [RobotMemory(project_id=project_id, **record) for record in records]
        )

    async def list_robot_memory(self, project_id: str) -> list[RobotMemoryRead]:
        async with self._lock_for_project(project_id):
            detail = await self.get_project(project_id)
            spatial = build_spatial_snapshot(detail)
            async with self.session_factory() as session:
                await self._ensure_robot_memory(session, project_id, spatial)
                await session.commit()
                memories = list(
                    (
                        await session.scalars(
                            select(RobotMemory)
                            .where(RobotMemory.project_id == project_id)
                            .order_by(RobotMemory.kind, RobotMemory.label)
                        )
                    ).all()
                )
        return [RobotMemoryRead.model_validate(memory) for memory in memories]

    async def create_robot_job(
        self, project_id: str, payload: RobotJobCreate
    ) -> RobotJobRead:
        async with self._lock_for_project(project_id):
            detail = await self.get_project(project_id)
            if detail.status == "emergency_stopped" or (
                detail.robot_state is not None and detail.robot_state.emergency_stopped
            ):
                raise StateConflictError("Emergency stop is latched; a job cannot be planned")
            spatial = build_spatial_snapshot(detail)
            try:
                planned = plan_robot_job(spatial, payload.instruction, payload.target)
            except ValueError as exc:
                raise StateConflictError(str(exc)) from exc

            async with self.session_factory() as session:
                await self._ensure_robot_memory(session, project_id, spatial)
                job = RobotJob(
                    project_id=project_id,
                    instruction=payload.instruction,
                    execution_mode=payload.execution_mode,
                    risk=planned.risk,
                    requested_by=payload.requested_by,
                    assigned_robot_id=planned.assigned_robot_id,
                    assigned_robot_name=planned.assigned_robot_name,
                    target_floor_id=planned.target_floor_id,
                    target_room_id=planned.target_room_id,
                    target_room_label=planned.target_room_label,
                    target_x=planned.target_x,
                    target_y=planned.target_y,
                    memory_context=planned.memory_context,
                    steps=planned.steps,
                )
                session.add(job)
                await session.flush()
                await append_audit_entry(
                    session,
                    project_id=project_id,
                    actor=payload.requested_by,
                    action="robot.job.planned",
                    entity_type="robot_job",
                    entity_id=job.id,
                    details={
                        "instruction": payload.instruction,
                        "execution_mode": payload.execution_mode,
                        "assigned_robot_id": planned.assigned_robot_id,
                        "target_floor_id": planned.target_floor_id,
                        "target_room_id": planned.target_room_id,
                        "target_x": planned.target_x,
                        "target_y": planned.target_y,
                        "matched_memory_keys": planned.memory_context[
                            "matched_memory_keys"
                        ],
                        "route_distance_metres": planned.memory_context[
                            "route_distance_metres"
                        ],
                        "hardware_command_sent": False,
                    },
                    audit_hmac_key=self.settings.audit_hmac_key,
                )
                await session.commit()
                response = RobotJobRead.model_validate(job)

        await self.events.publish(
            project_id,
            "robot.job.planned",
            {"job": response.model_dump(mode="json"), "hardware_command_sent": False},
        )
        return response

    async def list_robot_jobs(self, project_id: str) -> list[RobotJobRead]:
        async with self.session_factory() as session:
            await self._ensure_project_exists(session, project_id)
            jobs = list(
                (
                    await session.scalars(
                        select(RobotJob)
                        .where(RobotJob.project_id == project_id)
                        .order_by(RobotJob.created_at.desc())
                    )
                ).all()
            )
        return [RobotJobRead.model_validate(job) for job in jobs]

    async def get_robot_job(self, project_id: str, job_id: str) -> RobotJobRead:
        async with self.session_factory() as session:
            job = (
                await session.scalars(
                    select(RobotJob).where(
                        RobotJob.id == job_id, RobotJob.project_id == project_id
                    )
                )
            ).one_or_none()
        if job is None:
            raise RobotJobNotFoundError(job_id)
        return RobotJobRead.model_validate(job)

    async def execute_robot_job(self, project_id: str, job_id: str) -> RobotJobRead:
        async with self._lock_for_project(project_id):
            async with self.session_factory() as session:
                project = await self._load_project(session, project_id)
                job = (
                    await session.scalars(
                        select(RobotJob).where(
                            RobotJob.id == job_id, RobotJob.project_id == project_id
                        )
                    )
                ).one_or_none()
                if job is None:
                    raise RobotJobNotFoundError(job_id)
                if job.status != "planned":
                    raise StateConflictError(
                        f"Job {job.id} cannot start from status {job.status}"
                    )
                if project.status == "emergency_stopped" or (
                    project.robot_state is not None and project.robot_state.emergency_stopped
                ):
                    raise StateConflictError("Emergency stop is latched; the job cannot start")
                if job.execution_mode == "physical":
                    raise StateConflictError(
                        "Physical job execution requires a certified command adapter; "
                        "run this job in simulation"
                    )

                steps = [dict(step) for step in job.steps]
                if steps:
                    steps[0]["status"] = "running"
                job.steps = steps
                job.status = "running"
                job.started_at = utc_now()
                job.progress = 0.0
                if project.robot_state is not None:
                    project.robot_state.mode = "job_simulation"
                    project.robot_state.connection = "digital_twin_connected"
                    project.robot_state.last_seen_at = utc_now()
                await append_audit_entry(
                    session,
                    project_id=project_id,
                    actor="dashboard.operator",
                    action="robot.job.started",
                    entity_type="robot_job",
                    entity_id=job.id,
                    details={
                        "execution_mode": "simulation",
                        "assigned_robot_id": job.assigned_robot_id,
                        "hardware_command_sent": False,
                    },
                    audit_hmac_key=self.settings.audit_hmac_key,
                )
                await session.commit()
                response = RobotJobRead.model_validate(job)

            self._start_robot_job(project_id, job_id)

        await self.events.publish(
            project_id,
            "robot.job.started",
            {"job": response.model_dump(mode="json"), "hardware_command_sent": False},
        )
        return response

    def _start_robot_job(self, project_id: str, job_id: str) -> None:
        task = asyncio.create_task(self._run_robot_job(project_id, job_id))
        self._job_tasks[job_id] = task
        self._job_projects[job_id] = project_id

        def discard(done: asyncio.Task[None]) -> None:
            if self._job_tasks.get(job_id) is done:
                self._job_tasks.pop(job_id, None)
                self._job_projects.pop(job_id, None)

        task.add_done_callback(discard)

    async def _run_robot_job(self, project_id: str, job_id: str) -> None:
        try:
            job = await self.get_robot_job(project_id, job_id)
            step_count = len(job.steps)
            for index in range(step_count):
                await asyncio.sleep(self.settings.simulation_step_delay_seconds)
                async with self._lock_for_project(project_id):
                    async with self.session_factory() as session:
                        stored = await session.get(RobotJob, job_id)
                        if stored is None or stored.status != "running":
                            return
                        steps = [dict(step) for step in stored.steps]
                        steps[index]["status"] = "completed"
                        steps[index]["evidence"] = (
                            f"Simulation evidence recorded for {steps[index]['capability']}."
                        )
                        if index + 1 < step_count:
                            steps[index + 1]["status"] = "running"
                        stored.steps = steps
                        stored.progress = round(((index + 1) / step_count) * 100, 1)
                        completed = index + 1 == step_count
                        if completed:
                            stored.status = "completed"
                            stored.completed_at = utc_now()
                            stored.result = {
                                "outcome": "completed_in_simulation",
                                "summary": (
                                    f"{stored.assigned_robot_name} completed the planned job at "
                                    f"{stored.target_room_label or stored.target_floor_id}."
                                ),
                                "target": {
                                    "floor_id": stored.target_floor_id,
                                    "room_id": stored.target_room_id,
                                    "x": stored.target_x,
                                    "y": stored.target_y,
                                },
                                "hardware_command_sent": False,
                            }
                            project = await self._load_project(session, project_id)
                            if project.robot_state is not None:
                                project.robot_state.pose_x = stored.target_x
                                project.robot_state.pose_y = stored.target_y
                                project.robot_state.pose_z = (
                                    FLOOR_IDS.index(stored.target_floor_id) * FLOOR_HEIGHT_M
                                    if stored.target_floor_id in FLOOR_IDS
                                    else 0.0
                                )
                                project.robot_state.velocity = 0.0
                                project.robot_state.mode = "job_simulation_complete"
                                project.robot_state.last_seen_at = utc_now()
                            session.add(
                                RobotMemory(
                                    project_id=project_id,
                                    key=f"experience:{stored.id}",
                                    kind="experience",
                                    label=f"Completed: {stored.instruction[:120]}",
                                    content={
                                        "job_id": stored.id,
                                        "instruction": stored.instruction,
                                        "assigned_robot_id": stored.assigned_robot_id,
                                        "target_floor_id": stored.target_floor_id,
                                        "target_room_id": stored.target_room_id,
                                        "result": stored.result,
                                    },
                                    confidence=0.9,
                                    source="completed-simulation-job",
                                )
                            )
                            await append_audit_entry(
                                session,
                                project_id=project_id,
                                actor="simulation.job-runner",
                                action="robot.job.completed",
                                entity_type="robot_job",
                                entity_id=stored.id,
                                details={
                                    "assigned_robot_id": stored.assigned_robot_id,
                                    "target_floor_id": stored.target_floor_id,
                                    "target_x": stored.target_x,
                                    "target_y": stored.target_y,
                                    "memory_updated": True,
                                    "hardware_command_sent": False,
                                },
                                audit_hmac_key=self.settings.audit_hmac_key,
                            )
                        await session.commit()
                        response = RobotJobRead.model_validate(stored)

                await self.events.publish(
                    project_id,
                    "robot.job.completed" if completed else "robot.job.updated",
                    {
                        "job": response.model_dump(mode="json"),
                        "hardware_command_sent": False,
                    },
                )
            await self._resume_demo_motion_if_configured(project_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("Robot job worker failed for job %s", job_id)
            async with self._lock_for_project(project_id):
                async with self.session_factory() as session:
                    stored = await session.get(RobotJob, job_id)
                    if stored is not None and stored.status == "running":
                        stored.status = "failed"
                        stored.result = {"error_type": type(exc).__name__}
                        await session.commit()
            await self._resume_demo_motion_if_configured(project_id)

    async def _cancel_project_jobs(self, project_id: str) -> None:
        matching = [
            job_id for job_id, stored_project_id in self._job_projects.items()
            if stored_project_id == project_id
        ]
        tasks = [self._job_tasks.pop(job_id) for job_id in matching]
        for job_id in matching:
            self._job_projects.pop(job_id, None)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def emergency_stop(
        self, project_id: str, *, actor: str = "dashboard.operator"
    ) -> ProjectDetail:
        async with self._lock_for_project(project_id):
            return await self._emergency_stop_unlocked(project_id, actor=actor)

    async def _emergency_stop_unlocked(
        self, project_id: str, *, actor: str = "dashboard.operator"
    ) -> ProjectDetail:
        await self._cancel_simulation(project_id)
        await self._cancel_demo_motion(project_id)
        await self._cancel_project_jobs(project_id)
        async with self.session_factory() as session:
            project = await self._load_project(session, project_id)
            already_stopped = project.status == "emergency_stopped"
            project.status = "emergency_stopped"
            if project.robot_state is not None:
                project.robot_state.emergency_stopped = True
                project.robot_state.connection = "stopped"
                project.robot_state.mode = "emergency_stop"
                project.robot_state.velocity = 0.0
                project.robot_state.last_seen_at = utc_now()
            for task in project.tasks:
                if task.status in {"running", "in_progress", "ready", "awaiting_approval"}:
                    task.status = "cancelled"
            running_jobs = list(
                (
                    await session.scalars(
                        select(RobotJob).where(
                            RobotJob.project_id == project_id,
                            RobotJob.status == "running",
                        )
                    )
                ).all()
            )
            for job in running_jobs:
                job.status = "cancelled"
                job.result = {"reason": "emergency_stop", "hardware_command_sent": False}
            await append_audit_entry(
                session,
                project_id=project.id,
                actor=actor,
                action="safety.emergency_stop",
                entity_type="project",
                entity_id=project.id,
                details={
                    "already_stopped": already_stopped,
                    "hardware_command_sent": False,
                    "adapter_behavior": "deny_and_latch",
                },
                audit_hmac_key=self.settings.audit_hmac_key,
            )
            await session.commit()

        detail = await self.get_project(project_id)
        spatial = build_spatial_snapshot(
            detail,
            stream_id=self.events.stream_id,
            event_sequence=self.events.current_sequence(project_id),
        )
        await self.events.publish(
            project_id,
            "safety.emergency_stop",
            {
                "status": detail.status,
                "robot_state": detail.robot_state.model_dump(mode="json")
                if detail.robot_state
                else None,
                "robots": [
                    robot.model_dump(mode="json", by_alias=True) for robot in spatial.robots
                ],
                "physicalExecutionEnabled": False,
            },
        )
        return detail

    def _demo_motion_is_running(self, project_id: str) -> bool:
        task = self._demo_motion_tasks.get(project_id)
        return task is not None and not task.done()

    def _demo_motion_status_value(self, project_id: str) -> DemoMotionStatus:
        running = self._demo_motion_is_running(project_id)
        return DemoMotionStatus(
            enabled=True,
            running=running,
            frame_interval_seconds=self.settings.demo_motion_frame_interval_seconds,
            speed_multiplier=self.settings.demo_motion_speed_multiplier,
            message=(
                "Virtual fleet motion is streaming from collision-checked demo routes."
                if running
                else "Virtual fleet motion is stopped."
            ),
        )

    async def get_demo_motion_status(self, project_id: str) -> DemoMotionStatus:
        await self.get_project(project_id)
        return self._demo_motion_status_value(project_id)

    async def start_demo_motion(
        self, project_id: str, *, actor: str = "dashboard.operator"
    ) -> DemoMotionStatus:
        async with self._lock_for_project(project_id):
            project = await self.get_project(project_id)
            if project.status == "emergency_stopped" or (
                project.robot_state is not None and project.robot_state.emergency_stopped
            ):
                raise StateConflictError(
                    "Emergency stop is latched; virtual demo motion cannot start"
                )
            if project.active_mode == "physical":
                raise StateConflictError(
                    "Virtual demo motion is paused while the project requests physical mode"
                )
            if project_id in self._simulation_tasks:
                raise StateConflictError(
                    "A mission simulation is already running; wait for it to complete"
                )
            if any(
                stored_project_id == project_id
                for stored_project_id in self._job_projects.values()
            ):
                raise StateConflictError(
                    "A robot job simulation is already running; wait for it to complete"
                )
            if not self._demo_motion_is_running(project_id):
                self._start_demo_motion_task(project_id, project)
                async with self.session_factory() as session:
                    stored = await self._load_project(session, project_id)
                    await append_audit_entry(
                        session,
                        project_id=stored.id,
                        actor=actor,
                        action="demo.motion.started",
                        entity_type="simulation",
                        entity_id=stored.id,
                        details={
                            "frame_interval_seconds": (
                                self.settings.demo_motion_frame_interval_seconds
                            ),
                            "speed_multiplier": self.settings.demo_motion_speed_multiplier,
                            "simulation_only": True,
                            "hardware_command_sent": False,
                        },
                        audit_hmac_key=self.settings.audit_hmac_key,
                    )
                    await session.commit()

        status = self._demo_motion_status_value(project_id)
        await self.events.publish(
            project_id,
            "demo.motion.started",
            status.model_dump(mode="json"),
        )
        return status

    async def stop_demo_motion(
        self, project_id: str, *, actor: str = "dashboard.operator"
    ) -> DemoMotionStatus:
        async with self._lock_for_project(project_id):
            project = await self.get_project(project_id)
            was_running = self._demo_motion_is_running(project_id)
            await self._cancel_demo_motion(project_id)
            if was_running:
                async with self.session_factory() as session:
                    stored = await self._load_project(session, project_id)
                    await append_audit_entry(
                        session,
                        project_id=stored.id,
                        actor=actor,
                        action="demo.motion.stopped",
                        entity_type="simulation",
                        entity_id=stored.id,
                        details={
                            "simulation_only": True,
                            "hardware_command_sent": False,
                        },
                        audit_hmac_key=self.settings.audit_hmac_key,
                    )
                    await session.commit()

        status = self._demo_motion_status_value(project_id)
        spatial = build_spatial_snapshot(
            project,
            stream_id=self.events.stream_id,
            event_sequence=self.events.current_sequence(project_id),
        )
        await self.events.publish(
            project_id,
            "robots.state.updated",
            self._spatial_event_payload(spatial),
        )
        await self.events.publish(
            project_id,
            "demo.motion.stopped",
            status.model_dump(mode="json"),
        )
        return status

    async def autostart_demo_motion(self) -> None:
        if not self.settings.demo_motion_autostart:
            return
        async with self.session_factory() as session:
            project_ids = list((await session.scalars(select(Project.id))).all())
        for project_id in project_ids:
            try:
                project = await self.get_project(project_id)
            except ProjectNotFoundError:
                continue
            if project.status == "emergency_stopped" or project.active_mode == "physical":
                continue
            self._start_demo_motion_task(project_id, project)

    def _start_demo_motion_task(
        self, project_id: str, project: ProjectDetail
    ) -> None:
        if self._demo_motion_is_running(project_id):
            return
        task = asyncio.create_task(self._run_demo_motion(project_id, project))
        self._demo_motion_tasks[project_id] = task

        def discard(done: asyncio.Task[None]) -> None:
            if self._demo_motion_tasks.get(project_id) is done:
                self._demo_motion_tasks.pop(project_id, None)

        task.add_done_callback(discard)

    async def _cancel_demo_motion(self, project_id: str) -> None:
        task = self._demo_motion_tasks.pop(project_id, None)
        if task is None or task.done() or task is asyncio.current_task():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def _resume_demo_motion_if_configured(self, project_id: str) -> None:
        if not self.settings.demo_motion_autostart or self._demo_motion_is_running(project_id):
            return
        try:
            project = await self.get_project(project_id)
        except ProjectNotFoundError:
            return
        if project.status == "emergency_stopped" or project.active_mode == "physical":
            return
        self._start_demo_motion_task(project_id, project)

    @staticmethod
    def _spatial_event_payload(spatial: SpatialSnapshotRead) -> dict[str, Any]:
        return {
            "revision": spatial.revision,
            "simulationOnly": True,
            "physicalExecutionEnabled": False,
            "robots": [
                robot.model_dump(mode="json", by_alias=True) for robot in spatial.robots
            ],
            "floors": [
                {
                    "id": floor.id,
                    "coverage": floor.coverage,
                    "hazards": [
                        hazard.model_dump(mode="json", by_alias=True)
                        for hazard in floor.hazards
                    ],
                    "rooms": [
                        {"id": room.id, "explored": room.explored}
                        for room in floor.rooms
                    ],
                    "path": [
                        point.model_dump(mode="json", by_alias=True)
                        for point in floor.path
                    ],
                }
                for floor in spatial.building.floors
            ],
        }

    async def _run_demo_motion(
        self, project_id: str, initial_project: ProjectDetail
    ) -> None:
        loop = asyncio.get_running_loop()
        started_at = loop.time()
        project = initial_project
        frame = 0
        try:
            while True:
                if frame > 0 and frame % 80 == 0:
                    project = await self.get_project(project_id)
                    if (
                        project.status == "emergency_stopped"
                        or project.active_mode == "physical"
                    ):
                        return
                elapsed = loop.time() - started_at
                spatial = build_demo_motion_snapshot(
                    project,
                    elapsed,
                    speed_multiplier=self.settings.demo_motion_speed_multiplier,
                    stream_id=self.events.stream_id,
                    event_sequence=self.events.current_sequence(project_id),
                )
                await self.events.publish(
                    project_id,
                    "robots.state.updated",
                    self._spatial_event_payload(spatial),
                )
                frame += 1
                await asyncio.sleep(self.settings.demo_motion_frame_interval_seconds)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("Demo motion worker failed for project %s", project_id)
            await self.events.publish(
                project_id,
                "demo.motion.failed",
                {
                    "error_type": type(exc).__name__,
                    "simulation_only": True,
                    "hardware_command_sent": False,
                },
            )

    async def list_telemetry(self, project_id: str, limit: int) -> list[TelemetryRead]:
        async with self.session_factory() as session:
            await self._ensure_project_exists(session, project_id)
            readings = list(
                (
                    await session.scalars(
                        select(Telemetry)
                        .where(Telemetry.project_id == project_id)
                        .order_by(Telemetry.recorded_at.desc())
                        .limit(limit)
                    )
                ).all()
            )
            return [TelemetryRead.model_validate(item) for item in readings]

    async def list_audit(self, project_id: str, limit: int) -> list[AuditEntryRead]:
        async with self.session_factory() as session:
            await self._ensure_project_exists(session, project_id)
            entries = list(
                (
                    await session.scalars(
                        select(AuditEntry)
                        .where(AuditEntry.project_id == project_id)
                        .order_by(AuditEntry.sequence.desc())
                        .limit(limit)
                    )
                ).all()
            )
            return [AuditEntryRead.model_validate(item) for item in entries]

    async def verify_audit(self, project_id: str) -> AuditVerification:
        async with self.session_factory() as session:
            await self._ensure_project_exists(session, project_id)
            return await verify_project_audit(session, project_id, self.settings.audit_hmac_key)

    async def _ensure_project_exists(self, session: AsyncSession, project_id: str) -> None:
        exists = await session.scalar(select(Project.id).where(Project.id == project_id))
        if exists is None:
            raise ProjectNotFoundError(project_id)

    def _start_simulation(self, project_id: str) -> None:
        task = asyncio.create_task(self._run_simulation_supervised(project_id))
        self._simulation_tasks[project_id] = task

        def discard(done: asyncio.Task[None]) -> None:
            if self._simulation_tasks.get(project_id) is done:
                self._simulation_tasks.pop(project_id, None)

        task.add_done_callback(discard)

    async def _cancel_simulation(self, project_id: str) -> None:
        task = self._simulation_tasks.pop(project_id, None)
        if task is None or task.done() or task is asyncio.current_task():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def _run_simulation_supervised(self, project_id: str) -> None:
        try:
            await self._run_simulation(project_id)
            await self._resume_demo_motion_if_configured(project_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("Simulation worker failed for project %s", project_id)
            try:
                async with self._lock_for_project(project_id):
                    marked_failed = await self._persist_simulation_failure(
                        project_id, error_type=type(exc).__name__
                    )
                if marked_failed:
                    await self.events.publish(
                        project_id,
                        "simulation.failed",
                        {
                            "status": "failed",
                            "error_type": type(exc).__name__,
                            "hardware_command_sent": False,
                        },
                    )
            except Exception:
                # A database outage may prevent persisting the failure state, but
                # the original worker exception is still consumed and both causes
                # are logged instead of becoming an unobserved task exception.
                logger.exception(
                    "Could not persist simulation failure for project %s", project_id
                )

    async def _persist_simulation_failure(self, project_id: str, *, error_type: str) -> bool:
        async with self.session_factory() as session:
            project = await self._load_project(session, project_id)
            if project.status == "emergency_stopped" or (
                project.robot_state is not None and project.robot_state.emergency_stopped
            ):
                return False
            project.status = "failed"
            if project.robot_state is not None:
                project.robot_state.connection = "digital_twin_error"
                project.robot_state.mode = "simulation_failed"
                project.robot_state.velocity = 0.0
                project.robot_state.last_seen_at = utc_now()
            for task in project.tasks:
                if task.title == "Run safety-qualified simulation":
                    task.status = "failed"
            await append_audit_entry(
                session,
                project_id=project.id,
                actor="simulation.supervisor",
                action="simulation.failed",
                entity_type="simulation",
                entity_id=project.id,
                details={
                    "error_type": error_type,
                    "hardware_command_sent": False,
                },
                audit_hmac_key=self.settings.audit_hmac_key,
            )
            await session.commit()
        return True

    async def _run_simulation(self, project_id: str) -> None:
        steps: Sequence[dict[str, Any]] = (
            {
                "progress": 12.0,
                "pose": (1.4, 0.8, 0.0, 0.35),
                "floor_id": "ground",
                "battery": 97.0,
                "coverage": 18.0,
                "hazards": 0,
                "phase": "localization_lock",
            },
            {
                "progress": 20.0,
                "pose": (4.8, 2.2, 0.0, 1.15),
                "floor_id": "ground",
                "battery": 95.0,
                "coverage": 27.0,
                "hazards": 0,
                "phase": "lobby_sweep",
            },
            {
                "progress": 29.0,
                "pose": (7.4, 5.4, 0.0, 1.57),
                "floor_id": "ground",
                "battery": 93.0,
                "coverage": 36.0,
                "hazards": 0,
                "phase": "ground_floor_west",
                "checkpoint": True,
            },
            {
                "progress": 37.0,
                "pose": (11.0, 8.4, 0.0, 0.73),
                "floor_id": "ground",
                "battery": 91.0,
                "coverage": 45.0,
                "hazards": 1,
                "phase": "ground_floor_sweep",
            },
            {
                "progress": 45.0,
                "pose": (11.1, 13.2, 3.4, 1.57),
                "floor_id": "level-1",
                "battery": 89.0,
                "coverage": 53.0,
                "hazards": 1,
                "phase": "stair_transition_level_1",
            },
            {
                "progress": 54.0,
                "pose": (8.2, 10.5, 3.4, 3.14),
                "floor_id": "level-1",
                "battery": 87.0,
                "coverage": 61.0,
                "hazards": 1,
                "phase": "level_1_west_sweep",
                "checkpoint": True,
            },
            {
                "progress": 63.0,
                "pose": (4.8, 12.2, 3.4, 3.58),
                "floor_id": "level-1",
                "battery": 86.0,
                "coverage": 69.0,
                "hazards": 2,
                "phase": "level_1_hazard_verification",
            },
            {
                "progress": 71.0,
                "pose": (14.0, 8.0, 3.4, 0.28),
                "floor_id": "level-1",
                "battery": 84.0,
                "coverage": 76.0,
                "hazards": 2,
                "phase": "level_1_east_sweep",
            },
            {
                "progress": 79.0,
                "pose": (14.2, 13.2, 6.8, 1.57),
                "floor_id": "level-2",
                "battery": 83.0,
                "coverage": 83.0,
                "hazards": 2,
                "phase": "stair_transition_level_2",
                "checkpoint": True,
            },
            {
                "progress": 87.0,
                "pose": (18.0, 11.2, 6.8, 5.76),
                "floor_id": "level-2",
                "battery": 82.0,
                "coverage": 89.0,
                "hazards": 3,
                "phase": "level_2_hazard_verification",
            },
            {
                "progress": 94.0,
                "pose": (21.0, 7.8, 6.8, 4.8),
                "floor_id": "level-2",
                "battery": 80.0,
                "coverage": 93.0,
                "hazards": 3,
                "phase": "level_2_final_sweep",
            },
            {
                "progress": 100.0,
                "pose": (0.4, 0.2, 0.0, 3.1),
                "floor_id": "ground",
                "battery": 79.0,
                "coverage": 96.0,
                "hazards": 3,
                "phase": "mission_complete",
                "checkpoint": True,
            },
        )
        for step in steps:
            await asyncio.sleep(self.settings.simulation_step_delay_seconds)
            async with self._lock_for_project(project_id):
                persisted = await self._persist_simulation_step(project_id, step)
            if not persisted:
                return
            progress = float(step["progress"])
            pose_x, pose_y, pose_z, yaw = step["pose"]
            await self.events.publish(
                project_id,
                "simulation.completed" if progress >= 100 else "simulation.progress",
                {
                    "phase": step["phase"],
                    "progress": progress,
                    "battery_percent": float(step["battery"]),
                    "pose": {
                        "x": float(pose_x),
                        "y": float(pose_y),
                        "z": float(pose_z),
                        "yaw": round(float(yaw) * 57.2958, 1),
                        "floorId": str(step["floor_id"]),
                    },
                    "map_coverage_percent": float(step["coverage"]),
                    "hazards_detected": int(step["hazards"]),
                },
            )
            detail = await self.get_project(project_id)
            spatial = build_spatial_snapshot(
                detail,
                stream_id=self.events.stream_id,
                event_sequence=self.events.current_sequence(project_id),
            )
            await self.events.publish(
                project_id,
                "robots.state.updated",
                {
                    "revision": spatial.revision,
                    "simulationOnly": True,
                    "physicalExecutionEnabled": False,
                    "robots": [
                        robot.model_dump(mode="json", by_alias=True)
                        for robot in spatial.robots
                    ],
                    "floors": [
                        {
                            "id": floor.id,
                            "coverage": floor.coverage,
                            "hazards": [
                                hazard.model_dump(mode="json", by_alias=True)
                                for hazard in floor.hazards
                            ],
                            "rooms": [
                                {"id": room.id, "explored": room.explored}
                                for room in floor.rooms
                            ],
                            "path": [
                                point.model_dump(mode="json", by_alias=True)
                                for point in floor.path
                            ],
                        }
                        for floor in spatial.building.floors
                    ],
                },
            )
            await self.events.publish(
                project_id,
                "mission.updated",
                {
                    "phase": str(step["phase"]).replace("_", " ").title(),
                    "progress": progress,
                    "activeTask": "Mission complete"
                    if progress >= 100
                    else "Autonomous building sweep",
                },
            )

    async def _persist_simulation_step(self, project_id: str, step: dict[str, Any]) -> bool:
        async with self.session_factory() as session:
            project = await self._load_project(session, project_id)
            if project.status == "emergency_stopped" or (
                project.robot_state is not None and project.robot_state.emergency_stopped
            ):
                return False
            progress = float(step["progress"])
            project.progress = progress
            project.status = "simulation_complete" if progress >= 100 else "simulation_running"
            robot = project.robot_state
            if robot is not None:
                pose_x, pose_y, pose_z, yaw = step["pose"]
                robot.pose_x = pose_x
                robot.pose_y = pose_y
                robot.pose_z = pose_z
                robot.yaw = yaw
                robot.velocity = 0.0 if progress >= 100 else 0.42
                robot.battery_percent = float(step["battery"])
                robot.map_coverage_percent = float(step["coverage"])
                robot.hazards_detected = int(step["hazards"])
                robot.mode = "simulation_complete" if progress >= 100 else "simulation"
                robot.connection = "digital_twin_connected"
                robot.last_seen_at = utc_now()
            for task in project.tasks:
                if task.title == "Run safety-qualified simulation":
                    task.progress = progress
                    task.status = "complete" if progress >= 100 else "in_progress"
                elif task.title == "Assemble digital twin":
                    # Persisted spatial fixtures and a running simulation are direct evidence
                    # for this task; unrelated engineering tasks must not inherit mission progress.
                    task.progress = 100.0
                    task.status = "complete"
                elif task.title == "Integrate mapping and perception":
                    coverage = float(step["coverage"])
                    hazards = int(step["hazards"])
                    evidence_complete = progress >= 100 and coverage >= 90 and hazards >= 1
                    task.progress = 100.0 if evidence_complete else min(95.0, coverage)
                    task.status = "complete" if evidence_complete else "in_progress"

            if bool(step.get("checkpoint", False)):
                timestamp = datetime.now(UTC)
                session.add_all(
                    [
                        Telemetry(
                            project_id=project.id,
                            recorded_at=timestamp,
                            metric="battery",
                            value=float(step["battery"]),
                            unit="percent",
                            details={"phase": step["phase"]},
                        ),
                        Telemetry(
                            project_id=project.id,
                            recorded_at=timestamp,
                            metric="map_coverage",
                            value=float(step["coverage"]),
                            unit="percent",
                            details={"phase": step["phase"]},
                        ),
                        Telemetry(
                            project_id=project.id,
                            recorded_at=timestamp,
                            metric="hazards_detected",
                            value=float(step["hazards"]),
                            unit="count",
                            details={
                                "phase": step["phase"],
                                "latest_type": (
                                    "thermal_anomaly" if int(step["hazards"]) > 0 else None
                                ),
                            },
                        ),
                    ]
                )
                action = "simulation.completed" if progress >= 100 else "simulation.progressed"
                await append_audit_entry(
                    session,
                    project_id=project.id,
                    actor="simulation.worker",
                    action=action,
                    entity_type="simulation",
                    entity_id=project.id,
                    details={
                        "phase": step["phase"],
                        "progress": progress,
                        "map_coverage_percent": float(step["coverage"]),
                        "hazards_detected": int(step["hazards"]),
                    },
                    audit_hmac_key=self.settings.audit_hmac_key,
                )
            await session.commit()
        return True

    async def shutdown(self) -> None:
        tasks = [
            *self._simulation_tasks.values(),
            *self._demo_motion_tasks.values(),
            *self._job_tasks.values(),
        ]
        self._simulation_tasks.clear()
        self._demo_motion_tasks.clear()
        self._job_tasks.clear()
        self._job_projects.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        provider = self._engineering_review_provider
        if isinstance(provider, OpenAIEngineeringReviewProvider):
            await provider.close()
