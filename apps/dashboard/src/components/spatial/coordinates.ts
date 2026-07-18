import type { BuildingFloor, BuildingState, Door, FloorSelection, RobotPose, Vec2 } from "./model";

export interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Projection2D {
  bounds: Bounds2D;
  scale: number;
  offsetX: number;
  offsetY: number;
  project: (point: Vec2) => Vec2;
  distance: (metres: number) => number;
}

export interface ProjectionFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  padding?: number;
}

export interface RoomLabelLayout {
  lines: string[];
  showCoverage: boolean;
}

export interface PerspectivePoint {
  horizontal: number;
  vertical: number;
  depth: number;
}

export interface Size2D {
  width: number;
  height: number;
}

const MIN_SPAN = 0.001;
const NAVIGATION_EPSILON = 1e-7;
const DOOR_APPROACH_METRES = 0.45;

export const DEFAULT_ROBOT_CLEARANCE_METRES = 0.18;
export const MAX_POSE_ANIMATION_DISTANCE_METRES = 3;

interface Segment2D {
  start: Vec2;
  end: Vec2;
  thickness: number;
}

export interface RouteAudit {
  valid: boolean;
  wallCrossings: number;
  doorTransitions: number;
  minimumClearance: number;
  segmentCount: number;
}

export function shouldAnimateRobotPose(
  previous: RobotPose,
  next: RobotPose,
  reducedMotion: boolean,
  maximumDistance = MAX_POSE_ANIMATION_DISTANCE_METRES,
): boolean {
  if (reducedMotion || previous.floorId !== next.floorId) return false;
  if (![previous.x, previous.y, previous.yaw, next.x, next.y, next.yaw].every(Number.isFinite)) return false;
  const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
  return distance > NAVIGATION_EPSILON && distance <= Math.max(0, maximumDistance);
}

/**
 * Allows pose interpolation only when the rendered straight-line motion is a
 * valid, clearance-qualified route on the same floor. Telemetry that jumps
 * across a wall, floor, or an implausibly large gap must snap to the new pose
 * instead of showing motion through solid geometry.
 */
export function shouldInterpolateRobotPose(
  floor: BuildingFloor,
  previous: RobotPose,
  next: RobotPose,
  reducedMotion: boolean,
  maximumDistance = MAX_POSE_ANIMATION_DISTANCE_METRES,
): boolean {
  return shouldAnimateRobotPose(previous, next, reducedMotion, maximumDistance)
    && next.floorId === floor.id
    && auditFloorRoute(floor, [previous, next]).valid;
}

