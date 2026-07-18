#include "nexus/navigation/occupancy_grid.hpp"

#include <array>
#include <cmath>
#include <limits>
#include <queue>
#include <stdexcept>

namespace nexus::navigation {
namespace {

constexpr std::array<GridPoint, 4> neighbours{{
    {1, 0},
    {-1, 0},
    {0, 1},
    {0, -1},
}};

std::size_t validated_cell_count(
    const std::size_t width,
    const std::size_t height,
    const double resolution_metres) {
  if (width == 0 || height == 0) {
    throw std::invalid_argument("occupancy grid dimensions must be non-zero");
  }
  if (!std::isfinite(resolution_metres) || resolution_metres <= 0.0) {
    throw std::invalid_argument("grid resolution must be a positive finite value");
  }

  // GridPoint uses signed int coordinates. Reject dimensions that cannot be
  // addressed without narrowing or overflowing neighbour arithmetic.
  constexpr auto max_coordinate_count =
      static_cast<std::size_t>(std::numeric_limits<int>::max());
  if (width > max_coordinate_count || height > max_coordinate_count) {
    throw std::length_error("occupancy grid dimensions exceed GridPoint range");
  }
  if (width > std::numeric_limits<std::size_t>::max() / height) {
    throw std::length_error("occupancy grid cell count overflows size_t");
  }
  return width * height;
}

}  // namespace

OccupancyGrid::OccupancyGrid(
    const std::size_t width,
    const std::size_t height,
    const double resolution_metres)
    : width_(width),
      height_(height),
      resolution_metres_(resolution_metres),
      cells_(validated_cell_count(width, height, resolution_metres),
             CellState::unknown) {}

std::size_t OccupancyGrid::width() const noexcept { return width_; }

std::size_t OccupancyGrid::height() const noexcept { return height_; }

double OccupancyGrid::resolution_metres() const noexcept {
  return resolution_metres_;
}

bool OccupancyGrid::contains(const GridPoint point) const noexcept {
  return point.x >= 0 && point.y >= 0 &&
         static_cast<std::size_t>(point.x) < width_ &&
         static_cast<std::size_t>(point.y) < height_;
}

std::size_t OccupancyGrid::index(const GridPoint point) const {
  if (!contains(point)) {
    throw std::out_of_range("grid point is outside the occupancy grid");
  }
  return static_cast<std::size_t>(point.y) * width_ +
         static_cast<std::size_t>(point.x);
}

CellState OccupancyGrid::at(const GridPoint point) const {
  return cells_.at(index(point));
}

void OccupancyGrid::observe_free(const GridPoint point) {
  auto& cell = cells_.at(index(point));
  // A hazard is a human/safety classification and must not be erased by a
  // subsequent noisy free-space observation.
  if (cell != CellState::hazard) {
    cell = CellState::free;
  }
}

void OccupancyGrid::observe_obstacle(const GridPoint point) {
  auto& cell = cells_.at(index(point));
  if (cell != CellState::hazard) {
    cell = CellState::occupied;
  }
}

void OccupancyGrid::mark_hazard(const GridPoint point) {
  cells_.at(index(point)) = CellState::hazard;
}

std::optional<GridPoint> OccupancyGrid::nearest_frontier(
    const GridPoint origin) const {
  if (!contains(origin) || at(origin) != CellState::free) {
    return std::nullopt;
  }

  std::queue<GridPoint> open;
  std::vector<bool> visited(cells_.size(), false);
  open.push(origin);
  visited[index(origin)] = true;

  while (!open.empty()) {
    const auto current = open.front();
    open.pop();

    for (const auto delta : neighbours) {
      const GridPoint next{current.x + delta.x, current.y + delta.y};
      if (!contains(next)) {
        continue;
      }

      const auto state = at(next);
      if (state == CellState::unknown) {
        return next;
      }

      const auto next_index = index(next);
      if (state == CellState::free && !visited[next_index]) {
        visited[next_index] = true;
        open.push(next);
      }
    }
  }

  return std::nullopt;
}

std::optional<std::vector<GridPoint>> OccupancyGrid::shortest_path(
    const GridPoint start,
    const GridPoint goal) const {
  if (!contains(start) || !contains(goal) || at(start) != CellState::free ||
      at(goal) != CellState::free) {
    return std::nullopt;
  }

  const auto start_index = index(start);
  const auto goal_index = index(goal);
  std::queue<GridPoint> open;
  std::vector<bool> visited(cells_.size(), false);
  std::vector<std::size_t> parent(cells_.size(), cells_.size());
  open.push(start);
  visited[start_index] = true;

  while (!open.empty() && !visited[goal_index]) {
    const auto current = open.front();
    open.pop();

    for (const auto delta : neighbours) {
      const GridPoint next{current.x + delta.x, current.y + delta.y};
      if (!contains(next) || at(next) != CellState::free) {
        continue;
      }
      const auto next_index = index(next);
      if (visited[next_index]) {
        continue;
      }
      visited[next_index] = true;
      parent[next_index] = index(current);
      open.push(next);
    }
  }

  if (!visited[goal_index]) {
    return std::nullopt;
  }

  std::vector<GridPoint> reversed_path;
  for (auto cursor = goal_index;; cursor = parent[cursor]) {
    const auto x = cursor % width_;
    const auto y = cursor / width_;
    reversed_path.push_back(
        {static_cast<int>(x), static_cast<int>(y)});
    if (cursor == start_index) {
      break;
    }
    if (parent[cursor] == cells_.size()) {
      return std::nullopt;
    }
  }

  return std::vector<GridPoint>(reversed_path.rbegin(), reversed_path.rend());
}

double OccupancyGrid::explored_fraction() const noexcept {
  std::size_t explored = 0;
  for (const auto cell : cells_) {
    if (cell != CellState::unknown) {
      ++explored;
    }
  }
  return static_cast<double>(explored) / static_cast<double>(cells_.size());
}

std::vector<GridPoint> OccupancyGrid::hazards() const {
  std::vector<GridPoint> result;
  for (std::size_t y = 0; y < height_; ++y) {
    for (std::size_t x = 0; x < width_; ++x) {
      const GridPoint point{static_cast<int>(x), static_cast<int>(y)};
      if (at(point) == CellState::hazard) {
        result.push_back(point);
      }
    }
  }
  return result;
}

}  // namespace nexus::navigation
