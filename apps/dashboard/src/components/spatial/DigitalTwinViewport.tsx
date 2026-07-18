import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BatteryMedium,
  Box,
  Crosshair,
  Home,
  Layers,
  Map,
  MousePointer2,
  Navigation,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { clamp } from "./coordinates";
import { FloorPlan2D, type SpatialEntitySelection } from "./FloorPlan2D";
import type { Building3DHandle, CameraPreset } from "./Building3D";
import {
  DEFAULT_SPATIAL_LAYERS,
  type DigitalTwinViewportProps,
  type FleetRobot,
  type FloorSelection,
  type SpatialHazard,
  type SpatialLayers,
} from "./model";
import "./spatial.css";

const Building3D = lazy(() => import("./Building3D"));

type TwinMode = "plan" | "building";

function statusText(status: FleetRobot["status"]): string {
  return status === "nominal" ? "Nominal" : status.charAt(0).toUpperCase() + status.slice(1);
}

function initialFloor(building: DigitalTwinViewportProps["building"], robots: FleetRobot[], activeRobotId?: string): FloorSelection {
  const activeFloor = robots.find((robot) => robot.id === activeRobotId)?.pose.floorId;
  if (activeFloor && building.floors.some((floor) => floor.id === activeFloor)) return activeFloor;
  return building.floors[0]?.id ?? "all";
}

function activeFloorLabel(building: DigitalTwinViewportProps["building"], floorId: string): string {
  return building.floors.find((floor) => floor.id === floorId)?.label ?? floorId;
}

