import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildingState, FleetRobot } from "./model";
import { DigitalTwinViewport } from "./DigitalTwinViewport";

const setCameraPreset = vi.fn();

vi.mock("./Building3D", async () => {
  const React = await import("react");
  const MockBuilding = React.forwardRef((_props, ref) => {
    React.useImperativeHandle(ref, () => ({
      setCameraPreset,
      reset: vi.fn(),
      zoom: vi.fn(),
    }));
    return <div data-testid="mock-building-3d">Interactive 3D building</div>;
  });
  return { default: MockBuilding };
});

const floor = {
  id: "ground",
  label: "Ground floor",
  level: 0,
  elevation: 0,
  height: 3.2,
  width: 20,
  depth: 12,
  coverage: 76,
  rooms: [{ id: "lobby", label: "Lobby", kind: "public", x: 1, y: 1, width: 8, depth: 5, explored: 100 }],
  walls: [
    { id: "north", x1: 0, y1: 12, x2: 20, y2: 12, thickness: 0.18, height: 3.2 },
    { id: "south", x1: 0, y1: 0, x2: 20, y2: 0, thickness: 0.18, height: 3.2 },
  ],
  doors: [{ id: "entry", x: 5, y: 0, width: 1.2, orientation: "horizontal" as const }],
  connectors: [{ id: "stairs", kind: "stairs" as const, x: 15, y: 4, width: 2, depth: 4, targetFloorIds: ["upper"] }],
  hazards: [{ id: "hazard-1", type: "Thermal anomaly", severity: "high" as const, x: 7, y: 4, z: 0, confidence: 94, detectedAt: "2026-07-12T12:00:00Z" }],
  path: [{ x: 2, y: 2, z: 0, floorId: "ground" }, { x: 5, y: 3, z: 0, floorId: "ground" }],
};

const building: BuildingState = {
  id: "building-1",
  name: "Responder training centre",
  width: 20,
  depth: 12,
  floorHeight: 3.2,
  frame: "building_enu",
  floors: [
    floor,
    { ...floor, id: "upper", label: "Upper floor", level: 1, elevation: 3.2, coverage: 48, hazards: [], path: [] },
  ],
};

const robots: FleetRobot[] = [{
  id: "scout-1",
  name: "Scout One",
  model: "NEXUS M2",
  role: "Mapper",
  status: "nominal",
  connection: "digital_twin_connected",
  battery: 82,
  speed: 0.4,
  localization: 98,
  mission: "Ground sweep",
  pose: { x: 5, y: 3, z: 0, yaw: 90, floorId: "ground" },
  trail: floor.path,
}];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DigitalTwinViewport", () => {
  it("renders a metric, selectable top-down plan", async () => {
    const onRobotSelect = vi.fn();
    const user = userEvent.setup();
    render(<DigitalTwinViewport building={building} robots={robots} activeRobotId="scout-1" onRobotSelect={onRobotSelect} />);

    expect(screen.getByRole("img", { name: /Responder training centre top-down building plan/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2D plan/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("option", { name: "Ground floor · 76%" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Scout One, nominal/i }));
    expect(onRobotSelect).toHaveBeenCalledWith("scout-1");
    expect(screen.getByText(/X 5.00 m/)).toBeInTheDocument();
  });

  it("carves door openings and keeps walls and labels above route strokes", () => {
    const { container } = render(
      <DigitalTwinViewport building={building} robots={robots} activeRobotId="scout-1" />,
    );
    const trail = container.querySelector(".spatial-robot-trail");
    const wall = container.querySelector(".spatial-wall-layer line");
    const label = container.querySelector(".spatial-room-label-layer text");

    expect(container.querySelectorAll(".spatial-wall-layer line")).toHaveLength(3);
    expect(container.querySelector(".spatial-door-gap")).not.toBeInTheDocument();
    expect(trail?.compareDocumentPosition(wall as Node) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(wall?.compareDocumentPosition(label as Node) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("interpolates a safe short pose update and cancels animation on unmount", () => {
    const frames: FrameRequestCallback[] = [];
    let frameId = 0;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      frameId += 1;
      return frameId;
    });
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const { rerender, unmount } = render(
      <DigitalTwinViewport building={building} robots={robots} activeRobotId="scout-1" />,
    );
    const movedRobots = [{
      ...robots[0],
      pose: { ...robots[0].pose, x: 5.5, yaw: 110 },
      trail: [...robots[0].trail, { x: 5.5, y: 3, z: 0, floorId: "ground" }],
    }];

    rerender(<DigitalTwinViewport building={building} robots={movedRobots} activeRobotId="scout-1" />);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    act(() => frames.shift()?.(1_350));

    expect(document.querySelector(".spatial-robot")?.getAttribute("transform")).toContain("rotate(-100)");
    expect(requestFrame).toHaveBeenCalledTimes(2);
    unmount();
    expect(cancelFrame).toHaveBeenCalledWith(2);
    now.mockRestore();
  });

  it("switches lazily to 3D and exposes floor and layer controls", async () => {
    const user = userEvent.setup();
    render(<DigitalTwinViewport building={building} robots={robots} activeRobotId="scout-1" />);

    await user.click(screen.getByRole("button", { name: /3D building/i }));
    expect(await screen.findByTestId("mock-building-3d")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /3D building/i })).toHaveAttribute("aria-pressed", "true");

    await user.selectOptions(screen.getByLabelText("Floor"), "all");
    expect(screen.getByLabelText("Floor")).toHaveValue("all");

    await user.click(screen.getByText("Layers"));
    const hazards = screen.getByRole("checkbox", { name: "Hazards" });
    expect(hazards).toBeChecked();
    await user.click(hazards);
    expect(hazards).not.toBeChecked();
  });

  it("uses the isometric camera action as a direct path from plan to 3D", async () => {
    const user = userEvent.setup();
    render(<DigitalTwinViewport building={building} robots={robots} />);

    await user.click(screen.getByRole("button", { name: "Isometric camera" }));
    expect(await screen.findByTestId("mock-building-3d")).toBeInTheDocument();
  });

  it("frames the whole building by selecting every floor", async () => {
    const user = userEvent.setup();
    render(<DigitalTwinViewport building={building} robots={robots} />);

    expect(screen.getByLabelText("Floor")).toHaveValue("ground");
    await user.click(screen.getByRole("button", { name: "Frame whole building" }));
    expect(screen.getByLabelText("Floor")).toHaveValue("all");
  });

  it("applies the deferred home camera after expanding a single-floor 3D view", async () => {
    const user = userEvent.setup();
    render(<DigitalTwinViewport building={building} robots={robots} />);

    await user.click(screen.getByRole("button", { name: /3D building/i }));
    await user.click(screen.getByRole("button", { name: "Frame whole building" }));

    expect(screen.getByLabelText("Floor")).toHaveValue("all");
    await waitFor(() => expect(setCameraPreset).toHaveBeenCalledWith("home"));
  });

  it("protects page scrolling behind an explicit 3D interaction gate on coarse pointers", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } satisfies MediaQueryList)));
    const user = userEvent.setup();
    render(<DigitalTwinViewport building={building} robots={robots} />);

    await user.click(screen.getByRole("button", { name: /3D building/i }));
    const interact = screen.getByRole("button", { name: "Interact with 3D" });
    expect(interact).toHaveAttribute("aria-pressed", "false");
    await user.click(interact);
    expect(screen.getByRole("button", { name: "Done" })).toHaveAttribute("aria-pressed", "true");
  });
});
