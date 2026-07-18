from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from nexus_api.audit import (
    GENESIS_HASH,
    compute_entry_hash,
    compute_signature,
    verify_audit_records,
)


@dataclass
class Record:
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


def make_record(
    sequence: int, previous_hash: str, recorded_at: datetime, details: dict[str, Any]
) -> Record:
    values = {
        "sequence": sequence,
        "recorded_at": recorded_at,
        "actor": "test.operator",
        "action": "project.changed",
        "entity_type": "project",
        "entity_id": "project-1",
        "details": details,
        "previous_hash": previous_hash,
    }
    entry_hash = compute_entry_hash(**values)
    return Record(**values, entry_hash=entry_hash, signature=compute_signature(entry_hash, "key"))


def test_sha256_chain_verifies_and_detects_content_tampering() -> None:
    timestamp = datetime.now(UTC)
    first = make_record(1, GENESIS_HASH, timestamp, {"status": "planned"})
    second = make_record(
        2,
        first.entry_hash,
        timestamp + timedelta(seconds=1),
        {"status": "simulation_running"},
    )

    verified = verify_audit_records([first, second], "key")
    assert verified.valid is True
    assert verified.entries_checked == 2
    assert verified.head_hash == second.entry_hash

    first.details["status"] = "physical_executing"
    invalid = verify_audit_records([first, second], "key")
    assert invalid.valid is False
    assert invalid.broken_sequence == 1
    assert "SHA-256" in (invalid.reason or "")


def test_chain_detects_missing_sequence() -> None:
    record = make_record(2, GENESIS_HASH, datetime.now(UTC), {})

    result = verify_audit_records([record], "key")

    assert result.valid is False
    assert result.broken_sequence == 2
