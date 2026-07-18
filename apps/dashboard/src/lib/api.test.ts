import { afterEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { buildApiUrl, getProjectSocketUrl, NexusApiError, normalizeDashboardSnapshot, requestEngineeringReview, setOperatingMode } from "./api";

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
