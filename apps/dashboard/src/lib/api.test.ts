import { afterEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  buildApiUrl,
  connectRobotLink,
  createRobotJob,
  executeRobotJob,
  fetchDemoMotionStatus,
  getProjectSocketUrl,
  getRobotCameraFrameUrl,
  NexusApiError,
  normalizeDashboardSnapshot,
  requestEngineeringReview,
  setOperatingMode,
  startDemoMotion,
  stopDemoMotion,
} from "./api";

function engineeringReviewPayload(overrides: Record<string, unknown> = {}) {
  return {
    project_id: "project-1",
    provider: "openai",
    model: "gpt-5.1",
    prompt_version: "engineering-review-v1",
    readiness: "needs_work",
    summary: "The simulation evidence is promising, but one safety requirement remains open.",
    findings: [{
      severity: "high",
      domain: "safety",
      evidence: "REQ-SAF-05 has not completed hardware-in-the-loop verification.",
      recommendation: "Complete HIL-SAF-03 before requesting any physical approval.",
      requires_human_approval: true,
    }],
    next_experiment: "Run a fault-injection simulation that verifies emergency-stop latency.",
    input_sha256: "a".repeat(64),
    generated_at: "2026-07-16T12:00:00Z",
    audit_hash: "b".repeat(64),
    advisory_only: true,
    simulation_only: true,
    physical_execution_enabled: false,
    hardware_command_sent: false,
    ...overrides,
  };
}

