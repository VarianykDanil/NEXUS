import type { DashboardSnapshot, ProjectSummary } from "../types";
import { demoBuilding, demoRobots } from "./spatialDemo";

export const demoProjects: ProjectSummary[] = [
  {
    id: "aegis-scout",
    name: "Aegis Scout",
    objective: "Explore Level 02, detect hazards, and produce a verified 3D map.",
    updatedAt: "12 sec ago",
  },
  {
    id: "warehouse-sentinel",
    name: "Warehouse Sentinel",
    objective: "Inspect aisles after hours and flag blocked evacuation routes.",
    updatedAt: "2 hr ago",
  },
];

export const demoSnapshot: DashboardSnapshot = {
  project: demoProjects[0],
  system: {
    mode: "SIMULATION",
    health: "nominal",
    connection: "online",
    safetyLock: true,
    lastHeartbeat: "2 sec ago",
  },
  mission: {
    id: "MSN-0241",
    name: "Level 02 reconnaissance",
    phase: "Autonomous exploration",
    activeTask: "Resolve east corridor frontier",
    progress: 68,
    currentStep: 7,
    totalSteps: 10,
    elapsed: "18m 42s",
    eta: "~9 min",
  },
  robot: {
    id: "RBT-07",
    name: "Scout 07",
    model: "NEXUS M2",
    pose: { x: 12.4, y: 7.8, yaw: 132 },
    battery: 78,
    speed: 0.34,
    temperature: 47,
    latency: 42,
    localization: 97.4,
    status: "nominal",
  },
  robots: demoRobots,
  building: demoBuilding,
  map: {
    coverage: 74,
    area: 386,
    floor: "Level 02",
    rooms: [
      { id: "r1", label: "LOBBY", x: 45, y: 52, width: 190, height: 134, explored: 100 },
      { id: "r2", label: "LAB 2A", x: 254, y: 52, width: 198, height: 134, explored: 100 },
      { id: "r3", label: "UTILITY", x: 470, y: 52, width: 144, height: 134, explored: 88 },
      { id: "r4", label: "WEST OFFICE", x: 45, y: 240, width: 190, height: 126, explored: 100 },
      { id: "r5", label: "CENTRAL HALL", x: 254, y: 204, width: 198, height: 162, explored: 72 },
      { id: "r6", label: "EAST CORRIDOR", x: 470, y: 204, width: 260, height: 70, explored: 61 },
      { id: "r7", label: "STORAGE", x: 590, y: 294, width: 140, height: 72, explored: 22 },
    ],
    path: [
      { x: 98, y: 118 }, { x: 182, y: 118 }, { x: 280, y: 118 }, { x: 368, y: 120 },
      { x: 366, y: 226 }, { x: 420, y: 246 }, { x: 515, y: 238 }, { x: 578, y: 238 },
    ],
    hazards: [
      { id: "HZ-19", type: "Thermal anomaly", severity: "high", x: 522, y: 118, confidence: 94, detectedAt: "4 min ago" },
      { id: "HZ-22", type: "Blocked passage", severity: "medium", x: 648, y: 238, confidence: 87, detectedAt: "38 sec ago" },
    ],
  },
  telemetry: [
    { id: "battery", label: "Battery", value: 78, unit: "%", trend: [88, 87, 86, 85, 84, 82, 81, 80, 79, 78], status: "nominal", detail: "2h 14m estimated" },
    { id: "lidar", label: "LiDAR", value: 10.2, unit: "Hz", trend: [10.0, 10.1, 9.9, 10.2, 10.1, 10.3, 10.2, 10.2, 10.1, 10.2], status: "nominal", detail: "18,440 points/frame" },
    { id: "latency", label: "Uplink", value: 42, unit: "ms", trend: [39, 45, 41, 47, 44, 38, 36, 40, 46, 42], status: "nominal", detail: "99.8% packet delivery" },
    { id: "temperature", label: "Compute", value: 47, unit: " deg C", trend: [42, 43, 44, 45, 44, 46, 46, 47, 46, 47], status: "nominal", detail: "Jetson load 63%" },
  ],
  pipeline: [
    { id: "p1", label: "Decompose objective", category: "plan", status: "complete", duration: "1m 08s", detail: "14 requirements accepted" },
    { id: "p2", label: "Generate navigation stack", category: "code", status: "complete", duration: "4m 32s", detail: "31 files / 2,840 LOC" },
    { id: "p3", label: "Unit & integration tests", category: "test", status: "complete", duration: "2m 41s", detail: "184 / 184 passing" },
    { id: "p4", label: "Gazebo mission trial 06", category: "simulate", status: "running", startedAt: "18m ago", detail: "7 / 10 checkpoints" },
    { id: "p5", label: "Safety gate review", category: "deploy", status: "blocked", detail: "Awaiting 2 approvals" },
    { id: "p6", label: "Deploy to Scout 07", category: "deploy", status: "queued", detail: "Physical action locked" },
  ],
  requirements: [
    { id: "REQ-NAV-01", title: "Navigate unknown indoor spaces without collision", source: "User objective", component: "Navigation", verification: "SIM-NAV-44", status: "verified" },
    { id: "REQ-MAP-03", title: "Generate a metrically consistent occupancy map", source: "Derived", component: "SLAM", verification: "SIM-MAP-17", status: "verified" },
    { id: "REQ-HZD-02", title: "Identify thermal and obstruction hazards", source: "User objective", component: "Perception", verification: "SIM-HAZ-09", status: "in-progress" },
    { id: "REQ-SAF-05", title: "Require approval before actuator enablement", source: "Safety policy", component: "Safety gate", verification: "HIL-SAF-03", status: "verified" },
    { id: "REQ-AUD-01", title: "Record every autonomous decision immutably", source: "Platform policy", component: "Audit service", verification: "INT-AUD-11", status: "verified" },
  ],
  architecture: [
    { id: "ui", label: "Operator Console", kind: "interface", status: "nominal" },
    { id: "orchestrator", label: "Mission Orchestrator", kind: "service", status: "nominal" },
    { id: "perception", label: "Perception", kind: "service", status: "nominal" },
    { id: "navigation", label: "Navigation", kind: "service", status: "nominal" },
    { id: "safety", label: "Safety Gate", kind: "service", status: "warning" },
    { id: "robot", label: "ROS 2 / Scout 07", kind: "robot", status: "nominal" },
    { id: "store", label: "Experiment Store", kind: "data", status: "nominal" },
  ],
  approvals: [
    {
      id: "APR-109", title: "Enable wheel actuators", description: "Permit Scout 07 to execute the validated Level 02 route at a capped speed of 0.5 m/s.",
      risk: "high", status: "pending", requestedBy: "Safety Gate", requestedAt: "2 min ago",
      scope: ["Scout 07 only", "Level 02 geofence", "30 minute expiry"],
    },
    {
      id: "APR-112", title: "Upload repaired navigation node", description: "Replace local_planner v0.8.4 with the simulation-tested v0.8.5 build.",
      risk: "medium", status: "pending", requestedBy: "Repair Agent", requestedAt: "46 sec ago",
      scope: ["Signed artifact sha256:91e...c42", "Rollback enabled"],
    },
  ],
  audit: [
    { id: "EVT-8842", action: "Approval requested", actor: "Safety Gate", rationale: "Physical actuator command crossed policy boundary SAF-P02.", timestamp: "14:32:18", hash: "91e7c42a", previousHash: "d03fe812", verified: true },
    { id: "EVT-8841", action: "Route replanned", actor: "Navigation Agent", rationale: "Obstacle occupied east corridor waypoint for 8.4 seconds.", timestamp: "14:31:52", hash: "d03fe812", previousHash: "cc18a701", verified: true },
    { id: "EVT-8840", action: "Hazard classified", actor: "Perception Agent", rationale: "Thermal region exceeded 67 deg C with 94% confidence.", timestamp: "14:29:06", hash: "cc18a701", previousHash: "b144fe66", verified: true },
    { id: "EVT-8839", action: "Simulation checkpoint", actor: "Mission Orchestrator", rationale: "Checkpoint 6 satisfied; localization error remained below 4 cm.", timestamp: "14:28:41", hash: "b144fe66", previousHash: "a0098c22", verified: true },
  ],
};

export function demoForProject(project: ProjectSummary): DashboardSnapshot {
  if (project.id === demoSnapshot.project.id) return structuredClone(demoSnapshot);
  return {
    ...structuredClone(demoSnapshot),
    project,
    mission: {
      ...demoSnapshot.mission,
      id: "MSN-0186",
      name: "Evacuation route inspection",
      phase: "Ready for simulation",
      activeTask: "Validate aisle clearance model",
      progress: 24,
      currentStep: 2,
    },
    system: { ...demoSnapshot.system, connection: "degraded", lastHeartbeat: "19 sec ago" },
  };
}
