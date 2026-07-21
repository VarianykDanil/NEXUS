from __future__ import annotations

import math
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from nexus_api.events import EventBroker
from nexus_api.schemas import ProjectDetail
from nexus_api.spatial import (
    FLOOR_IDS,
    ROBOT_CLEARANCE_M,
    ROBOT_ROUTES,
    RoutePoint,
    audit_floor_route,
    build_demo_motion_robots,
    demo_motion_routes,
    is_declared_floor_transition,
    plan_robot_route,
)


def _assert_finite_numbers(value: object) -> None:
    if isinstance(value, float):
        assert math.isfinite(value)
    elif isinstance(value, dict):
        for item in value.values():
            _assert_finite_numbers(item)
    elif isinstance(value, list):
        for item in value:
            _assert_finite_numbers(item)


def test_spatial_endpoint_returns_bounded_canonical_building_and_robots(
    client: TestClient, project: dict[str, object]
) -> None:
    project_id = str(project["id"])
    response = client.get(f"/api/v1/projects/{project_id}/spatial")

    assert response.status_code == 200
    body = response.json()
    assert body["schemaVersion"] == "1.0"
    assert body["projectId"] == project_id
    assert body["simulationOnly"] is True
    assert body["physicalExecutionEnabled"] is False
    assert body["streamId"]
    assert body["eventSequence"] >= 1

    building = body["building"]
    assert building == {
        **building,
        "width": 24.0,
        "depth": 16.0,
        "floorHeight": 3.4,
        "frame": "building_enu",
    }
    floors = building["floors"]
    assert [floor["id"] for floor in floors] == ["ground", "level-1", "level-2"]
    assert [floor["elevation"] for floor in floors] == [0.0, 3.4, 6.8]
    assert len(floors) == 3

    for floor in floors:
        assert floor["width"] == building["width"]
        assert floor["depth"] == building["depth"]
        assert 0 <= floor["coverage"] <= 100
        assert 1 <= len(floor["rooms"]) <= 100
        assert floor["walls"]
        assert floor["doors"]
        assert {connector["kind"] for connector in floor["connectors"]} == {
            "stairs",
            "elevator",
        }
        for room in floor["rooms"]:
            assert 0 <= room["x"] < building["width"]
            assert 0 <= room["y"] < building["depth"]
            assert room["x"] + room["width"] <= building["width"]
            assert room["y"] + room["depth"] <= building["depth"]
            assert 0 <= room["explored"] <= 100
        for wall in floor["walls"]:
            assert 0 <= wall["x1"] <= building["width"]
            assert 0 <= wall["x2"] <= building["width"]
            assert 0 <= wall["y1"] <= building["depth"]
            assert 0 <= wall["y2"] <= building["depth"]
        for connector in floor["connectors"]:
            assert connector["targetFloorIds"] == ["ground", "level-1", "level-2"]
        assert all(point["floorId"] == floor["id"] for point in floor["path"])
        path_audit = audit_floor_route(
            floor["id"],
            [(point["x"], point["y"]) for point in floor["path"]],
        )
        assert path_audit.valid
        assert path_audit.wall_crossings == 0
        assert path_audit.minimum_clearance >= ROBOT_CLEARANCE_M - 1e-6

    robots = body["robots"]
    assert len(robots) == 3
    assert len({robot["id"] for robot in robots}) == 3
    assert {robot["role"] for robot in robots} == {
        "lead_scout",
        "hazard_survey",
        "mapping_relay",
    }
    for robot in robots:
        assert robot["pose"]["floorId"] in {"ground", "level-1", "level-2"}
        assert 0 <= robot["pose"]["x"] <= building["width"]
        assert 0 <= robot["pose"]["y"] <= building["depth"]
        assert len(robot["trail"]) <= 120
        assert 0 <= robot["battery"] <= 100
        assert robot["speed"] >= 0
        for floor_id in FLOOR_IDS:
            floor_trail = [
                (point["x"], point["y"])
                for point in robot["trail"]
                if point["floorId"] == floor_id
            ]
            if not floor_trail:
                continue
            trail_audit = audit_floor_route(floor_id, floor_trail)
            assert trail_audit.valid
            assert trail_audit.wall_crossings == 0
            assert trail_audit.minimum_clearance >= ROBOT_CLEARANCE_M - 1e-6

        route_points = [
            RoutePoint(
                point["floorId"],
                point["x"],
                point["y"],
                0.0,
            )
            for point in robot["trail"]
        ]
        for previous, current in zip(route_points, route_points[1:], strict=False):
            if previous.floor_id != current.floor_id:
                assert is_declared_floor_transition(previous, current)

    _assert_finite_numbers(body)


