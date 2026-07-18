from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import cache
from typing import Literal

from nexus_api.schemas import (
    ProjectDetail,
    SpatialBuildingRead,
    SpatialConnectorRead,
    SpatialDoorRead,
    SpatialFloorRead,
    SpatialHazardRead,
    SpatialRobotPoseRead,
    SpatialRobotRead,
    SpatialRoomRead,
    SpatialSnapshotRead,
    SpatialTrailPointRead,
    SpatialWallRead,
)

BUILDING_WIDTH_M = 24.0
BUILDING_DEPTH_M = 16.0
FLOOR_HEIGHT_M = 3.4
FLOOR_IDS = ("ground", "level-1", "level-2")
DoorOrientation = Literal["horizontal", "vertical"]
HazardSeverity = Literal["low", "medium", "high"]
RobotStatus = Literal["nominal", "warning", "critical", "offline"]


@dataclass(frozen=True)
class RoomSpec:
    id: str
    label: str
    kind: str
    x: float
    y: float
    width: float
    depth: float


@dataclass(frozen=True)
class WallSpec:
    id: str
    x1: float
    y1: float
    x2: float
    y2: float


@dataclass(frozen=True)
class DoorSpec:
    id: str
    x: float
    y: float
    width: float
    orientation: DoorOrientation


@dataclass(frozen=True)
class RoutePoint:
    floor_id: str
    x: float
    y: float
    yaw_degrees: float


@dataclass(frozen=True)
class ConnectorSpec:
    id_suffix: str
    kind: Literal["stairs", "elevator"]
    x: float
    y: float
    width: float
    depth: float


@dataclass(frozen=True)
class RouteAudit:
    valid: bool
    wall_crossings: int
    door_transitions: int
    minimum_clearance: float
    segment_count: int


OUTER_WALLS = (
    WallSpec("north-shell", 0.0, 0.0, BUILDING_WIDTH_M, 0.0),
    WallSpec("east-shell", BUILDING_WIDTH_M, 0.0, BUILDING_WIDTH_M, BUILDING_DEPTH_M),
    WallSpec(
        "south-shell",
        BUILDING_WIDTH_M,
        BUILDING_DEPTH_M,
        0.0,
        BUILDING_DEPTH_M,
    ),
    WallSpec("west-shell", 0.0, BUILDING_DEPTH_M, 0.0, 0.0),
)

FLOOR_ROOMS: dict[str, tuple[RoomSpec, ...]] = {
    "ground": (
        RoomSpec("g-lobby", "Reception Lobby", "lobby", 0.3, 0.3, 7.5, 5.7),
        RoomSpec("g-security", "Security Control", "control", 8.2, 0.3, 7.6, 5.7),
        RoomSpec("g-plant", "Electrical Plant", "utility", 16.2, 0.3, 7.5, 5.7),
        RoomSpec("g-office", "West Office", "office", 0.3, 6.6, 7.5, 9.1),
        RoomSpec("g-atrium", "Central Atrium", "circulation", 8.2, 6.6, 7.6, 9.1),
        RoomSpec("g-corridor", "East Corridor", "corridor", 16.2, 6.6, 7.5, 3.4),
        RoomSpec("g-storage", "Response Storage", "storage", 16.2, 10.4, 7.5, 5.3),
    ),
    "level-1": (
        RoomSpec("l1-meeting", "Briefing Room", "meeting", 0.3, 0.3, 7.5, 5.7),
        RoomSpec("l1-open", "Open Workspace", "office", 8.2, 0.3, 15.5, 5.7),
        RoomSpec("l1-office", "West Offices", "office", 0.3, 6.6, 7.5, 9.1),
        RoomSpec("l1-core", "Lift and Stair Core", "circulation", 8.2, 6.6, 7.6, 9.1),
        RoomSpec("l1-lab", "Sensor Laboratory", "laboratory", 16.2, 6.6, 7.5, 5.4),
        RoomSpec("l1-store", "Equipment Store", "storage", 16.2, 12.4, 7.5, 3.3),
    ),
    "level-2": (
        RoomSpec("l2-command", "Incident Command", "control", 0.3, 0.3, 9.5, 5.7),
        RoomSpec("l2-comms", "Communications", "technical", 10.2, 0.3, 6.6, 5.7),
        RoomSpec("l2-mechanical", "Mechanical", "utility", 17.2, 0.3, 6.5, 5.7),
        RoomSpec("l2-analysis", "Hazard Analysis", "laboratory", 0.3, 6.6, 9.5, 9.1),
        RoomSpec("l2-core", "Vertical Core", "circulation", 10.2, 6.6, 6.6, 9.1),
        RoomSpec("l2-training", "Training Suite", "training", 17.2, 6.6, 6.5, 9.1),
    ),
}

