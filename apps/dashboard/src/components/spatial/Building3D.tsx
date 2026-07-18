import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  aspectRatioChanged,
  perspectiveFitDistance,
  selectedFloors,
  shouldInterpolateRobotPose,
  shortestYawDelta,
} from "./coordinates";
import type {
  BuildingFloor,
  BuildingState,
  FleetRobot,
  FloorSelection,
  SpatialLayers,
  RobotPose,
  Vec2,
  VerticalConnector,
} from "./model";
import { wallRenderFragments, type RenderableWallFragment } from "./wallGeometry";

export type CameraPreset = "home" | "top" | "isometric";

export interface Building3DHandle {
  setCameraPreset: (preset: CameraPreset) => void;
  reset: () => void;
  zoom: (factor: number) => void;
}

export interface Building3DProps {
  building: BuildingState;
  robots: FleetRobot[];
  floorSelection: FloorSelection;
  cameraPreset: CameraPreset;
  activeRobotId?: string;
  selectedRobotId?: string;
  followRobotId?: string;
  layers: SpatialLayers;
  interactionEnabled: boolean;
  compact?: boolean;
  onRobotSelect: (id: string) => void;
  onUnavailable: (reason: string) => void;
}

interface ThemeColors {
  background: THREE.ColorRepresentation;
  floor: THREE.ColorRepresentation;
  room: THREE.ColorRepresentation;
  roomUnexplored: THREE.ColorRepresentation;
  wall: THREE.ColorRepresentation;
  door: THREE.ColorRepresentation;
  connector: THREE.ColorRepresentation;
  active: THREE.ColorRepresentation;
  robot: THREE.ColorRepresentation;
  warning: THREE.ColorRepresentation;
  critical: THREE.ColorRepresentation;
  muted: THREE.ColorRepresentation;
  grid: THREE.ColorRepresentation;
}

interface RobotVisual {
  group: THREE.Group;
  trail: THREE.Line;
  accentMaterials: THREE.MeshStandardMaterial[];
  trailMaterial: THREE.LineBasicMaterial;
  targetPosition: THREE.Vector3;
  targetYaw: number;
  currentYaw: number;
  selectionRing: THREE.Mesh;
  floorId: string;
}

interface SceneRuntime {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  syncRobots: (robots: FleetRobot[]) => void;
  setInteraction: (enabled: boolean) => void;
  setCameraPreset: (preset: CameraPreset) => void;
  reset: () => void;
  zoom: (factor: number) => void;
  dispose: () => void;
}

function cssColor(element: HTMLElement, variable: string, fallback: string): string {
  const value = getComputedStyle(element).getPropertyValue(variable).trim();
  return value || fallback;
}

function readTheme(element: HTMLElement): ThemeColors {
  return {
    background: cssColor(element, "--bg", "#050c12"),
    floor: cssColor(element, "--panel-soft", "#0d1c26"),
    room: cssColor(element, "--border-strong", "#27505d"),
    roomUnexplored: cssColor(element, "--panel", "#0a1720"),
    wall: cssColor(element, "--muted", "#79909b"),
    door: cssColor(element, "--cyan-bright", "#6cf5e4"),
    connector: cssColor(element, "--blue", "#63a8ff"),
    active: cssColor(element, "--cyan", "#37e2cd"),
    robot: cssColor(element, "--blue", "#63a8ff"),
    warning: cssColor(element, "--amber", "#f6bd60"),
    critical: cssColor(element, "--red", "#ff6577"),
    muted: cssColor(element, "--muted-dim", "#526b76"),
    grid: cssColor(element, "--border", "#19313d"),
  };
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    const renderable = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    renderable.geometry?.dispose();
    if (Array.isArray(renderable.material)) renderable.material.forEach((material) => material.dispose());
    else renderable.material?.dispose();
  });
}

function floorElevation(building: BuildingState, floorId: string): number {
  return building.floors.find((floor) => floor.id === floorId)?.elevation ?? 0;
}

function robotHeight(building: BuildingState, robot: FleetRobot): number {
  const elevation = floorElevation(building, robot.pose.floorId);
  return Math.max(elevation, robot.pose.z) + 0.18;
}

function pointHeight(building: BuildingState, floorId: string, z: number): number {
  return Math.max(floorElevation(building, floorId), z) + 0.07;
}

function robotColor(robot: FleetRobot, active: boolean, theme: ThemeColors): THREE.ColorRepresentation {
  if (robot.status === "critical") return theme.critical;
  if (robot.status === "warning") return theme.warning;
  return active ? theme.active : theme.robot;
}