describe("NEXUS API mapping", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps snake_case dashboard envelopes onto the typed UI model", () => {
    const result = normalizeDashboardSnapshot({
      data: {
        snapshot: {
          project: { id: "backend-1", name: "Backend Scout", objective: "Inspect a plant" },
          system: { last_heartbeat: "now", safety_lock: false },
          mission: { active_task: "Scan bay 4", current_step: 8, total_steps: 12, progress: 71 },
          robot: { pose: { x: 4.2, y: 8.7, yaw: 90 }, battery: 64 },
          building: {
            id: "building-1",
            floor_height: 3.4,
            floors: [{ ...demoSnapshot.building.floors[0], id: "ground-live", label: "Live Ground" }],
          },
          robots: [{ ...demoSnapshot.robots[0], id: "robot-live", pose: { x: 4.2, y: 8.7, z: 0, yaw: 90, floor_id: "ground-live" } }],
          approvals: [],
        },
      },
    }, demoSnapshot);

    expect(result.project.id).toBe("backend-1");
    expect(result.system.lastHeartbeat).toBe("now");
    expect(result.system.safetyLock).toBe(false);
    expect(result.mission.activeTask).toBe("Scan bay 4");
    expect(result.mission.currentStep).toBe(8);
    expect(result.robot.pose).toEqual({ x: 4.2, y: 8.7, yaw: 90 });
    expect(result.building.floorHeight).toBe(3.4);
    expect(result.building.floors[0].label).toBe("Live Ground");
    expect(result.robots[0].pose.floorId).toBe("ground-live");
    expect(result.map.rooms).toHaveLength(demoSnapshot.map.rooms.length);
    expect(result.approvals).toEqual([]);
  });

  it("uses same-origin API and project WebSocket paths by default", () => {
    expect(buildApiUrl("projects/aegis-scout/dashboard")).toBe("/api/v1/projects/aegis-scout/dashboard");
    expect(getProjectSocketUrl("project / 7")).toMatch(/\/ws\/projects\/project%20%2F%207$/);
  });

  it("returns normalized command acknowledgement data for reconciliation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: vi.fn().mockResolvedValue({
        message: "Approval required",
        hardware_command_sent: false,
        project: { id: "project-1", active_mode: "physical" },
        approval: { id: "approval-1", requested_by: "operator" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await setOperatingMode("project-1", "PHYSICAL");

    expect(response).toMatchObject({
      message: "Approval required",
      hardwareCommandSent: false,
      project: { id: "project-1", activeMode: "physical" },
      approval: { id: "approval-1", requestedBy: "operator" },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ mode: "PHYSICAL" });
  });

  it("connects the read-only robot link and builds an encoded camera URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        status: {
          adapter: "demo",
          configured: true,
          connected: true,
          read_only: true,
          robot_name: "Demo Spot",
          serial_number: "DEMO-001",
          software_version: "sim-1",
          battery_percent: 87,
          camera_sources: [{ name: "front camera", label: "Front camera", width: 960, height: 540 }],
          last_seen_at: "2026-07-20T12:00:00Z",
          message: "Connected",
        },
        hardware_command_sent: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectRobotLink("project / 1");

    expect(result).toMatchObject({ adapter: "demo", connected: true, readOnly: true });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/project%20%2F%201\/robot-link\/connect$/);
    expect(getRobotCameraFrameUrl("project / 1", "front camera", 42)).toBe(
      "/api/v1/projects/project%20%2F%201/robot-link/cameras/front%20camera/frame?frame=42",
    );
  });

  it("normalizes and controls the simulation-only continuous fleet feed", async () => {
    const payload = (running: boolean) => ({
      enabled: true,
      running,
      simulation_only: true,
      frame_interval_seconds: 0.25,
      speed_multiplier: 1,
      message: running ? "Virtual fleet motion is streaming." : "Virtual fleet motion is stopped.",
      hardware_command_sent: false,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload(true)) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload(true)) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload(false)) });
    vi.stubGlobal("fetch", fetchMock);

    const status = await fetchDemoMotionStatus("project / 1");
    const started = await startDemoMotion("project / 1");
    const stopped = await stopDemoMotion("project / 1");

    expect(status).toMatchObject({
      running: true,
      simulationOnly: true,
      frameIntervalSeconds: 0.25,
      hardwareCommandSent: false,
    });
    expect(started.running).toBe(true);
    expect(stopped.running).toBe(false);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "/api/v1/projects/project%20%2F%201/demo-motion",
      "/api/v1/projects/project%20%2F%201/demo-motion/start",
      "/api/v1/projects/project%20%2F%201/demo-motion/stop",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      requested_by: "dashboard.operator",
    });
  });

  it("creates a map-targeted job and executes the normalized simulation plan", async () => {
    const jobPayload = {
      id: "job-1",
      project_id: "project-1",
      instruction: "Inspect the lobby",
      status: "planned",
      execution_mode: "simulation",
      risk: "medium",
      requested_by: "dashboard.operator",
      assigned_robot_id: "scout-1",
      assigned_robot_name: "Scout One",
      target_floor_id: "ground",
      target_room_id: "lobby",
      target_room_label: "Lobby",
      target_x: 5,
      target_y: 3,
      progress: 0,
      memory_context: { matched_memory_keys: ["location:ground:lobby"], route_distance_metres: 4.2 },
      steps: [{ id: "understand", title: "Understand", detail: "Bound intent", status: "queued", capability: "intent", evidence: null }],
      result: {},
      created_at: "2026-07-20T12:00:00Z",
      updated_at: "2026-07-20T12:00:00Z",
      started_at: null,
      completed_at: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: vi.fn().mockResolvedValue(jobPayload) })
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: vi.fn().mockResolvedValue({ job: { ...jobPayload, status: "running" }, hardware_command_sent: false }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const planned = await createRobotJob("project / 1", "Inspect the lobby", {
      floorId: "ground", x: 5, y: 3, roomId: "lobby", roomLabel: "Lobby",
    });
    const running = await executeRobotJob("project / 1", planned.id);

    expect(planned).toMatchObject({ assignedRobotName: "Scout One", targetRoomLabel: "Lobby" });
    expect(running.status).toBe("running");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      execution_mode: "simulation",
      target: { floor_id: "ground", room_id: "lobby", x: 5, y: 3 },
    });
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/jobs\/job-1\/execute$/);
  });

  it("preserves server validation detail in a typed API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: vi.fn().mockResolvedValue({ detail: "Invalid operating mode" }),
    }));

    const error = await setOperatingMode("project-1", "PHYSICAL").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NexusApiError);
    expect(error).toMatchObject({ status: 422, offline: false, message: "Invalid operating mode" });
  });

  it("requests and normalizes an advisory OpenAI engineering review with physical safety flags", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(engineeringReviewPayload()),
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestEngineeringReview("project / 1");

    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/projects\/project%20%2F%201\/ai-review$/);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ requested_by: "dashboard.user" });
    expect(response).toMatchObject({
      provider: "openai",
      model: "gpt-5.1",
      readiness: "needs_work",
      advisoryOnly: true,
      simulationOnly: true,
      physicalExecutionEnabled: false,
      hardwareCommandSent: false,
      findings: [{ requiresHumanApproval: true }],
    });
  });

  it("rejects a provider response that does not preserve the physical safety boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(engineeringReviewPayload({ physical_execution_enabled: true })),
    }));

    const error = await requestEngineeringReview("project-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NexusApiError);
    expect(error).toMatchObject({ message: "NEXUS API returned an invalid engineering review safety boundary" });
  });

  it("reports a no-network review request as an offline API error without fallback content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network unavailable")));

    const error = await requestEngineeringReview("project-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NexusApiError);
    expect(error).toMatchObject({ offline: true, message: "Unable to reach the NEXUS API" });
  });
});
