export type OperatingMode = "SIMULATION" | "PHYSICAL";
export type HealthStatus = "nominal" | "warning" | "critical" | "offline";
export type TaskStatus = "complete" | "running" | "queued" | "blocked" | "failed";
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type EngineeringReviewReadiness = "blocked" | "needs_work" | "ready_for_simulation";
export type EngineeringFindingSeverity = "critical" | "high" | "medium" | "low";
export type EngineeringFindingDomain =
  | "requirements"
  | "architecture"
  | "software"
  | "hardware"
  | "safety"
  | "simulation"
  | "testing"
  | "operations"
  | "security";

export interface EngineeringReviewFinding {
  severity: EngineeringFindingSeverity;
  domain: EngineeringFindingDomain;
  evidence: string;
  recommendation: string;
  requiresHumanApproval: boolean;
}

export interface EngineeringReviewResponse {
  projectId: string;
  provider: "openai";
  model: string;
  promptVersion: "engineering-review-v1";
  readiness: EngineeringReviewReadiness;
  summary: string;
  findings: EngineeringReviewFinding[];
  nextExperiment: string;
  inputSha256: string;
  generatedAt: string;
  auditHash: string;
  advisoryOnly: true;
  simulationOnly: true;
  physicalExecutionEnabled: false;
  hardwareCommandSent: false;
}

export interface ProjectSummary {
  id: string;
  name: string;
  objective: string;
  updatedAt: string;
}

export interface SystemState {
  mode: OperatingMode;
  health: HealthStatus;
  connection: "online" | "degraded" | "offline";
  safetyLock: boolean;
  lastHeartbeat: string;
}

export interface MissionState {
  id: string;
  name: string;
  phase: string;
  activeTask: string;
  progress: number;
  currentStep: number;
  totalSteps: number;
  elapsed: string;
  eta: string;
}

export interface RobotState {
  id: string;
  name: string;
  model: string;
  pose: { x: number; y: number; yaw: number };
  battery: number;
  speed: number;
  temperature: number;
  latency: number;
  localization: number;
  status: HealthStatus;
}

export interface RobotCameraSource {
  name: string;
  label: string;
  width: number;
  height: number;
}

export interface RobotLinkStatus {
  adapter: "demo" | "spot" | "disabled";
  configured: boolean;
  connected: boolean;
  readOnly: true;
  robotName: string | null;
  serialNumber: string | null;
  softwareVersion: string | null;
  batteryPercent: number | null;
  cameraSources: RobotCameraSource[];
  lastSeenAt: string | null;
  message: string;
}

export interface DemoMotionStatus {
  enabled: boolean;
  running: boolean;
  simulationOnly: true;
  frameIntervalSeconds: number;
  speedMultiplier: number;
  message: string;
  hardwareCommandSent: false;
}

export interface RobotJobTarget {
  floorId: string;
  x: number;
  y: number;
  roomId?: string;
  roomLabel?: string;
}

export type RobotJobStatus = "planned" | "running" | "completed" | "blocked" | "failed" | "cancelled";

export interface RobotJobStep {
  id: string;
  title: string;
  detail: string;
  status: "queued" | "running" | "completed" | "blocked" | "failed";
  capability: string;
  evidence: string | null;
}

export interface RobotJob {
  id: string;
  projectId: string;
  instruction: string;
  status: RobotJobStatus;
  executionMode: "simulation" | "physical";
  risk: "low" | "medium" | "high" | "critical";
  requestedBy: string;
  assignedRobotId: string;
  assignedRobotName: string;
  targetFloorId: string;
  targetRoomId: string | null;
  targetRoomLabel: string | null;
  targetX: number;
  targetY: number;
  progress: number;
  memoryContext: {
    planner?: string;
    mapFrame?: string;
    mapRevision?: string;
    targetResolution?: string;
    matchedMemoryKeys?: string[];
    procedure?: string;
    knownHazardsOnFloor?: number;
    routeDistanceMetres?: number;
    route?: Array<{ floorId: string; x: number; y: number; yaw: number }>;
    whyThisRobot?: string;
    [key: string]: unknown;
  };
  steps: RobotJobStep[];
  result: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RobotMemory {
  id: string;
  projectId: string;
  key: string;
  kind: "location" | "procedure" | "experience";
  label: string;
  content: Record<string, unknown>;
  confidence: number;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface MapRoom {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  explored: number;
}

export interface MapPoint {
  x: number;
  y: number;
}

export interface Hazard {
  id: string;
  type: string;
  severity: "low" | "medium" | "high";
  x: number;
  y: number;
  confidence: number;
  detectedAt: string;
}

export interface MapState {
  coverage: number;
  area: number;
  floor: string;
  rooms: MapRoom[];
  path: MapPoint[];
  hazards: Hazard[];
}

export interface TelemetryMetric {
  id: string;
  label: string;
  value: number;
  unit: string;
  trend: number[];
  status: HealthStatus;
  detail: string;
}

export interface PipelineTask {
  id: string;
  label: string;
  category: "plan" | "code" | "test" | "simulate" | "deploy";
  status: TaskStatus;
  duration?: string;
  detail: string;
  startedAt?: string;
}

export interface Requirement {
  id: string;
  title: string;
  source: string;
  component: string;
  verification: string;
  status: "verified" | "in-progress" | "unverified";
}

export interface ArchitectureNode {
  id: string;
  label: string;
  kind: "interface" | "service" | "robot" | "data";
  status: HealthStatus;
}

export interface Approval {
  id: string;
  title: string;
  description: string;
  risk: "low" | "medium" | "high";
  status: ApprovalStatus;
  requestedBy: string;
  requestedAt: string;
  scope: string[];
}

export interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  rationale: string;
  timestamp: string;
  hash: string;
  previousHash: string;
  verified: boolean;
}

export interface DashboardSnapshot {
  project: ProjectSummary;
  system: SystemState;
  mission: MissionState;
  robot: RobotState;
  robots: FleetRobot[];
  building: BuildingState;
  map: MapState;
  telemetry: TelemetryMetric[];
  pipeline: PipelineTask[];
  requirements: Requirement[];
  architecture: ArchitectureNode[];
  approvals: Approval[];
  audit: AuditEntry[];
}

export interface RealtimeEvent {
  schema_version?: string;
  stream_id?: string;
  type: string;
  sequence?: number;
  timestamp?: string;
  emitted_at?: string;
  project_id?: string;
  payload?: Record<string, unknown>;
  data?: unknown;
}
import type { BuildingState, FleetRobot } from "./components/spatial/model";

export type {
  BuildingFloor,
  BuildingState,
  FleetRobot,
  RobotPose,
  SpatialHazard,
  TrailPoint,
} from "./components/spatial/model";
