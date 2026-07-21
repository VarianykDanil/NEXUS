import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  blockedWallSegments,
  clampProjectionPan,
  clientDeltaToSvg,
  createProjection,
  clamp,
  describeFloor,
  doorGeometry,
  floorBounds,
  floorGrid,
  interpolateRobotPose,
  roomLabelLayout,
  roomCenter,
  selectedFloors,
  shouldInterpolateRobotPose,
} from "./coordinates";
import type {
  BuildingFloor,
  BuildingState,
  FleetRobot,
  FloorSelection,
  MapJobTarget,
  RobotPose,
  SpatialHazard,
  SpatialLayers,
  Vec2,
  VerticalConnector,
} from "./model";

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 620;
const SINGLE_FLOOR_PADDING = 50;
const MULTI_FLOOR_PADDING = 52;
const MIN_POSE_ANIMATION_MS = 180;
const MAX_POSE_ANIMATION_MS = 700;

export type SpatialEntitySelection =
  | { kind: "robot"; id: string }
  | { kind: "hazard"; id: string; floorId: string }
  | null;

export interface FloorPlan2DProps {
  building: BuildingState;
  robots: FleetRobot[];
  floorSelection: FloorSelection;
  activeRobotId?: string;
  selection: SpatialEntitySelection;
  layers: SpatialLayers;
  zoom: number;
  resetVersion: number;
  compact?: boolean;
  jobTargeting?: boolean;
  jobTarget?: MapJobTarget | null;
  onRobotSelect: (id: string) => void;
  onHazardSelect: (hazard: SpatialHazard, floorId: string) => void;
  onJobTargetSelect?: (target: MapJobTarget) => void;
}

interface DragState {
  pointerId: number;
  origin: Vec2;
  pan: Vec2;
}

function connectorLabel(connector: VerticalConnector): string {
  return connector.kind === "elevator" ? "LIFT" : "STAIRS";
}

function ConnectorMark({
  connector,
  project,
  distance,
  labels,
}: {
  connector: VerticalConnector;
  project: (point: Vec2) => Vec2;
  distance: (metres: number) => number;
  labels: boolean;
}) {
  const topLeft = project({ x: connector.x, y: connector.y + connector.depth });
  const width = distance(connector.width);
  const height = distance(connector.depth);
  const lines = Array.from({ length: 5 }, (_, index) => topLeft.y + ((index + 1) / 6) * height);

  return (
    <g className={`spatial-connector spatial-connector-${connector.kind}`}>
      <title>{connectorLabel(connector)}</title>
      <rect x={topLeft.x} y={topLeft.y} width={width} height={height} rx="2" />
      {connector.kind === "stairs" ? (
        lines.map((y) => <line key={y} x1={topLeft.x + 3} x2={topLeft.x + width - 3} y1={y} y2={y} />)
      ) : (
        <>
          <line x1={topLeft.x + 4} x2={topLeft.x + width - 4} y1={topLeft.y + 4} y2={topLeft.y + height - 4} />
          <line x1={topLeft.x + width - 4} x2={topLeft.x + 4} y1={topLeft.y + 4} y2={topLeft.y + height - 4} />
        </>
      )}
      {labels && <text x={topLeft.x + width / 2} y={topLeft.y + height / 2 + 3}>{connectorLabel(connector)}</text>}
    </g>
  );
}

function HazardMark({
  hazard,
  floor,
  point,
  selected,
  onSelect,
}: {
  hazard: SpatialHazard;
  floor: BuildingFloor;
  point: Vec2;
  selected: boolean;
  onSelect: () => void;
}) {
  const label = `${hazard.type}, ${hazard.severity} severity, ${hazard.confidence.toFixed(0)}% confidence, ${floor.label}`;
  return (
    <g
      className={`spatial-hazard severity-${hazard.severity}${selected ? " is-selected" : ""}`}
      transform={`translate(${point.x} ${point.y})`}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <circle className="spatial-hit-target" r="22" />
      <circle className="spatial-hazard-aura" r="13" />
      <path d="M0 -8 L8 7 L-8 7 Z" />
      <line x1="0" x2="0" y1="-3" y2="2" />
      <circle cy="5" r="1" />
    </g>
  );
}

