import type {
  BuildingFloor,
  BuildingState,
  Door,
  FleetRobot,
  Room,
  SpatialHazard,
  TrailPoint,
  Wall,
} from "../components/spatial/model";
import { planFloorRoute } from "../components/spatial/coordinates";

const WIDTH = 24;
const DEPTH = 16;
const FLOOR_HEIGHT = 3.4;

const outerWalls: Wall[] = [
  { id: "north-shell", x1: 0, y1: 0, x2: WIDTH, y2: 0, thickness: 0.18, height: 3.1 },
  { id: "east-shell", x1: WIDTH, y1: 0, x2: WIDTH, y2: DEPTH, thickness: 0.18, height: 3.1 },
  { id: "south-shell", x1: WIDTH, y1: DEPTH, x2: 0, y2: DEPTH, thickness: 0.18, height: 3.1 },
  { id: "west-shell", x1: 0, y1: DEPTH, x2: 0, y2: 0, thickness: 0.18, height: 3.1 },
];

const connectors = (floorId: string) => [
  { id: `${floorId}-stair`, kind: "stairs" as const, x: 10.3, y: 12.4, width: 2.3, depth: 3, targetFloorIds: ["ground", "level-1", "level-2"] },
  { id: `${floorId}-lift`, kind: "elevator" as const, x: 13.3, y: 12.7, width: 1.8, depth: 2.1, targetFloorIds: ["ground", "level-1", "level-2"] },
];

function room(id: string, label: string, kind: string, x: number, y: number, width: number, depth: number, explored: number): Room {
  return { id, label, kind, x, y, width, depth, explored };
}

function wall(id: string, x1: number, y1: number, x2: number, y2: number): Wall {
  return { id, x1, y1, x2, y2, thickness: 0.12, height: 3.1 };
}

function door(id: string, x: number, y: number, width: number, orientation: Door["orientation"]): Door {
  return { id, x, y, width, orientation };
}

const groundHazards: SpatialHazard[] = [
  { id: "HZ-19", type: "Thermal anomaly", severity: "high", x: 18.6, y: 3.8, z: 0, confidence: 94, detectedAt: "4 min ago" },
];

const levelOneHazards: SpatialHazard[] = [
  { id: "HZ-22", type: "Smoke plume", severity: "high", x: 19.4, y: 9.2, z: FLOOR_HEIGHT, confidence: 91, detectedAt: "38 sec ago" },
];

const levelTwoHazards: SpatialHazard[] = [
  { id: "HZ-24", type: "Blocked passage", severity: "medium", x: 14.8, y: 7.8, z: FLOOR_HEIGHT * 2, confidence: 87, detectedAt: "12 sec ago" },
];

const floors: BuildingFloor[] = [
  {
    id: "ground",
    label: "Ground Floor",
    level: 0,
    elevation: 0,
    height: 3.1,
    width: WIDTH,
    depth: DEPTH,
    coverage: 100,
    rooms: [
      room("g-lobby", "Reception Lobby", "lobby", 0.3, 0.3, 7.5, 5.7, 100),
      room("g-security", "Security Control", "control", 8.2, 0.3, 7.6, 5.7, 100),
      room("g-plant", "Electrical Plant", "utility", 16.2, 0.3, 7.5, 5.7, 96),
      room("g-office", "West Office", "office", 0.3, 6.6, 7.5, 9.1, 100),
      room("g-atrium", "Central Atrium", "circulation", 8.2, 6.6, 7.6, 9.1, 92),
      room("g-corridor", "East Corridor", "corridor", 16.2, 6.6, 7.5, 3.4, 88),
      room("g-storage", "Response Storage", "storage", 16.2, 10.4, 7.5, 5.3, 74),
    ],
    walls: [...outerWalls, wall("g-west", 8, 0, 8, 16), wall("g-east", 16, 0, 16, 16), wall("g-cross", 0, 6.3, 24, 6.3), wall("g-store", 16, 10.2, 24, 10.2)],
    doors: [door("g-entry", 3.4, 0, 1.8, "horizontal"), door("g-security-door", 8, 3.4, 1.1, "vertical"), door("g-plant-door", 16, 3.5, 1.1, "vertical"), door("g-office-door", 5.4, 6.3, 1.1, "horizontal"), door("g-atrium-north-door", 12, 6.3, 1.2, "horizontal"), door("g-corridor-north-door", 20, 6.3, 1.2, "horizontal"), door("g-atrium-west-door", 8, 10, 1.2, "vertical"), door("g-corridor-west-door", 16, 8.2, 1.2, "vertical"), door("g-store-door", 19.8, 10.2, 1.2, "horizontal")],
    connectors: connectors("ground"),
    hazards: groundHazards,
    path: [],
  },
  {
    id: "level-1",
    label: "Level 1",
    level: 1,
    elevation: FLOOR_HEIGHT,
    height: 3.1,
    width: WIDTH,
    depth: DEPTH,
    coverage: 78,
    rooms: [
      room("l1-meeting", "Briefing Room", "meeting", 0.3, 0.3, 7.5, 5.7, 94),
      room("l1-open", "Open Workspace", "office", 8.2, 0.3, 15.5, 5.7, 89),
      room("l1-office", "West Offices", "office", 0.3, 6.6, 7.5, 9.1, 82),
      room("l1-core", "Lift and Stair Core", "circulation", 8.2, 6.6, 7.6, 9.1, 100),
      room("l1-lab", "Sensor Laboratory", "laboratory", 16.2, 6.6, 7.5, 5.4, 68),
      room("l1-store", "Equipment Store", "storage", 16.2, 12.4, 7.5, 3.3, 51),
    ],
    walls: [...outerWalls, wall("l1-west", 8, 0, 8, 16), wall("l1-east", 16, 6.3, 16, 16), wall("l1-cross", 0, 6.3, 24, 6.3), wall("l1-store", 16, 12.2, 24, 12.2)],
    doors: [door("l1-meeting-door", 5.4, 6.3, 1.1, "horizontal"), door("l1-core-door", 12, 6.3, 1.2, "horizontal"), door("l1-office-door", 8, 10, 1.1, "vertical"), door("l1-lab-door", 16, 9.2, 1.1, "vertical"), door("l1-store-door", 19.8, 12.2, 1.1, "horizontal")],
    connectors: connectors("level-1"),
    hazards: levelOneHazards,
    path: [],
  },
  {
    id: "level-2",
    label: "Level 2",
    level: 2,
    elevation: FLOOR_HEIGHT * 2,
    height: 3.1,
    width: WIDTH,
    depth: DEPTH,
    coverage: 42,
    rooms: [
      room("l2-command", "Incident Command", "control", 0.3, 0.3, 9.5, 5.7, 71),
      room("l2-comms", "Communications", "technical", 10.2, 0.3, 6.6, 5.7, 62),
      room("l2-mechanical", "Mechanical", "utility", 17.2, 0.3, 6.5, 5.7, 45),
      room("l2-analysis", "Hazard Analysis", "laboratory", 0.3, 6.6, 9.5, 9.1, 53),
      room("l2-core", "Vertical Core", "circulation", 10.2, 6.6, 6.6, 9.1, 100),
      room("l2-training", "Training Suite", "training", 17.2, 6.6, 6.5, 9.1, 28),
    ],
    walls: [...outerWalls, wall("l2-west", 10, 0, 10, 16), wall("l2-east", 17, 0, 17, 16), wall("l2-cross", 0, 6.3, 24, 6.3)],
    doors: [door("l2-command-door", 5.8, 6.3, 1.2, "horizontal"), door("l2-comms-door", 10, 3.2, 1, "vertical"), door("l2-mechanical-door", 17, 3.2, 1, "vertical"), door("l2-core-door", 13.5, 6.3, 1.2, "horizontal"), door("l2-analysis-door", 10, 11, 1.1, "vertical"), door("l2-training-door", 17, 11, 1.1, "vertical")],
    connectors: connectors("level-2"),
    hazards: levelTwoHazards,
    path: [],
  },
];

