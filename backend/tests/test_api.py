from __future__ import annotations

import time
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from nexus_api.config import Settings
from nexus_api.main import create_app
from nexus_api.schemas import EventEnvelope


def test_health_ready_project_crud_and_dashboard(
    client: TestClient, project: dict[str, object]
) -> None:
    health = client.get("/api/v1/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert client.get("/api/v1/ready").json() == {"status": "ready", "database": "ready"}

    projects = client.get("/api/v1/projects")
    assert projects.status_code == 200
    assert projects.json()[0]["id"] == project["id"]

    detail = client.get(f"/api/v1/projects/{project['id']}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["status"] == "planned"
    assert len(body["requirements"]) >= 6
    assert len(body["architecture_components"]) == 6
    assert any(task["requires_approval"] for task in body["tasks"])
    assert body["physical_execution_enabled"] is False

    dashboard = client.get(f"/api/v1/projects/{project['id']}/dashboard")
    assert dashboard.status_code == 200
    assert {
        "project",
        "system",
        "mission",
        "robot",
        "map",
        "telemetry",
        "pipeline",
        "requirements",
        "architecture",
        "approvals",
        "audit",
    } <= dashboard.json().keys()
    requirements = {item["title"]: item for item in dashboard.json()["requirements"]}
    assert requirements["Traceable decisions"]["status"] == "verified"
    assert requirements["Fail-safe operation"]["status"] == "unverified"


def test_physical_launch_is_approval_gated_and_demo_link_is_read_only(
    client: TestClient, project: dict[str, object]
) -> None:
    project_id = str(project["id"])
    launch = client.post(
        f"/api/v1/projects/{project_id}/launch",
        json={"mode": "physical", "requested_by": "safety.agent"},
    )
    assert launch.status_code == 202
    launch_body = launch.json()
    assert launch_body["hardware_command_sent"] is False
    assert launch_body["project"]["status"] == "awaiting_approval"
    assert launch_body["project"]["robot_state"]["connection"] == "demo_available"
    assert launch_body["approval"]["status"] == "pending"

    approval_id = launch_body["approval"]["id"]
    decision = client.post(
        f"/api/v1/approvals/{approval_id}/decision",
        json={
            "decision": "approved",
            "decided_by": "human.operator",
            "comment": "Simulation evidence reviewed.",
        },
    )
    assert decision.status_code == 200
    decision_body = decision.json()
    assert decision_body["hardware_command_sent"] is False
    assert decision_body["project"]["status"] == "physical_ready"
    assert decision_body["project"]["physical_execution_enabled"] is False
    assert decision_body["project"]["robot_state"]["connection"] == "demo_connected"

    spatial = client.get(f"/api/v1/projects/{project_id}/spatial")
    assert spatial.status_code == 200
    assert {robot["connection"] for robot in spatial.json()["robots"]} == {
        "virtual_twin_paused"
    }

    repeated = client.post(
        f"/api/v1/approvals/{approval_id}/decision",
        json={"decision": "approved", "decided_by": "human.operator"},
    )
    assert repeated.status_code == 409


def test_demo_robot_link_connects_and_serves_changing_camera_frames(
    client: TestClient, project: dict[str, object]
) -> None:
    project_id = str(project["id"])
    initial = client.get(f"/api/v1/projects/{project_id}/robot-link")
    assert initial.status_code == 200
    assert initial.json()["adapter"] == "demo"
    assert initial.json()["configured"] is True
    assert initial.json()["read_only"] is True

    connected = client.post(f"/api/v1/projects/{project_id}/robot-link/connect")
    assert connected.status_code == 200
    body = connected.json()
    assert body["hardware_command_sent"] is False
    assert body["status"]["connected"] is True
    assert len(body["status"]["camera_sources"]) == 3

    source = body["status"]["camera_sources"][0]["name"]
    frame = client.get(
        f"/api/v1/projects/{project_id}/robot-link/cameras/{source}/frame"
    )
    assert frame.status_code == 200
    assert frame.headers["content-type"].startswith("image/svg+xml")
    assert frame.headers["cache-control"] == "no-store, max-age=0"
    assert b"NEXUS ROBOT LINK" in frame.content


def test_demo_motion_can_be_started_streamed_and_stopped_without_hardware(
    client: TestClient, project: dict[str, object]
) -> None:
    project_id = str(project["id"])
    status_url = f"/api/v1/projects/{project_id}/demo-motion"

    initial = client.get(status_url)
    assert initial.status_code == 200
    assert initial.json() == {
        "enabled": True,
        "running": False,
        "simulation_only": True,
        "frame_interval_seconds": 0.25,
        "speed_multiplier": 1.0,
        "message": "Virtual fleet motion is stopped.",
        "hardware_command_sent": False,
    }

    with client.websocket_connect(f"/ws/projects/{project_id}") as websocket:
        assert websocket.receive_json()["type"] == "dashboard.snapshot"
        started = client.post(
            f"{status_url}/start",
            json={"requested_by": "demo.test"},
        )
        assert started.status_code == 200
        assert started.json()["running"] is True
        assert started.json()["simulation_only"] is True
        assert started.json()["hardware_command_sent"] is False

        motion_event = None
        for _ in range(8):
            event = websocket.receive_json()
            if event["type"] == "robots.state.updated":
                motion_event = event
                break
        assert motion_event is not None
        robots = motion_event["payload"]["robots"]
        assert len(robots) == 3
        assert all(robot["connection"] == "virtual_demo_stream_live" for robot in robots)
        assert all(robot["speed"] > 0 for robot in robots)
        assert motion_event["payload"]["physicalExecutionEnabled"] is False

        stopped = client.post(
            f"{status_url}/stop",
            json={"requested_by": "demo.test"},
        )
        assert stopped.status_code == 200
        assert stopped.json()["running"] is False
        assert stopped.json()["hardware_command_sent"] is False

    assert client.get(status_url).json()["running"] is False


def test_text_and_map_jobs_use_memory_build_a_pipeline_and_complete_in_simulation(
    client: TestClient, project: dict[str, object]
) -> None:
    project_id = str(project["id"])

    memories = client.get(f"/api/v1/projects/{project_id}/robot-memory")
    assert memories.status_code == 200
    assert {memory["kind"] for memory in memories.json()} == {"location", "procedure"}
    assert any(memory["label"].startswith("Electrical Plant") for memory in memories.json())

    planned = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        json={
            "instruction": "Inspect the Electrical Plant for heat and capture evidence",
            "execution_mode": "simulation",
        },
    )
    assert planned.status_code == 201
    job = planned.json()
    assert job["status"] == "planned"
    assert job["assigned_robot_name"] == "Hazard Surveyor 02"
    assert job["target_room_label"] == "Electrical Plant"
    assert job["memory_context"]["matched_memory_keys"] == [
        "location:ground:g-plant",
        "procedure:hazard",
    ]
    assert len(job["steps"]) == 6
    assert {step["status"] for step in job["steps"]} == {"queued"}

    started = client.post(
        f"/api/v1/projects/{project_id}/jobs/{job['id']}/execute"
    )
    assert started.status_code == 202
    assert started.json()["hardware_command_sent"] is False

    for _ in range(100):
        listed = client.get(f"/api/v1/projects/{project_id}/jobs").json()
        current = next(item for item in listed if item["id"] == job["id"])
        if current["status"] == "completed":
            break
        time.sleep(0.01)
    assert current["status"] == "completed"
    assert current["progress"] == 100
    assert {step["status"] for step in current["steps"]} == {"completed"}
    assert current["result"]["hardware_command_sent"] is False

    updated_memory = client.get(f"/api/v1/projects/{project_id}/robot-memory").json()
    assert any(memory["key"] == f"experience:{job['id']}" for memory in updated_memory)

    map_job = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        json={
            "instruction": "Scan this selected area and update the map",
            "target": {"floor_id": "ground", "x": 2.0, "y": 2.0},
        },
    )
    assert map_job.status_code == 201
    assert map_job.json()["memory_context"]["target_resolution"] == (
        "operator_map_selection"
    )
    assert map_job.json()["target_room_label"] == "Reception Lobby"


