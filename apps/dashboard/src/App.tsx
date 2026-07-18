import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  Bell,
  Boxes,
  ChevronDown,
  CircleGauge,
  FileClock,
  GitBranch,
  Hexagon,
  LayoutDashboard,
  Map,
  Menu,
  Plus,
  Power,
  Radio,
  ServerCog,
  ShieldCheck,
  Siren,
  Waypoints,
  X,
} from "lucide-react";
import {
  ApprovalsView,
  AuditView,
  MissionView,
  PipelineView,
  RequirementsView,
  TwinView,
} from "./components/Views";
import { StatusDot } from "./components/Visuals";
import { demoForProject, demoProjects } from "./data/demo";
import { useProjectDashboard } from "./hooks/useProjectDashboard";
import { useModalFocus } from "./hooks/useModalFocus";
import {
  createProject,
  decideApproval,
  fetchProjectDashboard,
  listProjects,
  NexusApiError,
  requestEngineeringReview,
  setOperatingMode,
  triggerEmergencyStop,
} from "./lib/api";
import { dataSourceLabel, formatHeartbeat } from "./lib/dataSource";
import type { Approval, ApprovalStatus, EngineeringReviewResponse, OperatingMode, ProjectSummary } from "./types";

type ViewKey = "mission" | "twin" | "requirements" | "pipeline" | "approvals" | "audit";

const navItems: Array<{ id: ViewKey; label: string; icon: typeof LayoutDashboard }> = [
  { id: "mission", label: "Mission control", icon: LayoutDashboard },
  { id: "twin", label: "Digital twin", icon: Map },
  { id: "requirements", label: "Requirements", icon: GitBranch },
  { id: "pipeline", label: "Build pipeline", icon: Waypoints },
  { id: "approvals", label: "Approvals", icon: ShieldCheck },
  { id: "audit", label: "Audit log", icon: FileClock },
];

const viewLabels: Record<ViewKey, string> = {
  mission: "Mission control",
  twin: "Digital twin",
  requirements: "Requirements & architecture",
  pipeline: "Build & validation",
  approvals: "Safety approvals",
  audit: "Decision audit",
};

