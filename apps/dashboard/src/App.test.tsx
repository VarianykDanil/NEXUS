import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { demoSnapshot } from "./data/demo";
import type { DashboardSnapshot } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function installLiveApi(options: {
  initial?: DashboardSnapshot;
  reconciled?: DashboardSnapshot;
  mutation?: (url: string, init?: RequestInit) => Response | Promise<Response>;
} = {}) {
  const initial = options.initial ?? structuredClone(demoSnapshot);
  const reconciled = options.reconciled ?? initial;
  let dashboardReads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/projects") && !init?.method) return jsonResponse([]);
    if (url.endsWith("/dashboard")) {
      const payload = dashboardReads === 0 ? initial : reconciled;
      dashboardReads += 1;
      return jsonResponse(payload);
    }
    if (options.mutation) return options.mutation(url, init);
    return jsonResponse({ message: "Command accepted", hardware_command_sent: false, project: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function engineeringReviewResponse(overrides: Record<string, unknown> = {}) {
  return {
    project_id: demoSnapshot.project.id,
    provider: "openai",
    model: "gpt-5.1",
    prompt_version: "engineering-review-v1",
    readiness: "needs_work",
    summary: "The current simulation evidence is promising, but one safety verification remains open.",
    findings: [{
      severity: "high",
      domain: "safety",
      evidence: "REQ-SAF-05 has not completed hardware-in-the-loop verification.",
      recommendation: "Complete HIL-SAF-03 before requesting physical approval.",
      requires_human_approval: true,
    }],
    next_experiment: "Run a fault-injection simulation and capture emergency-stop latency evidence.",
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

async function openRequirements(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Requirements" }));
  expect(screen.getByRole("heading", { name: "Requirements & architecture" })).toBeInTheDocument();
}

describe("NEXUS operations console", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("API offline")));
    vi.stubGlobal("WebSocket", undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a complete seeded mission when the API is offline", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Level 02 reconnaissance" })).toBeInTheDocument();
    expect(screen.getByText("Resolve east corridor frontier")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /top-down building plan/i })).toBeInTheDocument();
    expect(screen.getByText("2 physical actions awaiting approval")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("DEMO DATA")).toBeInTheDocument());
  });

  it("routes notifications to pending approvals", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByText("DEMO DATA")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Review 2 pending approvals" }));
    expect(screen.getByRole("heading", { name: "Safety approvals" })).toBeInTheDocument();
  });

  it("opens and dismisses mobile navigation with unambiguous controls", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("button", { name: "Close navigation" })).toBeInTheDocument();
    const dismiss = screen.getByRole("button", { name: "Dismiss navigation" });
    await user.click(dismiss);
    expect(screen.queryByRole("button", { name: "Dismiss navigation" })).not.toBeInTheDocument();
  });

  it("routes an empty notification inbox to the audit log", async () => {
    const user = userEvent.setup();
    const snapshot = structuredClone(demoSnapshot);
    snapshot.approvals = [];
    installLiveApi({ initial: snapshot });
    render(<App />);
    await waitFor(() => expect(screen.getByText("API SNAPSHOT")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Open audit log" }));
    expect(screen.getByRole("heading", { name: "Decision audit" })).toBeInTheDocument();
  });

  it("labels an offline simulation selection as a local demo only", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByText("DEMO DATA")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Request simulation mode" }));
    expect(screen.getByText(/simulation preview selected locally.*No control-plane command was sent/i)).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith("/mode") && init?.method === "POST")).toBe(false);
  });

  it("keeps physical state unchanged when an approval request is rejected", async () => {
    const user = userEvent.setup();
    installLiveApi({
      mutation: () => jsonResponse({ detail: "Emergency stop is latched" }, 409),
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText("API SNAPSHOT")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Request physical approval" }));
    await waitFor(() => expect(screen.getByText(/Physical approval request was rejected: Emergency stop is latched/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Request physical approval" })).not.toHaveClass("active");
    expect(screen.getByText("Resolve east corridor frontier")).toBeInTheDocument();
  });

  it("awaits a physical request and reports approval without claiming actuation", async () => {
    const user = userEvent.setup();
    let resolveMutation!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveMutation = resolve; });
    const reconciled = structuredClone(demoSnapshot);
    reconciled.system.mode = "PHYSICAL";
    installLiveApi({ reconciled, mutation: () => pending });
    render(<App />);
    await waitFor(() => expect(screen.getByText("API SNAPSHOT")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Request physical approval" }));
    expect(screen.getByRole("button", { name: "Physical approval request in progress" })).toBeDisabled();
    resolveMutation(jsonResponse({ message: "Approval required", hardware_command_sent: false, project: {}, approval: {} }));

    await waitFor(() => expect(screen.getByText(/Physical approval requested.*no actuator command was sent/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Physical approval pending" })).toBeDisabled();
    expect(screen.getByText("APPROVAL PENDING")).toBeInTheDocument();
  });

  it("waits for the control plane before resolving an approval", async () => {
    const user = userEvent.setup();
    let resolveMutation!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveMutation = resolve; });
    const reconciled = structuredClone(demoSnapshot);
    reconciled.approvals[0].status = "approved";
    installLiveApi({ reconciled, mutation: () => pending });
    render(<App />);
    await waitFor(() => expect(screen.getByText("API SNAPSHOT")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Approvals/ }));

    const approve = screen.getAllByRole("button", { name: "Approve scope" })[0];
    await user.click(approve);
    expect(approve).toBeDisabled();
    expect(screen.getByText("2 pending requests")).toBeInTheDocument();
    resolveMutation(jsonResponse({ message: "Approved", hardware_command_sent: false, project: {}, approval: { status: "approved" } }));

    await waitFor(() => expect(screen.getByText(/APR-109 approved by the control plane/)).toBeInTheDocument());
    expect(screen.getByText("1 pending requests")).toBeInTheDocument();
  });

  it("only confirms an emergency-stop latch after a successful API response", async () => {
    const user = userEvent.setup();
    let resolveMutation!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveMutation = resolve; });
    const stopped = structuredClone(demoSnapshot);
    stopped.robot.speed = 0;
    stopped.robot.status = "critical";
    stopped.system.health = "critical";
    stopped.mission.activeTask = "Emergency stop engaged";
    installLiveApi({
      reconciled: stopped,
      mutation: () => pending,
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText("API SNAPSHOT")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Request emergency stop" }));
    await user.click(screen.getByRole("button", { name: "Confirm emergency stop request" }));
    expect(screen.getByRole("button", { name: "Emergency stop request in progress" })).toBeDisabled();
    resolveMutation(jsonResponse({ message: "Latched", hardware_command_sent: false, project: {} }));

    await waitFor(() => expect(screen.getByText(/Emergency-stop control-plane latch confirmed/)).toBeInTheDocument());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("Emergency stop engaged")).toBeInTheDocument();
  });

  it("keeps the mission unchanged and the stop dialog open when E-stop fails", async () => {
    const user = userEvent.setup();
    installLiveApi({ mutation: () => jsonResponse({ detail: "Robot edge unavailable" }, 503) });
    render(<App />);
    await waitFor(() => expect(screen.getByText("API SNAPSHOT")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Request emergency stop" }));
    await user.click(screen.getByRole("button", { name: "Confirm emergency stop request" }));

    await waitFor(() => expect(screen.getByText(/No control-plane latch was confirmed/)).toBeInTheDocument());
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Resolve east corridor frontier")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm emergency stop request" })).toBeEnabled();
  });

  it("aligns objective form constraints and creates an explicitly local demo", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByText("DEMO DATA")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "New objective" }));

    const name = screen.getByLabelText("Project name");
    const objective = screen.getByLabelText("Engineering objective");
    expect(name).toHaveAttribute("minlength", "3");
    expect(name).toHaveAttribute("maxlength", "160");
    expect(objective).toHaveAttribute("minlength", "20");
    expect(objective).toHaveAttribute("maxlength", "5000");

    await user.type(name, "New Scout");
    await user.type(objective, "Inspect every room safely and build a map.");
    await user.click(screen.getByRole("button", { name: "Create objective" }));
    expect(screen.getByText(/Demo project created locally.*not persisted/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables objective controls while server creation is pending", async () => {
    const user = userEvent.setup();
    let resolveMutation!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveMutation = resolve; });
    installLiveApi({ mutation: () => pending });
    render(<App />);
    await waitFor(() => expect(screen.getByText("API SNAPSHOT")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "New objective" }));
    await user.type(screen.getByLabelText("Project name"), "Async Scout");
    await user.type(screen.getByLabelText("Engineering objective"), "Inspect every room safely and build a map.");
    await user.click(screen.getByRole("button", { name: "Create objective" }));

    expect(screen.getByRole("button", { name: "Creating objective" })).toBeDisabled();
    expect(screen.getByLabelText("Project name")).toBeDisabled();
    resolveMutation(jsonResponse({
      id: "async-scout",
      name: "Async Scout",
      objective: "Inspect every room safely and build a map.",
      updated_at: "now",
    }, 201));

    await waitFor(() => expect(screen.getByText("Objective created and engineering decomposition queued.")).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the objective dialog open and distinguishes server validation", async () => {
    const user = userEvent.setup();
    installLiveApi({ mutation: () => jsonResponse({ detail: "Objective violates project policy" }, 422) });
    render(<App />);
    await waitFor(() => expect(screen.getByText("API SNAPSHOT")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "New objective" }));
    await user.type(screen.getByLabelText("Project name"), "Policy Test");
    await user.type(screen.getByLabelText("Engineering objective"), "Inspect every room safely and build a map.");
    await user.click(screen.getByRole("button", { name: "Create objective" }));

    await waitFor(() => expect(screen.getByText(/Project creation failed validation: Objective violates project policy/)).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create objective" })).toBeEnabled();
  });

  it("runs an OpenAI engineering review and renders its advisory physical boundary", async () => {
    const user = userEvent.setup();
    const fetchMock = installLiveApi({
      mutation: (url) => url.endsWith("/ai-review")
        ? jsonResponse(engineeringReviewResponse())
        : jsonResponse({ message: "Command accepted", hardware_command_sent: false }),
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText("API SNAPSHOT")).toBeInTheDocument());
    await openRequirements(user);

    await user.click(screen.getByRole("button", { name: "Run OpenAI engineering review" }));

    expect(await screen.findByRole("heading", { name: "Independent evidence review" })).toBeInTheDocument();
    expect(screen.getByText("Advisory only")).toBeInTheDocument();
    expect(screen.getByText("Simulation only")).toBeInTheDocument();
    expect(screen.getByText("Physical execution disabled")).toBeInTheDocument();
    expect(screen.getByText("No hardware command sent")).toBeInTheDocument();
    expect(screen.getByText(/No launch, approval, or hardware action was triggered/i)).toBeInTheDocument();
    const reviewCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/ai-review"));
    expect(reviewCall?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(reviewCall?.[1]?.body))).toEqual({ requested_by: "dashboard.user" });
  });

  it("shows a configuration-specific 503 error without fabricating a review", async () => {
    const user = userEvent.setup();
    installLiveApi({ mutation: () => jsonResponse({ detail: "Engineering review is unavailable until OPENAI_API_KEY is configured" }, 503) });
    render(<App />);
    await waitFor(() => expect(screen.getByText("API SNAPSHOT")).toBeInTheDocument());
    await openRequirements(user);

    await user.click(screen.getByRole("button", { name: "Run OpenAI engineering review" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Set OPENAI_API_KEY on the NEXUS API and restart the service/i);
    expect(screen.queryByRole("heading", { name: "Independent evidence review" })).not.toBeInTheDocument();
  });

  it("reports a no-network review failure and produces no fallback AI result", async () => {
    const user = userEvent.setup();
    installLiveApi({ mutation: () => Promise.reject(new TypeError("Network unavailable")) });
    render(<App />);
    await waitFor(() => expect(screen.getByText("API SNAPSHOT")).toBeInTheDocument());
    await openRequirements(user);

    await user.click(screen.getByRole("button", { name: "Run OpenAI engineering review" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/NEXUS API could not be reached.*no AI result was generated/i);
    expect(screen.queryByRole("heading", { name: "Independent evidence review" })).not.toBeInTheDocument();
  });

  it("disables review controls and prevents double submission while OpenAI is pending", async () => {
    const user = userEvent.setup();
    let resolveReview!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveReview = resolve; });
    const fetchMock = installLiveApi({ mutation: () => pending });
    render(<App />);
    await waitFor(() => expect(screen.getByText("API SNAPSHOT")).toBeInTheDocument());
    await openRequirements(user);

    await user.click(screen.getByRole("button", { name: "Run OpenAI engineering review" }));
    const pendingButton = screen.getByRole("button", { name: "OpenAI engineering review in progress" });
    expect(pendingButton).toBeDisabled();
    pendingButton.click();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/ai-review"))).toHaveLength(1);

    resolveReview(jsonResponse(engineeringReviewResponse()));
    expect(await screen.findByRole("heading", { name: "Independent evidence review" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run OpenAI engineering review" })).toBeEnabled();
  });
});
