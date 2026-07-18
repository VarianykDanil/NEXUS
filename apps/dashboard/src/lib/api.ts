import { demoSnapshot } from "../data/demo";
import type {
  ApprovalStatus,
  DashboardSnapshot,
  EngineeringFindingDomain,
  EngineeringFindingSeverity,
  EngineeringReviewReadiness,
  EngineeringReviewResponse,
  OperatingMode,
  ProjectSummary,
  RealtimeEvent,
} from "../types";

type UnknownRecord = Record<string, unknown>;

export interface CommandResponse {
  message: string;
  hardwareCommandSent: boolean;
  project?: UnknownRecord;
  approval?: UnknownRecord | null;
}

export class NexusApiError extends Error {
  readonly status?: number;
  readonly offline: boolean;

  constructor(message: string, options: { status?: number; offline?: boolean } = {}) {
    super(message);
    this.name = "NexusApiError";
    this.status = options.status;
    this.offline = options.offline ?? false;
  }
}

const env = import.meta.env;

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getApiBaseUrl(): string {
  const configured = env.VITE_API_BASE_URL?.trim();
  if (!configured) return "/api/v1";
  const base = stripTrailingSlash(configured);
  return base.endsWith("/api/v1") ? base : `${base}/api/v1`;
}

export function buildApiUrl(path: string): string {
  return `${getApiBaseUrl()}/${path.replace(/^\/+/, "")}`;
}

export function getProjectSocketUrl(projectId: string): string {
  const encodedId = encodeURIComponent(projectId);
  const configured = env.VITE_WS_BASE_URL?.trim();
  if (configured) {
    const wsBase = stripTrailingSlash(configured)
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:");
    return `${wsBase}/ws/projects/${encodedId}`;
  }

  if (typeof window === "undefined") return `ws://localhost/ws/projects/${encodedId}`;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/projects/${encodedId}`;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function camelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [camelKey(key), camelize(item)]));
}

function unwrapPayload(value: unknown): UnknownRecord {
  if (!isRecord(value)) return {};
  const data = isRecord(value.data) ? value.data : value;
  if (isRecord(data.dashboard)) return data.dashboard;
  if (isRecord(data.snapshot)) return data.snapshot;
  return data;
}

function mergeObject<T extends object>(fallback: T, candidate: unknown): T {
  return isRecord(candidate) ? ({ ...fallback, ...candidate } as T) : fallback;
}

/** Converts backend snake_case envelopes into the stable UI domain model. */
export function normalizeDashboardSnapshot(
  payload: unknown,
  fallback: DashboardSnapshot = demoSnapshot,
): DashboardSnapshot {
  const root = camelize(unwrapPayload(payload)) as UnknownRecord;
  const buildingCandidate = isRecord(root.building) ? root.building : {};
  return {
    ...fallback,
    ...root,
    project: mergeObject(fallback.project, root.project),
    system: mergeObject(fallback.system, root.system),
    mission: mergeObject(fallback.mission, root.mission),
    robot: {
      ...mergeObject(fallback.robot, root.robot),
      pose: mergeObject(fallback.robot.pose, isRecord(root.robot) ? root.robot.pose : undefined),
    },
    robots: Array.isArray(root.robots) ? (root.robots as DashboardSnapshot["robots"]) : fallback.robots,
    building: {
      ...mergeObject(fallback.building, buildingCandidate),
      floors: Array.isArray(buildingCandidate.floors)
        ? (buildingCandidate.floors as DashboardSnapshot["building"]["floors"])
        : fallback.building.floors,
    },
    map: mergeObject(fallback.map, root.map),
    telemetry: Array.isArray(root.telemetry) ? (root.telemetry as DashboardSnapshot["telemetry"]) : fallback.telemetry,
    pipeline: Array.isArray(root.pipeline) ? (root.pipeline as DashboardSnapshot["pipeline"]) : fallback.pipeline,
    requirements: Array.isArray(root.requirements) ? (root.requirements as DashboardSnapshot["requirements"]) : fallback.requirements,
    architecture: Array.isArray(root.architecture) ? (root.architecture as DashboardSnapshot["architecture"]) : fallback.architecture,
    approvals: Array.isArray(root.approvals) ? (root.approvals as DashboardSnapshot["approvals"]) : fallback.approvals,
    audit: Array.isArray(root.audit) ? (root.audit as DashboardSnapshot["audit"]) : fallback.audit,
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (typeof fetch !== "function") throw new NexusApiError("Fetch is unavailable", { offline: true });
  let response: Response;
  try {
    response = await fetch(buildApiUrl(path), {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new NexusApiError("Unable to reach the NEXUS API", { offline: true });
  }
  if (!response.ok) {
    let detail = `NEXUS API returned ${response.status}`;
    try {
      const payload = await response.json() as unknown;
      if (isRecord(payload) && typeof payload.detail === "string") detail = payload.detail;
    } catch {
      // Preserve the status-based message when the error body is not JSON.
    }
    throw new NexusApiError(detail, { status: response.status });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function normalizeCommandResponse(payload: unknown): CommandResponse {
  const root = camelize(unwrapPayload(payload));
  if (!isRecord(root)) throw new NexusApiError("NEXUS API returned an invalid command response");
  return {
    message: typeof root.message === "string" ? root.message : "Command accepted by the control plane.",
    hardwareCommandSent: root.hardwareCommandSent === true,
    project: isRecord(root.project) ? root.project : undefined,
    approval: root.approval === null ? null : isRecord(root.approval) ? root.approval : undefined,
  };
}

const engineeringReadiness = new Set<EngineeringReviewReadiness>(["blocked", "needs_work", "ready_for_simulation"]);
const engineeringSeverities = new Set<EngineeringFindingSeverity>(["critical", "high", "medium", "low"]);
const engineeringDomains = new Set<EngineeringFindingDomain>([
  "requirements", "architecture", "software", "hardware", "safety",
  "simulation", "testing", "operations", "security",
]);

function requiredString(root: UnknownRecord, key: string): string {
  const value = root[key];
  if (typeof value !== "string" || !value.trim()) throw new NexusApiError("NEXUS API returned an invalid engineering review");
  return value;
}

function normalizeEngineeringReview(payload: unknown): EngineeringReviewResponse {
  const root = camelize(unwrapPayload(payload));
  if (!isRecord(root)
    || root.provider !== "openai"
    || root.promptVersion !== "engineering-review-v1"
    || typeof root.readiness !== "string"
    || !engineeringReadiness.has(root.readiness as EngineeringReviewReadiness)
    || !Array.isArray(root.findings)
    || root.findings.length === 0
    || root.advisoryOnly !== true
    || root.simulationOnly !== true
    || root.physicalExecutionEnabled !== false
    || root.hardwareCommandSent !== false) {
    throw new NexusApiError("NEXUS API returned an invalid engineering review safety boundary");
  }

  const findings = root.findings.map((item) => {
    if (!isRecord(item)
      || typeof item.severity !== "string"
      || !engineeringSeverities.has(item.severity as EngineeringFindingSeverity)
      || typeof item.domain !== "string"
      || !engineeringDomains.has(item.domain as EngineeringFindingDomain)
      || typeof item.requiresHumanApproval !== "boolean") {
      throw new NexusApiError("NEXUS API returned an invalid engineering review finding");
    }
    return {
      severity: item.severity as EngineeringFindingSeverity,
      domain: item.domain as EngineeringFindingDomain,
      evidence: requiredString(item, "evidence"),
      recommendation: requiredString(item, "recommendation"),
      requiresHumanApproval: item.requiresHumanApproval,
    };
  });

  return {
    projectId: requiredString(root, "projectId"),
    provider: "openai",
    model: requiredString(root, "model"),
    promptVersion: "engineering-review-v1",
    readiness: root.readiness as EngineeringReviewReadiness,
    summary: requiredString(root, "summary"),
    findings,
    nextExperiment: requiredString(root, "nextExperiment"),
    inputSha256: requiredString(root, "inputSha256"),
    generatedAt: requiredString(root, "generatedAt"),
    auditHash: requiredString(root, "auditHash"),
    advisoryOnly: true,
    simulationOnly: true,
    physicalExecutionEnabled: false,
    hardwareCommandSent: false,
  };
}

export async function listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
  const payload = await request<unknown>("projects", { signal });
  const root = camelize(payload) as unknown;
  if (Array.isArray(root)) return root as ProjectSummary[];
  if (isRecord(root) && Array.isArray(root.items)) return root.items as ProjectSummary[];
  if (isRecord(root) && Array.isArray(root.projects)) return root.projects as ProjectSummary[];
  return [];
}

export async function fetchProjectDashboard(
  projectId: string,
  fallback: DashboardSnapshot,
  signal?: AbortSignal,
): Promise<DashboardSnapshot> {
  const payload = await request<unknown>(`projects/${encodeURIComponent(projectId)}/dashboard`, { signal });
  return normalizeDashboardSnapshot(payload, fallback);
}

export async function createProject(name: string, objective: string): Promise<ProjectSummary> {
  const payload = await request<unknown>("projects", {
    method: "POST",
    body: JSON.stringify({ name, objective }),
  });
  const root = camelize(unwrapPayload(payload));
  if (!isRecord(root)) throw new NexusApiError("NEXUS API returned an invalid project response");
  return root as unknown as ProjectSummary;
}

export async function decideApproval(
  projectId: string,
  approvalId: string,
  decision: Exclude<ApprovalStatus, "pending">,
  reason?: string,
): Promise<CommandResponse> {
  const payload = await request<unknown>(`projects/${encodeURIComponent(projectId)}/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision, reason, comment: reason, decided_by: "operator" }),
  });
  return normalizeCommandResponse(payload);
}