function addWall(group: THREE.Group, floor: BuildingFloor, wall: RenderableWallFragment, theme: ThemeColors) {
  const dx = wall.x2 - wall.x1;
  const dz = wall.y2 - wall.y1;
  const length = Math.max(0.01, Math.hypot(dx, dz));
  const cutawayHeight = Math.min(wall.height, 1.45);
  const geometry = new THREE.BoxGeometry(length, cutawayHeight, Math.max(0.04, wall.thickness));
  const material = new THREE.MeshStandardMaterial({
    color: theme.wall,
    roughness: 0.78,
    metalness: 0.05,
    transparent: true,
    opacity: 0.88,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `wall:${wall.id}`;
  mesh.userData.wallId = wall.sourceWallId;
  mesh.position.set((wall.x1 + wall.x2) / 2, floor.elevation + cutawayHeight / 2, (wall.y1 + wall.y2) / 2);
  mesh.rotation.y = -Math.atan2(dz, dx);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  group.add(mesh);
}

function addDoor(group: THREE.Group, floor: BuildingFloor, door: BuildingFloor["doors"][number], theme: ThemeColors) {
  const height = Math.min(1.15, floor.height * 0.45);
  const leaf = new THREE.Mesh(
    new THREE.BoxGeometry(door.width, height, 0.035),
    new THREE.MeshStandardMaterial({ color: theme.door, roughness: 0.55, transparent: true, opacity: 0.82 }),
  );
  const pivot = new THREE.Group();
  const horizontal = door.orientation === "horizontal";
  const hingeX = horizontal ? door.x - door.width / 2 : door.x;
  const hingeZ = horizontal ? door.y : door.y - door.width / 2;
  pivot.position.set(hingeX, floor.elevation + height / 2, hingeZ);
  pivot.rotation.y = (horizontal ? 0 : -Math.PI / 2) - Math.PI / 5;
  leaf.position.x = door.width / 2;
  pivot.add(leaf);
  group.add(pivot);
}

function addConnector(group: THREE.Group, floor: BuildingFloor, connector: VerticalConnector, theme: ThemeColors) {
  const material = new THREE.MeshStandardMaterial({
    color: theme.connector,
    roughness: 0.62,
    transparent: true,
    opacity: 0.72,
  });
  if (connector.kind === "stairs") {
    const steps = 7;
    for (let index = 0; index < steps; index += 1) {
      const stepDepth = connector.depth / steps;
      const stepHeight = 0.07 + index * 0.055;
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(connector.width, stepHeight, stepDepth * 0.9),
        material.clone(),
      );
      step.position.set(
        connector.x + connector.width / 2,
        floor.elevation + stepHeight / 2 + 0.03,
        connector.y + stepDepth * (index + 0.5),
      );
      group.add(step);
    }
    return;
  }

  const shaftGeometry = new THREE.BoxGeometry(connector.width, Math.min(1.25, floor.height), connector.depth);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(shaftGeometry),
    new THREE.LineBasicMaterial({ color: theme.connector, transparent: true, opacity: 0.8 }),
  );
  edges.position.set(
    connector.x + connector.width / 2,
    floor.elevation + Math.min(1.25, floor.height) / 2,
    connector.y + connector.depth / 2,
  );
  group.add(edges);
}

function addHazard(group: THREE.Group, floor: BuildingFloor, hazard: BuildingFloor["hazards"][number], theme: ThemeColors) {
  const color = hazard.severity === "high" ? theme.critical : hazard.severity === "medium" ? theme.warning : theme.connector;
  const marker = new THREE.Group();
  marker.position.set(hazard.x, Math.max(floor.elevation, hazard.z) + 0.03, hazard.y);
  marker.userData.hazardId = hazard.id;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.19, 0.29, 24),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.72 }),
  );
  ring.rotation.x = -Math.PI / 2;
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.13, 0.34, 4),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.22 }),
  );
  cone.position.y = 0.2;
  marker.add(ring, cone);
  group.add(marker);
}

