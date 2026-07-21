import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  Check,
  CheckCircle2,
  Circle,
  Crosshair,
  Database,
  LoaderCircle,
  MapPin,
  Play,
  Route,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  createRobotJob,
  executeRobotJob,
  fetchRobotJobs,
  fetchRobotMemory,
} from "../lib/api";
import type { RobotJob, RobotJobStep, RobotMemory } from "../types";
import type { MapJobTarget } from "./spatial/model";

const EXAMPLE_JOBS = [
  "Inspect the Electrical Plant for heat or smoke and record camera evidence",
  "Map the Response Storage room and update coverage memory",
  "Patrol the Ground Atrium and report any new hazards",
];

interface RobotJobPanelProps {
  projectId: string;
  target: MapJobTarget | null;
  targeting: boolean;
  onTargetingChange: (targeting: boolean) => void;
  onTargetClear: () => void;
}

function stepIcon(step: RobotJobStep) {
  if (step.status === "completed") return <Check size={14} aria-hidden="true" />;
  if (step.status === "running") return <LoaderCircle size={14} className="spin" aria-hidden="true" />;
  if (step.status === "failed" || step.status === "blocked") return <AlertTriangle size={14} aria-hidden="true" />;
  return <Circle size={10} aria-hidden="true" />;
}

function memorySummary(memory: RobotMemory[]): string {
  const locations = memory.filter((item) => item.kind === "location").length;
  const procedures = memory.filter((item) => item.kind === "procedure").length;
  const experiences = memory.filter((item) => item.kind === "experience").length;
  return `${locations} locations · ${procedures} procedures · ${experiences} experiences`;
}

