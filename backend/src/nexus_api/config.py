from __future__ import annotations

import json
from functools import lru_cache

from pydantic import AliasChoices, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings shared by local, container, and test environments."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    database_url: str = Field(
        default="sqlite+aiosqlite:///./nexus.db",
        validation_alias=AliasChoices("DATABASE_URL", "NEXUS_DATABASE_URL"),
    )
    environment: str = Field(default="development", validation_alias="NEXUS_ENVIRONMENT")
    log_level: str = Field(default="INFO", validation_alias="NEXUS_LOG_LEVEL")
    cors_origins: str = Field(
        default=(
            "http://localhost:3000,http://127.0.0.1:3000,"
            "http://localhost:5173,http://127.0.0.1:5173"
        ),
        validation_alias="NEXUS_CORS_ORIGINS",
    )
    audit_hmac_key: str = Field(default="", validation_alias="NEXUS_AUDIT_HMAC_KEY")
    require_action_approval: bool = Field(
        default=True, validation_alias="NEXUS_REQUIRE_ACTION_APPROVAL"
    )
    simulation_only: bool = Field(default=True, validation_alias="NEXUS_SIMULATION_ONLY")
    seed_demo: bool = Field(default=True, validation_alias="NEXUS_SEED_DEMO")
    simulation_step_delay_seconds: float = Field(
        default=0.2,
        ge=0,
        le=30,
        validation_alias="NEXUS_SIMULATION_STEP_DELAY_SECONDS",
    )
    openai_api_key: SecretStr | None = Field(default=None, validation_alias="OPENAI_API_KEY")
    openai_model: str = Field(
        default="gpt-5.6",
        min_length=1,
        max_length=100,
        validation_alias="NEXUS_OPENAI_MODEL",
    )
    openai_timeout_seconds: float = Field(
        default=30.0,
        ge=1,
        le=120,
        validation_alias="NEXUS_OPENAI_TIMEOUT_SECONDS",
    )

    @field_validator("openai_model", mode="after")
    @classmethod
    def normalize_openai_model(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("NEXUS_OPENAI_MODEL must not be blank")
        return value

    @model_validator(mode="after")
    def require_signed_audit_in_production(self) -> Settings:
        """Fail closed rather than advertise unsigned audit proof in production."""

        if self.environment.strip().lower() in {"prod", "production"}:
            key = self.audit_hmac_key.encode("utf-8")
            if len(key) < 32 or self.audit_hmac_key.startswith("replace-with-"):
                raise ValueError(
                    "NEXUS_AUDIT_HMAC_KEY must be a unique secret of at least 32 bytes "
                    "in production"
                )
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        value = self.cors_origins.strip()
        if not value:
            return []
        if value == "*":
            return ["*"]
        if value.startswith("["):
            parsed = json.loads(value)
            if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
                raise ValueError("NEXUS_CORS_ORIGINS must be a JSON string list")
            origins = [origin.strip() for origin in parsed if origin.strip()]
        else:
            origins = [origin.strip() for origin in value.split(",") if origin.strip()]
        if "*" in origins:
            raise ValueError("A wildcard CORS origin cannot be combined with explicit origins")
        return list(dict.fromkeys(origins))

    @property
    def openai_api_key_value(self) -> str | None:
        if self.openai_api_key is None:
            return None
        value = self.openai_api_key.get_secret_value().strip()
        return value or None


@lru_cache
def get_settings() -> Settings:
    return Settings()
