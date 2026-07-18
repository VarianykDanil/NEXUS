import { useCallback, useEffect, useRef, useState } from "react";
import { connectProjectSocket, fetchProjectDashboard, normalizeDashboardSnapshot } from "../lib/api";
import type { DataSourceState } from "../lib/dataSource";
import type { DashboardSnapshot, RealtimeEvent } from "../types";

export type { DataSourceState } from "../lib/dataSource";

const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 4_000;
const MAX_TRAIL_POINTS = 120;

type UnknownRecord = Record<string, unknown>;
type FleetRobot = DashboardSnapshot["robots"][number];
type FleetPose = FleetRobot["pose"];

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function healthStatus(value: unknown, fallback: FleetRobot["status"]): FleetRobot["status"] {
  return value === "nominal" || value === "warning" || value === "critical" || value === "offline"
    ? value
    : fallback;
}

function normalizedPose(value: unknown, fallback?: FleetPose): FleetPose | undefined {
  if (!isRecord(value)) return fallback;
  const floorId = nonEmptyString(value.floorId ?? value.floor_id, fallback?.floorId ?? "");
  const x = finiteNumber(value.x, Number.NaN);
  const y = finiteNumber(value.y, Number.NaN);
  const z = finiteNumber(value.z, fallback?.z ?? Number.NaN);
  const yaw = finiteNumber(value.yaw, fallback?.yaw ?? Number.NaN);
  if (!floorId || ![x, y, z, yaw].every(Number.isFinite)) return fallback;
  return { x, y, z, yaw, floorId };
}

function normalizedTrail(value: unknown, fallback: FleetRobot["trail"], pose: FleetPose): FleetRobot["trail"] {
  if (!Array.isArray(value)) return fallback;
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const floorId = nonEmptyString(item.floorId ?? item.floor_id, pose.floorId);
    const x = finiteNumber(item.x, Number.NaN);
    const y = finiteNumber(item.y, Number.NaN);
    const z = finiteNumber(item.z, pose.z);
    return floorId && [x, y, z].every(Number.isFinite) ? [{ x, y, z, floorId }] : [];
  }).slice(-MAX_TRAIL_POINTS);
}

function normalizedRobot(value: unknown, existing?: FleetRobot): FleetRobot | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id, existing?.id ?? "");
  const pose = normalizedPose(value.pose, existing?.pose);
  if (!id || !pose) return undefined;

  const fallback: FleetRobot = existing ?? {
    id,
    name: id,
    model: "Unknown model",
    role: "Robot",
    status: "offline",
    connection: "unknown",
    battery: 0,
    speed: 0,
    localization: 0,
    mission: "Unassigned",
    pose,
    trail: [],
  };

  return {
    id,
    name: nonEmptyString(value.name, fallback.name),
    model: nonEmptyString(value.model, fallback.model),
    role: nonEmptyString(value.role, fallback.role),
    status: healthStatus(value.status, fallback.status),
    connection: nonEmptyString(value.connection, fallback.connection),
    battery: finiteNumber(value.battery, fallback.battery),
    speed: finiteNumber(value.speed, fallback.speed),
    localization: finiteNumber(value.localization, fallback.localization),
    mission: nonEmptyString(value.mission, fallback.mission),
    pose,
    trail: normalizedTrail(value.trail, fallback.trail, pose),
  };
}

function normalizedFleet(value: unknown, existing: FleetRobot[]): FleetRobot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const byId = new Map(existing.map((robot) => [robot.id, robot]));
  const robots = value.flatMap((item) => {
    const id = isRecord(item) && typeof item.id === "string" ? item.id : "";
    const robot = normalizedRobot(item, byId.get(id));
    return robot ? [robot] : [];
  });
  return robots.length > 0 ? robots : undefined;
}

