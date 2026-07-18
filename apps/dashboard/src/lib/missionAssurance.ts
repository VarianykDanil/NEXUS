import type { DashboardSnapshot } from "../types";
import { auditFloorRoute } from "../components/spatial/coordinates";
import type { BuildingFloor, TrailPoint } from "../components/spatial/model";
import type { DataSourceState } from "./dataSource";
import { dataSourceDetail } from "./dataSource";

export type AssuranceState = "clear" | "attention" | "blocked";
export type AssuranceTarget = "twin" | "requirements" | "pipeline" | "approvals" | "audit";

export interface AssuranceEvidence {
  id: "source" | "fleet" | "route" | "simulation" | "requirements" | "approvals" | "audit";
  label: string;
  state: AssuranceState;
  evidence: string;
  target?: AssuranceTarget;
}

export interface MissionAssuranceBrief {
  state: AssuranceState;
  summary: string;
  blocked: number;
  attention: number;
  clear: number;
  evidence: AssuranceEvidence[];
}

function plural(value: number, singular: string, pluralValue = `${singular}s`): string {
  return value === 1 ? singular : pluralValue;
}

function fleetEvidence(snapshot: DashboardSnapshot): AssuranceEvidence {
  const robots = snapshot.robots;
  const unavailable = robots.filter((robot) =>
    robot.status === "critical"
    || robot.status === "offline"
    || robot.connection.toLowerCase().includes("stopped")
    || robot.connection.toLowerCase().includes("offline"));
  const warnings = robots.filter((robot) => robot.status === "warning");
  const batteries = robots.map((robot) => robot.battery).filter(Number.isFinite);
  const localizations = robots.map((robot) => robot.localization).filter(Number.isFinite);
  const minimumBattery = batteries.length ? Math.min(...batteries) : undefined;
  const minimumLocalization = localizations.length ? Math.min(...localizations) : undefined;
  const observations = [
    `${robots.length} ${plural(robots.length, "robot")}`,
    `${unavailable.length} critical/offline`,
    minimumBattery === undefined ? undefined : `minimum battery ${minimumBattery.toFixed(0)}%`,
    minimumLocalization === undefined ? undefined : `minimum localization ${minimumLocalization.toFixed(1)}%`,
  ].filter(Boolean).join(" · ");

  return {
    id: "fleet",
    label: "Fleet state",
    state: unavailable.length > 0 ? "blocked" : warnings.length > 0 ? "attention" : "clear",
    evidence: observations || "No robot state is present in this snapshot",
    target: "twin",
  };
}

function auditTrail(floor: BuildingFloor, points: readonly TrailPoint[]) {
  const floorPoints = points.filter((point) => point.floorId === floor.id);
  return floorPoints.length > 1 ? auditFloorRoute(floor, floorPoints) : undefined;
}

function routeEvidence(snapshot: DashboardSnapshot): AssuranceEvidence {
  const audits = snapshot.building.floors.flatMap((floor) => {
    const floorAudit = floor.path.length > 1 ? [auditFloorRoute(floor, floor.path)] : [];
    const robotAudits = snapshot.robots.flatMap((robot) => {
      const audit = auditTrail(floor, robot.trail);
      return audit ? [audit] : [];
    });
    return [...floorAudit, ...robotAudits];
  });
  const invalid = audits.filter((audit) => !audit.valid);
  const wallCrossings = audits.reduce((total, audit) => total + audit.wallCrossings, 0);
  const doorTransitions = audits.reduce((total, audit) => total + audit.doorTransitions, 0);
  const finiteClearances = audits.map((audit) => audit.minimumClearance).filter(Number.isFinite);
  const minimumClearance = finiteClearances.length ? Math.min(...finiteClearances) : undefined;
  const evidence = audits.length === 0
    ? "No multi-point displayed routes are available to audit"
    : invalid.length > 0
      ? `${invalid.length}/${audits.length} displayed ${plural(audits.length, "route")} invalid · ${wallCrossings} wall crossings`
      : `${audits.length} displayed ${plural(audits.length, "route")} valid · 0 wall crossings · ${doorTransitions} door ${plural(doorTransitions, "transition")}${minimumClearance === undefined ? "" : ` · ${minimumClearance.toFixed(2)} m minimum wall clearance`}`;
  return {
    id: "route",
    label: "Route geometry",
    state: audits.length === 0 ? "attention" : invalid.length > 0 ? "blocked" : "clear",
    evidence,
    target: "twin",
  };
}

