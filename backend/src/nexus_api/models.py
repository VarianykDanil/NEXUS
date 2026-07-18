from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def new_id() -> str:
    return str(uuid.uuid4())


def utc_now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(160))
    objective: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(40), default="planned", index=True)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    active_mode: Mapped[str | None] = mapped_column(String(24), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    requirements: Mapped[list[Requirement]] = relationship(
        back_populates="project", cascade="all, delete-orphan", lazy="selectin"
    )
    architecture_components: Mapped[list[ArchitectureComponent]] = relationship(
        back_populates="project", cascade="all, delete-orphan", lazy="selectin"
    )
    tasks: Mapped[list[Task]] = relationship(
        back_populates="project", cascade="all, delete-orphan", lazy="selectin"
    )
    approvals: Mapped[list[Approval]] = relationship(
        back_populates="project", cascade="all, delete-orphan", lazy="selectin"
    )
    robot_state: Mapped[RobotState | None] = relationship(
        back_populates="project", cascade="all, delete-orphan", uselist=False, lazy="selectin"
    )
    telemetry: Mapped[list[Telemetry]] = relationship(
        back_populates="project", cascade="all, delete-orphan", lazy="raise"
    )
    audit_entries: Mapped[list[AuditEntry]] = relationship(
        back_populates="project", cascade="all, delete-orphan", lazy="raise"
    )


class Requirement(Base):
    __tablename__ = "requirements"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(180))
    description: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(32))
    priority: Mapped[str] = mapped_column(String(16), default="must")
    acceptance_criteria: Mapped[str] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer)

    project: Mapped[Project] = relationship(back_populates="requirements")


class ArchitectureComponent(Base):
    __tablename__ = "architecture_components"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(32))
    technology: Mapped[str] = mapped_column(String(120))
    responsibility: Mapped[str] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer)

    project: Mapped[Project] = relationship(back_populates="architecture_components")


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(180))
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    risk: Mapped[str] = mapped_column(String(16), default="low")
    requires_approval: Mapped[bool] = mapped_column(Boolean, default=False)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    position: Mapped[int] = mapped_column(Integer)

    project: Mapped[Project] = relationship(back_populates="tasks")


class Approval(Base):
    __tablename__ = "approvals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    action: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    risk: Mapped[str] = mapped_column(String(16), default="critical")
    requested_by: Mapped[str] = mapped_column(String(120), default="system")
    decided_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    project: Mapped[Project] = relationship(back_populates="approvals")


class RobotState(Base):
    __tablename__ = "robot_states"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), unique=True, index=True
    )
    connection: Mapped[str] = mapped_column(String(32), default="virtual_ready")
    mode: Mapped[str] = mapped_column(String(24), default="standby")
    pose_x: Mapped[float] = mapped_column(Float, default=0.0)
    pose_y: Mapped[float] = mapped_column(Float, default=0.0)
    pose_z: Mapped[float] = mapped_column(Float, default=0.0)
    yaw: Mapped[float] = mapped_column(Float, default=0.0)
    velocity: Mapped[float] = mapped_column(Float, default=0.0)
    battery_percent: Mapped[float] = mapped_column(Float, default=100.0)
    map_coverage_percent: Mapped[float] = mapped_column(Float, default=0.0)
    hazards_detected: Mapped[int] = mapped_column(Integer, default=0)
    emergency_stopped: Mapped[bool] = mapped_column(Boolean, default=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    project: Mapped[Project] = relationship(back_populates="robot_state")


class Telemetry(Base):
    __tablename__ = "telemetry"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, index=True
    )
    metric: Mapped[str] = mapped_column(String(80), index=True)
    value: Mapped[float] = mapped_column(Float)
    unit: Mapped[str] = mapped_column(String(24))
    details: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    project: Mapped[Project] = relationship(back_populates="telemetry")


class AuditEntry(Base):
    __tablename__ = "audit_entries"
    __table_args__ = (UniqueConstraint("project_id", "sequence", name="uq_audit_project_seq"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    sequence: Mapped[int] = mapped_column(Integer)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    actor: Mapped[str] = mapped_column(String(120))
    action: Mapped[str] = mapped_column(String(120))
    entity_type: Mapped[str] = mapped_column(String(80))
    entity_id: Mapped[str] = mapped_column(String(36))
    details: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    previous_hash: Mapped[str] = mapped_column(String(64))
    entry_hash: Mapped[str] = mapped_column(String(64), index=True)
    signature: Mapped[str | None] = mapped_column(String(64), nullable=True)

    project: Mapped[Project] = relationship(back_populates="audit_entries")