FLOOR_WALLS: dict[str, tuple[WallSpec, ...]] = {
    "ground": OUTER_WALLS
    + (
        WallSpec("g-west-divider", 8.0, 0.0, 8.0, 16.0),
        WallSpec("g-east-divider", 16.0, 0.0, 16.0, 16.0),
        WallSpec("g-north-cross", 0.0, 6.3, 24.0, 6.3),
        WallSpec("g-east-store", 16.0, 10.2, 24.0, 10.2),
    ),
    "level-1": OUTER_WALLS
    + (
        WallSpec("l1-west-divider", 8.0, 0.0, 8.0, 16.0),
        WallSpec("l1-east-divider", 16.0, 6.3, 16.0, 16.0),
        WallSpec("l1-north-cross", 0.0, 6.3, 24.0, 6.3),
        WallSpec("l1-store-divider", 16.0, 12.2, 24.0, 12.2),
    ),
    "level-2": OUTER_WALLS
    + (
        WallSpec("l2-west-divider", 10.0, 0.0, 10.0, 16.0),
        WallSpec("l2-east-divider", 17.0, 0.0, 17.0, 16.0),
        WallSpec("l2-north-cross", 0.0, 6.3, 24.0, 6.3),
    ),
}

FLOOR_DOORS: dict[str, tuple[DoorSpec, ...]] = {
    "ground": (
        DoorSpec("g-main-entry", 3.4, 0.0, 1.8, "horizontal"),
        DoorSpec("g-security-door", 8.0, 3.4, 1.1, "vertical"),
        DoorSpec("g-plant-door", 16.0, 3.5, 1.1, "vertical"),
        DoorSpec("g-office-door", 5.4, 6.3, 1.1, "horizontal"),
        DoorSpec("g-atrium-north-door", 12.0, 6.3, 1.2, "horizontal"),
        DoorSpec("g-corridor-north-door", 20.0, 6.3, 1.2, "horizontal"),
        DoorSpec("g-atrium-west-door", 8.0, 10.0, 1.2, "vertical"),
        DoorSpec("g-corridor-west-door", 16.0, 8.2, 1.2, "vertical"),
        DoorSpec("g-store-door", 19.8, 10.2, 1.2, "horizontal"),
    ),
    "level-1": (
        DoorSpec("l1-meeting-door", 5.4, 6.3, 1.1, "horizontal"),
        DoorSpec("l1-core-door", 12.0, 6.3, 1.2, "horizontal"),
        DoorSpec("l1-office-door", 8.0, 10.0, 1.1, "vertical"),
        DoorSpec("l1-lab-door", 16.0, 9.2, 1.1, "vertical"),
        DoorSpec("l1-store-door", 19.8, 12.2, 1.1, "horizontal"),
    ),
    "level-2": (
        DoorSpec("l2-command-door", 5.8, 6.3, 1.2, "horizontal"),
        DoorSpec("l2-comms-door", 10.0, 3.2, 1.0, "vertical"),
        DoorSpec("l2-mechanical-door", 17.0, 3.2, 1.0, "vertical"),
        DoorSpec("l2-core-door", 13.5, 6.3, 1.2, "horizontal"),
        DoorSpec("l2-analysis-door", 10.0, 11.0, 1.1, "vertical"),
        DoorSpec("l2-training-door", 17.0, 11.0, 1.1, "vertical"),
    ),
}

CONNECTOR_SPECS = (
    ConnectorSpec("main-stair", "stairs", 10.3, 12.4, 2.3, 3.0),
    ConnectorSpec("lift", "elevator", 13.3, 12.7, 1.8, 2.1),
)

ROBOT_CLEARANCE_M = 0.18
DOOR_APPROACH_M = 0.45
NAVIGATION_EPSILON = 1e-7
ROUTE_PROGRESS_THRESHOLDS = (
    12.0,
    20.0,
    29.0,
    37.0,
    45.0,
    54.0,
    63.0,
    71.0,
    79.0,
    87.0,
    94.0,
    100.0,
)