export function interpolateRobotPose(previous: RobotPose, next: RobotPose, progress: number): RobotPose {
  if (previous.floorId !== next.floorId) return { ...next };
  const amount = clamp(progress, 0, 1);
  return {
    x: previous.x + (next.x - previous.x) * amount,
    y: previous.y + (next.y - previous.y) * amount,
    z: previous.z + (next.z - previous.z) * amount,
    yaw: normalizeYaw(previous.yaw + shortestYawDelta(previous.yaw, next.yaw) * amount),
    floorId: next.floorId,
  };
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeYaw(yaw: number): number {
  const normalized = yaw % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

export function shortestYawDelta(from: number, to: number): number {
  return ((normalizeYaw(to) - normalizeYaw(from) + 540) % 360) - 180;
}

export function floorBounds(floor: Pick<BuildingFloor, "width" | "depth">): Bounds2D {
  return {
    minX: 0,
    minY: 0,
    maxX: Math.max(MIN_SPAN, floor.width),
    maxY: Math.max(MIN_SPAN, floor.depth),
  };
}

export function buildingBounds(building: Pick<BuildingState, "width" | "depth">): Bounds2D {
  return {
    minX: 0,
    minY: 0,
    maxX: Math.max(MIN_SPAN, building.width),
    maxY: Math.max(MIN_SPAN, building.depth),
  };
}

export function createProjection(
  bounds: Bounds2D,
  frame: ProjectionFrame,
  zoom = 1,
  pan: Vec2 = { x: 0, y: 0 },
): Projection2D {
  const padding = Math.max(0, frame.padding ?? 18);
  const availableWidth = Math.max(1, frame.width - padding * 2);
  const availableHeight = Math.max(1, frame.height - padding * 2);
  const spanX = Math.max(MIN_SPAN, bounds.maxX - bounds.minX);
  const spanY = Math.max(MIN_SPAN, bounds.maxY - bounds.minY);
  const scale = Math.min(availableWidth / spanX, availableHeight / spanY) * clamp(zoom, 0.5, 4);
  const drawnWidth = spanX * scale;
  const drawnHeight = spanY * scale;
  const offsetX = frame.x + (frame.width - drawnWidth) / 2 + pan.x;
  const offsetY = frame.y + (frame.height - drawnHeight) / 2 + pan.y;

  return {
    bounds,
    scale,
    offsetX,
    offsetY,
    project: ({ x, y }) => ({
      x: offsetX + (x - bounds.minX) * scale,
      y: offsetY + (bounds.maxY - y) * scale,
    }),
    distance: (metres) => metres * scale,
  };
}

export function floorGrid(count: number, width: number, height: number): ProjectionFrame[] {
  if (count <= 1) return [{ x: 0, y: 0, width, height }];
  const columns = width < 620 ? 1 : count > 4 ? 3 : 2;
  const rows = Math.ceil(count / columns);
  const gap = 24;
  const cellWidth = (width - gap * (columns - 1)) / columns;
  const cellHeight = (height - gap * (rows - 1)) / rows;
  return Array.from({ length: count }, (_, index) => ({
    x: (index % columns) * (cellWidth + gap),
    y: Math.floor(index / columns) * (cellHeight + gap),
    width: cellWidth,
    height: cellHeight,
  }));
}

export function clientDeltaToSvg(delta: Vec2, viewBox: Size2D, rendered: Size2D): Vec2 {
  return {
    x: delta.x * (viewBox.width / Math.max(1, rendered.width)),
    y: delta.y * (viewBox.height / Math.max(1, rendered.height)),
  };
}

export function clampProjectionPan(
  bounds: Bounds2D,
  frame: ProjectionFrame,
  zoom: number,
  pan: Vec2,
): Vec2 {
  const padding = Math.max(0, frame.padding ?? 18);
  const availableWidth = Math.max(1, frame.width - padding * 2);
  const availableHeight = Math.max(1, frame.height - padding * 2);
  const spanX = Math.max(MIN_SPAN, bounds.maxX - bounds.minX);
  const spanY = Math.max(MIN_SPAN, bounds.maxY - bounds.minY);
  const baseScale = Math.min(availableWidth / spanX, availableHeight / spanY);
  const scale = baseScale * clamp(zoom, 0.5, 4);
  const maximumX = Math.max(0, (spanX * scale - availableWidth) / 2);
  const maximumY = Math.max(0, (spanY * scale - availableHeight) / 2);
  return {
    x: maximumX === 0 ? 0 : clamp(pan.x, -maximumX, maximumX),
    y: maximumY === 0 ? 0 : clamp(pan.y, -maximumY, maximumY),
  };
}

export function aspectRatioChanged(previous: number, next: number, tolerance = 0.01): boolean {
  if (!Number.isFinite(previous) || previous <= 0) return true;
  return Math.abs(next / previous - 1) > tolerance;
}

/**
 * Wraps a room name only when the complete label can stay inside its room.
 * The estimates match the map's 12.5 px monospace labels and intentionally
 * prefer hiding secondary copy to allowing adjacent-room collisions.
 */
export function roomLabelLayout(
  label: string,
  width: number,
  height: number,
  dense = false,
): RoomLabelLayout | null {
  const horizontalInset = dense ? 4 : 18;
  const averageCharacterWidth = dense ? 7.2 : 7.6;
  const maxCharacters = Math.floor((width - horizontalInset) / averageCharacterWidth);
  if (maxCharacters < 4 || height < 27) return null;

  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.some((word) => word.length > maxCharacters)) return null;

  const lines: string[] = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (current && `${current} ${word}`.length <= maxCharacters) {
      lines[lines.length - 1] = `${current} ${word}`;
    } else {
      lines.push(word);
    }
  }
  if (lines.length > 2) return null;

  const nameHeight = lines.length * (dense ? 14 : 15);
  if (height < nameHeight + (dense ? 4 : 12)) return null;
  return {
    lines,
    showCoverage: height >= nameHeight + (dense ? 20 : 30),
  };
}

/** Returns the closest camera distance that keeps every projected corner visible. */
export function perspectiveFitDistance(
  points: PerspectivePoint[],
  verticalFovDegrees: number,
  aspect: number,
  padding = 1.06,
): number {
  const tangent = Math.tan((verticalFovDegrees * Math.PI) / 360);
  const safeAspect = Math.max(0.1, aspect);
  const required = points.reduce((distance, point) => Math.max(
    distance,
    point.depth + Math.abs(point.vertical) / tangent,
    point.depth + Math.abs(point.horizontal) / (tangent * safeAspect),
  ), 0);
  return Math.max(1, required * Math.max(1, padding));
}

