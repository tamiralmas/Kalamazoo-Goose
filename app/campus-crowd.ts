import * as THREE from 'three';

export const MAX_CAMPUS_NPCS = 84;

export type CrowdRoute = {
  points: THREE.Vector3[];
  cumulative: number[];
  total: number;
  sidewalkOffset?: number;
};

export type CampusNpcMode = 'walk' | 'flee' | 'ragdoll' | 'recover';

export type GroundSampler = (east: number, north: number, fallback: number) => number;

export type CampusNpc = {
  index: number;
  route: CrowdRoute;
  distance: number;
  directionSign: -1 | 1;
  laneOffset: number;
  walkSpeed: number;
  speed: number;
  heightScale: number;
  position: THREE.Vector3;
  previousPosition: THREE.Vector3;
  direction: THREE.Vector3;
  previousDirection: THREE.Vector3;
  ground: number;
  targetGround: number;
  groundRefreshRemaining: number;
  mode: CampusNpcMode;
  modeTime: number;
  panicDuration: number;
  gaitPhase: number;
  restTime: number;
  honkCooldown: number;
  collisionCooldown: number;
  scoreCooldown: number;
  ragdollVelocity: THREE.Vector3;
  ragdollRotation: THREE.Quaternion;
  previousRagdollRotation: THREE.Quaternion;
  ragdollAngularVelocity: THREE.Vector3;
  recoveryStart: THREE.Vector3;
  recoveryTarget: THREE.Vector3;
  recoveryStartRotation: THREE.Quaternion;
  shirtColor: number;
  trousersColor: number;
  skinColor: number;
  paletteKey: number;
};

export type CrowdFleet = {
  capacity: number;
  heads: THREE.InstancedMesh;
  torsos: THREE.InstancedMesh;
  leftArms: THREE.InstancedMesh;
  rightArms: THREE.InstancedMesh;
  leftLegs: THREE.InstancedMesh;
  rightLegs: THREE.InstancedMesh;
  colorKeys: Int32Array;
};

const WALK_ACCELERATION = 2.8;
const FLEE_ACCELERATION = 7.5;
const RAGDOLL_GRAVITY = 9.81;
const RECOVERY_DURATION = 0.9;
const TWO_PI = Math.PI * 2;

const SHIRT_COLORS = [
  0x7b3f93,
  0xd29a2e,
  0x3f7295,
  0x4f7a55,
  0xa94e45,
  0xd6d1c5,
  0x313940,
  0x835d42,
];
const TROUSERS_COLORS = [0x24313a, 0x3f4548, 0x43536b, 0x675c4e, 0x202326, 0x6d6a61];
const SKIN_COLORS = [0xf2c7a2, 0xd99f76, 0xb97952, 0x865236, 0x5f3828, 0xe8b991];

const samplePosition = new THREE.Vector3();
const sampleDirection = new THREE.Vector3();
const sampleRight = new THREE.Vector3();
const panicAway = new THREE.Vector3();
const rotationAxis = new THREE.Vector3();
const rotationDelta = new THREE.Quaternion();
const uprightRotation = new THREE.Quaternion();
const uprightEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

function moveToward(value: number, target: number, amount: number) {
  if (value < target) return Math.min(target, value + amount);
  return Math.max(target, value - amount);
}

function smoothstep(value: number) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function random01(index: number, salt: number) {
  let value = Math.imul(index + 1, 0x45d9f3b) ^ Math.imul(salt + 11, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 4_294_967_296;
}

function safeGround(
  groundAt: GroundSampler,
  east: number,
  north: number,
  fallback: number,
) {
  const elevation = groundAt(east, north, fallback);
  return Number.isFinite(elevation) ? elevation : fallback;
}

function sampleCrowdRoute(
  route: CrowdRoute,
  distance: number,
  position: THREE.Vector3,
  direction: THREE.Vector3,
) {
  const routeDistance = clamp(distance, 0, route.total);
  let low = 1;
  let high = route.cumulative.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (route.cumulative[middle] < routeDistance) low = middle + 1;
    else high = middle;
  }
  const index = clamp(low, 1, route.points.length - 1);
  const startDistance = route.cumulative[index - 1];
  const segmentLength = Math.max(route.cumulative[index] - startDistance, 0.001);
  const t = clamp((routeDistance - startDistance) / segmentLength, 0, 1);
  position.lerpVectors(route.points[index - 1], route.points[index], t);
  direction.copy(route.points[index]).sub(route.points[index - 1]);
  direction.y = 0;
  if (direction.lengthSq() < 0.0001) direction.set(0, 0, 1);
  else direction.normalize();
}