ROBOT_ROUTES: tuple[tuple[RoutePoint, ...], ...] = (
    (
        RoutePoint("ground", 1.4, 0.8, 20.0),
        RoutePoint("ground", 4.8, 2.2, 66.0),
        RoutePoint("ground", 7.4, 5.4, 90.0),
        RoutePoint("ground", 11.0, 8.4, 42.0),
        RoutePoint("level-1", 11.1, 13.2, 90.0),
        RoutePoint("level-1", 8.3, 10.5, 180.0),
        RoutePoint("level-1", 4.8, 12.2, 205.0),
        RoutePoint("level-1", 14.0, 8.0, 16.0),
        RoutePoint("level-2", 14.2, 13.2, 90.0),
        RoutePoint("level-2", 18.0, 11.2, 330.0),
        RoutePoint("level-2", 21.0, 7.8, 275.0),
        RoutePoint("ground", 0.4, 0.35, 177.6),
    ),
    (
        RoutePoint("ground", 20.8, 13.8, 180.0),
        RoutePoint("ground", 18.3, 12.0, 215.0),
        RoutePoint("ground", 18.4, 8.2, 270.0),
        RoutePoint("ground", 20.0, 4.0, 300.0),
        RoutePoint("ground", 14.3, 3.0, 180.0),
        RoutePoint("level-1", 14.1, 13.1, 90.0),
        RoutePoint("level-1", 18.2, 9.8, 320.0),
        RoutePoint("level-1", 21.1, 14.2, 75.0),
        RoutePoint("level-2", 14.0, 13.0, 90.0),
        RoutePoint("level-2", 5.2, 11.8, 180.0),
        RoutePoint("level-2", 4.0, 3.4, 270.0),
        RoutePoint("level-2", 8.1, 2.0, 8.0),
    ),
    (
        RoutePoint("ground", 10.2, 14.0, 0.0),
        RoutePoint("ground", 13.8, 14.0, 0.0),
        RoutePoint("level-1", 14.2, 13.4, 90.0),
        RoutePoint("level-1", 11.5, 8.4, 230.0),
        RoutePoint("level-1", 11.0, 3.1, 270.0),
        RoutePoint("level-1", 18.2, 3.1, 0.0),
        RoutePoint("level-2", 14.2, 13.4, 90.0),
        RoutePoint("level-2", 20.4, 12.1, 350.0),
        RoutePoint("level-2", 20.5, 8.2, 270.0),
        RoutePoint("level-2", 14.2, 7.8, 180.0),
        RoutePoint("level-2", 12.0, 3.1, 270.0),
        RoutePoint("level-2", 14.0, 1.8, 20.0),
    ),
)

Point2D = tuple[float, float]


def _wall_is_horizontal(wall: WallSpec) -> bool:
    return abs(wall.y1 - wall.y2) <= NAVIGATION_EPSILON


def _wall_is_vertical(wall: WallSpec) -> bool:
    return abs(wall.x1 - wall.x2) <= NAVIGATION_EPSILON


def _door_intervals_on_wall(floor_id: str, wall: WallSpec) -> tuple[tuple[float, float], ...]:
    if _wall_is_horizontal(wall):
        wall_axis = wall.y1
        lower, upper = sorted((wall.x1, wall.x2))
        intervals = [
            (max(lower, door.x - door.width / 2), min(upper, door.x + door.width / 2))
            for door in FLOOR_DOORS[floor_id]
            if door.orientation == "horizontal"
            and abs(door.y - wall_axis) <= NAVIGATION_EPSILON
            and lower - NAVIGATION_EPSILON <= door.x <= upper + NAVIGATION_EPSILON
        ]
    elif _wall_is_vertical(wall):
        wall_axis = wall.x1
        lower, upper = sorted((wall.y1, wall.y2))
        intervals = [
            (max(lower, door.y - door.width / 2), min(upper, door.y + door.width / 2))
            for door in FLOOR_DOORS[floor_id]
            if door.orientation == "vertical"
            and abs(door.x - wall_axis) <= NAVIGATION_EPSILON
            and lower - NAVIGATION_EPSILON <= door.y <= upper + NAVIGATION_EPSILON
        ]
    else:
        raise ValueError(f"Navigation wall {wall.id!r} must be axis aligned")

    merged: list[tuple[float, float]] = []
    for start, end in sorted(interval for interval in intervals if interval[1] > interval[0]):
        if merged and start <= merged[-1][1] + NAVIGATION_EPSILON:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return tuple(merged)


@cache
def blocked_wall_segments(floor_id: str) -> tuple[WallSpec, ...]:
    """Return solid wall fragments after subtracting declared door openings."""

    fragments: list[WallSpec] = []
    for wall in FLOOR_WALLS[floor_id]:
        horizontal = _wall_is_horizontal(wall)
        lower, upper = sorted((wall.x1, wall.x2) if horizontal else (wall.y1, wall.y2))
        cursor = lower
        part = 0
        for opening_start, opening_end in _door_intervals_on_wall(floor_id, wall):
            if opening_start > cursor + NAVIGATION_EPSILON:
                if horizontal:
                    fragments.append(
                        WallSpec(f"{wall.id}-solid-{part}", cursor, wall.y1, opening_start, wall.y1)
                    )
                else:
                    fragments.append(
                        WallSpec(f"{wall.id}-solid-{part}", wall.x1, cursor, wall.x1, opening_start)
                    )
                part += 1
            cursor = max(cursor, opening_end)
        if cursor < upper - NAVIGATION_EPSILON:
            if horizontal:
                fragments.append(
                    WallSpec(f"{wall.id}-solid-{part}", cursor, wall.y1, upper, wall.y1)
                )
            else:
                fragments.append(
                    WallSpec(f"{wall.id}-solid-{part}", wall.x1, cursor, wall.x1, upper)
                )
    return tuple(fragments)


