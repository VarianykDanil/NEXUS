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


def test_physical_launch_is_approval_gated_and_adapter_denied(
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
    assert launch_body["project"]["robot_state"]["connection"] == "adapter_denied"
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
    assert decision_body["project"]["robot_state"]["connection"] == "adapter_denied"

    repeated = client.post(
        f"/api/v1/approvals/{approval_id}/decision",
        json={"decision": "approved", "decided_by": "human.operator"},
    )
    assert repeated.status_code == 409


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
