from __future__ import annotations

import json
from collections import defaultdict
from typing import Any

from nexus_api.schemas import ProjectDetail
from nexus_api.spatial import build_spatial_snapshot


def _health(project: ProjectDetail) -> str:
    if project.status == "emergency_stopped":
        return "critical"
    if project.status in {"awaiting_approval", "approval_rejected", "failed"}:
        return "warning"
    return "nominal"


def _task_status(status: str) -> str:
    return {
        "complete": "complete",
        "in_progress": "running",
        "running": "running",
        "pending": "queued",
        "ready": "queued",
        "awaiting_approval": "blocked",
        "blocked": "blocked",
        "cancelled": "failed",
        "failed": "failed",
    }.get(status, "queued")


def _task_category(title: str) -> str:
    lowered = title.lower()
    if "physical" in lowered or "deploy" in lowered:
        return "deploy"
    if "simulation" in lowered or "digital twin" in lowered:
        return "simulate"
    if "integrate" in lowered or "code" in lowered:
        return "code"
    if "test" in lowered or "qualif" in lowered:
        return "test"
    return "plan"


def dashboard_projection(project: ProjectDetail, *, audit_valid: bool) -> dict[str, Any]:
    """Project the normalized backend model into the dashboard's stable view model."""

    robot = project.robot_state
    completed_tasks = sum(task.status == "complete" for task in project.tasks)
    active_task = next(
        (
            task.title
            for task in project.tasks
            if task.status in {"in_progress", "running", "awaiting_approval", "ready"}
        ),
        next((task.title for task in project.tasks if task.status == "pending"), "Mission idle"),
    )
    if project.status == "emergency_stopped":
        active_task = "Emergency stop engaged"
    mode = "PHYSICAL" if project.active_mode == "physical" else "SIMULATION"
    connection = "online"
    if robot is None or robot.connection in {"stopped", "digital_twin_error"}:
        connection = "offline"
    elif robot.connection in {"adapter_denied", "virtual_ready"}:
        connection = "degraded"

    telemetry_groups: dict[str, list[float]] = defaultdict(list)
    telemetry_latest: dict[str, Any] = {}
    for reading in reversed(project.recent_telemetry):
        telemetry_groups[reading.metric].append(reading.value)
        telemetry_latest[reading.metric] = reading

    metric_definitions = (
        ("battery", "Battery", robot.battery_percent if robot else 0.0, "%"),
        (
            "map_coverage",
            "Map coverage",
            robot.map_coverage_percent if robot else 0.0,
            "%",
        ),
        (
            "hazards_detected",
            "Hazards",
            float(robot.hazards_detected if robot else 0),
            "count",
        ),
        (
            "air_quality_index",
            "Air quality",
            telemetry_groups.get("air_quality_index", [24.0])[-1],
            "AQI",
        ),
    )
    telemetry = []
    for metric_id, label, fallback_value, fallback_unit in metric_definitions:
        latest = telemetry_latest.get(metric_id)
        value = latest.value if latest else fallback_value
        # Telemetry storage uses canonical names such as ``percent``; cards use
        # compact operator-facing symbols from the projection contract.
        unit = fallback_unit
        status = "nominal"
        if metric_id == "battery" and value < 30:
            status = "critical"
        elif metric_id == "air_quality_index" and value > 100:
            status = "warning"
        telemetry.append(
            {
                "id": metric_id,
                "label": label,
                "value": value,
                "unit": unit,
                "trend": telemetry_groups.get(metric_id, [value]),
                "status": status,
                "detail": latest.details.get("phase", "live digital-twin reading")
                if latest
                else "awaiting sensor samples",
            }
        )

    known_hazards = (
        ("Thermal anomaly", "high", 522, 118, 94),
        ("Smoke plume", "high", 648, 238, 91),
        ("Blocked passage", "medium", 390, 306, 87),
    )
    hazards = [
        {
            "id": f"HZ-{index + 1:02d}",
            "type": hazard[0],
            "severity": hazard[1],
            "x": hazard[2],
            "y": hazard[3],
            "confidence": hazard[4],
            "detectedAt": project.updated_at.isoformat(),
        }
        for index, hazard in enumerate(
            known_hazards[: robot.hazards_detected if robot is not None else 0]
        )
    ]
    path_points = [
        {"x": 98, "y": 118},
        {"x": 182, "y": 118},
        {"x": 280, "y": 118},
        {"x": 368, "y": 120},
        {"x": 366, "y": 226},
        {"x": 420, "y": 246},
        {"x": 515, "y": 238},
        {"x": 578, "y": 238},
    ]
    coverage = robot.map_coverage_percent if robot else 0.0
    visible_points = max(1, min(len(path_points), round(coverage / 100 * len(path_points))))
    spatial = build_spatial_snapshot(project)
    simulation_evidence_complete = (
        project.status in {"simulation_complete", "physical_ready"}
        and project.progress >= 100
    )

    def requirement_status(category: str) -> str:
        if category == "assurance":
            return "verified" if audit_valid and bool(project.recent_audit) else "unverified"
        if category == "mission":
            return "verified" if simulation_evidence_complete and audit_valid else (
                "in-progress" if project.progress > 10 else "unverified"
            )
        if category == "mapping":
            return "verified" if simulation_evidence_complete and coverage >= 90 else (
                "in-progress" if coverage > 0 else "unverified"
            )
        if category == "perception":
            hazards_detected = robot.hazards_detected if robot else 0
            return "verified" if simulation_evidence_complete and hazards_detected > 0 else (
                "in-progress" if project.progress > 10 else "unverified"
            )
        # Safety needs hardware-in-the-loop evidence, navigation needs a recorded
        # collision report, and operations needs a persisted REST/WebSocket
        # reconciliation result. Category names alone are never verification.
        return "in-progress" if project.progress > 10 else "unverified"

    return {
        "project": {
            "id": project.id,
            "name": project.name,
            "objective": project.objective,
            "status": project.status,
            "progress": project.progress,
            "updatedAt": project.updated_at.isoformat(),
        },
        "system": {
            "mode": mode,
            "health": _health(project),
            "connection": connection,
            "safetyLock": True,
            "lastHeartbeat": robot.last_seen_at.isoformat()
            if robot
            else project.updated_at.isoformat(),
        },
        "mission": {
            "id": f"MSN-{project.id[:8].upper()}",
            "name": project.name,
            "phase": project.status.replace("_", " ").title(),
            "activeTask": active_task,
            "progress": project.progress,
            "currentStep": min(len(project.tasks), completed_tasks + 1),
            "totalSteps": len(project.tasks),
            "elapsed": "live",
            "eta": "complete" if project.progress >= 100 else "simulation estimate pending",
        },
        "robot": {
            "id": f"RBT-{project.id[:6].upper()}",
            "name": "Sentinel Scout",
            "model": "NEXUS M2 Digital Twin",
            "pose": {
                "x": robot.pose_x if robot else 0.0,
                "y": robot.pose_y if robot else 0.0,
                "yaw": round((robot.yaw if robot else 0.0) * 57.2958, 1),
            },
            "battery": robot.battery_percent if robot else 0.0,
            "speed": robot.velocity if robot else 0.0,
            "temperature": 43.0,
            "latency": 28.0,
            "localization": 98.6 if robot and robot.connection != "stopped" else 0.0,
            "status": _health(project),
        },
        "map": {
            "coverage": coverage,
            "area": round(coverage * 5.2, 1),
            "floor": "Building digital twin",
            "rooms": [
                {
                    "id": "r1",
                    "label": "LOBBY",
                    "x": 45,
                    "y": 52,
                    "width": 190,
                    "height": 134,
                    "explored": round(min(100, coverage * 1.4), 1),
                },
                {
                    "id": "r2",
                    "label": "LAB 2A",
                    "x": 254,
                    "y": 52,
                    "width": 198,
                    "height": 134,
                    "explored": round(min(100, coverage * 1.2), 1),
                },
                {
                    "id": "r3",
                    "label": "UTILITY",
                    "x": 470,
                    "y": 52,
                    "width": 144,
                    "height": 134,
                    "explored": round(coverage, 1),
                },
                {
                    "id": "r4",
                    "label": "WEST OFFICE",
                    "x": 45,
                    "y": 240,
                    "width": 190,
                    "height": 126,
                    "explored": round(min(100, coverage * 1.1), 1),
                },
                {
                    "id": "r5",
                    "label": "CENTRAL HALL",
                    "x": 254,
                    "y": 204,
                    "width": 198,
                    "height": 162,
                    "explored": round(coverage * 0.9, 1),
                },
                {
                    "id": "r6",
                    "label": "EAST CORRIDOR",
                    "x": 470,
                    "y": 204,
                    "width": 260,
                    "height": 70,
                    "explored": round(coverage * 0.75, 1),
                },
            ],
            "path": path_points[:visible_points],
            "hazards": hazards,
        },
        "building": spatial.building.model_dump(mode="json", by_alias=True),
        "robots": [item.model_dump(mode="json", by_alias=True) for item in spatial.robots],
        "telemetry": telemetry,
        "pipeline": [
            {
                "id": task.id,
                "label": task.title,
                "category": _task_category(task.title),
                "status": _task_status(task.status),
                "detail": f"{task.risk} risk - {task.progress:.0f}% complete",
            }
            for task in project.tasks
        ],
        "requirements": [
            {
                "id": requirement.id,
                "title": requirement.title,
                "source": "User objective" if requirement.category == "mission" else "Derived",
                "component": requirement.category.title(),
                "verification": requirement.acceptance_criteria,
                "status": requirement_status(requirement.category),
            }
            for requirement in project.requirements
        ],
        "architecture": [
            {
                "id": component.id,
                "label": component.name,
                "kind": "interface"
                if component.kind == "human-interface"
                else ("robot" if component.kind == "robot-runtime" else "service"),
                "status": "warning"
                if component.kind == "safety-boundary" and project.pending_approvals
                else "nominal",
            }
            for component in project.architecture_components
        ],
        "approvals": [
            {
                "id": approval.id,
                "title": "Authorize physical launch",
                "description": (
                    "Permit transition to hardware-ready state. The current adapter will still "
                    "deny actuator commands."
                ),
                "risk": "high" if approval.risk in {"high", "critical"} else approval.risk,
                "status": approval.status,
                "requestedBy": approval.requested_by,
                "requestedAt": approval.requested_at.isoformat(),
                "scope": ["This project only", "No hardware commands", "Emergency stop enforced"],
            }
            for approval in project.approvals
        ],
        "audit": [
            {
                "id": entry.id,
                "action": entry.action.replace(".", " ").replace("_", " ").title(),
                "actor": entry.actor,
                "rationale": json.dumps(entry.details, sort_keys=True, default=str),
                "timestamp": entry.recorded_at.isoformat(),
                "hash": entry.entry_hash,
                "previousHash": entry.previous_hash,
                "verified": audit_valid,
            }
            for entry in project.recent_audit
        ],
    }
