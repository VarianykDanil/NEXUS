#include "nexus/navigation/occupancy_grid.hpp"

#include <cstdlib>
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>

using nexus::navigation::CellState;
using nexus::navigation::GridPoint;
using nexus::navigation::OccupancyGrid;

namespace {

int failures = 0;

void expect(const bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << '\n';
    ++failures;
  }
}

}  // namespace

int main() {
  OccupancyGrid grid(5, 4, 0.1);

  grid.observe_free({1, 1});
  grid.observe_free({2, 1});
  grid.observe_obstacle({3, 1});
  grid.mark_hazard({2, 2});
  grid.observe_free({2, 2});

  expect(grid.at({1, 1}) == CellState::free, "free observation is stored");
  expect(grid.at({3, 1}) == CellState::occupied, "obstacle observation is stored");
  expect(grid.at({2, 2}) == CellState::hazard, "free observation cannot clear a hazard");
  expect(grid.hazards().size() == 1, "hazards are enumerated once");
  expect(
      std::abs(grid.explored_fraction() - 0.2) < 0.0001,
      "explored fraction counts every known cell state");

  const auto frontier = grid.nearest_frontier({1, 1});
  expect(frontier.has_value(), "frontier is found from reachable free space");
  expect(
      frontier.has_value() && *frontier == GridPoint{0, 1},
      "frontier selection follows deterministic neighbour order");

  OccupancyGrid blocked(3, 3, 0.1);
  blocked.observe_free({1, 1});
  blocked.observe_obstacle({0, 1});
  blocked.observe_obstacle({1, 0});
  blocked.observe_obstacle({2, 1});
  blocked.observe_obstacle({1, 2});
  expect(
      !blocked.nearest_frontier({1, 1}).has_value(),
      "occupied cells block access to an unknown frontier");

  OccupancyGrid planner(5, 5, 0.25);
  for (int y = 0; y < 5; ++y) {
    for (int x = 0; x < 5; ++x) {
      planner.observe_free({x, y});
    }
  }
  planner.observe_obstacle({2, 1});
  planner.observe_obstacle({2, 2});
  planner.observe_obstacle({2, 3});
  const auto safe_path = planner.shortest_path({0, 2}, {4, 2});
  expect(safe_path.has_value(), "a path is found around an obstacle wall");
  expect(
      safe_path.has_value() && safe_path->front() == GridPoint{0, 2} &&
          safe_path->back() == GridPoint{4, 2},
      "the path preserves its requested endpoints");
  expect(
      safe_path.has_value() && safe_path->size() == 9,
      "the planner returns the deterministic shortest safe detour");
  if (safe_path.has_value()) {
    for (const auto point : *safe_path) {
      expect(
          planner.at(point) == CellState::free,
          "the path contains only observed free cells");
    }
  }

  planner.mark_hazard({4, 2});
  expect(
      !planner.shortest_path({0, 2}, {4, 2}).has_value(),
      "a hazard endpoint is rejected");

  OccupancyGrid sealed(3, 3, 0.25);
  sealed.observe_free({0, 1});
  sealed.observe_free({2, 1});
  expect(
      !sealed.shortest_path({0, 1}, {2, 1}).has_value(),
      "unknown space cannot be used as an unverified shortcut");

  bool rejected_invalid_resolution = false;
  try {
    const OccupancyGrid invalid_resolution(2, 2, 0.0);
    (void)invalid_resolution;
  } catch (const std::invalid_argument&) {
    rejected_invalid_resolution = true;
  }
  expect(rejected_invalid_resolution, "zero resolution is rejected");

  bool rejected_non_finite_resolution = false;
  try {
    const OccupancyGrid invalid_resolution(
        2, 2, std::numeric_limits<double>::infinity());
    (void)invalid_resolution;
  } catch (const std::invalid_argument&) {
    rejected_non_finite_resolution = true;
  }
  expect(rejected_non_finite_resolution, "non-finite resolution is rejected");

  bool rejected_empty_grid = false;
  try {
    const OccupancyGrid empty(0, 2, 0.1);
    (void)empty;
  } catch (const std::invalid_argument&) {
    rejected_empty_grid = true;
  }
  expect(rejected_empty_grid, "empty grid dimensions are rejected");

  bool rejected_unaddressable_grid = false;
  try {
    const auto too_wide =
        static_cast<std::size_t>(std::numeric_limits<int>::max()) + 1U;
    const OccupancyGrid unaddressable(too_wide, 1, 0.1);
    (void)unaddressable;
  } catch (const std::length_error&) {
    rejected_unaddressable_grid = true;
  }
  expect(
      rejected_unaddressable_grid,
      "dimensions outside the GridPoint coordinate range are rejected");

  bool rejected_out_of_bounds_access = false;
  try {
    (void)grid.at({5, 0});
  } catch (const std::out_of_range&) {
    rejected_out_of_bounds_access = true;
  }
  expect(rejected_out_of_bounds_access, "out-of-bounds access is rejected");

  return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