def test_physical_job_can_be_planned_but_not_executed_without_certified_adapter(
    client: TestClient, project: dict[str, object]
) -> None:
    project_id = str(project["id"])
    planned = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        json={
            "instruction": "Patrol the Reception Lobby and report any obstruction",
            "execution_mode": "physical",
        },
    )
    assert planned.status_code == 201

    response = client.post(
        f"/api/v1/projects/{project_id}/jobs/{planned.json()['id']}/execute"
    )
    assert response.status_code == 409
    assert "certified command adapter" in response.json()["detail"]


def test_dashboard_mode_and_project_scoped_approval_aliases(
    client: TestClient, project: dict[str, object]
) -> None:
    project_id = str(project["id"])
    mode = client.post(
        f"/api/v1/projects/{project_id}/mode",
        json={"mode": "PHYSICAL"},
    )
    assert mode.status_code == 202
    approval_id = mode.json()["approval"]["id"]

    decision = client.post(
        f"/api/v1/projects/{project_id}/approvals/{approval_id}/decision",
        json={"decision": "rejected", "reason": "Need another simulation."},
    )
    assert decision.status_code == 200
    assert decision.json()["approval"]["decided_by"] == "operator"
    assert decision.json()["project"]["status"] == "approval_rejected"


def test_emergency_stop_latches_and_blocks_relaunch(
    client: TestClient, project: dict[str, object]
) -> None:
    project_id = str(project["id"])
    launch = client.post(
        f"/api/v1/projects/{project_id}/launch",
        json={"mode": "simulation"},
    )
    assert launch.status_code == 202

    stop = client.post(f"/api/v1/projects/{project_id}/emergency-stop")
    assert stop.status_code == 200
    stopped = stop.json()["project"]
    assert stopped["status"] == "emergency_stopped"
    assert stopped["robot_state"]["emergency_stopped"] is True
    assert stopped["robot_state"]["velocity"] == 0
    assert stop.json()["hardware_command_sent"] is False

    blocked = client.post(
        f"/api/v1/projects/{project_id}/launch",
        json={"mode": "simulation"},
    )
    assert blocked.status_code == 409


