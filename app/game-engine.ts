import * as THREE from 'three';
import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl';

import { WMU_TREE_POINTS } from './wmu-trees';

export const WMU_SPAWN: [number, number] = [-85.61771, 42.284996];

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
  wheels: THREE.InstancedMesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
};

type HonkWave = {
  mesh: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  age: number;
  life: number;
};

type BuildingCollider = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  ground: number;
  height: number;
};

type CampusSecretKind = 'radio' | 'duck-council' | 'diploma-tornado' | 'sky-ring' | 'dean-ufo';

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
const FLAP_STAMINA_COST = 0.014;
const SPAWN_ALTITUDE = 64;
const MAX_TRAFFIC = 32;
const BUILDING_TEXTURE_MAX_ZOOM = 18;
const BUILDING_TEXTURE_MIN_ZOOM = 15;
const CHAOS_COMBO_SECONDS = 4;

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
  root.scale.setScalar(0.4);
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

function createTrafficFleet(capacity: number) {
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.52,
    metalness: 0.12,
  });
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0x26383e,
    roughness: 0.24,
    metalness: 0.08,
  });
  const tireMaterial = new THREE.MeshStandardMaterial({ color: 0x171918, roughness: 0.96 });
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
  const wheels = new THREE.InstancedMesh(wheelGeometry, tireMaterial, capacity * 4);
  bodies.count = 0;
  cabins.count = 0;
  wheels.count = 0;
  bodies.frustumCulled = false;
  cabins.frustumCulled = false;
  wheels.frustumCulled = false;
  return { bodies, cabins, wheels } satisfies TrafficFleet;
}

function routeFromPoints(points: THREE.Vector3[], cruise = 7, laneWidth = 1.35) {
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + points[index].distanceTo(points[index - 1]));
  }
  return { points, cumulative, total: cumulative[cumulative.length - 1], cruise, laneWidth } satisfies Route;
}