function advanceNpcDistance(npc: CampusNpc, amount: number) {
  npc.distance += amount * npc.directionSign;
  let reflections = 0;
  while ((npc.distance < 0 || npc.distance > npc.route.total) && reflections < 4) {
    if (npc.distance > npc.route.total) {
      npc.distance = npc.route.total * 2 - npc.distance;
      npc.directionSign = -1;
    } else if (npc.distance < 0) {
      npc.distance = -npc.distance;
      npc.directionSign = 1;
    }
    reflections += 1;
  }
  npc.distance = clamp(npc.distance, 0, npc.route.total);
}

function updateRoutePosition(
  npc: CampusNpc,
  elapsed: number,
  groundAt: GroundSampler,
  dt: number,
) {
  sampleCrowdRoute(npc.route, npc.distance, samplePosition, sampleDirection);
  npc.direction.copy(sampleDirection).multiplyScalar(npc.directionSign);
  sampleRight.set(npc.direction.z, 0, -npc.direction.x);
  const panicAmount = npc.mode === 'flee' ? 1 : 0;
  const lateralWeave =
    Math.sin(elapsed * (7.5 + random01(npc.index, 7) * 2.5) + npc.index * 1.31) *
    (0.035 + panicAmount * 0.3);
  samplePosition.addScaledVector(sampleRight, npc.laneOffset + lateralWeave);

  npc.groundRefreshRemaining -= dt;
  if (npc.groundRefreshRemaining <= 0) {
    npc.groundRefreshRemaining =
      (npc.mode === 'flee' ? 0.25 : 0.55) + random01(npc.index, 31) * 0.35;
    npc.targetGround = safeGround(
      groundAt,
      samplePosition.x,
      samplePosition.z,
      npc.targetGround,
    );
  }
  npc.ground +=
    (npc.targetGround - npc.ground) * (1 - Math.exp(-(npc.mode === 'flee' ? 12 : 8) * dt));
  npc.position.set(samplePosition.x, npc.ground, samplePosition.z);
}

function beginRecovery(npc: CampusNpc, groundAt: GroundSampler) {
  sampleCrowdRoute(npc.route, npc.distance, samplePosition, sampleDirection);
  sampleDirection.multiplyScalar(npc.directionSign);
  sampleRight.set(sampleDirection.z, 0, -sampleDirection.x);
  samplePosition.addScaledVector(sampleRight, npc.laneOffset);
  npc.ground = safeGround(groundAt, samplePosition.x, samplePosition.z, npc.ground);
  npc.targetGround = npc.ground;
  npc.recoveryStart.copy(npc.position);
  npc.recoveryTarget.set(
    samplePosition.x,
    npc.ground + 1.1 * npc.heightScale,
    samplePosition.z,
  );
  npc.recoveryStartRotation.copy(npc.ragdollRotation);
  npc.direction.copy(sampleDirection);
  uprightEuler.set(0, Math.atan2(sampleDirection.x, sampleDirection.z), 0, 'YXZ');
  uprightRotation.setFromEuler(uprightEuler);
  npc.mode = 'recover';
  npc.modeTime = 0;
  npc.ragdollVelocity.set(0, 0, 0);
  npc.ragdollAngularVelocity.set(0, 0, 0);
}

export function createCrowdFleet(capacity: number): CrowdFleet {
  const safeCapacity = Math.max(1, Math.floor(capacity));
  const skinMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0,
  });
  const shirtMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    metalness: 0,
  });
  const trousersMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0,
  });
  const headGeometry = new THREE.DodecahedronGeometry(0.17, 0);
  const torsoGeometry = new THREE.BoxGeometry(0.38, 0.62, 0.24);
  const armGeometry = new THREE.CylinderGeometry(0.045, 0.055, 0.6, 6);
  const legGeometry = new THREE.CylinderGeometry(0.06, 0.075, 0.76, 6);
  const heads = new THREE.InstancedMesh(headGeometry, skinMaterial, safeCapacity);
  const torsos = new THREE.InstancedMesh(torsoGeometry, shirtMaterial, safeCapacity);
  const leftArms = new THREE.InstancedMesh(armGeometry, shirtMaterial, safeCapacity);
  const rightArms = new THREE.InstancedMesh(armGeometry, shirtMaterial, safeCapacity);
  const leftLegs = new THREE.InstancedMesh(legGeometry, trousersMaterial, safeCapacity);
  const rightLegs = new THREE.InstancedMesh(legGeometry, trousersMaterial, safeCapacity);

  const meshes = [heads, torsos, leftArms, rightArms, leftLegs, rightLegs];
  meshes.forEach((mesh) => {
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  });

  const colorKeys = new Int32Array(safeCapacity);
  colorKeys.fill(-1);
  return {
    capacity: safeCapacity,
    heads,
    torsos,
    leftArms,
    rightArms,
    leftLegs,
    rightLegs,
    colorKeys,
  };
}