function mergeDynamicFloors(snapshot: DashboardSnapshot, value: unknown): DashboardSnapshot {
  if (!Array.isArray(value)) return snapshot;
  const projections = new Map<string, UnknownRecord>();
  value.forEach((item) => {
    if (isRecord(item) && typeof item.id === "string") projections.set(item.id, item);
  });
  if (projections.size === 0) return snapshot;

  let changed = false;
  const floors = snapshot.building.floors.map((floor) => {
    const projection = projections.get(floor.id);
    if (!projection) return floor;
    changed = true;
    const defaultPose: FleetPose = {
      x: 0,
      y: 0,
      z: floor.elevation,
      yaw: 0,
      floorId: floor.id,
    };
    const path = normalizedTrail(projection.path, floor.path, defaultPose);
    const existingHazards = new Map(floor.hazards.map((hazard) => [hazard.id, hazard]));
    const hazards = Array.isArray(projection.hazards)
      ? projection.hazards.flatMap((item) => {
        if (!isRecord(item)) return [];
        const id = nonEmptyString(item.id, "");
        if (!id) return [];
        const fallback = existingHazards.get(id);
        const x = finiteNumber(item.x, fallback?.x ?? Number.NaN);
        const y = finiteNumber(item.y, fallback?.y ?? Number.NaN);
        const z = finiteNumber(item.z, fallback?.z ?? floor.elevation);
        if (![x, y, z].every(Number.isFinite)) return [];
        const severity = item.severity === "low" || item.severity === "medium" || item.severity === "high"
          ? item.severity
          : fallback?.severity ?? "medium";
        return [{
          id,
          type: nonEmptyString(item.type, fallback?.type ?? "Detected hazard"),
          severity,
          x,
          y,
          z,
          confidence: finiteNumber(item.confidence, fallback?.confidence ?? 0),
          detectedAt: nonEmptyString(item.detectedAt ?? item.detected_at, fallback?.detectedAt ?? "live"),
        }];
      })
      : floor.hazards;
    const roomProjections = new Map<string, UnknownRecord>();
    if (Array.isArray(projection.rooms)) {
      projection.rooms.forEach((item) => {
        if (isRecord(item) && typeof item.id === "string") roomProjections.set(item.id, item);
      });
    }
    const rooms = roomProjections.size > 0
      ? floor.rooms.map((room) => {
        const roomProjection = roomProjections.get(room.id);
        if (!roomProjection) return room;
        const explored = Math.min(100, Math.max(0, finiteNumber(roomProjection.explored, room.explored)));
        return explored === room.explored ? room : { ...room, explored };
      })
      : floor.rooms;
    return {
      ...floor,
      coverage: finiteNumber(projection.coverage, floor.coverage),
      hazards,
      rooms,
      path,
    };
  });
  return changed ? { ...snapshot, building: { ...snapshot.building, floors } } : snapshot;
}

function projectFleet(snapshot: DashboardSnapshot, robots: FleetRobot[]): DashboardSnapshot {
  const primary = robots.find((robot) => robot.id === snapshot.robot.id) ?? robots[0];
  if (!primary) return { ...snapshot, robots };
  return {
    ...snapshot,
    robots,
    robot: {
      ...snapshot.robot,
      id: primary.id,
      name: primary.name,
      model: primary.model,
      pose: { x: primary.pose.x, y: primary.pose.y, yaw: primary.pose.yaw },
      battery: primary.battery,
      speed: primary.speed,
      localization: primary.localization,
      status: primary.status,
    },
    telemetry: snapshot.telemetry.map((metric) => {
      const value = metric.id === "battery"
        ? primary.battery
        : metric.id === "localization"
          ? primary.localization
          : metric.value;
      return value === metric.value
        ? metric
        : { ...metric, value, trend: [...metric.trend.slice(-19), value], status: primary.status };
    }),
  };
}

function appendPoseToPrimaryFleet(
  snapshot: DashboardSnapshot,
  poseValue: unknown,
  battery: number,
  speed: number,
): FleetRobot[] {
  if (!isRecord(poseValue)) return snapshot.robots;
  const primaryIndex = Math.max(0, snapshot.robots.findIndex((robot) => robot.id === snapshot.robot.id));
  const primary = snapshot.robots[primaryIndex];
  if (!primary) return snapshot.robots;
  const pose = normalizedPose(poseValue, primary.pose);
  if (!pose) return snapshot.robots;

  const lastPoint = primary.trail.at(-1);
  const changed = !lastPoint
    || lastPoint.x !== pose.x
    || lastPoint.y !== pose.y
    || lastPoint.z !== pose.z
    || lastPoint.floorId !== pose.floorId;
  const trail = changed
    ? [...primary.trail, { x: pose.x, y: pose.y, z: pose.z, floorId: pose.floorId }].slice(-MAX_TRAIL_POINTS)
    : primary.trail;
  const robots = [...snapshot.robots];
  robots[primaryIndex] = { ...primary, pose, trail, battery, speed };
  return robots;
}

