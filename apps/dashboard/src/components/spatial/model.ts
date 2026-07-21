export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 extends Vec2 {
  z: number;
}

export type FloorSelection = string | "all";
export type SpatialHealth = "nominal" | "warning" | "critical" | "offline";

export interface Door {
  id: string;
  x: number;
  y: number;
  width: number;
  orientation: "horizontal" | "vertical";
}

export interface Wall {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
  height: number;
}

export interface Room {
  id: string;
  label: string;
  kind: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  explored: number;
}

export interface VerticalConnector {
  id: string;
  kind: "stairs" | "elevator";
  x: number;
  y: number;
  width: number;
  depth: number;
  targetFloorIds: string[];
}

export interface SpatialHazard extends Vec3 {
  id: string;
  type: string;
  severity: "low" | "medium" | "high";
  confidence: number;
  detectedAt: string;
}

export interface TrailPoint extends Vec3 {
  floorId: string;
}

export interface BuildingFloor {
  id: string;
  label: string;
  level: number;
  elevation: number;
  height: number;
  width: number;
  depth: number;
  coverage: number;
  rooms: Room[];
  walls: Wall[];
  doors: Door[];
  connectors: VerticalConnector[];
  hazards: SpatialHazard[];
  path: TrailPoint[];
}

export interface BuildingState {
  id: string;
  name: string;
  width: number;
  depth: number;
  floorHeight: number;
  frame: "building_enu" | string;
  floors: BuildingFloor[];
}

export interface RobotPose extends Vec3 {
  yaw: number;
  floorId: string;
}

export interface FleetRobot {
  id: string;
  name: string;
  model: string;
  role: string;
  status: SpatialHealth;
  connection: string;
  battery: number;
  speed: number;
  localization: number;
  mission: string;
  pose: RobotPose;
  trail: TrailPoint[];
}

export interface SpatialLayers {
  rooms: boolean;
  labels: boolean;
  trails: boolean;
  hazards: boolean;
  connectors: boolean;
}

export interface MapJobTarget extends Vec2 {
  floorId: string;
  roomId?: string;
  roomLabel?: string;
}

export const DEFAULT_SPATIAL_LAYERS: SpatialLayers = {
  rooms: true,
  labels: true,
  trails: true,
  hazards: true,
  connectors: true,
};

export interface DigitalTwinViewportProps {
  building: BuildingState;
  robots: FleetRobot[];
  activeRobotId?: string;
  streamStatus?: "connecting" | "live" | "demo";
  compact?: boolean;
  jobTargeting?: boolean;
  jobTarget?: MapJobTarget | null;
  onRobotSelect?: (id: string) => void;
  onJobTargetSelect?: (target: MapJobTarget) => void;
}