def _point_segment_distance(point: Point2D, start: Point2D, end: Point2D) -> float:
    delta_x = end[0] - start[0]
    delta_y = end[1] - start[1]
    length_squared = delta_x * delta_x + delta_y * delta_y
    if length_squared <= NAVIGATION_EPSILON:
        return math.hypot(point[0] - start[0], point[1] - start[1])
    projection = (
        (point[0] - start[0]) * delta_x + (point[1] - start[1]) * delta_y
    ) / length_squared
    projection = max(0.0, min(1.0, projection))
    closest = (start[0] + projection * delta_x, start[1] + projection * delta_y)
    return math.hypot(point[0] - closest[0], point[1] - closest[1])


def _orientation(first: Point2D, second: Point2D, third: Point2D) -> float:
    return (second[0] - first[0]) * (third[1] - first[1]) - (
        second[1] - first[1]
    ) * (third[0] - first[0])


def _on_segment(first: Point2D, point: Point2D, second: Point2D) -> bool:
    return (
        min(first[0], second[0]) - NAVIGATION_EPSILON
        <= point[0]
        <= max(first[0], second[0]) + NAVIGATION_EPSILON
        and min(first[1], second[1]) - NAVIGATION_EPSILON
        <= point[1]
        <= max(first[1], second[1]) + NAVIGATION_EPSILON
    )


def _segments_intersect(
    first_start: Point2D,
    first_end: Point2D,
    second_start: Point2D,
    second_end: Point2D,
) -> bool:
    orientations = (
        _orientation(first_start, first_end, second_start),
        _orientation(first_start, first_end, second_end),
        _orientation(second_start, second_end, first_start),
        _orientation(second_start, second_end, first_end),
    )
    if orientations[0] * orientations[1] < 0 and orientations[2] * orientations[3] < 0:
        return True
    return (
        abs(orientations[0]) <= NAVIGATION_EPSILON
        and _on_segment(first_start, second_start, first_end)
        or abs(orientations[1]) <= NAVIGATION_EPSILON
        and _on_segment(first_start, second_end, first_end)
        or abs(orientations[2]) <= NAVIGATION_EPSILON
        and _on_segment(second_start, first_start, second_end)
        or abs(orientations[3]) <= NAVIGATION_EPSILON
        and _on_segment(second_start, first_end, second_end)
    )


def _segment_distance(
    first_start: Point2D,
    first_end: Point2D,
    second_start: Point2D,
    second_end: Point2D,
) -> float:
    if _segments_intersect(first_start, first_end, second_start, second_end):
        return 0.0
    return min(
        _point_segment_distance(first_start, second_start, second_end),
        _point_segment_distance(first_end, second_start, second_end),
        _point_segment_distance(second_start, first_start, first_end),
        _point_segment_distance(second_end, first_start, first_end),
    )


def _wall_half_thickness(wall: WallSpec) -> float:
    return 0.09 if "shell" in wall.id else 0.06


def _point_is_navigable(floor_id: str, point: Point2D, clearance: float) -> bool:
    if not all(math.isfinite(value) for value in point):
        return False
    if not (
        clearance - NAVIGATION_EPSILON
        <= point[0]
        <= BUILDING_WIDTH_M - clearance + NAVIGATION_EPSILON
        and clearance - NAVIGATION_EPSILON
        <= point[1]
        <= BUILDING_DEPTH_M - clearance + NAVIGATION_EPSILON
    ):
        return False
    return all(
        _point_segment_distance(point, (wall.x1, wall.y1), (wall.x2, wall.y2))
        >= clearance + _wall_half_thickness(wall) - NAVIGATION_EPSILON
        for wall in blocked_wall_segments(floor_id)
    )


def _segment_is_navigable(
    floor_id: str,
    start: Point2D,
    end: Point2D,
    clearance: float,
) -> bool:
    if not _point_is_navigable(floor_id, start, clearance) or not _point_is_navigable(
        floor_id, end, clearance
    ):
        return False
    return all(
        _segment_distance(start, end, (wall.x1, wall.y1), (wall.x2, wall.y2))
        >= clearance + _wall_half_thickness(wall) - NAVIGATION_EPSILON
        for wall in blocked_wall_segments(floor_id)
    )


