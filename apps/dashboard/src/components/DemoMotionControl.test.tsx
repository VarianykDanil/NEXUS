import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { DemoMotionControl } from "./DemoMotionControl";

function response(running: boolean) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      enabled: true,
      running,
      simulation_only: true,
      frame_interval_seconds: 0.25,
      speed_multiplier: 1,
      message: running ? "Virtual fleet motion is streaming." : "Virtual fleet motion is stopped.",
      hardware_command_sent: false,
    }),
  };
}

describe("DemoMotionControl", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the live rate and stops only the virtual motion worker", async () => {
    const robots = demoSnapshot.robots.map((robot) => ({
      ...robot,
      connection: "virtual_demo_stream_live",
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(false));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <DemoMotionControl
        projectId="project / 1"
        robots={robots}
        apiEnabled
      />,
    );

    expect(screen.getByText("VIRTUAL FLEET LIVE")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Virtual motion facts"))
      .toHaveTextContent("4 updates/sec"));
    const stop = screen.getByRole("button", { name: "Stop virtual motion" });
    await user.click(stop);

    await waitFor(() => expect(screen.getByText("VIRTUAL FLEET STOPPED")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/demo-motion\/stop$/);
    expect(screen.getByText(/simulation only.*no hardware command/i)).toBeInTheDocument();
  });
});