export function createCampusNpc(
  index: number,
  route: CrowdRoute,
  distance: number,
  groundAt: GroundSampler,
): CampusNpc {
  if (
    route.points.length < 2 ||
    route.cumulative.length !== route.points.length ||
    !Number.isFinite(route.total) ||
    route.total <= 0.1
  ) {
    throw new Error('Campus NPC routes need at least two points and a positive length.');
  }

  const routeDistance = clamp(distance, 0, route.total);
  const directionSign = (index % 2 === 0 ? 1 : -1) as -1 | 1;
  const sidewalkSide = random01(index, 2) < 0.5 ? -1 : 1;
  const laneOffset = sidewalkSide * (route.sidewalkOffset ?? 0) + (random01(index, 1) - 0.5) * 1.1;
  sampleCrowdRoute(route, routeDistance, samplePosition, sampleDirection);
  sampleDirection.multiplyScalar(directionSign);
  sampleRight.set(sampleDirection.z, 0, -sampleDirection.x);
  samplePosition.addScaledVector(sampleRight, laneOffset);
  const ground = safeGround(groundAt, samplePosition.x, samplePosition.z, samplePosition.y);
  const heading = Math.atan2(sampleDirection.x, sampleDirection.z);
  const initialRotation = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0, heading, 0, 'YXZ'),
  );
  const shirtIndex = Math.floor(random01(index, 3) * SHIRT_COLORS.length);
  const trousersIndex = Math.floor(random01(index, 5) * TROUSERS_COLORS.length);
  const skinIndex = Math.floor(random01(index, 9) * SKIN_COLORS.length);
  const paletteKey = shirtIndex * 100 + trousersIndex * 10 + skinIndex;
  const position = new THREE.Vector3(samplePosition.x, ground, samplePosition.z);

  return {
    index,
    route,
    distance: routeDistance,
    directionSign,
    laneOffset,
    walkSpeed: 1.08 + random01(index, 13) * 0.62,
    speed: 0.7 + random01(index, 17) * 0.35,
    heightScale: 0.94 + random01(index, 19) * 0.12,
    position,
    previousPosition: position.clone(),
    direction: sampleDirection.clone(),
    previousDirection: sampleDirection.clone(),
    ground,
    targetGround: ground,
    groundRefreshRemaining: random01(index, 23) * 0.55,
    mode: 'walk',
    modeTime: 0,
    panicDuration: 0,
    gaitPhase: random01(index, 29) * TWO_PI,
    restTime: 0,
    honkCooldown: 0,
    collisionCooldown: 0,
    scoreCooldown: 0,
    ragdollVelocity: new THREE.Vector3(),
    ragdollRotation: initialRotation.clone(),
    previousRagdollRotation: initialRotation.clone(),
    ragdollAngularVelocity: new THREE.Vector3(),
    recoveryStart: position.clone(),
    recoveryTarget: position.clone(),
    recoveryStartRotation: initialRotation.clone(),
    shirtColor: SHIRT_COLORS[shirtIndex],
    trousersColor: TROUSERS_COLORS[trousersIndex],
    skinColor: SKIN_COLORS[skinIndex],
    paletteKey,
  };
}

export function panicCampusNpc(npc: CampusNpc, source: THREE.Vector3) {
  if (npc.mode === 'ragdoll') return false;
  sampleCrowdRoute(npc.route, npc.distance, samplePosition, sampleDirection);
  panicAway.copy(npc.position).sub(source);
  panicAway.y = 0;
  if (panicAway.lengthSq() < 0.001) {
    panicAway.set(sampleDirection.z, 0, -sampleDirection.x);
    if (npc.index % 2 !== 0) panicAway.multiplyScalar(-1);
  } else {
    panicAway.normalize();
  }
  npc.directionSign = sampleDirection.dot(panicAway) >= 0 ? 1 : -1;
  npc.direction.copy(sampleDirection).multiplyScalar(npc.directionSign);
  npc.mode = 'flee';
  npc.modeTime = 0;
  npc.panicDuration = 2.8 + random01(npc.index, 37) * 1.9;
  npc.speed = Math.max(npc.speed, npc.walkSpeed * 1.5);
  npc.honkCooldown = Math.max(npc.honkCooldown, 5.5);
  return true;
}

