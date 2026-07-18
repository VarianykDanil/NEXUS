from __future__ import annotations

from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nexus_api.config import Settings
from nexus_api.main import create_app


@pytest.fixture
def app(tmp_path: Path):
    database_path = (tmp_path / "test.db").as_posix()
    settings = Settings(
        database_url=f"sqlite+aiosqlite:///{database_path}",
        environment="test",
        seed_demo=False,
        openai_api_key=None,
        audit_hmac_key="test-audit-key",
        simulation_step_delay_seconds=0.005,
        cors_origins="http://localhost:3000",
    )
    return create_app(settings)


@pytest.fixture
def client(app) -> Generator[TestClient, None, None]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def project(client: TestClient) -> dict[str, object]:
    response = client.post(
        "/api/v1/projects",
        json={
            "name": "Responder Scout",
            "objective": (
                "Explore an unknown office building, detect smoke and heat hazards, "
                "and create a reliable 3D map."
            ),
        },
    )
    assert response.status_code == 201
    return response.json()
