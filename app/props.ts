// Phase 2: wreckable campus props (cones, benches, trash cans, bike racks,
// signs, flags).
//
// Every prop is a tiny rigid body: a bounding sphere with a velocity, an
// angular velocity and a quaternion, integrated the same way campus-crowd.ts
// integrates a ragdolled student (gravity, ground bounce, drag, rest
// detection). That is deliberate: the game already ships that motion and it
// reads well, so props reuse the approach instead of pulling in a physics
// engine for six kinds of street furniture.
//
// The system owns its meshes and its bodies; the engine owns the world. Every
// query that needs world knowledge (terrain, water, buildings, scoring, camera)
// arrives as a callback in the options, so this file never imports the engine
// and can be reasoned about on its own.

import * as THREE from 'three';

import { knockDownCampusNpc, type CampusNpc } from './campus-crowd';
import type {
  FlightMode,
  GameEvent,
  PropKind,
  PropPlacement,
} from './game-contract';

/** Total live bodies across every kind. Sized for the perf budget, not the art. */
const PROP_CAPACITY = 160;
/** Mirrors FLIGHT.mass in game-engine.ts; the impulse split needs both masses. */
const GOOSE_MASS = 4.5;
const GRAVITY = 9.81;
const RESTITUTION = 0.25;
const AIR_DRAG = 0.38;
const ROLLING_FRICTION = 4.2;
const GROUND_SPIN_FRICTION = 3.6;
const AIR_SPIN_FRICTION = 0.5;
const SLEEP_DELAY = 0.6;
/** A wrecked prop only counts again once it has rested this long somewhere new. */
const REWRECK_SLEEP_SECONDS = 6;
const WRECK_DISTANCE = 0.6;
/** cos(60 degrees): a prop tipped further than this counts as wrecked. */
const WRECK_TILT_COSINE = 0.5;
const MAX_ANGULAR_SPEED = 13;
const CONE_COMBO_SECONDS = 4;
const CONE_COMBO_TARGET = 5;
const POI_RECYCLE_DISTANCE = 1_600;
const POI_RECYCLE_INTERVAL = 0.8;
const GROUND_REFRESH_SECONDS = 0.09;
const BUILDING_REFRESH_SECONDS = 0.12;
/** Sleeping props re-sample terrain a couple at a time so a late DEM lands them. */
const SETTLE_PER_STEP = 2;
const TWO_PI = Math.PI * 2;

const KIND_ORDER: readonly PropKind[] = [
  'cone',
  'bench',
  'trash',
  'bike',
  'sign',
  'flag',
];

type PropProfile = {
  mass: number;
  /** Collision sphere; also the clearance kept from building walls. */
  radius: number;
  /** Height of the body center above the ground when the prop is at rest. */
  groundOffset: number;
  label: string;
  id: string;
  points: number;
};

const PROFILES: Record<PropKind, PropProfile> = {
  cone: {
    mass: 2,
    radius: 0.36,
    groundOffset: 0.31,
    label: 'CONE CROWN',
    id: 'cone-crown',
    points: 60,
  },
  bench: {
    mass: 30,
    radius: 0.85,
    groundOffset: 0.25,
    label: 'BENCH PRESS',
    id: 'bench-press',
    points: 180,
  },
  trash: {
    mass: 6,
    radius: 0.55,
    groundOffset: 0.48,
    label: 'TRASH PANDA (GOOSE)',
    id: 'trash-panda-goose',
    points: 120,
  },
  bike: {
    mass: 12,
    radius: 0.88,
    groundOffset: 0.37,
    label: 'RACK AND ROLL',
    id: 'rack-and-roll',
    points: 150,
  },
  sign: {
    mass: 15,
    radius: 1,
    groundOffset: 0.95,
    label: 'SIGN LANGUAGE',
    id: 'sign-language',
    points: 140,
  },
  flag: {
    mass: 5,
    radius: 1.25,
    groundOffset: 1.2,
    label: 'FLAG ON THE PLAY',
    id: 'flag-on-the-play',
    points: 130,
  },
};

export type PropGroundSampler = (
  east: number,
  north: number,
  fallback: number,
) => number;

/**
 * Keeps a prop outside building walls. The point carries `y` as well as `x`/`z`
 * so the engine can tell a prop standing on a roof (inside the footprint, above
 * it) from one stuck in a wall, and only push the second one out.
 */
export type PropBuildingResolver = (
  point: { x: number; y: number; z: number },
  radius: number,
) => { pushed: boolean };

export type PropSystemOptions = {
  scene: THREE.Scene;
  /** Highest walkable surface: terrain, or a roof when one is higher. */
  groundAt: PropGroundSampler;
  isWater: (east: number, north: number) => boolean;
  resolveBuilding: PropBuildingResolver;
  awardChaos: (
    points: number,
    label: string,
    options?: { id?: string; subject?: string },
  ) => void;
  recordEvent: (event: GameEvent) => void;
  shake: (seconds: number) => void;
  isInView: (east: number, elevation: number, north: number) => boolean;
};

/** What the simulation needs to know about the goose to bounce props off it. */
export type PropGooseProbe = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  prevPosition: THREE.Vector3;
  radius: number;
  mode: FlightMode;
};

