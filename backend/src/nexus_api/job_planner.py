from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

from nexus_api.schemas import RobotJobTargetRequest, SpatialSnapshotRead
from nexus_api.spatial import RoutePoint, nearest_navigable_point, plan_robot_route


@dataclass(frozen=True)
class PlannedRobotJob:
    assigned_robot_id: str
    assigned_robot_name: str
    target_floor_id: str
    target_room_id: str | None
    target_room_label: str | None
    target_x: float
    target_y: float
    risk: str
    memory_context: dict[str, Any]
    steps: list[dict[str, Any]]


PROCEDURES: dict[str, dict[str, Any]] = {
    "inspect": {
        "label": "Visual inspection and evidence capture",
        "keywords": ("inspect", "check", "look", "camera", "verify"),
        "capability": "visual_inspection",
        "risk": "medium",
        "action": "Inspect the target from a bounded observation pose and capture evidence.",
    },
    "hazard": {
        "label": "Hazard standoff assessment",
        "keywords": ("hazard", "smoke", "fire", "gas", "heat", "danger", "leak"),
        "capability": "hazard_survey",
        "risk": "high",
        "action": "Observe from a safe standoff, classify the anomaly, and preserve egress.",
    },
    "map": {
        "label": "Map and coverage update",
        "keywords": ("map", "scan", "survey", "coverage", "reconstruct"),
        "capability": "mapping",
        "risk": "medium",
        "action": "Scan the selected area, update spatial memory, and measure coverage change.",
    },
    "patrol": {
        "label": "Bounded patrol",
        "keywords": ("patrol", "monitor", "watch", "round"),
        "capability": "patrol",
        "risk": "medium",
        "action": "Survey the target and adjacent accessible space, recording anomalies.",
    },
    "deliver": {
        "label": "Payload delivery rehearsal",
        "keywords": ("deliver", "bring", "carry", "take", "transport"),
        "capability": "payload_delivery",
        "risk": "high",
        "action": "Rehearse the bounded delivery and verify the hand-off location.",
    },
    "return": {
        "label": "Return and dock",
        "keywords": ("return", "dock", "charge", "home"),
        "capability": "return_to_base",
        "risk": "low",
        "action": "Return to the remembered base location and verify a stopped state.",
    },
}


def procedure_memory_records() -> list[dict[str, Any]]:
    return [
        {
            "key": f"procedure:{key}",
            "kind": "procedure",
            "label": value["label"],
            "content": {
                "capability": value["capability"],
                "keywords": list(value["keywords"]),
                "action": value["action"],
                "safety": "Simulation first; physical execution requires an approved edge adapter.",
            },
            "confidence": 0.95,
            "source": "nexus-procedure-library-v1",
        }
        for key, value in PROCEDURES.items()
    ]


def location_memory_records(spatial: SpatialSnapshotRead) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for floor in spatial.building.floors:
        for room in floor.rooms:
            records.append(
                {
                    "key": f"location:{floor.id}:{room.id}",
                    "kind": "location",
                    "label": f"{room.label} · {floor.label}",
                    "content": {
                        "floor_id": floor.id,
                        "floor_label": floor.label,
                        "room_id": room.id,
                        "room_label": room.label,
                        "kind": room.kind,
                        "center": {
                            "x": round(room.x + room.width / 2, 3),
                            "y": round(room.y + room.depth / 2, 3),
                        },
                        "bounds": {
                            "x": room.x,
                            "y": room.y,
                            "width": room.width,
                            "depth": room.depth,
                        },
                    },
                    "confidence": max(0.5, min(1.0, room.explored / 100)),
                    "source": "digital-twin-spatial-memory-v1",
                }
            )
    return records


def _normalize(value: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value.lower()).split())


def _select_procedure(instruction: str) -> tuple[str, dict[str, Any]]:
    normalized = _normalize(instruction)
    for key in ("hazard", "deliver", "return", "map", "patrol", "inspect"):
        procedure = PROCEDURES[key]
        if any(keyword in normalized for keyword in procedure["keywords"]):
            return key, procedure
    return "inspect", PROCEDURES["inspect"]


def _find_room_from_text(
    spatial: SpatialSnapshotRead, instruction: str
) -> tuple[Any, Any] | None:
    normalized = _normalize(instruction)
    candidates: list[tuple[int, Any, Any]] = []
    for floor in spatial.building.floors:
        for room in floor.rooms:
            room_name = _normalize(room.label)
            if room_name and room_name in normalized:
                candidates.append((len(room_name), floor, room))
                continue
            significant = [word for word in room_name.split() if len(word) >= 5]
            if significant and all(word in normalized for word in significant):
                candidates.append((sum(map(len, significant)), floor, room))
    if not candidates:
        return None
    _, floor, room = max(candidates, key=lambda item: (item[0], -item[1].level))
    return floor, room


def _room_at_point(floor: Any, x: float, y: float) -> Any | None:
    return next(
        (
            room
            for room in floor.rooms
            if room.x <= x <= room.x + room.width and room.y <= y <= room.y + room.depth
        ),
        None,
    )


