import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { connectProjectSocket, fetchProjectDashboard } from "../lib/api";
import type { DashboardSnapshot } from "../types";
import { applyEvent, useProjectDashboard } from "./useProjectDashboard";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    connectProjectSocket: vi.fn(),
    fetchProjectDashboard: vi.fn(),
  };
});

const mockedConnect = vi.mocked(connectProjectSocket);
const mockedFetch = vi.mocked(fetchProjectDashboard);

type SocketHandlers = Parameters<typeof connectProjectSocket>[1];

function cloneSnapshot(): DashboardSnapshot {
  return structuredClone(demoSnapshot);
}

function makeSocket() {
  return { close: vi.fn() } as unknown as WebSocket;
}

describe("project WebSocket reconciliation", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockedConnect.mockReset();
    mockedFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies a completed simulation to legacy state and a floor-aware robot trail", () => {
    const result = applyEvent(cloneSnapshot(), {
      type: "simulation.completed",
      payload: {
        phase: "mission_complete",
        progress: 100,
        battery_percent: 79,
        map_coverage_percent: 96,
        hazards_detected: 3,
        pose: { x: 0.4, y: 0.2, z: 6.8, yaw: 177.6, floorId: "level-2" },
      },
    });

    expect(result.mission.progress).toBe(100);
    expect(result.mission.currentStep).toBe(result.mission.totalSteps);
    expect(result.robot).toMatchObject({ battery: 79, speed: 0, pose: { x: 0.4, y: 0.2, yaw: 177.6 } });
    expect(result.robots[0]).toMatchObject({
      battery: 79,
      speed: 0,
      pose: { x: 0.4, y: 0.2, z: 6.8, yaw: 177.6, floorId: "level-2" },
    });
    expect(result.robots[0].trail.at(-1)).toEqual({ x: 0.4, y: 0.2, z: 6.8, floorId: "level-2" });
    expect(result.map.coverage).toBe(96);
    expect(result.map.hazards).toEqual(demoSnapshot.map.hazards);
    expect(result.map.area).toBe(demoSnapshot.map.area);
    expect(result.map.path).toEqual(demoSnapshot.map.path);
    expect(result.pipeline.filter((task) => task.category !== "deploy").every((task) => task.status === "complete")).toBe(true);
  });

  it("halts a failed simulation without inventing route, hazard, or area evidence", () => {
    const source = cloneSnapshot();
    const result = applyEvent(source, {
      type: "simulation.failed",
      payload: { status: "failed", error_type: "RouteValidationError" },
    });

    expect(result.system.health).toBe("warning");
    expect(result.mission).toMatchObject({ phase: "simulation failed", activeTask: "Review simulation failure", eta: "unavailable" });
    expect(result.robot).toMatchObject({ speed: 0, status: "warning" });
    expect(result.robots.find((robot) => robot.id === result.robot.id)).toMatchObject({
      speed: 0,
      status: "warning",
      connection: "digital_twin_error",
    });
    expect(result.pipeline.find((task) => task.category === "simulate")).toMatchObject({
      status: "failed",
      detail: "Simulation halted · RouteValidationError",
    });
    expect(result.map).toEqual(source.map);
  });

  it("replaces the full fleet batch and mirrors the primary robot into legacy cards", () => {
    const primary = {
      ...structuredClone(demoSnapshot.robots[0]),
      battery: 63,
      speed: 0.58,
      localization: 98.7,
      pose: { x: 20.2, y: 11.1, z: 3.4, yaw: 271, floorId: "level-1" },
      trail: [{ x: 20.2, y: 11.1, z: 3.4, floorId: "level-1" }],
    };
    const secondary = {
      ...structuredClone(demoSnapshot.robots[1]),
      pose: { x: 8.1, y: 4.2, z: 6.8, yaw: 92, floorId: "level-2" },
      trail: [{ x: 8.1, y: 4.2, z: 6.8, floor_id: "level-2" }],
    };
    const source = cloneSnapshot();
    const originalRooms = source.building.floors.find((floor) => floor.id === "level-1")?.rooms;
    const result = applyEvent(source, {
      type: "robots.state.updated",
      payload: {
        robots: [primary, secondary],
        floors: [{
          id: "level-1",
          coverage: 91,
          hazards: [{
            id: "HZ-live",
            type: "Smoke plume",
            severity: "high",
            x: 19.2,
            y: 9.1,
            z: 3.4,
            confidence: 97,
            detected_at: "2026-07-12T19:00:00Z",
          }],
          rooms: [{ id: originalRooms?.[0].id, explored: 91 }],
          path: [{ x: 8.1, y: 4.2, z: 3.4, floor_id: "level-1" }],
        }],
        simulationOnly: true,
        physicalExecutionEnabled: false,
      },
    });

    expect(result.robots).toHaveLength(2);
    expect(result.robots[0]).toMatchObject({ battery: 63, pose: { floorId: "level-1", z: 3.4 } });
    expect(result.robots[1].trail[0]).toEqual({ x: 8.1, y: 4.2, z: 6.8, floorId: "level-2" });
    expect(result.robot).toMatchObject({
      id: primary.id,
      battery: 63,
      speed: 0.58,
      localization: 98.7,
      pose: { x: 20.2, y: 11.1, yaw: 271 },
    });
    expect(result.robot.temperature).toBe(demoSnapshot.robot.temperature);
    expect(result.telemetry.find((metric) => metric.id === "battery")?.value).toBe(63);
    const updatedFloor = result.building.floors.find((floor) => floor.id === "level-1");
    expect(updatedFloor).toMatchObject({ coverage: 91 });
    expect(updatedFloor?.hazards[0]).toMatchObject({ id: "HZ-live", detectedAt: "2026-07-12T19:00:00Z" });
    expect(updatedFloor?.path[0]).toEqual({ x: 8.1, y: 4.2, z: 3.4, floorId: "level-1" });
    expect(updatedFloor?.rooms[0]).toEqual({ ...originalRooms?.[0], explored: 91 });
    expect(updatedFloor?.rooms[0].x).toBe(originalRooms?.[0].x);
  });

  it("projects a backend physical request into a warning approval", () => {
    const result = applyEvent(cloneSnapshot(), {
      type: "approval.requested",
      payload: {
        approval: {
          id: "approval-1",
          risk: "critical",
          requested_by: "operator",
          requested_at: "now",
        },
      },
    });

    expect(result.system.health).toBe("warning");
    expect(result.mission.phase).toBe("Awaiting approval");
    expect(result.approvals[0]).toMatchObject({ id: "approval-1", risk: "high", status: "pending" });
  });

  it("latches every robot into a stopped critical state from an emergency-stop event", () => {
    const eventRobots = cloneSnapshot().robots.map((robot, index) => ({
      ...robot,
      speed: 0.9 + index,
      status: "nominal" as const,
      connection: "digital_twin_connected",
    }));
    const result = applyEvent(cloneSnapshot(), {
      type: "safety.emergency_stop",
      payload: { robots: eventRobots, physicalExecutionEnabled: false },
    });

    expect(result.system).toMatchObject({ health: "critical", safetyLock: true });
    expect(result.robot).toMatchObject({ speed: 0, status: "critical" });
    expect(result.robots).toHaveLength(eventRobots.length);
    expect(result.robots.every((robot) => robot.speed === 0 && robot.status === "critical" && robot.connection === "stopped")).toBe(true);
    expect(result.mission.activeTask).toBe("Motion inhibited");
  });

  it("reconciles a sequence gap with REST and replays the queued fleet batch", async () => {
    const handlers: SocketHandlers[] = [];
    const initialRemote = cloneSnapshot();
    initialRemote.mission.progress = 11;
    const reconciledRemote = cloneSnapshot();
    reconciledRemote.mission.progress = 44;
    mockedFetch
      .mockResolvedValueOnce(initialRemote)
      .mockResolvedValueOnce(reconciledRemote);
    mockedConnect.mockImplementation((_projectId, nextHandlers) => {
      handlers.push(nextHandlers);
      return makeSocket();
    });

    const initial = cloneSnapshot();
    const { result, unmount } = renderHook(() => useProjectDashboard(initial));
    await waitFor(() => expect(result.current.snapshot.mission.progress).toBe(11));
    expect(handlers).toHaveLength(1);

    act(() => {
      handlers[0].onOpen();
      handlers[0].onEvent({
        schema_version: "1.0",
        stream_id: "stream-a",
        sequence: 1,
        project_id: demoSnapshot.project.id,
        type: "dashboard.snapshot",
        data: { dashboard: initialRemote },
      });
    });

    const updatedRobots = cloneSnapshot().robots.map((robot, index) => ({
      ...robot,
      battery: 50 + index,
      pose: { ...robot.pose, x: robot.pose.x + 1, floorId: index === 0 ? "level-2" : robot.pose.floorId },
    }));
    act(() => {
      handlers[0].onEvent({
        schema_version: "1.0",
        stream_id: "stream-a",
        sequence: 3,
        project_id: demoSnapshot.project.id,
        type: "robots.state.updated",
        payload: { robots: updatedRobots },
      });
    });

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.snapshot.mission.progress).toBe(44));
    expect(result.current.snapshot.robots[0]).toMatchObject({ battery: 50, pose: { floorId: "level-2" } });
    expect(result.current.snapshot.robot.battery).toBe(50);
    expect(result.current.source).toBe("live");
    unmount();
  });

  it("reconnects with capped exponential delays and cancels pending work on cleanup", async () => {
    vi.useFakeTimers();
    const handlers: SocketHandlers[] = [];
    const sockets: Array<ReturnType<typeof makeSocket>> = [];
    mockedFetch.mockResolvedValue(cloneSnapshot());
    mockedConnect.mockImplementation((_projectId, nextHandlers) => {
      handlers.push(nextHandlers);
      const socket = makeSocket();
      sockets.push(socket);
      return socket;
    });

    const initial = cloneSnapshot();
    const { result, unmount } = renderHook(() => useProjectDashboard(initial));
    await act(async () => Promise.resolve());
    expect(handlers).toHaveLength(1);
    act(() => handlers[0].onOpen());
    expect(result.current.source).toBe("live");

    act(() => handlers[0].onClose());
    expect(result.current.source).toBe("snapshot");
    act(() => vi.advanceTimersByTime(249));
    expect(handlers).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(handlers).toHaveLength(2);

    act(() => handlers[1].onClose());
    act(() => vi.advanceTimersByTime(499));
    expect(handlers).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(handlers).toHaveLength(3);

    act(() => handlers[2].onClose());
    unmount();
    expect(sockets[2].close).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(4_000));
    expect(handlers).toHaveLength(3);
  });

  it("reports demo data when neither REST nor a WebSocket transport is available", async () => {
    mockedFetch.mockRejectedValue(new Error("offline"));
    mockedConnect.mockReturnValue(undefined);
    const initial = cloneSnapshot();
    const { result } = renderHook(() => useProjectDashboard(initial));

    await waitFor(() => expect(result.current.source).toBe("demo"));
    expect(result.current.snapshot.project.id).toBe(demoSnapshot.project.id);
  });

  it("reports a successful REST response as a snapshot when WebSockets are unavailable", async () => {
    const remote = cloneSnapshot();
    remote.mission.progress = 73;
    mockedFetch.mockResolvedValue(remote);
    mockedConnect.mockReturnValue(undefined);
    const initial = cloneSnapshot();
    const { result } = renderHook(() => useProjectDashboard(initial));

    await waitFor(() => expect(result.current.source).toBe("snapshot"));
    expect(result.current.snapshot.mission.progress).toBe(73);
  });
});