export function RobotJobPanel({
  projectId,
  target,
  targeting,
  onTargetingChange,
  onTargetClear,
}: RobotJobPanelProps) {
  const [instruction, setInstruction] = useState(EXAMPLE_JOBS[0]);
  const [executionMode, setExecutionMode] = useState<"simulation" | "physical">("simulation");
  const [jobs, setJobs] = useState<RobotJob[]>([]);
  const [memory, setMemory] = useState<RobotMemory[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [nextJobs, nextMemory] = await Promise.all([
      fetchRobotJobs(projectId, signal),
      fetchRobotMemory(projectId, signal),
    ]);
    setJobs(nextJobs);
    setMemory(nextMemory);
    setActiveJobId((current) => current && nextJobs.some((job) => job.id === current)
      ? current
      : nextJobs[0]?.id ?? null);
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((caught: unknown) => {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(caught instanceof Error ? caught.message : "Robot jobs are unavailable");
      }
    });
    return () => controller.abort();
  }, [refresh]);

  const hasRunningJob = jobs.some((job) => job.status === "running");
  useEffect(() => {
    if (!hasRunningJob) return undefined;
    const timer = window.setInterval(() => {
      void refresh().catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Job progress could not be refreshed");
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [hasRunningJob, refresh]);

  const activeJob = useMemo(
    () => jobs.find((job) => job.id === activeJobId) ?? jobs[0],
    [activeJobId, jobs],
  );

  async function planJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (instruction.trim().length < 8) {
      setError("Describe the job in at least eight characters.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const job = await createRobotJob(projectId, instruction.trim(), target ?? undefined, executionMode);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setActiveJobId(job.id);
      onTargetingChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The job could not be planned");
    } finally {
      setCreating(false);
    }
  }

  async function runJob(job: RobotJob) {
    setExecutingId(job.id);
    setError(null);
    try {
      const running = await executeRobotJob(projectId, job.id);
      setJobs((current) => current.map((item) => item.id === running.id ? running : item));
      setActiveJobId(running.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The job could not start");
    } finally {
      setExecutingId(null);
    }
  }

  return (
    <section className="panel robot-job-panel" aria-labelledby="robot-job-title">
      <div className="panel-header">
        <div>
          <span className="eyebrow">MEMORY-BACKED AUTONOMY</span>
          <h2 id="robot-job-title">Tell the fleet what job to do</h2>
        </div>
        <span className="robot-memory-badge"><BrainCircuit size={14} /> {memory.length ? memorySummary(memory) : "Loading memory…"}</span>
      </div>

      <div className="robot-job-layout">
        <form className="robot-job-composer" onSubmit={(event) => void planJob(event)}>
          <div className="robot-job-intro">
            <Sparkles size={18} aria-hidden="true" />
            <span><strong>Natural-language mission planner</strong><small>NEXUS recalls known rooms and procedures, chooses a robot, validates a route, and builds an explainable pipeline.</small></span>
          </div>
          <label className="robot-job-instruction">
            Job instruction
            <textarea
              value={instruction}
              rows={4}
              maxLength={2000}
              placeholder="Example: inspect the Electrical Plant for heat and record evidence"
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>
          <div className="robot-job-examples" aria-label="Example job instructions">
            {EXAMPLE_JOBS.map((example) => (
              <button type="button" key={example} onClick={() => setInstruction(example)}>{example}</button>
            ))}
          </div>
          <div className="robot-job-target-row">
            <button
              type="button"
              className={`button ${targeting ? "primary" : "secondary"}`}
              aria-pressed={targeting}
              onClick={() => onTargetingChange(!targeting)}
            >
              <Crosshair size={15} /> {targeting ? "Click the map now" : "Choose on map"}
            </button>
            {target ? (
              <span className="robot-job-target-chip">
                <MapPin size={14} /> {target.roomLabel ?? target.floorId} · {target.x.toFixed(1)}, {target.y.toFixed(1)} m
                <button type="button" aria-label="Clear map target" onClick={onTargetClear}><X size={13} /></button>
              </span>
            ) : <span className="robot-job-target-auto"><BrainCircuit size={14} /> Or let memory resolve a named room</span>}
          </div>
          <label className="robot-job-mode">
            Execution contract
            <select value={executionMode} onChange={(event) => setExecutionMode(event.target.value as "simulation" | "physical")}>
              <option value="simulation">Simulation · executable now</option>
              <option value="physical">Physical plan · motion gated</option>
            </select>
          </label>
          <p className="robot-job-boundary"><ShieldCheck size={14} /> Physical plans never send motion commands from this prototype. The Spot camera link remains read-only.</p>
          {error && <p className="robot-job-error" role="alert">{error}</p>}
          <button className="button primary robot-job-submit" type="submit" disabled={creating}>
            {creating ? <LoaderCircle size={16} className="spin" /> : <Route size={16} />}
            {creating ? "Building plan…" : "Build job pipeline"}
          </button>
        </form>

        <div className="robot-job-plan" aria-live="polite">
          {jobs.length > 1 && (
            <div className="robot-job-history" aria-label="Recent robot jobs">
              {jobs.slice(0, 5).map((job) => (
                <button
                  type="button"
                  key={job.id}
                  className={job.id === activeJob?.id ? "is-active" : ""}
                  onClick={() => setActiveJobId(job.id)}
                >
                  <span className={`job-state state-${job.status}`} /> {job.targetRoomLabel ?? job.targetFloorId} · {job.status}
                </button>
              ))}
            </div>
          )}
          {activeJob ? (
            <>
              <div className="robot-job-plan-head">
                <div><span className="eyebrow">JOB {activeJob.id.slice(0, 8).toUpperCase()}</span><h3>{activeJob.instruction}</h3></div>
                <span className={`robot-job-status status-${activeJob.status}`}>{activeJob.status}</span>
              </div>
              <div className="robot-job-facts">
                <div><span>Assigned</span><strong>{activeJob.assignedRobotName}</strong></div>
                <div><span>Destination</span><strong>{activeJob.targetRoomLabel ?? activeJob.targetFloorId}</strong><small>{activeJob.targetX.toFixed(1)}, {activeJob.targetY.toFixed(1)} m</small></div>
                <div><span>Procedure</span><strong>{String(activeJob.memoryContext.procedure ?? "Bounded inspection")}</strong></div>
                <div><span>Verified route</span><strong>{Number(activeJob.memoryContext.routeDistanceMetres ?? 0).toFixed(1)} m</strong><small>{activeJob.memoryContext.route?.length ?? 0} waypoints</small></div>
              </div>
              <div className="robot-job-rationale">
                <BrainCircuit size={17} />
                <span><strong>Why this plan</strong><small>{String(activeJob.memoryContext.whyThisRobot ?? "Deterministic capability and route match.")}</small></span>
              </div>
              <div className="robot-job-memory-keys">
                <Database size={14} aria-hidden="true" />
                {(activeJob.memoryContext.matchedMemoryKeys ?? []).map((key) => <code key={key}>{key}</code>)}
              </div>
              <div className="robot-job-progress"><span style={{ width: `${activeJob.progress}%` }} /></div>
              <ol className="robot-job-steps">
                {activeJob.steps.map((step, index) => (
                  <li className={`step-${step.status}`} key={step.id}>
                    <span className="robot-job-step-number">{stepIcon(step)}</span>
                    <span><strong>{index + 1}. {step.title}</strong><small>{step.detail}</small>{step.evidence && <em>{step.evidence}</em>}</span>
                  </li>
                ))}
              </ol>
              {activeJob.status === "planned" && (
                <button
                  type="button"
                  className="button primary robot-job-run"
                  disabled={executingId === activeJob.id}
                  onClick={() => void runJob(activeJob)}
                >
                  {executingId === activeJob.id ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}
                  {activeJob.executionMode === "physical" ? "Request physical execution" : "Run in digital twin"}
                </button>
              )}
              {activeJob.status === "completed" && (
                <p className="robot-job-complete"><CheckCircle2 size={17} /> Simulation complete. Evidence and reusable experience memory were recorded; no hardware command was sent.</p>
              )}
            </>
          ) : (
            <div className="robot-job-empty">
              <Route size={30} />
              <h3>No job planned yet</h3>
              <p>Describe a task or select a point on the map. The plan, robot assignment, route, safety checks, and execution stages will appear here.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
