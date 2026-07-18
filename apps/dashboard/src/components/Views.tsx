import {
  AlertTriangle,
  ArrowRight,
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Code2,
  Database,
  FlaskConical,
  GitBranch,
  LockKeyhole,
  MapPin,
  Navigation,
  Radio,
  Route,
  ScanLine,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  TestTube2,
  X,
  XCircle,
} from "lucide-react";
import { dataSourceLabel, spatialStreamStatus, type DataSourceState } from "../lib/dataSource";
import { buildMissionAssurance, type AssuranceEvidence } from "../lib/missionAssurance";
import type {
  Approval,
  ApprovalStatus,
  DashboardSnapshot,
  EngineeringReviewFinding,
  EngineeringReviewResponse,
  PipelineTask,
  Requirement,
  TaskStatus,
} from "../types";
import { DigitalTwinViewport } from "./spatial";
import { ProgressRing, StatusDot, TelemetryCard, statusClass } from "./Visuals";

interface ViewProps {
  snapshot: DashboardSnapshot;
  source: DataSourceState;
  onNavigate: (view: string) => void;
  onDecision: (approval: Approval, decision: Exclude<ApprovalStatus, "pending">) => void;
  engineeringReview: EngineeringReviewResponse | null;
  engineeringReviewError: string | null;
  reviewPending: boolean;
  onRequestEngineeringReview: () => void;
}

const taskIcons = {
  plan: GitBranch,
  code: Code2,
  test: TestTube2,
  simulate: FlaskConical,
  deploy: Box,
};

const taskStatusLabel: Record<TaskStatus, string> = {
  complete: "Complete",
  running: "Running",
  queued: "Queued",
  blocked: "Approval required",
  failed: "Failed",
};

function spatialCoverage(snapshot: DashboardSnapshot): number {
  const floors = snapshot.building.floors;
  if (floors.length === 0) return snapshot.map.coverage;
  return floors.reduce((total, floor) => total + floor.coverage, 0) / floors.length;
}

function spatialHazardCount(snapshot: DashboardSnapshot): number {
  return snapshot.building.floors.reduce((total, floor) => total + floor.hazards.length, 0);
}

function activeFloorLabel(snapshot: DashboardSnapshot): string {
  const active = snapshot.robots[0];
  if (!active) return "Building";
  return snapshot.building.floors.find((floor) => floor.id === active.pose.floorId)?.label ?? active.pose.floorId;
}

function PanelHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) {
  return (
    <div className="panel-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}

function MissionStatus({ snapshot }: { snapshot: DashboardSnapshot }) {
  const { mission } = snapshot;
  const coverage = spatialCoverage(snapshot);
  const hazards = spatialHazardCount(snapshot);
  const phase = mission.phase.toLowerCase();
  const simulationComplete = phase.includes("complete") || mission.progress >= 100;
  const physicalReleasePending = simulationComplete && snapshot.pipeline.some(
    (task) => task.category === "deploy" && task.status !== "complete",
  );
  const halted = phase.includes("emergency")
    || phase.includes("rejected")
    || snapshot.pipeline.some((task) => task.status === "failed");
  const gated = phase.includes("approval") || snapshot.pipeline.some((task) => task.status === "blocked");
  const running = snapshot.pipeline.some((task) => task.status === "running")
    || (mission.progress > 0 && mission.progress < 100);
  const stateLabel = halted
    ? "HALTED"
    : physicalReleasePending
      ? "SIM COMPLETE"
      : simulationComplete
        ? "COMPLETE"
        : gated
          ? "GATED"
          : running
            ? "RUNNING"
            : "READY";
  const progressLabel = physicalReleasePending ? "Simulation progress" : "Mission progress";
  return (
    <section className="panel mission-status-panel">
      <PanelHeader
        eyebrow={mission.id}
        title="Simulation & release status"
        action={<span className="live-badge"><span /> {stateLabel}</span>}
      />
      <div className="mission-progress-layout">
        <ProgressRing value={mission.progress} label={progressLabel} />
        <div className="mission-progress-copy">
          <span className="eyebrow">{physicalReleasePending ? "NEXT SAFETY GATE" : "CURRENT OPERATION"}</span>
          <h3>{mission.activeTask}</h3>
          <p>{mission.phase}{physicalReleasePending ? " · physical release gated" : ""}</p>
          <div className="progress-track" aria-label={`${progressLabel}: step ${mission.currentStep} of ${mission.totalSteps}`}>
            <span style={{ width: `${mission.progress}%` }} />
          </div>
          <div className="progress-meta">
            <span>Step {mission.currentStep} / {mission.totalSteps}</span>
            <span>{physicalReleasePending ? "Physical release gated" : `ETA ${mission.eta}`}</span>
          </div>
        </div>
      </div>
      <dl className="mission-facts">
        <div><dt>Elapsed</dt><dd>{mission.elapsed}</dd></div>
        <div><dt>Coverage</dt><dd>{coverage.toFixed(1)}%</dd></div>
        <div><dt>Hazards</dt><dd className="warning-text">{hazards} active</dd></div>
      </dl>
    </section>
  );
}

function AssuranceEvidenceRow({ item, onNavigate }: { item: AssuranceEvidence; onNavigate: (view: string) => void }) {
  const Icon = item.state === "clear" ? CheckCircle2 : item.state === "blocked" ? ShieldAlert : AlertTriangle;
  const contents = (
    <>
      <span className={`assurance-evidence-icon state-${item.state}`}><Icon size={17} aria-hidden="true" /></span>
      <span className="assurance-evidence-copy"><strong>{item.label}</strong><small>{item.evidence}</small></span>
      <span className={`assurance-evidence-state state-${item.state}`}>{item.state}</span>
      {item.target && <ChevronRight size={15} aria-hidden="true" />}
    </>
  );
  if (!item.target) return <div className="assurance-evidence-row">{contents}</div>;
  return (
    <button
      type="button"
      className="assurance-evidence-row is-action"
      aria-label={`${item.label}: ${item.state}. ${item.evidence}. Open related evidence.`}
      onClick={() => onNavigate(item.target!)}
    >
      {contents}
    </button>
  );
}

function MissionAssurance({ snapshot, source, onNavigate }: Pick<ViewProps, "snapshot" | "source" | "onNavigate">) {
  const brief = buildMissionAssurance(snapshot, source);
  return (
    <section className="panel mission-assurance-panel" aria-labelledby="mission-assurance-title">
      <PanelHeader
        eyebrow="EXPLAINABLE SAFETY CASE"
        title="Mission assurance brief"
        action={<span className={`assurance-summary-chip state-${brief.state}`}>{brief.blocked} blocked · {brief.attention} review</span>}
      />
      <div className="assurance-overview">
        <span className={`assurance-overview-icon state-${brief.state}`}><ShieldCheck size={21} aria-hidden="true" /></span>
        <span>
          <strong id="mission-assurance-title">{brief.summary}</strong>
          <small>Derived from the visible snapshot. The control-plane policy engine remains authoritative.</small>
        </span>
        <span className="assurance-count"><strong>{brief.clear}/{brief.evidence.length}</strong><small>checks clear</small></span>
      </div>
      <div className="assurance-evidence-grid">
        {brief.evidence.map((item) => <AssuranceEvidenceRow key={item.id} item={item} onNavigate={onNavigate} />)}
      </div>
    </section>
  );
}

function PipelineCompact({ tasks, onNavigate }: { tasks: PipelineTask[]; onNavigate: (view: string) => void }) {
  return (
    <section className="panel pipeline-compact">
      <PanelHeader
        eyebrow="AUTONOMOUS WORKFLOW"
        title="Execution pipeline"
        action={<button className="text-button" onClick={() => onNavigate("pipeline")}>View run <ArrowRight size={14} /></button>}
      />
      <div className="pipeline-mini-list">
        {tasks.slice(0, 5).map((task, index) => {
          const Icon = taskIcons[task.category];
          return (
            <div className={`pipeline-mini-row ${statusClass(task.status)}`} key={task.id}>
              <span className="pipeline-rail" aria-hidden="true">{index < 4 && <i />}</span>
              <span className="task-icon"><Icon size={15} aria-hidden="true" /></span>
              <span className="task-copy"><strong>{task.label}</strong><small>{task.detail}</small></span>
              <span className="task-state">{task.status === "complete" ? <Check size={14} /> : task.status === "running" ? <span className="spinner" /> : task.status === "blocked" ? <LockKeyhole size={13} /> : <Clock3 size={13} />}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function MissionView({ snapshot, source, onNavigate }: ViewProps) {
  const pendingCount = snapshot.approvals.filter((approval) => approval.status === "pending").length;
  const primaryRobot = snapshot.robots[0];
  const coverage = spatialCoverage(snapshot);
  const mappedArea = snapshot.building.floors.reduce(
    (total, floor) => total + (floor.width * floor.depth * floor.coverage) / 100,
    0,
  );
  const pose = primaryRobot?.pose ?? snapshot.robot.pose;
  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <span className="eyebrow">MISSION CONTROL / {activeFloorLabel(snapshot).toUpperCase()}</span>
          <h1>{snapshot.mission.name}</h1>
          <p>Live autonomous operations, perception, and safety state.</p>
        </div>
        <div className="heading-actions">
          <span className="sync-state"><Radio size={14} /> {source === "live" ? "Live WebSocket" : source === "snapshot" ? "API snapshot" : source === "connecting" ? "Connecting" : "Demo snapshot"} <b>{snapshot.robots.length} robots</b></span>
          <button className="button secondary" onClick={() => onNavigate("twin")}><ScanLine size={16} /> Open digital twin</button>
        </div>
      </div>

      {pendingCount > 0 && (
        <button className="approval-banner" onClick={() => onNavigate("approvals")}>
          <span className="approval-banner-icon"><ShieldAlert size={18} /></span>
          <span><strong>{pendingCount} physical {pendingCount === 1 ? "action" : "actions"} awaiting approval</strong><small>Safety gate is holding deployment until an operator reviews the requested scope.</small></span>
          <span className="approval-banner-action">Review now <ChevronRight size={16} /></span>
        </button>
      )}

      <div className="mission-dashboard-grid">
        <section className="panel map-panel">
          <PanelHeader
            eyebrow="METRIC BUILDING PLAN"
            title={`${snapshot.building.name} · live fleet`}
            action={
              <div className="map-header-stats">
                <span><strong>{mappedArea.toFixed(0)}</strong> m² mapped</span>
                <span><strong>{coverage.toFixed(1)}</strong>% coverage</span>
              </div>
            }
          />
          <DigitalTwinViewport
            building={snapshot.building}
            robots={snapshot.robots}
            activeRobotId={primaryRobot?.id}
            streamStatus={spatialStreamStatus(source)}
            compact
          />
        </section>
        <div className="mission-side-stack">
          <MissionStatus snapshot={snapshot} />
          <PipelineCompact tasks={snapshot.pipeline} onNavigate={onNavigate} />
        </div>
      </div>

      <MissionAssurance snapshot={snapshot} source={source} onNavigate={onNavigate} />

      <section className="telemetry-section" aria-labelledby="telemetry-title">
        <div className="section-inline-heading">
          <div><span className="eyebrow">ROBOT TELEMETRY</span><h2 id="telemetry-title">{primaryRobot?.name ?? snapshot.robot.name} live systems</h2></div>
          <span className="robot-pose-label"><Navigation size={14} /> Pose {pose.x.toFixed(1)}, {pose.y.toFixed(1)} / {pose.yaw.toFixed(0)} deg</span>
        </div>
        <div className="telemetry-grid">
          {snapshot.telemetry.map((metric) => <TelemetryCard metric={metric} key={metric.id} />)}
        </div>
      </section>
    </div>
  );
}

export function TwinView({ snapshot, source }: ViewProps) {
  const primaryRobot = snapshot.robots[0];
  return (
    <div className="view-stack">
      <div className="page-heading">
        <div><span className="eyebrow">DIGITAL TWIN / LIVE</span><h1>Spatial intelligence</h1><p>Metric floor plans, a navigable 3D building, and every robot on one live frame.</p></div>
        <div className="heading-actions">
          <span className={`live-badge stream-${source}`}><span /> {source === "live" ? "LIVE WEBSOCKET" : dataSourceLabel(source)}</span>
          <span className="simulation-only-badge">SIMULATION ONLY · NO HARDWARE COMMANDS</span>
        </div>
      </div>
      <section className="panel twin-spatial-panel">
        <PanelHeader
          eyebrow="BUILDING_ENU / METRES"
          title={snapshot.building.name}
          action={<span className="version-chip">{snapshot.building.floors.length} FLOORS · {snapshot.robots.length} ROBOTS</span>}
        />
        <DigitalTwinViewport
          building={snapshot.building}
          robots={snapshot.robots}
          activeRobotId={primaryRobot?.id}
          streamStatus={spatialStreamStatus(source)}
        />
      </section>
    </div>
  );
}

function RequirementStatus({ requirement }: { requirement: Requirement }) {
  if (requirement.status === "verified") return <span className="requirement-state verified"><CheckCircle2 size={14} /> Verified</span>;
  if (requirement.status === "in-progress") return <span className="requirement-state in-progress"><span className="spinner" /> In progress</span>;
  return <span className="requirement-state"><Clock3 size={14} /> Unverified</span>;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function requirementsToCsv(projectName: string, requirements: Requirement[]): string {
  const header = ["Project", "ID", "Requirement", "Source", "Component", "Verification evidence", "Status"];
  const rows = requirements.map((requirement) => [
    projectName,
    requirement.id,
    requirement.title,
    requirement.source,
    requirement.component,
    requirement.verification,
    requirement.status,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function requirementExportName(projectName: string): string {
  const stem = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "nexus";
  return `${stem}-requirements.csv`;
}

function requirementExportHref(projectName: string, requirements: Requirement[]): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${requirementsToCsv(projectName, requirements)}`)}`;
}

function reviewReadinessLabel(readiness: EngineeringReviewResponse["readiness"]): string {
  if (readiness === "ready_for_simulation") return "Ready for simulation";
  if (readiness === "needs_work") return "Needs work";
  return "Blocked";
}

function reviewDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function ReviewFinding({ finding }: { finding: EngineeringReviewFinding }) {
  return (
    <li className={`engineering-review-finding severity-${finding.severity}`}>
      <div className="engineering-review-finding-head">
        <span className={`review-severity severity-${finding.severity}`}>{finding.severity}</span>
        <span className="review-domain">{finding.domain}</span>
        {finding.requiresHumanApproval && <span className="review-human-gate"><LockKeyhole size={13} aria-hidden="true" /> Human approval required</span>}
      </div>
      <p><strong>Evidence</strong>{finding.evidence}</p>
      <p><strong>Recommendation</strong>{finding.recommendation}</p>
    </li>
  );
}

function EngineeringReviewPanel({ review }: { review: EngineeringReviewResponse }) {
  return (
    <section className="panel engineering-review-panel" aria-labelledby="engineering-review-title">
      <div className="engineering-review-head">
        <span className="engineering-review-mark"><Sparkles size={20} aria-hidden="true" /></span>
        <div>
          <span className="eyebrow">OPENAI ENGINEERING REVIEW</span>
          <h2 id="engineering-review-title">Independent evidence review</h2>
          <p>Generated by {review.provider} / {review.model} · {reviewDateLabel(review.generatedAt)}</p>
        </div>
        <span className={`review-readiness readiness-${review.readiness}`}>{reviewReadinessLabel(review.readiness)}</span>
      </div>
      <div className="engineering-review-boundary" aria-label="Review safety boundary">
        <span><ShieldCheck size={14} aria-hidden="true" /> Advisory only</span>
        <span><FlaskConical size={14} aria-hidden="true" /> Simulation only</span>
        <span><LockKeyhole size={14} aria-hidden="true" /> Physical execution disabled</span>
        <span><CheckCircle2 size={14} aria-hidden="true" /> No hardware command sent</span>
      </div>
      <p className="engineering-review-summary">{review.summary}</p>
      <div className="engineering-review-body">
        <section aria-labelledby="engineering-findings-title">
          <div className="engineering-review-section-title"><span className="eyebrow">FINDINGS</span><h3 id="engineering-findings-title">{review.findings.length} evidence-based {review.findings.length === 1 ? "finding" : "findings"}</h3></div>
          <ol className="engineering-review-findings">
            {review.findings.map((finding, index) => <ReviewFinding key={`${finding.domain}-${finding.severity}-${index}`} finding={finding} />)}
          </ol>
        </section>
        <aside className="engineering-review-next" aria-labelledby="next-experiment-title">
          <span className="eyebrow">NEXT EXPERIMENT</span>
          <h3 id="next-experiment-title">Recommended validation step</h3>
          <p>{review.nextExperiment}</p>
        </aside>
      </div>
      <details className="engineering-review-provenance">
        <summary>Review provenance and audit proof</summary>
        <dl>
          <div><dt>Provider / model</dt><dd>{review.provider} / {review.model}</dd></div>
          <div><dt>Prompt contract</dt><dd><code>{review.promptVersion}</code></dd></div>
          <div><dt>Input SHA-256</dt><dd><code>{review.inputSha256}</code></dd></div>
          <div><dt>Audit hash</dt><dd><code>{review.auditHash}</code></dd></div>
        </dl>
      </details>
    </section>
  );
}

export function RequirementsView({
  snapshot,
  source,
  engineeringReview,
  engineeringReviewError,
  reviewPending,
  onRequestEngineeringReview,
}: ViewProps) {
  const verified = snapshot.requirements.filter((item) => item.status === "verified").length;
  const objectiveRequirements = snapshot.requirements.filter((item) => item.source === "User objective").length;
  const derivedRequirements = snapshot.requirements.length - objectiveRequirements;
  const unverified = snapshot.requirements.length - verified;
  const traced = snapshot.requirements.filter((item) => item.component.trim() && item.verification.trim()).length;
  const traceCoverage = Math.round((traced / Math.max(1, snapshot.requirements.length)) * 100);
  return (
    <div className="view-stack">
      <div className="page-heading">
        <div><span className="eyebrow">ENGINEERING DEFINITION</span><h1>Requirements & architecture</h1><p>Trace the objective from intent through implementation and verification evidence.</p></div>
        <div className="heading-actions requirements-heading-actions">
          <span className="traceability-score"><ShieldCheck size={16} /> {verified}/{snapshot.requirements.length} verified</span>
          <div className="engineering-review-action">
            <button
              type="button"
              className="button primary"
              disabled={reviewPending || source === "demo" || source === "connecting"}
              aria-describedby="engineering-review-action-note"
              aria-label={reviewPending ? "OpenAI engineering review in progress" : "Run OpenAI engineering review"}
              onClick={onRequestEngineeringReview}
            >
              {reviewPending ? <span className="spinner" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
              {reviewPending ? "Reviewing evidence..." : "Run OpenAI review"}
            </button>
            <small id="engineering-review-action-note">
              {source === "demo"
                ? "Requires a connected NEXUS API; no demo AI result is generated."
                : source === "connecting"
                  ? "Waiting for API connection confirmation."
                  : "Advisory evidence only · never launches or approves hardware."}
            </small>
          </div>
        </div>
      </div>
      <div className="requirement-summary-grid">
        <article><span>Requirements</span><strong>{snapshot.requirements.length}</strong><small>{objectiveRequirements} objective / {derivedRequirements} derived</small></article>
        <article><span>Trace coverage</span><strong>{traceCoverage}%</strong><small>{traced}/{snapshot.requirements.length} linked to component and evidence</small></article>
        <article><span>Verification</span><strong>{Math.round((verified / Math.max(1, snapshot.requirements.length)) * 100)}%</strong><small>{unverified} {unverified === 1 ? "item" : "items"} awaiting evidence</small></article>
      </div>
      {engineeringReviewError && (
        <div className="engineering-review-error" role="alert">
          <AlertTriangle size={20} aria-hidden="true" />
          <span><strong>OpenAI review unavailable</strong><small>{engineeringReviewError}</small></span>
        </div>
      )}
      {engineeringReview && <EngineeringReviewPanel review={engineeringReview} />}
      <div className="requirements-layout">
        <section className="panel architecture-panel">
          <PanelHeader eyebrow="SYSTEM TOPOLOGY" title="Prototype architecture" action={<span className="version-chip">{snapshot.architecture.length} PLANNED COMPONENTS</span>} />
          <div className="architecture-graph" aria-label="NEXUS prototype architecture">
            <div className="architecture-column">
              <span className="architecture-column-label">OPERATOR</span>
              <ArchitectureCard icon={<TerminalSquare size={17} />} label="Operator Console" meta="React / WebSocket" />
            </div>
            <ArrowRight className="architecture-arrow" />
            <div className="architecture-column">
              <span className="architecture-column-label">CONTROL</span>
              <ArchitectureCard icon={<Server size={17} />} label="Mission Orchestrator" meta="Python control plane" />
              <ArchitectureCard icon={<Database size={17} />} label="Experiment Store" meta="PostgreSQL evidence" quiet />
            </div>
            <ArrowRight className="architecture-arrow" />
            <div className="architecture-column service-cluster">
              <span className="architecture-column-label">AUTONOMY</span>
              <ArchitectureCard icon={<ScanLine size={17} />} label="Perception" meta="Simulated hazard feed" warning />
              <ArchitectureCard icon={<Route size={17} />} label="Navigation" meta="C++ safety primitive" />
              <ArchitectureCard icon={<ShieldCheck size={17} />} label="Safety Gate" meta="Policy gate active" warning />
            </div>
            <ArrowRight className="architecture-arrow" />
            <div className="architecture-column">
              <span className="architecture-column-label">PLATFORM</span>
              <ArchitectureCard icon={<Navigation size={17} />} label={snapshot.robots[0]?.name ?? snapshot.robot.name} meta="Digital twin · no ROS link" warning />
            </div>
          </div>
        </section>
        <section className="panel requirement-panel">
          <PanelHeader
            eyebrow="TRACEABILITY MATRIX"
            title="Objective coverage"
            action={(
              <a
                className="icon-label-button"
                href={requirementExportHref(snapshot.project.name, snapshot.requirements)}
                download={requirementExportName(snapshot.project.name)}
              >
                Export matrix
              </a>
            )}
          />
          <div className="requirement-table" role="table" aria-label="Requirements traceability">
            <div className="requirement-table-head" role="row">
              <span>ID / REQUIREMENT</span><span>COMPONENT</span><span>EVIDENCE</span><span>STATUS</span>
            </div>
            {snapshot.requirements.map((requirement) => (
              <div className="requirement-row" role="row" key={requirement.id}>
                <span><code>{requirement.id}</code><strong>{requirement.title}</strong><small>{requirement.source}</small></span>
                <span>{requirement.component}</span>
                <span><code>{requirement.verification}</code></span>
                <span><RequirementStatus requirement={requirement} /></span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function ArchitectureCard({ icon, label, meta, quiet, warning }: { icon: React.ReactNode; label: string; meta: string; quiet?: boolean; warning?: boolean }) {
  return (
    <div className={`architecture-card${quiet ? " quiet" : ""}${warning ? " warning" : ""}`}>
      <span>{icon}</span><div><strong>{label}</strong><small>{meta}</small></div><StatusDot status={warning ? "warning" : "nominal"} />
    </div>
  );
}

export function PipelineView({ snapshot }: ViewProps) {
  const runningIndex = snapshot.pipeline.findIndex((task) => task.status === "running");
  const blockedIndex = snapshot.pipeline.findIndex((task) => task.status === "blocked");
  const currentIndex = runningIndex >= 0
    ? runningIndex
    : blockedIndex >= 0
      ? blockedIndex
      : Math.max(0, snapshot.pipeline.length - 1);
  const currentTask = snapshot.pipeline[currentIndex];
  const completeTasks = snapshot.pipeline.filter((task) => task.status === "complete").length;
  const chainVerified = snapshot.audit.length > 0 && snapshot.audit.every((event) => event.verified);
  const auditHead = snapshot.audit[0]?.hash;
  return (
    <div className="view-stack">
      <div className="page-heading">
        <div><span className="eyebrow">EXPERIMENT RUN / {snapshot.mission.id}</span><h1>Build & validation pipeline</h1><p>Every autonomous change advances through isolated code, test, simulation, and safety gates.</p></div>
        <div className="heading-actions"><span className="live-badge"><span /> {currentTask ? `STAGE ${currentIndex + 1}` : "NO STAGES"}</span></div>
      </div>
      <section className="panel pipeline-hero">
        <div className="pipeline-stage-track">
          {snapshot.pipeline.map((task, index) => {
            const Icon = taskIcons[task.category];
            return (
              <div className={`pipeline-stage ${statusClass(task.status)}`} key={task.id}>
                <div className="pipeline-stage-index">{task.status === "complete" ? <Check size={15} /> : index + 1}</div>
                <div className="pipeline-stage-icon"><Icon size={20} /></div>
                <span>{task.category}</span>
                {index < snapshot.pipeline.length - 1 && <i className="pipeline-stage-connector" />}
              </div>
            );
          })}
        </div>
        <div className={`active-run-summary ${currentTask ? statusClass(currentTask.status) : "status-queued"}`}>
          <span className="running-orb"><span /></span>
          <div><span className="eyebrow">{currentTask?.status === "blocked" ? "AWAITING APPROVAL" : currentTask?.status === "failed" ? "HALTED" : currentTask?.status === "complete" ? "LATEST STAGE" : "CURRENTLY RUNNING"}</span><h2>{currentTask?.label ?? "No active task"}</h2><p>{currentTask?.detail ?? "No execution evidence recorded"}</p></div>
          <div className="run-timer"><span>PROGRESS</span><strong>{snapshot.mission.progress}%</strong></div>
        </div>
      </section>
      <div className="pipeline-detail-grid">
        <section className="panel task-timeline-panel">
          <PanelHeader eyebrow="TASK GRAPH" title="Run activity" />
          <div className="task-timeline">
            {snapshot.pipeline.map((task) => {
              const Icon = taskIcons[task.category];
              return (
                <article className={`task-timeline-row ${statusClass(task.status)}`} key={task.id}>
                  <span className="timeline-icon"><Icon size={16} /></span>
                  <div><strong>{task.label}</strong><p>{task.detail}</p></div>
                  <span className="timeline-duration">{task.duration ?? task.startedAt ?? "--"}</span>
                  <span className="timeline-state">{taskStatusLabel[task.status]}</span>
                </article>
              );
            })}
          </div>
        </section>
        <aside className="pipeline-evidence-stack">
          <section className="panel evidence-panel">
            <PanelHeader eyebrow="RECORDED EVIDENCE" title="Verification summary" />
            <dl className="evidence-list">
              <div><dt>Requirements</dt><dd><CheckCircle2 size={14} /> {snapshot.requirements.length} traced</dd></div>
              <div><dt>Pipeline tasks</dt><dd><CheckCircle2 size={14} /> {completeTasks} / {snapshot.pipeline.length}</dd></div>
              <div><dt>Safety policy</dt><dd><CheckCircle2 size={14} /> {snapshot.system.safetyLock ? "Enforced" : "Review"}</dd></div>
              <div><dt>Simulation</dt><dd className={snapshot.mission.progress >= 100 ? "" : "running-text"}>{snapshot.mission.progress < 100 && <span className="spinner" />} {snapshot.mission.progress}%</dd></div>
            </dl>
          </section>
          <section className="panel artifact-panel">
            <PanelHeader eyebrow="AUDIT EVIDENCE" title="Latest chain head" />
            <code>{auditHead ? `sha256:${auditHead}` : "No audit head recorded"}</code>
            <div><span>Tamper-evident</span><span>{chainVerified ? "Chain verified" : "Verification pending"}</span></div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function RiskBadge({ risk }: { risk: Approval["risk"] }) {
  return <span className={`risk-badge risk-${risk}`}><AlertTriangle size={12} /> {risk.toUpperCase()} RISK</span>;
}

export function ApprovalsView({ snapshot, onDecision }: ViewProps) {
  const pending = snapshot.approvals.filter((approval) => approval.status === "pending");
  const resolved = snapshot.approvals.filter((approval) => approval.status !== "pending");
  return (
    <div className="view-stack">
      <div className="page-heading">
        <div><span className="eyebrow">HUMAN-IN-THE-LOOP CONTROL</span><h1>Safety approvals</h1><p>Review exact scope and evidence before NEXUS can affect a physical system.</p></div>
        <div className="heading-actions"><span className="safety-policy-chip"><LockKeyhole size={15} /> SAF-P02 enforced</span></div>
      </div>
      <div className="safety-explainer">
        <ShieldCheck size={20} />
        <span><strong>Physical actions remain policy locked.</strong><small>Decisions use an operator-supplied label and enter the tamper-evident audit chain. Authentication, expiry, and robot-edge enforcement are not implemented in this prototype.</small></span>
      </div>
      <section className="approval-section">
        <div className="section-inline-heading"><div><span className="eyebrow">ACTION REQUIRED</span><h2>{pending.length} pending requests</h2></div></div>
        <div className="approval-grid">
          {pending.map((approval) => (
            <article className="panel approval-card" key={approval.id}>
              <div className="approval-card-head"><RiskBadge risk={approval.risk} /><code>{approval.id}</code></div>
              <h2>{approval.title}</h2>
              <p>{approval.description}</p>
              <div className="approval-scope">
                <span className="eyebrow">ENFORCED SCOPE</span>
                <ul>{approval.scope.map((scope) => <li key={scope}><Check size={13} /> {scope}</li>)}</ul>
              </div>
              <div className="approval-request-meta"><span>Requested by <strong>{approval.requestedBy}</strong></span><span>{approval.requestedAt}</span></div>
              <div className="approval-actions">
                <button className="button reject" onClick={() => onDecision(approval, "rejected")}><X size={16} /> Reject</button>
                <button className="button approve" onClick={() => onDecision(approval, "approved")}><Check size={16} /> Approve scope</button>
              </div>
            </article>
          ))}
          {pending.length === 0 && <div className="empty-state"><ShieldCheck size={28} /><h2>No pending approvals</h2><p>No approval requests are pending in the current snapshot.</p></div>}
        </div>
      </section>
      {resolved.length > 0 && (
        <section className="resolved-approvals">
          <div className="section-inline-heading"><div><span className="eyebrow">CURRENT SNAPSHOT</span><h2>Resolved requests</h2></div></div>
          {resolved.map((approval) => (
            <div className="resolved-row" key={approval.id}>
              {approval.status === "approved" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
              <span><strong>{approval.title}</strong><small>{approval.id}</small></span>
              <span className={`decision-chip ${approval.status}`}>{approval.status}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

export function AuditView({ snapshot, source }: ViewProps) {
  const chainVerified = snapshot.audit.length > 0 && snapshot.audit.every((event) => event.verified);
  const latestHash = snapshot.audit[0]?.hash ?? "No chain head";
  return (
    <div className="view-stack">
      <div className="page-heading">
        <div><span className="eyebrow">CRYPTOGRAPHIC PROVENANCE</span><h1>Decision audit</h1><p>Inspect the tamper-evident record of what changed, why it changed, and who authorized it.</p></div>
        <div className="heading-actions"><span className="version-chip">SHA-256 CHAIN</span></div>
      </div>
      <section className="audit-integrity-panel">
        <div className="integrity-icon"><ShieldCheck size={24} /></div>
        <div><span className="eyebrow">CHAIN INTEGRITY</span><h2>{chainVerified ? `All ${snapshot.audit.length.toLocaleString()} visible events verified` : "Chain verification pending"}</h2><p>{source === "live" || source === "snapshot" ? "The API snapshot reports canonical content and previous-hash link checks." : "Seeded evidence is shown for interface evaluation; no API verification is currently confirmed."}</p></div>
        <div className="integrity-hash"><span>LATEST HEAD</span><code>{latestHash}</code></div>
      </section>
      <section className="panel audit-log-panel">
        <PanelHeader eyebrow="RECENT DECISIONS" title="Tamper-evident event chain" action={<span className="version-chip">{dataSourceLabel(source)}</span>} />
        <div className="audit-chain">
          {snapshot.audit.map((event, index) => (
            <article className="audit-event" key={event.id} aria-labelledby={`audit-action-${event.id}`}>
              <div className="audit-chain-rail" aria-hidden="true">
                <span><Check size={12} /></span>
                {index < snapshot.audit.length - 1 && <i />}
              </div>
              <div className="audit-event-primary">
                <div className="audit-time">
                  <span className="audit-field-label">RECORDED</span>
                  <time dateTime={event.timestamp}>{event.timestamp}</time>
                  <small><span>EVENT ID</span>{event.id}</small>
                </div>
                <div className="audit-event-copy">
                  <h3 id={`audit-action-${event.id}`}>{event.action}</h3>
                  <p>{event.rationale}</p>
                  <span>Actor: <strong>{event.actor}</strong></span>
                </div>
              </div>
              <dl className="audit-hashes" aria-label={`Cryptographic links for ${event.action}`}>
                <div className="audit-hash">
                  <dt>HASH</dt>
                  <dd><code>{event.hash}</code></dd>
                </div>
                <div className="audit-hash">
                  <dt>PREVIOUS</dt>
                  <dd><code>{event.previousHash}</code></dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