export function knockDownCampusNpc(npc: CampusNpc, impulse: THREE.Vector3) {
  if (npc.mode === 'ragdoll' && npc.collisionCooldown > 0) return false;
  const heading = Math.atan2(npc.direction.x, npc.direction.z);
  uprightEuler.set(0, heading, 0, 'YXZ');
  npc.ragdollRotation.setFromEuler(uprightEuler);
  npc.previousRagdollRotation.copy(npc.ragdollRotation);
  npc.position.y = Math.max(npc.position.y, npc.ground) + 1.1 * npc.heightScale;
  npc.previousPosition.copy(npc.position);
  npc.ragdollVelocity
    .copy(npc.direction)
    .multiplyScalar(npc.speed * 0.55)
    .add(impulse);
  const side = impulse.x * npc.direction.z - impulse.z * npc.direction.x;
  const spinSign = side === 0 ? (npc.index % 2 === 0 ? 1 : -1) : Math.sign(side);
  npc.ragdollAngularVelocity.set(
    (3.8 + random01(npc.index, 41) * 3.4) * spinSign,
    (2.2 + random01(npc.index, 43) * 3.1) * -spinSign,
    (5.2 + random01(npc.index, 47) * 4.2) * spinSign,
  );
  npc.mode = 'ragdoll';
  npc.modeTime = 0;
  npc.restTime = 0;
  npc.speed = 0;
  npc.collisionCooldown = 2.8;
  npc.honkCooldown = Math.max(npc.honkCooldown, 1.2);
  return true;
}

export function simulateCampusNpc(
  npc: CampusNpc,
  dt: number,
  elapsed: number,
  groundAt: GroundSampler,
) {
  const step = clamp(dt, 0, 0.05);
  if (step <= 0) return;
  npc.previousPosition.copy(npc.position);
  npc.previousDirection.copy(npc.direction);
  npc.previousRagdollRotation.copy(npc.ragdollRotation);
  npc.modeTime += step;
  npc.honkCooldown = Math.max(0, npc.honkCooldown - step);
  npc.collisionCooldown = Math.max(0, npc.collisionCooldown - step);
  npc.scoreCooldown = Math.max(0, npc.scoreCooldown - step);

  if (npc.mode === 'ragdoll') {
    npc.groundRefreshRemaining -= step;
    if (npc.groundRefreshRemaining <= 0) {
      npc.groundRefreshRemaining = 0.06;
      npc.ground = safeGround(groundAt, npc.position.x, npc.position.z, npc.ground);
      npc.targetGround = npc.ground;
    }
    npc.ragdollVelocity.y -= RAGDOLL_GRAVITY * step;
    const airDrag = Math.exp(-0.32 * step);
    npc.ragdollVelocity.x *= airDrag;
    npc.ragdollVelocity.z *= airDrag;
    npc.position.addScaledVector(npc.ragdollVelocity, step);

    const angularSpeed = npc.ragdollAngularVelocity.length();
    if (angularSpeed > 0.001) {
      rotationAxis.copy(npc.ragdollAngularVelocity).multiplyScalar(1 / angularSpeed);
      rotationDelta.setFromAxisAngle(rotationAxis, angularSpeed * step);
      npc.ragdollRotation.premultiply(rotationDelta).normalize();
    }

    const bodyRadius = 0.3 * npc.heightScale;
    if (npc.position.y <= npc.ground + bodyRadius) {
      npc.position.y = npc.ground + bodyRadius;
      if (npc.ragdollVelocity.y < -0.8) npc.ragdollVelocity.y *= -0.22;
      else npc.ragdollVelocity.y = 0;
      const groundDrag = Math.exp(-5.5 * step);
      npc.ragdollVelocity.x *= groundDrag;
      npc.ragdollVelocity.z *= groundDrag;
      npc.ragdollAngularVelocity.multiplyScalar(Math.exp(-3.8 * step));
    } else {
      npc.ragdollAngularVelocity.multiplyScalar(Math.exp(-0.55 * step));
    }

    const horizontalSpeed = Math.hypot(npc.ragdollVelocity.x, npc.ragdollVelocity.z);
    if (
      npc.position.y <= npc.ground + bodyRadius + 0.02 &&
      horizontalSpeed < 0.42 &&
      Math.abs(npc.ragdollVelocity.y) < 0.35
    ) {
      npc.restTime += step;
    } else {
      npc.restTime = 0;
    }
    if ((npc.modeTime > 0.75 && npc.restTime > 0.55) || npc.modeTime > 3.6) {
      beginRecovery(npc, groundAt);
    }
    return;
  }

  if (npc.mode === 'recover') {
    const recoveryBlend = smoothstep(npc.modeTime / RECOVERY_DURATION);
    npc.position.lerpVectors(npc.recoveryStart, npc.recoveryTarget, recoveryBlend);
    uprightEuler.set(0, Math.atan2(npc.direction.x, npc.direction.z), 0, 'YXZ');
    uprightRotation.setFromEuler(uprightEuler);
    npc.ragdollRotation.slerpQuaternions(
      npc.recoveryStartRotation,
      uprightRotation,
      recoveryBlend,
    );
    if (recoveryBlend >= 1) {
      npc.mode = 'walk';
      npc.modeTime = 0;
      npc.speed = 0.35;
      npc.position.y = npc.ground;
      npc.previousPosition.copy(npc.position);
      npc.previousRagdollRotation.copy(npc.ragdollRotation);
    }
    return;
  }

  if (npc.mode === 'flee' && npc.modeTime >= npc.panicDuration) {
    npc.mode = 'walk';
    npc.modeTime = 0;
  }
  const fleeing = npc.mode === 'flee';
  const targetSpeed = fleeing
    ? clamp(npc.walkSpeed * 2.9, 3.4, 5.1)
    : npc.walkSpeed;
  npc.speed = moveToward(
    npc.speed,
    targetSpeed,
    (fleeing ? FLEE_ACCELERATION : WALK_ACCELERATION) * step,
  );
  advanceNpcDistance(npc, npc.speed * step);
  updateRoutePosition(npc, elapsed, groundAt, step);
  npc.gaitPhase = (npc.gaitPhase + npc.speed * step * (fleeing ? 6.8 : 5.2)) % TWO_PI;
}