def test_emergency_stop_cannot_be_overridden_by_an_older_approval(
    client: TestClient, project: dict[str, object]
) -> None:
    project_id = str(project["id"])
    launch = client.post(
        f"/api/v1/projects/{project_id}/launch",
        json={"mode": "physical", "requested_by": "safety.agent"},
    )
    approval_id = launch.json()["approval"]["id"]
    assert client.post(f"/api/v1/projects/{project_id}/emergency-stop").status_code == 200

    decision = client.post(
        f"/api/v1/approvals/{approval_id}/decision",
        json={"decision": "approved", "decided_by": "human.operator"},
    )
    assert decision.status_code == 409
    detail = client.get(f"/api/v1/projects/{project_id}").json()
    assert detail["status"] == "emergency_stopped"
    assert detail["robot_state"]["emergency_stopped"] is True


def test_simulation_updates_telemetry_audit_and_websocket(
    client: TestClient, project: dict[str, object]
) -> None:
    project_id = str(project["id"])
    with client.websocket_connect(f"/ws/projects/{project_id}") as websocket:
        snapshot = websocket.receive_json()
        assert snapshot["type"] == "dashboard.snapshot"
        assert snapshot["data"]["dashboard"]["project"]["id"] == project_id
        response = client.post(
            f"/api/v1/projects/{project_id}/launch",
            json={"mode": "simulation", "requested_by": "test.operator"},
        )
        assert response.status_code == 202
        started = websocket.receive_json()
        assert started["type"] == "simulation.started"
        assert started["payload"]["status"] == "simulation_running"
    deadline = time.monotonic() + 2
    detail: dict[str, object] = {}
    while time.monotonic() < deadline:
        detail = client.get(f"/api/v1/projects/{project_id}").json()
        if detail["status"] == "simulation_complete":
            break
        time.sleep(0.01)
    assert detail["status"] == "simulation_complete"
    assert detail["progress"] == 100
    assert detail["robot_state"]["map_coverage_percent"] == 96
    assert detail["robot_state"]["hazards_detected"] == 3

    tasks = {task["title"]: task for task in detail["tasks"]}
    assert tasks["Assemble digital twin"]["status"] == "complete"
    assert tasks["Integrate mapping and perception"]["status"] == "complete"
    assert tasks["Run safety-qualified simulation"]["status"] == "complete"
    assert tasks["Prepare physical deployment"]["status"] == "pending"

    dashboard = client.get(f"/api/v1/projects/{project_id}/dashboard").json()
    requirements = {item["title"]: item for item in dashboard["requirements"]}
    assert requirements["Metric 3D environment map"]["status"] == "verified"
    assert requirements["Hazard detection and geolocation"]["status"] == "verified"
    assert requirements["Fail-safe operation"]["status"] == "in-progress"

    telemetry = client.get(f"/api/v1/projects/{project_id}/telemetry").json()
    assert len(telemetry) == 12
    audit = client.get(f"/api/v1/projects/{project_id}/audit").json()
    assert audit[0]["action"] == "simulation.completed"
    verification = client.get(f"/api/v1/projects/{project_id}/audit/verify").json()
    assert verification["valid"] is True
    assert verification["entries_checked"] >= 6


