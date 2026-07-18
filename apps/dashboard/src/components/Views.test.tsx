import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { EngineeringReviewResponse } from "../types";
import { AuditView, MissionView, RequirementsView, requirementsToCsv, TwinView } from "./Views";

const props = {
  snapshot: demoSnapshot,
  source: "live" as const,
  onNavigate: vi.fn(),
  onDecision: vi.fn(),
  engineeringReview: null,
  engineeringReviewError: null,
  reviewPending: false,
  onRequestEngineeringReview: vi.fn(),
};

const engineeringReview: EngineeringReviewResponse = {
  projectId: demoSnapshot.project.id,
  provider: "openai",
  model: "gpt-5.1",
  promptVersion: "engineering-review-v1",
  readiness: "needs_work",
  summary: "Simulation evidence is promising, but the safety verification chain is incomplete.",
  findings: [{
    severity: "high",
    domain: "safety",
    evidence: "REQ-SAF-05 is linked to HIL-SAF-03, which has not completed.",
    recommendation: "Complete hardware-in-the-loop emergency-stop verification before physical review.",
    requiresHumanApproval: true,
  }],
  nextExperiment: "Run a simulation fault-injection trial and capture emergency-stop latency evidence.",
  inputSha256: "a".repeat(64),
  generatedAt: "2026-07-16T12:00:00Z",
  auditHash: "b".repeat(64),
  advisoryOnly: true,
  simulationOnly: true,
  physicalExecutionEnabled: false,
  hardwareCommandSent: false,
};

