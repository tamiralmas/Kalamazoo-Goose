import * as THREE from 'three';
import type {
  CustomLayerInterface,
  Map as MapLibreMap,
  MapSourceDataEvent,
} from 'maplibre-gl';

import {
  MAX_CAMPUS_NPCS,
  createCampusNpc,
  createCrowdFleet,
  knockDownCampusNpc,
  panicCampusNpc,
  simulateCampusNpc,
  updateCrowdVisuals,
  type CampusNpc,
  type CrowdRoute,
} from './campus-crowd';
import { BONUS_CHAOS_SECRETS, type BonusChaosSecret } from './chaos-secrets';
import { WMU_TREE_POINTS } from './wmu-trees';

// The former coordinate was the center of the Fetzer Center itself. This point is
// on the open campus lawn immediately east of it, so a new goose never begins
// inside a building while still spawning at WMU.
export const WMU_SPAWN: [number, number] = [-85.616863, 42.284881];

// Campus secrets were authored before the safe lawn spawn moved. Keep their
// geographic anchor stable so a spawn tweak can never move a landmark again.
const WMU_CONTENT_ANCHOR: [number, number] = [-85.61771, 42.284996];

export type FlightMode = 'flying' | 'planing' | 'waddling' | 'swimming';

export type GameTelemetry = {
  speed: number;
  agl: number;
  sink: number;
  glideRatio: number | null;
  stamina: number;
  stall: number;
  mode: FlightMode;
  score: number;
  combo: number;
  secretsFound: number;
  secretsTotal: number;
  secretVisuals: number;
  nearestSecretLabel: string | null;
  nearestSecretDistance: number | null;
  nearestSecretDirection: number;
  nearestSecretBearing: number;
  students: number;
  studentsNearby: number;
  studentsOnMappedWalkways: number;
  nearestStudent: number | null;
  nearestStudentVertical: number | null;
  trees: number;
  treesResolved: number;
  flockSize: number;
  flockTotal: number;
  recruitableGooseInRange: boolean;
  altitudeBoost: number;
  groundElevation: number;
  east: number;
  north: number;
  heading: number;
  buildings: number;
  cameraZoom: number;
  cameraScale: number;
  insideBuilding: boolean;
  renderCalls: number;
  gooseVisible: boolean;
  gooseScreenX: number;
  gooseScreenY: number;
  duckCouncilEast: number;
  duckCouncilNorth: number;
  duckCouncilVisible: boolean;
};

type MapLibreModule = typeof import('maplibre-gl');

type Hooks = {
  onTelemetry: (telemetry: GameTelemetry) => void;
  onToast: (message: string) => void;
};

export type GooseEngine = {
  start: () => void;
  reset: () => void;
  setKey: (code: string, pressed: boolean) => void;
  scaleCameraZoom: (multiplier: number) => void;
  orbitCamera: (yawDelta: number, pitchDelta: number) => void;
  resetCamera: () => void;
  destroy: () => void;
};

type GooseRig = {
  root: THREE.Group;
  leftWing: THREE.Group;
  rightWing: THREE.Group;
  legs: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
};

type FlockGoose = {
  rig: GooseRig;
  beacon: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  home: THREE.Vector2;
  position: THREE.Vector3;
  ground: number;
  terrainResolved: boolean;
  terrainSamplePosition: THREE.Vector2;
  terrainRefreshRemaining: number;
  recruited: boolean;
  phase: number;
  waddlePhase: number;
  waterContactLatched: boolean;
  waterContactReleaseTime: number;
};

type SimState = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  forward: THREE.Vector3;
  heading: number;
  bank: number;
  alpha: number;
  stamina: number;
  stall: number;
  mode: FlightMode;
  ground: number;
  onWater: boolean;
  flapRemaining: number;
};

type Route = {
  points: THREE.Vector3[];
  cumulative: number[];
  total: number;
  cruise: number;
  laneWidth: number;
};

type TrafficCar = {
  index: number;
  route: Route;
  distance: number;
  directionSign: -1 | 1;
  laneOffset: number;
  speed: number;
  cruise: number;
  ground: number;
  targetGround: number;
  elevationTimer: number;
  stopped: boolean;
  position: THREE.Vector3;
  previousPosition: THREE.Vector3;
  direction: THREE.Vector3;
  previousDirection: THREE.Vector3;
  reactionRemaining: number;
  honkScoreCooldown: number;
  collisionCooldown: number;
  nearMissCooldown: number;
  wobbleRemaining: number;
};

type TrafficFleet = {
  bodies: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  cabins: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  wheels: THREE.InstancedMesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
};

type HonkWave = {
  mesh: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  age: number;
  life: number;
};

type BuildingCollider = {
  sourceKey: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  centerGround: number;
  ground: number;
  height: number;
  renderHeight: number;
  renderMinHeight: number;
  terrainResolved: boolean;
  terrainRefreshAt: number;
  outer: THREE.Vector2[];
  holes: THREE.Vector2[][];
};

type WaterArea = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  outer: THREE.Vector2[];
  holes: THREE.Vector2[][];
};

type CampusSecretKind =
  | 'radio'
  | 'duck-council'
  | 'bronco-horse'
  | 'diploma-tornado'
  | 'sky-ring'
  | 'dean-ufo'
  | 'chaos-bonus';

type CampusSecret = {
  id: string;
  kind: CampusSecretKind;
  group: THREE.Group;
  position: THREE.Vector3;
  radius: number;
  found: boolean;
  activation: number;
  honkCount: number;
  honkWindow: number;
  altitude: number;
  terrainResolved: boolean;
  terrainRefreshRemaining: number;
  definition?: BonusChaosSecret;
};

type CloudCluster = {
  east: number;
  north: number;
  altitude: number;
  scale: number;
  driftEast: number;
  driftNorth: number;
  phase: number;
};

type Splash = {
  group: THREE.Group;
  age: number;
  life: number;
  rings: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>[];
  drops: Array<{
    mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
    velocity: THREE.Vector3;
  }>;
};

const UP = new THREE.Vector3(0, 1, 0);
const FIXED_DT = 1 / 90;
const DEG = Math.PI / 180;
const FALLBACK_GROUND_MSL = 0;
const FLAP_PERIOD = 0.36;
const DOWNSTROKE = 0.2;
const FLAP_STAMINA_COST = 0.014;
const SPAWN_ALTITUDE = 42;
const SPAWN_SPEED = 13.8;
const MAX_TRAFFIC = 32;
const MAX_TREE_COUNT = 560;
const NEAR_SPAWN_CROWD_COUNT = 12;
const ALTITUDE_BOOST_HEIGHT = 50;
const ALTITUDE_BOOST_FULL_HEIGHT = 100;
const ALTITUDE_BOOST_RELEASE_HEIGHT = 47;
const BUILDING_ACTIVE_RADIUS = 150;
const TEXTURED_ROOF_RADIUS = 760;
const BUILDING_TEXTURE_MAX_ZOOM = 18;
const BUILDING_TEXTURE_MIN_ZOOM = 15;
const CHAOS_COMBO_SECONDS = 4;
const DEDICATED_WALKWAY_CLASSES = new Set([
  'path',
  'pedestrian',
  'footway',
  'steps',
  'cycleway',
]);
const PEDESTRIAN_ROUTE_CLASSES = new Set([
  'primary',
  'secondary',
  'tertiary',
  'minor',
  'service',
  'track',
  ...DEDICATED_WALKWAY_CLASSES,
]);

const FLOCK_ROOSTS = [
  [-22, 34],
  [54, -48],
  [-78, -38],
  [92, 82],
  [-118, 132],
  [178, -74],
  [-152, 238],
  [46, 304],
] as const;

const FLIGHT = {
  mass: 4.5,
  wingArea: 0.42,
  rho: 1.225,
  gravity: 9.81,
  cl0: 0.42,
  clAlpha: 4.8,
  clMax: 1.5,
  clMin: -0.8,
  alphaStall: 15 * DEG,
  alphaDeepStall: 24 * DEG,
  cd0: 0.03,
  inducedK: 0.055,
  deepStallDrag: 0.58,
  trimAlpha: 3 * DEG,
  maxBank: 48 * DEG,
  maxRollRate: 100 * DEG,
};

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const smoothstep = (low: number, high: number, value: number) => {
  const t = clamp((value - low) / Math.max(high - low, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

const neutralFlightAlpha = (speed: number, liftScale: number) => {
  const dynamicPressure =
    0.5 * FLIGHT.rho * Math.max(speed * speed, 0.1) * FLIGHT.wingArea;
  const targetLift = FLIGHT.mass * FLIGHT.gravity * 0.82;
  const targetCl = targetLift / Math.max(dynamicPressure * liftScale, 0.1);
  return clamp((targetCl - FLIGHT.cl0) / FLIGHT.clAlpha, -2.5 * DEG, 6 * DEG);
};

const moveToward = (value: number, target: number, maxDelta: number) => {
  if (Math.abs(target - value) <= maxDelta) return target;
  return value + Math.sign(target - value) * maxDelta;
};

function makeWingGeometry(side: -1 | 1) {
  const s = side;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        0,
        0.03,
        0.3,
        1.75 * s,
        -0.05,
        0.05,
        1.48 * s,
        -0.08,
        -0.45,
        0.76 * s,
        -0.02,
        -0.72,
        0.12 * s,
        0.03,
        -0.52,
      ],
      3,
    ),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4]);
  geometry.computeVertexNormals();
  return geometry;
}

function createGooseRig(frustumCulled = false) {
  const root = new THREE.Group();
  root.name = 'Canada goose';
  root.scale.setScalar(0.4);
  root.traverse((object) => {
    object.frustumCulled = frustumCulled;
  });

  const brown = new THREE.MeshStandardMaterial({
    color: 0x6c5742,
    roughness: 0.9,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x171b19,
    roughness: 0.82,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });
  const cream = new THREE.MeshStandardMaterial({
    color: 0xf0ead8,
    roughness: 0.88,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });
  const wingMat = new THREE.MeshStandardMaterial({
    color: 0x4d4338,
    roughness: 0.92,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });
  const orange = new THREE.MeshStandardMaterial({
    color: 0xe37c24,
    roughness: 0.75,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.54, 14, 10), brown);
  body.scale.set(0.9, 0.72, 1.36);
  body.position.set(0, 0.78, 0);
  root.add(body);

  const breast = new THREE.Mesh(new THREE.SphereGeometry(0.43, 12, 8), cream);
  breast.scale.set(0.78, 0.55, 0.72);
  breast.position.set(0, 0.7, 0.42);
  root.add(breast);

  const neck = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.135, 0.67, 5, 9),
    dark,
  );
  neck.rotation.x = 0.26;
  neck.position.set(0, 1.25, 0.43);
  root.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.245, 12, 9), dark);
  head.scale.set(0.88, 0.9, 1.04);
  head.position.set(0, 1.68, 0.66);
  root.add(head);

  const cheekGeometry = new THREE.SphereGeometry(0.105, 9, 6);
  for (const side of [-1, 1]) {
    const cheek = new THREE.Mesh(cheekGeometry, cream);
    cheek.scale.set(0.38, 0.84, 0.86);
    cheek.position.set(side * 0.2, 1.64, 0.75);
    root.add(cheek);
  }

  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.27, 8), dark);
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 1.66, 0.95);
  root.add(beak);

  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.62, 7), cream);
  tail.rotation.x = -Math.PI / 2;
  tail.position.set(0, 0.8, -0.72);
  root.add(tail);

  const leftWing = new THREE.Group();
  leftWing.position.set(-0.36, 0.9, 0.08);
  leftWing.add(new THREE.Mesh(makeWingGeometry(-1), wingMat));
  root.add(leftWing);

  const rightWing = new THREE.Group();
  rightWing.position.set(0.36, 0.9, 0.08);
  rightWing.add(new THREE.Mesh(makeWingGeometry(1), wingMat));
  root.add(rightWing);

  const legs = new THREE.Group();
  let leftLeg = new THREE.Group();
  let rightLeg = new THREE.Group();
  for (const side of [-1, 1]) {
    const legPivot = new THREE.Group();
    legPivot.position.set(side * 0.18, 0.5, 0.05);
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.045, 0.42, 7),
      orange,
    );
    leg.position.set(0, -0.21, 0);
    legPivot.add(leg);
    const foot = new THREE.Mesh(
      new THREE.BoxGeometry(0.17, 0.045, 0.31),
      orange,
    );
    foot.position.set(0, -0.425, 0.08);
    legPivot.add(foot);
    legs.add(legPivot);
    if (side === -1) leftLeg = legPivot;
    else rightLeg = legPivot;
  }
  root.add(legs);

  root.traverse((object) => {
    object.frustumCulled = false;
    if (object instanceof THREE.Mesh) {
      object.castShadow = false;
      object.receiveShadow = false;
    }
  });

  return {
    root,
    leftWing,
    rightWing,
    legs,
    leftLeg,
    rightLeg,
  } satisfies GooseRig;
}

function setGooseLegStride(rig: GooseRig, stride: number) {
  rig.leftLeg.rotation.x = stride * 0.42;
  rig.rightLeg.rotation.x = -stride * 0.42;
}

function createTrafficFleet(capacity: number) {
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.52,
    metalness: 0.12,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0x26383e,
    roughness: 0.24,
    metalness: 0.08,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });
  const tireMaterial = new THREE.MeshStandardMaterial({
    color: 0x171918,
    roughness: 0.96,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });
  const bodies = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.82, 0.52, 4.4),
    bodyMaterial,
    capacity,
  );
  const cabins = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.52, 0.72, 2.15),
    glassMaterial,
    capacity,
  );
  const wheelGeometry = new THREE.CylinderGeometry(0.31, 0.31, 0.2, 10);
  wheelGeometry.rotateZ(Math.PI / 2);
  const wheels = new THREE.InstancedMesh(
    wheelGeometry,
    tireMaterial,
    capacity * 4,
  );
  bodies.count = 0;
  cabins.count = 0;
  wheels.count = 0;
  bodies.frustumCulled = false;
  cabins.frustumCulled = false;
  wheels.frustumCulled = false;
  return { bodies, cabins, wheels } satisfies TrafficFleet;
}

function routeFromPoints(
  points: THREE.Vector3[],
  cruise = 7,
  laneWidth = 1.35,
) {
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(
      cumulative[index - 1] + points[index].distanceTo(points[index - 1]),
    );
  }
  return {
    points,
    cumulative,
    total: cumulative[cumulative.length - 1],
    cruise,
    laneWidth,
  } satisfies Route;
}

function sampleRoute(route: Route, distance: number) {
  const routeDistance = clamp(distance, 0, route.total);
  let index = 1;
  while (
    index < route.cumulative.length - 1 &&
    route.cumulative[index] < routeDistance
  )
    index += 1;
  const startDistance = route.cumulative[index - 1];
  const segmentLength = Math.max(
    route.cumulative[index] - startDistance,
    0.001,
  );
  const t = (routeDistance - startDistance) / segmentLength;
  const position = route.points[index - 1].clone().lerp(route.points[index], t);
  const direction = route.points[index]
    .clone()
    .sub(route.points[index - 1])
    .normalize();
  return { position, direction };
}

