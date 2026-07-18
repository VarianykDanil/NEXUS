import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { buildMissionAssurance } from "./missionAssurance";

describe("mission assurance evidence", () => {
  it("derives blockers and review items from the current snapshot without a synthetic score", () => {
    const brief = buildMissionAssurance(structuredClone(demoSnapshot), "live");

    expect(brief.state).toBe("blocked");
    expect(brief.blocked).toBe(1);
    expect(brief.attention).toBe(3);
    expect(brief.evidence.find((item) => item.id === "approvals")).toMatchObject({
      state: "blocked",
      evidence: "2 pending requests · 1 high risk",
    });
    expect(brief.evidence.find((item) => item.id === "fleet")?.evidence).toContain("minimum localization 95.8%");
    expect(brief.evidence.find((item) => item.id === "route")).toMatchObject({ state: "clear" });
    expect(brief.evidence.find((item) => item.id === "route")?.evidence).toContain("0 wall crossings");
  });

  it("reports a clear snapshot only when every represented evidence check is clear", () => {
    const snapshot = structuredClone(demoSnapshot);
    snapshot.pipeline = snapshot.pipeline.map((task) => task.category === "simulate" ? { ...task, status: "complete" } : task);
    snapshot.requirements = snapshot.requirements.map((requirement) => ({ ...requirement, status: "verified" }));
    snapshot.approvals = [];
    snapshot.robots = snapshot.robots.map((robot) => ({ ...robot, status: "nominal" }));

    const brief = buildMissionAssurance(snapshot, "live");
    expect(brief).toMatchObject({ state: "clear", blocked: 0, attention: 0, clear: 7 });
  });

  it("does not present API-only or demo data as a live realtime stream", () => {
    const apiBrief = buildMissionAssurance(structuredClone(demoSnapshot), "snapshot");
    const demoBrief = buildMissionAssurance(structuredClone(demoSnapshot), "demo");

    expect(apiBrief.evidence[0]).toMatchObject({ state: "attention" });
    expect(apiBrief.evidence[0].evidence).toContain("API snapshot available");
    expect(demoBrief.evidence[0]).toMatchObject({ state: "blocked" });
    expect(demoBrief.evidence[0].evidence).toContain("no control-plane connection");
  });

  it("promotes the spatial wall audit into a blocking route-geometry finding", () => {
    const snapshot = structuredClone(demoSnapshot);
    snapshot.robots[0].trail = [
      { x: 1, y: 1, z: 0, floorId: "ground" },
      { x: 20, y: 1, z: 0, floorId: "ground" },
    ];

    const route = buildMissionAssurance(snapshot, "live").evidence.find((item) => item.id === "route");
    expect(route).toMatchObject({ state: "blocked" });
    expect(route?.evidence).toMatch(/displayed routes? invalid.*wall crossings/);
  });
});
