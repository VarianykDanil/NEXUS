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
from nexus_api.models import (
    Approval,
    ArchitectureComponent,
    AuditEntry,
    Project,
    Requirement,
    RobotState,
    Task,
    Telemetry,
    utc_now,
)
from nexus_api.planner import decompose_objective
from nexus_api.schemas import (
    ApprovalRead,
    ArchitectureComponentRead,
    AuditEntryRead,
    AuditVerification,
    EngineeringFindingDomain,
    EngineeringFindingSeverity,
    EngineeringReviewContent,
    EngineeringReviewResponse,
    ProjectDetail,
    ProjectSummary,
    RequirementRead,
    RobotStateRead,
    TaskRead,
    TelemetryRead,
)
from nexus_api.spatial import build_spatial_snapshot

logger = logging.getLogger(__name__)
PROJECT_LOCK_STRIPES = 64


class ProjectNotFoundError(LookupError):
    pass


class ApprovalNotFoundError(LookupError):
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
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.events = events
        self._engineering_review_provider = engineering_review_provider
        self._simulation_tasks: dict[str, asyncio.Task[None]] = {}
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
                project.robot_state.connection = "adapter_denied"
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
            "Human approval is required. The physical adapter remains denied.",
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
            return await self._decide_approval_unlocked(
                approval_id,
                decision,
                decided_by=decided_by,
                comment=comment,
                expected_project_id=expected_project_id,
            )

    async def _decide_approval_unlocked(
        self,
        approval_id: str,
        decision: str,
        *,
        decided_by: str,
        comment: str | None,
        expected_project_id: str | None = None,
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
                    project.robot_state.connection = "adapter_denied"
                    project.robot_state.mode = "physical_ready_safe"
                    project.robot_state.velocity = 0.0
                    project.robot_state.last_seen_at = utc_now()
                for task in project.tasks:
                    if task.requires_approval:
                        task.status = "ready"
                message = (
                    "Approval recorded. Project is ready for a future hardware adapter, "
                    "but this MVP sent no physical command."
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

    async def emergency_stop(
        self, project_id: str, *, actor: str = "dashboard.operator"
    ) -> ProjectDetail:
        async with self._lock_for_project(project_id):
            return await self._emergency_stop_unlocked(project_id, actor=actor)

    async def _emergency_stop_unlocked(
        self, project_id: str, *, actor: str = "dashboard.operator"
    ) -> ProjectDetail:
        await self._cancel_simulation(project_id)
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
        tasks = list(self._simulation_tasks.values())
        self._simulation_tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        provider = self._engineering_review_provider
        if isinstance(provider, OpenAIEngineeringReviewProvider):
            await provider.close()