function makeLocalProject(name: string, objective: string): ProjectSummary {
  return {
    id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString(36)}`,
    name,
    objective,
    updatedAt: "just now",
  };
}

function projectInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words.at(-1)![0]}` : words[0]?.slice(0, 2) ?? "NX").toUpperCase();
}

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>(demoProjects);
  const [selectedProjectId, setSelectedProjectId] = useState(demoProjects[0].id);
  const [activeView, setActiveView] = useState<ViewKey>("mission");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [engineeringReview, setEngineeringReview] = useState<EngineeringReviewResponse | null>(null);
  const [engineeringReviewError, setEngineeringReviewError] = useState<string | null>(null);
  const createDialogRef = useRef<HTMLElement>(null);
  const createNameRef = useRef<HTMLInputElement>(null);
  const stopDialogRef = useRef<HTMLElement>(null);
  const stopCancelRef = useRef<HTMLButtonElement>(null);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const initialSnapshot = useMemo(() => demoForProject(selectedProject), [selectedProject]);
  const { snapshot, source, update } = useProjectDashboard(initialSnapshot);

  const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === "pending").length;
  const auditVerified = snapshot.audit.length > 0 && snapshot.audit.every((event) => event.verified);
  const modePending = pendingAction?.startsWith("mode:") ?? false;
  const approvalPending = pendingAction?.startsWith("approval:") ?? false;
  const createPending = pendingAction === "create";
  const stopPending = pendingAction === "emergency-stop";
  const physicalRequestActive = snapshot.system.mode === "PHYSICAL";
  const physicalButtonText = pendingAction === "mode:PHYSICAL"
    ? "REQUESTING..."
    : physicalRequestActive && pendingApprovals > 0
      ? "APPROVAL PENDING"
      : physicalRequestActive
        ? "ADAPTER LOCKED"
        : "REQUEST PHYSICAL";
  const physicalButtonLabel = pendingAction === "mode:PHYSICAL"
    ? "Physical approval request in progress"
    : physicalRequestActive && pendingApprovals > 0
      ? "Physical approval pending"
      : physicalRequestActive
        ? "Physical readiness approved; hardware adapter disabled"
        : "Request physical approval";
  const reviewPending = pendingAction === "ai-review";
  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const closeStop = useCallback(() => setStopOpen(false), []);

  useModalFocus({
    open: createOpen,
    locked: createPending,
    containerRef: createDialogRef,
    initialFocusRef: createNameRef,
    onRequestClose: closeCreate,
  });

  useEffect(() => {
    setEngineeringReview(null);
    setEngineeringReviewError(null);
  }, [selectedProjectId]);
  useModalFocus({
    open: stopOpen,
    locked: stopPending,
    containerRef: stopDialogRef,
    initialFocusRef: stopCancelRef,
    onRequestClose: closeStop,
  });

  function failureMessage(action: string, error: unknown): string {
    if (error instanceof NexusApiError) {
      if (error.offline) return `${action} could not reach the NEXUS API. No server-side change was made.`;
      if (error.status === 422) return `${action} failed validation: ${error.message}`;
      return `${action} was rejected: ${error.message}`;
    }
    return `${action} failed unexpectedly. No server-side change was confirmed.`;
  }

  async function reconcile(fallback = snapshot): Promise<boolean> {
    try {
      const remote = await fetchProjectDashboard(fallback.project.id, fallback);
      update(() => remote);
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    listProjects(controller.signal)
      .then((remoteProjects) => {
        if (!remoteProjects.length) return;
        setProjects((current) => {
          const remoteIds = new Set(remoteProjects.map((project) => project.id));
          return [...remoteProjects, ...current.filter((project) => !remoteIds.has(project.id))];
        });
        setSelectedProjectId((current) =>
          demoProjects.some((project) => project.id === current) ? remoteProjects[0].id : current,
        );
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  function navigate(view: string) {
    if (navItems.some((item) => item.id === view)) setActiveView(view as ViewKey);
    setMobileNavOpen(false);
  }

  function selectProject(id: string) {
    setSelectedProjectId(id);
    setActiveView("mission");
  }

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingAction) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const objective = String(form.get("objective") ?? "").trim();
    if (name.length < 3) {
      setToast("Project name must contain at least 3 characters.");
      return;
    }
    if (objective.length < 20) {
      setToast("Engineering objective must contain at least 20 characters.");
      return;
    }

    if (source === "demo") {
      const project = makeLocalProject(name, objective);
      setProjects((current) => [project, ...current]);
      setSelectedProjectId(project.id);
      setActiveView("mission");
      setCreateOpen(false);
      setToast("Demo project created locally. It is not persisted to the NEXUS control plane.");
      return;
    }

    setPendingAction("create");
    try {
      const project = await createProject(name, objective);
      setProjects((current) => [project, ...current]);
      setSelectedProjectId(project.id);
      setActiveView("mission");
      setCreateOpen(false);
      setToast("Objective created and engineering decomposition queued.");
    } catch (error) {
      setToast(failureMessage("Project creation", error));
    } finally {
      setPendingAction(null);
    }
  }

  async function handleMode(mode: OperatingMode) {
    if (pendingAction) return;
    if (source === "demo") {
      if (mode === "SIMULATION") {
        update((current) => ({ ...current, system: { ...current.system, mode } }));
        setToast("Demo mode: simulation preview selected locally. No control-plane command was sent.");
      } else {
        setToast("Demo mode: physical approval cannot be requested while the NEXUS API is offline.");
      }
      return;
    }

    setPendingAction(`mode:${mode}`);
    try {
      await setOperatingMode(snapshot.project.id, mode);
      const refreshed = await reconcile();
      if (!refreshed && mode === "SIMULATION") {
        update((current) => ({ ...current, system: { ...current.system, mode: "SIMULATION" } }));
      }
      setToast(mode === "PHYSICAL"
        ? `Physical approval requested. Safety gates remain locked; no actuator command was sent.${refreshed ? "" : " Live snapshot refresh is pending."}`
        : `Simulation start confirmed by the control plane. No physical hardware was contacted.${refreshed ? "" : " Live snapshot refresh is pending."}`);
    } catch (error) {
      setToast(failureMessage(mode === "PHYSICAL" ? "Physical approval request" : "Simulation request", error));
    } finally {
      setPendingAction(null);
    }
  }

  async function handleDecision(approval: Approval, decision: Exclude<ApprovalStatus, "pending">) {
    if (pendingAction) return;
    if (source === "demo") {
      update((current) => ({
        ...current,
        approvals: current.approvals.map((item) => item.id === approval.id ? { ...item, status: decision } : item),
      }));
      setToast(`Demo mode: ${approval.id} marked ${decision} locally. No server audit entry or physical effect was created.`);
      return;
    }

    setPendingAction(`approval:${approval.id}`);
    try {
      await decideApproval(snapshot.project.id, approval.id, decision, "Operator decision from NEXUS dashboard");
      const refreshed = await reconcile();
      if (!refreshed) {
        update((current) => ({
          ...current,
          approvals: current.approvals.map((item) => item.id === approval.id ? { ...item, status: decision } : item),
        }));
      }
      setToast(`${approval.id} ${decision} by the control plane.${refreshed ? " Audit state refreshed." : " Live snapshot refresh is pending."}`);
    } catch (error) {
      setToast(failureMessage(`${approval.id} ${decision}`, error));
    } finally {
      setPendingAction(null);
    }
  }

  async function handleEmergencyStop() {
    if (pendingAction) return;
    if (source === "demo") {
      update((current) => ({
        ...current,
        robot: { ...current.robot, speed: 0, status: "warning" },
        mission: { ...current.mission, activeTask: "Demo motion stopped", phase: "Local simulation inhibited" },
        system: { ...current.system, safetyLock: true, health: "warning" },
      }));
      setStopOpen(false);
      setToast("Demo mode: simulated motion stopped locally. No control-plane latch or physical effect was confirmed.");
      return;
    }

    setPendingAction("emergency-stop");
    try {
      await triggerEmergencyStop(snapshot.project.id);
      const refreshed = await reconcile();
      if (!refreshed) {
        update((current) => ({
          ...current,
          robot: { ...current.robot, speed: 0, status: "critical" },
          mission: { ...current.mission, activeTask: "Emergency stop engaged", phase: "Motion inhibited" },
          system: { ...current.system, safetyLock: true, health: "critical" },
        }));
      }
      setStopOpen(false);
      setToast(`Emergency-stop control-plane latch confirmed.${refreshed ? "" : " Live snapshot refresh is pending."} Hardware-edge acknowledgement is not available in this build.`);
    } catch (error) {
      setToast(`${failureMessage("Emergency stop", error)} No control-plane latch was confirmed.`);
    } finally {
      setPendingAction(null);
    }
  }

  async function handleEngineeringReview() {
    if (pendingAction) return;
    if (source === "demo") {
      setEngineeringReviewError("OpenAI review requires a connected NEXUS API. No AI result was generated from demo data.");
      return;
    }
    if (source === "connecting") {
      setEngineeringReviewError("OpenAI review is waiting for the NEXUS API connection to be confirmed.");
      return;
    }

    setPendingAction("ai-review");
    setEngineeringReview(null);
    setEngineeringReviewError(null);
    try {
      const result = await requestEngineeringReview(snapshot.project.id);
      setEngineeringReview(result);
      setToast("OpenAI engineering review recorded as advisory evidence. No launch, approval, or hardware action was triggered.");
      await reconcile();
    } catch (error) {
      if (error instanceof NexusApiError && error.status === 503) {
        setEngineeringReviewError("OpenAI review is not configured. Set OPENAI_API_KEY on the NEXUS API and restart the service; no AI result was generated.");
      } else if (error instanceof NexusApiError && error.offline) {
        setEngineeringReviewError("The NEXUS API could not be reached. Check the API connection and try again; no AI result was generated.");
      } else {
        setEngineeringReviewError(`${failureMessage("OpenAI engineering review", error)} No AI result was generated.`);
      }
    } finally {
      setPendingAction(null);
    }
  }

  const viewProps = {
    snapshot,
    source,
    onNavigate: navigate,
    onDecision: handleDecision,
    engineeringReview,
    engineeringReviewError,
    reviewPending,
    onRequestEngineeringReview: handleEngineeringReview,
  };

  return (
    <div className="nexus-app">
      <aside className={`sidebar${mobileNavOpen ? " is-open" : ""}`}>
        <div className="brand">
          <span className="brand-mark"><Hexagon size={29} /><i /></span>
          <span><strong>NEXUS</strong><small>ENGINEERING SYSTEM</small></span>
          <button className="mobile-close" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}><X size={19} /></button>
        </div>

        <div className="project-control">
          <label htmlFor="project-select">ACTIVE PROJECT</label>
          <div className="project-select-wrap">
            <span className="project-avatar" aria-hidden="true">{projectInitials(selectedProject.name)}</span>
            <select id="project-select" value={selectedProjectId} disabled={pendingAction !== null} onChange={(event) => selectProject(event.target.value)}>
              {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </div>
          <button className="new-objective-button" disabled={pendingAction !== null} onClick={() => setCreateOpen(true)}><Plus size={15} /> New objective</button>
        </div>

        <nav className="primary-nav" aria-label="Project navigation">
          <span className="nav-section-label">OPERATIONS</span>
          {navItems.slice(0, 2).map((item) => <NavItem key={item.id} item={item} active={activeView === item.id} onClick={() => navigate(item.id)} />)}
          <span className="nav-section-label">ENGINEERING</span>
          {navItems.slice(2, 4).map((item) => <NavItem key={item.id} item={item} active={activeView === item.id} onClick={() => navigate(item.id)} />)}
          <span className="nav-section-label">GOVERNANCE</span>
          {navItems.slice(4).map((item) => (
            <NavItem
              key={item.id}
              item={item}
              active={activeView === item.id}
              onClick={() => navigate(item.id)}
              count={item.id === "approvals" && pendingApprovals ? pendingApprovals : undefined}
            />
          ))}
        </nav>

        <div className="sidebar-spacer" />
        <div className="platform-status">
          <div className="platform-status-head"><span>PLATFORM</span><StatusDot status={snapshot.system.health} label={snapshot.system.health === "nominal" ? "Nominal" : "Attention"} /></div>
          <div className="platform-row"><ServerCog size={15} /><span>Orchestrator</span><b>v0.1.0</b></div>
          <div className="platform-row">
            <Radio size={15} />
            <span>Last heartbeat</span>
            <b><time dateTime={snapshot.system.lastHeartbeat} title={snapshot.system.lastHeartbeat}>{formatHeartbeat(snapshot.system.lastHeartbeat)}</time></b>
          </div>
        </div>
        <div className="sidebar-footer"><span className="chain-verified"><ShieldCheck size={14} /> Audit chain {auditVerified ? "verified" : "pending"}</span><small>BUILD 0.1.0</small></div>
      </aside>

      {mobileNavOpen && <button className="sidebar-backdrop" aria-label="Dismiss navigation" onClick={() => setMobileNavOpen(false)} />}

      <div className="app-column">
        <header className="topbar">
          <div className="topbar-left">
            <button className="mobile-menu" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu size={20} /></button>
            <div className="breadcrumb"><span>{snapshot.project.name}</span><i>/</i><strong>{viewLabels[activeView]}</strong></div>
          </div>
          <div className="topbar-actions">
            <span className={`data-source source-${source}`} aria-live="polite"><i /> {dataSourceLabel(source)}</span>
            <div className="mode-switch" aria-label="Operating mode requests" aria-busy={modePending}>
              <button
                className={snapshot.system.mode === "SIMULATION" ? "active" : ""}
                disabled={pendingAction !== null}
                aria-label={pendingAction === "mode:SIMULATION" ? "Simulation request in progress" : "Request simulation mode"}
                onClick={() => void handleMode("SIMULATION")}
              ><CircleGauge size={14} /> {pendingAction === "mode:SIMULATION" ? "SIM..." : "SIM"}</button>
              <button
                className={physicalRequestActive ? "active physical" : ""}
                disabled={pendingAction !== null || physicalRequestActive}
                aria-label={physicalButtonLabel}
                onClick={() => void handleMode("PHYSICAL")}
              ><Activity size={14} /> {physicalButtonText}</button>
            </div>
            <button
              className="notification-button"
              aria-label={pendingApprovals > 0 ? `Review ${pendingApprovals} pending approvals` : "Open audit log"}
              onClick={() => navigate(pendingApprovals > 0 ? "approvals" : "audit")}
            ><Bell size={17} />{pendingApprovals > 0 && <span>{pendingApprovals}</span>}</button>
            <button className="estop-button" disabled={pendingAction !== null} aria-label="Request emergency stop" onClick={() => setStopOpen(true)}><Siren size={17} /><span>EMERGENCY STOP</span></button>
          </div>
        </header>

        <div className="objective-bar">
          <span className="objective-icon"><Boxes size={15} /></span>
          <span><strong>OBJECTIVE</strong>{snapshot.project.objective}</span>
          <span className="objective-id">{snapshot.mission.id}</span>
        </div>

        <main className="main-content">
          {activeView === "mission" && <MissionView {...viewProps} />}
          {activeView === "twin" && <TwinView {...viewProps} />}
          {activeView === "requirements" && <RequirementsView {...viewProps} />}
          {activeView === "pipeline" && <PipelineView {...viewProps} />}
          {activeView === "approvals" && (
            <fieldset
              disabled={pendingAction !== null}
              aria-busy={approvalPending}
              aria-label="Safety approval controls"
              style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}
            >
              <ApprovalsView {...viewProps} />
            </fieldset>
          )}
          {activeView === "audit" && <AuditView {...viewProps} />}
        </main>
      </div>

      {createOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!createPending) closeCreate(); }}>
          <section ref={createDialogRef} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-labelledby="new-objective-title" aria-describedby="new-objective-description" aria-busy={createPending} onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head"><div><span className="eyebrow">NEW ENGINEERING PROJECT</span><h2 id="new-objective-title">Define an objective</h2></div><button type="button" aria-label="Close" disabled={createPending} onClick={closeCreate}><X size={19} /></button></div>
            <p id="new-objective-description">NEXUS will convert this objective into traceable requirements, architecture, tests, and an approval-gated execution plan.</p>
            <form onSubmit={handleCreateProject}>
              <label htmlFor="project-name">Project name</label><input ref={createNameRef} id="project-name" name="name" required minLength={3} maxLength={160} disabled={createPending} placeholder="e.g. Aegis Scout" />
              <label htmlFor="engineering-objective">Engineering objective</label><textarea id="engineering-objective" name="objective" required minLength={20} maxLength={5000} disabled={createPending} rows={5} placeholder="Describe the real-world outcome, operating environment, and constraints..." />
              <div className="modal-actions"><button type="button" className="button secondary" disabled={createPending} onClick={closeCreate}>Cancel</button><button className="button primary" type="submit" disabled={createPending} aria-label={createPending ? "Creating objective" : "Create objective"}><Plus size={16} /> {createPending ? "Creating..." : "Create objective"}</button></div>
            </form>
          </section>
        </div>
      )}

      {stopOpen && (
        <div className="modal-backdrop danger-backdrop" role="presentation" onMouseDown={() => { if (!stopPending) closeStop(); }}>
          <section ref={stopDialogRef} tabIndex={-1} className="modal emergency-modal" role="alertdialog" aria-modal="true" aria-labelledby="stop-title" aria-describedby="stop-description" aria-busy={stopPending} onMouseDown={(event) => event.stopPropagation()}>
            <div className="emergency-symbol"><Power size={29} /></div>
            <span className="eyebrow">SAFETY OVERRIDE</span>
            <h2 id="stop-title">Request emergency stop?</h2>
            <p id="stop-description">{source === "demo" ? "This stops only the local simulation preview." : "This requests a control-plane emergency-stop latch."} NEXUS reports confirmation only after API acknowledgement; hardware-edge acknowledgement remains separate.</p>
            <div className="modal-actions"><button ref={stopCancelRef} type="button" className="button secondary" disabled={stopPending} onClick={closeStop}>Cancel</button><button type="button" className="button danger" disabled={stopPending} aria-label={stopPending ? "Emergency stop request in progress" : "Confirm emergency stop request"} onClick={() => void handleEmergencyStop()}><Siren size={16} /> {stopPending ? "Confirming..." : "Confirm emergency stop"}</button></div>
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status"><ShieldCheck size={16} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={14} /></button></div>}
    </div>
  );
}

function NavItem({ item, active, onClick, count }: { item: typeof navItems[number]; active: boolean; onClick: () => void; count?: number }) {
  const Icon = item.icon;
  return (
    <button key={item.id} className={`nav-item${active ? " active" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined}>
      <Icon size={17} aria-hidden="true" />
      <span>{item.label}</span>
      {count !== undefined && <b>{count}</b>}
    </button>
  );
}
