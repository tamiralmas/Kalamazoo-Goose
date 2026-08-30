import * as THREE from 'three';
import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl';

import { WMU_TREE_POINTS } from './wmu-trees';

export const WMU_SPAWN: [number, number] = [-85.61771, 42.284996];

export type FlightMode = 'flying' | 'waddling' | 'swimming';

export type GameTelemetry = {
  speed: number;
  agl: number;
  sink: number;
  glideRatio: number | null;
  stamina: number;
  stall: number;
  mode: FlightMode;
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
  destroy: () => void;
};

type GooseRig = {
  root: THREE.Group;
  leftWing: THREE.Group;
  rightWing: THREE.Group;
  legs: THREE.Group;
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
};

type TrafficCar = {
  root: THREE.Group;
  route: Route;
  distance: number;
  speed: number;
  cruise: number;
  ground: number;
  targetGround: number;
  elevationTimer: number;
  stopped: boolean;
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
const FIXED_DT = 1 / 120;
const DEG = Math.PI / 180;
const FALLBACK_GROUND_MSL = 0;
const FLAP_PERIOD = 0.36;
const DOWNSTROKE = 0.2;

const FLIGHT = {
  mass: 4.5,
  wingArea: 0.42,
  rho: 1.225,
  gravity: 9.81,
  cl0: 0.25,
  clAlpha: 4.8,
  clMax: 1.5,
  clMin: -0.8,
  alphaStall: 15 * DEG,
  alphaDeepStall: 24 * DEG,
  cd0: 0.03,
  inducedK: 0.055,
  deepStallDrag: 0.58,
  trimAlpha: 5.8 * DEG,
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
        0, 0.03, 0.3,
        1.75 * s, -0.05, 0.05,
        1.48 * s, -0.08, -0.45,
        0.76 * s, -0.02, -0.72,
        0.12 * s, 0.03, -0.52,
      ],
      3,
    ),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4]);
  geometry.computeVertexNormals();
  return geometry;
}

function createGooseRig() {
  const root = new THREE.Group();
  root.name = 'Canada goose';
  root.scale.setScalar(1.06);
  root.traverse((object) => {
    object.frustumCulled = false;
  });

  const brown = new THREE.MeshStandardMaterial({ color: 0x6c5742, roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x171b19, roughness: 0.82 });
  const cream = new THREE.MeshStandardMaterial({ color: 0xf0ead8, roughness: 0.88 });
  const wingMat = new THREE.MeshStandardMaterial({
    color: 0x4d4338,
    roughness: 0.92,
    side: THREE.DoubleSide,
  });
  const orange = new THREE.MeshStandardMaterial({ color: 0xe37c24, roughness: 0.75 });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.54, 14, 10), brown);
  body.scale.set(0.9, 0.72, 1.36);
  body.position.set(0, 0.78, 0);
  root.add(body);

  const breast = new THREE.Mesh(new THREE.SphereGeometry(0.43, 12, 8), cream);
  breast.scale.set(0.78, 0.55, 0.72);
  breast.position.set(0, 0.7, 0.42);
  root.add(breast);

  const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.135, 0.67, 5, 9), dark);
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
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.42, 7), orange);
    leg.position.set(side * 0.18, 0.29, 0.05);
    legs.add(leg);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.045, 0.31), orange);
    foot.position.set(side * 0.18, 0.075, 0.13);
    legs.add(foot);
  }
  root.add(legs);

  root.traverse((object) => {
    object.frustumCulled = false;
    if (object instanceof THREE.Mesh) {
      object.castShadow = false;
      object.receiveShadow = false;
    }
  });

  return { root, leftWing, rightWing, legs } satisfies GooseRig;
}

function createCar(color: number) {
  const root = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.12 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x22333a, roughness: 0.24 });
  const tire = new THREE.MeshStandardMaterial({ color: 0x171918, roughness: 0.96 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.43, 3.7), paint);
  body.position.y = 0.48;
  root.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.5, 1.85), glass);
  cabin.position.set(0, 0.9, -0.08);
  root.add(cabin);
  for (const x of [-0.78, 0.78]) {
    for (const z of [-1.16, 1.16]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.16, 9), tire);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.25, z);
      root.add(wheel);
    }
  }
  root.scale.setScalar(0.84);
  root.traverse((object) => {
    object.frustumCulled = false;
  });
  return root;
}