function wallIsHorizontal(wall: BuildingFloor["walls"][number]): boolean {
  return Math.abs(wall.y1 - wall.y2) <= NAVIGATION_EPSILON;
}

function doorIntervalsOnWall(
  floor: BuildingFloor,
  wall: BuildingFloor["walls"][number],
): Array<[number, number]> {
  const horizontal = wallIsHorizontal(wall);
  const [lower, upper] = horizontal
    ? [Math.min(wall.x1, wall.x2), Math.max(wall.x1, wall.x2)]
    : [Math.min(wall.y1, wall.y2), Math.max(wall.y1, wall.y2)];
  const intervals = floor.doors.flatMap((door): Array<[number, number]> => {
    const aligned = horizontal
      ? door.orientation === "horizontal" && Math.abs(door.y - wall.y1) <= NAVIGATION_EPSILON
      : door.orientation === "vertical" && Math.abs(door.x - wall.x1) <= NAVIGATION_EPSILON;
    const center = horizontal ? door.x : door.y;
    if (!aligned || center < lower - NAVIGATION_EPSILON || center > upper + NAVIGATION_EPSILON) return [];
    return [[Math.max(lower, center - door.width / 2), Math.min(upper, center + door.width / 2)]];
  }).filter(([start, end]) => end > start).sort((first, second) => first[0] - second[0]);

  const merged: Array<[number, number]> = [];
  for (const [start, end] of intervals) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1] + NAVIGATION_EPSILON) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/** Returns solid wall fragments with the declared door openings subtracted. */
export function blockedWallSegments(floor: BuildingFloor): Segment2D[] {
  return floor.walls.flatMap((wall) => {
    const horizontal = wallIsHorizontal(wall);
    const [lower, upper] = horizontal
      ? [Math.min(wall.x1, wall.x2), Math.max(wall.x1, wall.x2)]
      : [Math.min(wall.y1, wall.y2), Math.max(wall.y1, wall.y2)];
    const fragments: Segment2D[] = [];
    let cursor = lower;
    for (const [openingStart, openingEnd] of doorIntervalsOnWall(floor, wall)) {
      if (openingStart > cursor + NAVIGATION_EPSILON) {
        fragments.push(horizontal
          ? { start: { x: cursor, y: wall.y1 }, end: { x: openingStart, y: wall.y1 }, thickness: wall.thickness }
          : { start: { x: wall.x1, y: cursor }, end: { x: wall.x1, y: openingStart }, thickness: wall.thickness });
      }
      cursor = Math.max(cursor, openingEnd);
    }
    if (cursor < upper - NAVIGATION_EPSILON) {
      fragments.push(horizontal
        ? { start: { x: cursor, y: wall.y1 }, end: { x: upper, y: wall.y1 }, thickness: wall.thickness }
        : { start: { x: wall.x1, y: cursor }, end: { x: wall.x1, y: upper }, thickness: wall.thickness });
    }
    return fragments;
  });
}

function pointSegmentDistance(point: Vec2, start: Vec2, end: Vec2): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared <= NAVIGATION_EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = clamp(
    ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared,
    0,
    1,
  );
  return Math.hypot(
    point.x - (start.x + projection * deltaX),
    point.y - (start.y + projection * deltaY),
  );
}

function orientation(first: Vec2, second: Vec2, third: Vec2): number {
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
}

function pointOnSegment(first: Vec2, point: Vec2, second: Vec2): boolean {
  return point.x >= Math.min(first.x, second.x) - NAVIGATION_EPSILON
    && point.x <= Math.max(first.x, second.x) + NAVIGATION_EPSILON
    && point.y >= Math.min(first.y, second.y) - NAVIGATION_EPSILON
    && point.y <= Math.max(first.y, second.y) + NAVIGATION_EPSILON;
}

function segmentsIntersect(first: Segment2D, second: Segment2D): boolean {
  const firstStart = orientation(first.start, first.end, second.start);
  const firstEnd = orientation(first.start, first.end, second.end);
  const secondStart = orientation(second.start, second.end, first.start);
  const secondEnd = orientation(second.start, second.end, first.end);
  if (firstStart * firstEnd < 0 && secondStart * secondEnd < 0) return true;
  return (Math.abs(firstStart) <= NAVIGATION_EPSILON && pointOnSegment(first.start, second.start, first.end))
    || (Math.abs(firstEnd) <= NAVIGATION_EPSILON && pointOnSegment(first.start, second.end, first.end))
    || (Math.abs(secondStart) <= NAVIGATION_EPSILON && pointOnSegment(second.start, first.start, second.end))
    || (Math.abs(secondEnd) <= NAVIGATION_EPSILON && pointOnSegment(second.start, first.end, second.end));
}