def test_every_complete_robot_route_uses_doors_and_declared_vertical_connectors() -> None:
    for checkpoints in ROBOT_ROUTES:
        planned = plan_robot_route(checkpoints)
        assert len(planned) <= 120

        for floor_id in FLOOR_IDS:
            points = [(point.x, point.y) for point in planned if point.floor_id == floor_id]
            if not points:
                continue
            audit = audit_floor_route(floor_id, points)
            assert audit.valid
            assert audit.wall_crossings == 0
            assert audit.minimum_clearance >= ROBOT_CLEARANCE_M - 1e-6

        for previous, current in zip(planned, planned[1:], strict=False):
            if previous.floor_id != current.floor_id:
                assert is_declared_floor_transition(previous, current)


def test_continuous_demo_fleet_moves_on_closed_collision_checked_routes(
    client: TestClient, project: dict[str, object]
) -> None:
    detail = ProjectDetail.model_validate(
        client.get(f"/api/v1/projects/{project['id']}").json()
    )
    initial = build_demo_motion_robots(detail, 0.0)
    advanced = build_demo_motion_robots(detail, 1.0)

    assert len(initial) == len(advanced) == 3
    assert all(robot.connection == "virtual_demo_stream_live" for robot in advanced)
    assert all(robot.status == "nominal" for robot in advanced)
    assert all(robot.speed > 0 for robot in advanced)
    assert all(1 <= len(robot.trail) <= 17 for robot in advanced)
    assert all(
        first.pose.model_dump() != second.pose.model_dump()
        for first, second in zip(initial, advanced, strict=True)
    )

    for route in demo_motion_routes():
        assert route[0].floor_id == route[-1].floor_id
        assert (route[0].x, route[0].y) == (route[-1].x, route[-1].y)
        for floor_id in FLOOR_IDS:
            floor_points = [
                (point.x, point.y) for point in route if point.floor_id == floor_id
            ]
            if floor_points:
                assert audit_floor_route(floor_id, floor_points).valid
        for previous, current in zip(route, route[1:], strict=False):
            if previous.floor_id != current.floor_id:
                assert is_declared_floor_transition(previous, current)


def test_dashboard_adds_spatial_scene_without_changing_legacy_projection(
    client: TestClient, project: dict[str, object]
) -> None:
    body = client.get(f"/api/v1/projects/{project['id']}/dashboard").json()

    assert len(body["building"]["floors"]) == 3
    assert len(body["robots"]) == 3
    assert body["robot"]["id"].startswith("RBT-")
    assert body["robot"]["pose"].keys() == {"x", "y", "yaw"}
    assert body["map"]["rooms"][0]["x"] == 45
    assert body["map"]["path"][0] == {"x": 98, "y": 118}
    assert body["system"]["safetyLock"] is True