function routeFromPoints(points: THREE.Vector3[]) {
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + points[index].distanceTo(points[index - 1]));
  }
  return { points, cumulative, total: cumulative[cumulative.length - 1] } satisfies Route;
}

function sampleRoute(route: Route, distance: number) {
  const wrapped = ((distance % route.total) + route.total) % route.total;
  let index = 1;
  while (index < route.cumulative.length - 1 && route.cumulative[index] < wrapped) index += 1;
  const startDistance = route.cumulative[index - 1];
  const segmentLength = Math.max(route.cumulative[index] - startDistance, 0.001);
  const t = (wrapped - startDistance) / segmentLength;
  const position = route.points[index - 1].clone().lerp(route.points[index], t);
  const direction = route.points[index].clone().sub(route.points[index - 1]).normalize();
  return { position, direction };
}

export function createGooseEngine(
  maplibre: MapLibreModule,
  map: MapLibreMap,
  hooks: Hooks,
): GooseEngine {
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const goose = createGooseRig();
  scene.add(goose.root);
  scene.add(new THREE.HemisphereLight(0xdaf0f2, 0x6d6a4f, 2.35));
  const sun = new THREE.DirectionalLight(0xfff1c2, 3.2);
  sun.position.set(-90, 150, 60);
  scene.add(sun);

  const origin = maplibre.MercatorCoordinate.fromLngLat(WMU_SPAWN, 0);
  const meterScale = origin.meterInMercatorCoordinateUnits();
  const localToMap = new THREE.Matrix4().set(
    meterScale, 0, 0, origin.x,
    0, 0, -meterScale, origin.y,
    0, meterScale, 0, origin.z,
    0, 0, 0, 1,
  );

  const keys = new Set<string>();
  const styleLayers = map.getStyle().layers ?? [];
  const waterLayers = styleLayers
    .filter((layer) => layer.type === 'fill' && layer['source-layer'] === 'water')
    .map((layer) => layer.id);
  const roadSourceLayer = styleLayers.find(
    (layer) =>
      'source-layer' in layer &&
      layer['source-layer'] === 'transportation' &&
      'source' in layer &&
      typeof layer.source === 'string',
  );
  const roadSourceId =
    roadSourceLayer && 'source' in roadSourceLayer && typeof roadSourceLayer.source === 'string'
      ? roadSourceLayer.source
      : null;
  if (!roadSourceId) throw new Error('The map style did not provide OSM road geometry.');
  const buildingLayerIndex = styleLayers.findIndex(
    (layer) => layer.type === 'fill-extrusion' && layer['source-layer'] === 'building',
  );
  if (buildingLayerIndex < 0) throw new Error('The map style did not provide 3D buildings.');
  const customLayerBeforeId = styleLayers[buildingLayerIndex + 1]?.id;

  const state: SimState = {
    position: new THREE.Vector3(0, FALLBACK_GROUND_MSL + 32, 0),
    velocity: new THREE.Vector3(0, -0.45, 15.2),
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
    renderState.position.lerpVectors(previousState.position, state.position, blend);
    renderState.velocity.lerpVectors(previousState.velocity, state.velocity, blend);
    renderState.forward.lerpVectors(previousState.forward, state.forward, blend);
    if (renderState.forward.lengthSq() < 0.0001) renderState.forward.copy(state.forward);
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
    renderState.flapRemaining = lerp(previousState.flapRemaining, state.flapRemaining, blend);
  };

  let playing = false;
  let destroyed = false;
  let renderer: THREE.WebGLRenderer | null = null;
  let animationFrame = 0;
  let previousTime = performance.now();
  let accumulator = 0;
  let surfaceClock = 0;
  let telemetryClock = 0;
  let trafficBuilt = false;
  const terrainEnabled = Boolean(map.getTerrain());
  let unresolvedTreeCount = terrainEnabled ? WMU_TREE_POINTS.length : 0;
  let treeRefreshClock = 0;
  let lastYieldToast = -10;
  let elapsedTime = 0;
  let previousSpacePressed = false;
  const traffic: TrafficCar[] = [];
  const splashes: Splash[] = [];
  const cameraPosition = new THREE.Vector3(0, state.position.y + 15, -18);
  const cameraTarget = new THREE.Vector3(0, state.position.y + 1, 8);

  const localToLngLat = (east: number, north: number) =>
    new maplibre.MercatorCoordinate(
      origin.x + east * meterScale,
      origin.y - north * meterScale,
      0,
    ).toLngLat();

  const geoToLocal = (longitude: number, latitude: number) => {
    const coordinate = maplibre.MercatorCoordinate.fromLngLat([longitude, latitude], 0);
    return new THREE.Vector3(
      (coordinate.x - origin.x) / meterScale,
      0,
      (origin.y - coordinate.y) / meterScale,
    );
  };

  const terrainAt = (east: number, north: number, fallback = state.ground) => {
    const elevation = map.queryTerrainElevation(localToLngLat(east, north));
    return typeof elevation === 'number' && Number.isFinite(elevation) ? elevation : fallback;
  };

  const treeTrunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.22, 0.3, 1, 6),
    new THREE.MeshStandardMaterial({ color: 0x59432c, roughness: 1, vertexColors: true }),
    WMU_TREE_POINTS.length,
  );
  const treeCrowns = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(1, 0),
    new THREE.MeshStandardMaterial({ color: 0x44733f, roughness: 1, vertexColors: true }),
    WMU_TREE_POINTS.length,
  );
  treeTrunks.frustumCulled = false;
  treeCrowns.frustumCulled = false;
  scene.add(treeTrunks, treeCrowns);

  const treeLocalPoints = WMU_TREE_POINTS.map(([, longitude, latitude]) =>
    geoToLocal(longitude, latitude),
  );
  const treeGrounds: Array<number | null> = WMU_TREE_POINTS.map(() =>
    terrainEnabled ? null : state.ground,
  );

  const updateTrees = (nearPlayerOnly = false) => {
    let changed = false;
    const dummy = new THREE.Object3D();
    WMU_TREE_POINTS.forEach(([id], index) => {
      const point = treeLocalPoints[index];
      if (
        terrainEnabled &&
        treeGrounds[index] === null &&
        (!nearPlayerOnly || Math.hypot(point.x - state.position.x, point.z - state.position.z) < 650)
      ) {
        const elevation = map.queryTerrainElevation(localToLngLat(point.x, point.z));
        if (typeof elevation === 'number' && Number.isFinite(elevation)) {
          treeGrounds[index] = elevation;
          unresolvedTreeCount -= 1;
          changed = true;
        }
      }
      const ground = treeGrounds[index] ?? state.ground;
      const random = Math.abs(Math.sin(Number(id % 1000000) * 0.0173));
      const height = 5.6 + random * 4.8;
      const crownRadius = 1.55 + random * 1.15;

      dummy.position.set(point.x, ground + height * 0.42 + 0.08, point.z);
      dummy.scale.set(0.72 + random * 0.26, height * 0.84, 0.72 + random * 0.26);
      dummy.rotation.y = random * Math.PI;
      dummy.updateMatrix();
      treeTrunks.setMatrixAt(index, dummy.matrix);

      dummy.position.set(point.x, ground + height, point.z);
      dummy.scale.set(crownRadius, crownRadius * 1.12, crownRadius);
      dummy.rotation.y = random * Math.PI * 2;
      dummy.updateMatrix();
      treeCrowns.setMatrixAt(index, dummy.matrix);

      treeTrunks.setColorAt(index, new THREE.Color().setHSL(0.075, 0.35, 0.24 + random * 0.07));
      treeCrowns.setColorAt(index, new THREE.Color().setHSL(0.28 + random * 0.035, 0.36, 0.31 + random * 0.08));
    });
    treeTrunks.instanceMatrix.needsUpdate = true;
    treeCrowns.instanceMatrix.needsUpdate = true;
    if (treeTrunks.instanceColor) treeTrunks.instanceColor.needsUpdate = true;
    if (treeCrowns.instanceColor) treeCrowns.instanceColor.needsUpdate = true;
    return changed;
  };

  updateTrees();

  const sampleSurface = () => {
    const location = localToLngLat(state.position.x, state.position.z);
    const elevation = map.queryTerrainElevation(location);
    if (typeof elevation === 'number' && Number.isFinite(elevation)) state.ground = elevation;
    if (waterLayers.length > 0) {
      const point = map.project(location);
      const canvas = map.getCanvas();
      if (point.x >= 0 && point.y >= 0 && point.x <= canvas.clientWidth && point.y <= canvas.clientHeight) {
        state.onWater = map.queryRenderedFeatures(point, { layers: waterLayers }).length > 0;
      } else {
        state.onWater = false;
      }
    }
  };

  const spawnSplash = (strength: number) => {
    const group = new THREE.Group();
    group.position.set(state.position.x, state.ground + 0.18, state.position.z);
    const rings: Splash['rings'] = [];
    for (let index = 0; index < 3; index += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: index === 0 ? 0xf4fbf7 : 0x83d6df,
        transparent: true,
        opacity: 0.8 - index * 0.13,
        depthTest: true,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55 + index * 0.22, 0.055, 6, 28), material);
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
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.08 + (index % 3) * 0.02, 6, 5), material);
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
            if (object.material instanceof THREE.Material) object.material.dispose();
          }
        });
        splashes.splice(index, 1);
      }
    }
  };

  const buildTraffic = () => {
    if (trafficBuilt || !map.getSource(roadSourceId)) return;
    const allowed = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']);
    const features = map.querySourceFeatures(roadSourceId, { sourceLayer: 'transportation' }) as Array<{
      properties?: Record<string, unknown>;
      geometry: { type: string; coordinates: unknown };
    }>;
    const routes: Route[] = [];
    const seen = new Set<string>();

    const acceptLine = (coordinates: number[][]) => {
      if (coordinates.length < 2) return;
      const points = coordinates
        .filter((coordinate) => coordinate.length >= 2)
        .map(([longitude, latitude]) => geoToLocal(longitude, latitude))
        .filter((point) => Math.hypot(point.x, point.z) < 1800);
      if (points.length < 2) return;
      const key = `${points[0].x.toFixed(0)}:${points[0].z.toFixed(0)}:${points.at(-1)?.x.toFixed(0)}:${points.at(-1)?.z.toFixed(0)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const route = routeFromPoints(points);
      if (route.total >= 45) routes.push(route);
    };

    features.forEach((feature) => {
      const classValue = feature.properties?.class ?? feature.properties?.subclass;
      const roadClass = typeof classValue === 'string' ? classValue : '';
      if (!allowed.has(roadClass) || feature.properties?.brunnel === 'tunnel') return;
      if (feature.geometry.type === 'LineString') acceptLine(feature.geometry.coordinates as number[][]);
      if (feature.geometry.type === 'MultiLineString') {
        (feature.geometry.coordinates as number[][][]).forEach(acceptLine);
      }
    });

    routes.sort((a, b) => b.total - a.total);
    if (routes.length === 0) return;
    const colors = [0xc94b43, 0xe5ae39, 0x3d6f9f, 0xe8e4d6, 0x5a7358, 0x8b5a88, 0x33383c, 0xd47a36];
    const count = Math.min(8, Math.max(4, routes.length));
    for (let index = 0; index < count; index += 1) {
      const route = routes[index % Math.min(routes.length, 8)];
      const root = createCar(colors[index % colors.length]);
      scene.add(root);
      traffic.push({
        root,
        route,
        distance: route.total * ((index * 0.271 + 0.13) % 1),
        speed: 4 + (index % 3),
        cruise: 6.1 + (index % 4) * 0.85,
        ground: state.ground,
        targetGround: state.ground,
        elevationTimer: index * 0.025,
        stopped: false,
      });
    }
    trafficBuilt = true;
  };

  const updateTraffic = (dt: number) => {
    const gooseGrounded = state.mode !== 'flying';
    traffic.forEach((car, index) => {
      const sample = sampleRoute(car.route, car.distance);
      const distanceToGoose = Math.hypot(
        sample.position.x - state.position.x,
        sample.position.z - state.position.z,
      );
      const shouldStop = gooseGrounded && distanceToGoose < 15;
      const targetSpeed = shouldStop ? 0 : car.cruise;
      car.speed = moveToward(car.speed, targetSpeed, (shouldStop ? 10 : 2.5) * dt);
      car.distance += car.speed * dt;
      const next = sampleRoute(car.route, car.distance);
      car.elevationTimer -= dt;
      if (car.elevationTimer <= 0) {
        car.elevationTimer = 0.22 + index * 0.012;
        car.targetGround = terrainAt(next.position.x, next.position.z, car.targetGround);
      }
      car.ground = lerp(car.ground, car.targetGround, 1 - Math.exp(-8 * dt));
      car.root.position.set(next.position.x, car.ground + 0.06, next.position.z);
      car.root.rotation.y = Math.atan2(next.direction.x, next.direction.z);
      if (shouldStop && !car.stopped && elapsedTime - lastYieldToast > 5) {
        lastYieldToast = elapsedTime;
        hooks.onToast('Traffic stopped for the goose');
      }
      car.stopped = shouldStop;
    });
  };

  const beginFlapIfNeeded = (spaceRising: boolean) => {
    if (
      !keys.has('Space') ||
      state.flapRemaining > 0 ||
      state.stamina < 0.018 ||
      (state.mode !== 'flying' && !spaceRising)
    ) return;
    state.flapRemaining = FLAP_PERIOD;
    state.stamina = Math.max(0, state.stamina - 0.018);
    if (state.mode !== 'flying') {
      const forward = new THREE.Vector3(Math.sin(state.heading), 0, Math.cos(state.heading));
      state.mode = 'flying';
      state.position.y = state.ground + 0.45;
      state.velocity.copy(forward).multiplyScalar(8.5).addScaledVector(UP, 4.2);
      state.forward.copy(forward);
      hooks.onToast('Wingbeat — you are airborne');
    }
  };

  const simulateGround = (dt: number) => {
    const turnInput = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    const moveInput = Number(keys.has('KeyW')) - Number(keys.has('KeyS'));
    const topSpeed = state.mode === 'swimming' ? 2.4 : 3.8;
    state.heading += turnInput * (1.7 + Math.abs(moveInput) * 0.45) * dt;
    const forward = new THREE.Vector3(Math.sin(state.heading), 0, Math.cos(state.heading));
    const desired = forward.multiplyScalar(moveInput >= 0 ? moveInput * topSpeed : moveInput * 1.25);
    const response = state.mode === 'swimming' ? 1.2 : 2.5;
    state.velocity.lerp(desired, 1 - Math.exp(-response * dt));
    state.position.addScaledVector(state.velocity, dt);
    state.position.y = state.ground + 0.04;
    state.forward.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    state.bank = moveToward(state.bank, 0, 3 * dt);
    state.alpha = FLIGHT.trimAlpha;
    state.stall = 0;
    state.stamina = Math.min(1, state.stamina + 0.08 * dt);
  };

  const simulateFlight = (dt: number) => {
    const bankInput = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    const pullInput = Number(keys.has('KeyS')) - Number(keys.has('KeyW'));
    const brake = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0;
    const speed = Math.max(state.velocity.length(), 0.1);
    const authority = lerp(0.3, 1, smoothstep(5, 11, speed));
    const bankTarget = bankInput * FLIGHT.maxBank * (1 - 0.55 * brake);
    state.bank = moveToward(state.bank, bankTarget, FLIGHT.maxRollRate * authority * dt);

    const agl = state.position.y - state.ground;
    const flare = brake * clamp((8 - agl) / 7, 0, 1) * clamp((-state.velocity.y - 0.2) / 2, 0, 1);
    const alphaTarget = clamp(
      FLIGHT.trimAlpha + 14 * DEG * pullInput + 3 * DEG * brake + 4 * DEG * flare + 2 * DEG * Math.sin(state.bank) ** 2,
      -6 * DEG,
      24 * DEG,
    );
    state.alpha += (alphaTarget - state.alpha) * (1 - Math.exp(-dt / 0.2));

    const forward = speed > 2 ? state.velocity.clone().normalize() : state.forward.clone();
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
    state.stall = smoothstep(stallStart, FLIGHT.alphaDeepStall, Math.abs(state.alpha));
    const cl = lerp(attachedCl, Math.sign(attachedCl || 1) * 0.55, state.stall);
    const cd =
      FLIGHT.cd0 +
      FLIGHT.inducedK * cl * cl +
      FLIGHT.deepStallDrag * state.stall * state.stall +
      0.12 * brake;
    const dynamicPressure = 0.5 * FLIGHT.rho * speed * speed;
    const force = new THREE.Vector3(0, -FLIGHT.mass * FLIGHT.gravity, 0);
    force.addScaledVector(liftDirection, dynamicPressure * FLIGHT.wingArea * cl);
    force.addScaledVector(forward, -dynamicPressure * FLIGHT.wingArea * cd);

    if (state.flapRemaining > 0) {
      const elapsed = FLAP_PERIOD - state.flapRemaining;
      const pulse = elapsed < DOWNSTROKE ? Math.sin((Math.PI * elapsed) / DOWNSTROKE) : 0;
      const staminaScale = smoothstep(0.015, 0.22, state.stamina);
      const lowSpeedLift = lerp(125, 42, smoothstep(2, 9, speed));
      const highSpeedThrustScale = clamp((26 - speed) / 10, 0.2, 1);
      force.addScaledVector(forward, 24 * pulse * staminaScale * highSpeedThrustScale);
      force.addScaledVector(liftDirection, lowSpeedLift * pulse * staminaScale);
    } else {
      state.stamina = Math.min(1, state.stamina + 0.008 * dt);
    }

    state.velocity.addScaledVector(force, dt / FLIGHT.mass);
    if (state.velocity.length() > 38) state.velocity.setLength(38);
    state.position.addScaledVector(state.velocity, dt);

    if (state.position.y <= state.ground + 0.05) {
      const impact = Math.max(0, -state.velocity.y);
      state.position.y = state.ground + 0.05;
      state.mode = state.onWater ? 'swimming' : 'waddling';
      state.heading = Math.atan2(state.forward.x, state.forward.z);
      const retainedMomentum = state.onWater ? 0.85 : 0.65;
      state.velocity.set(
        state.velocity.x * retainedMomentum,
        0,
        state.velocity.z * retainedMomentum,
      );
      state.bank = 0;
      if (state.onWater) {
        spawnSplash(clamp((impact - 0.3) / 5, 0.15, 1));
        hooks.onToast(impact < 2.4 ? 'Clean water landing — splash!' : 'Big splash — hold Shift to flare');
      } else {
        hooks.onToast(impact < 2.4 ? 'Touchdown — now waddle' : 'Bumpy landing — flare with Shift');
      }
    }
  };

  const simulate = (dt: number) => {
    const spacePressed = keys.has('Space');
    const spaceRising = spacePressed && !previousSpacePressed;
    beginFlapIfNeeded(spaceRising);
    surfaceClock -= dt;
    if (surfaceClock <= 0) {
      surfaceClock = 0.12;
      sampleSurface();
    }
    if (state.mode === 'flying') simulateFlight(dt);
    else simulateGround(dt);
    if (state.flapRemaining > 0) {
      state.flapRemaining = Math.max(0, state.flapRemaining - dt);
    }
    previousSpacePressed = spacePressed;
  };

  const updateGoosePose = (pose: SimState) => {
    goose.root.position.copy(pose.position);
    const speed = pose.velocity.length();
    const waddle = pose.mode === 'waddling' ? Math.sin(elapsedTime * (6 + speed * 1.3)) : 0;
    goose.root.position.y += Math.abs(waddle) * 0.055;

    if (pose.mode === 'flying') {
      const forward = pose.forward.clone().normalize();
      const liftBase = UP.clone().addScaledVector(forward, -UP.dot(forward)).normalize();
      const liftDirection = liftBase.applyAxisAngle(forward, -pose.bank);
      const bodyForward = forward
        .clone()
        .multiplyScalar(Math.cos(pose.alpha))
        .addScaledVector(liftDirection, Math.sin(pose.alpha))
        .normalize();
      const bodyUp = liftDirection
        .clone()
        .multiplyScalar(Math.cos(pose.alpha))
        .addScaledVector(forward, -Math.sin(pose.alpha))
        .normalize();
      const bodyRight = new THREE.Vector3().crossVectors(bodyUp, bodyForward).normalize();
      goose.root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(bodyRight, bodyUp, bodyForward));
      goose.legs.visible = false;
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
      goose.root.rotation.set(0, pose.heading, -waddle * 0.055);
      goose.legs.visible = pose.mode === 'waddling';
      goose.leftWing.scale.set(0.42, 1, 0.84);
      goose.rightWing.scale.set(0.42, 1, 0.84);
      goose.leftWing.rotation.z = -0.66;
      goose.rightWing.rotation.z = 0.66;
    }
  };

  const updateCamera = (dt: number, pose: SimState, immediate = false) => {
    const horizontal = new THREE.Vector3(pose.forward.x, 0, pose.forward.z);
    if (horizontal.lengthSq() < 0.01) horizontal.set(Math.sin(pose.heading), 0, Math.cos(pose.heading));
    horizontal.normalize();
    const speed = pose.velocity.length();
    const chaseBack = 12 + 0.25 * speed;
    const chaseHeight = 12 + 0.25 * speed;
    const lookAhead = 6 + 0.25 * speed;
    const desiredPosition = pose.position
      .clone()
      .addScaledVector(horizontal, -chaseBack)
      .addScaledVector(UP, chaseHeight);
    desiredPosition.y = Math.max(
      desiredPosition.y,
      terrainAt(desiredPosition.x, desiredPosition.z, pose.ground) + 2.5,
    );
    const desiredTarget = pose.position.clone().addScaledVector(horizontal, lookAhead).addScaledVector(UP, 1.05);
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
    map.jumpTo({
      ...options,
      roll: clamp((-pose.bank / DEG) * 0.12, -6, 6),
    });
  };

  const emitTelemetry = () => {
    const horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    const sink = -state.velocity.y;
    hooks.onTelemetry({
      speed: state.mode === 'flying' ? state.velocity.length() : horizontalSpeed,
      agl: Math.max(0, state.position.y - state.ground),
      sink,
      glideRatio: state.mode === 'flying' && sink > 0.2 ? clamp(horizontalSpeed / sink, 0, 99) : null,
      stamina: state.stamina,
      stall: state.stall,
      mode: state.mode,
    });
  };

  const resetState = () => {
    const spawnGround = terrainAt(0, 0, state.ground);
    state.ground = spawnGround;
    state.position.set(0, spawnGround + 32, 0);
    state.velocity.set(0, -0.45, 15.2);
    state.forward.set(0, 0, 1);
    state.heading = 0;
    state.bank = 0;
    state.alpha = FLIGHT.trimAlpha;
    state.stamina = 1;
    state.stall = 0;
    state.mode = 'flying';
    state.onWater = false;
    state.flapRemaining = 0;
    previousSpacePressed = false;
    cameraPosition.set(0, state.position.y + 15, -18);
    cameraTarget.set(0, state.position.y + 1, 8);
    sampleSurface();
    copyState(previousState, state);
    copyState(renderState, state);
    updateGoosePose(renderState);
    updateCamera(1 / 60, renderState, true);
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
        .copy(new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix))
        .multiply(localToMap);
      renderer.resetState();
      renderer.render(scene, camera);
    },
    onRemove() {
      renderer?.dispose();
      renderer = null;
    },
  };

  map.addLayer(customLayer, customLayerBeforeId);

  const onIdle = () => {
    const hadTraffic = trafficBuilt;
    buildTraffic();
    const treesChanged = unresolvedTreeCount > 0 ? updateTrees(true) : false;
    if ((!hadTraffic && trafficBuilt) || treesChanged) map.triggerRepaint();
  };
  map.on('idle', onIdle);

  const frame = (now: number) => {
    if (destroyed) return;
    const frameDt = Math.min(0.1, Math.max(0, (now - previousTime) / 1000));
    previousTime = now;
    elapsedTime += frameDt;
    if (playing) {
      accumulator += frameDt;
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < 8) {
        copyState(previousState, state);
        simulate(FIXED_DT);
        accumulator -= FIXED_DT;
        steps += 1;
      }
      if (steps >= 8) accumulator = 0;
      interpolateState(accumulator / FIXED_DT);
      updateTraffic(frameDt);
      treeRefreshClock -= frameDt;
      if (unresolvedTreeCount > 0 && treeRefreshClock <= 0) {
        treeRefreshClock = 1.25;
        updateTrees(true);
      }
    }
    updateSplashes(frameDt);
    updateGoosePose(renderState);
    if (playing) updateCamera(frameDt, renderState);
    telemetryClock -= frameDt;
    if (telemetryClock <= 0) {
      telemetryClock = 0.1;
      emitTelemetry();
    }
    if (playing || splashes.length > 0) map.triggerRepaint();
    animationFrame = requestAnimationFrame(frame);
  };

  resetState();
  animationFrame = requestAnimationFrame(frame);

  return {
    start() {
      playing = true;
      previousTime = performance.now();
      hooks.onToast('Glide from WMU — dive for speed, pull up to trade it for height');
    },
    reset() {
      resetState();
      playing = true;
      previousTime = performance.now();
      hooks.onToast('Respawned above Western Michigan University');
    },
    setKey(code, pressed) {
      if (pressed) keys.add(code);
      else keys.delete(code);
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(animationFrame);
      map.off('idle', onIdle);
      keys.clear();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
    },
  };
}
