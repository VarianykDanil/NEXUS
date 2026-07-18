import { describe, expect, it } from "vitest";
import type { BuildingFloor } from "./model";
import { wallRenderFragments } from "./wallGeometry";

function floorFixture(): BuildingFloor {
  return {
    id: "test-floor",
    label: "Test floor",
    level: 0,
    elevation: 0,
    height: 3.2,
    width: 10,
    depth: 8,
    coverage: 100,
    rooms: [],
    walls: [{ id: "north", x1: 0, y1: 4, x2: 10, y2: 4, thickness: 0.2, height: 3.1 }],
    doors: [
      { id: "door-a", x: 3, y: 4, width: 2, orientation: "horizontal" },
      { id: "door-b", x: 7, y: 4, width: 2, orientation: "horizontal" },
    ],
    connectors: [],
    hazards: [],
    path: [],
  };
}

describe("3D wall rendering geometry", () => {
  it("subtracts every declared doorway from the rendered wall", () => {
    const fragments = wallRenderFragments(floorFixture());
    expect(fragments.map(({ x1, x2 }) => [x1, x2])).toEqual([[0, 2], [4, 6], [8, 10]]);
  });

  it("preserves source identity, thickness, and full wall height on every fragment", () => {
    const fragments = wallRenderFragments(floorFixture());
    expect(fragments).toHaveLength(3);
    expect(fragments.every((fragment) => (
      fragment.sourceWallId === "north"
      && fragment.thickness === 0.2
      && fragment.height === 3.1
      && fragment.id.startsWith("north:fragment-")
    ))).toBe(true);
  });

  it("keeps the original wall id when no aligned opening splits it", () => {
    const floor = floorFixture();
    floor.doors = [{ id: "misaligned", x: 3, y: 2, width: 2, orientation: "horizontal" }];
    expect(wallRenderFragments(floor)).toEqual([{
      id: "north",
      sourceWallId: "north",
      x1: 0,
      y1: 4,
      x2: 10,
      y2: 4,
      thickness: 0.2,
      height: 3.1,
    }]);
  });
});