export function applyEvent(snapshot: DashboardSnapshot, event: RealtimeEvent): DashboardSnapshot {
  if (event.type === "snapshot" || event.type === "dashboard.snapshot") {
    return normalizeDashboardSnapshot(event.data ?? event.payload, snapshot);
  }

  const payload = event.payload ?? (isRecord(event.data) ? event.data : {});
  if (event.type === "robots.state.updated") {
    const robots = normalizedFleet(payload.robots, snapshot.robots);
    const fleetSnapshot = robots ? projectFleet(snapshot, robots) : snapshot;
    return mergeDynamicFloors(fleetSnapshot, payload.floors);
  }

  if (event.type === "telemetry.updated") {
    const robot = payload.robot && typeof payload.robot === "object" ? payload.robot : {};
    const metric = payload.metric && typeof payload.metric === "object" ? payload.metric as { id?: string } : undefined;
    return {
      ...snapshot,
      robot: { ...snapshot.robot, ...robot },
      telemetry: metric?.id
        ? snapshot.telemetry.map((item) => item.id === metric.id ? { ...item, ...metric } : item)
        : snapshot.telemetry,
    };
  }

  if (event.type === "mission.updated") {
    return { ...snapshot, mission: { ...snapshot.mission, ...payload } };
  }

  if (event.type === "pipeline.updated") {
    const task = payload.task as { id?: string } | undefined;
    if (!task?.id) return snapshot;
    return {
      ...snapshot,
      pipeline: snapshot.pipeline.map((item) => item.id === task.id ? { ...item, ...task } : item),
    };
  }

  if (event.type.startsWith("simulation.")) {
    const progress = Math.min(100, Math.max(0, finiteNumber(payload.progress, snapshot.mission.progress)));
    const coverage = typeof payload.map_coverage_percent === "number"
      ? payload.map_coverage_percent
      : snapshot.map.coverage;
    const battery = typeof payload.battery_percent === "number"
      ? payload.battery_percent
      : snapshot.robot.battery;
    const hazardCount = typeof payload.hazards_detected === "number"
      ? payload.hazards_detected
      : snapshot.map.hazards.length;
    const phase = typeof payload.phase === "string"
      ? payload.phase.replaceAll("_", " ")
      : event.type.replaceAll(".", " ");
    const rawPose = isRecord(payload.pose) ? payload.pose : undefined;
    const pose = rawPose
      ? {
        x: finiteNumber(rawPose.x, snapshot.robot.pose.x),
        y: finiteNumber(rawPose.y, snapshot.robot.pose.y),
        yaw: finiteNumber(rawPose.yaw, snapshot.robot.pose.yaw),
      }
      : snapshot.robot.pose;
    const failed = event.type === "simulation.failed";
    const complete = event.type === "simulation.completed" || progress >= 100;
    const speed = complete || failed ? 0 : snapshot.robot.speed;
    const posedRobots = appendPoseToPrimaryFleet(snapshot, rawPose, battery, speed);
    const robots = failed
      ? posedRobots.map((robot) => robot.id === snapshot.robot.id
        ? { ...robot, speed: 0, status: "warning" as const, connection: "digital_twin_error" }
        : robot)
      : posedRobots;
    return {
      ...snapshot,
      robots,
      system: failed ? { ...snapshot.system, health: "warning" } : snapshot.system,
      mission: {
        ...snapshot.mission,
        progress,
        phase,
        currentStep: complete
          ? snapshot.mission.totalSteps
          : Math.max(snapshot.mission.currentStep, Math.ceil(progress / 20)),
        eta: complete ? "complete" : failed ? "unavailable" : snapshot.mission.eta,
        activeTask: failed ? "Review simulation failure" : snapshot.mission.activeTask,
      },
      robot: {
        ...snapshot.robot,
        battery,
        speed,
        pose,
        status: failed ? "warning" : snapshot.robot.status,
      },
      map: {
        ...snapshot.map,
        coverage,
      },
      telemetry: snapshot.telemetry.map((metric) => {
        const value = metric.id === "battery"
          ? battery
          : metric.id === "map_coverage"
            ? coverage
            : metric.id === "hazards_detected"
              ? hazardCount
              : metric.value;
        return value === metric.value
          ? metric
          : { ...metric, value, trend: [...metric.trend.slice(-19), value] };
      }),
      pipeline: snapshot.pipeline.map((task) => failed && task.category === "simulate"
        ? { ...task, status: "failed", detail: `Simulation halted${typeof payload.error_type === "string" ? ` · ${payload.error_type}` : ""}` }
        : complete && task.category !== "deploy"
        ? { ...task, status: "complete", detail: "100% complete - simulation evidence recorded" }
        : task.category === "simulate"
          ? {
            ...task,
            status: "running",
            detail: `${progress.toFixed(0)}% complete - ${phase}`,
          }
          : task),
    };
  }

  if ((event.type === "approval.created" || event.type === "approval.requested") && payload.approval && typeof payload.approval === "object") {
    const raw = payload.approval as Record<string, unknown>;
    const id = String(raw.id ?? "");
    if (!id || snapshot.approvals.some((approval) => approval.id === id)) return snapshot;
    const risk = raw.risk === "low" || raw.risk === "medium" ? raw.risk : "high";
    const approval: DashboardSnapshot["approvals"][number] = {
      id,
      title: "Authorize physical launch",
      description: "Permit a hardware-ready transition. The physical adapter remains denied in this build.",
      risk,
      status: "pending",
      requestedBy: String(raw.requested_by ?? "Safety Gate"),
      requestedAt: String(raw.requested_at ?? "now"),
      scope: ["This project only", "No hardware commands", "Emergency stop enforced"],
    };
    return {
      ...snapshot,
      system: { ...snapshot.system, health: "warning", safetyLock: true },
      mission: {
        ...snapshot.mission,
        phase: "Awaiting approval",
        activeTask: "Review physical deployment scope",
      },
      approvals: [approval, ...snapshot.approvals],
    };
  }

  if (event.type === "safety.emergency_stop") {
    const eventRobots = normalizedFleet(payload.robots, snapshot.robots);
    const robots = (eventRobots ?? snapshot.robots).map((robot) => ({
      ...robot,
      status: "critical" as const,
      connection: "stopped",
      speed: 0,
    }));
    const stopped = projectFleet(snapshot, robots);
    return {
      ...stopped,
      system: { ...stopped.system, health: "critical", safetyLock: true },
      mission: { ...stopped.mission, phase: "Emergency stopped", activeTask: "Motion inhibited" },
      robot: { ...stopped.robot, speed: 0, status: "critical" },
    };
  }

  return snapshot;
}

