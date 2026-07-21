import { describe, expect, it } from "vitest";
import {
  auditFloorRoute,
  aspectRatioChanged,
  clampProjectionPan,
  clientDeltaToSvg,
  createProjection,
  DEFAULT_ROBOT_CLEARANCE_METRES,
  doorGeometry,
  floorGrid,
  interpolateRobotPose,
  normalizeYaw,
  perspectiveFitDistance,
  planFloorRoute,
  roomLabelLayout,
  shouldAnimateRobotPose,
  shouldInterpolateRobotPose,
  shortestYawDelta,
} from "./coordinates";
import { demoBuilding, demoRobots } from "../../data/spatialDemo";

describe("spatial coordinate utilities", () => {
  it("projects metric ENU coordinates into a north-up SVG frame", () => {
    const projection = createProjection(
      { minX: 0, minY: 0, maxX: 20, maxY: 10 },
      { x: 0, y: 0, width: 1000, height: 600, padding: 20 },
    );

    expect(projection.project({ x: 0, y: 0 })).toEqual({ x: 20, y: 540 });
    expect(projection.project({ x: 20, y: 10 })).toEqual({ x: 980, y: 60 });
    expect(projection.unproject(projection.project({ x: 7.25, y: 3.5 }))).toEqual({ x: 7.25, y: 3.5 });
    expect(projection.distance(5)).toBe(240);
  });

  it("creates readable small-multiple frames for all floors", () => {
    expect(floorGrid(3, 1000, 600)).toEqual([
      { x: 0, y: 0, width: 488, height: 288 },
      { x: 512, y: 0, width: 488, height: 288 },
      { x: 0, y: 312, width: 488, height: 288 },
    ]);
  });

  it("stacks floor frames on narrow rendered maps", () => {
    expect(floorGrid(3, 360, 840)).toEqual([
      { x: 0, y: 0, width: 360, height: 264 },
      { x: 0, y: 288, width: 360, height: 264 },
      { x: 0, y: 576, width: 360, height: 264 },
    ]);
  });

  it("converts CSS pointer travel into SVG units and clamps map panning", () => {
    expect(clientDeltaToSvg(
      { x: 10, y: -15 },
      { width: 1000, height: 620 },
      { width: 500, height: 310 },
    )).toEqual({ x: 20, y: -30 });

    const bounds = { minX: 0, minY: 0, maxX: 20, maxY: 10 };
    const frame = { x: 0, y: 0, width: 1000, height: 600, padding: 20 };
    expect(clampProjectionPan(bounds, frame, 1, { x: 200, y: -200 })).toEqual({ x: 0, y: 0 });
    expect(clampProjectionPan(bounds, frame, 2, { x: 800, y: -300 })).toEqual({ x: 480, y: -200 });
  });

  it("detects meaningful camera aspect changes without resize noise", () => {
    expect(aspectRatioChanged(0, 1.5)).toBe(true);
    expect(aspectRatioChanged(1.5, 1.51)).toBe(false);
    expect(aspectRatioChanged(1.5, 1.8)).toBe(true);
  });

  it("wraps readable room labels and suppresses copy that would collide", () => {
    expect(roomLabelLayout("Response Storage", 122, 72)).toEqual({
      lines: ["Response", "Storage"],
      showCoverage: true,
    });
    expect(roomLabelLayout("Electrical Plant", 76, 38)).toBeNull();
    expect(roomLabelLayout("Electrical Plant", 79, 60, true)).toEqual({
      lines: ["Electrical", "Plant"],
      showCoverage: true,
    });
    expect(roomLabelLayout("East Corridor", 79, 36, true)).toEqual({
      lines: ["East", "Corridor"],
      showCoverage: false,
    });
    expect(roomLabelLayout("Lab", 54, 42)).toEqual({ lines: ["Lab"], showCoverage: false });
  });

  it("fits perspective content against both horizontal and vertical field of view", () => {
    const points = [
      { horizontal: -10, vertical: -5, depth: 2 },
      { horizontal: 10, vertical: 5, depth: 2 },
    ];
    expect(perspectiveFitDistance(points, 90, 2, 1)).toBeCloseTo(7);
    expect(perspectiveFitDistance(points, 90, 1, 1)).toBeCloseTo(12);
  });

  it("calculates horizontal and vertical door swings", () => {
    expect(doorGeometry({ id: "d1", x: 5, y: 4, width: 2, orientation: "horizontal" })).toEqual({
      hinge: { x: 4, y: 4 },
      closedEnd: { x: 6, y: 4 },
      openEnd: { x: 4, y: 6 },
      sweep: 0,
    });
    expect(doorGeometry({ id: "d2", x: 5, y: 4, width: 2, orientation: "vertical" })).toEqual({
      hinge: { x: 5, y: 3 },
      closedEnd: { x: 5, y: 5 },
      openEnd: { x: 7, y: 3 },
      sweep: 1,
    });
  });

  it("normalizes headings and takes the shortest interpolation arc", () => {
    expect(normalizeYaw(-10)).toBe(350);
    expect(shortestYawDelta(350, 10)).toBe(20);
    expect(shortestYawDelta(10, 350)).toBe(-20);
  });

  it("bounds pose animation, uses the shortest yaw arc, and snaps across floors", () => {
    const previous = { x: 2, y: 2, z: 0, yaw: 350, floorId: "ground" };
    const nearby = { x: 3, y: 2, z: 0, yaw: 10, floorId: "ground" };
    const farAway = { ...nearby, x: 8 };
    const upstairs = { ...nearby, z: 3.4, floorId: "level-1" };

    expect(shouldAnimateRobotPose(previous, nearby, false)).toBe(true);
    expect(shouldAnimateRobotPose(previous, nearby, true)).toBe(false);
    expect(shouldAnimateRobotPose(previous, farAway, false)).toBe(false);
    expect(shouldAnimateRobotPose(previous, upstairs, false)).toBe(false);
    expect(interpolateRobotPose(previous, nearby, 0.5)).toEqual({
      x: 2.5,
      y: 2,
      z: 0,
      yaw: 0,
      floorId: "ground",
    });
    expect(interpolateRobotPose(previous, nearby, -1)).toEqual(previous);
    expect(interpolateRobotPose(previous, upstairs, 0.5)).toEqual(upstairs);
  });

  it("refuses to interpolate a short telemetry jump through a wall", () => {
    const floor = demoBuilding.floors[0];
    const previous = { x: 7.4, y: 5.4, z: 0, yaw: 0, floorId: "ground" };
    const throughWall = { x: 8.6, y: 5.4, z: 0, yaw: 0, floorId: "ground" };
    const insideRoom = { x: 7.0, y: 5.0, z: 0, yaw: 0, floorId: "ground" };

    expect(shouldAnimateRobotPose(previous, throughWall, false)).toBe(true);
    expect(shouldInterpolateRobotPose(floor, previous, throughWall, false)).toBe(false);
    expect(shouldInterpolateRobotPose(floor, previous, insideRoom, false)).toBe(true);
  });

  it("detects a wall-cutting route and deterministically replans it through doors", () => {
    const floor = demoBuilding.floors[0];
    const start = { x: 1.4, y: 0.8 };
    const end = { x: 11, y: 8.4 };
    const directAudit = auditFloorRoute(floor, [start, end]);

    expect(directAudit.valid).toBe(false);
    expect(directAudit.wallCrossings).toBeGreaterThan(0);

    const route = planFloorRoute(floor, start, end);
    const audit = auditFloorRoute(floor, route);
    expect(route).toEqual(planFloorRoute(floor, start, end));
    expect(audit.valid).toBe(true);
    expect(audit.wallCrossings).toBe(0);
    expect(audit.doorTransitions).toBeGreaterThanOrEqual(2);
    expect(audit.minimumClearance).toBeGreaterThanOrEqual(DEFAULT_ROBOT_CLEARANCE_METRES - 1e-6);
  });

  it("keeps every fallback floor path and robot trail clear of wall solids", () => {
    for (const floor of demoBuilding.floors) {
      const pathAudit = auditFloorRoute(floor, floor.path);
      expect(pathAudit.valid, `${floor.id} planned path`).toBe(true);
      expect(pathAudit.wallCrossings, `${floor.id} planned path crossings`).toBe(0);

      for (const robot of demoRobots) {
        const trail = robot.trail.filter((point) => point.floorId === floor.id);
        if (trail.length === 0) continue;
        const trailAudit = auditFloorRoute(floor, trail);
        expect(trailAudit.valid, `${robot.id} trail on ${floor.id}`).toBe(true);
        expect(trailAudit.wallCrossings, `${robot.id} trail crossings on ${floor.id}`).toBe(0);
      }
    }
  });
});