def nearest_navigable_point(
    floor_id: str,
    point: Point2D,
    clearance: float = ROBOT_CLEARANCE_M,
) -> Point2D:
    """Project stale or unsafe telemetry to the closest deterministic free-space point."""

    bounded = (
        max(clearance, min(BUILDING_WIDTH_M - clearance, point[0])),
        max(clearance, min(BUILDING_DEPTH_M - clearance, point[1])),
    )
    if _point_is_navigable(floor_id, bounded, clearance):
        return bounded

    step = 0.05
    for radius_index in range(1, 21):
        radius = radius_index * step
        offsets = [index * step for index in range(-radius_index, radius_index + 1)]
        candidates = {
            (bounded[0] + offset, bounded[1] - radius) for offset in offsets
        } | {(bounded[0] + offset, bounded[1] + radius) for offset in offsets}
        candidates |= {
            (bounded[0] - radius, bounded[1] + offset) for offset in offsets
        } | {(bounded[0] + radius, bounded[1] + offset) for offset in offsets}
        navigable = [
            candidate
            for candidate in candidates
            if _point_is_navigable(floor_id, candidate, clearance)
        ]
        if navigable:
            return min(navigable, key=lambda candidate: (math.dist(point, candidate), candidate))

    fallbacks = [
        (room.x + room.width / 2, room.y + room.depth / 2)
        for room in FLOOR_ROOMS[floor_id]
    ] + [_connector_center(connector) for connector in CONNECTOR_SPECS]
    navigable_fallbacks = [
        candidate
        for candidate in fallbacks
        if _point_is_navigable(floor_id, candidate, clearance)
    ]
    if not navigable_fallbacks:
        raise ValueError(f"Floor {floor_id!r} contains no navigable fallback point")
    return min(navigable_fallbacks, key=lambda candidate: (math.dist(point, candidate), candidate))


def _wall_crossing_coordinate(start: Point2D, end: Point2D, wall: WallSpec) -> float | None:
    if _wall_is_horizontal(wall):
        delta = end[1] - start[1]
        if abs(delta) <= NAVIGATION_EPSILON:
            return None
        parameter = (wall.y1 - start[1]) / delta
        if not NAVIGATION_EPSILON < parameter < 1 - NAVIGATION_EPSILON:
            return None
        coordinate = start[0] + parameter * (end[0] - start[0])
        lower, upper = sorted((wall.x1, wall.x2))
    else:
        delta = end[0] - start[0]
        if abs(delta) <= NAVIGATION_EPSILON:
            return None
        parameter = (wall.x1 - start[0]) / delta
        if not NAVIGATION_EPSILON < parameter < 1 - NAVIGATION_EPSILON:
            return None
        coordinate = start[1] + parameter * (end[1] - start[1])
        lower, upper = sorted((wall.y1, wall.y2))
    if lower - NAVIGATION_EPSILON <= coordinate <= upper + NAVIGATION_EPSILON:
        return coordinate
    return None


def audit_floor_route(
    floor_id: str,
    points: Sequence[Point2D],
    clearance: float = ROBOT_CLEARANCE_M,
) -> RouteAudit:
    """Audit a route against wall solids and count legal door crossings."""

    wall_crossings = 0
    door_transitions = 0
    minimum_clearance = math.inf
    for point in points:
        for blocked in blocked_wall_segments(floor_id):
            minimum_clearance = min(
                minimum_clearance,
                _point_segment_distance(point, (blocked.x1, blocked.y1), (blocked.x2, blocked.y2))
                - _wall_half_thickness(blocked),
            )
    for start, end in zip(points, points[1:], strict=False):
        for blocked in blocked_wall_segments(floor_id):
            minimum_clearance = min(
                minimum_clearance,
                _segment_distance(start, end, (blocked.x1, blocked.y1), (blocked.x2, blocked.y2))
                - _wall_half_thickness(blocked),
            )
        for wall in FLOOR_WALLS[floor_id]:
            coordinate = _wall_crossing_coordinate(start, end, wall)
            if coordinate is None:
                continue
            if any(
                opening_start - NAVIGATION_EPSILON <= coordinate <= opening_end + NAVIGATION_EPSILON
                for opening_start, opening_end in _door_intervals_on_wall(floor_id, wall)
            ):
                door_transitions += 1
            else:
                wall_crossings += 1

    points_are_navigable = all(_point_is_navigable(floor_id, point, clearance) for point in points)
    segments_are_navigable = all(
        _segment_is_navigable(floor_id, start, end, clearance)
        for start, end in zip(points, points[1:], strict=False)
    )
    return RouteAudit(
        valid=points_are_navigable and segments_are_navigable and wall_crossings == 0,
        wall_crossings=wall_crossings,
        door_transitions=door_transitions,
        minimum_clearance=minimum_clearance,
        segment_count=max(0, len(points) - 1),
    )