export async function setOperatingMode(projectId: string, mode: OperatingMode): Promise<CommandResponse> {
  const payload = await request<unknown>(`projects/${encodeURIComponent(projectId)}/mode`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
  return normalizeCommandResponse(payload);
}

export async function triggerEmergencyStop(projectId: string): Promise<CommandResponse> {
  const payload = await request<unknown>(`projects/${encodeURIComponent(projectId)}/emergency-stop`, { method: "POST" });
  return normalizeCommandResponse(payload);
}

export async function requestEngineeringReview(projectId: string): Promise<EngineeringReviewResponse> {
  const payload = await request<unknown>(`projects/${encodeURIComponent(projectId)}/ai-review`, {
    method: "POST",
    body: JSON.stringify({ requested_by: "dashboard.user" }),
  });
  return normalizeEngineeringReview(payload);
}

export function connectProjectSocket(
  projectId: string,
  handlers: {
    onEvent: (event: RealtimeEvent) => void;
    onOpen: () => void;
    onClose: () => void;
  },
): WebSocket | undefined {
  if (typeof WebSocket === "undefined") return undefined;
  const socket = new WebSocket(getProjectSocketUrl(projectId));
  socket.onopen = handlers.onOpen;
  socket.onclose = handlers.onClose;
  socket.onerror = handlers.onClose;
  socket.onmessage = (message) => {
    try {
      handlers.onEvent(JSON.parse(String(message.data)) as RealtimeEvent);
    } catch {
      // Ignore malformed frames; the next authoritative snapshot reconciles state.
    }
  };
  return socket;
}