function eventSequence(event: RealtimeEvent): number | undefined {
  return typeof event.sequence === "number" && Number.isSafeInteger(event.sequence) && event.sequence >= 0
    ? event.sequence
    : undefined;
}

export function useProjectDashboard(initialSnapshot: DashboardSnapshot) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [source, setSource] = useState<DataSourceState>("connecting");
  const fallbackRef = useRef(initialSnapshot);

  useEffect(() => {
    fallbackRef.current = initialSnapshot;
    setSnapshot(initialSnapshot);
    setSource("connecting");

    const controller = new AbortController();
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let connectionGeneration = 0;
    let reconnectAttempt = 0;
    let socketOpen = false;
    let realtimeUnavailable = false;
    let serverDataAvailable = false;
    let initialFetchSettled = false;
    let streamId: string | undefined;
    let lastSequence: number | undefined;
    let reconcileInFlight = false;
    let queuedEvents: RealtimeEvent[] = [];

    const connectedSource = () => {
      if (disposed) return;
      if (socketOpen) {
        setSource("live");
      } else if (serverDataAvailable) {
        setSource("snapshot");
      } else if (!initialFetchSettled) {
        setSource("connecting");
      } else {
        setSource("demo");
      }
    };

    const applyQueuedEvents = (base: DashboardSnapshot, events: RealtimeEvent[]) =>
      events.reduce((current, event) => applyEvent(current, event), base);

    const reconcile = () => {
      if (disposed || reconcileInFlight) return;
      reconcileInFlight = true;
      fetchProjectDashboard(initialSnapshot.project.id, fallbackRef.current, controller.signal)
        .then((remote) => {
          if (disposed) return;
          serverDataAvailable = true;
          const events = queuedEvents;
          queuedEvents = [];
          reconcileInFlight = false;
          setSnapshot(applyQueuedEvents(remote, events));
          connectedSource();
        })
        .catch((error: unknown) => {
          if (disposed || controller.signal.aborted) return;
          const events = queuedEvents;
          queuedEvents = [];
          reconcileInFlight = false;
          if (events.length > 0) {
            setSnapshot((current) => applyQueuedEvents(current, events));
          }
          if (!(error instanceof DOMException && error.name === "AbortError")) connectedSource();
        })
        .finally(() => {
          if (!initialFetchSettled) {
            initialFetchSettled = true;
            connectedSource();
          }
        });
    };

    const receiveEvent = (event: RealtimeEvent) => {
      if (disposed || (event.project_id && event.project_id !== initialSnapshot.project.id)) return;
      const sequence = eventSequence(event);
      const incomingStream = typeof event.stream_id === "string" && event.stream_id ? event.stream_id : undefined;
      const authoritativeSnapshot = event.type === "snapshot" || event.type === "dashboard.snapshot";
      let gapDetected = false;

      if (incomingStream && incomingStream !== streamId) {
        streamId = incomingStream;
        lastSequence = undefined;
        gapDetected = !authoritativeSnapshot;
      }
      if (sequence !== undefined) {
        if (lastSequence !== undefined) {
          if (sequence < lastSequence || (sequence === lastSequence && !authoritativeSnapshot)) return;
          if (!authoritativeSnapshot && sequence > lastSequence + 1) gapDetected = true;
        }
        lastSequence = sequence;
      }

      if (reconcileInFlight || gapDetected) {
        queuedEvents.push(event);
      } else {
        setSnapshot((current) => applyEvent(current, event));
      }
      if (gapDetected) reconcile();
    };

    const scheduleReconnect = () => {
      if (disposed || realtimeUnavailable || reconnectTimer !== undefined) return;
      const exponent = Math.min(reconnectAttempt, 4);
      const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * (2 ** exponent));
      reconnectAttempt = Math.min(reconnectAttempt + 1, 4);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        openSocket();
      }, delay);
    };

    const openSocket = () => {
      if (disposed) return;
      const generation = ++connectionGeneration;
      let closed = false;
      const handleClose = () => {
        if (disposed || generation !== connectionGeneration || closed) return;
        closed = true;
        socketOpen = false;
        connectedSource();
        scheduleReconnect();
      };

      try {
        const nextSocket = connectProjectSocket(initialSnapshot.project.id, {
          onEvent: (event) => {
            if (generation === connectionGeneration) receiveEvent(event);
          },
          onOpen: () => {
            if (disposed || generation !== connectionGeneration) return;
            socketOpen = true;
            serverDataAvailable = true;
            reconnectAttempt = 0;
            setSource("live");
          },
          onClose: handleClose,
        });
        socket = nextSocket;
        if (!nextSocket) {
          realtimeUnavailable = true;
          connectedSource();
        }
      } catch {
        handleClose();
      }
    };

    reconcile();
    openSocket();

    return () => {
      disposed = true;
      connectionGeneration += 1;
      controller.abort();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
      queuedEvents = [];
    };
  }, [initialSnapshot]);

  const update = useCallback((updater: (current: DashboardSnapshot) => DashboardSnapshot) => {
    setSnapshot(updater);
  }, []);

  return { snapshot, source, update };
}
