from __future__ import annotations

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from nexus_api.models import Base


def normalize_database_url(database_url: str) -> str:
    """Accept common deployment URLs while consistently using async drivers."""

    if database_url.startswith("postgres://"):
        return database_url.replace("postgres://", "postgresql+asyncpg://", 1)
    if database_url.startswith("postgresql://"):
        return database_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if database_url.startswith("sqlite://") and not database_url.startswith("sqlite+aiosqlite://"):
        return database_url.replace("sqlite://", "sqlite+aiosqlite://", 1)
    return database_url


def create_database(
    database_url: str,
) -> tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
    normalized_url = normalize_database_url(database_url)
    connect_args: dict[str, object] = {}
    if normalized_url.startswith("sqlite+"):
        connect_args["timeout"] = 30
    engine = create_async_engine(
        normalized_url,
        pool_pre_ping=True,
        connect_args=connect_args,
    )
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def initialize_database(engine: AsyncEngine) -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