def test_websocket_rejects_untrusted_browser_origin(
    client: TestClient, project: dict[str, object]
) -> None:
    with pytest.raises(WebSocketDisconnect) as denied:
        with client.websocket_connect(
            f"/ws/projects/{project['id']}",
            headers={"origin": "https://untrusted.example"},
        ):
            pass
    assert denied.value.code == 4403


def test_demo_is_seeded_only_for_an_empty_database(tmp_path: Path) -> None:
    settings = Settings(
        database_url=f"sqlite+aiosqlite:///{(tmp_path / 'seed.db').as_posix()}",
        seed_demo=True,
        simulation_step_delay_seconds=0,
    )
    app = create_app(settings)
    with TestClient(app) as client:
        projects = client.get("/api/v1/projects").json()
        assert len(projects) == 1
        assert projects[0]["name"] == "Sentinel Mapper - Building Hazard Reconnaissance"
        detail = client.get(f"/api/v1/projects/{projects[0]['id']}").json()
        assert detail["robot_state"]["connection"] == "digital_twin_ready"
        assert len(detail["recent_telemetry"]) == 3


def test_unknown_resources_return_404(client: TestClient) -> None:
    assert client.get("/api/v1/projects/missing").status_code == 404
    assert client.get("/api/v1/projects/missing/audit/verify").status_code == 404


def test_request_text_is_trimmed_and_blank_or_nul_input_is_rejected(
    client: TestClient, project: dict[str, object]
) -> None:
    blank = client.post(
        "/api/v1/projects",
        json={"name": "   ", "objective": "                         "},
    )
    assert blank.status_code == 422

    nul = client.post(
        "/api/v1/projects",
        json={
            "name": "Valid project",
            "objective": "Map the building safely\u0000 and report every hazard.",
        },
    )
    assert nul.status_code == 422

    created = client.post(
        "/api/v1/projects",
        json={
            "name": "  Trimmed project  ",
            "objective": "  Explore every accessible room and map all hazards safely.  ",
        },
    )
    assert created.status_code == 201
    assert created.json()["name"] == "Trimmed project"
    assert created.json()["objective"] == (
        "Explore every accessible room and map all hazards safely."
    )

    blank_actor = client.post(
        f"/api/v1/projects/{project['id']}/launch",
        json={"mode": "physical", "requested_by": "  "},
    )
    assert blank_actor.status_code == 422


def test_fresh_stream_snapshot_sequence_zero_matches_event_contract() -> None:
    now = datetime.now(UTC)
    envelope = EventEnvelope(
        stream_id="fresh-stream",
        sequence=0,
        type="dashboard.snapshot",
        project_id="project-1",
        emitted_at=now,
        timestamp=now,
        data={"dashboard": {}},
    )
    assert envelope.sequence == 0


def test_project_lock_pool_is_bounded(app) -> None:
    service = app.state.service

    locks = {id(service._lock_for_project(f"missing-{index}")) for index in range(10_000)}

    assert len(service._project_locks) == 64
    assert len(locks) <= 64


def test_simulation_worker_failure_is_persisted_and_stops_the_robot(
    client: TestClient,
    project: dict[str, object],
    app,
    monkeypatch,
) -> None:
    project_id = str(project["id"])

    async def fail_step(_project_id: str, _step: dict[str, object]) -> bool:
        raise RuntimeError("injected simulation failure")

    monkeypatch.setattr(app.state.service, "_persist_simulation_step", fail_step)
    launch = client.post(
        f"/api/v1/projects/{project_id}/launch",
        json={"mode": "simulation", "requested_by": "test.operator"},
    )
    assert launch.status_code == 202

    deadline = time.monotonic() + 2
    detail: dict[str, object] = {}
    while time.monotonic() < deadline:
        detail = client.get(f"/api/v1/projects/{project_id}").json()
        if detail["status"] == "failed":
            break
        time.sleep(0.01)

    assert detail["status"] == "failed"
    robot = detail["robot_state"]
    assert isinstance(robot, dict)
    assert robot["velocity"] == 0
    assert robot["connection"] == "digital_twin_error"
    dashboard = client.get(f"/api/v1/projects/{project_id}/dashboard").json()
    assert dashboard["system"]["connection"] == "offline"
    audit = client.get(f"/api/v1/projects/{project_id}/audit").json()
    assert audit[0]["action"] == "simulation.failed"
    assert audit[0]["details"] == {
        "error_type": "RuntimeError",
        "hardware_command_sent": False,
    }