function segmentDistance(first: Segment2D, second: Segment2D): number {
  if (segmentsIntersect(first, second)) return 0;
  return Math.min(
    pointSegmentDistance(first.start, second.start, second.end),
    pointSegmentDistance(first.end, second.start, second.end),
    pointSegmentDistance(second.start, first.start, first.end),
    pointSegmentDistance(second.end, first.start, first.end),
  );
}

function pointIsNavigable(floor: BuildingFloor, point: Vec2, clearance: number): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  if (point.x < clearance - NAVIGATION_EPSILON || point.x > floor.width - clearance + NAVIGATION_EPSILON
    || point.y < clearance - NAVIGATION_EPSILON || point.y > floor.depth - clearance + NAVIGATION_EPSILON) {
    return false;
  }
  return blockedWallSegments(floor).every((wall) => (
    pointSegmentDistance(point, wall.start, wall.end) >= clearance + wall.thickness / 2 - NAVIGATION_EPSILON
  ));
}

function segmentIsNavigable(floor: BuildingFloor, start: Vec2, end: Vec2, clearance: number): boolean {
  if (!pointIsNavigable(floor, start, clearance) || !pointIsNavigable(floor, end, clearance)) return false;
  const routeSegment = { start, end, thickness: 0 };
  return blockedWallSegments(floor).every((wall) => (
    segmentDistance(routeSegment, wall) >= clearance + wall.thickness / 2 - NAVIGATION_EPSILON
  ));
}

function wallCrossingCoordinate(start: Vec2, end: Vec2, wall: BuildingFloor["walls"][number]): number | null {
  const horizontal = wallIsHorizontal(wall);
  const delta = horizontal ? end.y - start.y : end.x - start.x;
  if (Math.abs(delta) <= NAVIGATION_EPSILON) return null;
  const parameter = horizontal ? (wall.y1 - start.y) / delta : (wall.x1 - start.x) / delta;
  if (parameter <= NAVIGATION_EPSILON || parameter >= 1 - NAVIGATION_EPSILON) return null;
  const coordinate = horizontal
    ? start.x + parameter * (end.x - start.x)
    : start.y + parameter * (end.y - start.y);
  const [lower, upper] = horizontal
    ? [Math.min(wall.x1, wall.x2), Math.max(wall.x1, wall.x2)]
    : [Math.min(wall.y1, wall.y2), Math.max(wall.y1, wall.y2)];
  return coordinate >= lower - NAVIGATION_EPSILON && coordinate <= upper + NAVIGATION_EPSILON
    ? coordinate
    : null;
}

/** Audits a same-floor route against wall solids and legal door openings. */
export function auditFloorRoute(
  floor: BuildingFloor,
  points: readonly Vec2[],
  clearance = DEFAULT_ROBOT_CLEARANCE_METRES,
): RouteAudit {
  const blocked = blockedWallSegments(floor);
  let minimumClearance = Number.POSITIVE_INFINITY;
  let wallCrossings = 0;
  let doorTransitions = 0;
  for (const point of points) {
    for (const wall of blocked) {
      minimumClearance = Math.min(
        minimumClearance,
        pointSegmentDistance(point, wall.start, wall.end) - wall.thickness / 2,
      );
    }
  }
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const routeSegment = { start, end, thickness: 0 };
    for (const wall of blocked) {
      minimumClearance = Math.min(
        minimumClearance,
        segmentDistance(routeSegment, wall) - wall.thickness / 2,
      );
    }
    for (const wall of floor.walls) {
      const coordinate = wallCrossingCoordinate(start, end, wall);
      if (coordinate === null) continue;
      const throughDoor = doorIntervalsOnWall(floor, wall).some(([openingStart, openingEnd]) => (
        coordinate >= openingStart - NAVIGATION_EPSILON && coordinate <= openingEnd + NAVIGATION_EPSILON
      ));
      if (throughDoor) doorTransitions += 1;
      else wallCrossings += 1;
    }
  }
  const pointsAreValid = points.every((point) => pointIsNavigable(floor, point, clearance));
  const segmentsAreValid = points.slice(1).every((point, index) => (
    segmentIsNavigable(floor, points[index], point, clearance)
  ));
  return {
    valid: pointsAreValid && segmentsAreValid && wallCrossings === 0,
    wallCrossings,
    doorTransitions,
    minimumClearance,
    segmentCount: Math.max(0, points.length - 1),
  };
}