def _resolve_target(
    spatial: SpatialSnapshotRead,
    instruction: str,
    requested: RobotJobTargetRequest | None,
) -> tuple[Any, Any | None, float, float, str]:
    if requested is not None:
        floor = next(
            (item for item in spatial.building.floors if item.id == requested.floor_id), None
        )
        if floor is None:
            raise ValueError(f"Unknown floor {requested.floor_id!r}")
        if requested.x > floor.width or requested.y > floor.depth:
            raise ValueError("Selected target is outside the mapped floor")
        safe_x, safe_y = nearest_navigable_point(floor.id, (requested.x, requested.y))
        room = _room_at_point(floor, requested.x, requested.y) or _room_at_point(
            floor, safe_x, safe_y
        )
        return floor, room, safe_x, safe_y, "operator_map_selection"

    matched = _find_room_from_text(spatial, instruction)
    if matched is not None:
        floor, room = matched
        center = (room.x + room.width / 2, room.y + room.depth / 2)
        safe_x, safe_y = nearest_navigable_point(floor.id, center)
        return floor, room, safe_x, safe_y, "room_name_memory_match"

    primary = spatial.robots[0]
    floor = next(
        item for item in spatial.building.floors if item.id == primary.pose.floor_id
    )
    room = next(
        (item for item in floor.rooms if "atrium" in item.label.lower()),
        floor.rooms[0],
    )
    center = (room.x + room.width / 2, room.y + room.depth / 2)
    safe_x, safe_y = nearest_navigable_point(floor.id, center)
    return floor, room, safe_x, safe_y, "default_spatial_memory"


def _assign_robot(
    spatial: SpatialSnapshotRead,
    procedure_key: str,
    floor_id: str,
    x: float,
    y: float,
) -> Any:
    preferred_role = {
        "hazard": "hazard_survey",
        "map": "mapping_relay",
        "patrol": "lead_scout",
        "deliver": "lead_scout",
        "return": "lead_scout",
        "inspect": "lead_scout",
    }[procedure_key]
    preferred = [robot for robot in spatial.robots if robot.role == preferred_role]
    candidates = preferred or list(spatial.robots)
    return min(
        candidates,
        key=lambda robot: (
            0 if robot.pose.floor_id == floor_id else 1,
            math.dist((robot.pose.x, robot.pose.y), (x, y)),
            robot.id,
        ),
    )


def plan_robot_job(
    spatial: SpatialSnapshotRead,
    instruction: str,
    requested_target: RobotJobTargetRequest | None,
) -> PlannedRobotJob:
    procedure_key, procedure = _select_procedure(instruction)
    floor, room, target_x, target_y, resolution = _resolve_target(
        spatial, instruction, requested_target
    )
    robot = _assign_robot(spatial, procedure_key, floor.id, target_x, target_y)
    start_x, start_y = nearest_navigable_point(
        robot.pose.floor_id, (robot.pose.x, robot.pose.y)
    )
    route = plan_robot_route(
        (
            RoutePoint(robot.pose.floor_id, start_x, start_y, robot.pose.yaw),
            RoutePoint(floor.id, target_x, target_y, 0.0),
        )
    )
    route_distance = sum(
        math.dist((start.x, start.y), (end.x, end.y))
        for start, end in zip(route, route[1:], strict=False)
    )
    known_hazards = len(floor.hazards)
    room_label = room.label if room is not None else None
    location_key = f"location:{floor.id}:{room.id}" if room is not None else None
    memory_context = {
        "planner": "nexus-memory-job-planner-v1",
        "map_frame": spatial.building.frame,
        "map_revision": spatial.revision,
        "target_resolution": resolution,
        "matched_memory_keys": [
            key for key in (location_key, f"procedure:{procedure_key}") if key is not None
        ],
        "procedure": procedure["label"],
        "known_hazards_on_floor": known_hazards,
        "route_distance_metres": round(route_distance, 2),
        "route": [
            {
                "floor_id": point.floor_id,
                "x": round(point.x, 3),
                "y": round(point.y, 3),
                "yaw": round(point.yaw_degrees, 2),
            }
            for point in route
        ],
        "why_this_robot": (
            f"{robot.name} matched the {procedure['capability']} capability and "
            "had the best deterministic assignment score."
        ),
    }
    target_name = room_label or f"X {target_x:.1f}, Y {target_y:.1f}"
    steps = [
        {
            "id": "understand",
            "title": "Understand operator intent",
            "detail": f'Bound the requested job: "{instruction.strip()}"',
            "status": "queued",
            "capability": "intent_validation",
            "evidence": None,
        },
        {
            "id": "recall",
            "title": "Recall map and procedure memory",
            "detail": (
                f"Matched {target_name} on {floor.label} with {procedure['label'].lower()}."
            ),
            "status": "queued",
            "capability": "memory_retrieval",
            "evidence": None,
        },
        {
            "id": "safety",
            "title": "Validate target and route",
            "detail": (
                f"Check a {route_distance:.1f} m wall-safe route, robot state, hazards, "
                "and stop conditions."
            ),
            "status": "queued",
            "capability": "safety_validation",
            "evidence": None,
        },
        {
            "id": "navigate",
            "title": f"Navigate to {target_name}",
            "detail": f"Follow {len(route)} verified route points in {spatial.building.frame}.",
            "status": "queued",
            "capability": "autonomous_navigation",
            "evidence": None,
        },
        {
            "id": "perform",
            "title": procedure["label"],
            "detail": procedure["action"],
            "status": "queued",
            "capability": procedure["capability"],
            "evidence": None,
        },
        {
            "id": "report",
            "title": "Record evidence and update memory",
            "detail": "Store the outcome, target, route summary, and observations for reuse.",
            "status": "queued",
            "capability": "evidence_and_memory",
            "evidence": None,
        },
    ]
    return PlannedRobotJob(
        assigned_robot_id=robot.id,
        assigned_robot_name=robot.name,
        target_floor_id=floor.id,
        target_room_id=room.id if room is not None else None,
        target_room_label=room_label,
        target_x=target_x,
        target_y=target_y,
        risk=procedure["risk"],
        memory_context=memory_context,
        steps=steps,
    )