function buildFloorScene(
  floor: BuildingFloor,
  layers: SpatialLayers,
  theme: ThemeColors,
): THREE.Group {
  const group = new THREE.Group();
  group.name = `floor:${floor.id}`;

  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(floor.width, 0.12, floor.depth),
    new THREE.MeshStandardMaterial({ color: theme.floor, roughness: 0.91, metalness: 0.02 }),
  );
  slab.position.set(floor.width / 2, floor.elevation - 0.06, floor.depth / 2);
  slab.receiveShadow = true;
  group.add(slab);

  if (layers.rooms) {
    for (const room of floor.rooms) {
      const material = new THREE.MeshStandardMaterial({
        color: room.explored < 50 ? theme.roomUnexplored : theme.room,
        roughness: 0.9,
        transparent: true,
        opacity: 0.18 + Math.min(1, room.explored / 100) * 0.18,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(room.width, 0.035, room.depth), material);
      mesh.position.set(room.x + room.width / 2, floor.elevation + 0.018, room.y + room.depth / 2);
      group.add(mesh);
    }
  }

  for (const wall of wallRenderFragments(floor)) addWall(group, floor, wall, theme);
  for (const door of floor.doors) addDoor(group, floor, door, theme);
  if (layers.connectors) for (const connector of floor.connectors) addConnector(group, floor, connector, theme);
  if (layers.hazards) for (const hazard of floor.hazards) addHazard(group, floor, hazard, theme);

  return group;
}

function createRobotVisual(robot: FleetRobot, active: boolean, theme: ThemeColors): RobotVisual {
  const group = new THREE.Group();
  group.name = `robot:${robot.id}`;
  group.userData.robotId = robot.id;
  const color = robotColor(robot, active, theme);
  const bodyMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.28 });
  const accentMaterials = [bodyMaterial];
  const darkMaterial = new THREE.MeshStandardMaterial({ color: theme.background, roughness: 0.7, metalness: 0.18 });

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.2, 0.46), bodyMaterial);
  chassis.position.y = 0.15;
  group.add(chassis);

  for (const x of [-0.22, 0.22]) {
    for (const z of [-0.27, 0.27]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.08, 16), darkMaterial.clone());
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, 0.08, z);
      group.add(wheel);
    }
  }

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.26, 12), darkMaterial.clone());
  mast.position.y = 0.37;
  const lidarMaterial = bodyMaterial.clone();
  const headingMaterial = bodyMaterial.clone();
  accentMaterials.push(lidarMaterial, headingMaterial);
  const lidar = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.065, 24), lidarMaterial);
  lidar.position.y = 0.52;
  const heading = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.2, 3), headingMaterial);
  heading.position.set(0.41, 0.25, 0);
  heading.rotation.z = -Math.PI / 2;
  group.add(mast, lidar, heading);

  const selectionRing = new THREE.Mesh(
    new THREE.RingGeometry(0.43, 0.49, 32),
    new THREE.MeshBasicMaterial({ color: theme.active, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }),
  );
  selectionRing.rotation.x = -Math.PI / 2;
  selectionRing.position.y = 0.015;
  selectionRing.visible = false;
  group.add(selectionRing);

  group.traverse((object) => {
    object.userData.robotId = robot.id;
  });

  const trailMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: active ? 0.9 : 0.55 });
  const trail = new THREE.Line(new THREE.BufferGeometry(), trailMaterial);
  trail.name = `trail:${robot.id}`;

  return {
    group,
    trail,
    accentMaterials,
    trailMaterial,
    targetPosition: new THREE.Vector3(),
    targetYaw: 0,
    currentYaw: 0,
    selectionRing,
    floorId: robot.pose.floorId,
  };
}