describe("spatial dashboard views", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the metric plan and every robot in mission control", () => {
    render(<MissionView {...props} />);

    expect(screen.getByRole("img", { name: /top-down building plan/i })).toBeInTheDocument();
    expect(screen.getByText("Live WebSocket", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText("3 robots", { exact: true })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /open digital twin/i })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Mission assurance brief" })).toBeInTheDocument();
    expect(screen.getByText(/Physical release has 1 blocking condition/i)).toBeInTheDocument();
    expect(screen.getByText(/displayed routes valid.*0 wall crossings/i)).toBeInTheDocument();
  });

  it("distinguishes a completed simulation from an incomplete physical release", () => {
    const snapshot = structuredClone(demoSnapshot);
    snapshot.mission.phase = "Simulation Complete";
    snapshot.mission.activeTask = "Prepare physical deployment";
    snapshot.mission.progress = 100;
    snapshot.mission.currentStep = snapshot.mission.totalSteps;
    snapshot.pipeline = snapshot.pipeline.map((task) => (
      task.category === "deploy" ? { ...task, status: "blocked" as const } : { ...task, status: "complete" as const }
    ));

    render(<MissionView {...props} snapshot={snapshot} />);

    expect(screen.getByRole("heading", { name: "Simulation & release status" })).toBeInTheDocument();
    expect(screen.getByText("SIM COMPLETE")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Simulation progress: 100%" })).toBeInTheDocument();
    expect(screen.getByText("NEXT SAFETY GATE")).toBeInTheDocument();
    expect(screen.getAllByText(/physical release gated/i)).toHaveLength(2);
  });

  it("opens the evidence view for every actionable mission-assurance check", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<MissionView {...props} onNavigate={onNavigate} />);
    const actions: Array<[RegExp, string]> = [
      [/Fleet state: .*Open related evidence/i, "twin"],
      [/Route geometry: .*Open related evidence/i, "twin"],
      [/Simulation evidence: .*Open related evidence/i, "pipeline"],
      [/Requirement verification: .*Open related evidence/i, "requirements"],
      [/Human approvals: .*Open related evidence/i, "approvals"],
      [/Decision provenance: .*Open related evidence/i, "audit"],
    ];
    for (const [name, target] of actions) {
      await user.click(screen.getByRole("button", { name }));
      expect(onNavigate).toHaveBeenLastCalledWith(target);
    }
    expect(onNavigate).toHaveBeenCalledTimes(actions.length);
  });

  it("keeps complete audit identifiers and cryptographic links available in each event", () => {
    const timestamp = "2026-07-17T23:15:48.890889+00:00";
    const eventId = "c14af426-fca3-40a7-8833-c28849288856";
    const hash = "9aec601588e3852026e07c3ff7863873ec8ac5eb95613056b8013fa2c99f1a28";
    const previousHash = "6d5c45a04a082945003b62efc8a0d6f50c0ccfd85d34e2769b645baf78aa61fb";
    const action = "Approval Approved";
    render(
      <AuditView
        {...props}
        snapshot={{
          ...demoSnapshot,
          audit: [{
            id: eventId,
            action,
            actor: "operator",
            rationale: '{"comment":"Operator decision from NEXUS dashboard","hardware_command_sent":false}',
            timestamp,
            hash,
            previousHash,
            verified: true,
          }],
        }}
      />,
    );

    const event = screen.getByRole("article", { name: action });
    expect(within(event).getByText(timestamp)).toHaveAttribute("datetime", timestamp);
    expect(within(event).getByText(eventId)).toBeVisible();
    const links = within(event).getByLabelText(`Cryptographic links for ${action}`);
    expect(within(links).getByText(hash)).toBeVisible();
    expect(within(links).getByText(previousHash)).toBeVisible();
    expect(within(links).getByText("HASH")).toBeVisible();
    expect(within(links).getByText("PREVIOUS")).toBeVisible();
  });

  it("offers working 2D and 3D controls in the full digital twin", () => {
    render(<TwinView {...props} />);

    expect(screen.getByRole("button", { name: /2d plan/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /3d building/i })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: /floor/i })).toHaveValue("ground");
    expect(screen.getByText(/simulation only/i)).toBeInTheDocument();
  });

  it("exports a complete, safely quoted traceability matrix", () => {
    const csv = requirementsToCsv("Sentinel, Mapper", [
      { ...demoSnapshot.requirements[0], title: "Detect \"heat\", smoke" },
    ]);
    expect(csv).toContain('"Sentinel, Mapper"');
    expect(csv).toContain('"Detect ""heat"", smoke"');
    expect(csv.split("\r\n")).toHaveLength(2);

    render(<RequirementsView {...props} />);
    const exportLink = screen.getByRole("link", { name: /export matrix/i });
    expect(exportLink).toHaveAttribute("download", "aegis-scout-requirements.csv");
    expect(exportLink.getAttribute("href")).toMatch(/^data:text\/csv;charset=utf-8,/);
  });

  it("labels planned and simulated architecture without claiming a live ROS or Gazebo runtime", () => {
    render(<RequirementsView {...props} />);

    expect(screen.getByRole("heading", { name: "Prototype architecture" })).toBeInTheDocument();
    expect(screen.getByText("Digital twin · no ROS link")).toBeInTheDocument();
    expect(screen.getByText("Simulated hazard feed")).toBeInTheDocument();
    expect(screen.queryByText("ROS 2 / Gazebo")).not.toBeInTheDocument();
    expect(screen.queryByText("C++ / SLAM")).not.toBeInTheDocument();
  });

  it("renders the OpenAI review provenance, physical boundary, and human-gated findings", () => {
    render(<RequirementsView {...props} engineeringReview={engineeringReview} />);

    expect(screen.getByRole("heading", { name: "Independent evidence review" })).toBeInTheDocument();
    expect(screen.getByText("Needs work")).toBeInTheDocument();
    expect(screen.getByText("Advisory only")).toBeInTheDocument();
    expect(screen.getByText("Simulation only")).toBeInTheDocument();
    expect(screen.getByText("Physical execution disabled")).toBeInTheDocument();
    expect(screen.getByText("No hardware command sent")).toBeInTheDocument();
    expect(screen.getByText("Human approval required")).toBeInTheDocument();
    expect(screen.getByText(engineeringReview.nextExperiment)).toBeInTheDocument();
  });

  it("invokes a live review request but disables AI generation for demo data", async () => {
    const user = userEvent.setup();
    const onRequestEngineeringReview = vi.fn();
    const { rerender } = render(<RequirementsView {...props} onRequestEngineeringReview={onRequestEngineeringReview} />);
    await user.click(screen.getByRole("button", { name: "Run OpenAI engineering review" }));
    expect(onRequestEngineeringReview).toHaveBeenCalledOnce();

    rerender(<RequirementsView {...props} source="demo" onRequestEngineeringReview={onRequestEngineeringReview} />);
    expect(screen.getByRole("button", { name: "Run OpenAI engineering review" })).toBeDisabled();
    expect(screen.getByText(/no demo AI result is generated/i)).toBeInTheDocument();
  });
});