export function DigitalTwinViewport({
  building,
  robots,
  activeRobotId,
  streamStatus = "live",
  compact = false,
  onRobotSelect,
}: DigitalTwinViewportProps) {
  const threeRef = useRef<Building3DHandle>(null);
  const [mode, setMode] = useState<TwinMode>("plan");
  const [floorSelection, setFloorSelection] = useState<FloorSelection>(() => initialFloor(building, robots, activeRobotId));
  const [selection, setSelection] = useState<SpatialEntitySelection>(() => activeRobotId ? { kind: "robot", id: activeRobotId } : null);
  const [layers, setLayers] = useState<SpatialLayers>(DEFAULT_SPATIAL_LAYERS);
  const [planZoom, setPlanZoom] = useState(1);
  const [resetVersion, setResetVersion] = useState(0);
  const [followRobot, setFollowRobot] = useState(false);
  const [coarsePointer, setCoarsePointer] = useState(false);
  const [cameraInteraction, setCameraInteraction] = useState(true);
  const [graphicsNotice, setGraphicsNotice] = useState("");
  const [activeCameraPreset, setActiveCameraPreset] = useState<CameraPreset>("isometric");

  const selectedRobot = selection?.kind === "robot" ? robots.find((robot) => robot.id === selection.id) : undefined;
  const selectedHazard = useMemo(() => {
    if (selection?.kind !== "hazard") return undefined;
    const floor = building.floors.find((item) => item.id === selection.floorId);
    const hazard = floor?.hazards.find((item) => item.id === selection.id);
    return hazard && floor ? { hazard, floor } : undefined;
  }, [building.floors, selection]);

  useEffect(() => {
    const media = window.matchMedia?.("(pointer: coarse)");
    if (!media) return;
    const sync = () => {
      setCoarsePointer(media.matches);
      setCameraInteraction(!media.matches);
    };
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);

  useEffect(() => {
    if (floorSelection !== "all" && !building.floors.some((floor) => floor.id === floorSelection)) {
      setFloorSelection(initialFloor(building, robots, activeRobotId));
    }
  }, [activeRobotId, building, floorSelection, robots]);

  useEffect(() => {
    if (!selection || selection.kind !== "robot" || robots.some((robot) => robot.id === selection.id)) return;
    setSelection(activeRobotId ? { kind: "robot", id: activeRobotId } : null);
  }, [activeRobotId, robots, selection]);

  function chooseRobot(id: string) {
    setSelection({ kind: "robot", id });
    onRobotSelect?.(id);
  }

  function chooseHazard(hazard: SpatialHazard, floorId: string) {
    setSelection({ kind: "hazard", id: hazard.id, floorId });
  }

  function setLayer(layer: keyof SpatialLayers, checked: boolean) {
    setLayers((current) => ({ ...current, [layer]: checked }));
  }

  function selectMode(nextMode: TwinMode) {
    setGraphicsNotice("");
    setMode(nextMode);
    if (nextMode === "building" && coarsePointer) setCameraInteraction(false);
  }

  function cameraPreset(preset: CameraPreset) {
    if (preset === "home" && floorSelection !== "all") {
      setFloorSelection("all");
      if (mode === "plan") {
        setPlanZoom(1);
        setResetVersion((value) => value + 1);
      } else {
        setActiveCameraPreset("home");
        threeRef.current?.setCameraPreset("home");
      }
      return;
    }
    if (mode === "plan") {
      if (preset === "isometric") {
        setActiveCameraPreset("isometric");
        selectMode("building");
        return;
      }
      setPlanZoom(1);
      setResetVersion((value) => value + 1);
      return;
    }
    setActiveCameraPreset(preset);
    threeRef.current?.setCameraPreset(preset);
  }

  function resetView() {
    if (mode === "building") {
      setActiveCameraPreset("isometric");
      threeRef.current?.reset();
    }
    else {
      setPlanZoom(1);
      setResetVersion((value) => value + 1);
    }
  }

  function zoomView(direction: "in" | "out") {
    if (mode === "building") {
      threeRef.current?.zoom(direction === "in" ? 0.82 : 1.22);
      return;
    }
    setPlanZoom((value) => clamp(value * (direction === "in" ? 1.18 : 0.84), 0.65, 3));
  }

  function handleGraphicsUnavailable(reason: string) {
    setGraphicsNotice(reason);
    setMode("plan");
    setCameraInteraction(false);
  }

  const followedRobotId = followRobot ? (selectedRobot?.id ?? activeRobotId) : undefined;
  const totalHazards = building.floors.reduce((total, floor) => total + floor.hazards.length, 0);

  return (
    <section className={`digital-twin-viewport${compact ? " is-compact" : ""}`} aria-label={`${building.name} spatial viewer`}>
      <div className="spatial-toolbar" aria-label="Digital twin controls">
        <div className="spatial-control-group spatial-mode-switch" aria-label="View type">
          <button type="button" aria-pressed={mode === "plan"} onClick={() => selectMode("plan")}>
            <Map size={15} aria-hidden="true" /> 2D plan
          </button>
          <button type="button" aria-pressed={mode === "building"} onClick={() => selectMode("building")}>
            <Box size={15} aria-hidden="true" /> 3D building
          </button>
        </div>

        <label className="spatial-floor-select">
          <span>Floor</span>
          <select value={floorSelection} onChange={(event) => setFloorSelection(event.target.value)}>
            <option value="all">All floors</option>
            {[...building.floors].sort((a, b) => a.level - b.level).map((floor) => (
              <option key={floor.id} value={floor.id}>{floor.label} · {floor.coverage.toFixed(0)}%</option>
            ))}
          </select>
        </label>

        <div className="spatial-control-group spatial-camera-controls" aria-label="Camera">
          <button type="button" onClick={() => cameraPreset("top")} aria-label="Top camera"><Map size={15} aria-hidden="true" /><span>Top</span></button>
          <button type="button" onClick={() => cameraPreset("isometric")} aria-label="Isometric camera"><Box size={15} aria-hidden="true" /><span>Iso</span></button>
          <button type="button" onClick={() => cameraPreset("home")} aria-label="Frame whole building"><Home size={15} aria-hidden="true" /><span>Home</span></button>
          <button type="button" onClick={() => zoomView("in")} aria-label="Zoom in"><ZoomIn size={15} aria-hidden="true" /></button>
          <button type="button" onClick={() => zoomView("out")} aria-label="Zoom out"><ZoomOut size={15} aria-hidden="true" /></button>
          <button type="button" onClick={resetView} aria-label="Reset view"><RotateCcw size={15} aria-hidden="true" /></button>
        </div>

        <button
          type="button"
          className="spatial-follow-button"
          aria-pressed={followRobot}
          disabled={robots.length === 0}
          onClick={() => setFollowRobot((value) => !value)}
        >
          <Crosshair size={15} aria-hidden="true" /> Follow robot
        </button>

        <details className="spatial-layer-menu">
          <summary><Layers size={15} aria-hidden="true" /> Layers</summary>
          <fieldset>
            <legend>Visible map layers</legend>
            {(Object.keys(layers) as Array<keyof SpatialLayers>).map((layer) => (
              <label key={layer}>
                <input type="checkbox" checked={layers[layer]} onChange={(event) => setLayer(layer, event.target.checked)} />
                {layer.charAt(0).toUpperCase() + layer.slice(1)}
              </label>
            ))}
          </fieldset>
        </details>

        {mode === "building" && coarsePointer && (
          <button
            type="button"
            className="spatial-interaction-button"
            aria-pressed={cameraInteraction}
            onClick={() => setCameraInteraction((value) => !value)}
          >
            <MousePointer2 size={15} aria-hidden="true" /> {cameraInteraction ? "Done" : "Interact with 3D"}
          </button>
        )}
      </div>

      {graphicsNotice && <p className="spatial-graphics-notice" role="status">{graphicsNotice}</p>}

      <div className="spatial-stage">
        {mode === "plan" ? (
          <FloorPlan2D
            building={building}
            robots={robots}
            floorSelection={floorSelection}
            activeRobotId={activeRobotId}
            selection={selection}
            layers={layers}
            zoom={planZoom}
            resetVersion={resetVersion}
            compact={compact}
            onRobotSelect={chooseRobot}
            onHazardSelect={chooseHazard}
          />
        ) : (
          <Suspense fallback={<div className="spatial-loading" role="status">Loading 3D building…</div>}>
            <Building3D
              ref={threeRef}
              building={building}
              robots={robots}
              floorSelection={floorSelection}
              cameraPreset={activeCameraPreset}
              activeRobotId={activeRobotId}
              selectedRobotId={selectedRobot?.id}
              followRobotId={followedRobotId}
              layers={layers}
              interactionEnabled={cameraInteraction}
              compact={compact}
              onRobotSelect={chooseRobot}
              onUnavailable={handleGraphicsUnavailable}
            />
          </Suspense>
        )}
      </div>

      <div className="spatial-status-strip" aria-label="Spatial model status">
        <span><i className={`spatial-live-dot stream-${streamStatus}`} aria-hidden="true" /> {streamStatus === "live" ? "Live frame" : streamStatus === "connecting" ? "Reconnecting frame" : "Demo frame"} <strong>{building.frame}</strong></span>
        <span>{building.floors.length} floors</span>
        <span>{robots.length} robots</span>
        <span>{totalHazards} hazards</span>
        {floorSelection !== "all" && <span>{activeFloorLabel(building, floorSelection)}</span>}
      </div>

      {(selectedRobot || selectedHazard) && (
        <div className="spatial-selection-detail" role="status">
          {selectedRobot ? (
            <>
              <span className={`spatial-entity-icon status-${selectedRobot.status}`}><Navigation size={17} aria-hidden="true" /></span>
              <span className="spatial-selection-copy">
                <strong>{selectedRobot.name} <small>{selectedRobot.model}</small></strong>
                <span>
                  {activeFloorLabel(building, selectedRobot.pose.floorId)} · X {selectedRobot.pose.x.toFixed(2)} m · Y {selectedRobot.pose.y.toFixed(2)} m · {selectedRobot.pose.yaw.toFixed(0)}°
                </span>
              </span>
              <span className="spatial-selection-vitals"><BatteryMedium size={14} aria-hidden="true" /> {selectedRobot.battery.toFixed(0)}% · {selectedRobot.speed.toFixed(2)} m/s</span>
            </>
          ) : selectedHazard ? (
            <>
              <span className={`spatial-entity-icon severity-${selectedHazard.hazard.severity}`}><AlertTriangle size={17} aria-hidden="true" /></span>
              <span className="spatial-selection-copy">
                <strong>{selectedHazard.hazard.type} <small>{selectedHazard.hazard.id}</small></strong>
                <span>{selectedHazard.floor.label} · X {selectedHazard.hazard.x.toFixed(2)} m · Y {selectedHazard.hazard.y.toFixed(2)} m</span>
              </span>
              <span className="spatial-selection-vitals">{selectedHazard.hazard.confidence.toFixed(0)}% confidence</span>
            </>
          ) : null}
        </div>
      )}

      <details className="spatial-fleet" open={!compact}>
        <summary>Fleet positions <span>{robots.length} connected</span></summary>
        <ul>
          {robots.map((robot) => (
            <li key={robot.id}>
              <button
                type="button"
                className={selection?.kind === "robot" && selection.id === robot.id ? "is-selected" : ""}
                aria-pressed={selection?.kind === "robot" && selection.id === robot.id}
                onClick={() => chooseRobot(robot.id)}
              >
                <span className={`spatial-fleet-state status-${robot.status}`} aria-hidden="true" />
                <span><strong>{robot.name}</strong><small>{robot.role} · {activeFloorLabel(building, robot.pose.floorId)}</small></span>
                <span className="spatial-fleet-pose">{robot.pose.x.toFixed(1)}, {robot.pose.y.toFixed(1)} m</span>
                <span className="spatial-fleet-status">{statusText(robot.status)}</span>
              </button>
            </li>
          ))}
        </ul>
      </details>

      <p className="spatial-screen-reader-summary">
        {building.name} contains {building.floors.length} floors. {robots.map((robot) => `${robot.name} is ${statusText(robot.status).toLowerCase()} on ${activeFloorLabel(building, robot.pose.floorId)} at ${robot.pose.x.toFixed(1)}, ${robot.pose.y.toFixed(1)} metres.`).join(" ")}
      </p>
    </section>
  );
}

export default DigitalTwinViewport;