function makeRuntime(
  host: HTMLDivElement,
  canvas: HTMLCanvasElement,
  building: BuildingState,
  floorSelection: FloorSelection,
  initialCameraPreset: CameraPreset,
  layers: SpatialLayers,
  activeRobotId: string | undefined,
  selectedRobotIdRef: React.MutableRefObject<string | undefined>,
  followRobotIdRef: React.MutableRefObject<string | undefined>,
  robotsRef: React.MutableRefObject<FleetRobot[]>,
  onRobotSelectRef: React.MutableRefObject<(id: string) => void>,
  onUnavailableRef: React.MutableRefObject<(reason: string) => void>,
): SceneRuntime {
  const theme = readTheme(host);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(theme.background);
  scene.fog = new THREE.Fog(theme.background, Math.max(building.width, building.depth) * 1.8, Math.max(building.width, building.depth) * 4.8);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, Math.max(300, building.width * 12));
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.setClearColor(theme.background, 1);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.screenSpacePanning = true;
  controls.minPolarAngle = 0.08;
  controls.maxPolarAngle = Math.PI / 2.03;
  controls.minDistance = 2;
  controls.maxDistance = Math.max(building.width, building.depth) * 4.5;

  scene.add(new THREE.HemisphereLight(theme.muted, theme.background, 1.5));
  const keyLight = new THREE.DirectionalLight("#e6fffb", 2.15);
  keyLight.position.set(building.width * 0.7, building.floorHeight * 5, building.depth * 0.25);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(theme.active, 0.75);
  rimLight.position.set(-building.width * 0.4, building.floorHeight * 2, building.depth * 1.15);
  scene.add(rimLight);

  const floorList = selectedFloors(building, floorSelection);
  const floorIds = new Set(floorList.map((floor) => floor.id));
  for (const floor of floorList) scene.add(buildFloorScene(floor, layers, theme));

  const gridSize = Math.max(building.width, building.depth) * 1.25;
  const grid = new THREE.GridHelper(gridSize, Math.max(12, Math.round(gridSize)), theme.grid, theme.grid);
  grid.position.set(building.width / 2, Math.min(...floorList.map((floor) => floor.elevation)) - 0.13, building.depth / 2);
  const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
  gridMaterials.forEach((material) => {
    material.transparent = true;
    material.opacity = 0.24;
  });
  scene.add(grid);

  const robotVisuals = new Map<string, RobotVisual>();
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  function isRobotVisible(robot: FleetRobot): boolean {
    return floorSelection === "all" || floorIds.has(robot.pose.floorId);
  }

  function updateTrail(visual: RobotVisual, robot: FleetRobot) {
    const points = robot.trail
      .filter((point) => floorSelection === "all" || floorIds.has(point.floorId))
      .slice(-500)
      .map((point) => new THREE.Vector3(point.x, pointHeight(building, point.floorId, point.z), point.y));
    visual.trail.geometry.setFromPoints(points);
    visual.trail.visible = layers.trails && points.length > 1;
  }

  function syncRobots(robots: FleetRobot[]) {
    const incomingIds = new Set(robots.map((robot) => robot.id));
    for (const [id, visual] of robotVisuals) {
      if (incomingIds.has(id)) continue;
      scene.remove(visual.group, visual.trail);
      disposeObject(visual.group);
      disposeObject(visual.trail);
      robotVisuals.delete(id);
    }

    for (const robot of robots) {
      let visual = robotVisuals.get(robot.id);
      const isNew = !visual;
      if (!visual) {
        visual = createRobotVisual(robot, robot.id === activeRobotId, theme);
        robotVisuals.set(robot.id, visual);
        scene.add(visual.group, visual.trail);
      }
      visual.group.visible = isRobotVisible(robot);
      const liveColor = robotColor(robot, robot.id === activeRobotId, theme);
      visual.accentMaterials.forEach((material) => material.color.set(liveColor));
      visual.trailMaterial.color.set(liveColor);
      visual.trailMaterial.opacity = robot.id === activeRobotId ? 0.9 : 0.55;
      visual.targetPosition.set(robot.pose.x, robotHeight(building, robot), robot.pose.y);
      visual.targetYaw = -THREE.MathUtils.degToRad(robot.pose.yaw);
      visual.selectionRing.visible = robot.id === selectedRobotIdRef.current;
      const floor = building.floors.find((candidate) => candidate.id === robot.pose.floorId);
      const displayedPose: RobotPose = {
        x: visual.group.position.x,
        y: visual.group.position.z,
        z: Math.max(0, visual.group.position.y - 0.18),
        yaw: -THREE.MathUtils.radToDeg(visual.currentYaw),
        floorId: visual.floorId,
      };
      const mayInterpolate = !isNew
        && floor !== undefined
        && shouldInterpolateRobotPose(floor, displayedPose, robot.pose, reducedMotion);
      if (!mayInterpolate) {
        visual.group.position.copy(visual.targetPosition);
        visual.currentYaw = visual.targetYaw;
        visual.group.rotation.y = visual.currentYaw;
      }
      visual.floorId = robot.pose.floorId;
      updateTrail(visual, robot);
    }
  }

  let currentPreset: CameraPreset = "isometric";
  let hasFramedCamera = false;

  function cameraFrame(preset: CameraPreset) {
    const framedFloors = floorList;
    const margin = 0.35;
    const minElevation = Math.min(...framedFloors.map((floor) => floor.elevation)) - 0.14;
    const maxElevation = Math.max(...framedFloors.map((floor) => floor.elevation + Math.min(floor.height, 1.55))) + 0.18;
    const maxWidth = Math.max(...framedFloors.map((floor) => floor.width));
    const maxDepth = Math.max(...framedFloors.map((floor) => floor.depth));
    const minimum = new THREE.Vector3(-margin, minElevation, -margin);
    const maximum = new THREE.Vector3(maxWidth + margin, maxElevation, maxDepth + margin);
    const center = minimum.clone().add(maximum).multiplyScalar(0.5);
    const span = Math.max(maximum.x - minimum.x, maximum.y - minimum.y, maximum.z - minimum.z, 6);
    const direction = preset === "top"
      ? new THREE.Vector3(0, 1, 0)
      : preset === "home"
        ? new THREE.Vector3(0.92, 0.74, 1.06)
        : new THREE.Vector3(0.84, 0.82, 0.96);
    direction.normalize();

    camera.up.set(0, preset === "top" ? 0 : 1, preset === "top" ? -1 : 0);
    camera.position.copy(center).add(direction);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);

    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const corners = [minimum.x, maximum.x].flatMap((x) =>
      [minimum.y, maximum.y].flatMap((y) =>
        [minimum.z, maximum.z].map((z) => new THREE.Vector3(x, y, z)),
      ),
    );
    const projectedCorners = corners.map((corner) => {
      const relative = corner.sub(center);
      return {
        horizontal: relative.dot(right),
        vertical: relative.dot(up),
        depth: relative.dot(direction),
      };
    });
    const distance = perspectiveFitDistance(
      projectedCorners,
      camera.fov,
      camera.aspect,
      preset === "top" ? 1.07 : 1.045,
    );

    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.lookAt(center);
    camera.near = Math.max(0.03, distance - span * 1.1);
    camera.far = Math.max(span * 12, distance + span * 3);
    camera.updateProjectionMatrix();
    controls.update();
    currentPreset = preset;
    hasFramedCamera = true;
  }

  syncRobots(robotsRef.current);

  let interactionEnabled = true;
  function setInteraction(enabled: boolean) {
    interactionEnabled = enabled;
    controls.enabled = enabled;
    canvas.style.touchAction = enabled ? "none" : "pan-y";
  }

  function zoom(factor: number) {
    const offset = camera.position.clone().sub(controls.target);
    const nextDistance = THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).add(offset.setLength(nextDistance));
    controls.update();
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerOrigin: Vec2 | null = null;
  function onPointerDown(event: PointerEvent) {
    pointerOrigin = { x: event.clientX, y: event.clientY };
  }
  function onPointerUp(event: PointerEvent) {
    if (!pointerOrigin || Math.hypot(event.clientX - pointerOrigin.x, event.clientY - pointerOrigin.y) > 5) {
      pointerOrigin = null;
      return;
    }
    pointerOrigin = null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([...robotVisuals.values()].map((visual) => visual.group), true);
    const robotId = hits.find((hit) => typeof hit.object.userData.robotId === "string")?.object.userData.robotId as string | undefined;
    if (robotId) onRobotSelectRef.current(robotId);
  }
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);

  function resize() {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const nextAspect = width / height;
    const shouldReframe = hasFramedCamera && aspectRatioChanged(camera.aspect, nextAspect);
    renderer.setSize(width, height, false);
    camera.aspect = nextAspect;
    camera.updateProjectionMatrix();
    if (shouldReframe) cameraFrame(currentPreset);
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();
  cameraFrame(initialCameraPreset);

  let inViewport = true;
  let animationFrame: number | undefined;
  let previousTime = performance.now();
  const intersectionObserver = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver((entries) => {
    inViewport = entries[0]?.isIntersecting ?? true;
    if (inViewport) scheduleFrame();
  }, { rootMargin: "120px" });
  intersectionObserver?.observe(host);

  function scheduleFrame() {
    if (animationFrame === undefined && inViewport && document.visibilityState !== "hidden") {
      animationFrame = requestAnimationFrame(renderFrame);
    }
  }

  function renderFrame(time: number) {
    animationFrame = undefined;
    const deltaSeconds = Math.min(0.1, Math.max(0, (time - previousTime) / 1000));
    previousTime = time;
    const positionAlpha = reducedMotion ? 1 : 1 - Math.exp(-11 * deltaSeconds);
    const rotationAlpha = reducedMotion ? 1 : 1 - Math.exp(-13 * deltaSeconds);

    for (const visual of robotVisuals.values()) {
      visual.group.position.lerp(visual.targetPosition, positionAlpha);
      const currentDegrees = THREE.MathUtils.radToDeg(visual.currentYaw);
      const targetDegrees = THREE.MathUtils.radToDeg(visual.targetYaw);
      visual.currentYaw += THREE.MathUtils.degToRad(shortestYawDelta(currentDegrees, targetDegrees)) * rotationAlpha;
      visual.group.rotation.y = visual.currentYaw;
    }

    const followed = followRobotIdRef.current ? robotVisuals.get(followRobotIdRef.current) : undefined;
    if (followed?.group.visible) {
      const target = followed.group.position.clone();
      const cameraDelta = target.sub(controls.target).multiplyScalar(reducedMotion ? 1 : Math.min(1, deltaSeconds * 5));
      controls.target.add(cameraDelta);
      camera.position.add(cameraDelta);
    }
    if (interactionEnabled) controls.update();
    renderer.render(scene, camera);
    scheduleFrame();
  }

  function onVisibilityChange() {
    if (document.visibilityState !== "hidden") {
      previousTime = performance.now();
      scheduleFrame();
    }
  }
  document.addEventListener("visibilitychange", onVisibilityChange);
  scheduleFrame();

  function onContextLost(event: Event) {
    event.preventDefault();
    onUnavailableRef.current("3D graphics context was lost. The live top-down plan is still available.");
  }
  canvas.addEventListener("webglcontextlost", onContextLost);

  return {
    camera,
    controls,
    syncRobots,
    setInteraction,
    setCameraPreset: cameraFrame,
    reset: () => cameraFrame("isometric"),
    zoom,
    dispose: () => {
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      intersectionObserver?.disconnect();
      resizeObserver.disconnect();
      controls.dispose();
      disposeObject(scene);
      renderer.renderLists.dispose();
      renderer.dispose();
    },
  };
}