export function updateCrowdVisuals(
  fleet: CrowdFleet,
  npcs: CampusNpc[],
  blend: number,
  elapsed: number,
) {
  const count = Math.min(fleet.capacity, npcs.length);
  const interpolation = clamp(blend, 0, 1);
  const rootPosition = new THREE.Vector3();
  const rootDirection = new THREE.Vector3();
  const rootScale = new THREE.Vector3();
  const rootRotation = new THREE.Quaternion();
  const rootEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const worldMatrix = new THREE.Matrix4();
  const localPosition = new THREE.Vector3();
  const localScale = new THREE.Vector3(1, 1, 1);
  const localRotation = new THREE.Quaternion();
  const localEuler = new THREE.Euler();
  const localMatrix = new THREE.Matrix4();
  const finalMatrix = new THREE.Matrix4();
  const color = new THREE.Color();
  let headColorsChanged = false;
  let shirtColorsChanged = false;
  let trousersColorsChanged = false;

  const placePart = (
    mesh: THREE.InstancedMesh,
    index: number,
    x: number,
    y: number,
    z: number,
    rotationX = 0,
    rotationY = 0,
    rotationZ = 0,
  ) => {
    localPosition.set(x, y, z);
    localEuler.set(rotationX, rotationY, rotationZ, 'XYZ');
    localRotation.setFromEuler(localEuler);
    localMatrix.compose(localPosition, localRotation, localScale);
    finalMatrix.multiplyMatrices(worldMatrix, localMatrix);
    mesh.setMatrixAt(index, finalMatrix);
  };

  for (let index = 0; index < count; index += 1) {
    const npc = npcs[index];
    if (fleet.colorKeys[index] !== npc.paletteKey) {
      fleet.colorKeys[index] = npc.paletteKey;
      fleet.heads.setColorAt(index, color.setHex(npc.skinColor));
      fleet.torsos.setColorAt(index, color.setHex(npc.shirtColor));
      fleet.leftArms.setColorAt(index, color.setHex(npc.shirtColor));
      fleet.rightArms.setColorAt(index, color.setHex(npc.shirtColor));
      fleet.leftLegs.setColorAt(index, color.setHex(npc.trousersColor));
      fleet.rightLegs.setColorAt(index, color.setHex(npc.trousersColor));
      headColorsChanged = true;
      shirtColorsChanged = true;
      trousersColorsChanged = true;
    }

    rootPosition.lerpVectors(npc.previousPosition, npc.position, interpolation);
    rootScale.setScalar(npc.heightScale);

    if (npc.mode === 'ragdoll' || npc.mode === 'recover') {
      rootRotation.slerpQuaternions(
        npc.previousRagdollRotation,
        npc.ragdollRotation,
        interpolation,
      );
      worldMatrix.compose(rootPosition, rootRotation, rootScale);
      const ragdollAmount =
        npc.mode === 'ragdoll' ? 1 : 1 - smoothstep(npc.modeTime / RECOVERY_DURATION);
      const flail =
        Math.sin(elapsed * 11 + npc.index * 1.73) * 0.46 * ragdollAmount;
      placePart(fleet.torsos, index, 0, 0, 0, flail * 0.14);
      placePart(fleet.heads, index, 0, 0.46, 0.01, flail * 0.2, 0, flail * 0.16);
      placePart(
        fleet.leftArms,
        index,
        -0.28,
        0.03,
        0,
        flail,
        0,
        0.08 + ragdollAmount * 1.02,
      );
      placePart(
        fleet.rightArms,
        index,
        0.28,
        0.03,
        0,
        -flail,
        0,
        -0.08 - ragdollAmount * 1.02,
      );
      placePart(
        fleet.leftLegs,
        index,
        -0.11,
        -0.68,
        0,
        -flail,
        0,
        ragdollAmount * 0.28,
      );
      placePart(
        fleet.rightLegs,
        index,
        0.11,
        -0.68,
        0,
        flail,
        0,
        -ragdollAmount * 0.28,
      );
      continue;
    }

    rootDirection.lerpVectors(npc.previousDirection, npc.direction, interpolation);
    rootDirection.y = 0;
    if (rootDirection.lengthSq() < 0.0001) rootDirection.copy(npc.direction);
    rootDirection.normalize();
    const heading = Math.atan2(rootDirection.x, rootDirection.z);
    const fleeing = npc.mode === 'flee';
    const gait = Math.sin(npc.gaitPhase + interpolation * npc.speed * 0.08);
    const bob = Math.abs(gait) * (fleeing ? 0.035 : 0.018) * npc.heightScale;
    rootPosition.y += bob;
    rootEuler.set(fleeing ? 0.09 : 0.015, heading, gait * (fleeing ? 0.035 : 0.012), 'YXZ');
    rootRotation.setFromEuler(rootEuler);
    worldMatrix.compose(rootPosition, rootRotation, rootScale);
    const limbSwing = gait * (fleeing ? 0.72 : 0.42);
    placePart(fleet.torsos, index, 0, 1.1, 0);
    placePart(fleet.heads, index, 0, 1.58, 0.015, 0, fleeing ? gait * 0.08 : 0, 0);
    placePart(fleet.leftArms, index, -0.25, 1.11, 0, limbSwing, 0, 0.08);
    placePart(fleet.rightArms, index, 0.25, 1.11, 0, -limbSwing, 0, -0.08);
    placePart(fleet.leftLegs, index, -0.11, 0.42, 0, -limbSwing, 0, 0.025);
    placePart(fleet.rightLegs, index, 0.11, 0.42, 0, limbSwing, 0, -0.025);
  }

  const meshes = [
    fleet.heads,
    fleet.torsos,
    fleet.leftArms,
    fleet.rightArms,
    fleet.leftLegs,
    fleet.rightLegs,
  ];
  meshes.forEach((mesh) => {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  });
  if (headColorsChanged && fleet.heads.instanceColor) {
    fleet.heads.instanceColor.needsUpdate = true;
  }
  if (shirtColorsChanged) {
    if (fleet.torsos.instanceColor) fleet.torsos.instanceColor.needsUpdate = true;
    if (fleet.leftArms.instanceColor) fleet.leftArms.instanceColor.needsUpdate = true;
    if (fleet.rightArms.instanceColor) fleet.rightArms.instanceColor.needsUpdate = true;
  }
  if (trousersColorsChanged) {
    if (fleet.leftLegs.instanceColor) fleet.leftLegs.instanceColor.needsUpdate = true;
    if (fleet.rightLegs.instanceColor) fleet.rightLegs.instanceColor.needsUpdate = true;
  }
}
