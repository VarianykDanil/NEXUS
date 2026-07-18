import { blockedWallSegments } from "./coordinates";
import type { BuildingFloor } from "./model";

export interface RenderableWallFragment {
  id: string;
  sourceWallId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
  height: number;
}

/** Produces only solid wall geometry, retaining the source wall identity and dimensions. */
export function wallRenderFragments(floor: BuildingFloor): RenderableWallFragment[] {
  return floor.walls.flatMap((wall) => {
    const segments = blockedWallSegments({ ...floor, walls: [wall] });
    return segments.map((segment, index) => ({
      id: segments.length === 1 ? wall.id : `${wall.id}:fragment-${index + 1}`,
      sourceWallId: wall.id,
      x1: segment.start.x,
      y1: segment.start.y,
      x2: segment.end.x,
      y2: segment.end.y,
      thickness: wall.thickness,
      height: wall.height,
    }));
  });
}