def plan_floor_route(
    floor_id: str,
    start: Point2D,
    end: Point2D,
    clearance: float = ROBOT_CLEARANCE_M,
) -> tuple[Point2D, ...]:
    """Find the deterministic shortest visibility-graph route through door openings."""

    if floor_id not in FLOOR_WALLS:
        raise ValueError(f"Unknown floor {floor_id!r}")
    if not _point_is_navigable(floor_id, start, clearance):
        raise ValueError(f"Route start {start!r} is not navigable on {floor_id}")
    if not _point_is_navigable(floor_id, end, clearance):
        raise ValueError(f"Route end {end!r} is not navigable on {floor_id}")
    if math.dist(start, end) <= NAVIGATION_EPSILON:
        return (start,)

    nodes: list[Point2D] = [start, end]
    seen = {start, end}
    for door in FLOOR_DOORS[floor_id]:
        candidates = (
            ((door.x, door.y - DOOR_APPROACH_M), (door.x, door.y + DOOR_APPROACH_M))
            if door.orientation == "horizontal"
            else ((door.x - DOOR_APPROACH_M, door.y), (door.x + DOOR_APPROACH_M, door.y))
        )
        for candidate in candidates:
            if candidate not in seen and _point_is_navigable(floor_id, candidate, clearance):
                nodes.append(candidate)
                seen.add(candidate)

    distances = [math.inf] * len(nodes)
    previous: list[int | None] = [None] * len(nodes)
    distances[0] = 0.0
    remaining = set(range(len(nodes)))
    while remaining:
        current = min(remaining, key=lambda index: (distances[index], index))
        remaining.remove(current)
        if not math.isfinite(distances[current]) or current == 1:
            break
        for neighbor in sorted(remaining):
            if not _segment_is_navigable(floor_id, nodes[current], nodes[neighbor], clearance):
                continue
            candidate_distance = distances[current] + math.dist(nodes[current], nodes[neighbor])
            if candidate_distance < distances[neighbor] - NAVIGATION_EPSILON:
                distances[neighbor] = candidate_distance
                previous[neighbor] = current

    if not math.isfinite(distances[1]):
        raise ValueError(f"No collision-free route from {start!r} to {end!r} on {floor_id}")
    indices = [1]
    while indices[-1] != 0:
        predecessor = previous[indices[-1]]
        if predecessor is None:
            raise RuntimeError("Visibility graph predecessor chain is incomplete")
        indices.append(predecessor)
    route = tuple(nodes[index] for index in reversed(indices))
    if not audit_floor_route(floor_id, route, clearance).valid:
        raise RuntimeError("Visibility graph returned an invalid route")
    return route


def _connector_center(connector: ConnectorSpec) -> Point2D:
    return (connector.x + connector.width / 2, connector.y + connector.depth / 2)


def is_declared_floor_transition(previous: RoutePoint, current: RoutePoint) -> bool:
    """Return whether a floor change is co-located inside a declared connector."""

    if previous.floor_id == current.floor_id:
        return False
    if math.dist((previous.x, previous.y), (current.x, current.y)) > NAVIGATION_EPSILON:
        return False
    return any(
        connector.x - NAVIGATION_EPSILON
        <= previous.x
        <= connector.x + connector.width + NAVIGATION_EPSILON
        and connector.y - NAVIGATION_EPSILON
        <= previous.y
        <= connector.y + connector.depth + NAVIGATION_EPSILON
        for connector in CONNECTOR_SPECS
    )


def _append_planned_floor_path(
    planned: list[RoutePoint],
    floor_id: str,
    coordinates: Sequence[Point2D],
    final_yaw: float,
) -> None:
    for index, (x, y) in enumerate(coordinates[1:], start=1):
        previous = planned[-1]
        yaw = (
            final_yaw
            if index == len(coordinates) - 1
            else math.degrees(math.atan2(y - previous.y, x - previous.x)) % 360
        )
        planned.append(RoutePoint(floor_id, x, y, yaw))


def plan_robot_route(checkpoints: Sequence[RoutePoint]) -> tuple[RoutePoint, ...]:
    """Expand mission checkpoints into wall-safe paths and connector-safe floor changes."""

    if not checkpoints:
        return ()
    planned = [checkpoints[0]]
    transfer = _connector_center(CONNECTOR_SPECS[0])
    for target in checkpoints[1:]:
        current = planned[-1]
        if current.floor_id != target.floor_id:
            departure = plan_floor_route(current.floor_id, (current.x, current.y), transfer)
            _append_planned_floor_path(planned, current.floor_id, departure, current.yaw_degrees)
            planned.append(
                RoutePoint(target.floor_id, transfer[0], transfer[1], target.yaw_degrees)
            )
            arrival = plan_floor_route(target.floor_id, transfer, (target.x, target.y))
            _append_planned_floor_path(planned, target.floor_id, arrival, target.yaw_degrees)
        else:
            route = plan_floor_route(current.floor_id, (current.x, current.y), (target.x, target.y))
            _append_planned_floor_path(planned, current.floor_id, route, target.yaw_degrees)

    if len(planned) > 120:
        raise ValueError(f"Planned route contains {len(planned)} points; schema permits 120")
    return tuple(planned)