function sampleRoute(route: Route, distance: number) {
  const routeDistance = clamp(distance, 0, route.total);
  let index = 1;
  while (index < route.cumulative.length - 1 && route.cumulative[index] < routeDistance) index += 1;
  const startDistance = route.cumulative[index - 1];
  const segmentLength = Math.max(route.cumulative[index] - startDistance, 0.001);
  const t = (routeDistance - startDistance) / segmentLength;
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
  const trafficFleet = createTrafficFleet(MAX_TRAFFIC);
  scene.add(goose.root);
  scene.add(trafficFleet.bodies, trafficFleet.cabins, trafficFleet.wheels);
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
  const buildingLayer = styleLayers[buildingLayerIndex];
  const buildingSourceId =
    'source' in buildingLayer && typeof buildingLayer.source === 'string'
      ? buildingLayer.source
      : null;
  if (!buildingSourceId) throw new Error('The map style did not provide OSM building geometry.');
  const customLayerBeforeId = styleLayers[buildingLayerIndex + 1]?.id;

  const state: SimState = {
    position: new THREE.Vector3(0, FALLBACK_GROUND_MSL + SPAWN_ALTITUDE, 0),
    velocity: new THREE.Vector3(0, -0.4, 16.2),
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
  let queuedFlaps = 0;
  let queuedHonks = 0;
  let honkCooldown = 0;
  let chaosScore = 0;
  let chaosCombo = 1;
  let chaosComboEvents = 0;
  let chaosComboRemaining = 0;
  let tumbleRemaining = 0;
  let tumbleAngle = 0;
  let tumbleAngularSpeed = 0;
  let hitCooldown = 0;
  let cameraShakeRemaining = 0;
  let audioContext: AudioContext | null = null;
  let airborneTime = 0;
  let peakAgl = 0;
  let waterSurfaceY = state.ground;
  let waterPlaningElapsed = 0;
  let waterDryTime = 0;
  let waterTouchdownSeverity = 0;
  let waterSprayClock = 0;
  const texturedBuildingKeys = new Set<string>();
  const buildingMaterials = new Map<
    string,
    {
      texture: THREE.Texture;
      roof: THREE.MeshBasicMaterial;
    }
  >();
  const buildingColliders: BuildingCollider[] = [];
  const traffic: TrafficCar[] = [];
  const splashes: Splash[] = [];
  const honkWaves: HonkWave[] = [];
  const campusSecrets: CampusSecret[] = [];
  let secretsFound = 0;
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

  const finiteNumber = (value: unknown, fallback: number) => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const chooseBuildingTextureTile = (ring: number[][]) => {
    const mercatorPoints = ring.map(([longitude, latitude]) =>
      maplibre.MercatorCoordinate.fromLngLat([longitude, latitude], 0),
    );
    for (let zoom = BUILDING_TEXTURE_MAX_ZOOM; zoom >= BUILDING_TEXTURE_MIN_ZOOM; zoom -= 1) {
      const scale = 2 ** zoom;
      const tileX = Math.floor(mercatorPoints[0].x * scale);
      const tileY = Math.floor(mercatorPoints[0].y * scale);
      if (
        mercatorPoints.every(
          (point) => Math.floor(point.x * scale) === tileX && Math.floor(point.y * scale) === tileY,
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
        loadedTexture.anisotropy = Math.min(8, renderer?.capabilities.getMaxAnisotropy() ?? 4);
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
    const features = map.querySourceFeatures(buildingSourceId, { sourceLayer: 'building' }) as Array<{
      id?: string | number;
      properties?: Record<string, unknown>;
      geometry: { type: string; coordinates: unknown };
    }>;
    let added = 0;

    features.forEach((feature) => {
      const polygonSets = feature.geometry.type === 'Polygon'
        ? [feature.geometry.coordinates as number[][][]]
        : feature.geometry.type === 'MultiPolygon'
          ? (feature.geometry.coordinates as number[][][][])
          : [];
      const properties = feature.properties ?? {};
      const levels = finiteNumber(properties.levels, 0);
      const height = clamp(
        finiteNumber(properties.render_height ?? properties.height, levels > 0 ? levels * 3.1 : 3.2),
        2.6,
        180,
      );
      polygonSets.forEach((rings, polygonIndex) => {
        const outerRing = rings[0]?.filter((coordinate) => coordinate.length >= 2) ?? [];
        if (outerRing.length < 4) return;
        const localOuter = outerRing.map(([longitude, latitude]) => geoToLocal(longitude, latitude));
        const minX = Math.min(...localOuter.map((point) => point.x));
        const maxX = Math.max(...localOuter.map((point) => point.x));
        const minZ = Math.min(...localOuter.map((point) => point.z));
        const maxZ = Math.max(...localOuter.map((point) => point.z));
        const centerX = (minX + maxX) * 0.5;
        const centerZ = (minZ + maxZ) * 0.5;
        if (Math.hypot(centerX, centerZ) > 1800 || maxX - minX < 0.8 || maxZ - minZ < 0.8) return;

        const footprintKey = [
          feature.id ?? 'building',
          polygonIndex,
          minX.toFixed(1),
          minZ.toFixed(1),
          maxX.toFixed(1),
          maxZ.toFixed(1),
          height.toFixed(1),
        ].join(':');
        if (texturedBuildingKeys.has(footprintKey)) return;

        const shapePoints = localOuter.slice(0, -1).map((point) => new THREE.Vector2(point.x, -point.z));
        if (shapePoints.length < 3) return;
        const shape = new THREE.Shape(shapePoints);
        rings.slice(1).forEach((holeRing) => {
          const holePoints = holeRing
            .filter((coordinate) => coordinate.length >= 2)
            .map(([longitude, latitude]) => geoToLocal(longitude, latitude))
            .slice(0, -1)
            .map((point) => new THREE.Vector2(point.x, -point.z));
          if (holePoints.length >= 3) shape.holes.push(new THREE.Path(holePoints));
        });

        const { zoom, tileX, tileY } = chooseBuildingTextureTile(outerRing);
        const materials = getBuildingMaterials(zoom, tileX, tileY);
        const geometry = new THREE.ShapeGeometry(shape, 1);
        applyBuildingRoofUvs(geometry, zoom, tileX, tileY);
        geometry.rotateX(-Math.PI / 2);
        const ground = terrainAt(centerX, centerZ, state.ground);
        geometry.translate(0, ground + height + 0.08, 0);
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, materials.roof);
        mesh.name = 'MiSAIL aerial roof overlay';
        mesh.frustumCulled = false;
        mesh.renderOrder = 1;
        scene.add(mesh);
        buildingColliders.push({ minX, maxX, minZ, maxZ, ground, height });
        texturedBuildingKeys.add(footprintKey);
        added += 1;
      });
    });

    return added > 0;
  };

  const createCampusSecrets = () => {
    const gold = new THREE.MeshStandardMaterial({
      color: 0xf4b942,
      roughness: 0.48,
      metalness: 0.32,
      emissive: 0x4b2600,
      emissiveIntensity: 0.4,
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x20312b, roughness: 0.76 });
    const cream = new THREE.MeshStandardMaterial({ color: 0xf3ead2, roughness: 0.82 });
    const orange = new THREE.MeshStandardMaterial({ color: 0xe9862b, roughness: 0.72 });
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
    ) => {
      const ground = terrainAt(east, north, state.ground);
      group.position.set(east, ground + altitude, north);
      group.userData.baseY = group.position.y;
      finishGroup(group);
      campusSecrets.push({
        id,
        kind,
        group,
        position: group.position.clone(),
        radius,
        found: false,
        activation: 0,
        honkCount: 0,
        honkWindow: 0,
      });
    };

    const radio = new THREE.Group();
    radio.name = 'Fetzer Radio Goose';
    const radioMast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 4.4, 8), dark);
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
    const radioBeacon = new THREE.Mesh(new THREE.TorusGeometry(2.25, 0.07, 7, 32), glow.clone());
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
    for (let index = 0; index < 5; index += 1) {
      const angle = (index / 5) * Math.PI * 2;
      const duck = makeDuck(0.9);
      duck.position.set(Math.cos(angle) * 3.2, 0, Math.sin(angle) * 3.2);
      duck.rotation.y = -angle + Math.PI / 2;
      council.add(duck);
    }
    const duckElder = makeDuck(2.8);
    duckElder.name = 'duck-elder';
    duckElder.position.y = -3.2;
    council.add(duckElder);
    addSecret('duck-council', 'duck-council', council, 112.4, 332.4, 0.08, 30);

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
      paper.position.set(Math.cos(angle) * (1 + (index % 4) * 0.24), 0.3 + index * 0.34, Math.sin(angle) * (1 + (index % 4) * 0.24));
      paper.rotation.set(angle * 0.2, angle, angle * 0.45);
      diploma.add(paper);
    }
    addSecret('diploma-tornado', 'diploma-tornado', diploma, 258.3, -105.4, 0.08, 5.5);

    const skyRing = new THREE.Group();
    skyRing.name = 'Miller Auditori-Honk';
    const outerRing = new THREE.Mesh(new THREE.TorusGeometry(4.3, 0.32, 10, 44), gold);
    outerRing.name = 'portal-outer';
    skyRing.add(outerRing);
    const innerRing = new THREE.Mesh(new THREE.TorusGeometry(3.55, 0.08, 8, 40), glow.clone());
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
    const cropCircle = new THREE.Mesh(new THREE.TorusGeometry(5.4, 0.12, 7, 48), glow.clone());
    cropCircle.rotation.x = Math.PI / 2;
    cropCircle.position.y = 0.12;
    ufoSite.add(cropCircle);
    for (let index = 0; index < 7; index += 1) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.85, 8), orange);
      const angle = (index / 7) * Math.PI * 2;
      cone.position.set(Math.cos(angle) * 4.8, 0.42, Math.sin(angle) * 4.8);
      ufoSite.add(cone);
    }
    const saucer = new THREE.Group();
    saucer.name = 'secret-saucer';
    saucer.visible = false;
    saucer.position.y = 8;
    const saucerBody = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 2.1, 0.55, 18), dark);
    saucer.add(saucerBody);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1.5, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), glow.clone());
    dome.position.y = 0.25;
    saucer.add(dome);
    ufoSite.add(saucer);
    addSecret('dean-ufo', 'dean-ufo', ufoSite, 213.5, 567.8, 0.08, 13);
  };

  createCampusSecrets();

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

  const spawnSkimSpray = (speed: number) => {
    const group = new THREE.Group();
    const forward = new THREE.Vector3(state.velocity.x, 0, state.velocity.z);
    if (forward.lengthSq() < 0.01) forward.set(Math.sin(state.heading), 0, Math.cos(state.heading));
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
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.045 + (index % 3) * 0.018, 5, 4), material);
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
    const cruiseByClass: Record<string, number> = {
      motorway: 13,
      trunk: 11.5,
      primary: 10.5,
      secondary: 9,
      tertiary: 8,
      minor: 6.7,
      service: 4.7,
    };
    const features = map.querySourceFeatures(roadSourceId, { sourceLayer: 'transportation' }) as Array<{
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
      const classValue = feature.properties?.class ?? feature.properties?.subclass;
      const roadClass = typeof classValue === 'string' ? classValue : '';
      if (!allowed.has(roadClass) || feature.properties?.brunnel === 'tunnel' || feature.properties?.brunnel === 'bridge') return;
      if (feature.geometry.type === 'LineString') acceptLine(feature.geometry.coordinates as number[][], roadClass);
      if (feature.geometry.type === 'MultiLineString') {
        (feature.geometry.coordinates as number[][][]).forEach((line) => acceptLine(line, roadClass));
      }
    });

    routes.sort((a, b) => b.total - a.total);
    if (routes.length === 0) return;
    const colors = [0xc94b43, 0xe5ae39, 0x3d6f9f, 0xe8e4d6, 0x5a7358, 0x8b5a88, 0x33383c, 0xd47a36];
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
      trafficFleet.bodies.setColorAt(index, new THREE.Color(colors[index % colors.length]));
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
    if (trafficFleet.bodies.instanceColor) trafficFleet.bodies.instanceColor.needsUpdate = true;
    trafficBuilt = true;
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
      const longitudinal = toGooseX * car.direction.x + toGooseZ * car.direction.z;
      const lateral = Math.abs(toGooseX * rightX + toGooseZ * rightZ);
      const stopDistance = 4.5 + 0.7 * car.speed + (car.speed * car.speed) / 10;
      const shouldYield = gooseGrounded && longitudinal > -2 && longitudinal < stopDistance && lateral < 2.3;

      let targetSpeed = car.reactionRemaining > 0 ? car.cruise * 0.18 : car.cruise;
      if (shouldYield) targetSpeed = 0;
      let closestLeaderGap = Infinity;
      let leaderSpeed = targetSpeed;
      traffic.forEach((other) => {
        if (other === car || other.route !== car.route || other.directionSign !== car.directionSign) return;
        const gap = (other.distance - car.distance) * car.directionSign;
        if (gap > 0 && gap < closestLeaderGap) {
          closestLeaderGap = gap;
          leaderSpeed = other.speed;
        }
      });
      const desiredGap = 6.5 + 1.2 * car.speed;
      if (closestLeaderGap < desiredGap) {
        targetSpeed = Math.min(targetSpeed, closestLeaderGap < 5 ? 0 : leaderSpeed * 0.82);
      }

      const acceleration = targetSpeed < car.speed ? (shouldYield ? 7 : 4.5) : 1.8;
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
        car.targetGround = terrainAt(next.position.x, next.position.z, car.targetGround);
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
      direction.lerpVectors(car.previousDirection, car.direction, blend).normalize();
      const heading = Math.atan2(direction.x, direction.z);
      const wobble = Math.sin(elapsedTime * 17 + car.index * 1.9) * 0.065 * clamp(car.wobbleRemaining, 0, 1);
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

  const awardChaos = (basePoints: number, label: string) => {
    chaosComboEvents += 1;
    chaosCombo = Math.min(5, 1 + Math.floor((chaosComboEvents - 1) / 3));
    chaosComboRemaining = CHAOS_COMBO_SECONDS;
    const points = basePoints * chaosCombo;
    chaosScore += points;
    hooks.onToast(`${label} · +${points}${chaosCombo > 1 ? ` · x${chaosCombo}` : ''}`);
  };

  const launchGoose = (verticalSpeed: number, forwardBoost: number) => {
    const horizontal = new THREE.Vector3(state.forward.x, 0, state.forward.z);
    if (horizontal.lengthSq() < 0.01) horizontal.set(Math.sin(state.heading), 0, Math.cos(state.heading));
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

  const discoverSecret = (secret: CampusSecret, points: number, label: string) => {
    if (secret.found) return;
    secret.found = true;
    secret.activation = 0;
    secretsFound += 1;
    secret.group.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial) {
        object.material.emissive.setHex(0x5a3000);
        object.material.emissiveIntensity = Math.max(object.material.emissiveIntensity, 0.62);
      }
    });
    awardChaos(points, `${label} · SECRET ${secretsFound}/${campusSecrets.length}`);
  };

  const registerSecretHonk = () => {
    campusSecrets.forEach((secret) => {
      if (secret.found) return;
      const distance = state.position.distanceTo(secret.position);
      if (secret.kind === 'duck-council' && distance < secret.radius && state.onWater) {
        discoverSecret(secret, 900, 'CHOSEN OF THE POND');
        cameraShakeRemaining = 0.14;
        return;
      }
      if ((secret.kind === 'radio' || secret.kind === 'dean-ufo') && distance < secret.radius) {
        if (secret.honkWindow <= 0) secret.honkCount = 0;
        secret.honkCount += 1;
        secret.honkWindow = 4;
        if (secret.honkCount < 3) {
          hooks.onToast(`${secret.kind === 'radio' ? 'The dish is listening' : 'The cones are humming'} · honk ${secret.honkCount}/3`);
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
      secret.honkWindow = Math.max(0, secret.honkWindow - dt);
      if (secret.honkWindow === 0 && !secret.found) secret.honkCount = 0;
      secret.activation += secret.found ? dt : 0;
      const pulse = 1 + Math.sin(elapsedTime * 3.2 + secretIndex) * 0.045;

      if (secret.kind === 'radio') {
        const beacon = secret.group.getObjectByName('secret-beacon');
        if (beacon) {
          beacon.rotation.z += dt * (secret.found ? 4.5 : 0.75);
          beacon.scale.setScalar(secret.found ? 1.25 + Math.sin(elapsedTime * 7) * 0.18 : pulse);
        }
        if (secret.found) secret.group.position.y = secret.group.userData.baseY + Math.sin(elapsedTime * 4) * 0.08;
      } else if (secret.kind === 'duck-council') {
        secret.group.rotation.y += dt * (secret.found ? 1.8 : 0.18);
        const elder = secret.group.getObjectByName('duck-elder');
        if (elder) elder.position.y = lerp(-3.2, 0.15, smoothstep(0, 1.3, secret.activation));
      } else if (secret.kind === 'diploma-tornado') {
        secret.group.rotation.y += dt * (secret.found ? 4.2 : 0.34);
        secret.group.children.forEach((paper, index) => {
          paper.rotation.x += dt * (0.25 + index * 0.025) * (secret.found ? 4 : 1);
          if (secret.found) paper.position.y += dt * 0.55;
        });
      } else if (secret.kind === 'sky-ring') {
        secret.group.rotation.z += dt * (secret.found ? 1.8 : 0.22);
        secret.group.scale.setScalar(secret.found ? 1.08 + Math.sin(elapsedTime * 8) * 0.09 : pulse);
      } else if (secret.kind === 'dean-ufo') {
        secret.group.rotation.y += dt * (secret.found ? 1.3 : 0.12);
        const saucer = secret.group.getObjectByName('secret-saucer');
        if (saucer) {
          saucer.visible = secret.found;
          saucer.position.y = 8 + Math.sin(elapsedTime * 2.7) * 0.75 + Math.min(9, secret.activation * 3.5);
        }
      }

      if (secret.found) return;
      const distance = state.position.distanceTo(secret.position);
      if (secret.kind === 'diploma-tornado' && distance < secret.radius) {
        discoverSecret(secret, 600, 'ACADEMIC MENACE');
        launchGoose(7.5, 2.5);
        cameraShakeRemaining = 0.18;
      } else if (secret.kind === 'sky-ring' && state.mode === 'flying' && distance < secret.radius) {
        discoverSecret(secret, 850, 'STANDING OVATION');
        state.velocity.addScaledVector(state.forward, 8);
        state.velocity.y += 4.5;
        state.stamina = 1;
        spawnHonkWave();
      }
    });
  };

  const playHonk = () => {
    try {
      audioContext ??= new AudioContext();
      if (audioContext.state === 'suspended') void audioContext.resume();
      const now = audioContext.currentTime;
      const gain = audioContext.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.11, now + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
      gain.connect(audioContext.destination);
      [
        { start: 205, end: 142, volume: 0.7 },
        { start: 154, end: 112, volume: 0.42 },
      ].forEach(({ start, end, volume }) => {
        const oscillator = audioContext!.createOscillator();
        const voiceGain = audioContext!.createGain();
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
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.045, 6, 34), material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(state.position.x, state.position.y + 0.2, state.position.z);
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
    const radius = state.mode === 'flying' && agl < 20 ? 34 : 26;
    const nearby = traffic
      .map((car) => ({
        car,
        distance: Math.hypot(car.position.x - state.position.x, car.position.z - state.position.z),
      }))
      .filter(({ distance }) => distance <= radius)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3);
    let scoredCars = 0;
    nearby.forEach(({ car, distance }) => {
      car.reactionRemaining = Math.max(car.reactionRemaining, distance < 10 ? 1.55 : 2.1);
      car.wobbleRemaining = Math.max(car.wobbleRemaining, 1.25);
      if (car.honkScoreCooldown <= 0 && car.speed > 0.8) {
        car.honkScoreCooldown = 6;
        scoredCars += 1;
      }
    });
    if (scoredCars > 0) {
      awardChaos(50 * scoredCars, scoredCars >= 2 ? `HONK CHAIN ×${scoredCars}` : 'HONK IF YOU YIELD');
    } else {
      hooks.onToast('HONK!');
    }
    registerSecretHonk();
  };

  const updateChaosTimers = (dt: number) => {
    honkCooldown = Math.max(0, honkCooldown - dt);
    hitCooldown = Math.max(0, hitCooldown - dt);
    cameraShakeRemaining = Math.max(0, cameraShakeRemaining - dt);
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
      state.velocity.y = Math.abs(state.velocity.y) > 1 ? -state.velocity.y * 0.22 : 0;
      state.velocity.x *= Math.exp(-2.5 * dt);
      state.velocity.z *= Math.exp(-2.5 * dt);
      state.mode = state.onWater ? 'swimming' : 'waddling';
    }
    if (tumbleRemaining <= FIXED_DT) {
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
      const overlaps = Math.abs(localX) < 1.25 && Math.abs(localZ) < 2.45 && vertical > -0.2 && vertical < 1.65;

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
        awardChaos(state.mode === 'flying' ? 225 : 200, state.mode === 'flying' ? 'AIRBORNE CAR BOP' : 'INSURANCE FRAUD');
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
    const wantsWingbeat = queuedFlaps > 0 || (spaceHeld && state.mode === 'flying');
    if (!wantsWingbeat || state.flapRemaining > 0) return;
    if (state.mode !== 'flying' && queuedFlaps === 0) return;

    queuedFlaps = Math.max(0, queuedFlaps - 1);
    state.flapRemaining = FLAP_PERIOD;
    state.stamina = Math.max(0, state.stamina - FLAP_STAMINA_COST);
    if (state.mode !== 'flying') {
      const forward = new THREE.Vector3(Math.sin(state.heading), 0, Math.cos(state.heading));
      const launchSpeed = Math.max(10.5, Math.hypot(state.velocity.x, state.velocity.z));
      state.mode = 'flying';
      state.position.y = state.ground + 0.45;
      state.velocity.copy(forward).multiplyScalar(launchSpeed).addScaledVector(UP, 5.8);
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
    if (state.onWater) waterSurfaceY = lerp(waterSurfaceY, state.ground, 1 - Math.exp(-3 * dt));

    const turnInput = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    const brake = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0;
    const horizontal = new THREE.Vector3(state.velocity.x, 0, state.velocity.z);
    const speed = horizontal.length();
    if (horizontal.lengthSq() < 0.01) horizontal.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    horizontal.normalize();
    state.heading = Math.atan2(horizontal.x, horizontal.z);
    const yawRate = lerp(0.75, 0.16, smoothstep(3, 15, speed));
    state.heading += turnInput * yawRate * dt;
    const steered = new THREE.Vector3(Math.sin(state.heading), 0, Math.cos(state.heading));
    horizontal.lerp(steered, 1 - Math.exp(-2.4 * dt)).normalize();

    const impactDrag = 4 * waterTouchdownSeverity * Math.exp(-6 * waterPlaningElapsed);
    const drag = 0.18 * speed + 0.025 * speed * speed + impactDrag + brake * 2.6;
    const nextSpeed = Math.max(0, speed - drag * dt);
    state.velocity.x = horizontal.x * nextSpeed;
    state.velocity.z = horizontal.z * nextSpeed;

    const plane = smoothstep(2.8, 11, nextSpeed);
    const rideHeight = 0.055 + 0.105 * plane;
    const targetY = waterSurfaceY + rideHeight;
    const omega = nextSpeed >= 3 ? 8 : 10;
    const accelerationY = omega * omega * (targetY - state.position.y) - 2 * 0.9 * omega * state.velocity.y;
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

    if ((nextSpeed < 2.8 && waterPlaningElapsed > 0.38) || waterPlaningElapsed > 8) {
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
    state.stamina = Math.min(1, state.stamina + 0.18 * dt);
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
      // Tired wings lose climb performance, but never silently discard an accepted input.
      const staminaScale = lerp(0.48, 1, smoothstep(0, 0.28, state.stamina));
      const lowSpeedLift = lerp(155, 58, smoothstep(2, 10, speed));
      const highSpeedThrustScale = clamp((26 - speed) / 10, 0.2, 1);
      force.addScaledVector(forward, 36 * pulse * staminaScale * highSpeedThrustScale);
      force.addScaledVector(liftDirection, lowSpeedLift * pulse * staminaScale);
    } else {
      state.stamina = Math.min(1, state.stamina + 0.055 * dt);
    }

    state.velocity.addScaledVector(force, dt / FLIGHT.mass);
    if (state.velocity.length() > 38) state.velocity.setLength(38);
    state.position.addScaledVector(state.velocity, dt);

    if (state.position.y <= state.ground + 0.05) {
      const impact = Math.max(0, -state.velocity.y);
      const landingSpeed = Math.hypot(state.velocity.x, state.velocity.z);
      const bankDegrees = Math.abs(state.bank / DEG);
      const landingCounts = airborneTime > 1.5 && peakAgl > 3;
      state.position.y = state.ground + 0.05;
      const waterRun = state.onWater && landingSpeed >= 3 && impact < 6;
      state.mode = state.onWater ? (waterRun ? 'planing' : 'swimming') : 'waddling';
      state.heading = Math.atan2(state.forward.x, state.forward.z);
      const waterSeverity = clamp(impact / 7 + bankDegrees / 90, 0, 1);
      const retainedMomentum = state.onWater ? lerp(0.98, 0.8, waterSeverity) : 0.65;
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
        if (landingCounts) {
          if (impact > 4.5 || bankDegrees > 35) awardChaos(350, 'BELLY FLOP');
          else if (impact >= 0.7 && impact < 2.3 && bankDegrees < 20) awardChaos(300, 'PERFECT SPLASHDOWN');
          else awardChaos(140, 'SPLASHDOWN-ISH');
        } else {
          hooks.onToast(impact < 2.4 ? 'Clean water landing — splash!' : 'Big splash — hold Shift to flare');
        }
      } else {
        if (landingCounts) {
          if (impact < 2 && bankDegrees < 15 && landingSpeed >= 8 && landingSpeed <= 17) {
            awardChaos(250, 'GREASED LANDING');
          } else if (impact > 4.5) {
            awardChaos(300, 'LAWN DART');
          } else {
            awardChaos(100, 'TOUCHDOWN-ISH');
          }
        } else {
          hooks.onToast(impact < 2.4 ? 'Touchdown — now waddle' : 'Bumpy landing — flare with Shift');
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

  const simulate = (dt: number) => {
    updateChaosTimers(dt);
    if (queuedHonks > 0 && honkCooldown <= 0) performHonk();
    beginFlapIfNeeded();
    surfaceClock -= dt;
    if (surfaceClock <= 0) {
      surfaceClock = state.mode === 'planing' || (state.mode === 'flying' && state.position.y - state.ground < 2 && state.velocity.y < 0)
        ? 0.035
        : 0.12;
      sampleSurface();
    }
    simulateTraffic(dt);
    if (tumbleRemaining > 0) simulateTumble(dt);
    else if (state.mode === 'planing') simulateWaterPlaning(dt);
    else if (state.mode === 'flying') simulateFlight(dt);
    else simulateGround(dt);
    resolveTrafficInteractions();
    updateCampusSecrets(dt);
    if (state.flapRemaining > 0) {
      state.flapRemaining = Math.max(0, state.flapRemaining - dt);
    }
  };

  const updateGoosePose = (pose: SimState) => {
    goose.root.position.copy(pose.position);
    const speed = pose.velocity.length();
    const waddle = pose.mode === 'waddling' ? Math.sin(elapsedTime * (6 + speed * 1.3)) : 0;
    goose.root.position.y += Math.abs(waddle) * 0.055;

    if (pose.mode === 'flying' || pose.mode === 'planing') {
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

    if (tumbleRemaining > 0) {
      const tumble = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(tumbleAngle * 0.72, tumbleAngle, tumbleAngle * 0.48, 'YXZ'),
      );
      goose.root.quaternion.multiply(tumble).normalize();
    }
  };

  const updateCamera = (dt: number, pose: SimState, immediate = false) => {
    const horizontal = new THREE.Vector3(pose.forward.x, 0, pose.forward.z);
    if (horizontal.lengthSq() < 0.01) horizontal.set(Math.sin(pose.heading), 0, Math.cos(pose.heading));
    horizontal.normalize();
    const speed = clamp(pose.velocity.length(), 8, 26);
    const isFlying = pose.mode === 'flying' || pose.mode === 'planing';
    const chaseBack = isFlying ? 7 + 0.06 * speed : 4.8;
    const chaseHeight = isFlying ? 3.2 + 0.055 * speed : 2.5;
    const lookAhead = isFlying ? 4.5 + 0.08 * speed : 3;
    const desiredPosition = pose.position
      .clone()
      .addScaledVector(horizontal, -chaseBack)
      .addScaledVector(UP, chaseHeight);
    desiredPosition.y = Math.max(
      desiredPosition.y,
      terrainAt(desiredPosition.x, desiredPosition.z, pose.ground) + 2.5,
    );
    for (const building of buildingColliders) {
      if (
        desiredPosition.x > building.minX - 0.6 &&
        desiredPosition.x < building.maxX + 0.6 &&
        desiredPosition.z > building.minZ - 0.6 &&
        desiredPosition.z < building.maxZ + 0.6 &&
        desiredPosition.y < building.ground + building.height + 1.5
      ) {
        desiredPosition.y = building.ground + building.height + 1.5;
      }
    }
    const shake = clamp(cameraShakeRemaining / 0.32, 0, 1);
    if (!immediate && shake > 0) {
      desiredPosition.x += Math.sin(elapsedTime * 91) * 0.48 * shake;
      desiredPosition.y += Math.sin(elapsedTime * 117 + 0.6) * 0.3 * shake;
      desiredPosition.z += Math.cos(elapsedTime * 83) * 0.48 * shake;
    }
    const desiredTarget = pose.position.clone().addScaledVector(horizontal, lookAhead).addScaledVector(UP, 0.65);
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
      speed: state.mode === 'flying' || state.mode === 'planing' ? state.velocity.length() : horizontalSpeed,
      agl: Math.max(0, state.position.y - state.ground),
      sink,
      glideRatio: state.mode === 'flying' && sink > 0.2 ? clamp(horizontalSpeed / sink, 0, 99) : null,
      stamina: state.stamina,
      stall: state.stall,
      mode: state.mode,
      score: chaosScore,
      combo: chaosCombo,
      secretsFound,
      secretsTotal: campusSecrets.length,
    });
  };

  const resetState = (clearProgress = false) => {
    const spawnGround = terrainAt(0, 0, state.ground);
    state.ground = spawnGround;
    state.position.set(0, spawnGround + SPAWN_ALTITUDE, 0);
    state.velocity.set(0, -0.4, 16.2);
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
    honkCooldown = 0;
    if (clearProgress) chaosScore = 0;
    chaosCombo = 1;
    chaosComboEvents = 0;
    chaosComboRemaining = 0;
    tumbleRemaining = 0;
    tumbleAngle = 0;
    tumbleAngularSpeed = 0;
    hitCooldown = 0;
    cameraShakeRemaining = 0;
    airborneTime = 0;
    peakAgl = 0;
    waterSurfaceY = spawnGround;
    waterPlaningElapsed = 0;
    waterDryTime = 0;
    waterTouchdownSeverity = 0;
    waterSprayClock = 0;
    accumulator = 0;
    for (const wave of honkWaves.splice(0)) {
      scene.remove(wave.mesh);
      wave.mesh.geometry.dispose();
      wave.mesh.material.dispose();
    }
    cameraPosition.set(0, state.position.y + 4.1, -8);
    cameraTarget.set(0, state.position.y + 0.65, 5.8);
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
    const buildingsChanged = buildTexturedBuildings();
    const treesChanged = unresolvedTreeCount > 0 ? updateTrees(true) : false;
    if (!hadTraffic && trafficBuilt) updateTrafficVisuals(1);
    if ((!hadTraffic && trafficBuilt) || buildingsChanged || treesChanged) map.triggerRepaint();
  };
  map.on('idle', onIdle);
  onIdle();

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
      if (trafficBuilt) updateTrafficVisuals(accumulator / FIXED_DT);
      treeRefreshClock -= frameDt;
      if (unresolvedTreeCount > 0 && treeRefreshClock <= 0) {
        treeRefreshClock = 1.25;
        updateTrees(true);
      }
    }
    updateSplashes(frameDt);
    updateHonkWaves(frameDt);
    updateGoosePose(renderState);
    if (playing) updateCamera(frameDt, renderState);
    telemetryClock -= frameDt;
    if (telemetryClock <= 0) {
      telemetryClock = 0.1;
      emitTelemetry();
    }
    if (playing || splashes.length > 0 || honkWaves.length > 0) map.triggerRepaint();
    animationFrame = requestAnimationFrame(frame);
  };

  resetState(true);
  animationFrame = requestAnimationFrame(frame);

  return {
    start() {
      playing = true;
      previousTime = performance.now();
      hooks.onToast('Five campus secrets are out there — hold Space to flap, press E to honk');
    },
    reset() {
      resetState();
      playing = true;
      previousTime = performance.now();
      hooks.onToast('Respawned above WMU — your secret discoveries and score are safe');
    },
    setKey(code, pressed) {
      if (pressed) {
        if (code === 'Space' && !keys.has(code) && tumbleRemaining <= 0) {
          queuedFlaps = Math.min(2, queuedFlaps + 1);
        }
        if ((code === 'KeyE' || code === 'KeyH') && !keys.has(code)) {
          queuedHonks = Math.min(1, queuedHonks + 1);
        }
        keys.add(code);
      } else {
        keys.delete(code);
      }
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(animationFrame);
      map.off('idle', onIdle);
      keys.clear();
      if (audioContext) {
        void audioContext.close().catch(() => undefined);
        audioContext = null;
      }
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      buildingMaterials.forEach(({ texture }) => texture.dispose());
      buildingMaterials.clear();
    },
  };
}
