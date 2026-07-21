import { Bot, Pause, Play, RadioTower, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  fetchDemoMotionStatus,
  startDemoMotion,
  stopDemoMotion,
} from "../lib/api";
import type { DemoMotionStatus, FleetRobot } from "../types";

interface DemoMotionControlProps {
  projectId: string;
  robots: FleetRobot[];
  apiEnabled: boolean;
}

export function DemoMotionControl({
  projectId,
  robots,
  apiEnabled,
}: DemoMotionControlProps) {
  const [status, setStatus] = useState<DemoMotionStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!apiEnabled) {
      setStatus(null);
      setError(null);
      return undefined;
    }
    const controller = new AbortController();
    const refresh = () => {
      void fetchDemoMotionStatus(projectId, controller.signal)
        .then((next) => {
          setStatus(next);
          setError(null);
        })
        .catch((caught: unknown) => {
          if (!(caught instanceof DOMException && caught.name === "AbortError")) {
            setError(caught instanceof Error ? caught.message : "Motion status is unavailable");
          }
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 4_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [apiEnabled, projectId]);

  const observedMoving = useMemo(
    () => robots.filter((robot) => (
      robot.connection === "virtual_demo_stream_live" && robot.speed > 0
    )).length,
    [robots],
  );
  const running = status?.running ?? observedMoving > 0;
  const movingCount = running ? observedMoving || robots.length : 0;
  const frameRate = status ? Math.round(1 / status.frameIntervalSeconds) : null;

  async function toggleMotion(): Promise<void> {
    if (!status || pending) return;
    setPending(true);
    setError(null);
    try {
      const next = status.running
        ? await stopDemoMotion(projectId)
        : await startDemoMotion(projectId);
      setStatus(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Motion command was not accepted");
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className={`demo-motion-control panel ${running ? "is-running" : ""}`}
      aria-labelledby="demo-motion-title"
    >
      <div className="demo-motion-identity">
        <span className="demo-motion-icon"><Bot size={22} /></span>
        <div>
          <span className="eyebrow">CONTINUOUS DIGITAL-TWIN FEED</span>
          <h2 id="demo-motion-title">Virtual fleet motion</h2>
          <p>{status?.message ?? (apiEnabled
            ? "Checking the authoritative motion worker..."
            : "Static showcase data; connect the API to control live movement.")}</p>
        </div>
      </div>
      <div className="demo-motion-facts" aria-label="Virtual motion facts">
        <span className={`demo-motion-state ${running ? "live" : ""}`}>
          <RadioTower size={14} /> {running ? "VIRTUAL FLEET LIVE" : "VIRTUAL FLEET STOPPED"}
        </span>
        <span><strong>{movingCount}</strong> robots moving</span>
        <span><strong>{frameRate ?? "—"}</strong> updates/sec</span>
        <span><strong>{status?.speedMultiplier.toFixed(1) ?? "—"}×</strong> route speed</span>
      </div>
      <div className="demo-motion-actions">
        <button
          className={`button ${running ? "secondary" : "primary"}`}
          type="button"
          disabled={!apiEnabled || !status || pending}
          onClick={() => void toggleMotion()}
        >
          {running ? <Pause size={15} /> : <Play size={15} />}
          {pending ? "Applying..." : running ? "Stop virtual motion" : "Start virtual motion"}
        </button>
        <span><ShieldCheck size={14} /> Simulation only · no hardware command</span>
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}