function simulationEvidence(snapshot: DashboardSnapshot): AssuranceEvidence {
  const simulationTasks = snapshot.pipeline.filter((task) => task.category === "simulate");
  const failed = simulationTasks.filter((task) => task.status === "failed");
  const complete = simulationTasks.filter((task) => task.status === "complete");
  const active = simulationTasks.find((task) => task.status === "running" || task.status === "blocked");
  const state: AssuranceState = failed.length > 0
    ? "blocked"
    : simulationTasks.length > 0 && complete.length === simulationTasks.length
      ? "clear"
      : "attention";
  const evidence = failed.length > 0
    ? `${failed.length} failed simulation ${plural(failed.length, "stage")}`
    : simulationTasks.length === 0
      ? "No simulation stage is recorded"
      : complete.length === simulationTasks.length
        ? `${complete.length}/${simulationTasks.length} simulation ${plural(simulationTasks.length, "stage")} complete`
        : `${complete.length}/${simulationTasks.length} complete${active ? ` · ${active.label}: ${active.status}` : ""}`;

  return { id: "simulation", label: "Simulation evidence", state, evidence, target: "pipeline" };
}

function requirementsEvidence(snapshot: DashboardSnapshot): AssuranceEvidence {
  const verified = snapshot.requirements.filter((requirement) => requirement.status === "verified").length;
  const failed = snapshot.requirements.length - verified;
  return {
    id: "requirements",
    label: "Requirement verification",
    state: snapshot.requirements.length > 0 && failed === 0 ? "clear" : "attention",
    evidence: snapshot.requirements.length
      ? `${verified}/${snapshot.requirements.length} verified · ${failed} awaiting evidence`
      : "No requirements are present in this snapshot",
    target: "requirements",
  };
}

function approvalsEvidence(snapshot: DashboardSnapshot): AssuranceEvidence {
  const pending = snapshot.approvals.filter((approval) => approval.status === "pending");
  const highRisk = pending.filter((approval) => approval.risk === "high").length;
  return {
    id: "approvals",
    label: "Human approvals",
    state: pending.length > 0 ? "blocked" : "clear",
    evidence: pending.length
      ? `${pending.length} pending ${plural(pending.length, "request")} · ${highRisk} high risk`
      : "No pending approval requests in this snapshot",
    target: "approvals",
  };
}

function auditEvidence(snapshot: DashboardSnapshot): AssuranceEvidence {
  const verified = snapshot.audit.filter((event) => event.verified).length;
  return {
    id: "audit",
    label: "Decision provenance",
    state: snapshot.audit.length > 0 && verified === snapshot.audit.length ? "clear" : "attention",
    evidence: snapshot.audit.length
      ? `${verified}/${snapshot.audit.length} visible chain ${plural(snapshot.audit.length, "event")} verified`
      : "No audit events are present in this snapshot",
    target: "audit",
  };
}

export function buildMissionAssurance(
  snapshot: DashboardSnapshot,
  source: DataSourceState,
): MissionAssuranceBrief {
  const sourceState: AssuranceState = source === "live" ? "clear" : source === "demo" ? "blocked" : "attention";
  const evidence: AssuranceEvidence[] = [
    {
      id: "source",
      label: "Data provenance",
      state: sourceState,
      evidence: dataSourceDetail(source),
    },
    fleetEvidence(snapshot),
    routeEvidence(snapshot),
    simulationEvidence(snapshot),
    requirementsEvidence(snapshot),
    approvalsEvidence(snapshot),
    auditEvidence(snapshot),
  ];
  const blocked = evidence.filter((item) => item.state === "blocked").length;
  const attention = evidence.filter((item) => item.state === "attention").length;
  const clear = evidence.length - blocked - attention;
  const state: AssuranceState = blocked > 0 ? "blocked" : attention > 0 ? "attention" : "clear";
  const summary = blocked > 0
    ? `Physical release has ${blocked} blocking ${plural(blocked, "condition")}`
    : attention > 0
      ? `${attention} evidence ${plural(attention, "item")} need review`
      : "Current evidence checks are clear";
  return { state, summary, blocked, attention, clear, evidence };
}
