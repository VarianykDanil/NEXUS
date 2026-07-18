# ADR 0002: Capability grants for physical actions

- Status: accepted
- Date: 2026-07-11

## Context

Model output is probabilistic, simulation is incomplete, and a compromised
control plane could otherwise turn a planning error into physical harm. A simple
confirmation button does not bind approval to the command that is executed.

## Decision

Physical actions require a server-issued, signed, short-lived capability grant
bound to the exact action digest, robot, project, limits, approver, and nonce.
Both the API and robot edge validate the grant. Material changes invalidate it;
dangerous classes require separation of duties. Local watchdogs, interlocks, and
emergency stops remain independent of the grant and NEXUS.

## Consequences

The approval model is more complex and adds latency. In return, the authorization
is attributable, reviewable, resistant to replay, and narrow enough for the edge
to enforce without trusting free-form model output.