/** Plans the deterministic shortest same-floor route through declared doors. */
export function planFloorRoute(
  floor: BuildingFloor,
  start: Vec2,
  end: Vec2,
  clearance = DEFAULT_ROBOT_CLEARANCE_METRES,
): Vec2[] {
  if (!pointIsNavigable(floor, start, clearance)) throw new Error(`Route start is not navigable on ${floor.id}`);
  if (!pointIsNavigable(floor, end, clearance)) throw new Error(`Route end is not navigable on ${floor.id}`);
  if (Math.hypot(end.x - start.x, end.y - start.y) <= NAVIGATION_EPSILON) return [{ ...start }];

  const nodes: Vec2[] = [{ ...start }, { ...end }];
  const seen = new Set(nodes.map((point) => `${point.x.toFixed(6)}:${point.y.toFixed(6)}`));
  for (const door of floor.doors) {
    const candidates = door.orientation === "horizontal"
      ? [{ x: door.x, y: door.y - DOOR_APPROACH_METRES }, { x: door.x, y: door.y + DOOR_APPROACH_METRES }]
      : [{ x: door.x - DOOR_APPROACH_METRES, y: door.y }, { x: door.x + DOOR_APPROACH_METRES, y: door.y }];
    for (const candidate of candidates) {
      const key = `${candidate.x.toFixed(6)}:${candidate.y.toFixed(6)}`;
      if (!seen.has(key) && pointIsNavigable(floor, candidate, clearance)) {
        nodes.push(candidate);
        seen.add(key);
      }
    }
  }

  const distances = nodes.map(() => Number.POSITIVE_INFINITY);
  const previous = nodes.map((): number | null => null);
  const remaining = new Set(nodes.map((_, index) => index));
  distances[0] = 0;
  while (remaining.size > 0) {
    const current = [...remaining].sort((first, second) => (
      distances[first] - distances[second] || first - second
    ))[0];
    remaining.delete(current);
    if (!Number.isFinite(distances[current]) || current === 1) break;
    for (const neighbor of [...remaining].sort((first, second) => first - second)) {
      if (!segmentIsNavigable(floor, nodes[current], nodes[neighbor], clearance)) continue;
      const candidateDistance = distances[current] + Math.hypot(
        nodes[neighbor].x - nodes[current].x,
        nodes[neighbor].y - nodes[current].y,
      );
      if (candidateDistance < distances[neighbor] - NAVIGATION_EPSILON) {
        distances[neighbor] = candidateDistance;
        previous[neighbor] = current;
      }
    }
  }
  if (!Number.isFinite(distances[1])) throw new Error(`No collision-free route exists on ${floor.id}`);
  const indices = [1];
  while (indices.at(-1) !== 0) {
    const predecessor = previous[indices.at(-1) ?? 1];
    if (predecessor === null) throw new Error("Route predecessor chain is incomplete");
    indices.push(predecessor);
  }
  const route = indices.reverse().map((index) => nodes[index]);
  if (!auditFloorRoute(floor, route, clearance).valid) throw new Error("Route planner returned an invalid path");
  return route;
}

export function selectedFloors(building: BuildingState, selection: FloorSelection): BuildingFloor[] {
  if (selection === "all") return [...building.floors].sort((a, b) => a.level - b.level);
  const selected = building.floors.find((floor) => floor.id === selection);
  return selected ? [selected] : building.floors.slice(0, 1);
}

export function roomCenter(room: { x: number; y: number; width: number; depth: number }): Vec2 {
  return { x: room.x + room.width / 2, y: room.y + room.depth / 2 };
}

export interface DoorGeometry {
  hinge: Vec2;
  closedEnd: Vec2;
  openEnd: Vec2;
  sweep: 0 | 1;
}

export function doorGeometry(door: Door): DoorGeometry {
  const half = door.width / 2;
  if (door.orientation === "horizontal") {
    return {
      hinge: { x: door.x - half, y: door.y },
      closedEnd: { x: door.x + half, y: door.y },
      openEnd: { x: door.x - half, y: door.y + door.width },
      sweep: 0,
    };
  }
  return {
    hinge: { x: door.x, y: door.y - half },
    closedEnd: { x: door.x, y: door.y + half },
    openEnd: { x: door.x + door.width, y: door.y - half },
    sweep: 1,
  };
}

export function describeFloor(floor: BuildingFloor): string {
  const hazards = floor.hazards.length;
  return `${floor.label}, ${floor.coverage.toFixed(0)}% mapped, ${floor.rooms.length} rooms, ${hazards} ${hazards === 1 ? "hazard" : "hazards"}`;
}