function RobotMark({
  robot,
  point,
  active,
  selected,
  onSelect,
}: {
  robot: FleetRobot;
  point: Vec2;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <g
      className={`spatial-robot status-${robot.status}${active ? " is-active" : ""}${selected ? " is-selected" : ""}`}
      transform={`translate(${point.x} ${point.y}) rotate(${-robot.pose.yaw})`}
      role="button"
      tabIndex={0}
      aria-label={`${robot.name}, ${robot.status}, ${robot.pose.x.toFixed(1)} by ${robot.pose.y.toFixed(1)} metres`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <rect className="spatial-hit-target" x="-22" y="-22" width="44" height="44" rx="8" />
      {active && <circle className="spatial-robot-range" r="21" />}
      <rect className="spatial-robot-body" x="-10" y="-7" width="20" height="14" rx="4" />
      <rect className="spatial-robot-wheel" x="-8" y="-10" width="5" height="4" rx="1" />
      <rect className="spatial-robot-wheel" x="3" y="-10" width="5" height="4" rx="1" />
      <rect className="spatial-robot-wheel" x="-8" y="6" width="5" height="4" rx="1" />
      <rect className="spatial-robot-wheel" x="3" y="6" width="5" height="4" rx="1" />
      <circle className="spatial-robot-lidar" r="3" />
      <path className="spatial-robot-heading" d="M13 0 L7 -4 L7 4 Z" />
    </g>
  );
}

export function FloorPlan2D({
  building,
  robots,
  floorSelection,
  activeRobotId,
  selection,
  layers,
  zoom,
  resetVersion,
  compact = false,
  jobTargeting = false,
  jobTarget,
  onRobotSelect,
  onHazardSelect,
  onJobTargetSelect,
}: FloorPlan2DProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [pan, setPan] = useState<Vec2>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [viewport, setViewport] = useState({ width: VIEW_WIDTH, height: VIEW_HEIGHT });
  const [displayedPoses, setDisplayedPoses] = useState<Record<string, RobotPose>>(() => (
    Object.fromEntries(robots.map((robot) => [robot.id, robot.pose]))
  ));
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const displayedPosesRef = useRef(displayedPoses);
  const animationFrameRef = useRef<number | null>(null);
  const floors = useMemo(() => selectedFloors(building, floorSelection), [building, floorSelection]);
  const frames = useMemo(
    () => floorGrid(floors.length, viewport.width, viewport.height),
    [floors.length, viewport.height, viewport.width],
  );
  const boundedPan = useMemo(() => {
    const floor = floors[0];
    const frame = frames[0];
    if (!floor || !frame || floors.length !== 1) return { x: 0, y: 0 };
    return clampProjectionPan(
      floorBounds(floor),
      { ...frame, padding: SINGLE_FLOOR_PADDING },
      zoom,
      pan,
    );
  }, [floors, frames, pan, zoom]);
  const renderedRobots = useMemo(() => robots.map((robot) => {
    const pose = displayedPoses[robot.id];
    return pose && pose.floorId === robot.pose.floorId ? { ...robot, pose } : robot;
  }), [displayedPoses, robots]);

  useEffect(() => {
    if (animationFrameRef.current !== null && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const targets = Object.fromEntries(robots.map((robot) => [robot.id, robot.pose]));
    const nextDisplayed = { ...targets };
    const animations: Array<{
      id: string;
      from: RobotPose;
      to: RobotPose;
      duration: number;
    }> = [];
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    for (const robot of robots) {
      const previous = displayedPosesRef.current[robot.id];
      const floor = building.floors.find((candidate) => candidate.id === robot.pose.floorId);
      if (!previous || !floor || !shouldInterpolateRobotPose(floor, previous, robot.pose, reducedMotion)) continue;

      const distance = Math.hypot(robot.pose.x - previous.x, robot.pose.y - previous.y);
      animations.push({
        id: robot.id,
        from: previous,
        to: robot.pose,
        duration: Math.min(
          MAX_POSE_ANIMATION_MS,
          Math.max(MIN_POSE_ANIMATION_MS, (distance / Math.max(0.25, robot.speed)) * 1000),
        ),
      });
      nextDisplayed[robot.id] = previous;
    }

    displayedPosesRef.current = nextDisplayed;
    setDisplayedPoses(nextDisplayed);
    if (animations.length === 0 || typeof window.requestAnimationFrame !== "function") return undefined;

    const startedAt = performance.now();
    const animate = (timestamp: number) => {
      let complete = true;
      const framePoses = { ...targets };
      for (const animation of animations) {
        const linearProgress = Math.min(1, Math.max(0, (timestamp - startedAt) / animation.duration));
        const easedProgress = linearProgress < 0.5
          ? 4 * linearProgress ** 3
          : 1 - (-2 * linearProgress + 2) ** 3 / 2;
        framePoses[animation.id] = interpolateRobotPose(animation.from, animation.to, easedProgress);
        complete = complete && linearProgress >= 1;
      }
      displayedPosesRef.current = framePoses;
      setDisplayedPoses(framePoses);
      if (!complete) animationFrameRef.current = window.requestAnimationFrame(animate);
      else animationFrameRef.current = null;
    };
    animationFrameRef.current = window.requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = null;
    };
  }, [building.floors, robots]);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;

    function commitSize(width: number, height: number) {
      if (width < 1 || height < 1) return;
      setViewport((current) => (
        Math.abs(current.width - width) < 0.5 && Math.abs(current.height - height) < 0.5
          ? current
          : { width, height }
      ));
    }

    const bounds = svg.getBoundingClientRect();
    commitSize(bounds.width, bounds.height);
    const observer = new ResizeObserver((entries) => {
      const size = entries[0]?.contentRect;
      if (size) commitSize(size.width, size.height);
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, [floors.length]);

  useEffect(() => {
    setPan({ x: 0, y: 0 });
    dragRef.current = null;
    setDragging(false);
  }, [floorSelection, resetVersion]);

  function startDrag(event: React.PointerEvent<SVGSVGElement>) {
    if (event.button > 0 || floors.length !== 1) return;
    if ((event.target as Element).closest(".spatial-robot, .spatial-hazard")) return;
    if (jobTargeting && onJobTargetSelect) {
      const floor = floors[0];
      const frame = frames[0];
      const renderedBounds = event.currentTarget.getBoundingClientRect();
      if (!floor || !frame || renderedBounds.width < 1 || renderedBounds.height < 1) return;
      const projection = createProjection(
        floorBounds(floor),
        { ...frame, padding: SINGLE_FLOOR_PADDING },
        zoom,
        boundedPan,
      );
      const point = projection.unproject({
        x: ((event.clientX - renderedBounds.left) / renderedBounds.width) * viewport.width,
        y: ((event.clientY - renderedBounds.top) / renderedBounds.height) * viewport.height,
      });
      const x = clamp(point.x, 0, floor.width);
      const y = clamp(point.y, 0, floor.depth);
      const room = floor.rooms.find((candidate) => (
        x >= candidate.x && x <= candidate.x + candidate.width
        && y >= candidate.y && y <= candidate.y + candidate.depth
      ));
      onJobTargetSelect({
        floorId: floor.id,
        x,
        y,
        roomId: room?.id,
        roomLabel: room?.label,
      });
      return;
    }
    if (event.pointerType === "touch") return;
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    dragRef.current = {
      pointerId: event.pointerId,
      origin: { x: event.clientX, y: event.clientY },
      pan: boundedPan,
    };
    setDragging(true);
  }

  function moveDrag(event: React.PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const renderedBounds = event.currentTarget.getBoundingClientRect();
    const delta = clientDeltaToSvg(
      { x: event.clientX - drag.origin.x, y: event.clientY - drag.origin.y },
      viewport,
      { width: renderedBounds.width, height: renderedBounds.height },
    );
    const floor = floors[0];
    const frame = frames[0];
    if (!floor || !frame) return;
    setPan(clampProjectionPan(
      floorBounds(floor),
      { ...frame, padding: SINGLE_FLOOR_PADDING },
      zoom,
      { x: drag.pan.x + delta.x, y: drag.pan.y + delta.y },
    ));
  }

  function endDrag(event: React.PointerEvent<SVGSVGElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (
      typeof event.currentTarget.hasPointerCapture === "function"
      && event.currentTarget.hasPointerCapture(event.pointerId)
      && typeof event.currentTarget.releasePointerCapture === "function"
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      className={`spatial-plan${compact ? " is-compact" : ""}${floors.length > 1 ? " has-multiple-floors" : ""}`}
      style={{ "--spatial-floor-count": floors.length } as CSSProperties}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${viewport.width} ${viewport.height}`}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
        className={`${dragging ? "is-dragging" : ""}${jobTargeting ? " is-job-targeting" : ""}`.trim()}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <title id={titleId}>{building.name} top-down building plan</title>
        <desc id={descriptionId}>
          Metric floor plan showing walls, doors, rooms, vertical connections, live robots, trails, and detected hazards.
        </desc>
        <defs>
          <pattern id={`${titleId}-grid`} width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" className="spatial-plan-grid-line" />
          </pattern>
          <filter id={`${titleId}-robot-glow`} x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect width={viewport.width} height={viewport.height} className="spatial-plan-background" />
        <rect width={viewport.width} height={viewport.height} fill={`url(#${titleId}-grid)`} />

        {floors.map((floor, floorIndex) => {
          const frame = frames[floorIndex];
          const framePan = floors.length === 1 ? boundedPan : { x: 0, y: 0 };
          const projection = createProjection(
            floorBounds(floor),
            { ...frame, padding: floors.length === 1 ? SINGLE_FLOOR_PADDING : MULTI_FLOOR_PADDING },
            floors.length === 1 ? zoom : 1,
            framePan,
          );
          const floorOrigin = projection.project({ x: 0, y: floor.depth });
          const floorWidth = projection.distance(floor.width);
          const floorDepth = projection.distance(floor.depth);
          const scaleMetres = Math.min(5, Math.max(1, Math.floor(floor.width / 5)));
          const scaleLength = projection.distance(scaleMetres);
          const scaleX = frame.x + 22;
          const scaleY = frame.y + frame.height - 18;
          const denseRoomLabels = viewport.width < 500;

          return (
            <g key={floor.id} aria-label={describeFloor(floor)}>
              <rect
                className="spatial-floor-plate"
                x={floorOrigin.x}
                y={floorOrigin.y}
                width={floorWidth}
                height={floorDepth}
              />

              {layers.rooms && floor.rooms.map((room) => {
                const roomTopLeft = projection.project({ x: room.x, y: room.y + room.depth });
                return (
                  <g
                    key={room.id}
                    className={`spatial-room${room.explored < 50 ? " is-unexplored" : ""}`}
                    aria-label={`${room.label}, ${room.explored.toFixed(0)}% mapped`}
                  >
                    <rect
                      x={roomTopLeft.x}
                      y={roomTopLeft.y}
                      width={projection.distance(room.width)}
                      height={projection.distance(room.depth)}
                      data-explored={Math.round(room.explored)}
                    />
                  </g>
                );
              })}

              {layers.trails && floor.path.length > 1 && (
                <polyline
                  className="spatial-planned-path"
                  points={floor.path.map((point) => {
                    const projected = projection.project(point);
                    return `${projected.x},${projected.y}`;
                  }).join(" ")}
                />
              )}

              {layers.trails && robots.filter((robot) => robot.trail.some((point) => point.floorId === floor.id)).map((robot) => {
                const points = robot.trail
                  .filter((point) => point.floorId === floor.id)
                  .map((point) => projection.project(point));
                return points.length > 1 ? (
                  <polyline
                    key={robot.id}
                    className={`spatial-robot-trail${robot.id === activeRobotId ? " is-active" : ""}`}
                    points={points.map((point) => `${point.x},${point.y}`).join(" ")}
                  />
                ) : null;
              })}

              <g className="spatial-wall-layer">
                {blockedWallSegments(floor).map((wall, index) => {
                  const start = projection.project(wall.start);
                  const end = projection.project(wall.end);
                  return (
                    <line
                      key={`${floor.id}-wall-fragment-${index}`}
                      x1={start.x}
                      y1={start.y}
                      x2={end.x}
                      y2={end.y}
                      strokeWidth={Math.max(2.2, projection.distance(wall.thickness))}
                    />
                  );
                })}
              </g>

              <g className="spatial-door-layer">
                {floor.doors.map((door) => {
                  const geometry = doorGeometry(door);
                  const hinge = projection.project(geometry.hinge);
                  const closedEnd = projection.project(geometry.closedEnd);
                  const openEnd = projection.project(geometry.openEnd);
                  const radius = projection.distance(door.width);
                  return (
                    <g key={door.id}>
                      <line className="spatial-door-leaf" x1={hinge.x} y1={hinge.y} x2={openEnd.x} y2={openEnd.y} />
                      <path
                        className="spatial-door-swing"
                        d={`M ${closedEnd.x} ${closedEnd.y} A ${radius} ${radius} 0 0 ${geometry.sweep} ${openEnd.x} ${openEnd.y}`}
                      />
                    </g>
                  );
                })}
              </g>

              {layers.connectors && floor.connectors.map((connector) => (
                <ConnectorMark
                  key={connector.id}
                  connector={connector}
                  project={projection.project}
                  distance={projection.distance}
                  labels={layers.labels && viewport.width >= 620}
                />
              ))}

              {layers.rooms && layers.labels && (
                <g className="spatial-room spatial-room-label-layer">
                  {floor.rooms.map((room) => {
                    const center = projection.project(roomCenter(room));
                    const roomWidth = projection.distance(room.width);
                    const roomHeight = projection.distance(room.depth);
                    const hasConnector = floor.connectors.some((connector) => (
                      connector.x < room.x + room.width
                      && connector.x + connector.width > room.x
                      && connector.y < room.y + room.depth
                      && connector.y + connector.depth > room.y
                    ));
                    const hasHazard = floor.hazards.some((hazard) => (
                      hazard.x >= room.x
                      && hazard.x <= room.x + room.width
                      && hazard.y >= room.y
                      && hazard.y <= room.y + room.depth
                    ));
                    const visibleRoomLabel = denseRoomLabels && hasHazard
                      ? room.label.split(/\s+/)[0]
                      : room.label;
                    const labelLayout = roomLabelLayout(visibleRoomLabel, roomWidth, roomHeight, denseRoomLabels);
                    if (!labelLayout) return null;
                    const roomLineHeight = denseRoomLabels ? 14 : 15;
                    const coverageLineHeight = denseRoomLabels ? 13 : 14;
                    const showCoverage = labelLayout.showCoverage && !(denseRoomLabels && hasHazard);
                    const labelBlockHeight = labelLayout.lines.length * roomLineHeight
                      + (showCoverage ? coverageLineHeight : 0);
                    const labelOffsetY = denseRoomLabels && hasHazard
                      ? roomHeight / 2 - 9
                      : denseRoomLabels && hasConnector
                        ? 12
                        : 0;
                    return (
                      <text key={room.id} x={center.x} y={center.y + labelOffsetY - labelBlockHeight / 2 + 11}>
                        {labelLayout.lines.map((line, index) => (
                          <tspan key={`${room.id}-${line}`} x={center.x} dy={index === 0 ? 0 : roomLineHeight}>{line}</tspan>
                        ))}
                        {showCoverage && (
                          <tspan x={center.x} dy={coverageLineHeight} className="spatial-room-coverage">{room.explored.toFixed(0)}% mapped</tspan>
                        )}
                      </text>
                    );
                  })}
                </g>
              )}

              {layers.hazards && floor.hazards.map((hazard) => (
                <HazardMark
                  key={hazard.id}
                  hazard={hazard}
                  floor={floor}
                  point={projection.project(hazard)}
                  selected={selection?.kind === "hazard" && selection.id === hazard.id}
                  onSelect={() => onHazardSelect(hazard, floor.id)}
                />
              ))}

              {renderedRobots.filter((robot) => robot.pose.floorId === floor.id).map((robot) => (
                <RobotMark
                  key={robot.id}
                  robot={robot}
                  point={projection.project(robot.pose)}
                  active={robot.id === activeRobotId}
                  selected={selection?.kind === "robot" && selection.id === robot.id}
                  onSelect={() => onRobotSelect(robot.id)}
                />
              ))}

              {jobTarget?.floorId === floor.id && (() => {
                const point = projection.project(jobTarget);
                return (
                  <g className="spatial-job-target" transform={`translate(${point.x} ${point.y})`} aria-label="Selected job destination">
                    <circle className="spatial-job-target-aura" r="18" />
                    <circle r="8" />
                    <path d="M-13 0H13M0-13V13" />
                    <text x="13" y="-12">JOB</text>
                  </g>
                );
              })()}

              <g className="spatial-floor-caption" transform={`translate(${frame.x + 18} ${frame.y + 23})`}>
                <text>{floor.label}</text>
                <text x="0" y="15" className="spatial-floor-caption-meta">L{floor.level} / {floor.coverage.toFixed(0)}% mapped</text>
              </g>
              <g className="spatial-scale" transform={`translate(${scaleX} ${scaleY})`}>
                <line x1="0" x2={scaleLength} />
                <line x1="0" x2="0" y1="-4" y2="4" />
                <line x1={scaleLength} x2={scaleLength} y1="-4" y2="4" />
                <text x={scaleLength / 2} y="-7">{scaleMetres} m</text>
              </g>
            </g>
          );
        })}

        <g className="spatial-north-arrow" transform={`translate(${viewport.width - 34} 38)`} aria-label="North is up">
          <path d="M0 -18 L7 4 L0 0 L-7 4 Z" />
          <text x="0" y="17">N</text>
        </g>
      </svg>
      <div className="spatial-map-legend" aria-label="Plan legend">
        <span><i className="legend-robot" /> Robot</span>
        <span><i className="legend-trail" /> Live trail</span>
        <span><i className="legend-hazard" /> Hazard</span>
        <span><i className="legend-door" /> Door swing</span>
      </div>
    </div>
  );
}