/** The slice of a traffic car this system touches. */
export type PropCar = {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  speed: number;
  ground: number;
  wobbleRemaining: number;
  reactionRemaining: number;
};

export type PropPoi = {
  east: number;
  north: number;
  kind: PropKind;
};

export type PropStats = {
  props: number;
  propsAwake: number;
};

export type AuthoredToLocal = (east: number, north: number) => THREE.Vector2;

export type PropSystem = {
  spawnFromPlacements: (
    placements: readonly PropPlacement[],
    authoredToLocal: AuthoredToLocal,
    focus?: { x: number; z: number },
  ) => void;
  spawnFromPois: (points: readonly PropPoi[]) => void;
  step: (dt: number, goose: PropGooseProbe) => void;
  updateVisuals: (blend: number, elapsed: number) => void;
  setVisible: (visible: boolean) => void;
  resetAll: () => void;
  stats: () => PropStats;
  collideCars: (cars: readonly PropCar[]) => void;
  collideStudents: (npcs: readonly CampusNpc[]) => void;
  nearest: (point: THREE.Vector3, radius: number) => string | null;
  /** What a prop id refers to; the grab code needs the kind and the mass. */
  describe: (id: string) => { kind: PropKind; mass: number } | null;
  hold: (id: string, target: THREE.Vector3) => boolean;
  release: (id: string, velocity: THREE.Vector3) => boolean;
  dispose: () => void;
};

type Prop = {
  id: string;
  kind: PropKind;
  /** Hand-authored props are never recycled by distance. */
  permanent: boolean;
  /** Stable spawn key, so respawning the same table never duplicates a prop. */
  key: string;
  home: THREE.Vector3;
  position: THREE.Vector3;
  previousPosition: THREE.Vector3;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  quaternion: THREE.Quaternion;
  previousQuaternion: THREE.Quaternion;
  ground: number;
  groundRefresh: number;
  buildingRefresh: number;
  awake: boolean;
  restTime: number;
  sleepTime: number;
  wrecked: boolean;
  held: boolean;
  holdTarget: THREE.Vector3 | null;
  gooseCooldown: number;
  carCooldown: number;
};

type PropPart = {
  geometry: THREE.BufferGeometry;
  color: number;
  x?: number;
  y?: number;
  z?: number;
  rotationX?: number;
  rotationY?: number;
  rotationZ?: number;
};

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