def test_floor_aware_simulation_emits_legacy_and_full_robot_state_events(
    client: TestClient, project: dict[str, object]
) -> None:
    project_id = str(project["id"])
    sequences: list[int] = []
    seen_floors: set[str] = set()
    robot_batches = 0
    completed = False
    final_batch_after_completion = False

    with client.websocket_connect(f"/ws/projects/{project_id}") as websocket:
        snapshot = websocket.receive_json()
        assert snapshot["type"] == "dashboard.snapshot"
        assert snapshot["data"] == snapshot["payload"]
        assert snapshot["emitted_at"] == snapshot["timestamp"]
        stream_id = snapshot["stream_id"]
        sequences.append(snapshot["sequence"])

        response = client.post(
            f"/api/v1/projects/{project_id}/launch",
            json={"mode": "simulation", "requested_by": "spatial.test"},
        )
        assert response.status_code == 202

        for _ in range(50):
            event = websocket.receive_json()
            assert event["schema_version"] == "1.0"
            assert event["stream_id"] == stream_id
            assert event["emitted_at"] == event["timestamp"]
            assert event["data"] == event["payload"]
            sequences.append(event["sequence"])

            if event["type"].startswith("simulation.") and "pose" in event["payload"]:
                pose = event["payload"]["pose"]
                assert {"x", "y", "z", "yaw", "floorId"} <= pose.keys()
                seen_floors.add(pose["floorId"])
                completed = event["type"] == "simulation.completed" or completed
            elif event["type"] == "robots.state.updated":
                robots = event["payload"]["robots"]
                floors = event["payload"]["floors"]
                assert len(robots) == 3
                assert [floor["id"] for floor in floors] == ["ground", "level-1", "level-2"]
                assert all(
                    {"coverage", "hazards", "rooms", "path"} <= floor.keys()
                    for floor in floors
                )
                assert all(
                    {"id", "explored"} <= room.keys()
                    for floor in floors
                    for room in floor["rooms"]
                )
                assert all("floorId" in robot["pose"] for robot in robots)
                assert all(len(robot["trail"]) <= 120 for robot in robots)
                assert event["payload"]["physicalExecutionEnabled"] is False
                robot_batches += 1
                if completed:
                    final_batch_after_completion = True
                    break

    assert seen_floors == {"ground", "level-1", "level-2"}
    assert robot_batches == 12
    assert completed is True
    assert final_batch_after_completion is True
    assert all(
        current > previous
        for previous, current in zip(sequences, sequences[1:], strict=False)
    )

    spatial = client.get(f"/api/v1/projects/{project_id}/spatial").json()
    assert spatial["robots"][0]["pose"]["floorId"] == "ground"
    assert sum(len(floor["hazards"]) for floor in spatial["building"]["floors"]) == 3


def test_emergency_stop_stops_every_projected_robot(
    client: TestClient, project: dict[str, object]
) -> None:
    project_id = str(project["id"])
    assert client.post(
        f"/api/v1/projects/{project_id}/launch", json={"mode": "simulation"}
    ).status_code == 202
    assert client.post(f"/api/v1/projects/{project_id}/emergency-stop").status_code == 200

    body = client.get(f"/api/v1/projects/{project_id}/spatial").json()
    assert body["physicalExecutionEnabled"] is False
    assert all(robot["status"] == "critical" for robot in body["robots"])
    assert all(robot["connection"] == "stopped" for robot in body["robots"])
    assert all(robot["speed"] == 0 for robot in body["robots"])
    assert all(robot["mission"] == "Motion inhibited" for robot in body["robots"])


@pytest.mark.asyncio
async def test_event_broker_sequences_make_bounded_queue_gaps_detectable() -> None:
    broker = EventBroker(queue_size=2)
    async with broker.subscribe("project-1") as subscription:
        await broker.publish("project-1", "event.one", {"value": 1})
        await broker.publish("project-1", "event.two", {"value": 2})
        await broker.publish("project-1", "event.three", {"value": 3})

        first = await subscription.queue.get()
        second = await subscription.queue.get()

    assert subscription.start_sequence == 0
    assert first.sequence == 2
    assert second.sequence == 3
    assert first.stream_id == second.stream_id == broker.stream_id
    assert first.timestamp == first.emitted_at
    assert broker.current_sequence("project-1") == 3
    assert broker.current_sequence("another-project") == 0


def test_websocket_subscription_replays_event_emitted_during_snapshot(
    client: TestClient,
    app: Any,
    project: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id = str(project["id"])
    service = app.state.service
    original_get_project = service.get_project
    calls = 0

    async def get_project_with_race(candidate_id: str):
        nonlocal calls
        calls += 1
        if calls == 2:
            await app.state.events.publish(
                candidate_id,
                "test.snapshot_race",
                {"authoritative": True},
            )
        return await original_get_project(candidate_id)

    monkeypatch.setattr(service, "get_project", get_project_with_race)
    with client.websocket_connect(f"/ws/projects/{project_id}") as websocket:
        snapshot = websocket.receive_json()
        raced = websocket.receive_json()

    assert snapshot["type"] == "dashboard.snapshot"
    assert raced["type"] == "test.snapshot_race"
    assert raced["sequence"] > snapshot["sequence"]
    assert raced["payload"] == {"authoritative": True}


def test_unknown_spatial_project_and_websocket_are_rejected(client: TestClient) -> None:
    assert client.get("/api/v1/projects/missing/spatial").status_code == 404
    with pytest.raises(WebSocketDisconnect) as disconnected:
        with client.websocket_connect("/ws/projects/missing"):
            pass
    assert disconnected.value.code == 4404