def _clamp_percent(value: float) -> float:
    return round(max(0.0, min(100.0, value)), 1)


def _floor_elevation(floor_id: str) -> float:
    return float(FLOOR_IDS.index(floor_id)) * FLOOR_HEIGHT_M


def floor_id_for_z(z: float) -> str:
    return min(FLOOR_IDS, key=lambda floor_id: abs(_floor_elevation(floor_id) - z))


def _visible_route(route: tuple[RoutePoint, ...], progress: float) -> tuple[RoutePoint, ...]:
    completed = sum(
        threshold <= _clamp_percent(progress) + NAVIGATION_EPSILON
        for threshold in ROUTE_PROGRESS_THRESHOLDS[: len(route)]
    )
    visible = max(1, min(len(route), completed))
    return route[:visible]


def _trail_point(point: RoutePoint) -> SpatialTrailPointRead:
    return SpatialTrailPointRead(
        x=point.x,
        y=point.y,
        z=_floor_elevation(point.floor_id),
        floor_id=point.floor_id,
    )


def _connection_for_virtual_robot(project: ProjectDetail) -> str:
    robot = project.robot_state
    if project.status == "emergency_stopped" or (robot and robot.emergency_stopped):
        return "stopped"
    if project.active_mode == "physical":
        return "adapter_denied"
    if project.status.startswith("simulation"):
        return "digital_twin_connected"
    return "virtual_ready"


def _status_for_virtual_robot(project: ProjectDetail) -> RobotStatus:
    if project.status == "emergency_stopped":
        return "critical"
    if project.status in {"awaiting_approval", "approval_rejected", "failed"}:
        return "warning"
    return "nominal"


def build_robots(project: ProjectDetail) -> list[SpatialRobotRead]:
    """Build three bounded virtual robots while preserving the primary legacy state."""

    legacy = project.robot_state
    connection = _connection_for_virtual_robot(project)
    status = _status_for_virtual_robot(project)
    stopped = connection in {"stopped", "adapter_denied"}
    running = project.status == "simulation_running" and not stopped
    base_battery = legacy.battery_percent if legacy else 100.0
    names = ("Sentinel Scout 01", "Hazard Surveyor 02", "Mapping Relay 03")
    models = ("NEXUS M2", "NEXUS H1", "NEXUS Relay")
    roles = ("lead_scout", "hazard_survey", "mapping_relay")
    missions = (
        "Autonomous building sweep",
        "Hazard verification and egress inspection",
        "Upper-floor mapping and communications relay",
    )
    speeds = (0.42, 0.34, 0.28)
    robots: list[SpatialRobotRead] = []

    for index, route in enumerate(ROBOT_ROUTES):
        visible_checkpoints = list(_visible_route(route, project.progress))
        if index == 0 and legacy is not None:
            floor_id = floor_id_for_z(legacy.pose_z)
            safe_x, safe_y = nearest_navigable_point(
                floor_id,
                (legacy.pose_x, legacy.pose_y),
            )
            legacy_target = RoutePoint(
                floor_id,
                safe_x,
                safe_y,
                round(math.degrees(legacy.yaw), 1),
            )
            if (
                visible_checkpoints[-1].floor_id != floor_id
                or math.dist(
                    (visible_checkpoints[-1].x, visible_checkpoints[-1].y),
                    (safe_x, safe_y),
                )
                > NAVIGATION_EPSILON
            ):
                visible_checkpoints.append(legacy_target)
        planned_route = plan_robot_route(visible_checkpoints)
        current = planned_route[-1]
        trail = [_trail_point(point) for point in planned_route]

        if index == 0 and legacy is not None:
            current_pose = SpatialRobotPoseRead(
                x=safe_x,
                y=safe_y,
                z=legacy.pose_z,
                yaw=round(math.degrees(legacy.yaw), 1),
                floor_id=floor_id,
            )
            trail[-1] = SpatialTrailPointRead(
                x=safe_x,
                y=safe_y,
                z=legacy.pose_z,
                floor_id=floor_id,
            )
            robot_speed = 0.0 if stopped else legacy.velocity
        else:
            current_pose = SpatialRobotPoseRead(
                x=current.x,
                y=current.y,
                z=_floor_elevation(current.floor_id),
                yaw=current.yaw_degrees,
                floor_id=current.floor_id,
            )
            robot_speed = speeds[index] if running else 0.0

        robots.append(
            SpatialRobotRead(
                id=f"rbt-{project.id[:8]}-{index + 1:02d}",
                name=names[index],
                model=models[index],
                role=roles[index],
                status=status,
                connection=connection,
                battery=_clamp_percent(base_battery - index * 4.0),
                speed=max(0.0, robot_speed),
                localization=0.0 if stopped else round(98.6 - index * 1.3, 1),
                mission="Motion inhibited" if stopped else missions[index],
                pose=current_pose,
                trail=trail,
            )
        )
    return robots


