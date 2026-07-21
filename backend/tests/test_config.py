from __future__ import annotations

import pytest
from pydantic import ValidationError

from nexus_api.config import Settings


@pytest.mark.parametrize("environment", ["production", "PROD"])
def test_production_requires_a_unique_audit_signing_key(environment: str) -> None:
    with pytest.raises(ValidationError, match="NEXUS_AUDIT_HMAC_KEY"):
        Settings(environment=environment, audit_hmac_key="short")

    with pytest.raises(ValidationError, match="NEXUS_AUDIT_HMAC_KEY"):
        Settings(
            environment=environment,
            audit_hmac_key="replace-with-at-least-32-random-bytes",
        )

    configured = Settings(environment=environment, audit_hmac_key="x" * 32)
    assert configured.environment == environment


def test_cors_origins_are_normalized_without_credentialed_wildcard_ambiguity() -> None:
    assert Settings().cors_origin_list == [
        "http://localhost:3006",
        "http://127.0.0.1:3006",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    assert Settings(cors_origins="").cors_origin_list == []
    assert Settings(cors_origins="*").cors_origin_list == ["*"]
    assert Settings(
        cors_origins='[" https://one.example ", "https://one.example", "https://two.example"]'
    ).cors_origin_list == ["https://one.example", "https://two.example"]

    with pytest.raises(ValueError, match="wildcard CORS origin"):
        _ = Settings(cors_origins="*,https://trusted.example").cors_origin_list


def test_openai_settings_are_optional_bounded_and_secret_safe() -> None:
    disabled = Settings(openai_api_key=None)
    assert disabled.openai_api_key_value is None
    assert disabled.openai_model == "gpt-5.6"
    assert disabled.openai_timeout_seconds == 30

    configured = Settings(
        openai_api_key="  unit-test-api-key  ",
        openai_model="  gpt-5.6-terra  ",
        openai_timeout_seconds=12,
    )
    assert configured.openai_api_key_value == "unit-test-api-key"
    assert configured.openai_model == "gpt-5.6-terra"
    assert "unit-test-api-key" not in repr(configured)

    with pytest.raises(ValidationError):
        Settings(openai_model="   ")
    with pytest.raises(ValidationError):
        Settings(openai_timeout_seconds=0.5)


def test_robot_link_defaults_to_demo_and_spot_password_stays_secret() -> None:
    assert Settings().robot_adapter == "demo"

    configured = Settings(
        robot_adapter="spot",
        spot_hostname="192.168.80.3",
        spot_username="nexus-demo",
        spot_password="spot-secret",
    )
    assert configured.spot_password_value == "spot-secret"
    assert "spot-secret" not in repr(configured)

    with pytest.raises(ValidationError):
        Settings(robot_adapter="unknown")


def test_continuous_demo_motion_defaults_are_live_and_bounded() -> None:
    settings = Settings()
    assert settings.demo_motion_autostart is True
    assert settings.demo_motion_frame_interval_seconds == 0.25
    assert settings.demo_motion_speed_multiplier == 1.0

    with pytest.raises(ValidationError):
        Settings(demo_motion_frame_interval_seconds=0.05)
    with pytest.raises(ValidationError):
        Settings(demo_motion_frame_interval_seconds=2.1)
    with pytest.raises(ValidationError):
        Settings(demo_motion_speed_multiplier=0)
    with pytest.raises(ValidationError):
        Settings(demo_motion_speed_multiplier=4.1)
