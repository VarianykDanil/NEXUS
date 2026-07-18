#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

namespace nexus::navigation {

struct GridPoint {
  int x{};
  int y{};

  friend constexpr bool operator==(const GridPoint lhs, const GridPoint rhs) {
    return lhs.x == rhs.x && lhs.y == rhs.y;
  }
};

enum class CellState : std::uint8_t {
  unknown = 0,
  free = 1,
  occupied = 2,
  hazard = 3,
};

// A small dependency-free mapping primitive used by the ROS bridge and simulator.
// Sensor fusion remains outside this class; updates are already expressed in grid
// coordinates so the core can be tested without ROS 2 or a simulator installed.
class OccupancyGrid {
 public:
  OccupancyGrid(std::size_t width, std::size_t height, double resolution_metres);

  [[nodiscard]] std::size_t width() const noexcept;
  [[nodiscard]] std::size_t height() const noexcept;
  [[nodiscard]] double resolution_metres() const noexcept;
  [[nodiscard]] bool contains(GridPoint point) const noexcept;
  [[nodiscard]] CellState at(GridPoint point) const;

  void observe_free(GridPoint point);
  void observe_obstacle(GridPoint point);
  void mark_hazard(GridPoint point);

  // Returns the nearest reachable unknown cell adjacent to known free space.
  // This is a deterministic frontier selector suitable for a safe local fallback;
  // a production planner can replace it behind the same boundary.
  [[nodiscard]] std::optional<GridPoint> nearest_frontier(GridPoint origin) const;

  // Returns a deterministic shortest path through observed free cells. Unknown,
  // occupied, and hazard cells are never traversed, so this is safe as a local
  // fallback and cannot silently plan through unmapped space.
  [[nodiscard]] std::optional<std::vector<GridPoint>> shortest_path(
      GridPoint start,
      GridPoint goal) const;

  [[nodiscard]] double explored_fraction() const noexcept;
  [[nodiscard]] std::vector<GridPoint> hazards() const;

 private:
  [[nodiscard]] std::size_t index(GridPoint point) const;

  std::size_t width_;
  std::size_t height_;
  double resolution_metres_;
  std::vector<CellState> cells_;
};

}  // namespace nexus::navigation
