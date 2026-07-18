# NEXUS navigation core

This directory contains the deterministic, dependency-free C++ portion of the
navigation boundary. It currently provides an occupancy grid, safety-preserving
hazard updates, explored-area measurement, a nearest-frontier fallback, and a
deterministic shortest-path planner that traverses observed free cells only.

Keeping this core independent of ROS 2 makes it fast to test in CI and usable by
both the digital twin and a future `rclcpp` bridge. The bridge—not this library—
will own ROS topics, lifecycle, quality-of-service settings, and hardware
capabilities.

```sh
cmake -S robotics -B build/robotics -DNEXUS_BUILD_TESTS=ON
cmake --build build/robotics --config Release
ctest --test-dir build/robotics --build-config Release --output-on-failure
```

The tests use explicit failure checks rather than `assert`, so they remain active
in optimized release builds. This library never emits actuator commands and
therefore cannot bypass the control-plane approval policy.