const Building3D = forwardRef<Building3DHandle, Building3DProps>(function Building3D({
  building,
  robots,
  floorSelection,
  cameraPreset,
  activeRobotId,
  selectedRobotId,
  followRobotId,
  layers,
  interactionEnabled,
  compact = false,
  onRobotSelect,
  onUnavailable,
}, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const robotsRef = useRef(robots);
  const selectedRobotIdRef = useRef(selectedRobotId);
  const followRobotIdRef = useRef(followRobotId);
  const onRobotSelectRef = useRef(onRobotSelect);
  const onUnavailableRef = useRef(onUnavailable);

  robotsRef.current = robots;
  selectedRobotIdRef.current = selectedRobotId;
  followRobotIdRef.current = followRobotId;
  onRobotSelectRef.current = onRobotSelect;
  onUnavailableRef.current = onUnavailable;

  useImperativeHandle(ref, () => ({
    setCameraPreset: (preset) => runtimeRef.current?.setCameraPreset(preset),
    reset: () => runtimeRef.current?.reset(),
    zoom: (factor) => runtimeRef.current?.zoom(factor),
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    try {
      runtimeRef.current = makeRuntime(
        host,
        canvas,
        building,
        floorSelection,
        cameraPreset,
        layers,
        activeRobotId,
        selectedRobotIdRef,
        followRobotIdRef,
        robotsRef,
        onRobotSelectRef,
        onUnavailableRef,
      );
      runtimeRef.current.setInteraction(interactionEnabled);
    } catch (error) {
      const message = error instanceof Error ? error.message : "WebGL could not be initialized";
      onUnavailableRef.current(`3D view unavailable: ${message}`);
    }
    return () => {
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    };
  }, [activeRobotId, building, floorSelection, layers]);

  useEffect(() => {
    runtimeRef.current?.syncRobots(robots);
  }, [robots, selectedRobotId]);

  useEffect(() => {
    runtimeRef.current?.setCameraPreset(cameraPreset);
  }, [cameraPreset]);

  useEffect(() => {
    runtimeRef.current?.setInteraction(interactionEnabled);
  }, [interactionEnabled]);

  return (
    <div ref={hostRef} className={`spatial-three${compact ? " is-compact" : ""}`}>
      <canvas
        ref={canvasRef}
        aria-label={`${building.name} interactive 3D building model. Use the camera controls above or select a robot from the accessible fleet list below.`}
      >
        Your browser cannot display the 3D building view. Use the top-down plan instead.
      </canvas>
      {!interactionEnabled && (
        <div className="spatial-three-passive" aria-hidden="true">Camera gestures paused · page scrolling enabled</div>
      )}
    </div>
  );
});

export default Building3D;
