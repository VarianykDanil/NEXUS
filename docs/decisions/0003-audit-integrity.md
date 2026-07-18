# ADR 0003: Hash-chained audit events with external checkpoints

- Status: accepted
- Date: 2026-07-11

## Context

An ordinary mutable audit table cannot prove that engineering evidence or an
approval was not altered. A chain stored only beside application data is also
insufficient when a privileged operator controls both the database and signing
key.

## Decision

Audit events use versioned canonical serialization, sequence numbers, previous-
hash links, event hashes, and signatures from a separately managed versioned
key. Application state, the event, and its outbox record commit atomically.
Production periodically writes signed chain checkpoints to independent,
retention-locked storage. Verification runs continuously and during restore.

## Consequences

Schema and key rotation need careful versioning, while cross-environment imports
must preserve chain provenance. The design provides practical tamper evidence
without claiming that a database-local HMAC is publicly verifiable proof.