function hash01(index: number, salt: number) {
  let value =
    Math.imul(index + 1, 0x45d9f3b) ^ Math.imul(salt + 11, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 4_294_967_296;
}

const partPosition = new THREE.Vector3();
const partEuler = new THREE.Euler();
const partQuaternion = new THREE.Quaternion();
const partScale = new THREE.Vector3(1, 1, 1);
const partMatrix = new THREE.Matrix4();

/**
 * Bakes a handful of primitives into one geometry with baked vertex colors, so
 * a whole kind renders as a single InstancedMesh draw and still shows an orange
 * cone with a white band or a brown sign board with a gold face.
 */
function mergeParts(parts: PropPart[]) {
  const chunks = parts.map((part) => {
    const source = part.geometry;
    const geometry = source.index ? source.toNonIndexed() : source;
    partPosition.set(part.x ?? 0, part.y ?? 0, part.z ?? 0);
    partEuler.set(
      part.rotationX ?? 0,
      part.rotationY ?? 0,
      part.rotationZ ?? 0,
      'XYZ',
    );
    partQuaternion.setFromEuler(partEuler);
    partMatrix.compose(partPosition, partQuaternion, partScale);
    geometry.applyMatrix4(partMatrix);
    if (geometry !== source) source.dispose();
    return { geometry, color: new THREE.Color(part.color) };
  });

  let total = 0;
  for (const chunk of chunks) {
    total += chunk.geometry.getAttribute('position').count;
  }
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  let offset = 0;
  for (const chunk of chunks) {
    const position = chunk.geometry.getAttribute('position');
    const normal = chunk.geometry.getAttribute('normal');
    for (let index = 0; index < position.count; index += 1) {
      const write = (offset + index) * 3;
      positions[write] = position.getX(index);
      positions[write + 1] = position.getY(index);
      positions[write + 2] = position.getZ(index);
      normals[write] = normal ? normal.getX(index) : 0;
      normals[write + 1] = normal ? normal.getY(index) : 1;
      normals[write + 2] = normal ? normal.getZ(index) : 0;
      colors[write] = chunk.color.r;
      colors[write + 1] = chunk.color.g;
      colors[write + 2] = chunk.color.b;
    }
    offset += position.count;
    chunk.geometry.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return merged;
}

const WMU_BROWN = 0x4b2e19;
const WMU_GOLD = 0xd7a12c;

/** Each geometry's origin is the body center, its base at -groundOffset. */
function buildPropGeometry(kind: PropKind) {
  if (kind === 'cone') {
    return mergeParts([
      { geometry: new THREE.ConeGeometry(0.24, 0.62, 10), color: 0xe4621f },
      {
        geometry: new THREE.CylinderGeometry(0.136, 0.153, 0.1, 10),
        color: 0xf2f0e8,
        y: -0.02,
      },
      {
        geometry: new THREE.BoxGeometry(0.44, 0.05, 0.44),
        color: 0xc9541a,
        y: -0.285,
      },
    ]);
  }
  if (kind === 'bench') {
    return mergeParts([
      {
        geometry: new THREE.BoxGeometry(1.6, 0.09, 0.45),
        color: 0x8a5a33,
        y: 0.2,
      },
      {
        geometry: new THREE.BoxGeometry(0.1, 0.42, 0.4),
        color: 0x3b3f42,
        x: -0.66,
        y: -0.05,
      },
      {
        geometry: new THREE.BoxGeometry(0.1, 0.42, 0.4),
        color: 0x3b3f42,
        x: 0.66,
        y: -0.05,
      },
    ]);
  }
  if (kind === 'trash') {
    return mergeParts([
      {
        geometry: new THREE.CylinderGeometry(0.3, 0.26, 0.86, 12),
        color: 0x2f3a33,
        y: -0.05,
      },
      {
        geometry: new THREE.CylinderGeometry(0.34, 0.34, 0.08, 12),
        color: 0x1e2622,
        y: 0.42,
      },
    ]);
  }
  if (kind === 'bike') {
    // Torus lies in its local XY plane, so a quarter turn about Y stands the
    // wheels up along the bike's length.
    return mergeParts([
      {
        geometry: new THREE.TorusGeometry(0.32, 0.045, 6, 14),
        color: 0x1b1d1f,
        z: -0.53,
        rotationY: Math.PI / 2,
      },
      {
        geometry: new THREE.TorusGeometry(0.32, 0.045, 6, 14),
        color: 0x1b1d1f,
        z: 0.53,
        rotationY: Math.PI / 2,
      },
      {
        geometry: new THREE.BoxGeometry(0.05, 0.05, 1.06),
        color: 0xb04a2f,
        y: 0.2,
      },
      {
        geometry: new THREE.BoxGeometry(0.42, 0.05, 0.05),
        color: 0x1b1d1f,
        y: 0.33,
        z: 0.46,
      },
    ]);
  }
  if (kind === 'sign') {
    return mergeParts([
      {
        geometry: new THREE.CylinderGeometry(0.045, 0.045, 1.9, 8),
        color: 0x6b6f73,
      },
      {
        geometry: new THREE.BoxGeometry(0.92, 0.62, 0.06),
        color: WMU_BROWN,
        y: 0.55,
      },
      {
        geometry: new THREE.BoxGeometry(0.78, 0.48, 0.02),
        color: WMU_GOLD,
        y: 0.55,
        z: 0.045,
      },
    ]);
  }
  return mergeParts([
    {
      geometry: new THREE.CylinderGeometry(0.04, 0.05, 2.4, 8),
      color: 0xbfc4c7,
    },
    {
      geometry: new THREE.BoxGeometry(0.62, 0.38, 0.02),
      color: WMU_GOLD,
      x: 0.33,
      y: 0.92,
    },
  ]);
}

// Hot-loop scratch. Nothing in step()/collide*() allocates.
const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();
const scratchLever = new THREE.Vector3();
const scratchTorque = new THREE.Vector3();
const scratchUp = new THREE.Vector3();
const scratchAxis = new THREE.Vector3();
const scratchSpin = new THREE.Quaternion();
const scratchImpulse = new THREE.Vector3();
const visualPosition = new THREE.Vector3();
const visualQuaternion = new THREE.Quaternion();
const visualScale = new THREE.Vector3(1, 1, 1);
const visualMatrix = new THREE.Matrix4();
const flutterEuler = new THREE.Euler();
const flutterQuaternion = new THREE.Quaternion();

export function createPropSystem(options: PropSystemOptions): PropSystem {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.86,
    metalness: 0.04,
  });
  const meshes = new Map<PropKind, THREE.InstancedMesh>();
  const byKind = new Map<PropKind, Prop[]>();
  for (const kind of KIND_ORDER) {
    const mesh = new THREE.InstancedMesh(
      buildPropGeometry(kind),
      material,
      PROP_CAPACITY,
    );
    mesh.name = `Campus props (${kind})`;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    options.scene.add(mesh);
    meshes.set(kind, mesh);
    byKind.set(kind, []);
  }

  const props: Prop[] = [];
  const propById = new Map<string, Prop>();
  const propsByKey = new Map<string, Prop[]>();
  let nextPropId = 0;
  let clock = 0;
  let settleCursor = 0;
  let poiRecycleClock = 0;
  let coneComboStart = -CONE_COMBO_SECONDS;
  let coneComboCount = 0;
  /** Last ground the terrain answered with; the seed for the next lookup. */
  let groundHint = Number.NaN;
  const focus = new THREE.Vector2(0, 0);

  const sampleGround = (east: number, north: number, fallback: number) => {
    const elevation = options.groundAt(east, north, fallback);
    if (!Number.isFinite(elevation)) return fallback;
    groundHint = elevation;
    return elevation;
  };

  const wake = (prop: Prop) => {
    prop.awake = true;
    prop.restTime = 0;
    prop.sleepTime = 0;
  };

  const sleep = (prop: Prop) => {
    prop.awake = false;
    prop.restTime = 0;
    prop.sleepTime = 0;
    prop.velocity.set(0, 0, 0);
    prop.angularVelocity.set(0, 0, 0);
    prop.position.y = prop.ground + PROFILES[prop.kind].groundOffset;
  };

  const awardWreck = (prop: Prop) => {
    const profile = PROFILES[prop.kind];
    options.awardChaos(profile.points, profile.label, { id: profile.id });
    options.recordEvent({ type: 'prop', kind: prop.kind, action: 'wrecked' });
    if (prop.kind !== 'cone') return;
    // Cones are cheap and come in rows, so a fast waddle through six of them
    // should read as one trick rather than six unrelated toasts.
    if (clock - coneComboStart > CONE_COMBO_SECONDS) {
      coneComboStart = clock;
      coneComboCount = 0;
    }
    coneComboCount += 1;
    if (coneComboCount === CONE_COMBO_TARGET) {
      options.awardChaos(300, 'CONE CROWN ×5', { id: 'cone-crown-five' });
    }
  };

  const checkWreck = (prop: Prop) => {
    if (prop.wrecked) return;
    const dx = prop.position.x - prop.home.x;
    const dy = prop.position.y - prop.home.y;
    const dz = prop.position.z - prop.home.z;
    const displaced =
      dx * dx + dy * dy + dz * dz > WRECK_DISTANCE * WRECK_DISTANCE;
    scratchUp.set(0, 1, 0).applyQuaternion(prop.quaternion);
    if (!displaced && scratchUp.y > WRECK_TILT_COSINE) return;
    prop.wrecked = true;
    awardWreck(prop);
  };

  const addSpin = (
    prop: Prop,
    lever: THREE.Vector3,
    impulse: THREE.Vector3,
  ) => {
    const profile = PROFILES[prop.kind];
    scratchTorque.copy(lever).cross(impulse);
    // Light props spin freely; a bench turns lazily. The clamp is what keeps
    // the integrator stable at 90 Hz without a real inertia tensor.
    scratchTorque.multiplyScalar(3.4 / (1 + profile.mass * 0.12));
    prop.angularVelocity.add(scratchTorque);
    if (prop.angularVelocity.length() > MAX_ANGULAR_SPEED) {
      prop.angularVelocity.setLength(MAX_ANGULAR_SPEED);
    }
  };

  const integrate = (prop: Prop, dt: number) => {
    const profile = PROFILES[prop.kind];
    prop.groundRefresh -= dt;
    if (prop.groundRefresh <= 0) {
      prop.groundRefresh = GROUND_REFRESH_SECONDS;
      prop.ground = sampleGround(prop.position.x, prop.position.z, prop.ground);
    }

    prop.velocity.y -= GRAVITY * dt;
    const airDrag = Math.exp(-AIR_DRAG * dt);
    prop.velocity.x *= airDrag;
    prop.velocity.z *= airDrag;
    prop.position.addScaledVector(prop.velocity, dt);

    const angularSpeed = prop.angularVelocity.length();
    if (angularSpeed > 0.001) {
      scratchAxis.copy(prop.angularVelocity).multiplyScalar(1 / angularSpeed);
      scratchSpin.setFromAxisAngle(scratchAxis, angularSpeed * dt);
      prop.quaternion.premultiply(scratchSpin).normalize();
    }

    const rest = prop.ground + profile.groundOffset;
    if (prop.position.y <= rest) {
      prop.position.y = rest;
      if (prop.velocity.y < -0.6) prop.velocity.y *= -RESTITUTION;
      else prop.velocity.y = 0;
      const friction = Math.exp(-ROLLING_FRICTION * dt);
      prop.velocity.x *= friction;
      prop.velocity.z *= friction;
      prop.angularVelocity.multiplyScalar(Math.exp(-GROUND_SPIN_FRICTION * dt));
    } else {
      prop.angularVelocity.multiplyScalar(Math.exp(-AIR_SPIN_FRICTION * dt));
    }

    prop.buildingRefresh -= dt;
    if (prop.buildingRefresh <= 0) {
      prop.buildingRefresh = BUILDING_REFRESH_SECONDS;
      if (options.resolveBuilding(prop.position, profile.radius).pushed) {
        // A prop shoved through a wall keeps its spin but loses the push that
        // put it there, so it settles against the wall instead of buzzing.
        prop.velocity.x *= 0.2;
        prop.velocity.z *= 0.2;
      }
    }

    const horizontal = Math.hypot(prop.velocity.x, prop.velocity.z);
    if (
      prop.position.y <= rest + 0.02 &&
      horizontal < 0.25 &&
      Math.abs(prop.velocity.y) < 0.3 &&
      prop.angularVelocity.lengthSq() < 0.36
    ) {
      prop.restTime += dt;
      if (prop.restTime >= SLEEP_DELAY) sleep(prop);
    } else {
      prop.restTime = 0;
    }
  };

  const followHeld = (prop: Prop, dt: number) => {
    if (!prop.holdTarget) return;
    scratchA.copy(prop.holdTarget).sub(prop.position);
    prop.velocity.copy(scratchA).multiplyScalar(1 / Math.max(dt, 1e-4));
    if (prop.velocity.length() > 26) prop.velocity.setLength(26);
    prop.position.copy(prop.holdTarget);
    prop.ground = sampleGround(prop.position.x, prop.position.z, prop.ground);
  };

  const collideGoose = (
    prop: Prop,
    dt: number,
    goose: PropGooseProbe,
    gooseRadius: number,
  ) => {
    if (prop.held) return;
    if (prop.gooseCooldown > 0) {
      prop.gooseCooldown = Math.max(0, prop.gooseCooldown - dt);
      return;
    }
    const profile = PROFILES[prop.kind];
    const contact = gooseRadius + profile.radius;
    // Swept sphere: closest approach of the goose segment to the prop center.
    const startX = goose.prevPosition.x;
    const startY = goose.prevPosition.y;
    const startZ = goose.prevPosition.z;
    const spanX = goose.position.x - startX;
    const spanY = goose.position.y - startY;
    const spanZ = goose.position.z - startZ;
    const toPropX = prop.position.x - startX;
    const toPropY = prop.position.y - startY;
    const toPropZ = prop.position.z - startZ;
    const spanLengthSquared = spanX * spanX + spanY * spanY + spanZ * spanZ;
    const t =
      spanLengthSquared > 1e-8
        ? clamp(
            (toPropX * spanX + toPropY * spanY + toPropZ * spanZ) /
              spanLengthSquared,
            0,
            1,
          )
        : 0;
    const closestX = toPropX - spanX * t;
    const closestY = toPropY - spanY * t;
    const closestZ = toPropZ - spanZ * t;
    const distanceSquared =
      closestX * closestX + closestY * closestY + closestZ * closestZ;
    if (distanceSquared > contact * contact) return;

    // Contact normal: prop center back out to the closest point on the goose
    // sweep. Pushing only along it means a prop already moving away with the
    // goose stops taking impulses, so leaning on a bench cannot walk it across
    // the lawn one frame at a time.
    const distance = Math.sqrt(distanceSquared);
    if (distance > 1e-4) {
      scratchB.set(
        closestX / distance,
        closestY / distance,
        closestZ / distance,
      );
    } else {
      scratchB.copy(goose.velocity);
      if (scratchB.lengthSq() < 1e-6) scratchB.set(0, 0, 1);
      scratchB.normalize();
    }
    scratchA.copy(goose.velocity).sub(prop.velocity);
    const approach = scratchA.dot(scratchB);
    if (approach < 0.35) return;
    const relativeSpeed = scratchA.length();

    const massRatio = GOOSE_MASS / (profile.mass + GOOSE_MASS);
    scratchImpulse.copy(goose.velocity).multiplyScalar(0.9 * massRatio);
    // The vertical kick is only weakly mass scaled, so a 20 m/s dive still
    // launches a bench while a 3.8 m/s waddle only nudges it.
    scratchImpulse.y += relativeSpeed * 0.3 * (0.35 + massRatio);
    prop.velocity.add(scratchImpulse);

    // Lever arm: body center out to the contact point on its own surface.
    scratchLever.copy(scratchB).multiplyScalar(-profile.radius);
    addSpin(prop, scratchLever, scratchImpulse);
    wake(prop);
    // One shove per contact, not one per frame of overlap.
    prop.gooseCooldown = 0.35;

    // Heavier props take more out of the goose, and only horizontally: eating
    // the vertical component would flatten a dive into a stall.
    const loss = clamp(
      0.35 * (profile.mass / (profile.mass + GOOSE_MASS)),
      0.02,
      0.22,
    );
    goose.velocity.x *= 1 - loss;
    goose.velocity.z *= 1 - loss;

    options.shake(
      clamp(0.08 + profile.mass * 0.002 + relativeSpeed * 0.004, 0.08, 0.2),
    );
    checkWreck(prop);
  };

  const settleSleepingProps = () => {
    if (props.length === 0) return;
    for (let sample = 0; sample < SETTLE_PER_STEP; sample += 1) {
      settleCursor = (settleCursor + 1) % props.length;
      const prop = props[settleCursor];
      if (prop.awake || prop.held) continue;
      const ground = sampleGround(
        prop.position.x,
        prop.position.z,
        prop.ground,
      );
      const delta = ground - prop.ground;
      if (Math.abs(delta) < 0.05) continue;
      // The home moves with the ground so a late DEM never reads as a wreck.
      prop.ground = ground;
      prop.position.y += delta;
      prop.home.y += delta;
      prop.previousPosition.y = prop.position.y;
      return;
    }
  };

  const removeProp = (prop: Prop) => {
    const index = props.indexOf(prop);
    if (index >= 0) props.splice(index, 1);
    const list = byKind.get(prop.kind);
    if (list) {
      const kindIndex = list.indexOf(prop);
      if (kindIndex >= 0) list.splice(kindIndex, 1);
    }
    propById.delete(prop.id);
    const keyed = propsByKey.get(prop.key);
    if (keyed) {
      const keyIndex = keyed.indexOf(prop);
      if (keyIndex >= 0) keyed.splice(keyIndex, 1);
      if (keyed.length === 0) propsByKey.delete(prop.key);
    }
  };

  const recycleDistantPois = () => {
    if (props.length === 0) return;
    for (let index = props.length - 1; index >= 0; index -= 1) {
      const prop = props[index];
      if (prop.permanent || prop.held) continue;
      const distance = Math.hypot(
        prop.position.x - focus.x,
        prop.position.z - focus.y,
      );
      if (distance < POI_RECYCLE_DISTANCE) continue;
      if (options.isInView(prop.position.x, prop.position.y, prop.position.z))
        continue;
      removeProp(prop);
    }
  };

  const spawnProp = (
    kind: PropKind,
    east: number,
    north: number,
    key: string,
    permanent: boolean,
  ) => {
    if (props.length >= PROP_CAPACITY) return null;
    if (options.isWater(east, north)) return null;
    const profile = PROFILES[kind];
    let ground = sampleGround(east, north, groundHint);
    scratchA.set(east, ground + profile.groundOffset, north);
    if (options.resolveBuilding(scratchA, profile.radius).pushed) {
      ground = sampleGround(scratchA.x, scratchA.z, ground);
      scratchA.y = ground + profile.groundOffset;
      if (options.isWater(scratchA.x, scratchA.z)) return null;
    }

    const position = new THREE.Vector3(scratchA.x, scratchA.y, scratchA.z);
    const prop: Prop = {
      id: `prop-${nextPropId}`,
      kind,
      permanent,
      key,
      home: position.clone(),
      position,
      previousPosition: position.clone(),
      velocity: new THREE.Vector3(),
      angularVelocity: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      previousQuaternion: new THREE.Quaternion(),
      ground,
      groundRefresh: hash01(nextPropId, 3) * GROUND_REFRESH_SECONDS,
      buildingRefresh: hash01(nextPropId, 5) * BUILDING_REFRESH_SECONDS,
      awake: false,
      restTime: 0,
      sleepTime: 0,
      wrecked: false,
      held: false,
      holdTarget: null,
      gooseCooldown: 0,
      carCooldown: 0,
    };
    // A deterministic resting yaw keeps a row of cones from looking stamped.
    prop.quaternion.setFromAxisAngle(
      scratchUp.set(0, 1, 0),
      hash01(nextPropId, 7) * TWO_PI,
    );
    prop.previousQuaternion.copy(prop.quaternion);
    nextPropId += 1;

    props.push(prop);
    byKind.get(kind)?.push(prop);
    propById.set(prop.id, prop);
    const keyed = propsByKey.get(key);
    if (keyed) keyed.push(prop);
    else propsByKey.set(key, [prop]);
    return prop;
  };

  /**
   * Capacity backstop. POI props go first; only when there is nothing else to
   * give does a hand-placed prop far behind the goose make room for a nearer
   * one, so the table near the player always wins.
   */
  const evictFarthest = (thanDistance: number) => {
    let candidate: Prop | null = null;
    let candidateDistance = 0;
    for (const prop of props) {
      if (prop.held) continue;
      const distance = Math.hypot(prop.home.x - focus.x, prop.home.z - focus.y);
      // Never trade a prop for one that is farther away than it is.
      if (distance <= thanDistance) continue;
      // Hand-placed props only yield when they are well out of the picture.
      if (prop.permanent && distance < 400) continue;
      const better =
        candidate === null ||
        (candidate.permanent && !prop.permanent) ||
        (candidate.permanent === prop.permanent &&
          distance > candidateDistance);
      if (!better) continue;
      candidate = prop;
      candidateDistance = distance;
    }
    if (!candidate) return false;
    removeProp(candidate);
    return true;
  };

  const spawnFromPlacements = (
    placements: readonly PropPlacement[],
    authoredToLocal: AuthoredToLocal,
    nextFocus?: { x: number; z: number },
  ) => {
    if (nextFocus) focus.set(nextFocus.x, nextFocus.z);
    type Candidate = {
      kind: PropKind;
      east: number;
      north: number;
      key: string;
      distance: number;
    };
    const candidates: Candidate[] = [];
    placements.forEach((placement, placementIndex) => {
      const count = Math.max(1, Math.floor(placement.count ?? 1));
      const pattern = placement.pattern ?? 'row';
      const spacing = placement.spacing ?? (pattern === 'ring' ? 3 : 2.4);
      const heading = placement.heading ?? 0;
      const base = authoredToLocal(placement.east, placement.north);
      for (let index = 0; index < count; index += 1) {
        let east = base.x;
        let north = base.y;
        if (pattern === 'ring') {
          const angle = (index / count) * TWO_PI + heading;
          east += Math.sin(angle) * spacing;
          north += Math.cos(angle) * spacing;
        } else if (pattern === 'cluster') {
          east += (hash01(placementIndex * 97 + index, 11) - 0.5) * 2 * spacing;
          north +=
            (hash01(placementIndex * 97 + index, 13) - 0.5) * 2 * spacing;
        } else {
          east += Math.sin(heading) * spacing * index;
          north += Math.cos(heading) * spacing * index;
        }
        candidates.push({
          kind: placement.kind,
          east,
          north,
          // Keyed by where it stands rather than by its row in the table, so a
          // reshuffled table respawns the same world and two tables spawned
          // into one system cannot collide.
          key: `place:${placement.kind}:${east.toFixed(1)}:${north.toFixed(1)}`,
          distance: Math.hypot(east - focus.x, north - focus.y),
        });
      }
    });
    candidates.sort((a, b) => a.distance - b.distance);
    for (const candidate of candidates) {
      if (propsByKey.has(candidate.key)) continue;
      if (props.length >= PROP_CAPACITY && !evictFarthest(candidate.distance))
        break;
      spawnProp(
        candidate.kind,
        candidate.east,
        candidate.north,
        candidate.key,
        true,
      );
    }
  };

  const spawnFromPois = (points: readonly PropPoi[]) => {
    for (const point of points) {
      // Rounded coordinates dedupe the same rack arriving from two tiles.
      const key = `poi:${point.kind}:${Math.round(point.east)}:${Math.round(point.north)}`;
      if (propsByKey.has(key)) continue;
      const distance = Math.hypot(point.east - focus.x, point.north - focus.y);
      if (props.length >= PROP_CAPACITY && !evictFarthest(distance)) return;
      if (point.kind === 'bike') {
        // A rack holds more than one bike; two reads as a rack, six is clutter.
        spawnProp('bike', point.east - 0.6, point.north, key, false);
        spawnProp('bike', point.east + 0.6, point.north, key, false);
      } else {
        spawnProp(point.kind, point.east, point.north, key, false);
      }
    }
  };

  const step = (dt: number, goose: PropGooseProbe) => {
    clock += dt;
    focus.set(goose.position.x, goose.position.z);
    if (props.length === 0) return;
    const gooseRadius =
      Number.isFinite(goose.radius) && goose.radius > 0
        ? goose.radius
        : goose.mode === 'flying'
          ? 0.68
          : 0.58;

    for (const prop of props) {
      prop.previousPosition.copy(prop.position);
      prop.previousQuaternion.copy(prop.quaternion);
      if (prop.carCooldown > 0)
        prop.carCooldown = Math.max(0, prop.carCooldown - dt);

      if (prop.held) {
        followHeld(prop, dt);
        continue;
      }
      if (prop.awake) {
        integrate(prop, dt);
        checkWreck(prop);
      } else {
        prop.sleepTime += dt;
        if (prop.wrecked && prop.sleepTime >= REWRECK_SLEEP_SECONDS) {
          // Settled somewhere new for long enough: this is its home now, and
          // knocking it over again is a fresh trick.
          prop.home.copy(prop.position);
          prop.wrecked = false;
        }
      }
      collideGoose(prop, dt, goose, gooseRadius);
    }

    settleSleepingProps();
    poiRecycleClock -= dt;
    if (poiRecycleClock <= 0) {
      poiRecycleClock = POI_RECYCLE_INTERVAL;
      recycleDistantPois();
    }
  };

  const collideCars = (cars: readonly PropCar[]) => {
    if (props.length === 0) return;
    for (const car of cars) {
      if (car.speed < 1.2) continue;
      const rightX = car.direction.z;
      const rightZ = -car.direction.x;
      for (const prop of props) {
        if (prop.held || prop.carCooldown > 0) continue;
        const dx = prop.position.x - car.position.x;
        const dz = prop.position.z - car.position.z;
        // Cheap 6 m broad phase before the oriented box test.
        if (dx * dx + dz * dz > 36) continue;
        const profile = PROFILES[prop.kind];
        const localX = dx * rightX + dz * rightZ;
        const localZ = dx * car.direction.x + dz * car.direction.z;
        if (Math.abs(localX) > 0.91 + profile.radius) continue;
        if (Math.abs(localZ) > 2.2 + profile.radius) continue;
        const vertical = prop.position.y - car.ground;
        if (vertical < -0.6 || vertical > 1.9) continue;

        const launch = clamp(
          car.speed * (2.6 / (1 + profile.mass * 0.05)),
          1.5,
          16,
        );
        scratchImpulse
          .copy(car.direction)
          .multiplyScalar(launch)
          .setY(clamp(car.speed * 0.55, 1.5, 6.5));
        prop.velocity.add(scratchImpulse);
        scratchLever.set(-localX * rightX, -0.25, -localX * rightZ);
        if (scratchLever.lengthSq() < 1e-6) scratchLever.set(0.1, -0.25, 0);
        addSpin(prop, scratchLever, scratchImpulse);
        wake(prop);
        prop.carCooldown = 0.5;
        car.wobbleRemaining = Math.max(car.wobbleRemaining, 0.9);
        car.reactionRemaining = Math.max(car.reactionRemaining, 0.6);
        options.recordEvent({
          type: 'prop',
          kind: prop.kind,
          action: 'hit-car',
        });
        checkWreck(prop);
      }
    }
  };

  const collideStudents = (npcs: readonly CampusNpc[]) => {
    if (props.length === 0 || npcs.length === 0) return;
    for (const prop of props) {
      if (!prop.awake || prop.held) continue;
      if (prop.velocity.lengthSq() < 9) continue;
      const profile = PROFILES[prop.kind];
      for (const npc of npcs) {
        if (npc.mode !== 'walk' && npc.mode !== 'flee') continue;
        if (npc.collisionCooldown > 0) continue;
        const dx = npc.position.x - prop.position.x;
        const dz = npc.position.z - prop.position.z;
        if (dx * dx + dz * dz > 0.5625) continue;
        const vertical = prop.position.y - npc.ground;
        if (vertical < -0.3 || vertical > 1.9) continue;

        scratchImpulse
          .copy(prop.velocity)
          .multiplyScalar(
            clamp(profile.mass / (profile.mass + GOOSE_MASS * 3), 0.25, 0.9),
          );
        scratchImpulse.y = Math.max(scratchImpulse.y, 2.4);
        if (!knockDownCampusNpc(npc, scratchImpulse)) continue;
        options.awardChaos(220, 'FRIENDLY FIRE', { id: 'friendly-fire' });
        options.recordEvent({
          type: 'prop',
          kind: prop.kind,
          action: 'hit-student',
        });
        options.recordEvent({ type: 'bowl', by: 'prop', airborne: true });
        prop.velocity.multiplyScalar(0.55);
        break;
      }
    }
  };

  const updateVisuals = (blend: number, elapsed: number) => {
    const interpolation = clamp(blend, 0, 1);
    for (const kind of KIND_ORDER) {
      const list = byKind.get(kind);
      const mesh = meshes.get(kind);
      if (!list || !mesh) continue;
      for (let index = 0; index < list.length; index += 1) {
        const prop = list[index];
        visualPosition.lerpVectors(
          prop.previousPosition,
          prop.position,
          interpolation,
        );
        visualQuaternion.slerpQuaternions(
          prop.previousQuaternion,
          prop.quaternion,
          interpolation,
        );
        if (kind === 'flag' && !prop.awake) {
          // A standing flag turns in the breeze. Every other sleeping prop is
          // written from a frozen transform, so nothing jitters at rest.
          flutterEuler.set(0, Math.sin(elapsed * 0.7 + prop.home.x) * 0.06, 0);
          flutterQuaternion.setFromEuler(flutterEuler);
          visualQuaternion.multiply(flutterQuaternion);
        }
        visualMatrix.compose(visualPosition, visualQuaternion, visualScale);
        mesh.setMatrixAt(index, visualMatrix);
      }
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
    }
  };

  const setVisible = (next: boolean) => {
    for (const mesh of meshes.values()) mesh.visible = next;
  };

  const resetAll = () => {
    for (const prop of props) {
      prop.position.copy(prop.home);
      prop.previousPosition.copy(prop.home);
      prop.velocity.set(0, 0, 0);
      prop.angularVelocity.set(0, 0, 0);
      prop.quaternion.identity();
      prop.previousQuaternion.identity();
      prop.awake = false;
      prop.restTime = 0;
      prop.sleepTime = 0;
      prop.wrecked = false;
      prop.held = false;
      prop.holdTarget = null;
      prop.gooseCooldown = 0;
      prop.carCooldown = 0;
    }
    coneComboCount = 0;
    coneComboStart = -CONE_COMBO_SECONDS;
  };

  const stats = (): PropStats => {
    let awake = 0;
    for (const prop of props) if (prop.awake || prop.held) awake += 1;
    return { props: props.length, propsAwake: awake };
  };

  const nearest = (point: THREE.Vector3, radius: number) => {
    let bestId: string | null = null;
    let bestDistance = radius * radius;
    for (const prop of props) {
      if (prop.held) continue;
      const dx = prop.position.x - point.x;
      const dy = prop.position.y - point.y;
      const dz = prop.position.z - point.z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared >= bestDistance) continue;
      bestDistance = distanceSquared;
      bestId = prop.id;
    }
    return bestId;
  };

  const describe = (id: string) => {
    const prop = propById.get(id);
    if (!prop) return null;
    return { kind: prop.kind, mass: PROFILES[prop.kind].mass };
  };

  const hold = (id: string, target: THREE.Vector3) => {
    const prop = propById.get(id);
    if (!prop) return false;
    prop.held = true;
    prop.holdTarget = target;
    prop.angularVelocity.set(0, 0, 0);
    wake(prop);
    return true;
  };

  const release = (id: string, velocity: THREE.Vector3) => {
    const prop = propById.get(id);
    if (!prop) return false;
    prop.held = false;
    prop.holdTarget = null;
    prop.velocity.copy(velocity);
    wake(prop);
    scratchB.set(0.2, 0, 0.2);
    addSpin(prop, scratchB, prop.velocity);
    checkWreck(prop);
    return true;
  };

  const dispose = () => {
    for (const mesh of meshes.values()) {
      options.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    material.dispose();
    meshes.clear();
    byKind.clear();
    props.length = 0;
    propById.clear();
    propsByKey.clear();
  };

  return {
    spawnFromPlacements,
    spawnFromPois,
    step,
    updateVisuals,
    setVisible,
    resetAll,
    stats,
    collideCars,
    collideStudents,
    nearest,
    describe,
    hold,
    release,
    dispose,
  };
}