def _hazards(project: ProjectDetail) -> list[SpatialHazardRead]:
    legacy = project.robot_state
    detected_count = legacy.hazards_detected if legacy else 0
    specifications: tuple[
        tuple[str, str, HazardSeverity, float, float, float], ...
    ] = (
        ("ground", "Thermal anomaly", "high", 18.6, 3.8, 94.0),
        ("level-1", "Smoke plume", "high", 19.4, 9.2, 91.0),
        ("level-2", "Blocked passage", "medium", 14.8, 7.8, 87.0),
    )
    return [
        SpatialHazardRead(
            id=f"hz-{project.id[:8]}-{index + 1:02d}",
            type=kind,
            severity=severity,
            x=x,
            y=y,
            z=_floor_elevation(floor_id),
            confidence=confidence,
            detected_at=project.updated_at,
        )
        for index, (floor_id, kind, severity, x, y, confidence) in enumerate(
            specifications[:detected_count]
        )
    ]


def _floor_coverage(overall: float, level: int) -> float:
    if level == 0:
        return _clamp_percent(overall * 1.15)
    if level == 1:
        return _clamp_percent((overall - 12.0) * 1.25)
    return _clamp_percent((overall - 42.0) * 1.72)


def build_building(project: ProjectDetail, robots: list[SpatialRobotRead]) -> SpatialBuildingRead:
    overall_coverage = project.robot_state.map_coverage_percent if project.robot_state else 0.0
    hazards = _hazards(project)
    primary_trail = robots[0].trail
    floors: list[SpatialFloorRead] = []
    labels = ("Ground Floor", "Level 1", "Level 2")

    for level, floor_id in enumerate(FLOOR_IDS):
        coverage = _floor_coverage(overall_coverage, level)
        rooms = [
            SpatialRoomRead(
                id=room.id,
                label=room.label,
                kind=room.kind,
                x=room.x,
                y=room.y,
                width=room.width,
                depth=room.depth,
                explored=_clamp_percent(coverage * (1.05 - index * 0.035)),
            )
            for index, room in enumerate(FLOOR_ROOMS[floor_id])
        ]
        walls = [
            SpatialWallRead(
                id=wall.id,
                x1=wall.x1,
                y1=wall.y1,
                x2=wall.x2,
                y2=wall.y2,
                thickness=0.18 if "shell" in wall.id else 0.12,
                height=3.1,
            )
            for wall in FLOOR_WALLS[floor_id]
        ]
        doors = [
            SpatialDoorRead(
                id=door.id,
                x=door.x,
                y=door.y,
                width=door.width,
                orientation=door.orientation,
            )
            for door in FLOOR_DOORS[floor_id]
        ]
        connectors = [
            SpatialConnectorRead(
                id=f"{floor_id}-{connector.id_suffix}",
                kind=connector.kind,
                x=connector.x,
                y=connector.y,
                width=connector.width,
                depth=connector.depth,
                target_floor_ids=list(FLOOR_IDS),
            )
            for connector in CONNECTOR_SPECS
        ]
        floors.append(
            SpatialFloorRead(
                id=floor_id,
                label=labels[level],
                level=level,
                elevation=level * FLOOR_HEIGHT_M,
                height=3.1,
                width=BUILDING_WIDTH_M,
                depth=BUILDING_DEPTH_M,
                coverage=coverage,
                rooms=rooms,
                walls=walls,
                doors=doors,
                connectors=connectors,
                hazards=[hazard for hazard in hazards if floor_id_for_z(hazard.z) == floor_id],
                path=[point for point in primary_trail if point.floor_id == floor_id],
            )
        )

    return SpatialBuildingRead(
        id=f"bld-{project.id[:8]}",
        name=f"{project.name} Digital Twin",
        width=BUILDING_WIDTH_M,
        depth=BUILDING_DEPTH_M,
        floor_height=FLOOR_HEIGHT_M,
        floors=floors,
    )


def build_spatial_snapshot(
    project: ProjectDetail,
    *,
    stream_id: str = "rest-snapshot",
    event_sequence: int = 0,
    generated_at: datetime | None = None,
) -> SpatialSnapshotRead:
    robots = build_robots(project)
    updated_at = project.updated_at
    if updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=UTC)
    revision = max(0, int(updated_at.timestamp() * 1000))
    return SpatialSnapshotRead(
        project_id=project.id,
        generated_at=generated_at or datetime.now(UTC),
        revision=revision,
        stream_id=stream_id,
        event_sequence=event_sequence,
        building=build_building(project, robots),
        robots=robots,
    )
