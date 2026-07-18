# ADR 0001: Lightweight core and optional robotics edge

- Status: accepted
- Date: 2026-07-11

## Context

NEXUS needs a useful developer experience while eventually supporting ROS 2,
Gazebo, isolated code execution, and physical hardware. Requiring the complete
robotics and simulation toolchain would make first-run builds large,
platform-specific, and unnecessarily privileged.

## Decision

The default stack contains a React dashboard, Python API/control plane, and
PostgreSQL. Deterministic navigation logic is a dependency-free C++ library.
Generated-code execution, Gazebo, ROS 2 adapters, and robot connectivity are
separate profiles/services with explicit capabilities. The robot integration is
an edge gateway; the API does not join the ROS graph or publish motor commands.

## Consequences

Most contributors can run the product with Docker alone, core CI remains fast,
and safety boundaries are visible. Integration tests must cover the separate
message contracts, and robotics contributors need an additional documented
environment. Some end-to-end features arrive later instead of being hidden in a
monolithic container.