export const demoBuilding: BuildingState = {
  id: "northstar-response-centre",
  name: "Northstar Response Centre",
  width: WIDTH,
  depth: DEPTH,
  floorHeight: FLOOR_HEIGHT,
  frame: "building_enu",
  floors,
};

const trail = (floorId: string, z: number, checkpoints: Array<[number, number]>): TrailPoint[] => {
  const floor = floors.find((candidate) => candidate.id === floorId);
  if (!floor) throw new Error(`Unknown demo floor ${floorId}`);
  const route = checkpoints.slice(1).reduce<Array<{ x: number; y: number }>>((planned, [x, y]) => {
    const start = planned.at(-1);
    if (!start) return [{ x, y }];
    return [...planned, ...planFloorRoute(floor, start, { x, y }).slice(1)];
  }, checkpoints.length > 0 ? [{ x: checkpoints[0][0], y: checkpoints[0][1] }] : []);
  return route.map(({ x, y }) => ({ x, y, z, floorId }));
};

floors[0].path = trail("ground", 0, [[1.4, 0.8], [4.8, 2.2], [7.4, 5.4], [11, 8.4]]);
floors[1].path = trail("level-1", FLOOR_HEIGHT, [[11.1, 13.2], [8.3, 10.5], [4.8, 12.2], [14, 8]]);
floors[2].path = trail("level-2", FLOOR_HEIGHT * 2, [[14.2, 13.2], [18, 11.2], [21, 7.8]]);

export const demoRobots: FleetRobot[] = [
  {
    id: "RBT-07",
    name: "Scout 07",
    model: "NEXUS M2",
    role: "Lead scout",
    status: "nominal",
    connection: "digital_twin_connected",
    battery: 78,
    speed: 0.34,
    localization: 97.4,
    mission: "Resolve east corridor frontier",
    pose: { x: 12.4, y: 7.8, z: 0, yaw: 132, floorId: "ground" },
    trail: trail("ground", 0, [[1.4, 0.8], [4.8, 2.2], [7.4, 5.4], [11, 8.4], [12.4, 7.8]]),
  },
  {
    id: "RBT-12",
    name: "Surveyor 12",
    model: "NEXUS H1",
    role: "Hazard survey",
    status: "warning",
    connection: "digital_twin_connected",
    battery: 71,
    speed: 0.22,
    localization: 95.8,
    mission: "Verify smoke plume",
    pose: { x: 19.4, y: 9.8, z: FLOOR_HEIGHT, yaw: 284, floorId: "level-1" },
    trail: trail("level-1", FLOOR_HEIGHT, [[14.1, 13.1], [18.2, 9.8], [19.4, 9.8]]),
  },
  {
    id: "RBT-18",
    name: "Relay 18",
    model: "NEXUS Relay",
    role: "Mapping relay",
    status: "nominal",
    connection: "digital_twin_connected",
    battery: 84,
    speed: 0.18,
    localization: 96.1,
    mission: "Maintain upper-floor mesh",
    pose: { x: 14, y: 13.2, z: FLOOR_HEIGHT * 2, yaw: 90, floorId: "level-2" },
    trail: trail("level-2", FLOOR_HEIGHT * 2, [[14.2, 13.4], [18.2, 10.2], [14, 13.2]]),
  },
];