function pointInRing(east: number, north: number, ring: THREE.Vector2[]) {
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index, index += 1
  ) {
    const a = ring[index];
    const b = ring[previous];
    const crosses =
      a.y > north !== b.y > north &&
      east < ((b.x - a.x) * (north - a.y)) / (b.y - a.y || 1e-9) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInBuilding(
  east: number,
  north: number,
  building: BuildingCollider,
) {
  return (
    pointInRing(east, north, building.outer) &&
    !building.holes.some((hole) => pointInRing(east, north, hole))
  );
}

function closestBuildingBoundary(
  east: number,
  north: number,
  building: BuildingCollider,
) {
  let closestX = east;
  let closestZ = north;
  let distanceSquared = Infinity;
  for (const ring of [building.outer, ...building.holes]) {
    for (let index = 0; index < ring.length; index += 1) {
      const start = ring[index];
      const end = ring[(index + 1) % ring.length];
      const edgeX = end.x - start.x;
      const edgeZ = end.y - start.y;
      const edgeLengthSquared = edgeX * edgeX + edgeZ * edgeZ;
      if (edgeLengthSquared < 1e-8) continue;
      const t = clamp(
        ((east - start.x) * edgeX + (north - start.y) * edgeZ) /
          edgeLengthSquared,
        0,
        1,
      );
      const candidateX = start.x + edgeX * t;
      const candidateZ = start.y + edgeZ * t;
      const dx = east - candidateX;
      const dz = north - candidateZ;
      const candidateDistanceSquared = dx * dx + dz * dz;
      if (candidateDistanceSquared < distanceSquared) {
        distanceSquared = candidateDistanceSquared;
        closestX = candidateX;
        closestZ = candidateZ;
      }
    }
  }
  return { x: closestX, z: closestZ, distanceSquared };
}

function firstBuildingCrossing(
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  building: BuildingCollider,
  radius: number,
) {
  const movementX = endX - startX;
  const movementZ = endZ - startZ;
  const movementLengthSquared = movementX * movementX + movementZ * movementZ;
  if (movementLengthSquared < 1e-10) return null;
  let earliest = Infinity;
  let hitX = endX;
  let hitZ = endZ;
  let normalX = 0;
  let normalZ = 0;

  const recordHit = (
    time: number,
    boundaryX: number,
    boundaryZ: number,
    candidateNormalX: number,
    candidateNormalZ: number,
  ) => {
    if (time < 0 || time > 1 || time >= earliest) return;
    earliest = time;
    hitX = boundaryX;
    hitZ = boundaryZ;
    normalX = candidateNormalX;
    normalZ = candidateNormalZ;
  };

  for (const ring of [building.outer, ...building.holes]) {
    for (let index = 0; index < ring.length; index += 1) {
      const edgeStart = ring[index];
      const edgeEnd = ring[(index + 1) % ring.length];
      const edgeX = edgeEnd.x - edgeStart.x;
      const edgeZ = edgeEnd.y - edgeStart.y;
      const edgeLength = Math.hypot(edgeX, edgeZ);
      if (edgeLength < 1e-6) continue;
      const tangentX = edgeX / edgeLength;
      const tangentZ = edgeZ / edgeLength;
      const lineNormalX = -tangentZ;
      const lineNormalZ = tangentX;
      const startOffsetX = startX - edgeStart.x;
      const startOffsetZ = startZ - edgeStart.y;
      const signedStart =
        startOffsetX * lineNormalX + startOffsetZ * lineNormalZ;
      const signedVelocity = movementX * lineNormalX + movementZ * lineNormalZ;

      if (Math.abs(signedVelocity) > 1e-8) {
        for (const sign of [-1, 1]) {
          if (sign * signedVelocity >= 0) continue;
          const time = (sign * radius - signedStart) / signedVelocity;
          if (time < 0 || time > 1 || time >= earliest) continue;
          const centerX = startX + movementX * time;
          const centerZ = startZ + movementZ * time;
          const edgeDistance =
            (centerX - edgeStart.x) * tangentX +
            (centerZ - edgeStart.y) * tangentZ;
          if (edgeDistance < 0 || edgeDistance > edgeLength) continue;
          recordHit(
            time,
            edgeStart.x + tangentX * edgeDistance,
            edgeStart.y + tangentZ * edgeDistance,
            lineNormalX * sign,
            lineNormalZ * sign,
          );
        }
      }

      for (const endpoint of [edgeStart, edgeEnd]) {
        const offsetX = startX - endpoint.x;
        const offsetZ = startZ - endpoint.y;
        const startDistanceSquared = offsetX * offsetX + offsetZ * offsetZ;
        if (startDistanceSquared <= radius * radius + 1e-7) continue;
        const halfB = offsetX * movementX + offsetZ * movementZ;
        const c = startDistanceSquared - radius * radius;
        const discriminant = halfB * halfB - movementLengthSquared * c;
        if (discriminant < 0) continue;
        const time = (-halfB - Math.sqrt(discriminant)) / movementLengthSquared;
        if (time < 0 || time > 1 || time >= earliest) continue;
        const centerX = startX + movementX * time;
        const centerZ = startZ + movementZ * time;
        const candidateNormalX = (centerX - endpoint.x) / radius;
        const candidateNormalZ = (centerZ - endpoint.y) / radius;
        recordHit(
          time,
          endpoint.x,
          endpoint.y,
          candidateNormalX,
          candidateNormalZ,
        );
      }
    }
  }
  return earliest === Infinity
    ? null
    : { t: earliest, x: hitX, z: hitZ, normalX, normalZ };
}

export function createGooseEngine(
  maplibre: MapLibreModule,
  map: MapLibreMap,
  hooks: Hooks,
): GooseEngine {
  const coarsePointer = window.matchMedia('(any-pointer: coarse)').matches;
  const fixedStep = coarsePointer ? 1 / 60 : FIXED_DT;
  const texturedRoofLimit = coarsePointer ? 180 : 320;
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const goose = createGooseRig();
  const trafficFleet = createTrafficFleet(MAX_TRAFFIC);
  const crowdFleet = createCrowdFleet(MAX_CAMPUS_NPCS);
  scene.add(goose.root);
  scene.add(trafficFleet.bodies, trafficFleet.cabins, trafficFleet.wheels);
  scene.add(
    crowdFleet.heads,
    crowdFleet.torsos,
    crowdFleet.leftArms,
    crowdFleet.rightArms,
    crowdFleet.leftLegs,
    crowdFleet.rightLegs,
  );
  goose.root.visible = false;
  trafficFleet.bodies.visible = false;
  trafficFleet.cabins.visible = false;
  trafficFleet.wheels.visible = false;
  crowdFleet.heads.visible = false;
  crowdFleet.torsos.visible = false;
  crowdFleet.leftArms.visible = false;
  crowdFleet.rightArms.visible = false;
  crowdFleet.leftLegs.visible = false;
  crowdFleet.rightLegs.visible = false;
  scene.add(new THREE.HemisphereLight(0xdaf0f2, 0x6d6a4f, 2.35));
  const sun = new THREE.DirectionalLight(0xfff1c2, 3.2);
  sun.position.set(-90, 150, 60);
  scene.add(sun);

  const origin = maplibre.MercatorCoordinate.fromLngLat(WMU_SPAWN, 0);
  const meterScale = origin.meterInMercatorCoordinateUnits();
  const localToMap = new THREE.Matrix4().set(
    meterScale,
    0,
    0,
    origin.x,
    0,
    0,
    -meterScale,
    origin.y,
    0,
    meterScale,
    0,
    origin.z,
    0,
    0,
    0,
    1,
  );

  const keys = new Set<string>();
  const styleLayers = map.getStyle().layers ?? [];
  const waterLayers = styleLayers
    .filter(
      (layer) => layer.type === 'fill' && layer['source-layer'] === 'water',
    )
    .map((layer) => layer.id);
  const waterSourceLayer = styleLayers.find(
    (layer) =>
      layer.type === 'fill' &&
      layer['source-layer'] === 'water' &&
      'source' in layer &&
      typeof layer.source === 'string',
  );
  const waterSourceId =
    waterSourceLayer &&
    'source' in waterSourceLayer &&
    typeof waterSourceLayer.source === 'string'
      ? waterSourceLayer.source
      : null;
  const landcoverSourceLayer = styleLayers.find(
    (layer) =>
      layer.type === 'fill' &&
      layer['source-layer'] === 'landcover' &&
      'source' in layer &&
      typeof layer.source === 'string',
  );
  const landcoverSourceId =
    landcoverSourceLayer &&
    'source' in landcoverSourceLayer &&
    typeof landcoverSourceLayer.source === 'string'
      ? landcoverSourceLayer.source
      : null;
  const roadSourceLayer = styleLayers.find(
    (layer) =>
      'source-layer' in layer &&
      layer['source-layer'] === 'transportation' &&
      'source' in layer &&
      typeof layer.source === 'string',
  );
  const roadSourceId =
    roadSourceLayer &&
    'source' in roadSourceLayer &&
    typeof roadSourceLayer.source === 'string'
      ? roadSourceLayer.source
      : null;
  if (!roadSourceId)
    throw new Error('The map style did not provide OSM road geometry.');
  const buildingLayerIndex = styleLayers.findIndex(
    (layer) =>
      layer.type === 'fill-extrusion' && layer['source-layer'] === 'building',
  );
  if (buildingLayerIndex < 0)
    throw new Error('The map style did not provide 3D buildings.');
  const buildingLayer = styleLayers[buildingLayerIndex];
  const buildingSourceId =
    'source' in buildingLayer && typeof buildingLayer.source === 'string'
      ? buildingLayer.source
      : null;
  if (!buildingSourceId)
    throw new Error('The map style did not provide OSM building geometry.');
  const customLayerBeforeId = styleLayers[buildingLayerIndex + 1]?.id;

  const state: SimState = {
    position: new THREE.Vector3(0, FALLBACK_GROUND_MSL + SPAWN_ALTITUDE, 0),
    velocity: new THREE.Vector3(0, -0.4, SPAWN_SPEED),
    forward: new THREE.Vector3(0, 0, 1),
    heading: 0,
    bank: 0,
    alpha: FLIGHT.trimAlpha,
    stamina: 1,
    stall: 0,
    mode: 'flying',
    ground: FALLBACK_GROUND_MSL,
    onWater: false,
    flapRemaining: 0,
  };

  const makeStateCopy = (): SimState => ({
    position: state.position.clone(),
    velocity: state.velocity.clone(),
    forward: state.forward.clone(),
    heading: state.heading,
    bank: state.bank,
    alpha: state.alpha,
    stamina: state.stamina,
    stall: state.stall,
    mode: state.mode,
    ground: state.ground,
    onWater: state.onWater,
    flapRemaining: state.flapRemaining,
  });
  const previousState = makeStateCopy();
  const renderState = makeStateCopy();

  const copyState = (target: SimState, source: SimState) => {
    target.position.copy(source.position);
    target.velocity.copy(source.velocity);
    target.forward.copy(source.forward);
    target.heading = source.heading;
    target.bank = source.bank;
    target.alpha = source.alpha;
    target.stamina = source.stamina;
    target.stall = source.stall;
    target.mode = source.mode;
    target.ground = source.ground;
    target.onWater = source.onWater;
    target.flapRemaining = source.flapRemaining;
  };

  const interpolateState = (blend: number) => {
    renderState.position.lerpVectors(
      previousState.position,
      state.position,
      blend,
    );
    renderState.velocity.lerpVectors(
      previousState.velocity,
      state.velocity,
      blend,
    );
    renderState.forward.lerpVectors(
      previousState.forward,
      state.forward,
      blend,
    );
    if (renderState.forward.lengthSq() < 0.0001)
      renderState.forward.copy(state.forward);
    renderState.forward.normalize();
    const headingDelta = Math.atan2(
      Math.sin(state.heading - previousState.heading),
      Math.cos(state.heading - previousState.heading),
    );
    renderState.heading = previousState.heading + headingDelta * blend;
    renderState.bank = lerp(previousState.bank, state.bank, blend);
    renderState.alpha = lerp(previousState.alpha, state.alpha, blend);
    renderState.stamina = lerp(previousState.stamina, state.stamina, blend);
    renderState.stall = lerp(previousState.stall, state.stall, blend);
    renderState.mode = state.mode;
    renderState.ground = lerp(previousState.ground, state.ground, blend);
    renderState.onWater = state.onWater;
    renderState.flapRemaining = lerp(
      previousState.flapRemaining,
      state.flapRemaining,
      blend,
    );
  };

  let playing = false;
  let destroyed = false;
  let renderer: THREE.WebGLRenderer | null = null;
  let animationFrame = 0;
  let lastRenderCalls = 0;
  let previousTime = performance.now();
  let accumulator = 0;
  let surfaceClock = 0;
  let telemetryClock = 0;
  let buildingRefreshClock = 0;
  let buildingRefreshRequested = true;
  let trafficBuilt = false;
  const terrainSpecification = map.getTerrain();
  const terrainSourceId = terrainSpecification?.source ?? null;
  const terrainEnabled = Boolean(terrainSpecification);
  let unresolvedTreeCount = 0;
  let treeRefreshClock = 0;
  let cloudRefreshClock = 0;
  let lastYieldToast = -10;
  let elapsedTime = 0;
  let queuedFlaps = 0;
  let queuedHonks = 0;
  let gooseWaddlePhase = 0;
  let honkCooldown = 0;
  let chaosScore = 0;
  let chaosCombo = 1;
  let chaosComboEvents = 0;
  let chaosComboRemaining = 0;
  let campusInfamyUnlocked = false;
  let infamyPanicClock = 0;
  let tumbleRemaining = 0;
  let tumbleAngle = 0;
  let tumbleAngularSpeed = 0;
  let hitCooldown = 0;
  let buildingHitCooldown = 0;
  let buildingContactThisStep = false;
  let cameraShakeRemaining = 0;
  let lowGravityRemaining = 0;
  let megaHonkRemaining = 0;
  let slipperyRemaining = 0;
  let audioContext: AudioContext | null = null;
  let airborneTime = 0;
  let peakAgl = 0;
  let terrainSurfaceY = state.ground;
  let finalSurfaceSampleClock = 0;
  let waterSurfaceY = state.ground;
  let waterPlaningElapsed = 0;
  let waterDryTime = 0;
  let waterTouchdownSeverity = 0;
  let waterSprayClock = 0;
  let waterContactLatched = false;
  let waterContactReleaseTime = 0;
  let altitudeBoostActive = false;
  const texturedBuildingKeys = new Set<string>();
  const texturedBuildingMeshByKey = new Map<string, THREE.Mesh>();
  const texturedBuildingGroup = new THREE.Group();
  texturedBuildingGroup.name = 'Capped aerial roof overlays';
  texturedBuildingGroup.visible = false;
  scene.add(texturedBuildingGroup);
  const buildingColliderByKey = new Map<string, BuildingCollider>();
  const buildingMaterials = new Map<
    string,
    {
      texture: THREE.Texture;
      roof: THREE.MeshBasicMaterial;
    }
  >();
  const buildingColliders: BuildingCollider[] = [];
  const activeBuildingColliders: BuildingCollider[] = [];
  const activeColliderCenter = new THREE.Vector2(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  let activeColliderSourceCount = -1;
  const traffic: TrafficCar[] = [];
  const trafficRoutes: Route[] = [];
  const campusNpcs: CampusNpc[] = [];
  const pedestrianRoutes: CrowdRoute[] = [];
  const pedestrianRouteKeys = new Set<string>();
  const mappedWaterAreas: WaterArea[] = [];
  let dryMappedWalkwayCache: CrowdRoute[] = [];
  let dryMappedWalkwayCacheDirty = true;
  const guaranteedWalkwayBases: THREE.Vector3[][] = [];
  const crowdAnchor = new THREE.Vector2(0, 0);
  let guaranteedPedestrianRouteCount = 0;
  let mappedCrowdWalkwaySignature = '';
  let crowdRelocationClock = 0;
  const splashes: Splash[] = [];
  const honkWaves: HonkWave[] = [];
  const campusSecrets: CampusSecret[] = [];
  const flockGeese: FlockGoose[] = [];
  let secretsFound = 0;
  let recruitedFlockCount = 0;
  const cameraPosition = new THREE.Vector3(0, state.position.y + 15, -18);
  const cameraTarget = new THREE.Vector3(0, state.position.y + 1, 8);
  let cameraDistanceScale = 1;
  let cameraDistanceTarget = 1;
  let cameraOrbitYaw = 0;
  let cameraOrbitYawTarget = 0;
  let cameraOrbitPitch = 24 * DEG;
  let cameraOrbitPitchTarget = 24 * DEG;
  const initialCampusElevation = map.queryTerrainElevation(WMU_SPAWN);
  let campusGroundResolved =
    !terrainEnabled ||
    (typeof initialCampusElevation === 'number' &&
      Number.isFinite(initialCampusElevation) &&
      Math.abs(initialCampusElevation) >= 20);
  let campusGroundFallback =
    campusGroundResolved && typeof initialCampusElevation === 'number'
      ? initialCampusElevation
      : FALLBACK_GROUND_MSL;
  let cloudBaseElevation = campusGroundFallback;
  let cloudBaseResolved = campusGroundResolved;

  const cloudCount = coarsePointer ? 11 : 20;
  const cloudClusters: CloudCluster[] = Array.from(
    { length: cloudCount },
    (_, index) => {
      const angle = index * 2.399963229728653;
      const radius = 210 + ((index * 173) % 650);
      return {
        east: Math.cos(angle) * radius,
        north: Math.sin(angle) * radius,
        altitude: 76 + ((index * 29) % 82),
        scale: 5.5 + ((index * 37) % 54) / 10,
        driftEast: 0.65 + ((index * 7) % 13) / 10,
        driftNorth: -0.32 + ((index * 11) % 8) / 10,
        phase: index * 1.73,
      };
    },
  );
  const cloudPuffsPerCluster = 4;
  const cloudPuffs = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0xf8fbf7,
      transparent: true,
      opacity: 0.72,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    cloudCount * cloudPuffsPerCluster,
  );
  cloudPuffs.name = 'Procedural campus cloud banks';
  cloudPuffs.frustumCulled = false;
  cloudPuffs.renderOrder = 2;
  cloudPuffs.visible = false;
  scene.add(cloudPuffs);
  const cloudDummy = new THREE.Object3D();
  const cloudSpan = 1900;
  const wrapCloudCoordinate = (value: number) =>
    ((((value + cloudSpan * 0.5) % cloudSpan) + cloudSpan) % cloudSpan) -
    cloudSpan * 0.5;
  const updateClouds = () => {
    cloudClusters.forEach((cloud, cloudIndex) => {
      const centerEast = wrapCloudCoordinate(
        cloud.east + elapsedTime * cloud.driftEast,
      );
      const centerNorth = wrapCloudCoordinate(
        cloud.north + elapsedTime * cloud.driftNorth,
      );
      const centerY =
        cloudBaseElevation +
        cloud.altitude +
        Math.sin(elapsedTime * 0.12 + cloud.phase) * 1.8;
      for (let lobe = 0; lobe < cloudPuffsPerCluster; lobe += 1) {
        const lobeAngle = cloud.phase + lobe * 1.91;
        const lobeScale = lobe === 0 ? 1.18 : 0.72 + lobe * 0.08;
        cloudDummy.position.set(
          centerEast + Math.cos(lobeAngle) * cloud.scale * lobe * 0.48,
          centerY + (lobe === 0 ? 0.9 : Math.sin(lobeAngle) * 1.1),
          centerNorth + Math.sin(lobeAngle) * cloud.scale * lobe * 0.38,
        );
        cloudDummy.scale.set(
          cloud.scale * 1.55 * lobeScale,
          cloud.scale * 0.48 * lobeScale,
          cloud.scale * 1.05 * lobeScale,
        );
        cloudDummy.rotation.y = lobeAngle;
        cloudDummy.updateMatrix();
        cloudPuffs.setMatrixAt(
          cloudIndex * cloudPuffsPerCluster + lobe,
          cloudDummy.matrix,
        );
      }
    });
    cloudPuffs.instanceMatrix.needsUpdate = true;
    cloudPuffs.visible = playing && cloudBaseResolved;
  };
  updateClouds();
  let broncoSecret: CampusSecret | null = null;
  const broncoHome = new THREE.Vector2();
  let broncoHeading = 0.72;
  let broncoTurnRemaining = 1.8;
  let broncoTerrainRemaining = 0;
  let broncoObstacleRemaining = 0;
  let broncoGround = FALLBACK_GROUND_MSL;

  const localToLngLat = (east: number, north: number) =>
    new maplibre.MercatorCoordinate(
      origin.x + east * meterScale,
      origin.y - north * meterScale,
      0,
    ).toLngLat();

  const geoToLocal = (longitude: number, latitude: number) => {
    const coordinate = maplibre.MercatorCoordinate.fromLngLat(
      [longitude, latitude],
      0,
    );
    return new THREE.Vector3(
      (coordinate.x - origin.x) / meterScale,
      0,
      (origin.y - coordinate.y) / meterScale,
    );
  };

  const contentAnchorLocal = geoToLocal(
    WMU_CONTENT_ANCHOR[0],
    WMU_CONTENT_ANCHOR[1],
  );
  const authoredToLocal = (east: number, north: number) =>
    new THREE.Vector2(
      east + contentAnchorLocal.x,
      north + contentAnchorLocal.z,
    );

  const isUsableTerrainElevation = (elevation: number | null | undefined) => {
    if (typeof elevation !== 'number' || !Number.isFinite(elevation))
      return false;
    if (!terrainEnabled) return true;
    // A raster DEM can briefly return its zero-filled placeholder before the
    // real tile is decoded. WMU is far above sea level, so never freeze campus
    // content or collision slabs onto that placeholder.
    if (Math.abs(elevation) < 20) return false;
    return (
      !campusGroundResolved || Math.abs(elevation - campusGroundFallback) <= 120
    );
  };

  const terrainAt = (east: number, north: number, fallback = state.ground) => {
    const elevation = map.queryTerrainElevation(localToLngLat(east, north));
    return typeof elevation === 'number' && isUsableTerrainElevation(elevation)
      ? elevation
      : fallback;
  };

  const npcTerrainAt = (east: number, north: number, fallback: number) => {
    const safeFallback =
      Math.abs(fallback - campusGroundFallback) > 80
        ? campusGroundFallback
        : fallback;
    return terrainAt(east, north, safeFallback);
  };

  const finiteNumber = (value: unknown, fallback: number) => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const collectMappedWaterAreas = () => {
    if (!waterSourceId || !map.getSource(waterSourceId)) return false;
    const features = map.querySourceFeatures(waterSourceId, {
      sourceLayer: 'water',
    }) as Array<{
      geometry: { type: string; coordinates: unknown };
    }>;
    const nextAreas: WaterArea[] = [];
    features.forEach((feature) => {
      const polygonSets =
        feature.geometry.type === 'Polygon'
          ? [feature.geometry.coordinates as number[][][]]
          : feature.geometry.type === 'MultiPolygon'
            ? (feature.geometry.coordinates as number[][][][])
            : [];
      polygonSets.forEach((rings) => {
        const outer = (rings[0] ?? [])
          .filter((coordinate) => coordinate.length >= 2)
          .map(([longitude, latitude]) => geoToLocal(longitude, latitude))
          .slice(0, -1)
          .map((point) => new THREE.Vector2(point.x, point.z));
        if (outer.length < 3) return;
        const minX = Math.min(...outer.map((point) => point.x));
        const maxX = Math.max(...outer.map((point) => point.x));
        const minZ = Math.min(...outer.map((point) => point.y));
        const maxZ = Math.max(...outer.map((point) => point.y));
        if (maxX < -1400 || minX > 1400 || maxZ < -1400 || minZ > 1400) return;
        const holes = rings
          .slice(1)
          .map((ring) =>
            ring
              .filter((coordinate) => coordinate.length >= 2)
              .map(([longitude, latitude]) => geoToLocal(longitude, latitude))
              .slice(0, -1)
              .map((point) => new THREE.Vector2(point.x, point.z)),
          )
          .filter((ring) => ring.length >= 3);
        nextAreas.push({ minX, maxX, minZ, maxZ, outer, holes });
      });
    });
    mappedWaterAreas.splice(0, mappedWaterAreas.length, ...nextAreas);
    dryMappedWalkwayCacheDirty = true;
    return nextAreas.length > 0;
  };

  const isPointInMappedWater = (east: number, north: number) =>
    mappedWaterAreas.some(
      (area) =>
        east >= area.minX &&
        east <= area.maxX &&
        north >= area.minZ &&
        north <= area.maxZ &&
        pointInRing(east, north, area.outer) &&
        !area.holes.some((hole) => pointInRing(east, north, hole)),
    );

  const crowdRouteTouchesMappedWater = (route: CrowdRoute) => {
    if (mappedWaterAreas.length === 0) return false;
    const lateralClearance = (route.sidewalkOffset ?? 0) + 0.9;
    for (let index = 1; index < route.points.length; index += 1) {
      const start = route.points[index - 1];
      const end = route.points[index];
      const segmentX = end.x - start.x;
      const segmentZ = end.z - start.z;
      const length = Math.hypot(segmentX, segmentZ);
      const sampleCount = Math.max(1, Math.ceil(length / 4));
      const rightX = length > 0.001 ? segmentZ / length : 0;
      const rightZ = length > 0.001 ? -segmentX / length : 0;
      for (let sample = 0; sample <= sampleCount; sample += 1) {
        const amount = sample / sampleCount;
        const east = lerp(start.x, end.x, amount);
        const north = lerp(start.z, end.z, amount);
        if (
          isPointInMappedWater(east, north) ||
          isPointInMappedWater(
            east + rightX * lateralClearance,
            north + rightZ * lateralClearance,
          ) ||
          isPointInMappedWater(
            east - rightX * lateralClearance,
            north - rightZ * lateralClearance,
          )
        )
          return true;
      }
    }
    return false;
  };

  const refreshActiveBuildingColliders = (force = false) => {
    if (
      !force &&
      activeColliderSourceCount === buildingColliders.length &&
      Math.hypot(
        state.position.x - activeColliderCenter.x,
        state.position.z - activeColliderCenter.y,
      ) < 18
    )
      return;
    activeColliderCenter.set(state.position.x, state.position.z);
    activeColliderSourceCount = buildingColliders.length;
    activeBuildingColliders.length = 0;
    for (const building of buildingColliders) {
      const dx =
        state.position.x < building.minX
          ? building.minX - state.position.x
          : state.position.x > building.maxX
            ? state.position.x - building.maxX
            : 0;
      const dz =
        state.position.z < building.minZ
          ? building.minZ - state.position.z
          : state.position.z > building.maxZ
            ? state.position.z - building.maxZ
            : 0;
      if (
        dx * dx + dz * dz <=
        BUILDING_ACTIVE_RADIUS * BUILDING_ACTIVE_RADIUS
      ) {
        activeBuildingColliders.push(building);
      }
    }
  };

  const chooseBuildingTextureTile = (ring: number[][]) => {
    const mercatorPoints = ring.map(([longitude, latitude]) =>
      maplibre.MercatorCoordinate.fromLngLat([longitude, latitude], 0),
    );
    for (
      let zoom = BUILDING_TEXTURE_MAX_ZOOM;
      zoom >= BUILDING_TEXTURE_MIN_ZOOM;
      zoom -= 1
    ) {
      const scale = 2 ** zoom;
      const tileX = Math.floor(mercatorPoints[0].x * scale);
      const tileY = Math.floor(mercatorPoints[0].y * scale);
      if (
        mercatorPoints.every(
          (point) =>
            Math.floor(point.x * scale) === tileX &&
            Math.floor(point.y * scale) === tileY,
        )
      ) {
        return { zoom, tileX, tileY };
      }
    }
    const scale = 2 ** BUILDING_TEXTURE_MIN_ZOOM;
    const center = mercatorPoints.reduce(
      (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
      { x: 0, y: 0 },
    );
    return {
      zoom: BUILDING_TEXTURE_MIN_ZOOM,
      tileX: Math.floor((center.x / mercatorPoints.length) * scale),
      tileY: Math.floor((center.y / mercatorPoints.length) * scale),
    };
  };

  const getBuildingMaterials = (zoom: number, tileX: number, tileY: number) => {
    const key = `${zoom}/${tileY}/${tileX}`;
    const cached = buildingMaterials.get(key);
    if (cached) return cached;

    const roof = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    const url = `https://imagery.michigan.gov/server/rest/services/Michigan_imagery_public/MapServer/tile/${zoom}/${tileY}/${tileX}`;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const texture = loader.load(
      url,
      (loadedTexture) => {
        loadedTexture.colorSpace = THREE.SRGBColorSpace;
        loadedTexture.wrapS = THREE.ClampToEdgeWrapping;
        loadedTexture.wrapT = THREE.ClampToEdgeWrapping;
        loadedTexture.minFilter = THREE.LinearMipmapLinearFilter;
        loadedTexture.magFilter = THREE.LinearFilter;
        loadedTexture.anisotropy = Math.min(
          8,
          renderer?.capabilities.getMaxAnisotropy() ?? 4,
        );
        loadedTexture.needsUpdate = true;
        map.triggerRepaint();
      },
      undefined,
      () => {
        roof.map = null;
        roof.color.setHex(0xc7c1b5);
        roof.needsUpdate = true;
      },
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    roof.map = texture;
    const materialSet = { texture, roof };
    buildingMaterials.set(key, materialSet);
    return materialSet;
  };

  const applyBuildingRoofUvs = (
    geometry: THREE.BufferGeometry,
    zoom: number,
    tileX: number,
    tileY: number,
  ) => {
    const scale = 2 ** zoom;
    const positions = geometry.getAttribute('position');
    const uvs = new Float32Array(positions.count * 2);
    for (let index = 0; index < positions.count; index += 1) {
      const east = positions.getX(index);
      const negativeNorth = positions.getY(index);
      const mercatorX = origin.x + east * meterScale;
      const mercatorY = origin.y + negativeNorth * meterScale;
      uvs[index * 2] = clamp(mercatorX * scale - tileX, 0, 1);
      uvs[index * 2 + 1] = clamp(1 - (mercatorY * scale - tileY), 0, 1);
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  };

  const buildTexturedBuildings = () => {
    if (!map.getSource(buildingSourceId)) return false;
    const features = map.querySourceFeatures(buildingSourceId, {
      sourceLayer: 'building',
    }) as Array<{
      id?: string | number;
      properties?: Record<string, unknown>;
      geometry: { type: string; coordinates: unknown };
    }>;
    let changed = false;
    let terrainQueryBudget = coarsePointer ? 7 : 12;

    features.forEach((feature) => {
      const polygonSets =
        feature.geometry.type === 'Polygon'
          ? [feature.geometry.coordinates as number[][][]]
          : feature.geometry.type === 'MultiPolygon'
            ? (feature.geometry.coordinates as number[][][][])
            : [];
      const properties = feature.properties ?? {};
      const levels = finiteNumber(properties.levels, 0);
      const renderHeight = clamp(
        finiteNumber(
          properties.render_height ?? properties.height,
          levels > 0 ? levels * 3.1 : 5,
        ),
        2.6,
        180,
      );
      const renderMinHeight = clamp(
        finiteNumber(properties.render_min_height ?? properties.min_height, 0),
        0,
        Math.max(0, renderHeight - 0.5),
      );
      polygonSets.forEach((rings, polygonIndex) => {
        const outerRing =
          rings[0]?.filter((coordinate) => coordinate.length >= 2) ?? [];
        if (outerRing.length < 4) return;
        const localOuter = outerRing.map(([longitude, latitude]) =>
          geoToLocal(longitude, latitude),
        );
        const minX = Math.min(...localOuter.map((point) => point.x));
        const maxX = Math.max(...localOuter.map((point) => point.x));
        const minZ = Math.min(...localOuter.map((point) => point.z));
        const maxZ = Math.max(...localOuter.map((point) => point.z));
        const centerX = (minX + maxX) * 0.5;
        const centerZ = (minZ + maxZ) * 0.5;
        const spanX = maxX - minX;
        const spanZ = maxZ - minZ;
        if (
          Math.hypot(centerX, centerZ) > 1800 ||
          spanX < 0.8 ||
          spanZ < 0.8 ||
          spanX > 500 ||
          spanZ > 500
        )
          return;

        const footprintKey = [
          feature.id ?? 'building',
          polygonIndex,
          minX.toFixed(1),
          minZ.toFixed(1),
          maxX.toFixed(1),
          maxZ.toFixed(1),
          renderHeight.toFixed(1),
          renderMinHeight.toFixed(1),
        ].join(':');
        const wantsTexturedRoof =
          !texturedBuildingKeys.has(footprintKey) &&
          texturedBuildingKeys.size < texturedRoofLimit &&
          Math.hypot(centerX, centerZ) <= TEXTURED_ROOF_RADIUS;
        const existingCollider = buildingColliderByKey.get(footprintKey);
        const nearPlayer =
          Math.hypot(centerX - state.position.x, centerZ - state.position.z) <=
          BUILDING_ACTIVE_RADIUS + 110;
        const staleAgainstCampus =
          existingCollider !== undefined &&
          campusGroundResolved &&
          Math.abs(existingCollider.centerGround - campusGroundFallback) > 120;
        const needsTerrainRefresh =
          terrainEnabled &&
          terrainQueryBudget > 0 &&
          (!existingCollider ||
            (nearPlayer &&
              (!existingCollider.terrainResolved ||
                staleAgainstCampus ||
                elapsedTime >= existingCollider.terrainRefreshAt)));

        if (existingCollider && !wantsTexturedRoof && !needsTerrainRefresh)
          return;

        let centerGround =
          existingCollider?.centerGround ?? campusGroundFallback;
        let colliderGround =
          existingCollider?.ground ?? campusGroundFallback + renderMinHeight;
        let colliderHeight = existingCollider?.height ?? renderHeight;
        let colliderTerrainResolved =
          existingCollider?.terrainResolved ?? !terrainEnabled;
        let colliderTerrainRefreshAt =
          existingCollider?.terrainRefreshAt ?? elapsedTime + 0.3;
        if (needsTerrainRefresh) {
          terrainQueryBudget -= 1;
          const terrainLocations: ReadonlyArray<readonly [number, number]> =
            existingCollider
              ? [[centerX, centerZ]]
              : [
                  [centerX, centerZ],
                  [minX, minZ],
                  [minX, maxZ],
                  [maxX, minZ],
                  [maxX, maxZ],
                ];
          const terrainReadings = terrainEnabled
            ? terrainLocations.map(([east, north]) =>
                map.queryTerrainElevation(localToLngLat(east, north)),
              )
            : [];
          colliderTerrainResolved =
            !terrainEnabled ||
            terrainReadings.every((elevation) =>
              isUsableTerrainElevation(elevation),
            );
          centerGround =
            terrainEnabled &&
            typeof terrainReadings[0] === 'number' &&
            isUsableTerrainElevation(terrainReadings[0])
              ? terrainReadings[0]
              : centerGround;
          const terrainSamples = terrainEnabled
            ? terrainReadings.map((elevation) =>
                typeof elevation === 'number' &&
                isUsableTerrainElevation(elevation)
                  ? elevation
                  : centerGround,
              )
            : terrainLocations.map(() => centerGround);
          if (existingCollider) {
            const terrainDelta = centerGround - existingCollider.centerGround;
            colliderGround = existingCollider.ground + terrainDelta;
            colliderHeight = existingCollider.height;
          } else {
            const lowestTerrain = Math.min(...terrainSamples);
            const highestTerrain = Math.max(...terrainSamples);
            colliderGround = lowestTerrain + renderMinHeight;
            colliderHeight = Math.max(
              2.6,
              highestTerrain + renderHeight - colliderGround,
            );
          }
          const refreshJitter =
            Math.abs(Math.sin(centerX * 0.013 + centerZ * 0.017)) * 0.85;
          colliderTerrainRefreshAt =
            elapsedTime +
            (colliderTerrainResolved ? 2.35 + refreshJitter : 0.42);
          if (existingCollider) {
            const previousRoof =
              existingCollider.ground + existingCollider.height;
            const nextRoof = colliderGround + colliderHeight;
            const roofDelta = nextRoof - previousRoof;
            const supportsGoose =
              state.mode === 'waddling' &&
              Math.abs(state.ground - previousRoof) < 0.45 &&
              Math.abs(state.position.y - (previousRoof + 0.04)) < 0.65 &&
              pointInBuilding(
                state.position.x,
                state.position.z,
                existingCollider,
              );
            const terrainChanged =
              Math.abs(existingCollider.centerGround - centerGround) > 0.05 ||
              Math.abs(existingCollider.ground - colliderGround) > 0.05 ||
              Math.abs(existingCollider.height - colliderHeight) > 0.05;
            existingCollider.centerGround = centerGround;
            existingCollider.ground = colliderGround;
            existingCollider.height = colliderHeight;
            existingCollider.renderHeight = renderHeight;
            existingCollider.renderMinHeight = renderMinHeight;
            existingCollider.terrainResolved = colliderTerrainResolved;
            existingCollider.terrainRefreshAt = colliderTerrainRefreshAt;
            if (supportsGoose && Math.abs(roofDelta) < 30) {
              state.position.y += roofDelta;
              previousState.position.y += roofDelta;
              renderState.position.y += roofDelta;
              state.ground = nextRoof;
            }
            const roofMesh = texturedBuildingMeshByKey.get(footprintKey);
            if (roofMesh) roofMesh.position.y = centerGround;
            if (terrainChanged) changed = true;
          }
        }

        if (existingCollider && !wantsTexturedRoof) return;

        const localHoles = rings.slice(1).map((holeRing) =>
          holeRing
            .filter((coordinate) => coordinate.length >= 2)
            .map(([longitude, latitude]) => geoToLocal(longitude, latitude))
            .slice(0, -1),
        );
        const colliderOuter = localOuter
          .slice(0, -1)
          .map((point) => new THREE.Vector2(point.x, point.z));
        const colliderHoles = localHoles
          .filter((hole) => hole.length >= 3)
          .map((hole) =>
            hole.map((point) => new THREE.Vector2(point.x, point.z)),
          );
        if (colliderOuter.length < 3) return;

        // Collision ingestion is deliberately independent from the decorative
        // aerial roof mesh. A failed/late texture can never make a visible OSM
        // building non-solid.
        if (!existingCollider) {
          const collider: BuildingCollider = {
            sourceKey: footprintKey,
            minX,
            maxX,
            minZ,
            maxZ,
            centerGround,
            ground: colliderGround,
            height: colliderHeight,
            renderHeight,
            renderMinHeight,
            terrainResolved: colliderTerrainResolved,
            terrainRefreshAt: colliderTerrainRefreshAt,
            outer: colliderOuter,
            holes: colliderHoles,
          };
          buildingColliderByKey.set(footprintKey, collider);
          buildingColliders.push(collider);
          changed = true;
        }

        if (!wantsTexturedRoof) return;
        const shapePoints = localOuter
          .slice(0, -1)
          .map((point) => new THREE.Vector2(point.x, -point.z));
        if (shapePoints.length < 3) return;
        const footprintArea =
          Math.abs(
            shapePoints.reduce((area, point, index) => {
              const next = shapePoints[(index + 1) % shapePoints.length];
              return area + point.x * next.y - next.x * point.y;
            }, 0),
          ) * 0.5;
        if (footprintArea < 5) return;
        const shape = new THREE.Shape(shapePoints);
        localHoles.forEach((holePoints) => {
          const shapeHole = holePoints.map(
            (point) => new THREE.Vector2(point.x, -point.z),
          );
          if (shapeHole.length >= 3)
            shape.holes.push(new THREE.Path(shapeHole));
        });

        const { zoom, tileX, tileY } = chooseBuildingTextureTile(outerRing);
        const materials = getBuildingMaterials(zoom, tileX, tileY);
        const geometry = new THREE.ShapeGeometry(shape, 1);
        applyBuildingRoofUvs(geometry, zoom, tileX, tileY);
        geometry.rotateX(-Math.PI / 2);
        geometry.translate(0, renderHeight + 0.08, 0);
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, materials.roof);
        mesh.name = 'MiSAIL aerial roof overlay';
        mesh.position.y = centerGround;
        mesh.frustumCulled = true;
        mesh.renderOrder = 1;
        texturedBuildingGroup.add(mesh);
        texturedBuildingMeshByKey.set(footprintKey, mesh);
        texturedBuildingKeys.add(footprintKey);
        changed = true;
      });
    });

    if (changed) settleFlockRoosts();
    return changed;
  };

  const createCampusSecrets = () => {
    const gold = new THREE.MeshStandardMaterial({
      color: 0xf4b942,
      roughness: 0.48,
      metalness: 0.32,
      emissive: 0x4b2600,
      emissiveIntensity: 0.4,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1,
      depthTest: true,
      depthWrite: true,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x20312b,
      roughness: 0.76,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1,
      depthTest: true,
      depthWrite: true,
    });
    const cream = new THREE.MeshStandardMaterial({
      color: 0xf3ead2,
      roughness: 0.82,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1,
      depthTest: true,
      depthWrite: true,
    });
    const orange = new THREE.MeshStandardMaterial({
      color: 0xe9862b,
      roughness: 0.72,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1,
      depthTest: true,
      depthWrite: true,
    });
    const glow = new THREE.MeshBasicMaterial({
      color: 0x83f0c1,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const finishGroup = (group: THREE.Group) => {
      group.traverse((object) => {
        object.frustumCulled = false;
      });
      group.visible = playing;
      scene.add(group);
    };

    const addSecret = (
      id: string,
      kind: CampusSecretKind,
      group: THREE.Group,
      east: number,
      north: number,
      altitude: number,
      radius: number,
      definition?: BonusChaosSecret,
    ) => {
      const local = authoredToLocal(east, north);
      const elevation = map.queryTerrainElevation(
        localToLngLat(local.x, local.y),
      );
      const terrainResolved =
        !terrainEnabled || isUsableTerrainElevation(elevation);
      const ground =
        terrainResolved && typeof elevation === 'number'
          ? elevation
          : campusGroundFallback;
      group.position.set(local.x, ground + altitude, local.y);
      group.userData.baseY = group.position.y;
      finishGroup(group);
      const secret: CampusSecret = {
        id,
        kind,
        group,
        position: group.position.clone(),
        radius,
        found: false,
        activation: 0,
        honkCount: 0,
        honkWindow: 0,
        altitude,
        terrainResolved,
        terrainRefreshRemaining: (campusSecrets.length % 7) * 0.11,
        definition,
      };
      campusSecrets.push(secret);
      group.visible = playing && terrainResolved;
      return secret;
    };

    const radio = new THREE.Group();
    radio.name = 'Fetzer Radio Goose';
    const radioMast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.2, 4.4, 8),
      dark,
    );
    radioMast.position.y = 2.2;
    radio.add(radioMast);
    const dish = new THREE.Mesh(
      new THREE.SphereGeometry(1.65, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2),
      gold,
    );
    dish.scale.set(1, 0.26, 1);
    dish.rotation.x = Math.PI / 2.8;
    dish.position.set(0, 4.25, 0.15);
    radio.add(dish);
    const radioBeacon = new THREE.Mesh(
      new THREE.TorusGeometry(2.25, 0.07, 7, 32),
      glow.clone(),
    );
    radioBeacon.name = 'secret-beacon';
    radioBeacon.rotation.x = Math.PI / 2;
    radioBeacon.position.y = 5.25;
    radio.add(radioBeacon);
    addSecret('fetzer-radio', 'radio', radio, 18, -8, 26, 13);

    const makeDuck = (scale = 1) => {
      const duck = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 7), gold);
      body.scale.set(1.2, 0.75, 1.45);
      body.position.y = 0.45;
      duck.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 9, 7), gold);
      head.position.set(0, 0.78, 0.45);
      duck.add(head);
      const beak = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 7), orange);
      beak.rotation.x = Math.PI / 2;
      beak.position.set(0, 0.76, 0.73);
      duck.add(beak);
      duck.scale.setScalar(scale);
      return duck;
    };
    const council = new THREE.Group();
    council.name = 'Council of Ducks';
    for (let index = 0; index < 3; index += 1) {
      const ripple = new THREE.Mesh(
        new THREE.TorusGeometry(4.4 + index * 1.35, 0.075, 7, 44),
        glow.clone(),
      );
      ripple.name = 'duck-ripple';
      ripple.rotation.x = Math.PI / 2;
      ripple.position.y = 0.08 + index * 0.025;
      council.add(ripple);
    }
    const councilBeacon = new THREE.Mesh(
      new THREE.TorusGeometry(4.8, 0.11, 8, 44),
      glow.clone(),
    );
    councilBeacon.name = 'secret-beacon';
    councilBeacon.position.y = 4.4;
    council.add(councilBeacon);
    for (let index = 0; index < 5; index += 1) {
      const angle = (index / 5) * Math.PI * 2;
      const duck = makeDuck(1.25);
      duck.position.set(Math.cos(angle) * 3.2, 0, Math.sin(angle) * 3.2);
      duck.rotation.y = -angle + Math.PI / 2;
      council.add(duck);
    }
    const duckElder = makeDuck(2.8);
    duckElder.name = 'duck-elder';
    duckElder.position.y = -3.2;
    council.add(duckElder);
    addSecret('duck-council', 'duck-council', council, 112.4, 332.4, 0.08, 30);

    const bronco = new THREE.Group();
    bronco.name = 'The Runaway WMU Bronco';
    const horseBrown = new THREE.MeshStandardMaterial({
      color: 0x6e3f25,
      roughness: 0.9,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1,
      depthTest: true,
      depthWrite: true,
    });
    const horseDark = new THREE.MeshStandardMaterial({
      color: 0x25170f,
      roughness: 0.94,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1,
      depthTest: true,
      depthWrite: true,
    });
    const horseBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.82, 0.88, 1.78),
      horseBrown,
    );
    horseBody.position.y = 1.08;
    bronco.add(horseBody);
    const horseChest = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 10, 8),
      horseBrown,
    );
    horseChest.scale.set(0.82, 1, 0.78);
    horseChest.position.set(0, 1.18, 0.58);
    bronco.add(horseChest);
    const horseNeck = new THREE.Mesh(
      new THREE.BoxGeometry(0.48, 1.05, 0.5),
      horseBrown,
    );
    horseNeck.rotation.x = -0.28;
    horseNeck.position.set(0, 1.68, 0.67);
    bronco.add(horseNeck);
    const horseHead = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.48, 0.78),
      horseBrown,
    );
    horseHead.position.set(0, 2.14, 1.02);
    bronco.add(horseHead);
    const muzzle = new THREE.Mesh(
      new THREE.BoxGeometry(0.44, 0.3, 0.48),
      cream,
    );
    muzzle.position.set(0, 2.04, 1.52);
    bronco.add(muzzle);
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(
        new THREE.ConeGeometry(0.11, 0.42, 7),
        horseDark,
      );
      ear.position.set(side * 0.16, 2.52, 0.92);
      bronco.add(ear);
      for (const z of [-0.58, 0.57]) {
        const leg = new THREE.Mesh(
          new THREE.CylinderGeometry(0.085, 0.1, 0.92, 7),
          horseDark,
        );
        leg.name = `bronco-leg-${side}-${z}`;
        leg.position.set(side * 0.28, 0.48, z);
        bronco.add(leg);
      }
    }
    const mane = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.72, 0.65),
      horseDark,
    );
    mane.position.set(0, 1.88, 0.42);
    mane.rotation.x = -0.25;
    bronco.add(mane);
    const tail = new THREE.Mesh(
      new THREE.ConeGeometry(0.13, 0.92, 8),
      horseDark,
    );
    tail.name = 'bronco-tail';
    tail.rotation.x = -0.48;
    tail.position.set(0, 1.02, -1.2);
    bronco.add(tail);
    const saddle = new THREE.Mesh(
      new THREE.BoxGeometry(0.86, 0.16, 0.72),
      gold,
    );
    saddle.position.set(0, 1.58, -0.12);
    bronco.add(saddle);
    const broncoBeacon = new THREE.Mesh(
      new THREE.TorusGeometry(1.6, 0.07, 7, 34),
      glow.clone(),
    );
    broncoBeacon.name = 'bronco-beacon';
    broncoBeacon.rotation.x = Math.PI / 2;
    broncoBeacon.position.y = 2.9;
    bronco.add(broncoBeacon);
    broncoSecret = addSecret(
      'runaway-wmu-bronco',
      'bronco-horse',
      bronco,
      -38,
      178,
      0.06,
      2.15,
    );
    bronco.traverse((object) => {
      object.frustumCulled = false;
    });
    broncoHome.set(broncoSecret.position.x, broncoSecret.position.z);
    broncoGround = broncoSecret.position.y - broncoSecret.altitude;

    const diploma = new THREE.Group();
    diploma.name = 'Sangren Diploma Tornado';
    for (let index = 0; index < 14; index += 1) {
      const paper = new THREE.Mesh(
        new THREE.PlaneGeometry(0.55 + (index % 3) * 0.12, 0.8),
        new THREE.MeshStandardMaterial({
          color: index % 4 === 0 ? 0xf0c75e : 0xf4f1e8,
          roughness: 0.82,
          side: THREE.DoubleSide,
        }),
      );
      const angle = index * 1.71;
      paper.position.set(
        Math.cos(angle) * (1 + (index % 4) * 0.24),
        0.3 + index * 0.34,
        Math.sin(angle) * (1 + (index % 4) * 0.24),
      );
      paper.rotation.set(angle * 0.2, angle, angle * 0.45);
      diploma.add(paper);
    }
    addSecret(
      'diploma-tornado',
      'diploma-tornado',
      diploma,
      258.3,
      -105.4,
      0.08,
      5.5,
    );

    const skyRing = new THREE.Group();
    skyRing.name = 'Miller Auditori-Honk';
    const outerRing = new THREE.Mesh(
      new THREE.TorusGeometry(4.3, 0.32, 10, 44),
      gold,
    );
    outerRing.name = 'portal-outer';
    skyRing.add(outerRing);
    const innerRing = new THREE.Mesh(
      new THREE.TorusGeometry(3.55, 0.08, 8, 40),
      glow.clone(),
    );
    innerRing.name = 'portal-inner';
    skyRing.add(innerRing);
    for (let index = 0; index < 5; index += 1) {
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 7, 5), cream);
      const angle = (index / 5) * Math.PI * 2;
      bulb.position.set(Math.cos(angle) * 4.3, Math.sin(angle) * 4.3, 0);
      skyRing.add(bulb);
    }
    addSecret('miller-ring', 'sky-ring', skyRing, 180.6, -632.7, 28, 4.1);

    const ufoSite = new THREE.Group();
    ufoSite.name = 'Take Me to Your Dean';
    const cropCircle = new THREE.Mesh(
      new THREE.TorusGeometry(5.4, 0.12, 7, 48),
      glow.clone(),
    );
    cropCircle.rotation.x = Math.PI / 2;
    cropCircle.position.y = 0.12;
    ufoSite.add(cropCircle);
    for (let index = 0; index < 7; index += 1) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.24, 0.85, 8),
        orange,
      );
      const angle = (index / 7) * Math.PI * 2;
      cone.position.set(Math.cos(angle) * 4.8, 0.42, Math.sin(angle) * 4.8);
      ufoSite.add(cone);
    }
    const saucer = new THREE.Group();
    saucer.name = 'secret-saucer';
    saucer.visible = false;
    saucer.position.y = 8;
    const saucerBody = new THREE.Mesh(
      new THREE.CylinderGeometry(3.4, 2.1, 0.55, 18),
      dark,
    );
    saucer.add(saucerBody);
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1.5, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      glow.clone(),
    );
    dome.position.y = 0.25;
    saucer.add(dome);
    ufoSite.add(saucer);
    addSecret('dean-ufo', 'dean-ufo', ufoSite, 213.5, 567.8, 0.08, 13);

    BONUS_CHAOS_SECRETS.forEach((definition) => {
      const group = new THREE.Group();
      group.name = definition.label;
      const material = new THREE.MeshStandardMaterial({
        color: definition.color,
        roughness: 0.55,
        metalness: 0.2,
        emissive: new THREE.Color(definition.color).multiplyScalar(0.18),
        emissiveIntensity: 0.55,
        side: THREE.DoubleSide,
        transparent: false,
        opacity: 1,
        depthTest: true,
        depthWrite: true,
      });
      const beaconMaterial = new THREE.MeshBasicMaterial({
        color: definition.color,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

      if (definition.visual === 'air-gate') {
        const gate = new THREE.Mesh(
          new THREE.TorusGeometry(3.2, 0.22, 9, 38),
          material,
        );
        gate.name = 'bonus-spinner';
        group.add(gate);
        const inner = new THREE.Mesh(
          new THREE.TorusGeometry(2.65, 0.055, 7, 34),
          beaconMaterial,
        );
        inner.name = 'bonus-pulse';
        group.add(inner);
        for (let index = 0; index < 6; index += 1) {
          const angle = (index / 6) * Math.PI * 2;
          const bulb = new THREE.Mesh(
            new THREE.SphereGeometry(0.13, 7, 5),
            cream,
          );
          bulb.position.set(Math.cos(angle) * 3.2, Math.sin(angle) * 3.2, 0);
          group.add(bulb);
        }
      } else if (definition.visual === 'honk-shrine') {
        const circle = new THREE.Mesh(
          new THREE.TorusGeometry(2.3, 0.09, 7, 36),
          beaconMaterial,
        );
        circle.name = 'bonus-pulse';
        circle.rotation.x = Math.PI / 2;
        circle.position.y = 0.1;
        group.add(circle);
        const post = new THREE.Mesh(
          new THREE.CylinderGeometry(0.18, 0.28, 2.4, 8),
          material,
        );
        post.position.y = 1.2;
        group.add(post);
        const bell = new THREE.Mesh(
          new THREE.ConeGeometry(0.65, 0.85, 10),
          material,
        );
        bell.name = 'bonus-spinner';
        bell.rotation.x = Math.PI;
        bell.position.y = 2.75;
        group.add(bell);
      } else if (definition.visual === 'bonk-cluster') {
        for (let index = 0; index < 7; index += 1) {
          const angle = (index / 7) * Math.PI * 2;
          const prop = new THREE.Mesh(
            new THREE.ConeGeometry(
              0.28 + (index % 2) * 0.08,
              0.95 + (index % 3) * 0.12,
              7,
            ),
            material,
          );
          prop.position.set(
            Math.cos(angle) * 1.75,
            0.48,
            Math.sin(angle) * 1.75,
          );
          prop.rotation.z = (index % 2 ? -1 : 1) * 0.08;
          group.add(prop);
        }
        const marker = new THREE.Mesh(
          new THREE.TorusGeometry(2.6, 0.07, 7, 36),
          beaconMaterial,
        );
        marker.name = 'bonus-pulse';
        marker.rotation.x = Math.PI / 2;
        marker.position.y = 0.08;
        group.add(marker);
      } else if (definition.visual === 'rideable') {
        const platform = new THREE.Mesh(
          new THREE.BoxGeometry(3.1, 0.35, 1.5),
          material,
        );
        platform.name = 'bonus-spinner';
        platform.position.y = 0.24;
        group.add(platform);
        const marker = new THREE.Mesh(
          new THREE.TorusGeometry(2.2, 0.075, 7, 36),
          beaconMaterial,
        );
        marker.name = 'bonus-pulse';
        marker.rotation.x = Math.PI / 2;
        marker.position.y = 0.08;
        group.add(marker);
      } else {
        const goal = new THREE.Mesh(
          new THREE.TorusGeometry(2.15, 0.18, 9, 36),
          material,
        );
        goal.name = 'bonus-spinner';
        goal.position.y = 2.3;
        group.add(goal);
        const toy = new THREE.Mesh(
          new THREE.DodecahedronGeometry(0.65, 0),
          material,
        );
        toy.name = 'bonus-pulse';
        toy.position.set(0, 0.7, 0.3);
        group.add(toy);
      }

      addSecret(
        definition.id,
        'chaos-bonus',
        group,
        definition.east,
        definition.north,
        definition.altitude,
        definition.radius,
        definition,
      );
    });
  };

  createCampusSecrets();

  const flockBeaconMaterial = new THREE.MeshBasicMaterial({
    color: 0xffc75b,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
  });
  FLOCK_ROOSTS.forEach(([east, north], index) => {
    const rig = createGooseRig(true);
    rig.root.name = `Recruitable campus goose ${index + 1}`;
    rig.root.scale.setScalar(0.36);
    rig.root.visible = playing;
    const beacon = new THREE.Mesh(
      new THREE.TorusGeometry(1.45, 0.055, 7, 30),
      flockBeaconMaterial.clone(),
    );
    beacon.name = 'Flock recruitment ring';
    beacon.rotation.x = Math.PI / 2;
    beacon.visible = playing;
    const home = new THREE.Vector2(east, north);
    const elevation = terrainEnabled
      ? map.queryTerrainElevation(localToLngLat(east, north))
      : campusGroundFallback;
    const terrainResolved =
      !terrainEnabled || isUsableTerrainElevation(elevation);
    const ground =
      terrainResolved && typeof elevation === 'number'
        ? elevation
        : campusGroundFallback;
    rig.root.position.set(east, ground + 0.04, north);
    beacon.position.set(east, ground + 0.08, north);
    scene.add(rig.root, beacon);
    flockGeese.push({
      rig,
      beacon,
      home,
      position: rig.root.position.clone(),
      ground,
      terrainResolved,
      terrainSamplePosition: home.clone(),
      terrainRefreshRemaining: index * 0.045,
      recruited: false,
      phase: index * 1.37,
      waddlePhase: index * 1.37,
      waterContactLatched: false,
      waterContactReleaseTime: 0,
    });
  });

  const refreshFlockTerrain = (
    member: FlockGoose,
    east: number,
    north: number,
    force = false,
  ) => {
    if (!force && member.terrainRefreshRemaining > 0) return member.ground;
    member.terrainSamplePosition.set(east, north);
    if (!terrainEnabled) {
      member.ground = campusGroundFallback;
      member.terrainResolved = true;
      member.terrainRefreshRemaining = 0.5;
      return member.ground;
    }
    const elevation = map.queryTerrainElevation(localToLngLat(east, north));
    if (typeof elevation === 'number' && isUsableTerrainElevation(elevation)) {
      member.ground = elevation;
      member.terrainResolved = true;
      member.terrainRefreshRemaining = 1.05 + (member.phase % 0.42);
    } else {
      member.terrainRefreshRemaining = 0.48 + (member.phase % 0.22);
    }
    return member.ground;
  };

  const settleFlockRoosts = () => {
    flockGeese.forEach((member) => {
      if (member.recruited) return;
      let relocated = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const building = buildingColliders.find((candidate) =>
          pointInBuilding(member.home.x, member.home.y, candidate),
        );
        if (!building) break;
        const boundary = closestBuildingBoundary(
          member.home.x,
          member.home.y,
          building,
        );
        let outwardX = boundary.x - member.home.x;
        let outwardZ = boundary.z - member.home.y;
        const length = Math.hypot(outwardX, outwardZ) || 1;
        outwardX /= length;
        outwardZ /= length;
        member.home.set(
          boundary.x + outwardX * 2.4,
          boundary.z + outwardZ * 2.4,
        );
        relocated = true;
      }
      if (relocated)
        refreshFlockTerrain(member, member.home.x, member.home.y, true);
    });
  };

  const recruitFlockMember = (member: FlockGoose) => {
    if (member.recruited) return;
    member.recruited = true;
    member.beacon.visible = false;
    member.terrainRefreshRemaining = 0;
    member.waterContactLatched = false;
    member.waterContactReleaseTime = 0;
    recruitedFlockCount += 1;
    awardChaos(
      300,
      `FLOCK RECRUITED ${recruitedFlockCount}/${flockGeese.length}`,
    );
  };

  const recruitNearbyFlock = (fromHonk = false) => {
    const radius = fromHonk ? 14 : 3.2;
    let recruited = 0;
    for (const member of flockGeese) {
      if (member.recruited) continue;
      const horizontal = Math.hypot(
        state.position.x - member.home.x,
        state.position.z - member.home.y,
      );
      if (
        horizontal <= radius &&
        Math.abs(state.position.y - member.ground) <= (fromHonk ? 8 : 3.2)
      ) {
        recruitFlockMember(member);
        recruited += 1;
      }
    }
    return recruited;
  };

  const updateFlockVisuals = (dt: number, pose: SimState) => {
    const leaderForward = new THREE.Vector3(pose.forward.x, 0, pose.forward.z);
    if (leaderForward.lengthSq() < 0.001) {
      leaderForward.set(Math.sin(pose.heading), 0, Math.cos(pose.heading));
    }
    leaderForward.normalize();
    const leaderRight = new THREE.Vector3(leaderForward.z, 0, -leaderForward.x);
    const airborne = pose.mode === 'flying';
    let formationIndex = 0;
    if (recruitedFlockCount > 0) refreshActiveBuildingColliders();

    const keepOutsideBuildings = (point: THREE.Vector3, clearance: number) => {
      let moved = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const building = activeBuildingColliders.find((candidate) => {
          const roof = candidate.ground + candidate.height;
          return (
            point.y < roof - 0.01 &&
            point.y + 0.75 > candidate.ground &&
            point.x >= candidate.minX &&
            point.x <= candidate.maxX &&
            point.z >= candidate.minZ &&
            point.z <= candidate.maxZ &&
            pointInBuilding(point.x, point.z, candidate)
          );
        });
        if (!building) return moved;
        const boundary = closestBuildingBoundary(point.x, point.z, building);
        let outwardX = boundary.x - point.x;
        let outwardZ = boundary.z - point.z;
        const length = Math.hypot(outwardX, outwardZ) || 1;
        outwardX /= length;
        outwardZ /= length;
        point.x = boundary.x + outwardX * clearance;
        point.z = boundary.z + outwardZ * clearance;
        moved = true;
      }
      return moved;
    };

    flockGeese.forEach((member) => {
      member.terrainRefreshRemaining = Math.max(
        0,
        member.terrainRefreshRemaining - dt,
      );
      if (!member.recruited) {
        if (member.terrainRefreshRemaining <= 0) {
          refreshFlockTerrain(member, member.home.x, member.home.y);
        }
        member.position.set(
          member.home.x,
          member.ground +
            0.04 +
            Math.abs(Math.sin(elapsedTime * 2 + member.phase)) * 0.025,
          member.home.y,
        );
        member.rig.root.position.copy(member.position);
        member.rig.root.visible = playing && member.terrainResolved;
        member.rig.root.rotation.set(
          0,
          member.phase + Math.sin(elapsedTime * 0.45 + member.phase) * 0.35,
          0,
        );
        member.rig.legs.visible = true;
        member.rig.leftWing.scale.set(0.42, 1, 0.84);
        member.rig.rightWing.scale.set(0.42, 1, 0.84);
        member.rig.leftWing.rotation.z = -0.66;
        member.rig.rightWing.rotation.z = 0.66;
        setGooseLegStride(member.rig, 0);
        member.beacon.position.set(
          member.home.x,
          member.ground + 0.08,
          member.home.y,
        );
        member.beacon.scale.setScalar(
          1 + Math.sin(elapsedTime * 3.1 + member.phase) * 0.12,
        );
        member.beacon.rotation.z += dt * 0.22;
        member.beacon.visible = playing && member.terrainResolved;
        return;
      }

      const row = Math.floor(formationIndex / 2) + 1;
      const side = formationIndex % 2 === 0 ? -1 : 1;
      formationIndex += 1;
      const target = pose.position
        .clone()
        .addScaledVector(leaderForward, -row * (airborne ? 3.15 : 2.2))
        .addScaledVector(leaderRight, side * row * (airborne ? 2.55 : 1.6));
      if (airborne) {
        target.y = pose.position.y + 0.12 - row * 0.06;
        keepOutsideBuildings(target, 0.85);
      } else {
        target.y = member.ground + 0.04;
        refreshFlockTerrain(member, target.x, target.z);
        target.y = member.ground + 0.04;
        if (keepOutsideBuildings(target, 0.48)) {
          refreshFlockTerrain(member, target.x, target.z, true);
          target.y = member.ground + 0.04;
        }
      }
      if (member.position.distanceToSquared(target) > 55 * 55)
        member.position.copy(target);
      else
        member.position.lerp(
          target,
          1 - Math.exp(-(airborne ? 3.4 : 2.5) * dt),
        );
      const followerSpeed =
        dt > 0
          ? Math.hypot(
              member.position.x - member.rig.root.position.x,
              member.position.z - member.rig.root.position.z,
            ) / dt
          : 0;
      keepOutsideBuildings(member.position, airborne ? 0.85 : 0.48);
      member.rig.root.position.copy(member.position);

      if (airborne) {
        member.rig.root.quaternion.copy(goose.root.quaternion);
        member.rig.legs.visible = false;
        member.rig.leftWing.scale.set(1, 1, 1);
        member.rig.rightWing.scale.set(1, 1, 1);
        const flap = 0.12 - 0.46 * Math.cos(elapsedTime * 8.2 + member.phase);
        member.rig.leftWing.rotation.z = flap;
        member.rig.rightWing.rotation.z = -flap;
        setGooseLegStride(member.rig, 0);
        member.waterContactReleaseTime += dt;
        if (member.waterContactReleaseTime >= 0.18)
          member.waterContactLatched = false;
      } else {
        const followerOnWater =
          member.terrainResolved &&
          member.position.y <= member.ground + 0.35 &&
          isPointInMappedWater(member.position.x, member.position.z);
        const waddleAmount = smoothstep(0.08, 1.25, followerSpeed);
        if (!followerOnWater && dt > 0) {
          member.waddlePhase =
            (member.waddlePhase + Math.min(followerSpeed, 3.8) * 1.9 * dt) %
            (Math.PI * 2);
        }
        const waddle = followerOnWater
          ? 0
          : Math.sin(member.waddlePhase) * waddleAmount;
        if (!followerOnWater) {
          member.rig.root.position.y +=
            (0.5 - 0.5 * Math.cos(member.waddlePhase * 2)) *
            0.025 *
            waddleAmount;
        }
        member.rig.root.rotation.set(0, pose.heading, -waddle * 0.035);
        member.rig.legs.visible = !followerOnWater;
        setGooseLegStride(member.rig, waddle);
        member.rig.leftWing.scale.set(0.42, 1, 0.84);
        member.rig.rightWing.scale.set(0.42, 1, 0.84);
        member.rig.leftWing.rotation.z = -0.66;
        member.rig.rightWing.rotation.z = 0.66;

        if (followerOnWater) {
          member.waterContactReleaseTime = 0;
          if (!member.waterContactLatched) {
            spawnSplash(
              clamp(0.24 + followerSpeed / 14, 0.24, 0.72),
              member.position,
              member.ground,
            );
            member.waterContactLatched = true;
          }
        } else {
          member.waterContactReleaseTime += dt;
          if (member.waterContactReleaseTime >= 0.18)
            member.waterContactLatched = false;
        }
      }
    });
  };

  type CampusTreePoint = {
    id: number;
    local: THREE.Vector3;
    supplemental: boolean;
    scale: number;
  };

  const campusTreePoints: CampusTreePoint[] = WMU_TREE_POINTS.map(
    ([id, longitude, latitude]) => ({
      id,
      local: geoToLocal(longitude, latitude),
      supplemental: false,
      scale: 0.9 + Math.abs(Math.sin(Number(id % 1000000) * 0.0117)) * 0.22,
    }),
  );
  const mappedTreeCount = campusTreePoints.length;
  let treeCount = campusTreePoints.length;
  unresolvedTreeCount = terrainEnabled ? treeCount : 0;

  const treeTrunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.22, 0.3, 1, 6),
    new THREE.MeshStandardMaterial({
      color: 0x6b482c,
      roughness: 1,
      vertexColors: false,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1,
      depthTest: true,
      depthWrite: true,
    }),
    MAX_TREE_COUNT,
  );
  const treeCrowns = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({
      color: 0x3f7f3d,
      roughness: 0.96,
      vertexColors: false,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1,
      depthTest: true,
      depthWrite: true,
    }),
    MAX_TREE_COUNT * 3,
  );
  treeTrunks.count = treeCount;
  treeCrowns.count = treeCount * 3;
  treeTrunks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  treeCrowns.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  treeTrunks.frustumCulled = false;
  treeCrowns.frustumCulled = false;
  treeTrunks.visible = playing;
  treeCrowns.visible = playing;
  scene.add(treeTrunks, treeCrowns);

  const treeGrounds: Array<number | null> = campusTreePoints.map(() =>
    terrainEnabled ? null : campusGroundFallback,
  );
  const treeTerrainRefreshAt = campusTreePoints.map(() => 0);
  const treeDummy = new THREE.Object3D();
  let treeRefreshCursor = 0;
  let treeMatricesInitialized = false;
  let treeBlockerSignature = '';

  const distanceSquaredToRoute = (
    points: THREE.Vector3[],
    east: number,
    north: number,
  ) => {
    let nearest = Number.POSITIVE_INFINITY;
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      const segmentX = end.x - start.x;
      const segmentZ = end.z - start.z;
      const lengthSquared = segmentX * segmentX + segmentZ * segmentZ;
      const amount =
        lengthSquared > 0.0001
          ? clamp(
              ((east - start.x) * segmentX + (north - start.z) * segmentZ) /
                lengthSquared,
              0,
              1,
            )
          : 0;
      const deltaX = start.x + segmentX * amount - east;
      const deltaZ = start.z + segmentZ * amount - north;
      nearest = Math.min(nearest, deltaX * deltaX + deltaZ * deltaZ);
    }
    return nearest;
  };
  const nearMappedCorridor = (east: number, north: number) =>
    trafficRoutes.some((route) => {
      const clearance = route.laneWidth + 2.8;
      return (
        distanceSquaredToRoute(route.points, east, north) <
        clearance * clearance
      );
    }) ||
    pedestrianRoutes.some((route) => {
      const clearance = (route.sidewalkOffset ?? 0) + 2.1;
      return (
        distanceSquaredToRoute(route.points, east, north) <
        clearance * clearance
      );
    });

  const treePlacementBlocked = (index: number) => {
    const tree = campusTreePoints[index];
    const { x, z } = tree.local;
    if (isPointInMappedWater(x, z)) return true;
    if (nearMappedCorridor(x, z)) return true;
    return buildingColliders.some(
      (building) =>
        x >= building.minX &&
        x <= building.maxX &&
        z >= building.minZ &&
        z <= building.maxZ &&
        pointInBuilding(x, z, building),
    );
  };

  const writeTreeInstances = (index: number) => {
    const tree = campusTreePoints[index];
    const point = tree.local;
    const ground = treeGrounds[index];
    const random = Math.abs(Math.sin(Number(tree.id % 1000000) * 0.0173));
    const height = (6.4 + random * 4.8) * tree.scale;
    const crownRadius = (2.1 + random * 1.3) * tree.scale;

    if (ground === null || treePlacementBlocked(index)) {
      treeDummy.position.set(point.x, campusGroundFallback, point.z);
      treeDummy.scale.setScalar(0);
      treeDummy.updateMatrix();
      treeTrunks.setMatrixAt(index, treeDummy.matrix);
      for (let lobe = 0; lobe < 3; lobe += 1) {
        treeCrowns.setMatrixAt(index * 3 + lobe, treeDummy.matrix);
      }
      return;
    }

    treeDummy.position.set(point.x, ground + height * 0.42 + 0.08, point.z);
    treeDummy.scale.set(
      0.72 + random * 0.26,
      height * 0.84,
      0.72 + random * 0.26,
    );
    treeDummy.rotation.y = random * Math.PI;
    treeDummy.updateMatrix();
    treeTrunks.setMatrixAt(index, treeDummy.matrix);
    for (let lobe = 0; lobe < 3; lobe += 1) {
      const crownIndex = index * 3 + lobe;
      const angle = random * Math.PI * 2 + lobe * ((Math.PI * 2) / 3);
      const offset = lobe === 0 ? 0 : crownRadius * 0.5;
      const lobeScale = lobe === 0 ? 1 : 0.76;
      treeDummy.position.set(
        point.x + Math.cos(angle) * offset,
        ground + height - (lobe === 0 ? 0 : crownRadius * 0.18),
        point.z + Math.sin(angle) * offset,
      );
      treeDummy.scale.set(
        crownRadius * lobeScale,
        crownRadius * (lobe === 0 ? 1.18 : 0.82),
        crownRadius * lobeScale,
      );
      treeDummy.rotation.y = angle;
      treeDummy.updateMatrix();
      treeCrowns.setMatrixAt(crownIndex, treeDummy.matrix);
    }
  };

  const updateTrees = (nearPlayerOnly = false) => {
    let changed = false;
    const changedIndices = new Set<number>();
    const terrainQueryBudget = terrainEnabled
      ? coarsePointer
        ? nearPlayerOnly
          ? 16
          : 30
        : nearPlayerOnly
          ? 24
          : 42
      : 0;
    let queries = 0;
    let scanned = 0;
    const startCursor = treeRefreshCursor;
    while (scanned < treeCount && queries < terrainQueryBudget) {
      const index = (startCursor + scanned) % treeCount;
      const tree = campusTreePoints[index];
      const point = tree.local;
      const distanceFromPlayer = Math.hypot(
        point.x - state.position.x,
        point.z - state.position.z,
      );
      scanned += 1;
      if (
        terrainEnabled &&
        !treePlacementBlocked(index) &&
        (!nearPlayerOnly || distanceFromPlayer < 650) &&
        elapsedTime >= treeTerrainRefreshAt[index]
      ) {
        queries += 1;
        const elevation = map.queryTerrainElevation(
          localToLngLat(point.x, point.z),
        );
        const terrainReady = isUsableTerrainElevation(elevation);
        const randomRefresh = Math.abs(
          Math.sin(Number(tree.id % 1000000) * 0.0091),
        );
        treeTerrainRefreshAt[index] =
          elapsedTime + (terrainReady ? 4.4 + randomRefresh * 2.2 : 0.55);
        if (terrainReady && typeof elevation === 'number') {
          const groundChanged =
            treeGrounds[index] === null ||
            Math.abs((treeGrounds[index] ?? elevation) - elevation) > 0.05;
          if (groundChanged) {
            changed = true;
            changedIndices.add(index);
          }
          treeGrounds[index] = elevation;
        }
      }
    }
    treeRefreshCursor =
      (startCursor + (scanned === treeCount ? 1 : Math.max(1, scanned))) %
      treeCount;

    if (!treeMatricesInitialized) {
      campusTreePoints.forEach((_, index) => writeTreeInstances(index));
      treeMatricesInitialized = true;
      changed = true;
    } else {
      changedIndices.forEach((index) => writeTreeInstances(index));
    }
    unresolvedTreeCount = 0;
    campusTreePoints.forEach((_, index) => {
      if (treeGrounds[index] === null || treePlacementBlocked(index))
        unresolvedTreeCount += 1;
    });
    if (changed) {
      treeTrunks.instanceMatrix.needsUpdate = true;
      treeCrowns.instanceMatrix.needsUpdate = true;
    }
    return changed;
  };

  const woodlandTreeKeys = new Set<string>();
  const collectMappedWoodlandTrees = () => {
    if (
      !landcoverSourceId ||
      !map.getSource(landcoverSourceId) ||
      trafficRoutes.length === 0 ||
      pedestrianRoutes.length === 0 ||
      treeCount >= MAX_TREE_COUNT
    )
      return false;
    const features = map.querySourceFeatures(landcoverSourceId, {
      sourceLayer: 'landcover',
    }) as Array<{
      properties?: Record<string, unknown>;
      geometry: { type: string; coordinates: unknown };
    }>;
    const spacing = coarsePointer ? 15.5 : 13.5;
    const candidates = new Map<string, CampusTreePoint>();
    const mappedTrees = campusTreePoints.slice(0, mappedTreeCount);

    features.forEach((feature) => {
      if (feature.properties?.class !== 'wood') return;
      const polygonSets =
        feature.geometry.type === 'Polygon'
          ? [feature.geometry.coordinates as number[][][]]
          : feature.geometry.type === 'MultiPolygon'
            ? (feature.geometry.coordinates as number[][][][])
            : [];
      polygonSets.forEach((rings) => {
        const outer = (rings[0] ?? [])
          .filter((coordinate) => coordinate.length >= 2)
          .map(([longitude, latitude]) => geoToLocal(longitude, latitude))
          .slice(0, -1)
          .map((point) => new THREE.Vector2(point.x, point.z));
        if (outer.length < 3) return;
        const holes = rings
          .slice(1)
          .map((ring) =>
            ring
              .filter((coordinate) => coordinate.length >= 2)
              .map(([longitude, latitude]) => geoToLocal(longitude, latitude))
              .slice(0, -1)
              .map((point) => new THREE.Vector2(point.x, point.z)),
          )
          .filter((ring) => ring.length >= 3);
        const minX = Math.max(
          -1400,
          Math.min(...outer.map((point) => point.x)),
        );
        const maxX = Math.min(1400, Math.max(...outer.map((point) => point.x)));
        const minZ = Math.max(
          -1400,
          Math.min(...outer.map((point) => point.y)),
        );
        const maxZ = Math.min(1400, Math.max(...outer.map((point) => point.y)));
        if (maxX <= minX || maxZ <= minZ) return;
        const firstCellX = Math.floor(minX / spacing);
        const lastCellX = Math.ceil(maxX / spacing);
        const firstCellZ = Math.floor(minZ / spacing);
        const lastCellZ = Math.ceil(maxZ / spacing);
        for (let cellZ = firstCellZ; cellZ <= lastCellZ; cellZ += 1) {
          for (let cellX = firstCellX; cellX <= lastCellX; cellX += 1) {
            const key = `${cellX}:${cellZ}`;
            if (woodlandTreeKeys.has(key) || candidates.has(key)) continue;
            const hash =
              Math.sin(cellX * 12.9898 + cellZ * 78.233) * 43758.5453;
            const unit = hash - Math.floor(hash);
            const secondHash =
              Math.sin(cellX * 39.3467 - cellZ * 11.135) * 24634.6345;
            const secondUnit = secondHash - Math.floor(secondHash);
            const east = (cellX + 0.5) * spacing + (unit - 0.5) * 4.8;
            const north = (cellZ + 0.5) * spacing + (secondUnit - 0.5) * 4.8;
            if (
              !pointInRing(east, north, outer) ||
              holes.some((hole) => pointInRing(east, north, hole)) ||
              nearMappedCorridor(east, north) ||
              mappedTrees.some(
                (tree) =>
                  Math.hypot(tree.local.x - east, tree.local.z - north) < 6,
              )
            )
              continue;
            candidates.set(key, {
              id:
                9_900_000_000 +
                Math.abs(cellX * 73_856_093 + cellZ * 19_349_663),
              local: new THREE.Vector3(east, 0, north),
              supplemental: true,
              scale: 0.76 + unit * 0.25,
            });
          }
        }
      });
    });

    const sortedCandidates = [...candidates.entries()].sort(
      ([, first], [, second]) =>
        first.local.lengthSq() - second.local.lengthSq(),
    );
    const firstNewIndex = treeCount;
    for (const [key, tree] of sortedCandidates) {
      if (campusTreePoints.length >= MAX_TREE_COUNT) break;
      woodlandTreeKeys.add(key);
      campusTreePoints.push(tree);
      treeGrounds.push(terrainEnabled ? null : campusGroundFallback);
      treeTerrainRefreshAt.push(0);
    }
    if (campusTreePoints.length === firstNewIndex) return false;
    treeCount = campusTreePoints.length;
    treeTrunks.count = treeCount;
    treeCrowns.count = treeCount * 3;
    for (let index = firstNewIndex; index < treeCount; index += 1) {
      writeTreeInstances(index);
    }
    treeRefreshCursor = firstNewIndex;
    updateTrees(false);
    treeTrunks.instanceMatrix.needsUpdate = true;
    treeCrowns.instanceMatrix.needsUpdate = true;
    return true;
  };

  const refreshTreePlacementMask = () => {
    const signature = `${mappedWaterAreas.length}:${buildingColliders.length}:${trafficRoutes.length}:${pedestrianRoutes.length}:${treeCount}`;
    if (signature === treeBlockerSignature) return false;
    treeBlockerSignature = signature;
    if (!treeMatricesInitialized) return false;
    campusTreePoints.forEach((_, index) => writeTreeInstances(index));
    treeTrunks.instanceMatrix.needsUpdate = true;
    treeCrowns.instanceMatrix.needsUpdate = true;
    return true;
  };

  updateTrees();

  const setGameplayVisibility = (visible: boolean) => {
    goose.root.visible = visible;
    trafficFleet.bodies.visible = visible;
    trafficFleet.cabins.visible = visible;
    trafficFleet.wheels.visible = visible;
    crowdFleet.heads.visible = visible;
    crowdFleet.torsos.visible = visible;
    crowdFleet.leftArms.visible = visible;
    crowdFleet.rightArms.visible = visible;
    crowdFleet.leftLegs.visible = visible;
    crowdFleet.rightLegs.visible = visible;
    treeTrunks.visible = visible;
    treeCrowns.visible = visible;
    cloudPuffs.visible = visible && cloudBaseResolved;
    texturedBuildingGroup.visible = visible;
    campusSecrets.forEach((secret) => {
      secret.group.visible = visible && secret.terrainResolved;
    });
    flockGeese.forEach((member) => {
      member.rig.root.visible = visible && member.terrainResolved;
      member.beacon.visible =
        visible && member.terrainResolved && !member.recruited;
    });
  };

  const highestRoofAt = (
    east: number,
    north: number,
    maximumRoof = Infinity,
  ) => {
    refreshActiveBuildingColliders();
    let roof: number | null = null;
    for (const building of activeBuildingColliders) {
      if (
        east < building.minX ||
        east > building.maxX ||
        north < building.minZ ||
        north > building.maxZ ||
        !pointInBuilding(east, north, building)
      )
        continue;
      const candidate = building.ground + building.height;
      if (candidate <= maximumRoof && (roof === null || candidate > roof))
        roof = candidate;
    }
    return roof;
  };

  const sampleSurface = () => {
    const location = localToLngLat(state.position.x, state.position.z);
    const elevation = map.queryTerrainElevation(location);
    if (typeof elevation === 'number' && isUsableTerrainElevation(elevation)) {
      const previousFallback = campusGroundFallback;
      const previousTerrain = terrainSurfaceY;
      const lateTerrainDelta = elevation - previousTerrain;
      const wasUsingTerrainSurface =
        Math.abs(state.ground - previousTerrain) < 1.5;
      if (
        state.mode === 'flying' &&
        wasUsingTerrainSurface &&
        Math.abs(lateTerrainDelta) > 25
      ) {
        // Preserve altitude above ground when the DEM resolves after gameplay
        // initialization instead of teleporting the surface up through the goose.
        state.position.y += lateTerrainDelta;
        previousState.position.y += lateTerrainDelta;
        renderState.position.y += lateTerrainDelta;
        cameraPosition.y += lateTerrainDelta;
        cameraTarget.y += lateTerrainDelta;
        state.ground += lateTerrainDelta;
      }
      terrainSurfaceY = elevation;
      if (!cloudBaseResolved) {
        cloudBaseElevation = elevation;
        cloudBaseResolved = true;
        cloudRefreshClock = 0;
      }
      campusGroundResolved = true;
      campusGroundFallback = elevation;
      if (Math.abs(elevation - previousFallback) > 3) {
        buildingRefreshRequested = true;
        treeRefreshClock = Math.min(treeRefreshClock, 0.12);
        campusSecrets.forEach((secret, index) => {
          secret.terrainRefreshRemaining = Math.min(
            secret.terrainRefreshRemaining,
            0.08 + (index % 8) * 0.06,
          );
        });
        flockGeese.forEach((member, index) => {
          member.terrainRefreshRemaining = Math.min(
            member.terrainRefreshRemaining,
            0.06 + index * 0.055,
          );
        });
      }
    }
    const terrainGround = terrainSurfaceY;
    const roof = highestRoofAt(
      state.position.x,
      state.position.z,
      state.position.y + 0.12,
    );
    const nextGround =
      roof === null ? terrainGround : Math.max(terrainGround, roof);
    const walkedOffDrop =
      state.mode === 'waddling' &&
      state.ground - nextGround > 0.8 &&
      state.position.y > nextGround + 0.8;
    state.ground = nextGround;
    if (walkedOffDrop) {
      state.mode = 'flying';
      state.velocity.y = Math.min(state.velocity.y, -0.5);
      airborneTime = 0;
      peakAgl = 0;
    }
    if (roof !== null) {
      state.onWater = false;
    } else if (waterLayers.length > 0) {
      const point = map.project(location);
      const canvas = map.getCanvas();
      if (
        point.x >= 0 &&
        point.y >= 0 &&
        point.x <= canvas.clientWidth &&
        point.y <= canvas.clientHeight
      ) {
        state.onWater =
          map.queryRenderedFeatures(point, { layers: waterLayers }).length > 0;
      } else {
        state.onWater = false;
      }
    } else {
      state.onWater = false;
    }
  };

  const spawnSplash = (
    strength: number,
    position = state.position,
    surfaceY = state.ground,
  ) => {
    const group = new THREE.Group();
    group.position.set(position.x, surfaceY + 0.18, position.z);
    const rings: Splash['rings'] = [];
    for (let index = 0; index < 3; index += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: index === 0 ? 0xf4fbf7 : 0x83d6df,
        transparent: true,
        opacity: 0.8 - index * 0.13,
        depthTest: true,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.55 + index * 0.22, 0.055, 6, 28),
        material,
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = index * 0.035;
      rings.push(ring);
      group.add(ring);
    }
    const drops: Splash['drops'] = [];
    for (let index = 0; index < 12; index += 1) {
      const angle = (index / 12) * Math.PI * 2;
      const material = new THREE.MeshBasicMaterial({
        color: index % 3 === 0 ? 0xf5ffff : 0x8edbe2,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.08 + (index % 3) * 0.02, 6, 5),
        material,
      );
      const velocity = new THREE.Vector3(
        Math.cos(angle) * (2.4 + strength * 2.5),
        3.1 + strength * 3.4 + (index % 4) * 0.25,
        Math.sin(angle) * (2.4 + strength * 2.5),
      );
      drops.push({ mesh, velocity });
      group.add(mesh);
    }
    group.traverse((object) => {
      object.frustumCulled = false;
    });
    scene.add(group);
    splashes.push({ group, age: 0, life: 1.35, rings, drops });
  };

  const spawnSkimSpray = (speed: number) => {
    const group = new THREE.Group();
    const forward = new THREE.Vector3(state.velocity.x, 0, state.velocity.z);
    if (forward.lengthSq() < 0.01)
      forward.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    forward.normalize();
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    group.position
      .copy(state.position)
      .addScaledVector(forward, -0.48)
      .addScaledVector(UP, -0.04);
    const drops: Splash['drops'] = [];
    for (let index = 0; index < 6; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const material = new THREE.MeshBasicMaterial({
        color: index < 2 ? 0xf4ffff : 0x91dce4,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.045 + (index % 3) * 0.018, 5, 4),
        material,
      );
      mesh.position.addScaledVector(right, side * (0.18 + (index % 3) * 0.11));
      const velocity = right
        .clone()
        .multiplyScalar(side * (1.1 + speed * 0.07 + (index % 3) * 0.34))
        .addScaledVector(forward, -0.7 - (index % 2) * 0.35)
        .addScaledVector(UP, 1.2 + speed * 0.075 + (index % 3) * 0.2);
      drops.push({ mesh, velocity });
      group.add(mesh);
    }
    group.traverse((object) => {
      object.frustumCulled = false;
    });
    scene.add(group);
    splashes.push({ group, age: 0, life: 0.62, rings: [], drops });
  };

  const updateSplashes = (dt: number) => {
    for (let index = splashes.length - 1; index >= 0; index -= 1) {
      const splash = splashes[index];
      splash.age += dt;
      const life = clamp(splash.age / splash.life, 0, 1);
      splash.rings.forEach((ring, ringIndex) => {
        const scale = 1 + life * (3.2 + ringIndex * 0.8);
        ring.scale.setScalar(scale);
        ring.material.opacity = (0.78 - ringIndex * 0.13) * (1 - life);
      });
      splash.drops.forEach((drop) => {
        drop.velocity.y -= FLIGHT.gravity * dt;
        drop.mesh.position.addScaledVector(drop.velocity, dt);
        drop.mesh.material.opacity = 1 - life;
      });
      if (splash.age >= splash.life) {
        scene.remove(splash.group);
        splash.group.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.geometry.dispose();
            if (object.material instanceof THREE.Material)
              object.material.dispose();
          }
        });
        splashes.splice(index, 1);
      }
    }
  };

  const buildTraffic = () => {
    if (trafficBuilt || !map.getSource(roadSourceId)) return;
    const allowed = new Set([
      'motorway',
      'trunk',
      'primary',
      'secondary',
      'tertiary',
      'minor',
      'service',
    ]);
    const cruiseByClass: Record<string, number> = {
      motorway: 13,
      trunk: 11.5,
      primary: 10.5,
      secondary: 9,
      tertiary: 8,
      minor: 6.7,
      service: 4.7,
    };
    const features = map.querySourceFeatures(roadSourceId, {
      sourceLayer: 'transportation',
    }) as Array<{
      properties?: Record<string, unknown>;
      geometry: { type: string; coordinates: unknown };
    }>;
    const routes: Route[] = [];
    const seen = new Set<string>();

    const acceptLine = (coordinates: number[][], roadClass: string) => {
      if (coordinates.length < 2) return;
      const points = coordinates
        .filter((coordinate) => coordinate.length >= 2)
        .map(([longitude, latitude]) => geoToLocal(longitude, latitude))
        .filter((point) => Math.hypot(point.x, point.z) < 1400);
      if (points.length < 2) return;
      const endpoints = [
        `${points[0].x.toFixed(0)}:${points[0].z.toFixed(0)}`,
        `${points.at(-1)?.x.toFixed(0)}:${points.at(-1)?.z.toFixed(0)}`,
      ].sort();
      const key = endpoints.join('|');
      if (seen.has(key)) return;
      seen.add(key);
      const route = routeFromPoints(
        points,
        cruiseByClass[roadClass] ?? 6.7,
        roadClass === 'service' ? 0.95 : 1.4,
      );
      if (route.total >= 45) routes.push(route);
    };

    features.forEach((feature) => {
      const classValue =
        feature.properties?.class ?? feature.properties?.subclass;
      const roadClass = typeof classValue === 'string' ? classValue : '';
      if (
        !allowed.has(roadClass) ||
        feature.properties?.brunnel === 'tunnel' ||
        feature.properties?.brunnel === 'bridge'
      )
        return;
      if (feature.geometry.type === 'LineString')
        acceptLine(feature.geometry.coordinates as number[][], roadClass);
      if (feature.geometry.type === 'MultiLineString') {
        (feature.geometry.coordinates as number[][][]).forEach((line) =>
          acceptLine(line, roadClass),
        );
      }
    });

    routes.sort((a, b) => b.total - a.total);
    if (routes.length === 0) return;
    trafficRoutes.push(...routes.slice(0, 24));
    const colors = [
      0xc94b43, 0xe5ae39, 0x3d6f9f, 0xe8e4d6, 0x5a7358, 0x8b5a88, 0x33383c,
      0xd47a36,
    ];
    const activeRoutes = Math.min(routes.length, 20);
    const count = Math.min(MAX_TRAFFIC, Math.max(20, activeRoutes * 2));
    for (let index = 0; index < count; index += 1) {
      const route = routes[index % activeRoutes];
      const directionSign = (index % 2 === 0 ? 1 : -1) as -1 | 1;
      const distance = route.total * ((index * 0.61803398875 + 0.11) % 1);
      const sample = sampleRoute(route, distance);
      const direction = sample.direction.multiplyScalar(directionSign);
      const right = new THREE.Vector3(direction.z, 0, -direction.x);
      const position = sample.position.addScaledVector(right, route.laneWidth);
      const ground = terrainAt(position.x, position.z, state.ground);
      position.y = ground + 0.04;
      trafficFleet.bodies.setColorAt(
        index,
        new THREE.Color(colors[index % colors.length]),
      );
      traffic.push({
        index,
        route,
        distance,
        directionSign,
        laneOffset: route.laneWidth,
        speed: route.cruise * (0.83 + (index % 5) * 0.035),
        cruise: route.cruise * (0.93 + (index % 4) * 0.035),
        ground,
        targetGround: ground,
        elevationTimer: index * 0.02,
        stopped: false,
        position: position.clone(),
        previousPosition: position.clone(),
        direction: direction.clone(),
        previousDirection: direction.clone(),
        reactionRemaining: 0,
        honkScoreCooldown: 0,
        collisionCooldown: 0,
        nearMissCooldown: 0,
        wobbleRemaining: 0,
      });
    }
    trafficFleet.bodies.count = count;
    trafficFleet.cabins.count = count;
    trafficFleet.wheels.count = count * 4;
    if (trafficFleet.bodies.instanceColor)
      trafficFleet.bodies.instanceColor.needsUpdate = true;
    trafficBuilt = true;
  };

  const addGuaranteedCampusWalkways = () => {
    if (guaranteedPedestrianRouteCount > 0) return 0;
    // These short paths sit on the open lawn around the WMU spawn. They guarantee
    // a busy, visible campus even while vector/terrain tiles are still arriving.
    const localWalkways = [
      [
        [-50, -5],
        [-24, -3],
        [0, 0],
        [24, 4],
        [50, 8],
      ],
      [
        [-47, -27],
        [-22, -18],
        [2, -16],
        [25, -21],
        [47, -14],
      ],
      [
        [-44, 25],
        [-19, 19],
        [5, 21],
        [27, 29],
        [46, 24],
      ],
      [
        [-31, -42],
        [-27, -18],
        [-25, 5],
        [-31, 28],
        [-25, 44],
      ],
      [
        [-5, -46],
        [-4, -22],
        [0, 0],
        [4, 23],
        [7, 46],
      ],
      [
        [29, -42],
        [25, -19],
        [27, 3],
        [34, 25],
        [29, 43],
      ],
      [
        [-43, -35],
        [-21, -17],
        [0, 1],
        [22, 19],
        [43, 36],
      ],
      [
        [-43, 36],
        [-20, 18],
        [1, 0],
        [22, -18],
        [44, -34],
      ],
      [
        [-52, 10],
        [-29, 14],
        [-4, 12],
        [22, 10],
        [50, 15],
      ],
      [
        [-14, -47],
        [-11, -23],
        [-9, 1],
        [-13, 24],
        [-10, 47],
      ],
      [
        [14, -47],
        [12, -23],
        [10, 1],
        [14, 24],
        [11, 47],
      ],
      [
        [-51, -16],
        [-28, -10],
        [-2, -8],
        [24, -6],
        [49, -10],
      ],
    ];
    localWalkways.forEach((line, index) => {
      const basePoints = line.map(
        ([east, north]) =>
          new THREE.Vector3(east * 0.64, campusGroundFallback, north * 0.64),
      );
      guaranteedWalkwayBases.push(basePoints.map((point) => point.clone()));
      const baseRoute = routeFromPoints(basePoints);
      pedestrianRouteKeys.add(`campus-lawn:${index}`);
      pedestrianRoutes.push({
        points: baseRoute.points,
        cumulative: baseRoute.cumulative,
        total: baseRoute.total,
        sidewalkOffset: 0.25,
        isMappedWalkway: false,
      });
      dryMappedWalkwayCacheDirty = true;
    });
    guaranteedPedestrianRouteCount = localWalkways.length;
    return localWalkways.length;
  };

  const getMappedPedestrianWalkways = () => {
    if (dryMappedWalkwayCacheDirty) {
      dryMappedWalkwayCache = pedestrianRoutes
        .slice(guaranteedPedestrianRouteCount)
        .filter(
          (route) =>
            route.isMappedWalkway && !crowdRouteTouchesMappedWater(route),
        );
      dryMappedWalkwayCacheDirty = false;
    }
    return dryMappedWalkwayCache;
  };

  const nearestDistanceOnCrowdRoute = (
    route: CrowdRoute,
    east: number,
    north: number,
  ) => {
    let nearestDistance = 0;
    let nearestDistanceSquared = Number.POSITIVE_INFINITY;
    for (let index = 1; index < route.points.length; index += 1) {
      const start = route.points[index - 1];
      const end = route.points[index];
      const segmentX = end.x - start.x;
      const segmentZ = end.z - start.z;
      const segmentLengthSquared = segmentX * segmentX + segmentZ * segmentZ;
      const amount =
        segmentLengthSquared > 0.0001
          ? clamp(
              ((east - start.x) * segmentX + (north - start.z) * segmentZ) /
                segmentLengthSquared,
              0,
              1,
            )
          : 0;
      const candidateX = start.x + segmentX * amount;
      const candidateZ = start.z + segmentZ * amount;
      const distanceSquared =
        (candidateX - east) * (candidateX - east) +
        (candidateZ - north) * (candidateZ - north);
      if (distanceSquared >= nearestDistanceSquared) continue;
      nearestDistanceSquared = distanceSquared;
      nearestDistance = lerp(
        route.cumulative[index - 1],
        route.cumulative[index],
        amount,
      );
    }
    return {
      distance: nearestDistance,
      distanceSquared: nearestDistanceSquared,
    };
  };

  const assignNearbyCrowdToMappedWalkways = (
    mappedWalkways: CrowdRoute[],
    focusX: number,
    focusZ: number,
  ) => {
    const nearbyCount = Math.min(NEAR_SPAWN_CROWD_COUNT, campusNpcs.length);
    if (mappedWalkways.length === 0 || nearbyCount === 0) return false;
    const nearestRoutes = mappedWalkways
      .map((route) => ({
        route,
        ...nearestDistanceOnCrowdRoute(route, focusX, focusZ),
      }))
      .sort((a, b) => a.distanceSquared - b.distanceSquared)
      .slice(0, Math.min(6, mappedWalkways.length));
    for (let index = 0; index < nearbyCount; index += 1) {
      const candidate = nearestRoutes[index % nearestRoutes.length];
      const row = Math.floor(index / nearestRoutes.length);
      const side = (index + row) % 2 === 0 ? -1 : 1;
      const distance = clamp(
        candidate.distance + side * (6 + row * 5.5),
        0,
        candidate.route.total,
      );
      campusNpcs[index] = createCampusNpc(
        index,
        candidate.route,
        distance,
        npcTerrainAt,
      );
    }
    return true;
  };

  const positionGuaranteedWalkways = (anchorX: number, anchorZ: number) => {
    crowdAnchor.set(anchorX, anchorZ);
    for (
      let routeIndex = 0;
      routeIndex < guaranteedPedestrianRouteCount;
      routeIndex += 1
    ) {
      const route = pedestrianRoutes[routeIndex];
      const basePoints = guaranteedWalkwayBases[routeIndex];
      route.points.forEach((point, pointIndex) => {
        point.set(
          basePoints[pointIndex].x + anchorX,
          campusGroundFallback,
          basePoints[pointIndex].z + anchorZ,
        );
      });
    }
  };

  const collectPedestrianRoutes = () => {
    let added = addGuaranteedCampusWalkways();
    let npcAssignmentsChanged = false;
    const features =
      map.getSource(roadSourceId) && pedestrianRoutes.length < 80
        ? (map.querySourceFeatures(roadSourceId, {
            sourceLayer: 'transportation',
          }) as Array<{
            properties?: Record<string, unknown>;
            geometry: { type: string; coordinates: unknown };
          }>)
        : [];

    const acceptLine = (
      coordinates: number[][],
      isDedicatedWalkway: boolean,
    ) => {
      if (coordinates.length < 2 || pedestrianRoutes.length >= 80) return;
      const points = coordinates
        .filter((coordinate) => coordinate.length >= 2)
        .map(([longitude, latitude]) => geoToLocal(longitude, latitude))
        .filter((point) => Math.hypot(point.x, point.z) < 1200);
      if (points.length < 2) return;
      const endpoints = [
        `${points[0].x.toFixed(0)}:${points[0].z.toFixed(0)}`,
        `${points.at(-1)?.x.toFixed(0)}:${points.at(-1)?.z.toFixed(0)}`,
      ].sort();
      const key = endpoints.join('|');
      if (pedestrianRouteKeys.has(key)) return;
      const route = routeFromPoints(points);
      if (route.total < 14) return;
      const crowdRoute: CrowdRoute = {
        points: route.points,
        cumulative: route.cumulative,
        total: route.total,
        sidewalkOffset: isDedicatedWalkway ? 0.16 : 1.7,
        isMappedWalkway: isDedicatedWalkway,
      };
      if (crowdRouteTouchesMappedWater(crowdRoute)) return;
      pedestrianRouteKeys.add(key);
      pedestrianRoutes.push(crowdRoute);
      dryMappedWalkwayCacheDirty = true;
      added += 1;
    };

    const isDedicatedFeature = (feature: (typeof features)[number]) => {
      const roadClass =
        typeof feature.properties?.class === 'string'
          ? feature.properties.class
          : '';
      const subclass =
        typeof feature.properties?.subclass === 'string'
          ? feature.properties.subclass
          : '';
      return (
        DEDICATED_WALKWAY_CLASSES.has(roadClass) ||
        DEDICATED_WALKWAY_CLASSES.has(subclass)
      );
    };
    features.sort(
      (a, b) => Number(isDedicatedFeature(b)) - Number(isDedicatedFeature(a)),
    );
    features.forEach((feature) => {
      const roadClass =
        typeof feature.properties?.class === 'string'
          ? feature.properties.class
          : '';
      const subclass =
        typeof feature.properties?.subclass === 'string'
          ? feature.properties.subclass
          : '';
      if (
        (!PEDESTRIAN_ROUTE_CLASSES.has(roadClass) &&
          !PEDESTRIAN_ROUTE_CLASSES.has(subclass)) ||
        feature.properties?.brunnel === 'tunnel' ||
        feature.properties?.brunnel === 'bridge'
      )
        return;
      const isDedicatedWalkway = isDedicatedFeature(feature);
      if (feature.geometry.type === 'LineString') {
        acceptLine(
          feature.geometry.coordinates as number[][],
          isDedicatedWalkway,
        );
      }
      if (feature.geometry.type === 'MultiLineString') {
        (feature.geometry.coordinates as number[][][]).forEach((line) =>
          acceptLine(line, isDedicatedWalkway),
        );
      }
    });

    trafficRoutes.forEach((route, index) => {
      if (pedestrianRoutes.length >= 48) return;
      const key = `roadside:${index}:${route.points[0].x.toFixed(0)}:${route.points[0].z.toFixed(0)}`;
      if (pedestrianRouteKeys.has(key)) return;
      const crowdRoute: CrowdRoute = {
        points: route.points,
        cumulative: route.cumulative,
        total: route.total,
        sidewalkOffset: route.laneWidth + 1.15,
        isMappedWalkway: false,
      };
      if (crowdRouteTouchesMappedWater(crowdRoute)) return;
      pedestrianRouteKeys.add(key);
      pedestrianRoutes.push(crowdRoute);
      dryMappedWalkwayCacheDirty = true;
      added += 1;
    });

    const targetCount =
      guaranteedPedestrianRouteCount > 0 ? MAX_CAMPUS_NPCS : 0;
    while (campusNpcs.length < targetCount) {
      const index = campusNpcs.length;
      const useNearbyRoute =
        index < NEAR_SPAWN_CROWD_COUNT ||
        pedestrianRoutes.length === guaranteedPedestrianRouteCount;
      const route = useNearbyRoute
        ? pedestrianRoutes[index % guaranteedPedestrianRouteCount]
        : pedestrianRoutes[
            guaranteedPedestrianRouteCount +
              ((index - NEAR_SPAWN_CROWD_COUNT) %
                (pedestrianRoutes.length - guaranteedPedestrianRouteCount))
          ];
      const routeFraction =
        index === 0 ? 0.5 : 0.06 + ((index * 0.61803398875 + 0.17) % 1) * 0.88;
      campusNpcs.push(
        createCampusNpc(
          index,
          route,
          route.total * routeFraction,
          npcTerrainAt,
        ),
      );
      npcAssignmentsChanged = true;
    }

    const mappedWalkways = getMappedPedestrianWalkways();
    const mappedWalkwaySignature = mappedWalkways
      .map((route) => pedestrianRoutes.indexOf(route))
      .join(':');
    if (
      mappedWalkways.length > 0 &&
      mappedWalkwaySignature !== mappedCrowdWalkwaySignature
    ) {
      for (
        let index = NEAR_SPAWN_CROWD_COUNT;
        index < campusNpcs.length;
        index += 1
      ) {
        const route =
          mappedWalkways[
            (index - NEAR_SPAWN_CROWD_COUNT) % mappedWalkways.length
          ];
        const distance =
          route.total * (0.06 + ((index * 0.61803398875 + 0.17) % 1) * 0.88);
        campusNpcs[index] = createCampusNpc(
          index,
          route,
          distance,
          npcTerrainAt,
        );
      }
      const crowdFocusX = state.position.x + state.forward.x * 12;
      const crowdFocusZ = state.position.z + state.forward.z * 12;
      crowdAnchor.set(crowdFocusX, crowdFocusZ);
      assignNearbyCrowdToMappedWalkways(
        mappedWalkways,
        crowdFocusX,
        crowdFocusZ,
      );
      mappedCrowdWalkwaySignature = mappedWalkwaySignature;
      npcAssignmentsChanged = true;
    } else if (
      mappedWalkways.length === 0 &&
      mappedCrowdWalkwaySignature !== ''
    ) {
      campusNpcs.forEach((_, index) => {
        const route = pedestrianRoutes[index % guaranteedPedestrianRouteCount];
        const distance =
          route.total * (0.06 + ((index * 0.61803398875 + 0.17) % 1) * 0.88);
        campusNpcs[index] = createCampusNpc(
          index,
          route,
          distance,
          npcTerrainAt,
        );
      });
      mappedCrowdWalkwaySignature = '';
      npcAssignmentsChanged = true;
    }
    if (npcAssignmentsChanged)
      updateCrowdVisuals(crowdFleet, campusNpcs, 1, elapsedTime);
    return added > 0 || npcAssignmentsChanged;
  };

  const relocateNearbyCrowd = (force = false) => {
    if (guaranteedPedestrianRouteCount === 0 || campusNpcs.length === 0)
      return false;
    const crowdFocusX = state.position.x + state.forward.x * 12;
    const crowdFocusZ = state.position.z + state.forward.z * 12;
    const distanceFromAnchor = Math.hypot(
      crowdFocusX - crowdAnchor.x,
      crowdFocusZ - crowdAnchor.y,
    );
    const mappedWalkways = getMappedPedestrianWalkways();
    const nearbyCount = Math.min(NEAR_SPAWN_CROWD_COUNT, campusNpcs.length);
    const needsMappedAssignment =
      mappedWalkways.length > 0 &&
      campusNpcs
        .slice(0, nearbyCount)
        .some((npc) => !npc.route.isMappedWalkway);
    const fallbackNeedsDryRelocation =
      mappedWalkways.length === 0 &&
      pedestrianRoutes
        .slice(0, guaranteedPedestrianRouteCount)
        .some((route) => crowdRouteTouchesMappedWater(route));
    if (
      !force &&
      !needsMappedAssignment &&
      !fallbackNeedsDryRelocation &&
      distanceFromAnchor < 70
    )
      return false;
    if (mappedWalkways.length > 0) {
      crowdAnchor.set(crowdFocusX, crowdFocusZ);
      const changed = assignNearbyCrowdToMappedWalkways(
        mappedWalkways,
        crowdFocusX,
        crowdFocusZ,
      );
      if (changed) updateCrowdVisuals(crowdFleet, campusNpcs, 1, elapsedTime);
      return changed;
    }

    const previousAnchor = crowdAnchor.clone();
    const candidateAnchors = [new THREE.Vector2(crowdFocusX, crowdFocusZ)];
    for (let radius = 35; radius <= 175; radius += 35) {
      for (let direction = 0; direction < 8; direction += 1) {
        const angle = (direction * Math.PI) / 4;
        candidateAnchors.push(
          new THREE.Vector2(
            crowdFocusX + Math.cos(angle) * radius,
            crowdFocusZ + Math.sin(angle) * radius,
          ),
        );
      }
    }
    candidateAnchors.push(new THREE.Vector2(0, 0));
    const dryAnchor = candidateAnchors.find((candidate) => {
      positionGuaranteedWalkways(candidate.x, candidate.y);
      return pedestrianRoutes
        .slice(0, guaranteedPedestrianRouteCount)
        .every((route) => !crowdRouteTouchesMappedWater(route));
    });
    if (!dryAnchor)
      positionGuaranteedWalkways(previousAnchor.x, previousAnchor.y);

    for (let index = 0; index < nearbyCount; index += 1) {
      const npc = campusNpcs[index];
      let relocated = createCampusNpc(
        index,
        npc.route,
        npc.distance,
        npcTerrainAt,
      );
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const playerDistance = Math.hypot(
          relocated.position.x - state.position.x,
          relocated.position.z - state.position.z,
        );
        if (playerDistance >= 8) break;
        const shiftedDistance = clamp(
          relocated.distance + relocated.route.total * (0.17 + attempt * 0.11),
          0,
          relocated.route.total,
        );
        relocated = createCampusNpc(
          index,
          relocated.route,
          shiftedDistance,
          npcTerrainAt,
        );
      }
      campusNpcs[index] = relocated;
    }
    updateCrowdVisuals(crowdFleet, campusNpcs, 1, elapsedTime);
    return true;
  };

  const simulateTraffic = (dt: number) => {
    const gooseGrounded = state.mode !== 'flying';
    traffic.forEach((car, index) => {
      car.previousPosition.copy(car.position);
      car.previousDirection.copy(car.direction);
      car.reactionRemaining = Math.max(0, car.reactionRemaining - dt);
      car.honkScoreCooldown = Math.max(0, car.honkScoreCooldown - dt);
      car.collisionCooldown = Math.max(0, car.collisionCooldown - dt);
      car.nearMissCooldown = Math.max(0, car.nearMissCooldown - dt);
      car.wobbleRemaining = Math.max(0, car.wobbleRemaining - dt);

      const toGooseX = state.position.x - car.position.x;
      const toGooseZ = state.position.z - car.position.z;
      const rightX = car.direction.z;
      const rightZ = -car.direction.x;
      const longitudinal =
        toGooseX * car.direction.x + toGooseZ * car.direction.z;
      const lateral = Math.abs(toGooseX * rightX + toGooseZ * rightZ);
      const stopDistance = 4.5 + 0.7 * car.speed + (car.speed * car.speed) / 10;
      const shouldYield =
        gooseGrounded &&
        longitudinal > -2 &&
        longitudinal < stopDistance &&
        lateral < 2.3;

      let targetSpeed =
        car.reactionRemaining > 0 ? car.cruise * 0.18 : car.cruise;
      if (shouldYield) targetSpeed = 0;
      let closestLeaderGap = Infinity;
      let leaderSpeed = targetSpeed;
      traffic.forEach((other) => {
        if (
          other === car ||
          other.route !== car.route ||
          other.directionSign !== car.directionSign
        )
          return;
        const gap = (other.distance - car.distance) * car.directionSign;
        if (gap > 0 && gap < closestLeaderGap) {
          closestLeaderGap = gap;
          leaderSpeed = other.speed;
        }
      });
      const desiredGap = 6.5 + 1.2 * car.speed;
      if (closestLeaderGap < desiredGap) {
        targetSpeed = Math.min(
          targetSpeed,
          closestLeaderGap < 5 ? 0 : leaderSpeed * 0.82,
        );
      }

      const acceleration =
        targetSpeed < car.speed ? (shouldYield ? 7 : 4.5) : 1.8;
      car.speed = moveToward(car.speed, targetSpeed, acceleration * dt);
      car.distance += car.speed * car.directionSign * dt;
      if (car.distance > car.route.total) {
        car.distance = Math.max(0, 2 * car.route.total - car.distance);
        car.directionSign = -1;
      } else if (car.distance < 0) {
        car.distance = Math.min(car.route.total, -car.distance);
        car.directionSign = 1;
      }

      const next = sampleRoute(car.route, car.distance);
      car.direction.copy(next.direction).multiplyScalar(car.directionSign);
      const right = new THREE.Vector3(car.direction.z, 0, -car.direction.x);
      next.position.addScaledVector(right, car.laneOffset);
      car.elevationTimer -= dt;
      if (car.elevationTimer <= 0) {
        car.elevationTimer = 0.55 + index * 0.015;
        car.targetGround = terrainAt(
          next.position.x,
          next.position.z,
          car.targetGround,
        );
      }
      car.ground = lerp(car.ground, car.targetGround, 1 - Math.exp(-8 * dt));
      car.position.set(next.position.x, car.ground + 0.04, next.position.z);
      if (shouldYield && !car.stopped && elapsedTime - lastYieldToast > 5) {
        lastYieldToast = elapsedTime;
        hooks.onToast('Traffic stopped for the goose');
      }
      car.stopped = shouldYield || car.reactionRemaining > 0;
    });
  };

  const updateTrafficVisuals = (blend: number) => {
    const position = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const world = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    const matrix = new THREE.Matrix4();
    const wheelPositions = [
      [-0.82, 0.32, -1.42],
      [0.82, 0.32, -1.42],
      [-0.82, 0.32, 1.42],
      [0.82, 0.32, 1.42],
    ] as const;

    traffic.forEach((car) => {
      position.lerpVectors(car.previousPosition, car.position, blend);
      direction
        .lerpVectors(car.previousDirection, car.direction, blend)
        .normalize();
      const heading = Math.atan2(direction.x, direction.z);
      const wobble =
        Math.sin(elapsedTime * 17 + car.index * 1.9) *
        0.065 *
        clamp(car.wobbleRemaining, 0, 1);
      quaternion.setFromEuler(new THREE.Euler(0, heading, wobble, 'YXZ'));
      world.compose(position, quaternion, scale);

      local.makeTranslation(0, 0.58, 0);
      matrix.multiplyMatrices(world, local);
      trafficFleet.bodies.setMatrixAt(car.index, matrix);
      local.makeTranslation(0, 1.03, -0.2);
      matrix.multiplyMatrices(world, local);
      trafficFleet.cabins.setMatrixAt(car.index, matrix);
      wheelPositions.forEach(([x, y, z], wheelIndex) => {
        local.makeTranslation(x, y, z);
        matrix.multiplyMatrices(world, local);
        trafficFleet.wheels.setMatrixAt(car.index * 4 + wheelIndex, matrix);
      });
    });
    trafficFleet.bodies.instanceMatrix.needsUpdate = true;
    trafficFleet.cabins.instanceMatrix.needsUpdate = true;
    trafficFleet.wheels.instanceMatrix.needsUpdate = true;
  };

  const terrorizeCampusCrowd = (radius: number, awardable = true) => {
    const nearby = campusNpcs
      .map((npc) => ({
        npc,
        distance: Math.hypot(
          npc.position.x - state.position.x,
          npc.position.z - state.position.z,
        ),
      }))
      .filter(
        ({ npc, distance }) =>
          distance <= radius &&
          Math.abs(state.position.y - npc.ground) < 20 &&
          npc.mode !== 'ragdoll' &&
          npc.honkCooldown <= 0,
      )
      .sort((a, b) => a.distance - b.distance)
      .slice(0, megaHonkRemaining > 0 ? 22 : 12);
    let scored = 0;
    nearby.forEach(({ npc }) => {
      const canScore = awardable && npc.scoreCooldown <= 0;
      if (panicCampusNpc(npc, state.position) && canScore) {
        npc.scoreCooldown = 8;
        scored += 1;
      }
    });
    return { panicked: nearby.length, scored };
  };

  const resolveCrowdInteractions = () => {
    if (campusNpcs.length === 0) return;
    const startX = previousState.position.x;
    const startZ = previousState.position.z;
    const segmentX = state.position.x - startX;
    const segmentZ = state.position.z - startZ;
    const segmentLengthSquared = segmentX * segmentX + segmentZ * segmentZ;

    for (const npc of campusNpcs) {
      if (
        npc.mode === 'ragdoll' ||
        npc.mode === 'recover' ||
        npc.collisionCooldown > 0
      )
        continue;
      const pointX = npc.position.x - startX;
      const pointZ = npc.position.z - startZ;
      const t =
        segmentLengthSquared > 0.0001
          ? clamp(
              (pointX * segmentX + pointZ * segmentZ) / segmentLengthSquared,
              0,
              1,
            )
          : 1;
      const closestX = startX + segmentX * t;
      const closestZ = startZ + segmentZ * t;
      const dx = npc.position.x - closestX;
      const dz = npc.position.z - closestZ;
      const horizontalDistance = Math.hypot(dx, dz);
      const vertical = state.position.y - npc.ground;
      if (horizontalDistance > 0.78 || vertical < -0.25 || vertical > 1.85)
        continue;

      const npcVelocity = npc.direction.clone().multiplyScalar(npc.speed);
      const relativeSpeed = state.velocity.clone().sub(npcVelocity).length();
      if (relativeSpeed < 2.35) {
        panicCampusNpc(npc, state.position);
        npc.collisionCooldown = 0.8;
        continue;
      }

      const severity = clamp((relativeSpeed - 2) / 10, 0.2, 1);
      const outward = new THREE.Vector3(dx, 0, dz);
      if (outward.lengthSq() < 0.01)
        outward.set(npc.direction.z, 0, -npc.direction.x);
      outward.normalize();
      const impulse = state.velocity
        .clone()
        .multiplyScalar(0.32)
        .addScaledVector(outward, 1.7 + severity * 2.2);
      impulse.y = 2.6 + severity * 3.2;
      if (!knockDownCampusNpc(npc, impulse)) continue;
      state.velocity.addScaledVector(outward, -0.55 * severity);
      state.velocity.y = Math.max(state.velocity.y, 0.5 + severity);
      cameraShakeRemaining = Math.max(
        cameraShakeRemaining,
        0.12 + severity * 0.12,
      );
      if (npc.scoreCooldown <= 0) {
        npc.scoreCooldown = 7;
        awardChaos(
          state.mode === 'flying' ? 260 : 180,
          state.mode === 'flying'
            ? 'AIRBORNE CAMPUS BOWLING'
            : 'CAMPUS BOWLING',
        );
      }
      break;
    }
  };

  const awardChaos = (basePoints: number, label: string) => {
    chaosComboEvents += 1;
    chaosCombo = Math.min(5, 1 + Math.floor((chaosComboEvents - 1) / 3));
    chaosComboRemaining = CHAOS_COMBO_SECONDS;
    const points = basePoints * chaosCombo;
    chaosScore += points;
    hooks.onToast(
      `${label} · +${points}${chaosCombo > 1 ? ` · x${chaosCombo}` : ''}`,
    );
  };

  const launchGoose = (verticalSpeed: number, forwardBoost: number) => {
    const horizontal = new THREE.Vector3(state.forward.x, 0, state.forward.z);
    if (horizontal.lengthSq() < 0.01)
      horizontal.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    horizontal.normalize();
    state.mode = 'flying';
    state.position.y = Math.max(state.position.y, state.ground + 0.7);
    state.velocity.addScaledVector(horizontal, forwardBoost);
    state.velocity.y = Math.max(state.velocity.y, verticalSpeed);
    state.forward.lerp(horizontal, 0.65).normalize();
    state.stamina = 1;
    waterPlaningElapsed = 0;
    waterDryTime = 0;
    waterSprayClock = 0;
    airborneTime = 0;
    peakAgl = 0;
  };

  const discoverSecret = (
    secret: CampusSecret,
    points: number,
    label: string,
  ) => {
    if (secret.found) return;
    secret.found = true;
    secret.activation = 0;
    secretsFound += 1;
    secret.group.traverse((object) => {
      if (
        object instanceof THREE.Mesh &&
        object.material instanceof THREE.MeshStandardMaterial
      ) {
        object.material.emissive.setHex(0x5a3000);
        object.material.emissiveIntensity = Math.max(
          object.material.emissiveIntensity,
          0.62,
        );
      }
    });
    awardChaos(
      points,
      `${label} · SECRET ${secretsFound}/${campusSecrets.length}`,
    );
  };

  const unleashBonusEffect = (secret: CampusSecret) => {
    const definition = secret.definition;
    if (!definition) return;
    const horizontal = new THREE.Vector3(state.forward.x, 0, state.forward.z);
    if (horizontal.lengthSq() < 0.01)
      horizontal.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    horizontal.normalize();

    if (definition.effect === 'launch') {
      launchGoose(
        definition.id === 'bench-catapult' ? 17 : 12,
        definition.id === 'bench-catapult' ? 12 : 5,
      );
      cameraShakeRemaining = 0.28;
    } else if (definition.effect === 'boost') {
      if (state.mode !== 'flying') launchGoose(7, 4);
      state.velocity.addScaledVector(horizontal, 11).addScaledVector(UP, 3.5);
      state.stamina = 1;
      cameraShakeRemaining = 0.16;
    } else if (definition.effect === 'low-gravity') {
      lowGravityRemaining = 10;
      if (state.mode !== 'flying') launchGoose(8.5, 3);
    } else if (definition.effect === 'mega-honk') {
      megaHonkRemaining = 10;
      spawnHonkWave();
    } else if (definition.effect === 'slippery') {
      slipperyRemaining = 12;
    } else if (definition.effect === 'spin') {
      launchGoose(13, 7);
      tumbleRemaining = 1.2;
      tumbleAngularSpeed = 16;
      cameraShakeRemaining = 0.24;
    } else if (definition.effect === 'stamina') {
      state.stamina = 1;
      state.velocity.addScaledVector(horizontal, 3.5);
      spawnHonkWave();
    } else if (definition.effect === 'traffic-wobble') {
      traffic.forEach((car) => {
        if (car.position.distanceToSquared(state.position) < 55 * 55) {
          car.wobbleRemaining = Math.max(car.wobbleRemaining, 5);
          car.reactionRemaining = Math.max(car.reactionRemaining, 2.5);
        }
      });
      terrorizeCampusCrowd(55, false);
      cameraShakeRemaining = 0.2;
    }
  };

  const activateBonusSecret = (secret: CampusSecret) => {
    if (!secret.definition || secret.found) return;
    discoverSecret(
      secret,
      secret.definition.points,
      secret.definition.label.toUpperCase(),
    );
    unleashBonusEffect(secret);
  };

  const registerSecretHonk = () => {
    campusSecrets.forEach((secret) => {
      if (secret.found) return;
      const distance = state.position.distanceTo(secret.position);
      if (
        secret.kind === 'chaos-bonus' &&
        secret.definition &&
        distance < secret.radius
      ) {
        const { definition } = secret;
        if (
          definition.trigger !== 'honk' &&
          definition.trigger !== 'multi-honk'
        )
          return;
        if (secret.honkWindow <= 0) secret.honkCount = 0;
        secret.honkCount += 1;
        secret.honkWindow = definition.id === 'student-megaphone' ? 7 : 4;
        if (secret.honkCount < definition.requiredHonks) {
          hooks.onToast(
            `${definition.label} · honk ${secret.honkCount}/${definition.requiredHonks}`,
          );
          return;
        }
        activateBonusSecret(secret);
        return;
      }
      if (
        secret.kind === 'duck-council' &&
        distance < secret.radius &&
        state.onWater
      ) {
        discoverSecret(secret, 900, 'CHOSEN OF THE POND');
        cameraShakeRemaining = 0.14;
        return;
      }
      if (
        (secret.kind === 'radio' || secret.kind === 'dean-ufo') &&
        distance < secret.radius
      ) {
        if (secret.honkWindow <= 0) secret.honkCount = 0;
        secret.honkCount += 1;
        secret.honkWindow = 4;
        if (secret.honkCount < 3) {
          hooks.onToast(
            `${secret.kind === 'radio' ? 'The dish is listening' : 'The cones are humming'} · honk ${secret.honkCount}/3`,
          );
          return;
        }
        if (secret.kind === 'radio') {
          discoverSecret(secret, 700, 'PUBLIC BROAD-GOOSE-TING');
          spawnHonkWave();
          launchGoose(12, 4);
        } else {
          discoverSecret(secret, 1000, 'TAKE ME TO YOUR DEAN');
          launchGoose(18, 7);
          cameraShakeRemaining = 0.3;
        }
      }
    });
  };

  const updateCampusSecrets = (dt: number) => {
    campusSecrets.forEach((secret, secretIndex) => {
      secret.terrainRefreshRemaining = Math.max(
        0,
        secret.terrainRefreshRemaining - dt,
      );
      if (
        secret.kind !== 'bronco-horse' &&
        secret.terrainRefreshRemaining <= 0 &&
        Math.hypot(
          secret.position.x - state.position.x,
          secret.position.z - state.position.z,
        ) < 850
      ) {
        const elevation = map.queryTerrainElevation(
          localToLngLat(secret.position.x, secret.position.z),
        );
        if (
          typeof elevation === 'number' &&
          isUsableTerrainElevation(elevation)
        ) {
          secret.terrainResolved = true;
          secret.terrainRefreshRemaining = 2.15 + (secretIndex % 6) * 0.17;
          secret.position.y = elevation + secret.altitude;
          secret.group.position.y = secret.position.y;
          secret.group.userData.baseY = secret.position.y;
          secret.group.visible = playing;
        } else {
          secret.terrainRefreshRemaining = 0.52 + (secretIndex % 4) * 0.09;
          if (!secret.terrainResolved) secret.group.visible = false;
        }
      }
      secret.honkWindow = Math.max(0, secret.honkWindow - dt);
      if (secret.honkWindow === 0 && !secret.found) secret.honkCount = 0;
      secret.activation += secret.found ? dt : 0;
      const pulse = 1 + Math.sin(elapsedTime * 3.2 + secretIndex) * 0.045;

      if (secret.kind === 'chaos-bonus') {
        const spinner = secret.group.getObjectByName('bonus-spinner');
        const beacon = secret.group.getObjectByName('bonus-pulse');
        if (spinner) {
          spinner.rotation.z += dt * (secret.found ? 2.8 : 0.35);
          if (secret.definition?.visual !== 'air-gate')
            spinner.rotation.y += dt * (secret.found ? 3.4 : 0.24);
        }
        if (beacon)
          beacon.scale.setScalar(
            secret.found ? 1.18 + Math.sin(elapsedTime * 8) * 0.15 : pulse,
          );
        if (secret.found) {
          secret.group.position.y =
            secret.group.userData.baseY +
            Math.sin(elapsedTime * 3.7 + secretIndex) * 0.16;
        }
      } else if (secret.kind === 'radio') {
        const beacon = secret.group.getObjectByName('secret-beacon');
        if (beacon) {
          beacon.rotation.z += dt * (secret.found ? 4.5 : 0.75);
          beacon.scale.setScalar(
            secret.found ? 1.25 + Math.sin(elapsedTime * 7) * 0.18 : pulse,
          );
        }
        if (secret.found)
          secret.group.position.y =
            secret.group.userData.baseY + Math.sin(elapsedTime * 4) * 0.08;
      } else if (secret.kind === 'duck-council') {
        secret.group.rotation.y += dt * (secret.found ? 1.8 : 0.18);
        const beacon = secret.group.getObjectByName('secret-beacon');
        if (beacon) {
          beacon.rotation.z += dt * (secret.found ? 2.4 : 0.35);
          beacon.scale.setScalar(
            secret.found ? 1.18 + Math.sin(elapsedTime * 7) * 0.12 : pulse,
          );
        }
        secret.group.children.forEach((child, index) => {
          if (child.name === 'duck-ripple') {
            child.scale.setScalar(
              1 + Math.sin(elapsedTime * 2.4 + index) * 0.07,
            );
          }
        });
        const elder = secret.group.getObjectByName('duck-elder');
        if (elder)
          elder.position.y = lerp(
            -3.2,
            0.15,
            smoothstep(0, 1.3, secret.activation),
          );
      } else if (secret.kind === 'bronco-horse') {
        broncoTurnRemaining -= dt;
        broncoObstacleRemaining -= dt;
        broncoTerrainRemaining -= dt;
        const homeX = broncoHome.x - secret.group.position.x;
        const homeZ = broncoHome.y - secret.group.position.z;
        const homeDistance = Math.hypot(homeX, homeZ);
        if (homeDistance > 68) {
          const homeHeading = Math.atan2(homeX, homeZ);
          const headingDelta = Math.atan2(
            Math.sin(homeHeading - broncoHeading),
            Math.cos(homeHeading - broncoHeading),
          );
          broncoHeading += headingDelta * Math.min(1, dt * 2.2);
        } else if (broncoTurnRemaining <= 0) {
          broncoTurnRemaining = 1.8 + (Math.sin(elapsedTime * 0.61) + 1) * 0.8;
          broncoHeading += Math.sin(elapsedTime * 1.37 + secretIndex) * 0.82;
        } else {
          broncoHeading +=
            Math.sin(elapsedTime * 0.43 + secretIndex) * 0.045 * dt;
        }

        if (broncoObstacleRemaining <= 0) {
          broncoObstacleRemaining = 0.22;
          const horseX = secret.group.position.x;
          const horseZ = secret.group.position.z;
          const containingBuilding = buildingColliders.find(
            (building) =>
              horseX >= building.minX &&
              horseX <= building.maxX &&
              horseZ >= building.minZ &&
              horseZ <= building.maxZ &&
              pointInBuilding(horseX, horseZ, building),
          );
          if (containingBuilding) {
            const boundary = closestBuildingBoundary(
              horseX,
              horseZ,
              containingBuilding,
            );
            let outwardX = boundary.x - horseX;
            let outwardZ = boundary.z - horseZ;
            const length = Math.hypot(outwardX, outwardZ) || 1;
            outwardX /= length;
            outwardZ /= length;
            secret.group.position.x = boundary.x + outwardX * 0.9;
            secret.group.position.z = boundary.z + outwardZ * 0.9;
            broncoHeading += Math.PI * 0.72;
          } else {
            const probeDistance = 2.6;
            const probeX = horseX + Math.sin(broncoHeading) * probeDistance;
            const probeZ = horseZ + Math.cos(broncoHeading) * probeDistance;
            const blocked = buildingColliders.some(
              (building) =>
                probeX >= building.minX &&
                probeX <= building.maxX &&
                probeZ >= building.minZ &&
                probeZ <= building.maxZ &&
                pointInBuilding(probeX, probeZ, building),
            );
            if (blocked)
              broncoHeading += Math.PI * (0.56 + 0.12 * Math.sin(elapsedTime));
          }
        }

        const horseSpeed = secret.found ? 4.8 : 3.15;
        secret.group.position.x += Math.sin(broncoHeading) * horseSpeed * dt;
        secret.group.position.z += Math.cos(broncoHeading) * horseSpeed * dt;
        if (broncoTerrainRemaining <= 0) {
          broncoTerrainRemaining = 0.28;
          const elevation = map.queryTerrainElevation(
            localToLngLat(secret.group.position.x, secret.group.position.z),
          );
          if (
            typeof elevation === 'number' &&
            isUsableTerrainElevation(elevation)
          ) {
            broncoGround = elevation;
            secret.terrainResolved = true;
            secret.group.visible = playing;
          } else if (!secret.terrainResolved) {
            secret.group.visible = false;
          }
        }
        secret.group.position.y = broncoGround + secret.altitude;
        secret.group.userData.baseY = secret.group.position.y;
        secret.group.rotation.y = broncoHeading;
        secret.position.copy(secret.group.position);
        let legIndex = 0;
        secret.group.children.forEach((child) => {
          if (child.name.startsWith('bronco-leg-')) {
            child.rotation.x =
              Math.sin(
                elapsedTime * horseSpeed * 3.2 + (legIndex % 2) * Math.PI,
              ) * 0.42;
            legIndex += 1;
          }
        });
        const tail = secret.group.getObjectByName('bronco-tail');
        if (tail) tail.rotation.z = Math.sin(elapsedTime * 5.1) * 0.28;
        const beacon = secret.group.getObjectByName('bronco-beacon');
        if (beacon) {
          beacon.rotation.z += dt * (secret.found ? 3.2 : 0.7);
          beacon.scale.setScalar(
            secret.found ? 1.2 + Math.sin(elapsedTime * 8) * 0.12 : pulse,
          );
        }
      } else if (secret.kind === 'diploma-tornado') {
        secret.group.rotation.y += dt * (secret.found ? 4.2 : 0.34);
        secret.group.children.forEach((paper, index) => {
          paper.rotation.x +=
            dt * (0.25 + index * 0.025) * (secret.found ? 4 : 1);
          if (secret.found) paper.position.y += dt * 0.55;
        });
      } else if (secret.kind === 'sky-ring') {
        secret.group.rotation.z += dt * (secret.found ? 1.8 : 0.22);
        secret.group.scale.setScalar(
          secret.found ? 1.08 + Math.sin(elapsedTime * 8) * 0.09 : pulse,
        );
      } else if (secret.kind === 'dean-ufo') {
        secret.group.rotation.y += dt * (secret.found ? 1.3 : 0.12);
        const saucer = secret.group.getObjectByName('secret-saucer');
        if (saucer) {
          saucer.visible = secret.found;
          saucer.position.y =
            8 +
            Math.sin(elapsedTime * 2.7) * 0.75 +
            Math.min(9, secret.activation * 3.5);
        }
      }

      if (secret.found) return;
      const distance = state.position.distanceTo(secret.position);
      if (secret.kind === 'chaos-bonus' && secret.definition) {
        const { definition } = secret;
        const contactRadius =
          definition.visual === 'bonk-cluster'
            ? Math.min(definition.radius, 3.2)
            : Math.min(definition.radius, 2.6);
        const touched =
          definition.trigger === 'touch' && distance < contactRadius;
        const flewThrough =
          definition.trigger === 'air' &&
          state.mode === 'flying' &&
          distance < definition.radius;
        if (touched || flewThrough) activateBonusSecret(secret);
      } else if (
        secret.kind === 'bronco-horse' &&
        distance < secret.radius &&
        state.velocity.length() > 2.35
      ) {
        discoverSecret(secret, 1_100, 'BRONCO BUSTER');
        broncoHeading += Math.PI;
        launchGoose(8.5, 4.5);
        tumbleRemaining = Math.max(tumbleRemaining, 0.72);
        tumbleAngularSpeed = 11;
        cameraShakeRemaining = 0.3;
      } else if (
        secret.kind === 'diploma-tornado' &&
        distance < secret.radius
      ) {
        discoverSecret(secret, 600, 'ACADEMIC MENACE');
        launchGoose(7.5, 2.5);
        cameraShakeRemaining = 0.18;
      } else if (
        secret.kind === 'sky-ring' &&
        state.mode === 'flying' &&
        distance < secret.radius
      ) {
        discoverSecret(secret, 850, 'STANDING OVATION');
        state.velocity.addScaledVector(state.forward, 8);
        state.velocity.y += 4.5;
        state.stamina = 1;
        spawnHonkWave();
      }
    });
  };

  const unlockAudio = () => {
    try {
      audioContext ??= new AudioContext();
      if (audioContext.state === 'suspended') void audioContext.resume();
      return audioContext;
    } catch {
      return null;
    }
  };

  const playHonk = () => {
    try {
      const context = unlockAudio();
      if (!context) return;
      const now = context.currentTime;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.11, now + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
      gain.connect(context.destination);
      [
        { start: 205, end: 142, volume: 0.7 },
        { start: 154, end: 112, volume: 0.42 },
      ].forEach(({ start, end, volume }) => {
        const oscillator = context.createOscillator();
        const voiceGain = context.createGain();
        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(start, now);
        oscillator.frequency.exponentialRampToValueAtTime(end, now + 0.31);
        voiceGain.gain.value = volume;
        oscillator.connect(voiceGain).connect(gain);
        oscillator.start(now);
        oscillator.stop(now + 0.35);
      });
    } catch {
      // Audio is a bonus; browsers may block it without affecting the honk interaction.
    }
  };

  const spawnHonkWave = () => {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffc85a,
      transparent: true,
      opacity: 0.82,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(
      new THREE.TorusGeometry(0.75, 0.045, 6, 34),
      material,
    );
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(
      state.position.x,
      state.position.y + 0.2,
      state.position.z,
    );
    mesh.frustumCulled = false;
    scene.add(mesh);
    honkWaves.push({ mesh, age: 0, life: 0.48 });
  };

  const updateHonkWaves = (dt: number) => {
    for (let index = honkWaves.length - 1; index >= 0; index -= 1) {
      const wave = honkWaves[index];
      wave.age += dt;
      const life = clamp(wave.age / wave.life, 0, 1);
      wave.mesh.scale.setScalar(1 + life * 13);
      wave.mesh.material.opacity = 0.82 * (1 - life);
      if (life >= 1) {
        scene.remove(wave.mesh);
        wave.mesh.geometry.dispose();
        wave.mesh.material.dispose();
        honkWaves.splice(index, 1);
      }
    }
  };

  const performHonk = () => {
    queuedHonks = 0;
    honkCooldown = 0.58;
    spawnHonkWave();
    playHonk();
    const agl = state.position.y - state.ground;
    const baseRadius = state.mode === 'flying' && agl < 20 ? 34 : 26;
    const radius = baseRadius * (megaHonkRemaining > 0 ? 2.4 : 1);
    const nearby = traffic
      .map((car) => ({
        car,
        distance: Math.hypot(
          car.position.x - state.position.x,
          car.position.z - state.position.z,
        ),
      }))
      .filter(({ distance }) => distance <= radius)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3);
    let scoredCars = 0;
    nearby.forEach(({ car, distance }) => {
      car.reactionRemaining = Math.max(
        car.reactionRemaining,
        distance < 10 ? 1.55 : 2.1,
      );
      car.wobbleRemaining = Math.max(car.wobbleRemaining, 1.25);
      if (car.honkScoreCooldown <= 0 && car.speed > 0.8) {
        car.honkScoreCooldown = 6;
        scoredCars += 1;
      }
    });
    const crowdReaction = terrorizeCampusCrowd(radius, true);
    const recruitedGeese = recruitNearbyFlock(true);
    if (scoredCars > 0 || crowdReaction.scored > 0) {
      const totalTargets = scoredCars + crowdReaction.scored;
      const label =
        scoredCars > 0 && crowdReaction.scored > 0
          ? `CAMPUS PANIC ×${totalTargets}`
          : crowdReaction.scored > 0
            ? `HONK PANIC ×${crowdReaction.scored}`
            : scoredCars >= 2
              ? `HONK CHAIN ×${scoredCars}`
              : 'HONK IF YOU YIELD';
      awardChaos(50 * scoredCars + 35 * crowdReaction.scored, label);
    } else if (crowdReaction.panicked > 0) {
      hooks.onToast(`HONK! · ${crowdReaction.panicked} students scattered`);
    } else if (recruitedGeese === 0) {
      hooks.onToast('HONK!');
    }
    registerSecretHonk();
  };

  const updateChaosTimers = (dt: number) => {
    honkCooldown = Math.max(0, honkCooldown - dt);
    hitCooldown = Math.max(0, hitCooldown - dt);
    buildingHitCooldown = Math.max(0, buildingHitCooldown - dt);
    cameraShakeRemaining = Math.max(0, cameraShakeRemaining - dt);
    lowGravityRemaining = Math.max(0, lowGravityRemaining - dt);
    megaHonkRemaining = Math.max(0, megaHonkRemaining - dt);
    slipperyRemaining = Math.max(0, slipperyRemaining - dt);
    infamyPanicClock = Math.max(0, infamyPanicClock - dt);
    if (chaosScore >= 10_000) {
      if (!campusInfamyUnlocked) {
        campusInfamyUnlocked = true;
        hooks.onToast('CAMPUS INFAMY · students now flee on sight');
      }
      if (infamyPanicClock <= 0) {
        infamyPanicClock = 0.35;
        campusNpcs.forEach((npc) => {
          if (
            npc.mode === 'walk' &&
            Math.hypot(
              npc.position.x - state.position.x,
              npc.position.z - state.position.z,
            ) < 95
          ) {
            panicCampusNpc(npc, state.position);
          }
        });
      }
    }
    if (chaosComboRemaining > 0) {
      chaosComboRemaining = Math.max(0, chaosComboRemaining - dt);
      if (chaosComboRemaining === 0) {
        chaosComboEvents = 0;
        chaosCombo = 1;
      }
    }
    if (tumbleRemaining > 0) {
      tumbleRemaining = Math.max(0, tumbleRemaining - dt);
      tumbleAngle += tumbleAngularSpeed * dt;
      tumbleAngularSpeed *= Math.exp(-0.7 * dt);
    }
    if (state.mode === 'flying' && tumbleRemaining <= 0) {
      airborneTime += dt;
      peakAgl = Math.max(peakAgl, state.position.y - state.ground);
    }
  };

  const simulateTumble = (dt: number) => {
    state.velocity.y -= FLIGHT.gravity * 0.75 * dt;
    state.velocity.x *= Math.exp(-1.45 * dt);
    state.velocity.z *= Math.exp(-1.45 * dt);
    state.position.addScaledVector(state.velocity, dt);
    if (state.position.y <= state.ground + 0.05) {
      state.position.y = state.ground + 0.05;
      if (state.onWater) {
        const horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);
        state.velocity.y = 0;
        state.velocity.x *= 0.58;
        state.velocity.z *= 0.58;
        state.mode = horizontalSpeed >= 3 ? 'planing' : 'swimming';
        waterSurfaceY = state.ground;
        waterTouchdownSeverity = 1;
        waterPlaningElapsed = 0;
        tumbleRemaining = 0;
        tumbleAngle = 0;
        tumbleAngularSpeed = 0;
        state.bank = 0;
        state.alpha = FLIGHT.trimAlpha;
        return;
      } else {
        state.velocity.y =
          Math.abs(state.velocity.y) > 1 ? -state.velocity.y * 0.22 : 0;
        state.velocity.x *= Math.exp(-2.5 * dt);
        state.velocity.z *= Math.exp(-2.5 * dt);
        state.mode = 'waddling';
      }
    }
    if (tumbleRemaining <= fixedStep) {
      state.bank = 0;
      state.alpha = FLIGHT.trimAlpha;
      if (state.mode !== 'flying') {
        state.velocity.y = 0;
        const horizontal = Math.hypot(state.velocity.x, state.velocity.z);
        if (horizontal > 2) {
          state.velocity.x *= 2 / horizontal;
          state.velocity.z *= 2 / horizontal;
        }
      }
    }
  };

  const resolveBuildingInteractions = () => {
    buildingContactThisStep = false;
    refreshActiveBuildingColliders();
    if (activeBuildingColliders.length === 0) return;
    // Use the visible body/inner-wing envelope, not just the goose's center point.
    // This prevents the wings and neck from visibly entering walls first.
    const radius = state.mode === 'flying' ? 0.68 : 0.58;
    const gooseHeight = 0.92;

    let roofLanding: {
      roof: number;
      east: number;
      north: number;
      time: number;
    } | null = null;
    const downwardTravel = previousState.position.y - state.position.y;
    if (
      state.mode === 'flying' &&
      downwardTravel > 1e-5 &&
      state.velocity.y <= 0
    ) {
      for (const building of activeBuildingColliders) {
        const roof = building.ground + building.height;
        const contactY = roof + 0.04;
        if (previousState.position.y <= contactY || state.position.y > contactY)
          continue;
        const time = (previousState.position.y - contactY) / downwardTravel;
        const east = lerp(previousState.position.x, state.position.x, time);
        const north = lerp(previousState.position.z, state.position.z, time);
        if (
          east < building.minX ||
          east > building.maxX ||
          north < building.minZ ||
          north > building.maxZ ||
          !pointInBuilding(east, north, building) ||
          (roofLanding !== null && time >= roofLanding.time)
        )
          continue;
        roofLanding = { roof, east, north, time };
      }
    }

    if (roofLanding !== null) {
      buildingContactThisStep = true;
      const impact = Math.max(0, -state.velocity.y);
      state.position.set(
        roofLanding.east,
        roofLanding.roof + 0.04,
        roofLanding.north,
      );
      state.ground = roofLanding.roof;
      state.onWater = false;
      state.mode = 'waddling';
      state.velocity.y = 0;
      state.velocity.x *= impact > 5 ? 0.48 : 0.78;
      state.velocity.z *= impact > 5 ? 0.48 : 0.78;
      state.bank = 0;
      queuedFlaps = 0;
      waterPlaningElapsed = 0;
      waterDryTime = 0;
      if (buildingHitCooldown <= 0) {
        buildingHitCooldown = 1.2;
        if (impact > 5) {
          tumbleRemaining = 0.7;
          tumbleAngularSpeed = 10;
          cameraShakeRemaining = 0.24;
          awardChaos(180, 'ROOFTOP PANCAKE');
        } else {
          awardChaos(220, 'ROOFTOP LANDING');
        }
      }
    }

    for (const building of activeBuildingColliders) {
      if (
        Math.max(previousState.position.x, state.position.x) <
          building.minX - radius ||
        Math.min(previousState.position.x, state.position.x) >
          building.maxX + radius ||
        Math.max(previousState.position.z, state.position.z) <
          building.minZ - radius ||
        Math.min(previousState.position.z, state.position.z) >
          building.maxZ + radius
      )
        continue;
      const roof = building.ground + building.height;
      const crossing = firstBuildingCrossing(
        previousState.position.x,
        previousState.position.z,
        state.position.x,
        state.position.z,
        building,
        radius,
      );
      const crossingY =
        crossing === null
          ? state.position.y
          : lerp(previousState.position.y, state.position.y, crossing.t);
      const lowestBodyY = Math.min(
        previousState.position.y,
        state.position.y,
        crossingY,
      );
      const highestBodyY =
        Math.max(previousState.position.y, state.position.y) + gooseHeight;
      const verticallyOverlaps =
        lowestBodyY < roof - 0.015 && highestBodyY > building.ground;
      if (!verticallyOverlaps) continue;

      const inside = pointInBuilding(
        state.position.x,
        state.position.z,
        building,
      );
      const boundary = closestBuildingBoundary(
        state.position.x,
        state.position.z,
        building,
      );
      const nearWall = boundary.distanceSquared < radius * radius;
      const startedInside = pointInBuilding(
        previousState.position.x,
        previousState.position.z,
        building,
      );
      const sweptHit = crossing !== null && !startedInside;
      if (!inside && !nearWall && !sweptHit) continue;

      let contactX = boundary.x;
      let contactZ = boundary.z;
      let normalX = inside
        ? boundary.x - state.position.x
        : state.position.x - boundary.x;
      let normalZ = inside
        ? boundary.z - state.position.z
        : state.position.z - boundary.z;
      if (sweptHit) {
        contactX = crossing.x;
        contactZ = crossing.z;
        normalX = crossing.normalX;
        normalZ = crossing.normalZ;
      }
      let normalLength = Math.hypot(normalX, normalZ);
      if (normalLength < 1e-5) {
        normalX = -state.velocity.x;
        normalZ = -state.velocity.z;
        normalLength = Math.hypot(normalX, normalZ);
      }
      if (normalLength < 1e-5) {
        normalX = 1;
        normalZ = 0;
        normalLength = 1;
      }
      normalX /= normalLength;
      normalZ /= normalLength;
      state.position.x = contactX + normalX * (radius + 0.025);
      state.position.z = contactZ + normalZ * (radius + 0.025);
      buildingContactThisStep = true;

      const inwardSpeed = -(
        state.velocity.x * normalX +
        state.velocity.z * normalZ
      );
      if (inwardSpeed > 0) {
        const rebound = state.mode === 'flying' ? 1.28 : 1;
        state.velocity.x += normalX * inwardSpeed * rebound;
        state.velocity.z += normalZ * inwardSpeed * rebound;
      }
      if (state.mode === 'flying' && inwardSpeed > 1.8) {
        const severity = clamp((inwardSpeed - 1.5) / 10, 0.18, 1);
        state.velocity.x *= lerp(0.88, 0.62, severity);
        state.velocity.z *= lerp(0.88, 0.62, severity);
        if (state.position.y - state.ground <= 2.2)
          state.velocity.y = Math.max(0, state.velocity.y);
        else
          state.velocity.y = Math.min(
            state.velocity.y,
            lerp(-0.4, -2.4, severity),
          );
        tumbleRemaining = Math.max(tumbleRemaining, lerp(0.45, 1.15, severity));
        tumbleAngularSpeed = lerp(7, 15, severity) * (normalX >= 0 ? 1 : -1);
        cameraShakeRemaining = Math.max(
          cameraShakeRemaining,
          lerp(0.1, 0.3, severity),
        );
        queuedFlaps = 0;
        if (buildingHitCooldown <= 0) {
          buildingHitCooldown = 1.5;
          awardChaos(200, 'ARCHITECTURAL CRITIQUE');
        }
      }
      const horizontal = new THREE.Vector3(
        state.velocity.x,
        0,
        state.velocity.z,
      );
      if (horizontal.lengthSq() > 0.04)
        state.forward.lerp(horizontal.normalize(), 0.5).normalize();
    }

    // Adjacent footprints and concave corners can push the goose from one
    // collider into another that was already processed. A short depenetration
    // pass makes "outside every wall" a postcondition for both flight and foot.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let moved = false;
      for (const building of activeBuildingColliders) {
        const roof = building.ground + building.height;
        if (
          state.position.y >= roof - 0.015 ||
          state.position.y + gooseHeight <= building.ground
        )
          continue;
        const inside = pointInBuilding(
          state.position.x,
          state.position.z,
          building,
        );
        const boundary = closestBuildingBoundary(
          state.position.x,
          state.position.z,
          building,
        );
        if (!inside && boundary.distanceSquared >= radius * radius) continue;
        let normalX = inside
          ? boundary.x - state.position.x
          : state.position.x - boundary.x;
        let normalZ = inside
          ? boundary.z - state.position.z
          : state.position.z - boundary.z;
        let normalLength = Math.hypot(normalX, normalZ);
        if (normalLength < 1e-5) {
          normalX = state.position.x - (building.minX + building.maxX) * 0.5;
          normalZ = state.position.z - (building.minZ + building.maxZ) * 0.5;
          normalLength = Math.hypot(normalX, normalZ) || 1;
        }
        normalX /= normalLength;
        normalZ /= normalLength;
        state.position.x = boundary.x + normalX * (radius + 0.035);
        state.position.z = boundary.z + normalZ * (radius + 0.035);
        const inwardSpeed = -(
          state.velocity.x * normalX +
          state.velocity.z * normalZ
        );
        if (inwardSpeed > 0) {
          state.velocity.x += normalX * inwardSpeed;
          state.velocity.z += normalZ * inwardSpeed;
        }
        buildingContactThisStep = true;
        moved = true;
        break;
      }
      if (!moved) break;
    }
    if (buildingContactThisStep) previousState.position.copy(state.position);
  };

  const refreshBuildingSupport = () => {
    if (state.mode !== 'waddling') return;
    const roof = highestRoofAt(
      state.position.x,
      state.position.z,
      state.position.y + 0.12,
    );
    if (roof !== null) {
      state.ground = roof;
      state.position.y = Math.max(state.position.y, roof + 0.04);
      state.onWater = false;
      return;
    }
    if (
      state.ground - terrainSurfaceY > 0.8 &&
      state.position.y > terrainSurfaceY + 0.8
    ) {
      state.ground = terrainSurfaceY;
      state.mode = 'flying';
      state.velocity.y = Math.min(state.velocity.y, -0.5);
      airborneTime = 0;
      peakAgl = 0;
    }
  };

  const enforceSurfacePostcondition = () => {
    const grounded = state.mode !== 'flying';
    const speedMargin = Math.max(8, state.velocity.length() * 0.3);
    const nearSurface = state.position.y - state.ground < speedMargin;
    const shouldResample =
      buildingContactThisStep ||
      tumbleRemaining > 0 ||
      (state.mode === 'flying' && nearSurface) ||
      (grounded && finalSurfaceSampleClock <= 0);
    if (shouldResample) {
      const elevation = map.queryTerrainElevation(
        localToLngLat(state.position.x, state.position.z),
      );
      if (
        typeof elevation === 'number' &&
        isUsableTerrainElevation(elevation)
      ) {
        terrainSurfaceY = elevation;
        campusGroundFallback = elevation;
        campusGroundResolved = true;
      }
      if (grounded) finalSurfaceSampleClock = 0.045;
    }

    const roof = highestRoofAt(
      state.position.x,
      state.position.z,
      state.position.y + 0.12,
    );
    const finalGround = roof === null ? terrainSurfaceY : roof;
    state.ground = finalGround;
    if (roof !== null) state.onWater = false;
    const contactOffset = state.mode === 'planing' ? 0.02 : 0.04;
    if (state.position.y >= finalGround + contactOffset) return;

    state.position.y = finalGround + contactOffset;
    previousState.position.y = Math.max(
      previousState.position.y,
      state.position.y,
    );
    state.velocity.y = Math.max(0, state.velocity.y);
    if (state.mode === 'flying') {
      const horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);
      state.mode = state.onWater
        ? horizontalSpeed >= 3
          ? 'planing'
          : 'swimming'
        : 'waddling';
      state.bank = 0;
      state.heading = Math.atan2(state.forward.x, state.forward.z);
      queuedFlaps = 0;
      if (state.onWater) {
        waterSurfaceY = finalGround;
        waterPlaningElapsed = 0;
        waterDryTime = 0;
      }
    }
  };

  const resolveTrafficInteractions = () => {
    if (traffic.length === 0) return;
    for (const car of traffic) {
      const dx = state.position.x - car.position.x;
      const dz = state.position.z - car.position.z;
      const rightX = car.direction.z;
      const rightZ = -car.direction.x;
      const localX = dx * rightX + dz * rightZ;
      const localZ = dx * car.direction.x + dz * car.direction.z;
      const vertical = state.position.y - car.ground;
      const overlaps =
        Math.abs(localX) < 1.25 &&
        Math.abs(localZ) < 2.45 &&
        vertical > -0.2 &&
        vertical < 1.65;

      if (overlaps && hitCooldown <= 0 && car.collisionCooldown <= 0) {
        const carVelocity = car.direction.clone().multiplyScalar(car.speed);
        const relativeSpeed = state.velocity.clone().sub(carVelocity).length();
        const severity = clamp((relativeSpeed - 1.5) / 8, 0.15, 1);
        const normal = new THREE.Vector3(dx, 0, dz);
        if (normal.lengthSq() < 0.01) normal.set(rightX, 0, rightZ);
        normal.normalize();
        state.velocity.addScaledVector(normal, lerp(2, 7, severity));
        state.velocity.y = Math.max(state.velocity.y, lerp(1.2, 3.5, severity));
        tumbleRemaining = lerp(0.55, 1.35, severity);
        tumbleAngularSpeed = lerp(8, 17, severity) * (localX >= 0 ? 1 : -1);
        hitCooldown = 1;
        cameraShakeRemaining = lerp(0.12, 0.32, severity);
        queuedFlaps = 0;
        car.collisionCooldown = 5;
        car.reactionRemaining = Math.max(car.reactionRemaining, 1.8);
        car.wobbleRemaining = Math.max(car.wobbleRemaining, 1.4);
        awardChaos(
          state.mode === 'flying' ? 225 : 200,
          state.mode === 'flying' ? 'AIRBORNE CAR BOP' : 'INSURANCE FRAUD',
        );
        break;
      }

      const lowFlyby =
        state.mode === 'flying' &&
        tumbleRemaining <= 0 &&
        car.nearMissCooldown <= 0 &&
        Math.hypot(dx, dz) < 3.2 &&
        vertical >= 1.65 &&
        vertical < 3.2;
      if (lowFlyby) {
        car.nearMissCooldown = 5;
        awardChaos(125, 'CAMPUS FLYBY');
      }
    }
  };

  const beginFlapIfNeeded = () => {
    if (tumbleRemaining > 0) return;
    const spaceHeld = keys.has('Space');
    const wantsWingbeat =
      queuedFlaps > 0 || (spaceHeld && state.mode === 'flying');
    if (!wantsWingbeat || state.flapRemaining > 0) return;
    if (state.mode !== 'flying' && queuedFlaps === 0) return;

    queuedFlaps = Math.max(0, queuedFlaps - 1);
    state.flapRemaining = FLAP_PERIOD;
    state.stamina = Math.max(0, state.stamina - FLAP_STAMINA_COST);
    if (state.mode !== 'flying') {
      const forward = new THREE.Vector3(
        Math.sin(state.heading),
        0,
        Math.cos(state.heading),
      );
      const launchSpeed = Math.max(
        10.5,
        Math.hypot(state.velocity.x, state.velocity.z),
      );
      state.mode = 'flying';
      state.position.y = state.ground + 0.45;
      state.velocity
        .copy(forward)
        .multiplyScalar(launchSpeed)
        .addScaledVector(UP, 5.8);
      state.forward.copy(forward);
      waterPlaningElapsed = 0;
      waterDryTime = 0;
      waterSprayClock = 0;
      airborneTime = 0;
      peakAgl = 0;
      hooks.onToast('Wingbeat — you are airborne');
    }
  };

  const simulateWaterPlaning = (dt: number) => {
    waterPlaningElapsed += dt;
    waterDryTime = state.onWater ? 0 : waterDryTime + dt;
    if (state.onWater)
      waterSurfaceY = lerp(waterSurfaceY, state.ground, 1 - Math.exp(-3 * dt));

    const turnInput = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    const brake = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0;
    const horizontal = new THREE.Vector3(state.velocity.x, 0, state.velocity.z);
    const speed = horizontal.length();
    if (horizontal.lengthSq() < 0.01)
      horizontal.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    horizontal.normalize();
    state.heading = Math.atan2(horizontal.x, horizontal.z);
    const yawRate = lerp(0.75, 0.16, smoothstep(3, 15, speed));
    state.heading += turnInput * yawRate * dt;
    const steered = new THREE.Vector3(
      Math.sin(state.heading),
      0,
      Math.cos(state.heading),
    );
    horizontal.lerp(steered, 1 - Math.exp(-2.4 * dt)).normalize();

    const impactDrag =
      4 * waterTouchdownSeverity * Math.exp(-6 * waterPlaningElapsed);
    const drag =
      0.18 * speed + 0.025 * speed * speed + impactDrag + brake * 2.6;
    const nextSpeed = Math.max(0, speed - drag * dt);
    state.velocity.x = horizontal.x * nextSpeed;
    state.velocity.z = horizontal.z * nextSpeed;

    const plane = smoothstep(2.8, 11, nextSpeed);
    const rideHeight = 0.055 + 0.105 * plane;
    const targetY = waterSurfaceY + rideHeight;
    const omega = nextSpeed >= 3 ? 8 : 10;
    const accelerationY =
      omega * omega * (targetY - state.position.y) -
      2 * 0.9 * omega * state.velocity.y;
    state.velocity.y = clamp(state.velocity.y + accelerationY * dt, -2.2, 2.2);
    state.position.addScaledVector(state.velocity, dt);
    state.position.y = Math.max(waterSurfaceY + 0.02, state.position.y);
    state.forward.lerp(horizontal, 1 - Math.exp(-4 * dt)).normalize();
    state.bank = moveToward(state.bank, -turnInput * 5 * DEG, 1.8 * dt);
    state.alpha = moveToward(state.alpha, FLIGHT.trimAlpha, 1.2 * dt);
    state.stall = 0;
    state.stamina = Math.min(1, state.stamina + 0.09 * dt);

    waterSprayClock -= dt;
    if (nextSpeed > 3.2 && waterSprayClock <= 0) {
      waterSprayClock = lerp(0.16, 0.065, smoothstep(3, 16, nextSpeed));
      spawnSkimSpray(nextSpeed);
    }

    if (waterDryTime > 0.22) {
      state.mode = 'waddling';
      state.position.y = state.ground + 0.05;
      state.velocity.y = 0;
      state.velocity.x *= 0.62;
      state.velocity.z *= 0.62;
      waterPlaningElapsed = 0;
      hooks.onToast('Skimmed onto shore');
      return;
    }

    if (
      (nextSpeed < 2.8 && waterPlaningElapsed > 0.38) ||
      waterPlaningElapsed > 8
    ) {
      state.mode = 'swimming';
      state.position.y = waterSurfaceY + 0.04;
      state.velocity.y = 0;
      if (nextSpeed > 2.4) {
        state.velocity.x *= 2.4 / nextSpeed;
        state.velocity.z *= 2.4 / nextSpeed;
      }
      state.bank = 0;
      waterPlaningElapsed = 0;
      hooks.onToast('Planing complete — now swimming');
    }
  };

  const simulateGround = (dt: number) => {
    if (state.mode === 'swimming') {
      waterDryTime = state.onWater ? 0 : waterDryTime + dt;
      if (waterDryTime > 0.18) {
        state.mode = 'waddling';
        waterDryTime = 0;
        hooks.onToast('Waddled onto shore');
      }
    }
    const turnInput = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    const moveInput = Number(keys.has('KeyW')) - Number(keys.has('KeyS'));
    const topSpeed =
      state.mode === 'swimming' ? 2.4 : slipperyRemaining > 0 ? 7.2 : 3.8;
    state.heading += turnInput * (1.7 + Math.abs(moveInput) * 0.45) * dt;
    const forward = new THREE.Vector3(
      Math.sin(state.heading),
      0,
      Math.cos(state.heading),
    );
    const desired = forward.multiplyScalar(
      moveInput >= 0 ? moveInput * topSpeed : moveInput * 1.25,
    );
    const response =
      state.mode === 'swimming' ? 1.2 : slipperyRemaining > 0 ? 0.6 : 2.5;
    state.velocity.lerp(desired, 1 - Math.exp(-response * dt));
    state.position.addScaledVector(state.velocity, dt);
    state.position.y = state.ground + 0.04;
    state.forward.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    state.bank = moveToward(state.bank, 0, 3 * dt);
    state.alpha = FLIGHT.trimAlpha;
    state.stall = 0;
    state.stamina = Math.min(1, state.stamina + 0.18 * dt);
  };

  const simulateFlight = (dt: number) => {
    const bankInput = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    const pullInput = Number(keys.has('KeyS')) - Number(keys.has('KeyW'));
    const brake = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0;
    const speed = Math.max(state.velocity.length(), 0.1);
    const authority = lerp(0.3, 1, smoothstep(5, 11, speed));
    const bankTarget = bankInput * FLIGHT.maxBank * (1 - 0.55 * brake);
    state.bank = moveToward(
      state.bank,
      bankTarget,
      FLIGHT.maxRollRate * authority * dt,
    );

    const agl = state.position.y - state.ground;
    if (agl > ALTITUDE_BOOST_HEIGHT && !altitudeBoostActive) {
      altitudeBoostActive = true;
      hooks.onToast('JETSTREAM · 50m altitude speed boost engaged');
    } else if (agl < ALTITUDE_BOOST_RELEASE_HEIGHT) {
      altitudeBoostActive = false;
    }
    const altitudeBoost = altitudeBoostActive
      ? smoothstep(ALTITUDE_BOOST_HEIGHT, ALTITUDE_BOOST_FULL_HEIGHT, agl)
      : 0;
    const flare =
      brake *
      clamp((8 - agl) / 7, 0, 1) *
      clamp((-state.velocity.y - 0.2) / 2, 0, 1);
    const liftScale = lerp(1, 0.4, altitudeBoost);
    const neutralAlpha = neutralFlightAlpha(speed, liftScale);
    const pitchAuthority = (pullInput >= 0 ? 12 : 18) * DEG * pullInput;
    const alphaTarget = clamp(
      neutralAlpha +
        pitchAuthority +
        3 * DEG * brake +
        4 * DEG * flare +
        0.5 * DEG * Math.sin(state.bank) ** 2,
      -11 * DEG,
      20 * DEG,
    );
    const pitchResponse = pullInput < 0 ? 0.12 : 0.18;
    state.alpha +=
      (alphaTarget - state.alpha) * (1 - Math.exp(-dt / pitchResponse));

    const forward =
      speed > 2 ? state.velocity.clone().normalize() : state.forward.clone();
    state.forward.lerp(forward, 1 - Math.exp(-9 * dt)).normalize();
    const liftBase = UP.clone().addScaledVector(forward, -UP.dot(forward));
    if (liftBase.lengthSq() < 0.0001) liftBase.set(0, 0, 1);
    liftBase.normalize();
    const liftDirection = liftBase.applyAxisAngle(forward, -state.bank);

    const attachedCl = clamp(
      FLIGHT.cl0 + FLIGHT.clAlpha * state.alpha,
      FLIGHT.clMin,
      lerp(FLIGHT.clMax, 1.7, brake),
    );
    const stallStart = state.alpha >= 0 ? FLIGHT.alphaStall : 13 * DEG;
    state.stall = smoothstep(
      stallStart,
      FLIGHT.alphaDeepStall,
      Math.abs(state.alpha),
    );
    const cl = lerp(attachedCl, Math.sign(attachedCl || 1) * 0.55, state.stall);
    const cd =
      FLIGHT.cd0 +
      FLIGHT.inducedK * cl * cl +
      FLIGHT.deepStallDrag * state.stall * state.stall +
      0.12 * brake;
    const dynamicPressure = 0.5 * FLIGHT.rho * speed * speed;
    const gravityScale = lowGravityRemaining > 0 ? 0.42 : 1;
    const force = new THREE.Vector3(
      0,
      -FLIGHT.mass * FLIGHT.gravity * gravityScale,
      0,
    );
    force.addScaledVector(
      liftDirection,
      dynamicPressure * FLIGHT.wingArea * cl * liftScale,
    );
    force.addScaledVector(
      forward,
      -dynamicPressure * FLIGHT.wingArea * cd * lerp(1, 0.74, altitudeBoost),
    );
    const tailwindDirection = new THREE.Vector3(forward.x, 0, forward.z);
    if (tailwindDirection.lengthSq() < 0.001) {
      tailwindDirection.set(
        Math.sin(state.heading),
        0,
        Math.cos(state.heading),
      );
    }
    tailwindDirection.normalize();

    if (state.flapRemaining > 0) {
      const elapsed = FLAP_PERIOD - state.flapRemaining;
      const pulse =
        elapsed < DOWNSTROKE ? Math.sin((Math.PI * elapsed) / DOWNSTROKE) : 0;
      // Tired wings lose climb performance, but never silently discard an accepted input.
      const staminaScale = lerp(0.48, 1, smoothstep(0, 0.28, state.stamina));
      const lowSpeedLift = lerp(155, 58, smoothstep(2, 10, speed));
      const highSpeedThrustScale = clamp((26 - speed) / 10, 0.2, 1);
      force.addScaledVector(
        forward,
        36 * pulse * staminaScale * highSpeedThrustScale,
      );
      const commandedDiveLiftScale = lerp(1, 0.32, clamp(-pullInput, 0, 1));
      force.addScaledVector(
        liftDirection,
        lowSpeedLift * pulse * staminaScale * commandedDiveLiftScale,
      );
    } else {
      state.stamina = Math.min(1, state.stamina + 0.055 * dt);
    }

    state.velocity.addScaledVector(force, dt / FLIGHT.mass);
    if (altitudeBoost > 0) {
      const horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);
      const boostedCruise = lerp(18.5, 25.5, altitudeBoost);
      if (horizontalSpeed < boostedCruise) {
        const addedSpeed = Math.min(
          boostedCruise - horizontalSpeed,
          2.1 * altitudeBoost * dt,
        );
        state.velocity.x += tailwindDirection.x * addedSpeed;
        state.velocity.z += tailwindDirection.z * addedSpeed;
      }
      if (pullInput <= 0) {
        state.velocity.y = Math.min(
          state.velocity.y,
          lerp(3.2, 1.8, altitudeBoost),
        );
      }
    }
    const maximumSpeed = lerp(38, 44, altitudeBoost);
    if (state.velocity.length() > maximumSpeed)
      state.velocity.setLength(maximumSpeed);
    state.position.addScaledVector(state.velocity, dt);

    if (state.position.y <= state.ground + 0.05) {
      const impact = Math.max(0, -state.velocity.y);
      const landingSpeed = Math.hypot(state.velocity.x, state.velocity.z);
      const bankDegrees = Math.abs(state.bank / DEG);
      const landingCounts = airborneTime > 1.5 && peakAgl > 3;
      state.position.y = state.ground + 0.05;
      const waterRun = state.onWater && landingSpeed >= 3;
      state.mode = state.onWater
        ? waterRun
          ? 'planing'
          : 'swimming'
        : 'waddling';
      state.heading = Math.atan2(state.forward.x, state.forward.z);
      const waterSeverity = clamp(impact / 7 + bankDegrees / 90, 0, 1);
      const retainedMomentum = state.onWater
        ? lerp(0.98, 0.8, waterSeverity)
        : 0.65;
      state.velocity.set(
        state.velocity.x * retainedMomentum,
        waterRun ? clamp(impact * 0.08, 0, 0.5) : 0,
        state.velocity.z * retainedMomentum,
      );
      state.bank = waterRun ? state.bank * 0.65 : 0;
      queuedFlaps = 0;
      if (state.onWater) {
        waterSurfaceY = state.ground;
        waterPlaningElapsed = 0;
        waterDryTime = 0;
        waterTouchdownSeverity = waterSeverity;
        waterSprayClock = 0.06;
        state.position.y = waterSurfaceY + (waterRun ? 0.1 : 0.04);
        spawnSplash(clamp(0.18 + impact / 7 + landingSpeed / 30, 0.2, 1));
        waterContactLatched = true;
        waterContactReleaseTime = 0;
        if (landingCounts) {
          if (impact > 4.5 || bankDegrees > 35) awardChaos(350, 'BELLY FLOP');
          else if (impact >= 0.7 && impact < 2.3 && bankDegrees < 20)
            awardChaos(300, 'PERFECT SPLASHDOWN');
          else awardChaos(140, 'SPLASHDOWN-ISH');
        } else {
          hooks.onToast(
            impact < 2.4
              ? 'Clean water landing — splash!'
              : 'Big splash — hold Shift to flare',
          );
        }
      } else {
        if (landingCounts) {
          if (
            impact < 2 &&
            bankDegrees < 15 &&
            landingSpeed >= 8 &&
            landingSpeed <= 17
          ) {
            awardChaos(250, 'GREASED LANDING');
          } else if (impact > 4.5) {
            awardChaos(300, 'LAWN DART');
          } else {
            awardChaos(100, 'TOUCHDOWN-ISH');
          }
        } else {
          hooks.onToast(
            impact < 2.4
              ? 'Touchdown — now waddle'
              : 'Bumpy landing — flare with Shift',
          );
        }
      }
      if (!state.onWater && impact > 4.5) {
        tumbleRemaining = 0.82;
        tumbleAngularSpeed = 11 * (state.bank >= 0 ? 1 : -1);
        cameraShakeRemaining = 0.28;
      } else if (state.onWater && impact > 4.5) {
        cameraShakeRemaining = 0.18;
      }
    }
  };

  const ensureWaterEntrySplash = (dt: number) => {
    const touchingWater =
      state.onWater &&
      state.position.y <= state.ground + 0.2 &&
      highestRoofAt(
        state.position.x,
        state.position.z,
        state.position.y + 0.12,
      ) === null;
    if (!touchingWater) {
      waterContactReleaseTime += dt;
      if (waterContactReleaseTime >= 0.18) waterContactLatched = false;
      return;
    }
    waterContactReleaseTime = 0;
    if (waterContactLatched) return;

    const impact = Math.max(0, -previousState.velocity.y, -state.velocity.y);
    const horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    spawnSplash(clamp(0.2 + impact / 7 + horizontalSpeed / 30, 0.2, 1));
    waterContactLatched = true;
    waterSurfaceY = state.ground;
    waterTouchdownSeverity = clamp(impact / 7, 0, 1);
    waterPlaningElapsed = 0;
    waterDryTime = 0;
    waterSprayClock = 0.06;

    if (state.mode === 'waddling') {
      state.mode = horizontalSpeed >= 3 ? 'planing' : 'swimming';
      state.position.y = state.ground + (state.mode === 'planing' ? 0.1 : 0.04);
      state.velocity.y = 0;
    }
    hooks.onToast(impact > 4 ? 'BELLY FLOP · splash!' : 'Splash!');
  };

  const simulate = (dt: number) => {
    updateChaosTimers(dt);
    finalSurfaceSampleClock = Math.max(0, finalSurfaceSampleClock - dt);
    if (queuedHonks > 0 && honkCooldown <= 0) performHonk();
    beginFlapIfNeeded();
    surfaceClock -= dt;
    if (surfaceClock <= 0) {
      surfaceClock =
        state.mode === 'planing'
          ? 0.035
          : tumbleRemaining > 0 ||
              (state.mode === 'flying' &&
                state.position.y - state.ground < 3 &&
                state.velocity.y < 0)
            ? fixedStep
            : 0.12;
      sampleSurface();
    }
    simulateTraffic(dt);
    crowdRelocationClock -= dt;
    if (crowdRelocationClock <= 0) {
      crowdRelocationClock = 0.65;
      relocateNearbyCrowd();
    }
    campusNpcs.forEach((npc) =>
      simulateCampusNpc(npc, dt, elapsedTime, npcTerrainAt),
    );
    if (tumbleRemaining > 0) simulateTumble(dt);
    else if (state.mode === 'planing') simulateWaterPlaning(dt);
    else if (state.mode === 'flying') simulateFlight(dt);
    else simulateGround(dt);
    resolveBuildingInteractions();
    refreshBuildingSupport();
    enforceSurfacePostcondition();
    ensureWaterEntrySplash(dt);
    resolveTrafficInteractions();
    resolveCrowdInteractions();
    recruitNearbyFlock();
    updateCampusSecrets(dt);
    if (state.flapRemaining > 0) {
      state.flapRemaining = Math.max(0, state.flapRemaining - dt);
    }
  };

  const updateGoosePose = (pose: SimState, dt = 0) => {
    goose.root.position.copy(pose.position);
    const horizontalSpeed = Math.hypot(pose.velocity.x, pose.velocity.z);
    const waddleAmount =
      pose.mode === 'waddling' ? smoothstep(0.08, 1.25, horizontalSpeed) : 0;
    if (waddleAmount > 0 && dt > 0) {
      gooseWaddlePhase =
        (gooseWaddlePhase + Math.min(horizontalSpeed, 3.8) * 1.9 * dt) %
        (Math.PI * 2);
    }
    const waddle = Math.sin(gooseWaddlePhase) * waddleAmount;
    goose.root.position.y +=
      (0.5 - 0.5 * Math.cos(gooseWaddlePhase * 2)) * 0.025 * waddleAmount;

    if (pose.mode === 'flying' || pose.mode === 'planing') {
      const forward = pose.forward.clone().normalize();
      const liftBase = UP.clone()
        .addScaledVector(forward, -UP.dot(forward))
        .normalize();
      const liftDirection = liftBase.applyAxisAngle(forward, -pose.bank);
      const poseAgl = pose.position.y - pose.ground;
      const poseBoost = altitudeBoostActive
        ? smoothstep(ALTITUDE_BOOST_HEIGHT, ALTITUDE_BOOST_FULL_HEIGHT, poseAgl)
        : 0;
      const visualNeutralAlpha =
        pose.mode === 'flying'
          ? neutralFlightAlpha(
              Math.max(pose.velocity.length(), 0.1),
              lerp(1, 0.4, poseBoost),
            )
          : FLIGHT.trimAlpha;
      const visualAlpha = pose.alpha - visualNeutralAlpha;
      const bodyForward = forward
        .clone()
        .multiplyScalar(Math.cos(visualAlpha))
        .addScaledVector(liftDirection, Math.sin(visualAlpha))
        .normalize();
      const bodyUp = liftDirection
        .clone()
        .multiplyScalar(Math.cos(visualAlpha))
        .addScaledVector(forward, -Math.sin(visualAlpha))
        .normalize();
      const bodyRight = new THREE.Vector3()
        .crossVectors(bodyUp, bodyForward)
        .normalize();
      goose.root.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(bodyRight, bodyUp, bodyForward),
      );
      goose.legs.visible = false;
      setGooseLegStride(goose, 0);
      goose.leftWing.scale.set(1, 1, 1);
      goose.rightWing.scale.set(1, 1, 1);
      if (pose.flapRemaining > 0) {
        const phase = (FLAP_PERIOD - pose.flapRemaining) / FLAP_PERIOD;
        const flapAngle = 0.12 - 0.62 * Math.cos(phase * Math.PI * 2);
        goose.leftWing.rotation.z = flapAngle;
        goose.rightWing.rotation.z = -flapAngle;
      } else {
        goose.leftWing.rotation.z = -0.1 - pose.bank * 0.1;
        goose.rightWing.rotation.z = 0.1 - pose.bank * 0.1;
      }
    } else {
      goose.root.rotation.set(0, pose.heading, -waddle * 0.035);
      goose.legs.visible = pose.mode === 'waddling';
      setGooseLegStride(goose, waddle);
      goose.leftWing.scale.set(0.42, 1, 0.84);
      goose.rightWing.scale.set(0.42, 1, 0.84);
      goose.leftWing.rotation.z = -0.66;
      goose.rightWing.rotation.z = 0.66;
    }

    if (tumbleRemaining > 0) {
      const tumble = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          tumbleAngle * 0.72,
          tumbleAngle,
          tumbleAngle * 0.48,
          'YXZ',
        ),
      );
      goose.root.quaternion.multiply(tumble).normalize();
    }
  };

  const updateCamera = (dt: number, pose: SimState, immediate = false) => {
    const inputBlend = immediate ? 1 : 1 - Math.exp(-12 * dt);
    cameraDistanceScale = lerp(
      cameraDistanceScale,
      cameraDistanceTarget,
      inputBlend,
    );
    const yawDelta = Math.atan2(
      Math.sin(cameraOrbitYawTarget - cameraOrbitYaw),
      Math.cos(cameraOrbitYawTarget - cameraOrbitYaw),
    );
    cameraOrbitYaw += yawDelta * inputBlend;
    cameraOrbitPitch = lerp(
      cameraOrbitPitch,
      cameraOrbitPitchTarget,
      inputBlend,
    );

    const horizontal = new THREE.Vector3(pose.forward.x, 0, pose.forward.z);
    if (horizontal.lengthSq() < 0.01)
      horizontal.set(Math.sin(pose.heading), 0, Math.cos(pose.heading));
    horizontal.normalize();
    const speed = clamp(pose.velocity.length(), 8, 26);
    const isFlying = pose.mode === 'flying' || pose.mode === 'planing';
    const orbitOrigin = pose.position.clone().addScaledVector(UP, 0.65);
    const radial = horizontal
      .clone()
      .multiplyScalar(-1)
      .applyAxisAngle(UP, cameraOrbitYaw);
    const distance =
      (isFlying ? 8.7 + 0.035 * speed : 5.65) * cameraDistanceScale;
    const desiredPosition = orbitOrigin
      .clone()
      .addScaledVector(radial, distance * Math.cos(cameraOrbitPitch))
      .addScaledVector(UP, distance * Math.sin(cameraOrbitPitch));

    // Pull the chase camera forward when a wall sits between it and the goose.
    // Raising it to the roof (the old behavior) changed the real camera distance
    // and made zoom clicks appear to do nothing beside large buildings.
    let obstructionTime = 1;
    refreshActiveBuildingColliders();
    for (const building of activeBuildingColliders) {
      if (
        Math.max(orbitOrigin.x, desiredPosition.x) < building.minX - 0.3 ||
        Math.min(orbitOrigin.x, desiredPosition.x) > building.maxX + 0.3 ||
        Math.max(orbitOrigin.z, desiredPosition.z) < building.minZ - 0.3 ||
        Math.min(orbitOrigin.z, desiredPosition.z) > building.maxZ + 0.3
      )
        continue;
      const crossing = firstBuildingCrossing(
        orbitOrigin.x,
        orbitOrigin.z,
        desiredPosition.x,
        desiredPosition.z,
        building,
        0.28,
      );
      if (!crossing || crossing.t >= obstructionTime) continue;
      const crossingY = lerp(orbitOrigin.y, desiredPosition.y, crossing.t);
      if (
        crossingY < building.ground + building.height + 0.45 &&
        crossingY + 0.25 > building.ground
      ) {
        obstructionTime = crossing.t;
      }
    }
    if (obstructionTime < 1) {
      desiredPosition.lerpVectors(
        orbitOrigin,
        desiredPosition,
        Math.max(0.16, obstructionTime - 0.055),
      );
    }
    desiredPosition.y = Math.max(
      desiredPosition.y,
      terrainAt(desiredPosition.x, desiredPosition.z, pose.ground) + 1.5,
    );
    const shake = clamp(cameraShakeRemaining / 0.32, 0, 1);
    if (!immediate && shake > 0) {
      desiredPosition.x += Math.sin(elapsedTime * 91) * 0.48 * shake;
      desiredPosition.y += Math.sin(elapsedTime * 117 + 0.6) * 0.3 * shake;
      desiredPosition.z += Math.cos(elapsedTime * 83) * 0.48 * shake;
    }
    const lookAhead =
      (isFlying ? 1.2 : 0.7) * Math.max(0, Math.cos(cameraOrbitYaw));
    const terrainLookDown = isFlying
      ? lerp(0.35, 1.2, smoothstep(6, 78, pose.position.y - pose.ground))
      : 0;
    const desiredTarget = orbitOrigin
      .clone()
      .addScaledVector(horizontal, lookAhead)
      .addScaledVector(UP, -terrainLookDown);
    const positionBlend = immediate ? 1 : 1 - Math.exp(-5 * dt);
    const targetBlend = immediate ? 1 : 1 - Math.exp(-7 * dt);
    cameraPosition.lerp(desiredPosition, positionBlend);
    cameraTarget.lerp(desiredTarget, targetBlend);
    const options = map.calculateCameraOptionsFromTo(
      localToLngLat(cameraPosition.x, cameraPosition.z),
      cameraPosition.y,
      localToLngLat(cameraTarget.x, cameraTarget.z),
      cameraTarget.y,
    );
    const nextCamera = {
      ...options,
      roll: clamp((-pose.bank / DEG) * 0.12, -6, 6),
    };
    // MapLibre 6 can ask an overzoomed DEM for out-of-range pixels when jumpTo
    // receives a close real-world camera. The target elevation is already part
    // of nextCamera, so skip only that redundant internal terrain sample while
    // leaving the terrain renderer itself enabled.
    const cameraBridge = map as unknown as {
      _camera?: { terrain: unknown };
    };
    const activeTerrain = cameraBridge._camera?.terrain;
    if (cameraBridge._camera && activeTerrain) {
      cameraBridge._camera.terrain = null;
      try {
        map.jumpTo(nextCamera);
      } finally {
        cameraBridge._camera.terrain = activeTerrain;
      }
    } else {
      map.jumpTo(nextCamera);
    }
  };

  const emitTelemetry = () => {
    const horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    const sink = -state.velocity.y;
    const nearestNpc = campusNpcs.reduce<{
      distance: number;
      npc: CampusNpc;
    } | null>((nearest, npc) => {
      const distance = Math.hypot(
        npc.position.x - state.position.x,
        npc.position.z - state.position.z,
      );
      return nearest === null || distance < nearest.distance
        ? { distance, npc }
        : nearest;
    }, null);
    const studentsNearby = campusNpcs.reduce(
      (count, npc) =>
        Math.hypot(
          npc.position.x - state.position.x,
          npc.position.z - state.position.z,
        ) <= 55
          ? count + 1
          : count,
      0,
    );
    const studentsOnMappedWalkways = campusNpcs.reduce(
      (count, npc) => count + (npc.route.isMappedWalkway ? 1 : 0),
      0,
    );
    const nearestSecret = campusSecrets.reduce<{
      secret: CampusSecret;
      distance: number;
    } | null>((nearest, secret) => {
      if (secret.found) return nearest;
      const distance = Math.hypot(
        secret.position.x - state.position.x,
        secret.position.z - state.position.z,
      );
      return nearest === null || distance < nearest.distance
        ? { secret, distance }
        : nearest;
    }, null);
    const duckCouncil = campusSecrets.find(
      (secret) => secret.id === 'duck-council',
    );
    const visualHeading =
      Math.hypot(state.forward.x, state.forward.z) > 0.001
        ? Math.atan2(state.forward.x, state.forward.z)
        : state.heading;
    const cameraBearing = visualHeading + cameraOrbitYaw;
    const secretBearing = nearestSecret
      ? Math.atan2(
          nearestSecret.secret.position.x - state.position.x,
          nearestSecret.secret.position.z - state.position.z,
        )
      : cameraBearing;
    const nearestSecretDirection =
      Math.atan2(
        Math.sin(secretBearing - cameraBearing),
        Math.cos(secretBearing - cameraBearing),
      ) / DEG;
    const agl = Math.max(0, state.position.y - state.ground);
    const altitudeBoost = altitudeBoostActive
      ? smoothstep(ALTITUDE_BOOST_HEIGHT, ALTITUDE_BOOST_FULL_HEIGHT, agl)
      : 0;
    const recruitableGooseInRange = flockGeese.some((member) => {
      if (member.recruited || !member.terrainResolved) return false;
      return (
        Math.hypot(
          state.position.x - member.home.x,
          state.position.z - member.home.y,
        ) <= 14 && Math.abs(state.position.y - member.ground) <= 8
      );
    });
    refreshActiveBuildingColliders();
    const insideBuilding = activeBuildingColliders.some((building) => {
      const roof = building.ground + building.height;
      return (
        state.position.y < roof - 0.015 &&
        state.position.y + 0.92 > building.ground &&
        pointInBuilding(state.position.x, state.position.z, building)
      );
    });
    const projectedGoose = state.position
      .clone()
      .applyMatrix4(camera.projectionMatrix);
    const mapCanvas = map.getCanvas();
    hooks.onTelemetry({
      speed:
        state.mode === 'flying' || state.mode === 'planing'
          ? state.velocity.length()
          : horizontalSpeed,
      agl,
      sink,
      glideRatio:
        state.mode === 'flying' && sink > 0.2
          ? clamp(horizontalSpeed / sink, 0, 99)
          : null,
      stamina: state.stamina,
      stall: state.stall,
      mode: state.mode,
      score: chaosScore,
      combo: chaosCombo,
      secretsFound,
      secretsTotal: campusSecrets.length,
      secretVisuals: campusSecrets.filter((secret) => secret.group.visible)
        .length,
      nearestSecretLabel: nearestSecret?.secret.group.name ?? null,
      nearestSecretDistance: nearestSecret?.distance ?? null,
      nearestSecretDirection,
      nearestSecretBearing: secretBearing / DEG,
      students: campusNpcs.length,
      studentsNearby,
      studentsOnMappedWalkways,
      nearestStudent: nearestNpc?.distance ?? null,
      nearestStudentVertical: nearestNpc
        ? nearestNpc.npc.position.y - state.ground
        : null,
      trees: treeCount,
      treesResolved: treeCount - unresolvedTreeCount,
      flockSize: recruitedFlockCount,
      flockTotal: flockGeese.length,
      recruitableGooseInRange,
      altitudeBoost,
      groundElevation: state.ground,
      east: state.position.x,
      north: state.position.z,
      heading: visualHeading,
      buildings: buildingColliders.length,
      cameraZoom: map.getZoom(),
      cameraScale: cameraDistanceScale,
      insideBuilding,
      renderCalls: lastRenderCalls,
      gooseVisible: goose.root.visible,
      gooseScreenX: (projectedGoose.x * 0.5 + 0.5) * mapCanvas.clientWidth,
      gooseScreenY: (-projectedGoose.y * 0.5 + 0.5) * mapCanvas.clientHeight,
      duckCouncilEast: duckCouncil?.position.x ?? 0,
      duckCouncilNorth: duckCouncil?.position.z ?? 0,
      duckCouncilVisible: duckCouncil?.group.visible ?? false,
    });
  };

  const resetState = (clearProgress = false, updateView = true) => {
    const spawnPoint = new THREE.Vector2(0, 0);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const containingBuilding = buildingColliders.find((building) =>
        pointInBuilding(spawnPoint.x, spawnPoint.y, building),
      );
      if (!containingBuilding) break;
      const boundary = closestBuildingBoundary(
        spawnPoint.x,
        spawnPoint.y,
        containingBuilding,
      );
      let outwardX = boundary.x - spawnPoint.x;
      let outwardZ = boundary.z - spawnPoint.y;
      const outwardLength = Math.hypot(outwardX, outwardZ) || 1;
      outwardX /= outwardLength;
      outwardZ /= outwardLength;
      spawnPoint.set(boundary.x + outwardX * 3, boundary.z + outwardZ * 3);
    }
    const spawnGround = terrainAt(spawnPoint.x, spawnPoint.y, state.ground);
    campusGroundFallback = spawnGround;
    if (!campusGroundResolved && Math.abs(spawnGround) >= 20)
      campusGroundResolved = true;
    if (!cloudBaseResolved && campusGroundResolved) {
      cloudBaseElevation = spawnGround;
      cloudBaseResolved = true;
    }
    state.ground = spawnGround;
    state.position.set(
      spawnPoint.x,
      spawnGround + SPAWN_ALTITUDE,
      spawnPoint.y,
    );
    state.velocity.set(0, -0.4, SPAWN_SPEED);
    state.forward.set(0, 0, 1);
    state.heading = 0;
    state.bank = 0;
    state.alpha = FLIGHT.trimAlpha;
    state.stamina = 1;
    state.stall = 0;
    state.mode = 'flying';
    state.onWater = false;
    state.flapRemaining = 0;
    queuedFlaps = 0;
    queuedHonks = 0;
    gooseWaddlePhase = 0;
    honkCooldown = 0;
    if (clearProgress) {
      chaosScore = 0;
      campusInfamyUnlocked = false;
    }
    infamyPanicClock = 0;
    chaosCombo = 1;
    chaosComboEvents = 0;
    chaosComboRemaining = 0;
    tumbleRemaining = 0;
    tumbleAngle = 0;
    tumbleAngularSpeed = 0;
    hitCooldown = 0;
    buildingHitCooldown = 0;
    cameraShakeRemaining = 0;
    lowGravityRemaining = 0;
    megaHonkRemaining = 0;
    slipperyRemaining = 0;
    airborneTime = 0;
    peakAgl = 0;
    waterSurfaceY = spawnGround;
    terrainSurfaceY = spawnGround;
    finalSurfaceSampleClock = 0;
    waterPlaningElapsed = 0;
    waterDryTime = 0;
    waterTouchdownSeverity = 0;
    waterSprayClock = 0;
    waterContactLatched = false;
    waterContactReleaseTime = 0;
    altitudeBoostActive = false;
    cameraDistanceScale = 1;
    cameraDistanceTarget = 1;
    cameraOrbitYaw = 0;
    cameraOrbitYawTarget = 0;
    cameraOrbitPitch = 24 * DEG;
    cameraOrbitPitchTarget = 24 * DEG;
    crowdRelocationClock = 0;
    accumulator = 0;
    relocateNearbyCrowd(true);
    campusNpcs.forEach((npc, index) => {
      campusNpcs[index] = createCampusNpc(
        index,
        npc.route,
        npc.distance,
        npcTerrainAt,
      );
    });
    for (const wave of honkWaves.splice(0)) {
      scene.remove(wave.mesh);
      wave.mesh.geometry.dispose();
      wave.mesh.material.dispose();
    }
    cameraPosition.set(spawnPoint.x, state.position.y + 2.8, spawnPoint.y - 5);
    cameraTarget.set(spawnPoint.x, state.position.y + 0.65, spawnPoint.y + 1.8);
    sampleSurface();
    refreshActiveBuildingColliders(true);
    settleFlockRoosts();
    updateTrees(false);
    campusSecrets.forEach((secret, index) => {
      secret.terrainRefreshRemaining = (index % 8) * 0.06;
      if (!secret.terrainResolved) {
        secret.position.y = campusGroundFallback + secret.altitude;
        secret.group.position.y = secret.position.y;
        secret.group.userData.baseY = secret.position.y;
      }
    });
    if (clearProgress) {
      recruitedFlockCount = 0;
      flockGeese.forEach((member) => {
        member.recruited = false;
        member.position.set(member.home.x, member.ground + 0.04, member.home.y);
      });
    }
    flockGeese.forEach((member) => {
      member.waddlePhase = member.phase;
      member.waterContactLatched = false;
      member.waterContactReleaseTime = 0;
      setGooseLegStride(member.rig, 0);
    });
    copyState(previousState, state);
    copyState(renderState, state);
    updateGoosePose(renderState);
    updateFlockVisuals(0, renderState);
    setGameplayVisibility(playing);
    if (updateView) updateCamera(1 / 60, renderState, true);
    emitTelemetry();
  };

  const customLayer: CustomLayerInterface = {
    id: 'goose-shared-3d-world',
    type: 'custom',
    renderingMode: '3d',
    onAdd(_map, gl) {
      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl as WebGLRenderingContext,
        antialias: true,
      });
      renderer.autoClear = false;
    },
    render(_gl, args) {
      if (!renderer) return;
      camera.projectionMatrix
        .copy(
          new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix),
        )
        .multiply(localToMap);
      renderer.resetState();
      renderer.render(scene, camera);
      lastRenderCalls = renderer.info.render.calls;
    },
    onRemove() {
      renderer?.dispose();
      renderer = null;
    },
  };

  map.addLayer(customLayer, customLayerBeforeId);

  const onIdle = () => {
    collectMappedWaterAreas();
    const hadTraffic = trafficBuilt;
    buildTraffic();
    const crowdChanged = collectPedestrianRoutes();
    const buildingsChanged =
      buildingColliders.length === 0 ? buildTexturedBuildings() : false;
    const woodlandChanged = collectMappedWoodlandTrees();
    const treePlacementsChanged = refreshTreePlacementMask();
    if (!hadTraffic && trafficBuilt) updateTrafficVisuals(1);
    if (
      (!hadTraffic && trafficBuilt) ||
      crowdChanged ||
      buildingsChanged ||
      woodlandChanged ||
      treePlacementsChanged
    )
      map.triggerRepaint();
  };
  const onSourceData = (event: MapSourceDataEvent) => {
    if (event.sourceDataType !== 'content') return;
    if (event.sourceId === buildingSourceId) {
      buildingRefreshRequested = true;
      buildingRefreshClock = Math.min(buildingRefreshClock, 0.08);
    }
    if (terrainSourceId && event.sourceId === terrainSourceId) {
      buildingRefreshRequested = true;
      treeRefreshClock = Math.min(treeRefreshClock, 0.12);
      campusSecrets.forEach((secret, index) => {
        secret.terrainRefreshRemaining = Math.min(
          secret.terrainRefreshRemaining,
          0.08 + (index % 8) * 0.06,
        );
      });
      flockGeese.forEach((member, index) => {
        member.terrainRefreshRemaining = Math.min(
          member.terrainRefreshRemaining,
          0.06 + index * 0.055,
        );
      });
    }
  };
  map.on('idle', onIdle);
  map.on('sourcedata', onSourceData);
  onIdle();

  const frame = (now: number) => {
    if (destroyed) return;
    const frameDt = Math.min(0.1, Math.max(0, (now - previousTime) / 1000));
    previousTime = now;
    elapsedTime += frameDt;
    buildingRefreshClock = Math.max(0, buildingRefreshClock - frameDt);
    if (!buildingRefreshRequested && buildingRefreshClock <= 0) {
      refreshActiveBuildingColliders();
      buildingRefreshRequested = activeBuildingColliders.some(
        (building) =>
          !building.terrainResolved || elapsedTime >= building.terrainRefreshAt,
      );
      if (!buildingRefreshRequested) buildingRefreshClock = 0.2;
    }
    if (buildingRefreshRequested && buildingRefreshClock <= 0) {
      buildingRefreshRequested = false;
      buildingRefreshClock = 0.28;
      if (buildTexturedBuildings()) {
        refreshTreePlacementMask();
        map.triggerRepaint();
      }
    }
    if (playing) {
      accumulator += frameDt;
      let steps = 0;
      while (accumulator >= fixedStep && steps < 5) {
        copyState(previousState, state);
        simulate(fixedStep);
        accumulator -= fixedStep;
        steps += 1;
      }
      if (steps >= 5) accumulator = 0;
      interpolateState(accumulator / fixedStep);
      if (trafficBuilt) updateTrafficVisuals(accumulator / fixedStep);
      if (campusNpcs.length > 0)
        updateCrowdVisuals(
          crowdFleet,
          campusNpcs,
          accumulator / fixedStep,
          elapsedTime,
        );
      treeRefreshClock -= frameDt;
      if (treeRefreshClock <= 0) {
        treeRefreshClock = 1.25;
        updateTrees(true);
      }
      cloudRefreshClock -= frameDt;
      if (cloudRefreshClock <= 0) {
        cloudRefreshClock = 0.12;
        updateClouds();
      }
    }
    updateSplashes(frameDt);
    updateHonkWaves(frameDt);
    updateGoosePose(renderState, frameDt);
    if (playing) {
      updateFlockVisuals(frameDt, renderState);
      updateCamera(frameDt, renderState);
    }
    telemetryClock -= frameDt;
    if (telemetryClock <= 0) {
      telemetryClock = 0.1;
      emitTelemetry();
    }
    if (playing || splashes.length > 0 || honkWaves.length > 0)
      map.triggerRepaint();
    animationFrame = requestAnimationFrame(frame);
  };

  resetState(true, false);
  animationFrame = requestAnimationFrame(frame);

  return {
    start() {
      unlockAudio();
      playing = true;
      setGameplayVisibility(true);
      previousTime = performance.now();
      updateCamera(1 / 60, renderState, true);
      hooks.onToast(
        'Twenty-six campus secrets are live — find the runaway WMU Bronco and build your flock',
      );
    },
    reset() {
      unlockAudio();
      playing = true;
      resetState();
      setGameplayVisibility(true);
      previousTime = performance.now();
      hooks.onToast(
        'Respawned above WMU — your secret discoveries and score are safe',
      );
    },
    setKey(code, pressed) {
      if (pressed) {
        if (code === 'Space' && !keys.has(code) && tumbleRemaining <= 0) {
          queuedFlaps = Math.min(2, queuedFlaps + 1);
        }
        if ((code === 'KeyE' || code === 'KeyH') && !keys.has(code)) {
          unlockAudio();
          queuedHonks = Math.min(1, queuedHonks + 1);
        }
        keys.add(code);
      } else {
        keys.delete(code);
      }
    },
    scaleCameraZoom(multiplier) {
      cameraDistanceTarget = clamp(
        cameraDistanceTarget * multiplier,
        0.28,
        3.4,
      );
      cameraDistanceScale = cameraDistanceTarget;
      updateCamera(1 / 60, renderState, true);
      map.triggerRepaint();
    },
    orbitCamera(yawDelta, pitchDelta) {
      cameraOrbitYawTarget =
        ((cameraOrbitYawTarget + yawDelta + Math.PI * 3) % (Math.PI * 2)) -
        Math.PI;
      cameraOrbitPitchTarget = clamp(
        cameraOrbitPitchTarget + pitchDelta,
        10 * DEG,
        72 * DEG,
      );
      map.triggerRepaint();
    },
    resetCamera() {
      cameraDistanceTarget = 1;
      cameraDistanceScale = cameraDistanceTarget;
      cameraOrbitYawTarget = 0;
      cameraOrbitYaw = cameraOrbitYawTarget;
      cameraOrbitPitchTarget = 24 * DEG;
      cameraOrbitPitch = cameraOrbitPitchTarget;
      updateCamera(1 / 60, renderState, true);
      map.triggerRepaint();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(animationFrame);
      map.off('idle', onIdle);
      map.off('sourcedata', onSourceData);
      keys.clear();
      if (audioContext) {
        void audioContext.close().catch(() => undefined);
        audioContext = null;
      }
      scene.traverse((object) => {
        if (
          object instanceof THREE.Mesh ||
          object instanceof THREE.InstancedMesh
        ) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material)
            ? object.material
            : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      buildingMaterials.forEach(({ texture }) => texture.dispose());
      buildingMaterials.clear();
    },
  };
}
