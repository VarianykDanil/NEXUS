from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from nexus_api.models import AuditEntry
from nexus_api.schemas import AuditVerification

GENESIS_HASH = "0" * 64


class AuditRecord(Protocol):
    sequence: int
    recorded_at: datetime
    actor: str
    action: str
    entity_type: str
    entity_id: str
    details: dict[str, Any]
    previous_hash: str
    entry_hash: str
    signature: str | None


def canonical_timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    value = value.astimezone(UTC)
    return value.isoformat(timespec="microseconds").replace("+00:00", "Z")


def compute_entry_hash(
    *,
    sequence: int,
    recorded_at: datetime,
    actor: str,
    action: str,
    entity_type: str,
    entity_id: str,
    details: dict[str, Any],
    previous_hash: str,
) -> str:
    canonical = json.dumps(
        {
            "action": action,
            "actor": actor,
            "details": details,
            "entity_id": entity_id,
            "entity_type": entity_type,
            "previous_hash": previous_hash,
            "recorded_at": canonical_timestamp(recorded_at),
            "sequence": sequence,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def compute_signature(entry_hash: str, audit_hmac_key: str) -> str | None:
    if not audit_hmac_key:
        return None
    return hmac.new(
        audit_hmac_key.encode("utf-8"), entry_hash.encode("ascii"), hashlib.sha256
    ).hexdigest()


async def append_audit_entry(
    session: AsyncSession,
    *,
    project_id: str,
    actor: str,
    action: str,
    entity_type: str,
    entity_id: str,
    details: dict[str, Any],
    audit_hmac_key: str,
) -> AuditEntry:
    latest = (
        await session.scalars(
            select(AuditEntry)
            .where(AuditEntry.project_id == project_id)
            .order_by(AuditEntry.sequence.desc())
            .limit(1)
        )
    ).first()
    sequence = 1 if latest is None else latest.sequence + 1
    previous_hash = GENESIS_HASH if latest is None else latest.entry_hash
    recorded_at = datetime.now(UTC)
    entry_hash = compute_entry_hash(
        sequence=sequence,
        recorded_at=recorded_at,
        actor=actor,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        details=details,
        previous_hash=previous_hash,
    )
    entry = AuditEntry(
        project_id=project_id,
        sequence=sequence,
        recorded_at=recorded_at,
        actor=actor,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        details=details,
        previous_hash=previous_hash,
        entry_hash=entry_hash,
        signature=compute_signature(entry_hash, audit_hmac_key),
    )
    session.add(entry)
    await session.flush()
    return entry


def verify_audit_records(
    entries: Sequence[AuditRecord], audit_hmac_key: str = ""
) -> AuditVerification:
    expected_previous = GENESIS_HASH
    for expected_sequence, entry in enumerate(entries, start=1):
        if entry.sequence != expected_sequence:
            return AuditVerification(
                valid=False,
                entries_checked=expected_sequence - 1,
                head_hash=entries[expected_sequence - 2].entry_hash
                if expected_sequence > 1
                else None,
                broken_sequence=entry.sequence,
                reason=f"Expected sequence {expected_sequence}, found {entry.sequence}",
            )
        if entry.previous_hash != expected_previous:
            return AuditVerification(
                valid=False,
                entries_checked=expected_sequence - 1,
                head_hash=expected_previous if expected_sequence > 1 else None,
                broken_sequence=entry.sequence,
                reason="Previous hash does not match the verified chain head",
            )
        calculated = compute_entry_hash(
            sequence=entry.sequence,
            recorded_at=entry.recorded_at,
            actor=entry.actor,
            action=entry.action,
            entity_type=entry.entity_type,
            entity_id=entry.entity_id,
            details=entry.details,
            previous_hash=entry.previous_hash,
        )
        if not hmac.compare_digest(calculated, entry.entry_hash):
            return AuditVerification(
                valid=False,
                entries_checked=expected_sequence - 1,
                head_hash=expected_previous if expected_sequence > 1 else None,
                broken_sequence=entry.sequence,
                reason="Entry content does not match its SHA-256 hash",
            )
        expected_signature = compute_signature(entry.entry_hash, audit_hmac_key)
        if expected_signature is not None and (
            entry.signature is None or not hmac.compare_digest(expected_signature, entry.signature)
        ):
            return AuditVerification(
                valid=False,
                entries_checked=expected_sequence - 1,
                head_hash=expected_previous if expected_sequence > 1 else None,
                broken_sequence=entry.sequence,
                reason="Entry HMAC signature is invalid",
            )
        expected_previous = entry.entry_hash
    return AuditVerification(
        valid=True,
        entries_checked=len(entries),
        head_hash=entries[-1].entry_hash if entries else None,
    )


async def verify_project_audit(
    session: AsyncSession, project_id: str, audit_hmac_key: str
) -> AuditVerification:
    entries = list(
        (
            await session.scalars(
                select(AuditEntry)
                .where(AuditEntry.project_id == project_id)
                .order_by(AuditEntry.sequence.asc())
            )
        ).all()
    )
    return verify_audit_records(entries, audit_hmac_key)
