import * as THREE from 'three';
import type {
  CustomLayerInterface,
  LngLatLike,
  Map as MapLibreMap,
  MapSourceDataEvent,
} from 'maplibre-gl';

import { createGameAudio } from './audio';
import {
  CAMPUS_CHASE_SECONDS,
  CAMPUS_ITEM_KINDS,
  MAX_CAMPUS_NPCS,
  buildCampusItemGeometry,
  createCampusItemMaterial,
  createCampusNpc,
  createCrowdFleet,
  knockDownCampusNpc,
  panicCampusNpc,
  resumeCampusNpcRoute,
  simulateCampusNpc,
  startCampusNpcChase,
  startDanceCampusNpc,
  updateCrowdVisuals,
  type CampusChaseContext,
  type CampusNpc,
  type CrowdRoute,
} from './campus-crowd';
import {
  COLLIDER_SAMPLE_COUNT,
  MIN_COLLIDER_HEIGHT,
  colliderRoof,
  polygonVertexCentroid,
  resolveColliderTerrain,
  writeColliderSamplePoints,
  type ColliderTerrain,
  type ColliderTerrainSample,
  type PlanarPoint,
} from './building-terrain';
import { BONUS_CHAOS_SECRETS, type BonusChaosSecret } from './chaos-secrets';
import { isTouchDevice } from './device';
import { createContactShadow } from './contact-shadow';
import {
  PROP_CAPACITY,
  createPropSystem,
  type PropPoi,
  type PropSystem,
} from './props';
import { PROP_PLACEMENTS } from './props-placement';
import {
  TREE_DENSITY_SCALE,
  TREE_TILE_BOUNDS,
  createTreeSelection,
  createTreeTileStore,
  retainTreeAtDensity,
} from './tree-tiles';
import { WMU_TREE_POINTS } from './wmu-trees';
import { createWaterSurfaces } from './water-surface';
import { WMU_SPAWN } from './world-config';
import { sunDirection } from './world-light';
import { TERRAIN_MAX_ZOOM, getAerialTileUrl } from './world-imagery';
import { JETSTREAM_BOOST_PERCENT, slugifyLabel } from './game-contract';
import type {
  FlightMode,
  GameEvent,
  GooseColors,
  GooseEngineApi,
  ItemKind,
  Modifiers,
  ProgressState,
  ProgressStore,
  PropKind,
  QuestDefinition,
  SecretMarkerTelemetry,
  ToastPriority,
} from './game-contract';
import { QUESTS, applyGameEvent } from './quests';
// Phase 4: mutators. computeModifiers folds the active mutator ids into one
// Modifiers snapshot; MUTATOR_BY_ID resolves an id to its display name for
// the "Unlocked: <name>" toast.
import { MUTATOR_BY_ID, computeModifiers } from './mutators';

export type {
  FlightMode,
  SecretMarkerTelemetry,
  ToastPriority,
} from './game-contract';

// Campus secrets were authored before the safe lawn spawn moved. Keep their
// geographic anchor stable so a spawn tweak can never move a landmark again.
const WMU_CONTENT_ANCHOR: [number, number] = [-85.61771, 42.284996];

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
  secretMarkers: SecretMarkerTelemetry[];
  students: number;
  studentsNearby: number;
  studentsOnMappedWalkways: number;
  nearestStudent: number | null;
  nearestStudentVertical: number | null;
  trees: number;
  treesResolved: number;
  /** Animated water meshes standing in for the map's flat water fill. */
  waterSurfaces: number;
  flockSize: number;
  flockTotal: number;
  recruitableGooseInRange: boolean;
  altitudeBoost: number;
  groundElevation: number;
  east: number;
  north: number;
  heading: number;
  buildings: number;
  /**
   * How many of those buildings have a collision box fitted to real terrain.
   * While this trails `buildings`, the rest are flat placeholder boxes waiting
   * on a DEM tile.
   */
  buildingsResolved: number;
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
  // Phase 1 progression readouts.
  paused: boolean;
  tokens: number;
  questsCompleted: number;
  questsTotal: number;
  // Phase 2 prop readouts.
  props: number;
  propsAwake: number;
  // Phase 3: what is in the beak right now ('cone', 'phone', ...), or null.
  holding: string | null;
  // Phase 4 mutator readouts.
  activeMutators: string[];
  gooseScale: number;
  // Phase 5 impact theater.
  /** The goose is limp: a crash tumble, or the KeyR ragdoll being held. */
  ragdolling: boolean;
  /** Simulation speed multiplier. 1 normally, 0.35 during a hit-stop. */
  timeScale: number;
};

type MapLibreModule = typeof import('maplibre-gl');

// Score toasts announce a named trick and its points; informational toasts
// (landing tips, traffic yielding) must not overwrite one that just appeared.
type Hooks = {
  onTelemetry: (telemetry: GameTelemetry) => void;
  onToast: (message: string, priority?: ToastPriority) => void;
  /** Every quest-countable moment; the HUD and audio can react to these. */
  onEvent?: (event: GameEvent) => void;
};

export type GooseEngine = GooseEngineApi;

type GooseRig = {
  root: THREE.Group;
  leftWing: THREE.Group;
  rightWing: THREE.Group;
  // Phase 8: the hand section, pivoting at the wrist off the arm above, so a
  // wingbeat bends through the span instead of hinging at the shoulder.
  leftWingOuter: THREE.Group;
  rightWingOuter: THREE.Group;
  legs: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  /** Phase 3: head, cheeks and beak on one pivot, so a full beak can droop. */
  head: THREE.Group;
  // Phase 4: mutators. Material refs so skins can recolor in place (no new
  // geometry), and the Angel Goose halo, hidden by default.
  materials: {
    body: THREE.MeshStandardMaterial;
    breast: THREE.MeshStandardMaterial;
    neck: THREE.MeshStandardMaterial;
    wing: THREE.MeshStandardMaterial;
    beak: THREE.MeshStandardMaterial;
  };
  /** Phase 8: the rim light's eye position, fed the chase camera each frame. */
  rimEye: GooseRimEye;
  halo: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
};

type FlockGoose = {
  beacon: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  home: THREE.Vector2;
  position: THREE.Vector3;
  /**
   * Where this goose was last drawn. The flock shares one pose rig now, so the
   * rig root can no longer carry "where I was last frame", which is what the
   * waddle reads to work out how fast the follower is moving.
   */
  drawnPosition: THREE.Vector3;
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
  /** OSM class the line came from; '' for a synthesised route. */
  roadClass: string;
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
  /** Phase 5: last step's shouldYield, so a fresh brake can screech once. */
  yielding: boolean;
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
  /** Vertex centroid of the footprint: the point MapLibre samples the DEM at. */
  centroidX: number;
  centroidZ: number;
  centerGround: number;
  ground: number;
  height: number;
  renderHeight: number;
  renderMinHeight: number;
  terrainResolved: boolean;
  /**
   * Consecutive building scans that did not hand this footprint back. The
   * vector source slices a building into one chunk per overzoomed tile, and
   * each chunk is drawn at its own centroid elevation, so when the camera
   * moves and MapLibre swaps a coarse chunk for finer ones (or back), the old
   * chunk's box and overlay have to go with it.
   */
  missingScans: number;
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
  /**
   * Gameplay visibility: playing, and its terrain has resolved. This is what
   * telemetry and the HUD mean by "this secret exists in the world", kept
   * apart from `inRange` so the draw-call gate below cannot be mistaken for a
   * secret that failed to place.
   */
  shown: boolean;
  /** Within SECRET_VISIBLE_RADIUS of the goose, refreshed a few times a second. */
  inRange: boolean;
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
const DEFAULT_CAMERA_SCALE = 10 / 7;
const DEFAULT_CAMERA_PITCH = 16 * DEG;
const MAX_TRAFFIC = 40;
const TRAFFIC_ROUTE_RADIUS = 1_100;
const TRAFFIC_REANCHOR_DISTANCE = 650;
const WATER_INGEST_RADIUS = 1_600;
/**
 * Seconds between re-samples of the terrain under a water sheet that is still
 * sitting on the fallback height. Ponds arrive from the vector tiles long
 * before the DEM under them, exactly like the building colliders do.
 */
const WATER_SURFACE_RESOLVE_INTERVAL = 0.45;
const WOODLAND_INGEST_RADIUS = 1_400;
const WOODLAND_REANCHOR_DISTANCE = 650;
/** Metres between street trees along a residential road, per side. */
const STREET_TREE_SPACING = 24;
/** How far a street tree stands from the road centreline: a front yard. */
const STREET_TREE_OFFSET = 9;
/** Street-tree candidates added per woodland scan, on top of the woods. */
const STREET_TREE_CANDIDATE_LIMIT = 420;
/** OpenMapTiles road classes that get street trees. */
const STREET_TREE_ROAD_CLASSES = new Set(['minor', 'tertiary', 'residential']);
const WOODLAND_RECYCLE_DISTANCE = 1_600;
const WOODLAND_SPAWN_MIN_DISTANCE = 180;
/**
 * Tree instance budget, reduced alongside the 20% location thinning. Reducing
 * both keeps roughly the same woodland horizon instead of merely drawing
 * fewer nearest trees and bringing the visible edge closer to the goose.
 */
const MAX_TREE_COUNT_DESKTOP = Math.floor(3_600 * TREE_DENSITY_SCALE);
const MAX_TREE_COUNT_PHONE = Math.floor(1_000 * TREE_DENSITY_SCALE);
/** How far the LiDAR selection reaches, and how far its tiles are fetched. */
const LIDAR_TREE_RADIUS_DESKTOP = 900;
const LIDAR_TREE_RADIUS_PHONE = 550;
/** Metres of travel before the nearest-first selection is taken again. */
const LIDAR_TREE_REANCHOR_DISTANCE = 120;
/**
 * Planting budgets for measured trees, which arrive by the thousand rather
 * than by the handful the woodland scan produces: without these the nearest
 * couple of thousand trees would take a minute of flying to show up.
 */
const LIDAR_STREAM_BATCH_DESKTOP = 180;
const LIDAR_STREAM_BATCH_PHONE = 45;
/** Trunk height as a share of the measured canopy top. */
const TREE_TRUNK_HEIGHT_SHARE = 0.4;
/** Crown centre height as a share of the measured canopy top. */
const TREE_CROWN_CENTRE_SHARE = 0.7;
/**
 * A tree is drawn as a conifer when its crown is both this closed (the share
 * of pulses the crown stopped before the ground) and narrow for its height
 * (CONIFER_SLENDERNESS, height over crown diameter). The flight caught the
 * canopy in leaf, so closure alone does not separate species: most crowns
 * score 0.7 or so, and only the dense, pointed ones are spruce and pine.
 */
const CONIFER_FULLNESS = 0.86;
const CONIFER_SLENDERNESS = 1.5;
/** Trunk radius as a share of the canopy top, and the range it lives in. */
const TREE_TRUNK_RADIUS_SHARE = 0.018;
const TREE_TRUNK_RADIUS_MIN = 0.1;
const TREE_TRUNK_RADIUS_MAX = 0.45;
/** Radius the trunk geometry is authored at, which the scale divides out. */
const TREE_TRUNK_GEOMETRY_RADIUS = 0.26;
const NEAR_SPAWN_CROWD_COUNT = 12;
const NPC_RECYCLE_DISTANCE = 220;
const NPC_STALE_ROUTE_KEEP_DISTANCE = 160;
const NPC_SPAWN_MIN_DISTANCE = 65;
const NPC_RECYCLE_BATCH = 2;
const NPC_STALE_RECYCLE_BATCH = 24;
const TREE_PLACEMENT_ANCHOR_TOLERANCE = 300;
const PROP_POI_RADIUS = 1_100;
const PROP_POI_RESCAN_DISTANCE = 220;
const PROP_POI_REFRESH_SECONDS = 2.5;
// Campus clutter: furniture generated from the mapped walkway and service-road
// network so the whole city feels lived in without a hand-authored table.
/** One trash can per this many meters of walkway. */
const WALKWAY_TRASH_SPACING = 90;
/** One bench per this many meters of walkway. */
const WALKWAY_BENCH_SPACING = 140;
const WALKWAY_CLUTTER_CADENCE = [
  ['trash', WALKWAY_TRASH_SPACING],
  ['bench', WALKWAY_BENCH_SPACING],
] as const satisfies ReadonlyArray<readonly [PropKind, number]>;
/** How far to the side of the walkway centerline furniture stands. */
const WALKWAY_PROP_OFFSET = 1.6;
/** Ceiling on generated walkway props, before the capacity headroom bites. */
const WALKWAY_PROP_LIMIT = 120;
/** Bodies left free for the authored table and the OSM POIs. */
const CLUTTER_HEADROOM = 40;
/** Generated furniture keeps this far clear of a mapped traffic corridor. */
const CLUTTER_ROAD_CLEARANCE = 2.5;
const CLUTTER_RESCAN_DISTANCE = 220;
const SERVICE_CONE_COUNT = 4;
const SERVICE_CONE_SPACING = 3.2;
/**
 * Cones sit this far outside the lane edge: a shoulder, not a roadblock. Wide
 * enough that a car driving its lane never clips one, because a cone the
 * traffic can reach is a cone that never gets to go back to sleep.
 */
const SERVICE_CONE_SHOULDER = 2;
const SERVICE_CONE_MIN_LENGTH = 60;
const SERVICE_CONE_RADIUS = 600;
const SERVICE_CONE_ROW_LIMIT = 40;
// The jetstream's speed increase comes from JETSTREAM_BOOST_PERCENT so the
// physics and HUD agree. The boost arms the moment the goose crosses 50 m
// and is at full strength half a second later, whatever the climb rate.
// It lets go below 47 m so a wobble at 50 m does not flicker it.
const ALTITUDE_BOOST_HEIGHT = 50;
const ALTITUDE_BOOST_RELEASE_HEIGHT = 47;
/** Seconds for the boost to fade in once armed, and out once released. */
const ALTITUDE_BOOST_RAMP_IN = 0.5;
const ALTITUDE_BOOST_RAMP_OUT = 0.35;
const BASE_CRUISE_SPEED = 18.5;
const BASE_MAX_FLIGHT_SPEED = 38;
const JETSTREAM_SPEED_SCALE = 1 + JETSTREAM_BOOST_PERCENT / 100;
const ALTITUDE_BOOST_CRUISE_SPEED = BASE_CRUISE_SPEED * JETSTREAM_SPEED_SCALE;
const ALTITUDE_BOOST_ACCELERATION = 2.7;
const ALTITUDE_BOOST_MAX_SPEED = BASE_MAX_FLIGHT_SPEED * JETSTREAM_SPEED_SCALE;
const BUILDING_ACTIVE_RADIUS = 150;
const BUILDING_INGEST_RADIUS = 950;
const BUILDING_RETENTION_RADIUS = 1_800;
const BUILDING_RESCAN_DISTANCE = 240;
/**
 * Building scans in a row that must miss a chunk before its collider and
 * overlay are dropped as no longer drawn. Two is a tile reloading; three is
 * the camera having moved on to a different chunking.
 */
const STALE_CHUNK_SCANS = 3;
/** Seconds between the steady building scans that feed that count. */
const BUILDING_RESCAN_INTERVAL = 2;
/**
 * How far a secret's visual stays in the scene graph. Frustum culling alone
 * still walks all 165 secret meshes every frame; dropping the whole group past
 * this radius keeps the far side of the map off the render list entirely.
 * Well past both TEXTURED_ROOF_RADIUS and anything a player can see a secret
 * beacon at, so nothing pops in on approach.
 */
const SECRET_VISIBLE_RADIUS = 900;
/** Seconds between re-evaluations of that radius. */
const SECRET_RANGE_INTERVAL = 0.5;
/** Tallest lip a goose on foot walks up rather than into, in metres. */
const STEP_UP_HEIGHT = 0.7;
/** How far out colliders keep chasing a DEM that had not decoded yet. */
const UNRESOLVED_COLLIDER_RADIUS = 1_400;
/** Seconds between sweeps of those colliders while playing. */
const UNRESOLVED_COLLIDER_INTERVAL = 0.25;
const TEXTURED_ROOF_RADIUS = 760;
const BUILDING_TEXTURE_MAX_ZOOM = 18;
const BUILDING_TEXTURE_MIN_ZOOM = 15;
const CHAOS_COMBO_SECONDS = 4;
// Phase 5: impact theater.
/** How long a hit-stop lasts, in simulated seconds. */
const HIT_STOP_SECONDS = 0.4;
/** The tail of that window spent easing back to full speed. */
const HIT_STOP_RELEASE_SECONDS = 0.1;
/** Simulation speed while the hit-stop holds. */
const HIT_STOP_SCALE = 0.35;
/** Below this, a collision is a bump and reads better at full speed. */
const HIT_STOP_MIN_SEVERITY = 0.7;
/** Re-armed every step KeyR is held; the tail is what decays on release. */
const RAGDOLL_HOLD_SECONDS = 0.25;
/** A standing goose still flops over rather than freezing mid-air. */
const RAGDOLL_MIN_SPIN = 4;
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

// jetstreamAlways (Jet Goose) pins the boost to full strength no matter the
// altitude; `ramp` is the engine's 0..1 fade, driven by time since arming.
const altitudeBoostStrength = (ramp: number, jetstreamAlways = false) =>
  jetstreamAlways ? 1 : smoothstep(0, 1, ramp);

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

// Phase 8: the hero. The goose is the one thing on screen the whole time, so
// it gets a rim light (silhouette separation against dark grass and asphalt),
// a feather-scale surface break-up, eyes, and a wing that bends instead of
// hinging. Everything below is shared with the flock: createGooseRig builds
// both the player's rig and the pose rig the InstancedMeshes copy from.

/**
 * The default Canada-goose palette: a warm greyish brown body, darker
 * brown-grey wings, cream chin and breast, and a black neck and head. Shared
 * by the rig's materials and by the mutator recolour path, so a skin that is
 * turned off puts back exactly what the rig was built with.
 */
const GOOSE_PALETTE: GooseColors = {
  body: 0x796a54,
  breast: 0xefe7d2,
  neck: 0x141513,
  wing: 0x51493c,
  beak: 0x141513,
};

/** Rim strength on the plumage: an edge, not a glow. */
const GOOSE_RIM_STRENGTH = 0.35;
/**
 * The near-black neck, head and beak need more than the plumage does, or the
 * silhouette dissolves into shadowed ground.
 */
const GOOSE_RIM_STRENGTH_DARK = 0.52;
/** Warm daylight bounce rather than the sky's blue, so the rim reads as sun. */
const GOOSE_RIM_COLOR = 0xffe3bd;
/** Feather fleck contrast, as a fraction of the base colour. */
const GOOSE_FLECK_CONTRAST = 0.06;
/** Fleck cells per rig unit (a rig unit is 0.4 m at the default root scale). */
const GOOSE_FLECK_CELLS = 17;
/** Secondary feather rows across the wing chord. */
const GOOSE_WING_STRIPE_CONTRAST = 0.05;
/** Eye bead radius in rig units: big enough to read at the chase distance. */
const GOOSE_EYE_RADIUS = 0.058;
/** Catchlight bead, which pokes just clear of the eye it sits on. */
const GOOSE_EYE_GLINT_RADIUS = 0.017;

/**
 * Where the rim light thinks the eye is, in engine-local metres.
 *
 * The custom layer renders through a bare THREE.Camera that only ever gets a
 * projectionMatrix (MapLibre's), so its matrixWorld stays identity: view space
 * *is* world space, and three's `vViewPosition` points at the world origin
 * rather than at the camera. A fresnel built on it would rim the side of the
 * goose facing the map origin. The engine copies the chase camera's position
 * in here every frame instead, and the shader reconstructs the world position
 * as `-vViewPosition`.
 */
type GooseRimEye = { value: THREE.Vector3 };

type GoosePlumage = {
  /** Rim strength; 0 leaves the material's lighting alone. */
  rim: number;
  /** Fleck contrast; 0 for the beak, feet and eyes. */
  fleck: number;
  /** Chordwise feather rows; wings only. */
  stripe: number;
};

/**
 * Injects the rim and the feather pattern into a MeshStandardMaterial.
 *
 * Every goose material shares this one closure, so three's default program
 * cache key (the source text of onBeforeCompile) matches across all of them
 * and they compile a single program between them; the per-material differences
 * ride in uniforms. The flock's InstancedMeshes reuse the pose rig's material
 * objects, so they inherit this for free (they compile their own USE_INSTANCING
 * variant, which calls onBeforeCompile again and picks up the same uniforms).
 */
const applyGoosePlumage = (
  material: THREE.MeshStandardMaterial,
  eye: GooseRimEye,
  plumage: GoosePlumage,
) => {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.gooseEye = eye;
    shader.uniforms.gooseRim = { value: plumage.rim };
    shader.uniforms.gooseRimColor = {
      value: new THREE.Color(GOOSE_RIM_COLOR),
    };
    shader.uniforms.gooseFleck = { value: plumage.fleck };
    shader.uniforms.gooseStripe = { value: plumage.stripe };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vGooseLocal;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvGooseLocal = transformed;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 gooseEye;
uniform vec3 gooseRimColor;
uniform float gooseRim;
uniform float gooseFleck;
uniform float gooseStripe;
varying vec3 vGooseLocal;
float gooseHash(vec3 cell) {
  return fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}`,
      )
      // Rig-local, not world: a world-space pattern would swim across the bird
      // as it flies. Two cell sizes so the speckle is not a single grid.
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
float gooseSpeck =
  gooseHash(floor(vGooseLocal * ${GOOSE_FLECK_CELLS.toFixed(1)})) * 1.24 +
  gooseHash(floor(vGooseLocal * ${(GOOSE_FLECK_CELLS * 2.3).toFixed(1)})) * 0.76 -
  1.0;
float gooseRow = sin(vGooseLocal.z * 21.0);
diffuseColor.rgb *= 1.0 + gooseSpeck * gooseFleck + gooseRow * gooseStripe;
roughnessFactor = clamp(roughnessFactor + gooseSpeck * 0.09, 0.05, 1.0);`,
      )
      // abs(): the map projection mirrors an axis, so gl_FrontFacing (and with
      // it the DoubleSide normal flip) is inverted. The silhouette is where the
      // normal is perpendicular to the view either way.
      .replace(
        '#include <opaque_fragment>',
        `float gooseFacing =
  abs(dot(normalize(normal), normalize(gooseEye + vViewPosition)));
outgoingLight += gooseRimColor * gooseRim * pow(1.0 - gooseFacing, 3.0);
#include <opaque_fragment>`,
      );
  };
};

/** Half-span of one wing, in rig units. */
const WING_SPAN = 1.75;
/** Span fraction where the hand section pivots off the arm. */
const WING_SPLIT = 0.55;
/**
 * The wrist pivots this far inboard of the split and the arm panel runs on to
 * the split, so the two panels overlap. They are separate meshes on separate
 * transform chains, and coincident edges crack open along the join under float
 * error; a couple of centimetres of overlap is cheaper than fighting that.
 */
const WING_JOIN_OVERLAP = 0.035;
/**
 * ...and the hand sits this far under the arm through the overlap, so the two
 * surfaces cannot z-fight at the point in a wingbeat where the wrist angle
 * passes through zero and they would otherwise be coplanar.
 */
const WING_JOIN_DROP = 0.004;
/** Quads across the chord in every wing panel. */
const WING_CHORD_STEPS = 3;
/** Quads along the span in the arm and hand panels (60 triangles a wing). */
const WING_INNER_STEPS = 4;
const WING_OUTER_STEPS = 6;
/** Chord arch at the root, and how much of it is gone by the tip. */
const WING_CAMBER = 0.08;
const WING_CAMBER_TAPER = 0.05;
/** Primary feather notches scalloped into the hand's trailing edge. */
const WING_NOTCHES = 3;
const WING_NOTCH_DEPTH = 0.28;

/**
 * Wing planform. The arm is broad and swept back, the hand narrows and sweeps
 * forward to a near point: that outline, not the surface detail, is what says
 * "goose" from the chase camera.
 */
const wingLeadingEdge = (span: number) => 0.3 - 0.24 * span * span;
const wingTrailingEdge = (span: number) =>
  -0.5 -
  0.24 * Math.sin(Math.PI * Math.min(span * 1.1, 1)) +
  0.34 * span ** 2.2;
/** Gentle dihedral, so the wings are not a flat plank through the body. */
const wingRise = (span: number) => 0.03 + 0.075 * span * span;

/**
 * One panel of a wing: a cambered, subdivided sheet between two span
 * fractions, authored in the panel's own local space so the hand can pivot at
 * the wrist. Built per side because the geometry is mirrored in x rather than
 * rotated, which is what the flat wing did before.
 */
function makeWingGeometry(
  side: -1 | 1,
  fromSpan: number,
  toSpan: number,
  spanSteps: number,
  notched: boolean,
) {
  const positions: number[] = [];
  const indices: number[] = [];
  const originX = fromSpan * WING_SPAN;
  const originY = wingRise(fromSpan);
  for (let i = 0; i <= spanSteps; i += 1) {
    const t = i / spanSteps;
    const span = lerp(fromSpan, toSpan, t);
    const leading = wingLeadingEdge(span);
    const trailing = wingTrailingEdge(span);
    // Primaries: the trailing edge is cut back between the feather tips,
    // deepest near the wingtip and fading out toward the wrist.
    const notch = notched
      ? WING_NOTCH_DEPTH *
        (leading - trailing) *
        t *
        (0.5 - 0.5 * Math.cos(t * Math.PI * 2 * WING_NOTCHES))
      : 0;
    for (let j = 0; j <= WING_CHORD_STEPS; j += 1) {
      // Cosine spacing clusters rows at both edges, which rounds the leading
      // edge and keeps the scalloped trailing edge crisp.
      const chord = 0.5 - 0.5 * Math.cos((j / WING_CHORD_STEPS) * Math.PI);
      const camber =
        (WING_CAMBER - WING_CAMBER_TAPER * span) * Math.sin(Math.PI * chord);
      positions.push(
        (span * WING_SPAN - originX) * side,
        wingRise(span) + camber - originY,
        lerp(leading, trailing + notch, chord),
      );
    }
  }
  const stride = WING_CHORD_STEPS + 1;
  for (let i = 0; i < spanSteps; i += 1) {
    for (let j = 0; j < WING_CHORD_STEPS; j += 1) {
      const corner = i * stride + j;
      const next = corner + stride;
      indices.push(corner, next, corner + 1, corner + 1, next, next + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Wing elevation at a point in the flap cycle; positive is wings-down. */
const wingBeatAngle = (cycle: number) =>
  0.12 - 0.62 * Math.cos(cycle * Math.PI * 2);

/** Fraction of a wingbeat spent on the downstroke, the power stroke. */
const WING_DOWNSTROKE = 0.4;

/**
 * Skews the flap phase so the downstroke takes the first WING_DOWNSTROKE of
 * the cycle and the recovery takes the rest. A pure cosine spends equal time
 * both ways, which reads as a hinge rather than as a bird.
 */
const flapCycle = (phase: number) =>
  phase < WING_DOWNSTROKE
    ? (phase / WING_DOWNSTROKE) * 0.5
    : 0.5 + ((phase - WING_DOWNSTROKE) / (1 - WING_DOWNSTROKE)) * 0.5;

/** How far the hand trails the arm through the stroke, in cycles. */
const WING_OUTER_LAG = 0.25;
/** How much of the arm's lead the hand actually bends through. */
const WING_OUTER_BEND = 0.72;
/** Peak nose-down twist of the hand on the downstroke, radians. */
const WING_OUTER_TWIST = 0.28;
/** Idle wing breathing in a glide: radians per second, and amplitude. */
const WING_BREATH_RATE = 0.3 * Math.PI * 2;
const WING_BREATH_ANGLE = 0.035;
/** Hand droop below the arm in a glide, which is what makes the gull shape. */
const WING_GLIDE_HAND_DROOP = 0.16;
/** Bank spreads the wrists the same way, so a turn is not two rigid planks. */
const WING_GLIDE_BANK_SPREAD = 0.14;

/**
 * Wings tucked against the body: the waddling, swimming and roosting stance.
 *
 * The flat three-triangle wing this replaced could be folded with a span scale
 * alone, because there was nothing to it edge-on. A cambered panel with real
 * chord sticks up like a fin if it is only scaled, so the fold also flattens it
 * (the y scale), droops it onto the flank and sweeps it back along the body,
 * with the hand swept further back still. Euler order is XYZ, so the droop is
 * applied before the sweep, which is the order the joints actually work in.
 */
const WING_FOLD_SCALE: [number, number, number] = [0.32, 0.5, 0.7];
const WING_FOLD_DROOP = 0.04;
const WING_FOLD_SWEEP = 0.85;
const WING_FOLD_HAND_SWEEP = 0.45;
const WING_FOLD_HAND_DROOP = 0.1;

function setGooseWingsFolded(rig: GooseRig) {
  rig.leftWing.scale.set(...WING_FOLD_SCALE);
  rig.rightWing.scale.set(...WING_FOLD_SCALE);
  rig.leftWing.rotation.set(0, -WING_FOLD_SWEEP, WING_FOLD_DROOP);
  rig.rightWing.rotation.set(0, WING_FOLD_SWEEP, -WING_FOLD_DROOP);
  rig.leftWingOuter.rotation.set(
    0,
    -WING_FOLD_HAND_SWEEP,
    WING_FOLD_HAND_DROOP,
  );
  rig.rightWingOuter.rotation.set(
    0,
    WING_FOLD_HAND_SWEEP,
    -WING_FOLD_HAND_DROOP,
  );
}

function createGooseRig(frustumCulled = false) {
  const root = new THREE.Group();
  root.name = 'Canada goose';
  root.scale.setScalar(0.4);
  root.traverse((object) => {
    object.frustumCulled = frustumCulled;
  });

  const rimEye: GooseRimEye = { value: new THREE.Vector3() };

  const brown = new THREE.MeshStandardMaterial({
    color: GOOSE_PALETTE.body,
    roughness: 0.9,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });
  // Roughness 0.6 on the black neck and head: a real Canada goose's head has a
  // faint sheen, and it is the one place a highlight helps the shape read.
  const dark = new THREE.MeshStandardMaterial({
    color: GOOSE_PALETTE.neck,
    roughness: 0.6,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });
  const cream = new THREE.MeshStandardMaterial({
    color: GOOSE_PALETTE.breast,
    roughness: 0.88,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });
  const wingMat = new THREE.MeshStandardMaterial({
    color: GOOSE_PALETTE.wing,
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
  // Phase 4: mutators. The beak used to share `dark` with the neck/head, but
  // GooseColors recolors them independently, so it gets its own material.
  const beakMat = new THREE.MeshStandardMaterial({
    color: GOOSE_PALETTE.beak,
    roughness: 0.62,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });
  // Phase 8: the eye bead is glossy and never recoloured by a skin, so a white
  // goose still has an eye. The catchlight is unlit on purpose: a specular
  // highlight this small dies at the chase distance, a flat white dot does not.
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x0a0b0a,
    roughness: 0.22,
    metalness: 0.05,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });
  const glintMat = new THREE.MeshBasicMaterial({
    color: 0xf4f7ff,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });

  applyGoosePlumage(brown, rimEye, {
    rim: GOOSE_RIM_STRENGTH,
    fleck: GOOSE_FLECK_CONTRAST,
    stripe: 0,
  });
  applyGoosePlumage(cream, rimEye, {
    rim: GOOSE_RIM_STRENGTH * 0.85,
    fleck: GOOSE_FLECK_CONTRAST * 0.6,
    stripe: 0,
  });
  applyGoosePlumage(dark, rimEye, {
    rim: GOOSE_RIM_STRENGTH_DARK,
    fleck: GOOSE_FLECK_CONTRAST * 0.5,
    stripe: 0,
  });
  applyGoosePlumage(wingMat, rimEye, {
    rim: GOOSE_RIM_STRENGTH,
    fleck: GOOSE_FLECK_CONTRAST,
    stripe: GOOSE_WING_STRIPE_CONTRAST,
  });
  applyGoosePlumage(beakMat, rimEye, {
    rim: GOOSE_RIM_STRENGTH_DARK,
    fleck: 0,
    stripe: 0,
  });
  applyGoosePlumage(orange, rimEye, {
    rim: GOOSE_RIM_STRENGTH * 0.7,
    fleck: 0,
    stripe: 0,
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

  // Phase 3: a pivot at the top of the neck. Everything above the neck hangs
  // off it, so carrying something can tip the whole head without bending the
  // body, and each part keeps the local position it was authored with.
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 1.5, 0.5);
  root.add(headPivot);
  const addToHead = (part: THREE.Mesh) => {
    part.position.sub(headPivot.position);
    headPivot.add(part);
  };

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.245, 12, 9), dark);
  head.scale.set(0.88, 0.9, 1.04);
  head.position.set(0, 1.68, 0.66);
  addToHead(head);

  const cheekGeometry = new THREE.SphereGeometry(0.105, 9, 6);
  for (const side of [-1, 1]) {
    const cheek = new THREE.Mesh(cheekGeometry, cream);
    cheek.scale.set(0.38, 0.84, 0.86);
    cheek.position.set(side * 0.2, 1.64, 0.75);
    addToHead(cheek);
  }

  // Phase 8: eyes, high and wide on the head so they sit on the head's
  // silhouette from the chase camera rather than hiding behind the cheek. They
  // go through addToHead like everything else above the neck, so a tipped head
  // still carries them.
  const eyeGeometry = new THREE.SphereGeometry(GOOSE_EYE_RADIUS, 8, 6);
  const glintGeometry = new THREE.SphereGeometry(GOOSE_EYE_GLINT_RADIUS, 6, 4);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeometry, eyeMat);
    eye.position.set(side * 0.172, 1.752, 0.756);
    addToHead(eye);
    const glint = new THREE.Mesh(glintGeometry, glintMat);
    glint.position.set(side * 0.188, 1.788, 0.78);
    addToHead(glint);
  }

  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.27, 8), beakMat);
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 1.66, 0.95);
  addToHead(beak);

  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.62, 7), cream);
  tail.rotation.x = -Math.PI / 2;
  tail.position.set(0, 0.8, -0.72);
  root.add(tail);

  // Phase 8: each wing is an arm panel with a hand panel pivoting off it at
  // the wrist, so updateGoosePose can let the hand trail the arm through a
  // beat. Folding for the waddle still scales the outer group, which carries
  // the hand's position as well as its geometry, so both segments tuck.
  const wristSpan = WING_SPLIT - WING_JOIN_OVERLAP;
  const buildWing = (side: -1 | 1) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.36, 0.9, 0.08);
    shoulder.add(
      new THREE.Mesh(
        makeWingGeometry(side, 0, WING_SPLIT, WING_INNER_STEPS, false),
        wingMat,
      ),
    );
    const wrist = new THREE.Group();
    wrist.position.set(
      side * wristSpan * WING_SPAN,
      wingRise(wristSpan) - wingRise(0) - WING_JOIN_DROP,
      0,
    );
    wrist.add(
      new THREE.Mesh(
        makeWingGeometry(side, wristSpan, 1, WING_OUTER_STEPS, true),
        wingMat,
      ),
    );
    shoulder.add(wrist);
    root.add(shoulder);
    return { shoulder, wrist };
  };
  const left = buildWing(-1);
  const right = buildWing(1);
  const leftWing = left.shoulder;
  const leftWingOuter = left.wrist;
  const rightWing = right.shoulder;
  const rightWingOuter = right.wrist;

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

  // Phase 4: mutators. Angel Goose's halo: a thin gold ring hovering above
  // the head, hidden by default and toggled/animated in updateGoosePose.
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.42, 0.035, 10, 28),
    new THREE.MeshBasicMaterial({
      color: 0xffd76a,
      transparent: true,
      opacity: 0.88,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  halo.rotation.x = Math.PI / 2;
  halo.position.set(0, head.position.y + 0.25, head.position.z);
  halo.visible = false;
  root.add(halo);

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
    leftWingOuter,
    rightWingOuter,
    legs,
    leftLeg,
    rightLeg,
    head: headPivot,
    materials: {
      body: brown,
      breast: cream,
      neck: dark,
      wing: wingMat,
      beak: beakMat,
    },
    rimEye,
    halo,
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
  roadClass = '',
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
    roadClass,
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
  progress: ProgressStore,
): GooseEngine {
  const coarsePointer = isTouchDevice();
  const fixedStep = coarsePointer ? 1 / 60 : FIXED_DT;
  const texturedRoofLimit = coarsePointer ? 180 : 320;
  const flareHint = coarsePointer ? 'hold Flare' : 'hold Shift to flare';
  const buildingTextureMaxZoom = coarsePointer ? 16 : BUILDING_TEXTURE_MAX_ZOOM;
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const goose = createGooseRig();
  const trafficFleet = createTrafficFleet(MAX_TRAFFIC);
  const crowdFleet = createCrowdFleet(MAX_CAMPUS_NPCS);
  scene.add(goose.root);
  const gooseShadow = createContactShadow(0.95);
  scene.add(gooseShadow.mesh);
  scene.add(trafficFleet.bodies, trafficFleet.cabins, trafficFleet.wheels);
  scene.add(
    crowdFleet.heads,
    crowdFleet.torsos,
    crowdFleet.leftArms,
    crowdFleet.rightArms,
    crowdFleet.leftLegs,
    crowdFleet.rightLegs,
  );
  for (const kind of CAMPUS_ITEM_KINDS) scene.add(crowdFleet.items[kind]);
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
  // Sky light slightly cool, ground bounce warm, and the key light from the
  // same south-east sun the aerial photo's shadows were cast by (see
  // world-light.ts), so the goose, trees and props sit in the same light as
  // the walls MapLibre shades and the shadows baked into the ground.
  scene.add(new THREE.HemisphereLight(0xd3e6f0, 0x7a7052, 2.15));
  const sun = new THREE.DirectionalLight(0xfff0cf, 3.4);
  const sunFrom = sunDirection();
  sun.position.set(sunFrom.x * 150, sunFrom.y * 150, sunFrom.z * 150);
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

  // map.queryTerrainElevation() samples through the tiles the camera can see.
  // A chase camera that sits below the real terrain (which happens whenever
  // the DEM resolves after the goose was placed at the sea-level fallback)
  // sees no terrain tiles and reads 0 forever, so the world can never climb
  // to the real ground. Sampling the DEM directly does not depend on the
  // camera at all; it returns 0 only while no tile has decoded.
  //
  // The zoom asked for is one *above* the source maxzoom on purpose.
  // MapLibre's TerrainTileManager resolves a query tile to a DEM tile with
  // `z = overscaledZ - deltaZoom` (deltaZoom is 1) and only then clamps to the
  // source maxzoom, so asking for TERRAIN_MAX_ZOOM (16) reads the zoom-15 DEM
  // at 2.2 m/px while MapLibre renders the terrain mesh and the extruded
  // buildings from the zoom-16 DEM at 1.1 m/px. Asking for 17 lands on the
  // same zoom-16 tile the map draws, so a collider roof and the building
  // under it agree instead of disagreeing by a metre of interpolation.
  const queryGroundElevation = (lngLat: LngLatLike): number | null => {
    const terrain = map.terrain;
    if (!terrain) return null;
    return terrain.getElevationForLngLatZoom(
      maplibre.LngLat.convert(lngLat),
      TERRAIN_MAX_ZOOM + 1,
    );
  };

  // The unresolved-collider pass reads five DEM points per building per tick.
  // localToLngLat() builds a MercatorCoordinate and a LngLat every call, so
  // this variant writes one shared LngLat instead: the inverse web-mercator
  // below is exactly what MercatorCoordinate.toLngLat() computes.
  const terrainSampleLngLat = new maplibre.LngLat(0, 0);
  const sampleGroundElevationAtLocal = (east: number, north: number) => {
    const mercatorY = origin.y - north * meterScale;
    terrainSampleLngLat.lng = (origin.x + east * meterScale) * 360 - 180;
    terrainSampleLngLat.lat =
      (360 / Math.PI) *
        Math.atan(Math.exp(((180 - mercatorY * 360) * Math.PI) / 180)) -
      90;
    return queryGroundElevation(terrainSampleLngLat);
  };

  const keys = new Set<string>();
  const styleLayers = map.getStyle().layers ?? [];
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
  // Bike racks and waste baskets ride in the same vector source as everything
  // else; a style that draws no POI layer still serves the source layer, so
  // fall back to the road source rather than giving up on POI props.
  const poiStyleLayer = styleLayers.find(
    (layer) =>
      'source-layer' in layer &&
      layer['source-layer'] === 'poi' &&
      'source' in layer &&
      typeof layer.source === 'string',
  );
  const poiSourceId =
    poiStyleLayer &&
    'source' in poiStyleLayer &&
    typeof poiStyleLayer.source === 'string'
      ? poiStyleLayer.source
      : roadSourceId;
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
  let buildingRescanClock = BUILDING_RESCAN_INTERVAL;
  let secretRangeClock = 0;
  let buildingRefreshRequested = true;
  let trafficRefreshClock = 0;
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
  let takeoffHintShown = false;
  let firstHonkAcknowledged = false;
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
  // Phase 5: every sound the game makes comes out of this one module. It is
  // lazy (no AudioContext until unlock()), rate limited, and never throws, so
  // call sites below are plain one-liners with no guards of their own.
  const audio = createGameAudio();
  audio.setEnabled(
    progress.get().settings.sound,
    progress.get().settings.ambient,
  );
  // Phase 5: hold KeyR to go limp. The key only seeds the existing tumble
  // path, so a ragdolling goose still bowls students and a car that hits it is
  // still an ordinary car hit; the key itself awards nothing.
  let ragdollLatched = false;
  let ragdollSplashLatched = false;
  let ragdollHintShown = false;
  // Phase 5: hit-stop. slowMotionRemaining counts down in simulated seconds,
  // so the dip lasts the same amount of game time on any frame rate; timeScale
  // is what frame() multiplies real time by before it enters the accumulator.
  let slowMotionRemaining = 0;
  let timeScale = 1;
  let slowMotionEnabled = progress.get().settings.slowMotion;
  // One screech per burst of cars braking at once, rather than one per car.
  let lastYieldScreech = -10;
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
  /** 0..1 fade of the jetstream, so arming at 50 m is not a jolt. */
  let altitudeBoostRamp = 0;
  const texturedBuildingKeys = new Set<string>();
  /**
   * One aerial roof overlay footprint. Its geometry is already in world XZ
   * with y at the building's render height, so the only thing merging has to
   * do is add `centerGround` to every vertex's y. Kept apart from the mesh
   * that draws it: 200-320 footprints used to be 200-320 draw calls, and a
   * roof overlay is a flat unlit quad-ish polygon that the GPU could not care
   * less about batching.
   */
  type RoofOverlayRecord = {
    key: string;
    materialKey: string;
    geometry: THREE.BufferGeometry;
    centerGround: number;
    terrainResolved: boolean;
  };
  /** Every footprint sharing one aerial tile, drawn as a single merged mesh. */
  type RoofOverlayBatch = {
    records: Set<RoofOverlayRecord>;
    mesh: THREE.Mesh | null;
    dirty: boolean;
  };
  const roofOverlayRecords = new Map<string, RoofOverlayRecord>();
  const roofOverlayBatches = new Map<string, RoofOverlayBatch>();
  let roofOverlayBatchesDirty = false;
  const texturedBuildingGroup = new THREE.Group();
  texturedBuildingGroup.name = 'Capped aerial roof overlays';
  texturedBuildingGroup.visible = false;
  scene.add(texturedBuildingGroup);
  const buildingColliderByKey = new Map<string, BuildingCollider>();
  let buildingCollectionGeneration = 0;
  const buildingMaterials = new Map<
    string,
    {
      texture: THREE.Texture;
      roof: THREE.MeshBasicMaterial;
      /** True once the aerial tile has arrived (or failed for good). */
      ready: boolean;
    }
  >();
  const buildingColliders: BuildingCollider[] = [];
  const activeBuildingColliders: BuildingCollider[] = [];
  const activeColliderCenter = new THREE.Vector2(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  const buildingIngestAnchor = new THREE.Vector2(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  let activeColliderSourceCount = -1;
  const traffic: TrafficCar[] = [];
  const trafficRoutes: Route[] = [];
  const trafficAnchor = new THREE.Vector2(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  const campusNpcs: CampusNpc[] = [];
  const pedestrianRoutes: CrowdRoute[] = [];
  const pedestrianRouteKeys = new Set<string>();
  let pedestrianRouteGeneration = 0;
  let pedestrianWaterGeneration = -1;
  const mappedWaterAreas: WaterArea[] = [];
  let mappedWaterSignature = '';
  let mappedWaterGeneration = 0;
  let waterRefreshRequested = true;
  let waterRefreshClock = 0;
  const mappedWaterAnchor = new THREE.Vector2(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  let dryMappedWalkwayCache: CrowdRoute[] = [];
  let dryMappedWalkwayCacheDirty = true;
  let guaranteedPedestrianRouteCount = 0;
  let crowdRelocationClock = 0;
  const splashes: Splash[] = [];
  const honkWaves: HonkWave[] = [];
  const campusSecrets: CampusSecret[] = [];
  const flockGeese: FlockGoose[] = [];
  let secretsFound = 0;
  let recruitedFlockCount = 0;
  let paused = false;
  // Play time is banked in bulk: a store write every fifteen seconds instead of
  // one per frame keeps the debounced save from thrashing localStorage.
  let unsavedPlaySeconds = 0;
  // Per-flight tallies. airborneTime and peakAgl already exist; these two ride
  // along so a touchdown can report the whole flight in one event.
  let flightMeters = 0;
  let flightTopSpeed = 0;
  let progressGeneration = progress.get().generation;

  // A trick toast and the quest it just completed both want the score slot, and
  // the HUD only shows one at a time. The trick reads first; queued banners wait
  // their turn and drain in frame().
  const QUEST_TOAST_DELAY = 1.7;
  const pendingToasts: Array<{
    message: string;
    priority: ToastPriority;
    remaining: number;
  }> = [];
  let scoreToastCooldown = 0;

  const showScoreToast = (message: string) => {
    hooks.onToast(message, 'score');
    scoreToastCooldown = QUEST_TOAST_DELAY;
  };

  const queueScoreToast = (message: string) => {
    if (scoreToastCooldown <= 0 && pendingToasts.length === 0) {
      showScoreToast(message);
      return;
    }
    pendingToasts.push({
      message,
      priority: 'score',
      remaining: scoreToastCooldown + pendingToasts.length * QUEST_TOAST_DELAY,
    });
  };

  const drainPendingToasts = (dt: number) => {
    scoreToastCooldown = Math.max(0, scoreToastCooldown - dt);
    for (const toast of pendingToasts) toast.remaining -= dt;
    while (pendingToasts.length > 0 && pendingToasts[0].remaining <= 0) {
      const [toast] = pendingToasts.splice(0, 1);
      hooks.onToast(toast.message, toast.priority);
      scoreToastCooldown = QUEST_TOAST_DELAY;
    }
  };

  /**
   * The single funnel from the simulation into saved progress. `persist` runs in
   * the same store update as the quest pass so a discovery and its bookkeeping
   * are one write. Completed quests are announced and then reported as events of
   * their own; nothing listens for 'quest', so the recursion stops immediately.
   */
  /**
   * Phase 5: the sound for anything a quest could count. Routed off the event
   * stream rather than off each award site, so a new award that reports an
   * existing event type is audible without touching this list again.
   */
  const playEventSound = (event: GameEvent) => {
    if (event.type === 'prop') {
      if (event.action === 'wrecked') audio.crunch(event.kind);
    } else if (event.type === 'bowl') {
      audio.yelp();
    } else if (event.type === 'quest') {
      audio.chime();
      // Tokens land in the locker as part of the same store write, so the coin
      // follows the chime rather than waiting for the HUD to notice.
      if (event.tokens > 0) audio.coin();
    } else if (event.type === 'secret') {
      audio.chime();
      // Every secret pays exactly one token (quests.ts applyGameEvent).
      audio.coin();
    } else if (event.type === 'unlock') {
      audio.coin();
    } else if (event.type === 'grab') {
      audio.grab();
    } else if (event.type === 'trick' && event.id === 'dance-party') {
      audio.cheer();
    }
  };

  const recordEvent = (
    event: GameEvent,
    persist?: (saved: ProgressState) => void,
  ) => {
    const completed: QuestDefinition[] = [];
    progress.update((saved) => {
      persist?.(saved);
      const result = applyGameEvent(saved, event);
      completed.push(...result.completed);
    });
    playEventSound(event);
    hooks.onEvent?.(event);
    for (const quest of completed) {
      queueScoreToast(
        `QUEST COMPLETE · ${quest.title} · +${quest.reward} tokens`,
      );
      recordEvent({ type: 'quest', id: quest.id, tokens: quest.reward });
    }
  };
  const cameraPosition = new THREE.Vector3(0, state.position.y + 15, -18);
  const screenVisibilityProbe = new THREE.Vector3();
  const isPointInsideCameraView = (
    east: number,
    elevation: number,
    north: number,
    margin = 1.2,
  ) => {
    if (!playing) return false;
    screenVisibilityProbe
      .set(east, elevation, north)
      .applyMatrix4(camera.projectionMatrix);
    return (
      Number.isFinite(screenVisibilityProbe.x) &&
      Number.isFinite(screenVisibilityProbe.y) &&
      Number.isFinite(screenVisibilityProbe.z) &&
      Math.abs(screenVisibilityProbe.x) <= margin &&
      Math.abs(screenVisibilityProbe.y) <= margin &&
      screenVisibilityProbe.z >= -1.1 &&
      screenVisibilityProbe.z <= 1.1
    );
  };
  const cameraTarget = new THREE.Vector3(0, state.position.y + 1, 8);
  let cameraDistanceScale = DEFAULT_CAMERA_SCALE;
  let cameraDistanceTarget = DEFAULT_CAMERA_SCALE;
  let cameraOrbitYaw = 0;
  let cameraOrbitYawTarget = 0;
  let cameraOrbitPitch = DEFAULT_CAMERA_PITCH;
  let cameraOrbitPitchTarget = DEFAULT_CAMERA_PITCH;
  const initialCampusElevation = queryGroundElevation(WMU_SPAWN);
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

  /**
   * geoToLocal without the Vector3, for hot loops that only need the two
   * numbers. The building scan calls this thousands of times a pass to decide
   * a footprint is out of range.
   */
  const geoToLocalInto = (
    longitude: number,
    latitude: number,
    out: { x: number; z: number },
  ) => {
    const coordinate = maplibre.MercatorCoordinate.fromLngLat(
      [longitude, latitude],
      0,
    );
    out.x = (coordinate.x - origin.x) / meterScale;
    out.z = (origin.y - coordinate.y) / meterScale;
    return out;
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
    const elevation = queryGroundElevation(localToLngLat(east, north));
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
        if (
          maxX < state.position.x - WATER_INGEST_RADIUS ||
          minX > state.position.x + WATER_INGEST_RADIUS ||
          maxZ < state.position.z - WATER_INGEST_RADIUS ||
          minZ > state.position.z + WATER_INGEST_RADIUS
        )
          return;
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
    // A reload can return only some ponds, or none. Preserve missing nearby
    // outlines until the complete source snapshot arrives. A repeated chunk
    // must not add duplicate sheets or keep increasing the cache generation.
    if (nextAreas.length === 0 || !map.isSourceLoaded(waterSourceId)) {
      nextAreas.push(
        ...mappedWaterAreas.filter(
          (area) =>
            area.maxX >= state.position.x - WATER_INGEST_RADIUS &&
            area.minX <= state.position.x + WATER_INGEST_RADIUS &&
            area.maxZ >= state.position.z - WATER_INGEST_RADIUS &&
            area.minZ <= state.position.z + WATER_INGEST_RADIUS &&
            !nextAreas.some(
              (next) =>
                Math.abs(next.minX - area.minX) < 0.1 &&
                Math.abs(next.minZ - area.minZ) < 0.1 &&
                Math.abs(next.maxX - area.maxX) < 0.1 &&
                Math.abs(next.maxZ - area.maxZ) < 0.1,
            ),
        ),
      );
    }
    waterRefreshRequested = false;
    const nextSignature = nextAreas
      .map(
        (area) =>
          `${area.minX.toFixed(1)}:${area.minZ.toFixed(1)}:${area.maxX.toFixed(1)}:${area.maxZ.toFixed(1)}`,
      )
      .sort()
      .join('|');
    mappedWaterAnchor.set(state.position.x, state.position.z);
    if (nextSignature === mappedWaterSignature) return false;
    mappedWaterSignature = nextSignature;
    mappedWaterGeneration += 1;
    mappedWaterAreas.splice(0, mappedWaterAreas.length, ...nextAreas);
    dryMappedWalkwayCacheDirty = true;
    return true;
  };

  const refreshMappedWaterForCurrentArea = () => {
    if (
      !waterSourceId ||
      !map.getSource(waterSourceId) ||
      (!waterRefreshRequested &&
        Math.hypot(
          state.position.x - mappedWaterAnchor.x,
          state.position.z - mappedWaterAnchor.y,
        ) <=
          TREE_PLACEMENT_ANCHOR_TOLERANCE * 0.7)
    )
      return false;
    return collectMappedWaterAreas();
  };

  // Animated water sheets over the same polygons the goose lands on. The
  // style's fill stays exactly as it was underneath: it is what the far
  // distance and the rivers still show, and these meshes only cover the
  // ponds close enough to be worth a draw call.
  const waterSurfaces = createWaterSurfaces(sunDirection());
  scene.add(waterSurfaces.group);
  let waterSurfaceGeneration = -1;
  let waterSurfaceClock = 0;
  const waterSurfaceElevationAt = (east: number, north: number) => {
    if (!terrainEnabled) return campusGroundFallback;
    const elevation = sampleGroundElevationAtLocal(east, north);
    return isUsableTerrainElevation(elevation) ? elevation : null;
  };
  const refreshWaterSurfaces = () => {
    if (waterSurfaceGeneration === mappedWaterGeneration) return false;
    waterSurfaceGeneration = mappedWaterGeneration;
    waterSurfaces.rebuild(
      mappedWaterAreas,
      waterSurfaceElevationAt,
      campusGroundFallback,
    );
    return true;
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

  // Scratch for the collider terrain fit: one sample-point buffer, one
  // readings buffer and one result object, shared by the ingestion path and by
  // the resolve pass below so neither allocates per building.
  const colliderSamplePoints: number[] = Array.from(
    { length: COLLIDER_SAMPLE_COUNT * 2 },
    () => 0,
  );
  const colliderSamples: ColliderTerrainSample[] = Array.from(
    { length: COLLIDER_SAMPLE_COUNT },
    () => null,
  );
  const colliderTerrainScratch: ColliderTerrain = {
    centerGround: 0,
    ground: 0,
    height: 0,
    terrainResolved: false,
  };
  const colliderCentroidScratch: PlanarPoint = { x: 0, z: 0 };
  /** The two projected corners the building scan rejects footprints with. */
  const scanCornerLow: PlanarPoint = { x: 0, z: 0 };
  const scanCornerHigh: PlanarPoint = { x: 0, z: 0 };

  /**
   * Fit a collision box to the DEM under a footprint. A reading the DEM cannot
   * answer yet stays null rather than falling back to the campus elevation:
   * that is the whole fix for the floating roof. On a hillside the fallback is
   * the ground under the goose, which in the Valleys is up to 25 m above the
   * building, and one fallback corner among four real ones was enough to bake
   * a 12 m box onto a 5 m building forever.
   *
   * The roof lands on the centroid reading: MapLibre lifts the whole slab by
   * the DEM under the footprint's vertex centroid, so that is the only sample
   * the roof may follow. Fitting it to the highest AABB corner instead put a
   * 480 m Goldsworth Valley chunk 11 m above the building it was drawn on.
   */
  const readColliderTerrain = (
    centroidX: number,
    centroidZ: number,
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    renderHeight: number,
    renderMinHeight: number,
  ) => {
    writeColliderSamplePoints(
      colliderSamplePoints,
      centroidX,
      centroidZ,
      minX,
      minZ,
      maxX,
      maxZ,
    );
    for (let index = 0; index < COLLIDER_SAMPLE_COUNT; index += 1) {
      if (!terrainEnabled) {
        colliderSamples[index] = campusGroundFallback;
        continue;
      }
      const elevation = sampleGroundElevationAtLocal(
        colliderSamplePoints[index * 2],
        colliderSamplePoints[index * 2 + 1],
      );
      colliderSamples[index] =
        typeof elevation === 'number' && isUsableTerrainElevation(elevation)
          ? elevation
          : null;
    }
    return resolveColliderTerrain(
      colliderSamples,
      renderHeight,
      renderMinHeight,
      campusGroundFallback,
      colliderTerrainScratch,
    );
  };

  /**
   * Carry the goose with a roof whose height just changed under its feet, so a
   * late DEM never drops it through a roof it is standing on or leaves it
   * hovering above one. `previousRoof` is the surface it was standing on.
   */
  const keepGooseOnRoof = (
    building: BuildingCollider,
    previousRoof: number,
    nextRoof: number,
  ) => {
    const roofDelta = nextRoof - previousRoof;
    // A correction this large is a different building, not a settling DEM.
    if (!Number.isFinite(roofDelta) || Math.abs(roofDelta) >= 30) return;
    if (
      state.mode !== 'waddling' ||
      Math.abs(state.ground - previousRoof) >= 0.45 ||
      Math.abs(state.position.y - (previousRoof + 0.04)) >= 0.65 ||
      !pointInBuilding(state.position.x, state.position.z, building)
    )
      return;
    state.position.y += roofDelta;
    previousState.position.y += roofDelta;
    renderState.position.y += roofDelta;
    state.ground = nextRoof;
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
      let zoom = buildingTextureMaxZoom;
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
      color: 0xc7c1b5,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    const url = getAerialTileUrl(zoom, tileX, tileY);
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const texture = loader.load(
      url,
      (loadedTexture) => {
        if (buildingMaterials.get(key)?.roof !== roof) {
          loadedTexture.dispose();
          return;
        }
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
        roof.map = loadedTexture;
        roof.color.setHex(0xffffff);
        roof.needsUpdate = true;
        revealWaitingRoofs(key);
        map.triggerRepaint();
      },
      undefined,
      () => {
        if (buildingMaterials.get(key)?.roof !== roof) return;
        roof.map = null;
        roof.color.setHex(0xc7c1b5);
        roof.needsUpdate = true;
        revealWaitingRoofs(key);
      },
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    const materialSet = { texture, roof, ready: false };
    buildingMaterials.set(key, materialSet);
    return materialSet;
  };

  const getRoofOverlayBatch = (materialKey: string) => {
    const existing = roofOverlayBatches.get(materialKey);
    if (existing) return existing;
    const batch: RoofOverlayBatch = {
      records: new Set<RoofOverlayRecord>(),
      mesh: null,
      dirty: true,
    };
    roofOverlayBatches.set(materialKey, batch);
    return batch;
  };

  /**
   * Anything that changes what a batch would merge to. The rebuild itself is
   * deferred to one flush per frame: a scan can resolve a hundred footprints
   * and there is no point merging the same tile a hundred times for it.
   */
  const markRoofOverlayBatchDirty = (materialKey: string) => {
    getRoofOverlayBatch(materialKey).dirty = true;
    roofOverlayBatchesDirty = true;
  };

  /**
   * An overlay is drawn only once both its DEM and its aerial tile are in:
   * a flat tan placeholder that later flips to imagery is exactly the
   * "textures keep updating" the player sees, and MapLibre's own roof under
   * it is the same tan anyway. Merging is what enforces that now, by leaving
   * the footprint out of the batch until both are true.
   */
  const roofOverlayShowable = (record: RoofOverlayRecord) =>
    record.terrainResolved &&
    buildingMaterials.get(record.materialKey)?.ready === true;

  const rebuildRoofOverlayBatch = (
    materialKey: string,
    batch: RoofOverlayBatch,
  ) => {
    batch.dirty = false;
    if (batch.mesh) {
      texturedBuildingGroup.remove(batch.mesh);
      batch.mesh.geometry.dispose();
      batch.mesh = null;
    }
    const materials = buildingMaterials.get(materialKey);
    if (!materials) return;
    let vertexCount = 0;
    for (const record of batch.records) {
      if (!roofOverlayShowable(record)) continue;
      vertexCount += record.geometry.getAttribute('position').count;
    }
    if (vertexCount === 0) return;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    let offset = 0;
    for (const record of batch.records) {
      if (!roofOverlayShowable(record)) continue;
      const position = record.geometry.getAttribute(
        'position',
      ) as THREE.BufferAttribute;
      const normal = record.geometry.getAttribute(
        'normal',
      ) as THREE.BufferAttribute;
      const uv = record.geometry.getAttribute('uv') as THREE.BufferAttribute;
      const source = position.array as Float32Array;
      for (let index = 0; index < position.count; index += 1) {
        const target = (offset + index) * 3;
        positions[target] = source[index * 3];
        // The record's own y is renderHeight + 0.08 above its ground; the
        // ground itself only lands here, because it is the one part of the
        // footprint that moves as the DEM resolves.
        positions[target + 1] = source[index * 3 + 1] + record.centerGround;
        positions[target + 2] = source[index * 3 + 2];
      }
      normals.set(normal.array as Float32Array, offset * 3);
      uvs.set(uv.array as Float32Array, offset * 2);
      offset += position.count;
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, materials.roof);
    mesh.name = 'MiSAIL aerial roof overlay batch';
    mesh.frustumCulled = true;
    mesh.renderOrder = 1;
    texturedBuildingGroup.add(mesh);
    batch.mesh = mesh;
  };

  const flushRoofOverlayBatches = () => {
    if (!roofOverlayBatchesDirty) return;
    roofOverlayBatchesDirty = false;
    roofOverlayBatches.forEach((batch, materialKey) => {
      if (batch.dirty) rebuildRoofOverlayBatch(materialKey, batch);
    });
  };

  const revealWaitingRoofs = (materialKey: string) => {
    const materials = buildingMaterials.get(materialKey);
    if (!materials) return;
    materials.ready = true;
    markRoofOverlayBatchDirty(materialKey);
  };

  /** Drops one footprint's overlay geometry and dirties the tile it was in. */
  const removeRoofOverlayRecord = (key: string) => {
    const record = roofOverlayRecords.get(key);
    if (!record) return;
    roofOverlayRecords.delete(key);
    const batch = roofOverlayBatches.get(record.materialKey);
    if (batch) {
      batch.records.delete(record);
      batch.dirty = true;
      roofOverlayBatchesDirty = true;
    }
    record.geometry.dispose();
  };

  /** Drops one collider and the aerial roof overlay built for it, if any. */
  const removeBuildingCollider = (index: number) => {
    const building = buildingColliders[index];
    buildingColliders.splice(index, 1);
    buildingColliderByKey.delete(building.sourceKey);
    removeRoofOverlayRecord(building.sourceKey);
    texturedBuildingKeys.delete(building.sourceKey);
  };

  /** Rebuilds the active set and frees roof textures nothing draws any more. */
  const finishBuildingRemoval = () => {
    buildingCollectionGeneration += 1;
    activeColliderSourceCount = -1;
    refreshActiveBuildingColliders(true);
    buildingMaterials.forEach((materials, key) => {
      const batch = roofOverlayBatches.get(key);
      if (batch && batch.records.size > 0) return;
      if (batch) {
        if (batch.mesh) {
          texturedBuildingGroup.remove(batch.mesh);
          batch.mesh.geometry.dispose();
        }
        roofOverlayBatches.delete(key);
      }
      materials.texture.dispose();
      materials.roof.dispose();
      buildingMaterials.delete(key);
    });
  };

  const pruneDistantBuildings = () => {
    const maximumDistanceSquared = BUILDING_RETENTION_RADIUS ** 2;
    let changed = false;
    for (let index = buildingColliders.length - 1; index >= 0; index -= 1) {
      const building = buildingColliders[index];
      const centerX = (building.minX + building.maxX) * 0.5;
      const centerZ = (building.minZ + building.maxZ) * 0.5;
      const dx = centerX - state.position.x;
      const dz = centerZ - state.position.z;
      if (dx * dx + dz * dz <= maximumDistanceSquared) continue;
      removeBuildingCollider(index);
      changed = true;
    }
    if (!changed) return false;
    finishBuildingRemoval();
    return true;
  };

  /**
   * Drops the chunks MapLibre stopped drawing.
   *
   * querySourceFeatures hands back the building geometry of every tile the
   * map is rendering right now, and with a pitched camera that is a mix of
   * zooms: 28 m chunks under the goose, 480 m chunks across the valley. Each
   * chunk is extruded at its own centroid elevation. When the camera moves and
   * a coarse chunk gives way to fine ones (or a zoom-out does the reverse) the
   * old chunk's box and overlay no longer match anything on screen, and on a
   * hillside that was a blurry slab hanging metres above the building.
   *
   * Three consecutive scans without the chunk is the bar, so a tile that is
   * merely reloading does not drop the roof from under the goose; the roof it
   * is standing on is never dropped here at all.
   */
  /**
   * The highest other roof under the goose within 3 m of the one it stands
   * on, or null. Used when that roof's chunk is retired so the goose can be
   * moved onto the chunk that now draws the same building there.
   */
  const replacementRoofUnderGoose = (retiring: BuildingCollider) => {
    let best: number | null = null;
    for (const building of buildingColliders) {
      if (building === retiring || building.missingScans >= STALE_CHUNK_SCANS)
        continue;
      if (
        state.position.x < building.minX ||
        state.position.x > building.maxX ||
        state.position.z < building.minZ ||
        state.position.z > building.maxZ
      )
        continue;
      const roof = colliderRoof(building);
      if (Math.abs(roof - state.ground) > 3) continue;
      if (!pointInBuilding(state.position.x, state.position.z, building))
        continue;
      if (best === null || roof > best) best = roof;
    }
    return best;
  };

  const pruneUnseenBuildingChunks = () => {
    const scanRadiusSquared = (BUILDING_INGEST_RADIUS - 60) ** 2;
    let changed = false;
    for (let index = buildingColliders.length - 1; index >= 0; index -= 1) {
      const building = buildingColliders[index];
      if (building.missingScans < STALE_CHUNK_SCANS) continue;
      if (colliderCenterDistanceSquared(building) > scanRadiusSquared) continue;
      if (
        state.mode !== 'flying' &&
        Math.abs(state.ground - colliderRoof(building)) < 0.5 &&
        pointInBuilding(state.position.x, state.position.z, building)
      ) {
        // The goose is standing on the chunk being retired. Hand it to the
        // chunk that replaced it (the same roof, drawn a little higher or
        // lower now) rather than dropping it; with no replacement under its
        // feet the old box stays until it walks off.
        const replacement = replacementRoofUnderGoose(building);
        if (replacement === null) continue;
        state.position.y = replacement + 0.04;
        previousState.position.y = state.position.y;
        renderState.position.y = state.position.y;
        state.ground = replacement;
      }
      removeBuildingCollider(index);
      changed = true;
    }
    if (!changed) return false;
    finishBuildingRemoval();
    return true;
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
    const prunedDistantBuildings = pruneDistantBuildings();
    if (!map.getSource(buildingSourceId)) return prunedDistantBuildings;
    buildingIngestAnchor.set(state.position.x, state.position.z);
    const aerialGroundReady =
      !coarsePointer || map.isSourceLoaded('wmug-aerial-imagery');
    const features = map.querySourceFeatures(buildingSourceId, {
      sourceLayer: 'building',
    }) as Array<{
      id?: string | number;
      properties?: Record<string, unknown>;
      geometry: { type: string; coordinates: unknown };
    }>;
    let changed = prunedDistantBuildings;
    let terrainQueryBudget = coarsePointer ? 7 : 12;
    // Every collider in scan range starts this pass presumed gone; the loop
    // below clears the count for each footprint the map still hands back.
    // An empty answer is the source mid-reload, not a campus with no
    // buildings, so it does not count against anything.
    const countMissingScans = features.length > 0;
    if (countMissingScans) {
      const scanRadiusSquared = (BUILDING_INGEST_RADIUS - 60) ** 2;
      for (const building of buildingColliders) {
        if (colliderCenterDistanceSquared(building) <= scanRadiusSquared)
          building.missingScans += 1;
      }
    }

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
        const rawOuter = rings[0];
        if (!rawOuter) return;
        // A scan is handed every building polygon of each zoom-14 tile in
        // view, one to four thousand of them, and all but a few dozen are out
        // of range. So the reject runs on the raw lng/lat arrays: projecting a
        // whole ring first cost a MercatorCoordinate and a Vector3 per vertex
        // plus four spread-allocations, for a footprint across town.
        let minLongitude = Infinity;
        let maxLongitude = -Infinity;
        let minLatitude = Infinity;
        let maxLatitude = -Infinity;
        let ringLength = 0;
        for (const coordinate of rawOuter) {
          if (coordinate.length < 2) continue;
          const longitude = coordinate[0];
          const latitude = coordinate[1];
          if (longitude < minLongitude) minLongitude = longitude;
          if (longitude > maxLongitude) maxLongitude = longitude;
          if (latitude < minLatitude) minLatitude = latitude;
          if (latitude > maxLatitude) maxLatitude = latitude;
          ringLength += 1;
        }
        if (ringLength < 4) return;
        // Web Mercator is monotonic in both axes (x rises with longitude, the
        // local z rises with latitude), so projecting the two opposite corners
        // of the lng/lat box gives exactly the local box the whole ring would
        // have produced: the same rejection, two projections instead of one
        // per vertex.
        const southWest = geoToLocalInto(
          minLongitude,
          minLatitude,
          scanCornerLow,
        );
        const northEast = geoToLocalInto(
          maxLongitude,
          maxLatitude,
          scanCornerHigh,
        );
        const spanX = northEast.x - southWest.x;
        const spanZ = northEast.z - southWest.z;
        if (
          Math.hypot(
            (southWest.x + northEast.x) * 0.5 - state.position.x,
            (southWest.z + northEast.z) * 0.5 - state.position.z,
          ) > BUILDING_INGEST_RADIUS ||
          spanX < 0.8 ||
          spanZ < 0.8 ||
          spanX > 500 ||
          spanZ > 500
        )
          return;

        const outerRing = rawOuter.filter(
          (coordinate) => coordinate.length >= 2,
        );
        const localOuter = outerRing.map(([longitude, latitude]) =>
          geoToLocal(longitude, latitude),
        );
        // The footprint key and the collider box are still the projected
        // ring's own bounds, not the corner estimate above.
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const point of localOuter) {
          if (point.x < minX) minX = point.x;
          if (point.x > maxX) maxX = point.x;
          if (point.z < minZ) minZ = point.z;
          if (point.z > maxZ) maxZ = point.z;
        }
        const centerX = (minX + maxX) * 0.5;
        const centerZ = (minZ + maxZ) * 0.5;
        const distanceFromPlayer = Math.hypot(
          centerX - state.position.x,
          centerZ - state.position.z,
        );

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
          aerialGroundReady &&
          !texturedBuildingKeys.has(footprintKey) &&
          texturedBuildingKeys.size < texturedRoofLimit &&
          distanceFromPlayer <= TEXTURED_ROOF_RADIUS;
        const existingCollider = buildingColliderByKey.get(footprintKey);
        if (existingCollider) existingCollider.missingScans = 0;
        const nearPlayer =
          Math.hypot(centerX - state.position.x, centerZ - state.position.z) <=
          BUILDING_ACTIVE_RADIUS + 110;
        const staleAgainstCampus =
          existingCollider !== undefined &&
          campusGroundResolved &&
          Math.abs(existingCollider.centerGround - campusGroundFallback) > 120;
        // Colliders whose DEM was not ready at ingestion are no longer
        // re-sampled here: refreshUnresolvedColliderTerrain() sweeps those by
        // distance on its own cadence, which reaches the whole valley instead
        // of only what is already under the goose's nose. What is left for
        // this pass is ingesting new footprints and re-anchoring a box the
        // campus fallback moved out from under (a travel across town).
        const needsTerrainRefresh =
          terrainEnabled &&
          terrainQueryBudget > 0 &&
          (!existingCollider || (nearPlayer && staleAgainstCampus));

        if (existingCollider && !wantsTexturedRoof && !needsTerrainRefresh)
          return;

        const localHoles = rings.slice(1).map((holeRing) =>
          holeRing
            .filter((coordinate) => coordinate.length >= 2)
            .map(([longitude, latitude]) => geoToLocal(longitude, latitude))
            .slice(0, -1),
        );
        // The DEM point MapLibre lifts this chunk by. Holes count, exactly as
        // the bucket averages them; the scratch is copied out at once because
        // readColliderTerrain and the next polygon both reuse it.
        let centroidX: number;
        let centroidZ: number;
        if (existingCollider) {
          centroidX = existingCollider.centroidX;
          centroidZ = existingCollider.centroidZ;
        } else {
          const centroid = polygonVertexCentroid(
            [localOuter, ...localHoles],
            colliderCentroidScratch,
          );
          centroidX = centroid.x;
          centroidZ = centroid.z;
        }

        let centerGround =
          existingCollider?.centerGround ?? campusGroundFallback;
        let colliderGround =
          existingCollider?.ground ?? campusGroundFallback + renderMinHeight;
        let colliderHeight =
          existingCollider?.height ??
          Math.max(MIN_COLLIDER_HEIGHT, renderHeight);
        let colliderTerrainResolved =
          existingCollider?.terrainResolved ?? !terrainEnabled;
        if (needsTerrainRefresh) {
          terrainQueryBudget -= 1;
          if (existingCollider) {
            // A stale box was already fitted to five real corners once, so a
            // campus shift only needs the center delta to slide it; its height
            // is still the right height for that hillside.
            const reading = terrainEnabled
              ? queryGroundElevation(localToLngLat(centroidX, centroidZ))
              : campusGroundFallback;
            if (
              typeof reading === 'number' &&
              isUsableTerrainElevation(reading)
            ) {
              centerGround = reading;
              colliderGround =
                existingCollider.ground +
                (reading - existingCollider.centerGround);
              colliderHeight = existingCollider.height;
            }
            const previousRoof =
              existingCollider.ground + existingCollider.height;
            const nextRoof = colliderGround + colliderHeight;
            const terrainChanged =
              Math.abs(existingCollider.centerGround - centerGround) > 0.05 ||
              Math.abs(existingCollider.ground - colliderGround) > 0.05 ||
              Math.abs(existingCollider.height - colliderHeight) > 0.05;
            existingCollider.centerGround = centerGround;
            existingCollider.ground = colliderGround;
            existingCollider.height = colliderHeight;
            existingCollider.renderHeight = renderHeight;
            existingCollider.renderMinHeight = renderMinHeight;
            keepGooseOnRoof(existingCollider, previousRoof, nextRoof);
            const record = roofOverlayRecords.get(footprintKey);
            if (record && existingCollider.terrainResolved) {
              record.centerGround = centerGround;
              markRoofOverlayBatchDirty(record.materialKey);
            }
            if (terrainChanged) changed = true;
          } else {
            const fit = readColliderTerrain(
              centroidX,
              centroidZ,
              minX,
              minZ,
              maxX,
              maxZ,
              renderHeight,
              renderMinHeight,
            );
            centerGround = fit.centerGround;
            colliderGround = fit.ground;
            colliderHeight = fit.height;
            colliderTerrainResolved = fit.terrainResolved;
          }
        }

        if (existingCollider && !wantsTexturedRoof) return;

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
            centroidX,
            centroidZ,
            centerGround,
            ground: colliderGround,
            height: colliderHeight,
            renderHeight,
            renderMinHeight,
            terrainResolved: colliderTerrainResolved,
            missingScans: 0,
            outer: colliderOuter,
            holes: colliderHoles,
          };
          buildingColliderByKey.set(footprintKey, collider);
          buildingColliders.push(collider);
          buildingCollectionGeneration += 1;
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
        // Kicks off the aerial tile fetch if this is the first footprint on
        // it; the batch below picks the material up by key once it is ready.
        getBuildingMaterials(zoom, tileX, tileY);
        const geometry = new THREE.ShapeGeometry(shape, 1);
        applyBuildingRoofUvs(geometry, zoom, tileX, tileY);
        geometry.rotateX(-Math.PI / 2);
        geometry.translate(0, renderHeight + 0.08, 0);
        geometry.computeVertexNormals();
        // Non-indexed so merging a tile's footprints is three array copies
        // with no index rebasing; a footprint is a dozen triangles, so the
        // duplicated vertices cost nothing worth the extra bookkeeping.
        const overlayGeometry = geometry.index
          ? geometry.toNonIndexed()
          : geometry;
        if (overlayGeometry !== geometry) geometry.dispose();
        const materialKey = `${zoom}/${tileY}/${tileX}`;
        // An overlay for a building whose terrain has not resolved would hang
        // at the campus fallback elevation, which on a hillside is a roof
        // floating tens of meters over its building. The record is kept now
        // (the geometry is here and the polygon is not) but stays out of the
        // merged mesh until the resolve pass can put it at the real
        // centerGround, and until its aerial tile has arrived.
        const record: RoofOverlayRecord = {
          key: footprintKey,
          materialKey,
          geometry: overlayGeometry,
          centerGround,
          terrainResolved: existingCollider
            ? existingCollider.terrainResolved
            : colliderTerrainResolved,
        };
        roofOverlayRecords.set(footprintKey, record);
        getRoofOverlayBatch(materialKey).records.add(record);
        markRoofOverlayBatchDirty(materialKey);
        texturedBuildingKeys.add(footprintKey);
        changed = true;
      });
    });

    if (countMissingScans && pruneUnseenBuildingChunks()) changed = true;
    if (changed) settleFlockRoosts();
    return changed;
  };

  const resolvedBuildingColliderCount = () => {
    let resolved = 0;
    for (const building of buildingColliders) {
      if (building.terrainResolved) resolved += 1;
    }
    return resolved;
  };

  /** Colliders still waiting on a DEM tile, refilled every pass. */
  const unresolvedColliders: BuildingCollider[] = [];
  const unresolvedColliderBudget = coarsePointer ? 24 : 48;
  let unresolvedColliderClock = 0;

  const colliderCenterDistanceSquared = (building: BuildingCollider) => {
    const dx = (building.minX + building.maxX) * 0.5 - state.position.x;
    const dz = (building.minZ + building.maxZ) * 0.5 - state.position.z;
    return dx * dx + dz * dz;
  };

  /**
   * Re-fit every collider that was ingested before its DEM tile had decoded.
   *
   * Buildings stream in far faster than the terrain under them, so on a first
   * flight most of the valley is ingested against the campus fallback. Without
   * this pass those boxes kept the wrong height forever (the feature-driven
   * refresh only ever slid `ground`), which is what put the goose 7 m above the
   * roofs it landed on and left aerial overlays hanging over the Valleys.
   *
   * Cheap enough to run four times a second: a DEM read is a lookup into an
   * already-decoded tile, and nothing here allocates per building.
   */
  const refreshUnresolvedColliderTerrain = (
    budget = unresolvedColliderBudget,
  ) => {
    if (!terrainEnabled || buildingColliders.length === 0) return false;
    unresolvedColliders.length = 0;
    const maximumDistanceSquared = UNRESOLVED_COLLIDER_RADIUS ** 2;
    for (const building of buildingColliders) {
      if (building.terrainResolved) continue;
      if (colliderCenterDistanceSquared(building) > maximumDistanceSquared)
        continue;
      unresolvedColliders.push(building);
    }
    if (unresolvedColliders.length === 0) return false;
    // Nearest first: the roof the goose is about to land on matters more than
    // one on the far side of the valley.
    unresolvedColliders.sort(
      (a, b) =>
        colliderCenterDistanceSquared(a) - colliderCenterDistanceSquared(b),
    );
    let changed = false;
    const attempts = Math.min(budget, unresolvedColliders.length);
    for (let index = 0; index < attempts; index += 1) {
      const building = unresolvedColliders[index];
      const fit = readColliderTerrain(
        building.centroidX,
        building.centroidZ,
        building.minX,
        building.minZ,
        building.maxX,
        building.maxZ,
        building.renderHeight,
        building.renderMinHeight,
      );
      // Still a hole in the DEM: leave the flat box alone and try again next
      // pass rather than freezing half an answer into it.
      if (!fit.terrainResolved) continue;
      const previousRoof = building.ground + building.height;
      building.centerGround = fit.centerGround;
      building.ground = fit.ground;
      building.height = fit.height;
      building.terrainResolved = true;
      keepGooseOnRoof(
        building,
        previousRoof,
        building.ground + building.height,
      );
      // The overlay was built hidden at the fallback elevation (or not at all,
      // if the building was out of roof range when it was ingested, in which
      // case buildTexturedBuildings creates it later already resolved). Now it
      // has somewhere true to sit.
      const record = roofOverlayRecords.get(building.sourceKey);
      if (record) {
        record.centerGround = fit.centerGround;
        record.terrainResolved = true;
        markRoofOverlayBatchDirty(record.materialKey);
      }
      changed = true;
    }
    if (!changed) return false;
    buildingCollectionGeneration += 1;
    refreshActiveBuildingColliders(true);
    return true;
  };

  /**
   * The one place a secret group's `visible` is written. `shown` is the
   * gameplay answer (playing, terrain resolved) that telemetry and the HUD
   * read; `inRange` is purely the draw-call gate. Discovery, the compass, the
   * minimap and travelTo all work off `secret.position`, so a secret the goose
   * cannot see still behaves exactly as before.
   */
  const applySecretVisibility = (secret: CampusSecret) => {
    secret.group.visible = secret.shown && secret.inRange;
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
        // Remember the undiscovered look now: a fresh goose has to be able to
        // put every secret back the way it was found. The position matters for
        // the parts that drift once found, such as the diploma papers.
        if (object instanceof THREE.Mesh) {
          // Every secret animation moves whole objects (position, rotation,
          // scale) and never edits a vertex, so one bounding sphere per
          // geometry stays correct for the life of the secret and the meshes
          // can be culled like anything else in the scene.
          object.geometry.computeBoundingSphere();
          object.userData.basePosition = object.position.clone();
          if (object.material instanceof THREE.MeshStandardMaterial) {
            object.userData.baseEmissive = object.material.emissive.getHex();
            object.userData.baseEmissiveIntensity =
              object.material.emissiveIntensity;
          }
        }
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
      const elevation = queryGroundElevation(localToLngLat(local.x, local.y));
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
        shown: playing && terrainResolved,
        // Assumed in range until the first range sweep: the alternative is a
        // frame where every secret near the spawn is missing.
        inRange: true,
        definition,
      };
      campusSecrets.push(secret);
      applySecretVisibility(secret);
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

  // The flock is drawn as one InstancedMesh per rig part rather than eight
  // rigs in the scene: a goose is fourteen little meshes, and eight of them
  // was 112 draw calls for birds that all look identical (mutator skins only
  // ever recolor the player's rig). This one rig is never rendered; it is
  // posed once per goose per frame and its part matrices are copied into the
  // instance buffers.
  const flockPoseRig = createGooseRig();
  flockPoseRig.root.name = 'Flock pose rig';
  flockPoseRig.root.scale.setScalar(0.36);
  const flockInstanceGroup = new THREE.Group();
  flockInstanceGroup.name = 'Recruitable campus geese';
  flockInstanceGroup.visible = false;
  scene.add(flockInstanceGroup);
  const flockParts: Array<{
    source: THREE.Object3D;
    instances: THREE.InstancedMesh;
  }> = [];
  flockPoseRig.root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    // The halo is the Angel Goose mutator, which applyModifiers only ever
    // turns on for the player. Instancing it would be a draw call that never
    // shows anything.
    if (object === flockPoseRig.halo) return;
    const instances = new THREE.InstancedMesh(
      object.geometry,
      object.material,
      FLOCK_ROOSTS.length,
    );
    instances.name = 'Flock goose part';
    // Eight geese spread across campus: the batch's bounding sphere would
    // cover the whole map, so testing it would cost more than it saves.
    instances.frustumCulled = false;
    instances.castShadow = false;
    instances.receiveShadow = false;
    flockInstanceGroup.add(instances);
    flockParts.push({ source: object, instances });
  });
  /** Collapses one instance to nothing without spending a draw call on it. */
  const hiddenFlockMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

  /**
   * True when the pose rig is currently showing this part: `legs.visible` is
   * toggled for a goose in the air or on the water, and that lives on the
   * group above the leg meshes.
   */
  const flockPartVisible = (part: THREE.Object3D) => {
    let node: THREE.Object3D | null = part;
    while (node && node !== flockPoseRig.root) {
      if (!node.visible) return false;
      node = node.parent;
    }
    return true;
  };

  /** Freezes the pose rig's current stance into one goose's instance slot. */
  const publishFlockPose = (index: number, drawn: boolean) => {
    flockPoseRig.root.updateMatrixWorld(true);
    for (const part of flockParts) {
      part.instances.setMatrixAt(
        index,
        drawn && flockPartVisible(part.source)
          ? part.source.matrixWorld
          : hiddenFlockMatrix,
      );
    }
  };

  const commitFlockInstances = () => {
    for (const part of flockParts)
      part.instances.instanceMatrix.needsUpdate = true;
  };

  FLOCK_ROOSTS.forEach(([east, north], index) => {
    const beacon = new THREE.Mesh(
      new THREE.TorusGeometry(1.45, 0.055, 7, 30),
      flockBeaconMaterial.clone(),
    );
    beacon.name = 'Flock recruitment ring';
    beacon.rotation.x = Math.PI / 2;
    beacon.visible = playing;
    const home = new THREE.Vector2(east, north);
    const elevation = terrainEnabled
      ? queryGroundElevation(localToLngLat(east, north))
      : campusGroundFallback;
    const terrainResolved =
      !terrainEnabled || isUsableTerrainElevation(elevation);
    const ground =
      terrainResolved && typeof elevation === 'number'
        ? elevation
        : campusGroundFallback;
    const position = new THREE.Vector3(east, ground + 0.04, north);
    beacon.position.set(east, ground + 0.08, north);
    scene.add(beacon);
    flockGeese.push({
      beacon,
      home,
      position,
      drawnPosition: position.clone(),
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
    const elevation = queryGroundElevation(localToLngLat(east, north));
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

  const recruitFlockMember = (member: FlockGoose, silent = false) => {
    if (member.recruited) return;
    member.recruited = true;
    member.beacon.visible = false;
    member.terrainRefreshRemaining = 0;
    member.waterContactLatched = false;
    member.waterContactReleaseTime = 0;
    recruitedFlockCount += 1;
    // A goose restored from the save was already paid for; it just falls in.
    if (silent) return;
    const roostIndex = flockGeese.indexOf(member);
    awardChaos(
      300,
      `FLOCK RECRUITED ${recruitedFlockCount}/${flockGeese.length}`,
      { id: 'flock-recruited', subject: String(roostIndex) },
    );
    recordEvent(
      {
        type: 'flock',
        recruited: recruitedFlockCount,
        total: flockGeese.length,
      },
      (saved) => {
        if (!saved.recruitedGeese.includes(roostIndex))
          saved.recruitedGeese = [...saved.recruitedGeese, roostIndex];
      },
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

    flockGeese.forEach((member, memberIndex) => {
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
        member.drawnPosition.copy(member.position);
        flockPoseRig.root.position.copy(member.drawnPosition);
        flockPoseRig.root.rotation.set(
          0,
          member.phase + Math.sin(elapsedTime * 0.45 + member.phase) * 0.35,
          0,
        );
        flockPoseRig.legs.visible = true;
        setGooseWingsFolded(flockPoseRig);
        setGooseLegStride(flockPoseRig, 0);
        publishFlockPose(memberIndex, playing && member.terrainResolved);
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
              member.position.x - member.drawnPosition.x,
              member.position.z - member.drawnPosition.z,
            ) / dt
          : 0;
      keepOutsideBuildings(member.position, airborne ? 0.85 : 0.48);
      member.drawnPosition.copy(member.position);

      if (airborne) {
        flockPoseRig.root.quaternion.copy(goose.root.quaternion);
        flockPoseRig.legs.visible = false;
        flockPoseRig.leftWing.scale.set(1, 1, 1);
        flockPoseRig.rightWing.scale.set(1, 1, 1);
        // A free-running beat rather than the player's flap timer, but the
        // same quarter-cycle wrist lag, so the formation reads as birds.
        const beat = elapsedTime * 8.2 + member.phase;
        const flap = 0.12 - 0.46 * Math.cos(beat);
        const bend =
          (0.12 - 0.46 * Math.cos(beat - Math.PI * 0.5) - flap) *
          WING_OUTER_BEND;
        const twist = Math.sin(beat) * WING_OUTER_TWIST;
        flockPoseRig.leftWing.rotation.set(0, 0, flap);
        flockPoseRig.rightWing.rotation.set(0, 0, -flap);
        flockPoseRig.leftWingOuter.rotation.set(twist, 0, bend);
        flockPoseRig.rightWingOuter.rotation.set(twist, 0, -bend);
        setGooseLegStride(flockPoseRig, 0);
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
          member.drawnPosition.y +=
            (0.5 - 0.5 * Math.cos(member.waddlePhase * 2)) *
            0.025 *
            waddleAmount;
        }
        flockPoseRig.root.rotation.set(0, pose.heading, -waddle * 0.035);
        flockPoseRig.legs.visible = !followerOnWater;
        setGooseLegStride(flockPoseRig, waddle);
        setGooseWingsFolded(flockPoseRig);

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
      // Last, because the grounded branch above adds the waddle bob to the
      // drawn height after copying the simulated position into it.
      flockPoseRig.root.position.copy(member.drawnPosition);
      publishFlockPose(memberIndex, playing && member.terrainResolved);
    });
    commitFlockInstances();
  };

  /** What the LiDAR flight measured of one crown. */
  type MeasuredCrown = {
    /** Canopy top above ground, metres. */
    height: number;
    radius: number;
    /** Share of crown cells that returned points, 0..1. */
    fullness: number;
  };

  type CampusTreePoint = {
    id: number;
    key: string | null;
    local: THREE.Vector3;
    supplemental: boolean;
    scale: number;
    /**
     * Set for the LiDAR trees. The authored campus list and the trees the
     * OpenStreetMap scan invents were never measured, so they keep the old
     * pseudo-random size instead.
     */
    measured: MeasuredCrown | null;
  };

  const MAX_TREE_COUNT = coarsePointer
    ? MAX_TREE_COUNT_PHONE
    : MAX_TREE_COUNT_DESKTOP;
  const lidarTreeRadius = coarsePointer
    ? LIDAR_TREE_RADIUS_PHONE
    : LIDAR_TREE_RADIUS_DESKTOP;

  const campusTreePoints: CampusTreePoint[] = WMU_TREE_POINTS.map(
    ([id, longitude, latitude]) => ({
      id,
      key: null,
      local: geoToLocal(longitude, latitude),
      supplemental: false,
      scale: 0.9 + Math.abs(Math.sin(Number(id % 1000000) * 0.0117)) * 0.22,
      measured: null,
    }),
  ).filter(({ local }) => retainTreeAtDensity(local.x, local.z));
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
      // White, because every crown carries its own instance colour: an olive
      // bare deciduous crown and a deep conifer are the same mesh.
      color: 0xffffff,
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
  const treeVisibilityLocked = campusTreePoints.map(() => false);
  const treeDummy = new THREE.Object3D();
  let treeRefreshCursor = 0;
  let treeMatricesInitialized = false;
  let treeBlockerSignature = '';
  const woodlandAnchor = new THREE.Vector2(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  let woodlandGeneration = 0;
  const woodlandTreeKeys = new Set<string>();
  let pendingWoodlandTrees: Array<{
    key: string;
    tree: CampusTreePoint;
  }> = [];
  let woodlandScanNeedsRetry = false;
  let woodlandScanRetryAt = 0;
  /**
   * The last OSM scan's candidates, kept so a LiDAR re-selection can merge
   * them back in without paying for the polygon walk again.
   */
  let woodlandCandidates: Array<{ key: string; tree: CampusTreePoint }> = [];
  const woodlandStreamBatch = coarsePointer ? 18 : 28;
  const woodlandTerrainQueryBudget = coarsePointer ? 30 : 48;
  const lidarStreamBatch = coarsePointer
    ? LIDAR_STREAM_BATCH_PHONE
    : LIDAR_STREAM_BATCH_DESKTOP;

  // The LiDAR trees. Inside the tiled rectangle these are the trees: the
  // woodland scan and the street-tree planting below stand down there so the
  // measured trunks are not doubled by invented ones. The rectangle is
  // Mercator-aligned, so two corners are enough to test a local point.
  const treeCoverageNorthWest = geoToLocal(
    TREE_TILE_BOUNDS.west,
    TREE_TILE_BOUNDS.north,
  );
  const treeCoverageSouthEast = geoToLocal(
    TREE_TILE_BOUNDS.east,
    TREE_TILE_BOUNDS.south,
  );
  const treeCoverageMinX = Math.min(
    treeCoverageNorthWest.x,
    treeCoverageSouthEast.x,
  );
  const treeCoverageMaxX = Math.max(
    treeCoverageNorthWest.x,
    treeCoverageSouthEast.x,
  );
  const treeCoverageMinZ = Math.min(
    treeCoverageNorthWest.z,
    treeCoverageSouthEast.z,
  );
  const treeCoverageMaxZ = Math.max(
    treeCoverageNorthWest.z,
    treeCoverageSouthEast.z,
  );
  const insideTreeCoverage = (east: number, north: number, margin = 0) =>
    east >= treeCoverageMinX - margin &&
    east <= treeCoverageMaxX + margin &&
    north >= treeCoverageMinZ - margin &&
    north <= treeCoverageMaxZ + margin;
  // Served from "/" in development and "/Kalamazoo-Goose/" on Pages; the tile
  // pyramid sits next to index.html either way.
  const treeTiles = createTreeTileStore({
    base: new URL('.', window.location.href).pathname,
    toLocal: geoToLocalInto,
  });
  const lidarSelection = createTreeSelection(MAX_TREE_COUNT);
  /** Keys of the trees the last selection asked for, planted or not. */
  const lidarSelectedKeys = new Set<string>();
  const lidarAnchor = new THREE.Vector2(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  let lidarGeneration = -1;
  const lidarTreeKey = (id: number) => `L${id}`;
  const treeRecycleDistances = new Float64Array(MAX_TREE_COUNT);

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

  /**
   * Distance tests against the vehicle network only. Props deliberately do not
   * use nearMappedCorridor(): that also counts footpaths, and campus clutter
   * is supposed to line the footpaths. What a prop must stay out of is
   * traffic, which is what plows it and hands out points nobody earned.
   */
  const nearTrafficCorridor = (
    east: number,
    north: number,
    clearance: number,
  ) =>
    trafficRoutes.some((route) => {
      const limit = route.laneWidth + clearance;
      return distanceSquaredToRoute(route.points, east, north) < limit * limit;
    });
  /**
   * The same test, ignoring one route. A cone row is deliberately parked on
   * the shoulder of the drive it cones off, but where that drive crosses
   * another road the row lands in the intersection, and traffic on the
   * crossing road plows those cones down the street forever.
   */
  const nearCrossingTrafficCorridor = (
    self: Route,
    east: number,
    north: number,
    clearance: number,
  ) =>
    trafficRoutes.some((route) => {
      if (route === self) return false;
      const limit = route.laneWidth + clearance;
      return distanceSquaredToRoute(route.points, east, north) < limit * limit;
    });
  const nearTrafficLaneCenter = (
    east: number,
    north: number,
    clearance: number,
  ) =>
    trafficRoutes.some(
      (route) =>
        distanceSquaredToRoute(route.points, east, north) <
        clearance * clearance,
    );

  const pointInsideAnyBuilding = (east: number, north: number) =>
    buildingColliders.some(
      (building) =>
        east >= building.minX &&
        east <= building.maxX &&
        north >= building.minZ &&
        north <= building.maxZ &&
        pointInBuilding(east, north, building),
    );

  const treePointBlocked = (x: number, z: number) => {
    if (isPointInMappedWater(x, z)) return true;
    if (nearMappedCorridor(x, z)) return true;
    return pointInsideAnyBuilding(x, z);
  };
  const treePlacementBlocked = (index: number) => {
    const { x, z } = campusTreePoints[index].local;
    return treePointBlocked(x, z);
  };
  const treeSourceSnapshotReady = (sourceId: string | null) =>
    !sourceId ||
    (Boolean(map.getSource(sourceId)) && map.isSourceLoaded(sourceId));
  const treePlacementDataReady = () =>
    trafficBuilt &&
    trafficRoutes.length > 0 &&
    pedestrianRoutes.length > guaranteedPedestrianRouteCount &&
    buildingCollectionGeneration > 0 &&
    Math.hypot(
      state.position.x - trafficAnchor.x,
      state.position.z - trafficAnchor.y,
    ) <= TREE_PLACEMENT_ANCHOR_TOLERANCE &&
    Math.hypot(
      state.position.x - buildingIngestAnchor.x,
      state.position.z - buildingIngestAnchor.y,
    ) <= TREE_PLACEMENT_ANCHOR_TOLERANCE &&
    (!waterSourceId ||
      Math.hypot(
        state.position.x - mappedWaterAnchor.x,
        state.position.z - mappedWaterAnchor.y,
      ) <= TREE_PLACEMENT_ANCHOR_TOLERANCE) &&
    treeSourceSnapshotReady(roadSourceId) &&
    treeSourceSnapshotReady(buildingSourceId) &&
    treeSourceSnapshotReady(waterSourceId);

  // Crown palette. Closure reads as density of foliage: an open crown gets
  // a lighter, yellower green, a closed one a deep green, and the few crowns
  // dense and pointed enough to be conifers a dark, slightly blue green.
  const TREE_CROWN_BARE = new THREE.Color(0x7fa548);
  const TREE_CROWN_DENSE = new THREE.Color(0x3a7a35);
  const TREE_CROWN_CONIFER = new THREE.Color(0x2b5742);
  const TREE_CROWN_UNMEASURED = new THREE.Color(0x3f7f3d);
  const treeCrownColor = new THREE.Color();

  const writeTreeInstances = (
    index: number,
    placementDataReady = treePlacementDataReady(),
  ) => {
    const tree = campusTreePoints[index];
    const point = tree.local;
    const ground = treeGrounds[index];
    const measured = tree.measured;
    const random = Math.abs(Math.sin(Number(tree.id % 1000000) * 0.0173));
    const height = measured
      ? measured.height
      : (6.4 + random * 4.8) * tree.scale;
    const crownRadius = measured
      ? measured.radius
      : (2.1 + random * 1.3) * tree.scale;

    const placementBlocked =
      !treeVisibilityLocked[index] &&
      (!placementDataReady || treePlacementBlocked(index));
    if (ground === null || placementBlocked) {
      treeDummy.position.set(point.x, campusGroundFallback, point.z);
      treeDummy.scale.setScalar(0);
      treeDummy.updateMatrix();
      treeTrunks.setMatrixAt(index, treeDummy.matrix);
      for (let lobe = 0; lobe < 3; lobe += 1) {
        treeCrowns.setMatrixAt(index * 3 + lobe, treeDummy.matrix);
      }
      return;
    }
    if (placementDataReady) treeVisibilityLocked[index] = true;

    const conifer =
      measured !== null &&
      measured.fullness >= CONIFER_FULLNESS &&
      height >= crownRadius * 2 * CONIFER_SLENDERNESS;
    // Where the crown sits on the trunk. A measured tree gets its own canopy
    // top; the trunk is drawn up to the crown rather than only to its stated
    // 40%, because a narrow crown high on a bare pole reads as a floating ball.
    const crownCenter = measured ? height * TREE_CROWN_CENTRE_SHARE : height;
    const trunkTop = measured
      ? Math.max(
          height * TREE_TRUNK_HEIGHT_SHARE,
          crownCenter - crownRadius * (conifer ? 0.9 : 0.6),
        )
      : height * 0.84;
    const trunkRadius = measured
      ? clamp(
          height * TREE_TRUNK_RADIUS_SHARE,
          TREE_TRUNK_RADIUS_MIN,
          TREE_TRUNK_RADIUS_MAX,
        )
      : (0.72 + random * 0.26) * TREE_TRUNK_GEOMETRY_RADIUS;
    const trunkScale = trunkRadius / TREE_TRUNK_GEOMETRY_RADIUS;

    treeDummy.position.set(point.x, ground + trunkTop * 0.5 + 0.08, point.z);
    treeDummy.scale.set(trunkScale, trunkTop, trunkScale);
    treeDummy.rotation.y = random * Math.PI;
    treeDummy.updateMatrix();
    treeTrunks.setMatrixAt(index, treeDummy.matrix);

    if (conifer) {
      treeCrownColor.copy(TREE_CROWN_CONIFER);
    } else if (measured) {
      treeCrownColor
        .copy(TREE_CROWN_BARE)
        .lerp(TREE_CROWN_DENSE, clamp((measured.fullness - 0.45) / 0.45, 0, 1));
    } else {
      treeCrownColor.copy(TREE_CROWN_UNMEASURED);
    }
    // A stand of one species is still a stand of individuals: shade each tree
    // a little lighter or darker than its neighbour.
    treeCrownColor.multiplyScalar(0.86 + random * 0.28);

    for (let lobe = 0; lobe < 3; lobe += 1) {
      const crownIndex = index * 3 + lobe;
      if (conifer) {
        // Three spheres up the spine instead of three lobes around it, each
        // narrower than the one below: a spruce, not a shade tree.
        const taper = 1 - lobe * 0.3;
        const lobeRadius = crownRadius * 0.66 * taper;
        treeDummy.position.set(
          point.x,
          ground + crownCenter + (lobe - 0.55) * height * 0.15,
          point.z,
        );
        treeDummy.scale.set(lobeRadius, lobeRadius * 1.3, lobeRadius);
        treeDummy.rotation.y = random * Math.PI + lobe;
      } else {
        const angle = random * Math.PI * 2 + lobe * ((Math.PI * 2) / 3);
        const offset = lobe === 0 ? 0 : crownRadius * 0.5;
        const lobeScale = lobe === 0 ? 1 : 0.76;
        treeDummy.position.set(
          point.x + Math.cos(angle) * offset,
          ground + crownCenter - (lobe === 0 ? 0 : crownRadius * 0.18),
          point.z + Math.sin(angle) * offset,
        );
        treeDummy.scale.set(
          crownRadius * lobeScale,
          crownRadius * (lobe === 0 ? 1.18 : 0.82),
          crownRadius * lobeScale,
        );
        treeDummy.rotation.y = angle;
      }
      treeDummy.updateMatrix();
      treeCrowns.setMatrixAt(crownIndex, treeDummy.matrix);
      treeCrowns.setColorAt(crownIndex, treeCrownColor);
    }
  };

  const markTreeInstancesDirty = () => {
    treeTrunks.instanceMatrix.needsUpdate = true;
    treeCrowns.instanceMatrix.needsUpdate = true;
    if (treeCrowns.instanceColor) treeCrowns.instanceColor.needsUpdate = true;
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
      scanned += 1;
      if (!terrainEnabled || elapsedTime < treeTerrainRefreshAt[index])
        continue;
      const tree = campusTreePoints[index];
      const point = tree.local;
      const distanceFromPlayer = Math.hypot(
        point.x - state.position.x,
        point.z - state.position.z,
      );
      if (
        !treePlacementBlocked(index) &&
        (!nearPlayerOnly || distanceFromPlayer < 650)
      ) {
        queries += 1;
        const elevation = queryGroundElevation(localToLngLat(point.x, point.z));
        const terrainReady = isUsableTerrainElevation(elevation);
        if (terrainReady && typeof elevation === 'number') {
          treeTerrainRefreshAt[index] = Number.POSITIVE_INFINITY;
          const groundChanged =
            treeGrounds[index] === null ||
            Math.abs((treeGrounds[index] ?? elevation) - elevation) > 0.05;
          if (groundChanged) {
            changed = true;
            changedIndices.add(index);
          }
          treeGrounds[index] = elevation;
        } else {
          treeTerrainRefreshAt[index] = elapsedTime + 0.55;
        }
      }
    }
    treeRefreshCursor =
      (startCursor + (scanned === treeCount ? 1 : Math.max(1, scanned))) %
      treeCount;

    if (!treeMatricesInitialized) {
      const placementDataReady = treePlacementDataReady();
      campusTreePoints.forEach((_, index) =>
        writeTreeInstances(index, placementDataReady),
      );
      treeMatricesInitialized = true;
      changed = true;
    } else {
      const placementDataReady = treePlacementDataReady();
      changedIndices.forEach((index) =>
        writeTreeInstances(index, placementDataReady),
      );
    }
    unresolvedTreeCount = 0;
    campusTreePoints.forEach((_, index) => {
      if (treeGrounds[index] === null || !treeVisibilityLocked[index])
        unresolvedTreeCount += 1;
    });
    if (changed) markTreeInstancesDirty();
    return changed;
  };

  const collectMappedWoodlandTrees = () => {
    if (!treePlacementDataReady()) return false;
    // Tiles first: a request never blocks, and inside the rectangle the
    // measured trees are the only trees the rest of this pass will find.
    const lidarActive = insideTreeCoverage(
      state.position.x,
      state.position.z,
      lidarTreeRadius,
    );
    if (lidarActive) {
      const here = localToLngLat(state.position.x, state.position.z);
      treeTiles.request(here.lng, here.lat, lidarTreeRadius);
    } else if (lidarSelectedKeys.size > 0) {
      // Flown out of the tiled rectangle: let go of the measured trees so the
      // woodland scan can recycle their slots for trees that are out here.
      lidarSelectedKeys.clear();
      lidarSelection.count = 0;
      lidarGeneration = -1;
      lidarAnchor.set(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    }
    const woodlandSourceReady = Boolean(
      landcoverSourceId && map.getSource(landcoverSourceId),
    );
    if (!lidarActive && !woodlandSourceReady) return false;
    const movedFromWoodlandAnchor =
      Math.hypot(
        state.position.x - woodlandAnchor.x,
        state.position.z - woodlandAnchor.y,
      ) > WOODLAND_REANCHOR_DISTANCE;
    const woodlandRescan =
      woodlandSourceReady &&
      (movedFromWoodlandAnchor ||
        (woodlandScanNeedsRetry && elapsedTime >= woodlandScanRetryAt));
    // The measured trees are re-picked far more often than the woodland is
    // rescanned: the selection is only 900 m wide, so a short flight already
    // leaves its far half behind and wants the trees ahead instead.
    const lidarReselect =
      lidarActive &&
      (treeTiles.generation !== lidarGeneration ||
        Math.hypot(
          state.position.x - lidarAnchor.x,
          state.position.z - lidarAnchor.y,
        ) > LIDAR_TREE_REANCHOR_DISTANCE);
    if (woodlandRescan && landcoverSourceId) {
      const features = map.querySourceFeatures(landcoverSourceId, {
        sourceLayer: 'landcover',
      }) as Array<{
        properties?: Record<string, unknown>;
        geometry: { type: string; coordinates: unknown };
      }>;
      const spacing = coarsePointer ? 15.5 : 13.5;
      const candidates = new Map<string, CampusTreePoint>();
      const mappedTrees = campusTreePoints.slice(0, mappedTreeCount);
      const candidateLimit = Math.ceil(
        MAX_TREE_COUNT * (coarsePointer ? 1.25 : 1.75),
      );
      const gridInspectionLimit = coarsePointer ? 16_000 : 32_000;
      let gridInspections = 0;

      // Collect every wood polygon that overlaps the ingest window first.
      // The map no longer slices vector tiles (see goose-game.tsx), so a
      // single feature can be a whole square kilometre of forest, and the
      // old polygon-by-polygon walk spent its entire cell budget on the
      // first big one it met, wherever that was, leaving the woods next to
      // the goose bare. Walking cells outward from the goose instead means
      // the budget always buys the nearest trees.
      const windowMinX = state.position.x - WOODLAND_INGEST_RADIUS;
      const windowMaxX = state.position.x + WOODLAND_INGEST_RADIUS;
      const windowMinZ = state.position.z - WOODLAND_INGEST_RADIUS;
      const windowMaxZ = state.position.z + WOODLAND_INGEST_RADIUS;
      const woods: Array<{
        outer: THREE.Vector2[];
        holes: THREE.Vector2[][];
        minX: number;
        maxX: number;
        minZ: number;
        maxZ: number;
      }> = [];
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
          let minX = Number.POSITIVE_INFINITY;
          let maxX = Number.NEGATIVE_INFINITY;
          let minZ = Number.POSITIVE_INFINITY;
          let maxZ = Number.NEGATIVE_INFINITY;
          for (const point of outer) {
            if (point.x < minX) minX = point.x;
            if (point.x > maxX) maxX = point.x;
            if (point.y < minZ) minZ = point.y;
            if (point.y > maxZ) maxZ = point.y;
          }
          if (
            maxX < windowMinX ||
            minX > windowMaxX ||
            maxZ < windowMinZ ||
            minZ > windowMaxZ
          )
            return;
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
          woods.push({ outer, holes, minX, maxX, minZ, maxZ });
        });
      });

      if (woods.length > 0) {
        const centerCellX = Math.floor(state.position.x / spacing);
        const centerCellZ = Math.floor(state.position.z / spacing);
        const maxRing = Math.ceil(WOODLAND_INGEST_RADIUS / spacing);
        const inspectCell = (cellX: number, cellZ: number) => {
          gridInspections += 1;
          const key = `${cellX}:${cellZ}`;
          if (woodlandTreeKeys.has(key) || candidates.has(key)) return;
          const hash = Math.sin(cellX * 12.9898 + cellZ * 78.233) * 43758.5453;
          const unit = hash - Math.floor(hash);
          const secondHash =
            Math.sin(cellX * 39.3467 - cellZ * 11.135) * 24634.6345;
          const secondUnit = secondHash - Math.floor(secondHash);
          const east = (cellX + 0.5) * spacing + (unit - 0.5) * 4.8;
          const north = (cellZ + 0.5) * spacing + (secondUnit - 0.5) * 4.8;
          if (!retainTreeAtDensity(east, north)) return;
          // Inside the tiled rectangle the LiDAR knows what actually grows
          // here; inventing a tree on a grid on top of that doubles the woods.
          if (insideTreeCoverage(east, north)) return;
          let wooded = false;
          for (const wood of woods) {
            if (
              east < wood.minX ||
              east > wood.maxX ||
              north < wood.minZ ||
              north > wood.maxZ ||
              !pointInRing(east, north, wood.outer) ||
              wood.holes.some((hole) => pointInRing(east, north, hole))
            )
              continue;
            wooded = true;
            break;
          }
          if (
            !wooded ||
            mappedTrees.some(
              (tree) =>
                Math.hypot(tree.local.x - east, tree.local.z - north) < 6,
            )
          )
            return;
          candidates.set(key, {
            id:
              9_900_000_000 + Math.abs(cellX * 73_856_093 + cellZ * 19_349_663),
            key,
            local: new THREE.Vector3(east, 0, north),
            supplemental: true,
            scale: 0.76 + unit * 0.25,
            measured: null,
          });
        };
        const budgetLeft = () =>
          candidates.size < candidateLimit &&
          gridInspections < gridInspectionLimit;
        inspectCell(centerCellX, centerCellZ);
        // Square rings outward: the top and bottom rows, then the two side
        // columns without their corners, so every cell is visited once.
        for (let ring = 1; ring <= maxRing && budgetLeft(); ring += 1) {
          for (let dx = -ring; dx <= ring && budgetLeft(); dx += 1) {
            inspectCell(centerCellX + dx, centerCellZ - ring);
            if (budgetLeft()) inspectCell(centerCellX + dx, centerCellZ + ring);
          }
          for (let dz = -ring + 1; dz <= ring - 1 && budgetLeft(); dz += 1) {
            inspectCell(centerCellX - ring, centerCellZ + dz);
            if (budgetLeft()) inspectCell(centerCellX + ring, centerCellZ + dz);
          }
        }
      }

      // Street trees. Off campus the only mapped trees are OSM wood
      // polygons, which residential Kalamazoo barely has, so the
      // neighbourhoods came up bare. Real streets have a tree every couple
      // of lots; plant one every STREET_TREE_SPACING along minor and
      // tertiary roads, on both sides, a lot-depth off the centreline. They
      // share the woodland budget and pipeline, so water, roads and
      // buildings still reject them and the nearest ones land first.
      if (map.getSource(roadSourceId) && candidates.size < candidateLimit) {
        const roads = map.querySourceFeatures(roadSourceId, {
          sourceLayer: 'transportation',
        }) as Array<{
          properties?: Record<string, unknown>;
          geometry: { type: string; coordinates: unknown };
        }>;
        const streetLimit = Math.min(
          candidateLimit,
          candidates.size + STREET_TREE_CANDIDATE_LIMIT,
        );
        const plantAlong = (coordinates: number[][]) => {
          let carry = STREET_TREE_SPACING * 0.5;
          for (
            let index = 1;
            index < coordinates.length && candidates.size < streetLimit;
            index += 1
          ) {
            const from = geoToLocalInto(
              coordinates[index - 1][0],
              coordinates[index - 1][1],
              scanCornerLow,
            );
            const fromX = from.x;
            const fromZ = from.z;
            const to = geoToLocalInto(
              coordinates[index][0],
              coordinates[index][1],
              scanCornerHigh,
            );
            const segmentX = to.x - fromX;
            const segmentZ = to.z - fromZ;
            const length = Math.hypot(segmentX, segmentZ);
            if (length < 0.5) continue;
            const rightX = segmentZ / length;
            const rightZ = -segmentX / length;
            let along = carry;
            while (along <= length && candidates.size < streetLimit) {
              const centerX = fromX + (segmentX * along) / length;
              const centerZ = fromZ + (segmentZ * along) / length;
              for (const side of [1, -1]) {
                const cellX = Math.floor(
                  (centerX + rightX * side * STREET_TREE_OFFSET) / spacing,
                );
                const cellZ = Math.floor(
                  (centerZ + rightZ * side * STREET_TREE_OFFSET) / spacing,
                );
                const key = `${cellX}:${cellZ}`;
                if (woodlandTreeKeys.has(key) || candidates.has(key)) continue;
                const hash =
                  Math.sin(cellX * 12.9898 + cellZ * 78.233) * 43758.5453;
                const unit = hash - Math.floor(hash);
                const offset = STREET_TREE_OFFSET + (unit - 0.5) * 2.4;
                const east = centerX + rightX * side * offset;
                const north = centerZ + rightZ * side * offset;
                if (!retainTreeAtDensity(east, north)) continue;
                if (
                  Math.hypot(
                    east - state.position.x,
                    north - state.position.z,
                  ) > WOODLAND_INGEST_RADIUS ||
                  // The LiDAR already found whatever really lines this street.
                  insideTreeCoverage(east, north) ||
                  mappedTrees.some(
                    (tree) =>
                      Math.hypot(tree.local.x - east, tree.local.z - north) < 6,
                  )
                )
                  continue;
                candidates.set(key, {
                  id:
                    9_800_000_000 +
                    Math.abs(cellX * 73_856_093 + cellZ * 19_349_663),
                  key,
                  local: new THREE.Vector3(east, 0, north),
                  supplemental: true,
                  scale: 0.7 + unit * 0.22,
                  measured: null,
                });
              }
              along += STREET_TREE_SPACING;
            }
            carry = along - length;
          }
        };
        for (const feature of roads) {
          if (candidates.size >= streetLimit) break;
          const roadClass =
            typeof feature.properties?.class === 'string'
              ? feature.properties.class
              : '';
          if (
            !STREET_TREE_ROAD_CLASSES.has(roadClass) ||
            feature.properties?.brunnel === 'tunnel' ||
            feature.properties?.brunnel === 'bridge'
          )
            continue;
          if (feature.geometry.type === 'LineString')
            plantAlong(feature.geometry.coordinates as number[][]);
          else if (feature.geometry.type === 'MultiLineString')
            for (const line of feature.geometry.coordinates as number[][][])
              plantAlong(line);
        }
      }

      woodlandAnchor.set(state.position.x, state.position.z);
      woodlandScanNeedsRetry =
        candidates.size === 0 && !map.isSourceLoaded(landcoverSourceId);
      woodlandScanRetryAt = elapsedTime + 4;
      woodlandCandidates = [...candidates.entries()].map(([key, tree]) => ({
        key,
        tree,
      }));
    }

    if (lidarReselect) {
      treeTiles.query(
        state.position.x,
        state.position.z,
        lidarTreeRadius,
        lidarSelection,
      );
      lidarSelectedKeys.clear();
      for (let slot = 0; slot < lidarSelection.count; slot += 1) {
        lidarSelectedKeys.add(lidarTreeKey(lidarSelection.ids[slot]));
      }
      lidarAnchor.set(state.position.x, state.position.z);
      lidarGeneration = treeTiles.generation;
    }

    if (woodlandRescan || lidarReselect) {
      // Both sources feed one queue, so the streaming budget, the terrain
      // sampling and the recycling below stay exactly as they were. Trees
      // already standing are skipped here rather than replanted.
      const queued: typeof pendingWoodlandTrees = [];
      for (const candidate of woodlandCandidates) {
        if (!woodlandTreeKeys.has(candidate.key)) queued.push(candidate);
      }
      for (let slot = 0; slot < lidarSelection.count; slot += 1) {
        const key = lidarTreeKey(lidarSelection.ids[slot]);
        if (woodlandTreeKeys.has(key)) continue;
        queued.push({
          key,
          tree: {
            id: lidarSelection.ids[slot],
            key,
            local: new THREE.Vector3(
              lidarSelection.east[slot],
              0,
              lidarSelection.north[slot],
            ),
            supplemental: true,
            scale: 1,
            measured: {
              height: lidarSelection.height[slot],
              radius: lidarSelection.crownRadius[slot],
              fullness: lidarSelection.fullness[slot],
            },
          },
        });
      }
      queued.sort(
        ({ tree: first }, { tree: second }) =>
          (first.local.x - state.position.x) ** 2 +
          (first.local.z - state.position.z) ** 2 -
          ((second.local.x - state.position.x) ** 2 +
            (second.local.z - state.position.z) ** 2),
      );
      pendingWoodlandTrees = queued;
    }
    if (pendingWoodlandTrees.length === 0) return false;

    // Only worth computing once the budget is full: until then every planting
    // appends into a free slot, and this scan is the expensive part of a pass.
    const replacementIndices: number[] = [];
    if (treeCount >= MAX_TREE_COUNT) {
      for (let index = 0; index < treeCount; index += 1) {
        const tree = campusTreePoints[index];
        if (!tree.supplemental) continue;
        const distance = Math.hypot(
          tree.local.x - state.position.x,
          tree.local.z - state.position.z,
        );
        // A measured tree is recyclable the moment the selection stops asking
        // for it. Waiting for the woodland recycle ring would never happen:
        // the whole selection is closer to the goose than that ring is.
        const stale = tree.measured
          ? tree.key === null || !lidarSelectedKeys.has(tree.key)
          : distance > WOODLAND_RECYCLE_DISTANCE;
        if (
          !stale ||
          isPointInsideCameraView(
            tree.local.x,
            (treeGrounds[index] ?? state.ground) + 6,
            tree.local.z,
          )
        )
          continue;
        treeRecycleDistances[index] = distance;
        replacementIndices.push(index);
      }
      replacementIndices.sort(
        (first, second) =>
          treeRecycleDistances[second] - treeRecycleDistances[first],
      );
    }
    const retryLater: typeof pendingWoodlandTrees = [];
    const streamBatch =
      lidarActive && lidarSelection.count > 0
        ? lidarStreamBatch
        : woodlandStreamBatch;
    const terrainQueryBudget =
      lidarActive && lidarSelection.count > 0
        ? lidarStreamBatch
        : woodlandTerrainQueryBudget;
    const inspectionBudget = terrainQueryBudget * 3;
    let inspections = 0;
    let terrainQueries = 0;
    let changes = 0;
    while (
      pendingWoodlandTrees.length > 0 &&
      inspections < inspectionBudget &&
      terrainQueries < terrainQueryBudget &&
      changes < streamBatch
    ) {
      const candidate = pendingWoodlandTrees.shift();
      if (!candidate) break;
      inspections += 1;
      if (woodlandTreeKeys.has(candidate.key)) continue;
      // The two deferrals below hide the pop of a tree appearing where the
      // player is looking. They only apply once the budget is full: during the
      // first fill every slot is empty, and an empty wood in front of the
      // goose looks far worse than a wood that finishes drawing itself.
      const deferForPresentation =
        candidate.tree.measured === null || treeCount >= MAX_TREE_COUNT;
      const distanceFromPlayer = Math.hypot(
        candidate.tree.local.x - state.position.x,
        candidate.tree.local.z - state.position.z,
      );
      if (
        deferForPresentation &&
        distanceFromPlayer < WOODLAND_SPAWN_MIN_DISTANCE
      ) {
        retryLater.push(candidate);
        continue;
      }
      if (treePointBlocked(candidate.tree.local.x, candidate.tree.local.z))
        continue;
      if (treeCount >= MAX_TREE_COUNT && replacementIndices.length === 0) {
        pendingWoodlandTrees.unshift(candidate);
        break;
      }
      terrainQueries += 1;
      const elevation = terrainEnabled
        ? queryGroundElevation(
            localToLngLat(candidate.tree.local.x, candidate.tree.local.z),
          )
        : campusGroundFallback;
      if (
        !isUsableTerrainElevation(elevation) ||
        typeof elevation !== 'number'
      ) {
        retryLater.push(candidate);
        continue;
      }
      if (
        deferForPresentation &&
        isPointInsideCameraView(
          candidate.tree.local.x,
          elevation + 6,
          candidate.tree.local.z,
        )
      ) {
        retryLater.push(candidate);
        continue;
      }

      const index =
        treeCount < MAX_TREE_COUNT
          ? treeCount
          : (replacementIndices.shift() ?? -1);
      if (index < 0) {
        retryLater.push(candidate);
        continue;
      }
      const previousKey = campusTreePoints[index]?.key;
      if (previousKey) woodlandTreeKeys.delete(previousKey);
      if (index === treeCount) {
        campusTreePoints.push(candidate.tree);
        treeGrounds.push(elevation);
        treeTerrainRefreshAt.push(Number.POSITIVE_INFINITY);
        treeVisibilityLocked.push(false);
        treeCount += 1;
      } else {
        campusTreePoints[index] = candidate.tree;
        treeGrounds[index] = elevation;
        treeTerrainRefreshAt[index] = Number.POSITIVE_INFINITY;
        treeVisibilityLocked[index] = false;
      }
      woodlandTreeKeys.add(candidate.key);
      writeTreeInstances(index, true);
      changes += 1;
    }
    pendingWoodlandTrees.push(...retryLater);
    if (changes === 0) return false;

    woodlandGeneration += 1;
    treeTrunks.count = treeCount;
    treeCrowns.count = treeCount * 3;
    markTreeInstancesDirty();
    return true;
  };

  const refreshTreePlacementMask = () => {
    const signature = `${mappedWaterGeneration}:${buildingCollectionGeneration}:${trafficRoutes.length}:${pedestrianRoutes.length}:${pedestrianRouteGeneration}:${woodlandGeneration}:${treeCount}`;
    if (signature === treeBlockerSignature) return false;
    treeBlockerSignature = signature;
    if (!treeMatricesInitialized) return false;
    const placementDataReady = treePlacementDataReady();
    campusTreePoints.forEach((_, index) =>
      writeTreeInstances(index, placementDataReady),
    );
    markTreeInstancesDirty();
    return true;
  };

  updateTrees();

  const setGameplayVisibility = (visible: boolean) => {
    goose.root.visible = visible;
    gooseShadow.setVisible(visible);
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
    waterSurfaces.setVisible(visible);
    propSystem.setVisible(visible);
    setPhase3Visibility(visible);
    cloudPuffs.visible = visible && cloudBaseResolved;
    texturedBuildingGroup.visible = visible;
    campusSecrets.forEach((secret) => {
      secret.shown = visible && secret.terrainResolved;
      applySecretVisibility(secret);
    });
    // Per-goose terrainResolved is carried by the instance matrices that
    // updateFlockVisuals writes; this flag is the whole flock at once.
    flockInstanceGroup.visible = visible;
    flockGeese.forEach((member) => {
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
    const elevation = queryGroundElevation(location);
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
    // Physics uses the same geographic outlines as the visible pond sheets,
    // NPC avoidance, and flock. A screen-space water hit depends on the chase
    // camera and terrain projection, and can miss the Valley ponds entirely.
    state.onWater =
      roof === null && isPointInMappedWater(state.position.x, state.position.z);
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
    // The sheet itself answers the landing, not just the ring props above it.
    // A splash on dry ground finds no surface here and is silently dropped.
    waterSurfaces.ripple(position.x, position.z, strength);
    // Only the player's own entry is audible. Flock followers splash in with
    // the same helper, and eight geese landing on a pond would be a wall of
    // noise rather than a landing the player can read.
    if (position === state.position) audio.splash(strength);
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
    audio.skim();
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
    const movedFromTrafficAnchor =
      !trafficBuilt ||
      Math.hypot(
        state.position.x - trafficAnchor.x,
        state.position.z - trafficAnchor.y,
      ) > TRAFFIC_REANCHOR_DISTANCE;
    if (
      !map.getSource(roadSourceId) ||
      (trafficBuilt && !movedFromTrafficAnchor)
    )
      return false;
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
        .filter(
          (point) =>
            Math.hypot(point.x - state.position.x, point.z - state.position.z) <
            TRAFFIC_ROUTE_RADIUS,
        );
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
        roadClass,
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
    if (routes.length < 6) return false;
    const nextTrafficRoutes = routes.slice(0, 24);
    traffic.length = 0;
    trafficRoutes.length = 0;
    pedestrianRoutes.length = guaranteedPedestrianRouteCount;
    pedestrianRouteKeys.clear();
    for (let index = 0; index < guaranteedPedestrianRouteCount; index += 1) {
      pedestrianRouteKeys.add(`campus-lawn:${index}`);
    }
    dryMappedWalkwayCache = [];
    dryMappedWalkwayCacheDirty = true;
    pedestrianRouteGeneration += 1;
    trafficRoutes.push(...nextTrafficRoutes);
    const colors = [
      0xc94b43, 0xe5ae39, 0x3d6f9f, 0xe8e4d6, 0x5a7358, 0x8b5a88, 0x33383c,
      0xd47a36,
    ];
    const activeRoutes = Math.min(routes.length, 20);
    const count = Math.min(
      MAX_TRAFFIC,
      Math.max(24, Math.ceil(activeRoutes * 2.5)),
    );
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
        yielding: false,
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
    trafficAnchor.set(state.position.x, state.position.z);
    trafficBuilt = true;
    return true;
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

  const sampleCrowdRouteSpawn = (
    route: CrowdRoute,
    distance: number,
    east: number,
    north: number,
  ) => {
    const routeDistance = clamp(distance, 0, route.total);
    let index = 1;
    while (
      index < route.cumulative.length - 1 &&
      route.cumulative[index] < routeDistance
    )
      index += 1;
    const start = route.points[index - 1];
    const end = route.points[index];
    const segmentStart = route.cumulative[index - 1];
    const segmentLength = Math.max(
      0.0001,
      route.cumulative[index] - segmentStart,
    );
    const amount = clamp((routeDistance - segmentStart) / segmentLength, 0, 1);
    const spawnEast = lerp(start.x, end.x, amount);
    const spawnNorth = lerp(start.z, end.z, amount);
    const deltaX = spawnEast - east;
    const deltaZ = spawnNorth - north;
    return {
      east: spawnEast,
      north: spawnNorth,
      distanceSquared: deltaX * deltaX + deltaZ * deltaZ,
    };
  };

  const recycleDistantCrowd = (
    routes: CrowdRoute[],
    focusX: number,
    focusZ: number,
    force = false,
  ) => {
    if (routes.length === 0 || campusNpcs.length === 0) return false;
    const activeRoutes = new Set(pedestrianRoutes);
    const recyclable = campusNpcs
      .map((npc) => {
        const distance = Math.hypot(
          npc.position.x - state.position.x,
          npc.position.z - state.position.z,
        );
        return {
          npc,
          distance,
          wet:
            isPointInMappedWater(npc.position.x, npc.position.z) ||
            crowdRouteTouchesMappedWater(npc.route),
          stale: !activeRoutes.has(npc.route),
        };
      })
      .filter(
        ({ npc, distance, wet, stale }) =>
          npc.mode === 'walk' &&
          (force ||
            (!isPointInsideCameraView(
              npc.position.x,
              npc.ground + 1.8,
              npc.position.z,
              1.25,
            ) &&
              distance > NPC_STALE_ROUTE_KEEP_DISTANCE &&
              (wet || stale || distance > NPC_RECYCLE_DISTANCE))),
      )
      .sort(
        (a, b) =>
          Number(b.wet) - Number(a.wet) ||
          Number(b.stale) - Number(a.stale) ||
          b.distance - a.distance,
      );
    const offscreenStaleCount = recyclable.filter(
      ({ stale, distance }) => stale && distance > NPC_RECYCLE_DISTANCE,
    ).length;
    const candidates = recyclable.slice(
      0,
      force
        ? NEAR_SPAWN_CROWD_COUNT
        : Math.min(
            NPC_STALE_RECYCLE_BATCH,
            Math.max(NPC_RECYCLE_BATCH, offscreenStaleCount),
          ),
    );
    if (candidates.length === 0) return false;

    const nearestRoutes = routes
      .map((route) => ({
        route,
        ...nearestDistanceOnCrowdRoute(route, focusX, focusZ),
      }))
      .sort((a, b) => a.distanceSquared - b.distanceSquared)
      .slice(0, Math.min(12, routes.length));
    let changed = false;
    candidates.forEach(({ npc }, recycleIndex) => {
      const edgeOffset = 70 + ((npc.index + recycleIndex * 3) % 6) * 10;
      const minimumSpawnDistance = force ? 8 : NPC_SPAWN_MIN_DISTANCE;
      let replacement: CampusNpc | null = null;
      for (
        let routeAttempt = 0;
        routeAttempt < nearestRoutes.length && replacement === null;
        routeAttempt += 1
      ) {
        const candidate =
          nearestRoutes[
            (npc.index + recycleIndex + routeAttempt) % nearestRoutes.length
          ];
        for (let sideAttempt = 0; sideAttempt < 2; sideAttempt += 1) {
          const side =
            (npc.index + recycleIndex + routeAttempt + sideAttempt) % 2 === 0
              ? -1
              : 1;
          const distance = clamp(
            candidate.distance + side * edgeOffset,
            0,
            candidate.route.total,
          );
          const spawn = sampleCrowdRouteSpawn(
            candidate.route,
            distance,
            state.position.x,
            state.position.z,
          );
          if (
            spawn.distanceSquared >= (minimumSpawnDistance + 2) ** 2 &&
            (force ||
              !isPointInsideCameraView(
                spawn.east,
                state.ground + 1.8,
                spawn.north,
                1.25,
              ))
          ) {
            replacement = createCampusNpc(
              npc.index,
              candidate.route,
              distance,
              npcTerrainAt,
            );
            break;
          }
        }
      }
      if (!replacement) return;
      campusNpcs[npc.index] = replacement;
      changed = true;
    });
    return changed;
  };

  const collectPedestrianRoutes = () => {
    let added = addGuaranteedCampusWalkways();
    let npcAssignmentsChanged = false;
    if (pedestrianWaterGeneration !== mappedWaterGeneration) {
      dryMappedWalkwayCacheDirty = true;
      pedestrianWaterGeneration = mappedWaterGeneration;
    }
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
        .filter(
          (point) =>
            Math.hypot(point.x - state.position.x, point.z - state.position.z) <
            1_200,
        );
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
    // Nearest paths first, dedicated walkways ahead of roadsides. The route
    // list is capped, and the source hands back whole zoom-14 tiles now (see
    // zoomLevelsToOverscale in goose-game.tsx), so accepting lines in tile
    // order filled the cap with trails on the far side of the radius and
    // left the crowd on the spawn lawn fallbacks: students in a field with
    // the real sidewalks next to them empty.
    const candidates: Array<{
      coordinates: number[][];
      dedicated: boolean;
      distanceSquared: number;
    }> = [];
    const nearestDistanceSquared = (coordinates: number[][]) => {
      let best = Number.POSITIVE_INFINITY;
      const stride = Math.max(1, Math.floor(coordinates.length / 12));
      for (let index = 0; index < coordinates.length; index += stride) {
        const coordinate = coordinates[index];
        if (coordinate.length < 2) continue;
        const point = geoToLocalInto(
          coordinate[0],
          coordinate[1],
          scanCornerLow,
        );
        const dx = point.x - state.position.x;
        const dz = point.z - state.position.z;
        const distance = dx * dx + dz * dz;
        if (distance < best) best = distance;
      }
      return best;
    };
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
      const dedicated = isDedicatedFeature(feature);
      const lines =
        feature.geometry.type === 'LineString'
          ? [feature.geometry.coordinates as number[][]]
          : feature.geometry.type === 'MultiLineString'
            ? (feature.geometry.coordinates as number[][][])
            : [];
      for (const coordinates of lines) {
        if (coordinates.length < 2) continue;
        const distanceSquared = nearestDistanceSquared(coordinates);
        if (distanceSquared > 1_200 * 1_200) continue;
        candidates.push({ coordinates, dedicated, distanceSquared });
      }
    });
    candidates.sort(
      (a, b) =>
        Number(b.dedicated) - Number(a.dedicated) ||
        a.distanceSquared - b.distanceSquared,
    );
    for (const candidate of candidates) {
      if (pedestrianRoutes.length >= 80) break;
      acceptLine(candidate.coordinates, candidate.dedicated);
    }

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

    if (npcAssignmentsChanged)
      updateCrowdVisuals(crowdFleet, campusNpcs, 1, elapsedTime);
    return added > 0 || npcAssignmentsChanged;
  };

  const relocateNearbyCrowd = (force = false) => {
    if (guaranteedPedestrianRouteCount === 0 || campusNpcs.length === 0)
      return false;
    const crowdFocusX = state.position.x + state.forward.x * 12;
    const crowdFocusZ = state.position.z + state.forward.z * 12;
    const mappedWalkways = getMappedPedestrianWalkways();
    const dryRoutes = pedestrianRoutes.filter(
      (route) => !crowdRouteTouchesMappedWater(route),
    );
    const routes =
      !force && mappedWalkways.length > 0 ? mappedWalkways : dryRoutes;
    const changed = recycleDistantCrowd(
      routes,
      crowdFocusX,
      crowdFocusZ,
      force,
    );
    if (changed) updateCrowdVisuals(crowdFleet, campusNpcs, 1, elapsedTime);
    return changed;
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
      // Only the moment a moving car decides to brake is worth a tire squeal;
      // a car already stopped for the goose keeps yielding silently. A whole
      // lane braking together still gets one screech, not one per car.
      if (
        shouldYield &&
        !car.yielding &&
        car.speed > 3 &&
        elapsedTime - lastYieldScreech > 0.6
      ) {
        lastYieldScreech = elapsedTime;
        audio.screech();
      }
      car.yielding = shouldYield;
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
      if (
        horizontalDistance > 0.78 * modifiers.gooseScale ||
        vertical < -0.25 ||
        vertical > 1.85
      )
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
      // Every knockdown counts for the bowling quest, even the ones the score
      // cooldown declines to pay for.
      recordEvent({
        type: 'bowl',
        by: 'goose',
        airborne: state.mode === 'flying',
      });
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

  const awardChaos = (
    basePoints: number,
    label: string,
    options?: { id?: string; subject?: string },
  ) => {
    // The music dips under every trick call-out so the toast reads as an event.
    audio.music.duck();
    chaosComboEvents += 1;
    chaosCombo = Math.min(5, 1 + Math.floor((chaosComboEvents - 1) / 3));
    chaosComboRemaining = CHAOS_COMBO_SECONDS;
    const points = basePoints * chaosCombo;
    chaosScore += points;
    showScoreToast(
      `${label} · +${points}${chaosCombo > 1 ? ` · x${chaosCombo}` : ''}`,
    );
    // Labels carry counters ("×3", "SECRET 4/33"), so quests key off the id an
    // award site passes in; the slug is only the fallback for fixed labels.
    recordEvent(
      {
        type: 'trick',
        id: options?.id ?? slugifyLabel(label),
        label,
        points,
        combo: chaosCombo,
        mode: state.mode,
        speed: state.velocity.length(),
        agl: Math.max(0, state.position.y - state.ground),
        subject: options?.subject,
      },
      (saved) => {
        saved.lifetimeChaos += points;
        saved.bestScore = Math.max(saved.bestScore, chaosScore);
      },
    );
  };

  /**
   * Props stand on the highest surface under them, so a cone parked on a roof
   * stays on the roof instead of falling through it to the terrain.
   */
  const propGroundAt = (east: number, north: number, fallback: number) => {
    const base = Number.isFinite(fallback) ? fallback : state.ground;
    const terrain = terrainAt(east, north, base);
    const roof = highestRoofAt(east, north);
    return roof === null ? terrain : Math.max(terrain, roof);
  };

  /**
   * Push a prop back out of any building wall it is standing in. A prop that is
   * up on a roof is inside the footprint by definition, so anything at or above
   * roof height is left alone.
   */
  const resolvePropBuilding = (
    point: { x: number; y: number; z: number },
    radius: number,
  ) => {
    refreshActiveBuildingColliders();
    let pushed = false;
    for (const building of activeBuildingColliders) {
      if (
        point.x < building.minX - radius ||
        point.x > building.maxX + radius ||
        point.z < building.minZ - radius ||
        point.z > building.maxZ + radius
      )
        continue;
      if (point.y > building.ground + building.height - 0.5) continue;
      if (!pointInBuilding(point.x, point.z, building)) continue;
      const boundary = closestBuildingBoundary(point.x, point.z, building);
      // The point is inside, so boundary-to-point aims deeper in; stepping the
      // other way past the wall by a full radius sets the body clear of it.
      let inwardX = point.x - boundary.x;
      let inwardZ = point.z - boundary.z;
      const inwardLength = Math.hypot(inwardX, inwardZ);
      if (inwardLength < 1e-4) {
        inwardX = point.x - (building.minX + building.maxX) * 0.5;
        inwardZ = point.z - (building.minZ + building.maxZ) * 0.5;
        const centerLength = Math.hypot(inwardX, inwardZ);
        if (centerLength < 1e-4) {
          inwardX = 1;
          inwardZ = 0;
        } else {
          inwardX /= centerLength;
          inwardZ /= centerLength;
        }
      } else {
        inwardX /= inwardLength;
        inwardZ /= inwardLength;
      }
      point.x = boundary.x - inwardX * radius;
      point.z = boundary.z - inwardZ * radius;
      pushed = true;
    }
    return { pushed };
  };

  const propSystem: PropSystem = createPropSystem({
    scene,
    groundAt: propGroundAt,
    isWater: isPointInMappedWater,
    resolveBuilding: resolvePropBuilding,
    isRoad: nearTrafficCorridor,
    isTrafficLane: nearTrafficLaneCenter,
    awardChaos,
    recordEvent,
    shake: (seconds) => {
      cameraShakeRemaining = Math.max(cameraShakeRemaining, seconds);
    },
    isInView: (east, elevation, north) =>
      isPointInsideCameraView(east, elevation, north, 1.25),
  });
  // Reused every fixed step; the vectors are the live simulation state, which
  // is only ever written in place, so the probe never needs rebuilding.
  const goosePropProbe = {
    position: state.position,
    velocity: state.velocity,
    prevPosition: previousState.position,
    radius: 0.58,
    mode: state.mode,
  };
  const propPoiBuffer: PropPoi[] = [];
  const propPoiAnchor = new THREE.Vector2(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  let propPoiClock = 0;
  let propPoiScans = 0;

  /** OSM bicycle_parking becomes bike racks, waste_basket becomes trash cans. */
  const collectPropPois = (force = false) => {
    if (!map.getSource(poiSourceId)) return;
    if (
      !force &&
      // The first few scans of a life repeat while POI tiles are still
      // streaming in; after that a scan costs a rescan distance to earn.
      propPoiScans > 4 &&
      Math.hypot(
        state.position.x - propPoiAnchor.x,
        state.position.z - propPoiAnchor.y,
      ) < PROP_POI_RESCAN_DISTANCE
    )
      return;
    propPoiScans += 1;
    propPoiAnchor.set(state.position.x, state.position.z);
    const features = map.querySourceFeatures(poiSourceId, {
      sourceLayer: 'poi',
    }) as Array<{
      properties?: Record<string, unknown>;
      geometry: { type: string; coordinates: unknown };
    }>;
    propPoiBuffer.length = 0;
    const seen = new Set<string>();
    for (const feature of features) {
      if (feature.geometry.type !== 'Point') continue;
      const coordinates = feature.geometry.coordinates as number[];
      if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
      const subclass =
        feature.properties?.subclass ?? feature.properties?.class;
      const kind =
        subclass === 'bicycle_parking'
          ? 'bike'
          : subclass === 'waste_basket'
            ? 'trash'
            : null;
      if (!kind) continue;
      const local = geoToLocal(coordinates[0], coordinates[1]);
      if (
        Math.hypot(local.x - state.position.x, local.z - state.position.z) >
        PROP_POI_RADIUS
      )
        continue;
      const key = `${kind}:${local.x.toFixed(0)}:${local.z.toFixed(0)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      propPoiBuffer.push({ east: local.x, north: local.z, kind });
    }
    if (propPoiBuffer.length > 0) propSystem.spawnFromPois(propPoiBuffer);
  };

  // ---------------------------------------------------------------------
  // Campus clutter: props derived from the walkway and service-road network.
  // ---------------------------------------------------------------------
  // Hand-authoring furniture for every quad in Kalamazoo is not a plan, and a
  // campus with nothing loose on it is a campus with nothing to steal. These
  // read the same OSM lines the crowd already walks and line them with trash
  // cans, benches and the occasional roadworks cone row.

  const clutterBuffer: PropPoi[] = [];
  const clutterKeys = new Set<string>();
  const clutterAnchor = new THREE.Vector2(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  let clutterRouteGeneration = -1;
  const clutterPoint = new THREE.Vector3();
  const clutterDirection = new THREE.Vector3();

  /** Position and tangent at `distance` along a polyline, written in place. */
  const samplePolyline = (
    points: THREE.Vector3[],
    cumulative: number[],
    distance: number,
  ) => {
    const total = cumulative[cumulative.length - 1] ?? 0;
    const target = clamp(distance, 0, total);
    let index = 1;
    while (index < cumulative.length - 1 && cumulative[index] < target)
      index += 1;
    const startDistance = cumulative[index - 1];
    const segment = Math.max(cumulative[index] - startDistance, 0.001);
    const amount = (target - startDistance) / segment;
    clutterPoint.copy(points[index - 1]).lerp(points[index], amount);
    clutterDirection
      .copy(points[index])
      .sub(points[index - 1])
      .normalize();
  };

  /** Somewhere a prop can stand without being furniture in a traffic lane. */
  const clutterSpotBlocked = (east: number, north: number) =>
    isPointInMappedWater(east, north) ||
    nearTrafficCorridor(east, north, CLUTTER_ROAD_CLEARANCE) ||
    pointInsideAnyBuilding(east, north);

  const pushClutter = (kind: PropKind, east: number, north: number) => {
    // Same rounding the prop system keys POI spawns by, so a spot that two
    // overlapping walkway segments both nominate is only offered once.
    const key = `${kind}:${Math.round(east)}:${Math.round(north)}`;
    if (clutterKeys.has(key)) return false;
    clutterKeys.add(key);
    clutterBuffer.push({ east, north, kind });
    return true;
  };

  /**
   * Trash cans and benches along every mapped walkway, and a short cone row
   * beside each long service road. Recycled like any other POI prop: they are
   * spawned non-permanent, so walking away from a quad hands its budget to
   * the next one.
   */
  const collectWalkwayClutter = (force = false) => {
    if (pedestrianRoutes.length === 0 && trafficRoutes.length === 0) return;
    const movedFromAnchor =
      Math.hypot(
        state.position.x - clutterAnchor.x,
        state.position.z - clutterAnchor.y,
      ) >= CLUTTER_RESCAN_DISTANCE;
    if (
      !force &&
      !movedFromAnchor &&
      clutterRouteGeneration === pedestrianRouteGeneration
    )
      return;
    clutterAnchor.set(state.position.x, state.position.z);
    clutterRouteGeneration = pedestrianRouteGeneration;
    clutterBuffer.length = 0;
    clutterKeys.clear();

    // Whatever is left of the prop budget after the authored table and the
    // OSM POIs, minus a little headroom so a walkway can never crowd out the
    // furniture the placement table put next to the goose.
    const budget = Math.max(
      0,
      Math.min(
        WALKWAY_PROP_LIMIT,
        PROP_CAPACITY - propSystem.stats().props - CLUTTER_HEADROOM,
      ),
    );
    if (budget <= 0) return;

    for (const route of pedestrianRoutes) {
      if (!route.isMappedWalkway) continue;
      if (clutterBuffer.length >= WALKWAY_PROP_LIMIT) break;
      let side = 1;
      for (const [kind, spacing] of WALKWAY_CLUTTER_CADENCE) {
        for (
          let distance = spacing * 0.5;
          distance < route.total;
          distance += spacing
        ) {
          if (clutterBuffer.length >= WALKWAY_PROP_LIMIT) break;
          samplePolyline(route.points, route.cumulative, distance);
          // Right-hand normal of the tangent, flipped every prop so a walkway
          // reads as furnished on both sides rather than fenced on one.
          const east =
            clutterPoint.x + clutterDirection.z * WALKWAY_PROP_OFFSET * side;
          const north =
            clutterPoint.z - clutterDirection.x * WALKWAY_PROP_OFFSET * side;
          side = -side;
          if (
            Math.hypot(east - state.position.x, north - state.position.z) >
            PROP_POI_RADIUS
          )
            continue;
          if (clutterSpotBlocked(east, north)) continue;
          pushClutter(kind, east, north);
        }
      }
    }

    let coneRows = 0;
    for (const route of trafficRoutes) {
      if (coneRows >= SERVICE_CONE_ROW_LIMIT) break;
      if (route.roadClass !== 'service') continue;
      if (route.total < SERVICE_CONE_MIN_LENGTH) continue;
      samplePolyline(route.points, route.cumulative, route.total * 0.5);
      if (
        Math.hypot(
          clutterPoint.x - state.position.x,
          clutterPoint.z - state.position.z,
        ) > SERVICE_CONE_RADIUS
      )
        continue;
      // Always the same side of the line, because roadworks coning off half a
      // service drive is the look; scattering them reads as litter.
      const shoulder = route.laneWidth + SERVICE_CONE_SHOULDER;
      const start =
        route.total * 0.5 -
        (SERVICE_CONE_COUNT - 1) * 0.5 * SERVICE_CONE_SPACING;
      let placed = 0;
      for (let index = 0; index < SERVICE_CONE_COUNT; index += 1) {
        samplePolyline(
          route.points,
          route.cumulative,
          start + index * SERVICE_CONE_SPACING,
        );
        const east = clutterPoint.x + clutterDirection.z * shoulder;
        const north = clutterPoint.z - clutterDirection.x * shoulder;
        if (isPointInMappedWater(east, north)) continue;
        if (pointInsideAnyBuilding(east, north)) continue;
        if (
          nearCrossingTrafficCorridor(
            route,
            east,
            north,
            CLUTTER_ROAD_CLEARANCE,
          )
        )
          continue;
        if (pushClutter('cone', east, north)) placed += 1;
      }
      if (placed > 0) coneRows += 1;
    }

    if (clutterBuffer.length === 0) return;
    // Nearest first, then cut to the budget: whichever spots are closest to
    // the goose are the ones worth spending the remaining bodies on, and the
    // prop system evicts the farthest body when it is full anyway.
    clutterBuffer.sort(
      (a, b) =>
        Math.hypot(a.east - state.position.x, a.north - state.position.z) -
        Math.hypot(b.east - state.position.x, b.north - state.position.z),
    );
    propSystem.spawnFromPois(
      clutterBuffer.length > budget
        ? clutterBuffer.slice(0, budget)
        : clutterBuffer,
    );
  };

  /** Everything the world streams into the prop system, in one call. */
  const collectStreamedProps = (force = false) => {
    collectPropPois(force);
    collectWalkwayClutter(force);
  };

  const refreshProps = (focusX: number, focusZ: number) => {
    propSystem.spawnFromPlacements(PROP_PLACEMENTS, authoredToLocal, {
      x: focusX,
      z: focusZ,
    });
    collectStreamedProps(true);
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

  /**
   * Light a secret up as found. `silent` is the restore path: no score, no
   * toast, and the activation clock starts past every intro animation so a
   * secret from the save looks like one you found ages ago.
   */
  const markSecretFound = (secret: CampusSecret, silent = false) => {
    if (secret.found) return false;
    secret.found = true;
    secret.activation = silent ? 12 : 0;
    secret.honkCount = 0;
    secret.honkWindow = 0;
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
    return true;
  };

  const discoverSecret = (
    secret: CampusSecret,
    points: number,
    label: string,
  ) => {
    if (!markSecretFound(secret)) return;
    awardChaos(
      points,
      `${label} · SECRET ${secretsFound}/${campusSecrets.length}`,
      { id: secret.id, subject: secret.id },
    );
    recordEvent(
      {
        type: 'secret',
        id: secret.id,
        label: secret.group.name,
        found: secretsFound,
        total: campusSecrets.length,
      },
      (saved) => {
        if (!saved.secretsFound.includes(secret.id))
          saved.secretsFound = [...saved.secretsFound, secret.id];
      },
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
          definition.trigger !== 'multi-honk' &&
          definition.trigger !== 'water-honk'
        )
          return;
        const landedOnWater =
          state.onWater &&
          (state.mode === 'swimming' || state.mode === 'planing');
        if (definition.trigger === 'water-honk' && !landedOnWater) {
          // Queued at score priority for the same reason as the honk counters
          // below: the crowd award for this very honk gets the slot first.
          queueScoreToast(`${definition.label} · land on the lake and honk`);
          return;
        }
        if (secret.honkWindow <= 0) secret.honkCount = 0;
        secret.honkCount += 1;
        secret.honkWindow = definition.id === 'student-megaphone' ? 7 : 4;
        if (secret.honkCount < definition.requiredHonks) {
          // The same honk that advances this counter usually scatters the
          // crowd, and that award's score toast is written first: an info
          // toast landing behind it is dropped by the HUD, which loses the
          // player's only feedback that the secret is counting. Queue it at
          // score priority so it waits its turn instead of vanishing.
          queueScoreToast(
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
          queueScoreToast(
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
        const elevation = queryGroundElevation(
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
          secret.shown = playing;
          applySecretVisibility(secret);
        } else {
          secret.terrainRefreshRemaining = 0.52 + (secretIndex % 4) * 0.09;
          if (!secret.terrainResolved) {
            secret.shown = false;
            applySecretVisibility(secret);
          }
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
        // Bronco Goose: the horse's leash follows the goose instead of its
        // authored spawn (Phase 4: mutators).
        if (modifiers.broncoFollows)
          broncoHome.set(state.position.x, state.position.z);
        const homeX = broncoHome.x - secret.group.position.x;
        const homeZ = broncoHome.y - secret.group.position.z;
        const homeDistance = Math.hypot(homeX, homeZ);
        if (homeDistance > (modifiers.broncoFollows ? 12 : 68)) {
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

        const horseSpeed = modifiers.broncoFollows
          ? 6
          : secret.found
            ? 4.8
            : 3.15;
        secret.group.position.x += Math.sin(broncoHeading) * horseSpeed * dt;
        secret.group.position.z += Math.cos(broncoHeading) * horseSpeed * dt;
        if (broncoTerrainRemaining <= 0) {
          broncoTerrainRemaining = 0.28;
          const elevation = queryGroundElevation(
            localToLngLat(secret.group.position.x, secret.group.position.z),
          );
          if (
            typeof elevation === 'number' &&
            isUsableTerrainElevation(elevation)
          ) {
            broncoGround = elevation;
            secret.terrainResolved = true;
            secret.shown = playing;
            applySecretVisibility(secret);
          } else if (!secret.terrainResolved) {
            secret.shown = false;
            applySecretVisibility(secret);
          }
        }
        secret.group.position.y = broncoGround + secret.altitude;
        secret.group.userData.baseY = secret.group.position.y;
        secret.group.rotation.y = broncoHeading;
        secret.position.copy(secret.group.position);
        if (modifiers.broncoFollows)
          trampleNearbyCrowd(secret, broncoHeading, horseSpeed);
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

  /**
   * Drops secret groups the goose is nowhere near out of the render list.
   * Only the group flag moves: positions, discovery radii and the terrain
   * chase in updateCampusSecrets all keep running for every secret, so a
   * secret that comes back into range is exactly where it would have been.
   */
  const refreshSecretRange = () => {
    const radiusSquared = SECRET_VISIBLE_RADIUS ** 2;
    for (const secret of campusSecrets) {
      const dx = secret.position.x - state.position.x;
      const dz = secret.position.z - state.position.z;
      const inRange = dx * dx + dz * dz <= radiusSquared;
      if (inRange === secret.inRange) continue;
      secret.inRange = inRange;
      applySecretVisibility(secret);
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
    audio.honk(megaHonkRemaining > 0);
    const agl = state.position.y - state.ground;
    const baseRadius = state.mode === 'flying' && agl < 20 ? 34 : 26;
    const radius =
      baseRadius *
      (megaHonkRemaining > 0 ? 2.4 : 1) *
      modifiers.honkRadiusScale;
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
    // Every car in the wave brakes for the goose, whether or not it still owes
    // points; the traffic quest counts stopped cars, not scored ones.
    const carsStopped = nearby.length;
    // Party Goose: students dance instead of scattering (Phase 4: mutators).
    const crowdReaction =
      modifiers.honkStyle === 'party'
        ? partyCampusCrowd(radius, true)
        : terrorizeCampusCrowd(radius, true);
    const recruitedGeese = recruitNearbyFlock(true);
    if (scoredCars > 0 || crowdReaction.scored > 0) {
      const totalTargets = scoredCars + crowdReaction.scored;
      const [label, id] =
        modifiers.honkStyle === 'party' && crowdReaction.scored > 0
          ? [`DANCE PARTY ×${crowdReaction.scored}`, 'dance-party']
          : scoredCars > 0 && crowdReaction.scored > 0
            ? [`CAMPUS PANIC ×${totalTargets}`, 'campus-panic']
            : crowdReaction.scored > 0
              ? [`HONK PANIC ×${crowdReaction.scored}`, 'honk-panic']
              : scoredCars >= 2
                ? [`HONK CHAIN ×${scoredCars}`, 'honk-chain']
                : ['HONK IF YOU YIELD', 'honk-if-you-yield'];
      awardChaos(50 * scoredCars + 35 * crowdReaction.scored, label, { id });
    } else if (crowdReaction.panicked > 0) {
      hooks.onToast(
        modifiers.honkStyle === 'party'
          ? `HONK! · ${crowdReaction.panicked} students started dancing`
          : `HONK! · ${crowdReaction.panicked} students scattered`,
      );
    } else if (recruitedGeese === 0 && !firstHonkAcknowledged) {
      // The ring, the sound, and the button state already confirm every honk.
      // A bare "HONK!" toast on each press kept overwriting score and secret
      // toasts, so only the first quiet honk of a session gets one.
      firstHonkAcknowledged = true;
      hooks.onToast('HONK! · nobody around to hear it');
    }
    recordEvent({
      type: 'honk',
      scattered: crowdReaction.panicked,
      carsStopped,
      airborne: state.mode === 'flying',
      mega: megaHonkRemaining > 0,
    });
    registerSecretHonk();
  };

  /**
   * Phase 5: hit-stop. A big impact drops the simulation to a third speed for
   * a beat so the player can read what just happened, then eases back. Only
   * collisions worth watching qualify, and only when the player left the
   * setting on; anything softer would turn ordinary flying into slow motion.
   */
  const triggerHitStop = (severity: number) => {
    if (!slowMotionEnabled || severity <= HIT_STOP_MIN_SEVERITY) return;
    slowMotionRemaining = HIT_STOP_SECONDS;
  };

  const updateTimeScale = () => {
    timeScale =
      slowMotionRemaining <= 0
        ? 1
        : slowMotionRemaining > HIT_STOP_RELEASE_SECONDS
          ? HIT_STOP_SCALE
          : lerp(
              1,
              HIT_STOP_SCALE,
              slowMotionRemaining / HIT_STOP_RELEASE_SECONDS,
            );
  };

  /**
   * Phase 5: KeyR keeps the goose limp for as long as it is held. It re-arms
   * the tumble every step instead of setting a long one, so letting go decays
   * through the ordinary tumble path rather than snapping upright.
   */
  const updateRagdollKey = () => {
    if (!keys.has('KeyR')) {
      ragdollLatched = false;
      ragdollSplashLatched = false;
      return;
    }
    if (!ragdollHintShown) {
      ragdollHintShown = true;
      queueInfoToast('RAGDOLL · hold R to stay limp');
    }
    // On water a limp goose is just a floating goose, so the key answers with
    // a splash and nothing else: that is how a player learns it is a move for
    // land and air.
    if (state.mode === 'swimming' || state.mode === 'planing') {
      ragdollLatched = false;
      if (!ragdollSplashLatched) {
        ragdollSplashLatched = true;
        audio.splash(0.2);
      }
      return;
    }
    ragdollSplashLatched = false;
    if (!ragdollLatched) {
      ragdollLatched = true;
      // Seed the spin from how fast the goose was going, so bailing out of a
      // dive whips around and bailing out of a waddle flops over.
      tumbleAngularSpeed =
        Math.max(RAGDOLL_MIN_SPIN, state.velocity.length() * 0.9) *
        (state.bank >= 0 ? 1 : -1);
    }
    tumbleRemaining = Math.max(tumbleRemaining, RAGDOLL_HOLD_SECONDS);
  };

  const updateChaosTimers = (dt: number) => {
    honkCooldown = Math.max(0, honkCooldown - dt);
    slowMotionRemaining = Math.max(0, slowMotionRemaining - dt);
    updateTimeScale();
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
        recordEvent({ type: 'infamy' });
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
            applyInfamyReaction(npc);
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
      flightTopSpeed = Math.max(flightTopSpeed, state.velocity.length());
    }
  };

  const simulateTumble = (dt: number) => {
    state.velocity.y -=
      FLIGHT.gravity *
      0.75 *
      Math.min(lowGravityRemaining > 0 ? 0.42 : 1, modifiers.gravityScale) *
      dt;
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
    const radius =
      (state.mode === 'flying' ? 0.68 : 0.58) * modifiers.gooseScale;
    const gooseHeight = 0.92;

    let roofLanding: {
      roof: number;
      east: number;
      north: number;
      time: number;
      key: string;
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
        roofLanding = { roof, east, north, time, key: building.sourceKey };
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
        // The footprint key is the roof's identity, so "ten different roofs"
        // cannot be farmed by bouncing on one of them.
        if (impact > 5) {
          tumbleRemaining = 0.7;
          tumbleAngularSpeed = 10;
          cameraShakeRemaining = 0.24;
          audio.thud(0.8);
          triggerHitStop(0.8);
          awardChaos(180, 'ROOFTOP PANCAKE', { subject: roofLanding.key });
        } else {
          audio.thud(0.3);
          awardChaos(220, 'ROOFTOP LANDING', { subject: roofLanding.key });
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
      // A waddling goose steps onto a lip no taller than a curb instead of
      // being walled by it. One roof is several tile chunks, each drawn at
      // its own centroid elevation, so on a slope neighbouring chunks sit a
      // few tens of centimetres apart; MapLibre draws that lip and the goose
      // should hop it, not bounce off it.
      if (
        state.mode === 'waddling' &&
        tumbleRemaining <= 0 &&
        roof > state.position.y &&
        roof - state.position.y <= STEP_UP_HEIGHT
      ) {
        if (inside) {
          state.position.y = roof + 0.04;
          state.ground = roof;
          buildingContactThisStep = true;
        }
        continue;
      }
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
        audio.thud(severity);
        triggerHitStop(severity);
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
          awardChaos(200, 'ARCHITECTURAL CRITIQUE', {
            subject: building.sourceKey,
          });
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
        // Same curb rule as above: a lip a waddling goose can step onto is
        // not a wall to be pushed off, or it could never reach the step.
        if (
          state.mode === 'waddling' &&
          tumbleRemaining <= 0 &&
          roof - state.position.y <= STEP_UP_HEIGHT
        ) {
          if (inside) {
            state.position.y = roof + 0.04;
            state.ground = roof;
            buildingContactThisStep = true;
          }
          continue;
        }
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
      const elevation = queryGroundElevation(
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
    state.onWater =
      roof === null && isPointInMappedWater(state.position.x, state.position.z);
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
        Math.abs(localX) < 1.25 * modifiers.gooseScale &&
        Math.abs(localZ) < 2.45 * modifiers.gooseScale &&
        vertical > -0.2 &&
        vertical < 1.65;

      if (overlaps && hitCooldown <= 0 && car.collisionCooldown <= 0) {
        const carVelocity = car.direction.clone().multiplyScalar(car.speed);
        const relativeSpeed = state.velocity.clone().sub(carVelocity).length();
        const severity = clamp((relativeSpeed - 1.5) / 8, 0.15, 1);
        const normal = new THREE.Vector3(dx, 0, dz);
        if (normal.lengthSq() < 0.01) normal.set(rightX, 0, rightZ);
        normal.normalize();
        // Giga Goose out-masses the car: it eats the impulse instead of the
        // goose (Phase 4: mutators).
        const gigaBounce = modifiers.gooseScale >= 2;
        applyTrafficImpact(car, normal, severity, localX, gigaBounce);
        audio.thud(severity);
        audio.screech();
        // ROAD HOG is the Giga Goose payoff shot, so it always earns the
        // slow motion beat even when the closing speed was gentle.
        triggerHitStop(gigaBounce ? 0.9 : severity);
        hitCooldown = 1;
        cameraShakeRemaining = lerp(0.12, 0.32, severity);
        queuedFlaps = 0;
        car.collisionCooldown = 5;
        car.reactionRemaining = Math.max(car.reactionRemaining, 1.8);
        car.wobbleRemaining = Math.max(car.wobbleRemaining, 1.4);
        if (gigaBounce) {
          awardChaos(240, 'ROAD HOG', {
            id: 'road-hog',
            subject: String(car.index),
          });
        } else {
          awardChaos(
            state.mode === 'flying' ? 225 : 200,
            state.mode === 'flying' ? 'AIRBORNE CAR BOP' : 'INSURANCE FRAUD',
            { subject: String(car.index) },
          );
        }
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
    // One wingbeat, one sound: this is the single place a beat starts.
    audio.flap();
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
      if (!takeoffHintShown) {
        takeoffHintShown = true;
        hooks.onToast('Wingbeat · you are airborne');
      }
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
      hooks.onToast('Planing complete · now swimming');
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

  /** The footprint key of the roof the goose is standing on, or null. */
  const roofKeyUnderGoose = () => {
    refreshActiveBuildingColliders();
    for (const building of activeBuildingColliders) {
      const roof = building.ground + building.height;
      if (Math.abs(roof - state.ground) > 0.3) continue;
      if (
        state.position.x < building.minX ||
        state.position.x > building.maxX ||
        state.position.z < building.minZ ||
        state.position.z > building.maxZ ||
        !pointInBuilding(state.position.x, state.position.z, building)
      )
        continue;
      return building.sourceKey;
    }
    return null;
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
      announceJetstream();
    } else if (agl < ALTITUDE_BOOST_RELEASE_HEIGHT) {
      altitudeBoostActive = false;
    }
    altitudeBoostRamp = altitudeBoostActive
      ? Math.min(1, altitudeBoostRamp + dt / ALTITUDE_BOOST_RAMP_IN)
      : Math.max(0, altitudeBoostRamp - dt / ALTITUDE_BOOST_RAMP_OUT);
    const altitudeBoost = altitudeBoostStrength(
      altitudeBoostRamp,
      modifiers.jetstreamAlways,
    );
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
    const stallStart =
      (state.alpha >= 0 ? FLIGHT.alphaStall : 13 * DEG) * heldStallPenalty();
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
    // Angel Goose's gravityScale combines with the low-gravity power-up by
    // taking whichever makes the goose float more (the smaller multiplier).
    const gravityScale = Math.min(
      lowGravityRemaining > 0 ? 0.42 : 1,
      modifiers.gravityScale,
    );
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
        (elapsed < DOWNSTROKE
          ? Math.sin((Math.PI * elapsed) / DOWNSTROKE)
          : 0) * modifiers.flapPowerScale;
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
      const boostedCruise = lerp(
        BASE_CRUISE_SPEED,
        ALTITUDE_BOOST_CRUISE_SPEED,
        altitudeBoost,
      );
      if (horizontalSpeed < boostedCruise) {
        const addedSpeed = Math.min(
          boostedCruise - horizontalSpeed,
          ALTITUDE_BOOST_ACCELERATION * altitudeBoost * dt,
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
    const maximumSpeed =
      lerp(BASE_MAX_FLIGHT_SPEED, ALTITUDE_BOOST_MAX_SPEED, altitudeBoost) *
      heldMassPenalty() *
      modifiers.topSpeedScale;
    if (state.velocity.length() > maximumSpeed)
      state.velocity.setLength(maximumSpeed);
    state.position.addScaledVector(state.velocity, dt);

    // Reclassify the actual touchdown position after moving. A fast descent
    // can cross a bank between the regular surface samples.
    if (
      state.position.y - state.ground <
      Math.max(3, -state.velocity.y * dt + 0.25)
    )
      sampleSurface();

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
              ? 'Clean water landing · splash!'
              : `Big splash · ${flareHint} before touchdown`,
          );
        }
      } else if (roofKeyUnderGoose() !== null) {
        // sampleSurface folds a roof into state.ground once the goose is
        // within 12 cm of it, so most rooftop touchdowns resolve here rather
        // than in resolveBuildingInteractions' plane-crossing test. Award them
        // as roofs, or every roof landing reads as a LAWN DART on the lawn.
        const roofKey = roofKeyUnderGoose() ?? '';
        if (buildingHitCooldown <= 0) {
          buildingHitCooldown = 1.2;
          if (impact > 5) {
            audio.thud(0.8);
            triggerHitStop(0.8);
            awardChaos(180, 'ROOFTOP PANCAKE', { subject: roofKey });
          } else {
            audio.thud(0.3);
            awardChaos(220, 'ROOFTOP LANDING', { subject: roofKey });
          }
        }
      } else {
        if (landingCounts) {
          if (
            impact < 2 &&
            bankDegrees < 15 &&
            landingSpeed >= 8 &&
            landingSpeed <= 17
          ) {
            // A greased landing is silent on purpose: the reward for nailing
            // it is that nothing goes crunch.
            awardChaos(250, 'GREASED LANDING');
          } else if (impact > 4.5) {
            audio.thud(0.9);
            triggerHitStop(0.9);
            awardChaos(300, 'LAWN DART');
          } else {
            audio.thud(0.35);
            awardChaos(100, 'TOUCHDOWN-ISH');
          }
        } else {
          hooks.onToast(
            impact < 2.4
              ? 'Touchdown · now waddle'
              : `Bumpy landing · ${flareHint} to soften it`,
          );
        }
      }
      if (!state.onWater && impact > 4.5) {
        // Shortened from 0.82: QA found the old tumble outlasted the player's
        // patience, and a queued Space tap now waits it out to take off.
        tumbleRemaining = 0.6;
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

  /**
   * One flight event per touchdown, wherever the landing came from: a flare, a
   * roof, or a tumble that ran out of sky. Watching the mode transition catches
   * all three without threading a report through each landing branch.
   */
  const finishFlightIfLanded = () => {
    if (previousState.mode === 'flying' || state.mode === 'flying') {
      flightMeters += Math.hypot(
        state.position.x - previousState.position.x,
        state.position.z - previousState.position.z,
      );
    }
    if (previousState.mode !== 'flying' || state.mode === 'flying') return;
    const seconds = airborneTime;
    const meters = flightMeters;
    const flightPeakAgl = peakAgl;
    const topSpeed = flightTopSpeed;
    airborneTime = 0;
    peakAgl = 0;
    flightMeters = 0;
    flightTopSpeed = 0;
    // Hops off a curb are not flights.
    if (seconds < 0.5) return;
    const roof = highestRoofAt(
      state.position.x,
      state.position.z,
      state.position.y + 0.2,
    );
    recordEvent({
      type: 'flight',
      seconds,
      meters,
      peakAgl: flightPeakAgl,
      topSpeed,
      surface: roof !== null ? 'roof' : state.onWater ? 'water' : 'ground',
    });
  };

  // =========================================================================
  // Phase 3: grab and steal
  //
  // Deliberately one block. The grab key, whatever is in the beak, the throw,
  // student items and the chase after a theft all live here, so the rest of the
  // engine only carries single-line hooks into it: setKey queues a grab,
  // simulate runs updateGrabAndSteal, simulateFlight asks what the load costs,
  // emitTelemetry reads the label, placeGoose lets go, and
  // setGameplayVisibility hides the meshes.
  // =========================================================================

  /** Reach from the beak point, before the goose scale multiplies it. */
  const GRAB_REACH = 1.4;
  /** createGooseRig ships the rig at this scale; a giga goose reaches further. */
  const RIG_BASE_SCALE = 0.4;
  /** How far ahead of the beak a carried thing rides. */
  const HOLD_LEAD = 0.35;
  /**
   * Critically damped spring on the hold point: carried, not welded on. Stiff
   * enough that a takeoff does not leave the load a meter behind the beak.
   */
  const HOLD_STIFFNESS = 24;
  /** Head droop while carrying, in radians. */
  const HOLD_HEAD_TILT = 0.25;
  /**
   * Benches, signs and bike racks. At or above this mass a load spoils the
   * flight envelope; above it, a grounded goose cannot keep hold at all.
   */
  const HEAVY_PROP_MASS = 12;
  const TOO_HEAVY_GROUND_SECONDS = 3;
  /** Held-load penalties: top speed and how early the wing lets go. */
  const HEAVY_SPEED_PENALTY = 0.6;
  const HEAVY_STALL_PENALTY = 0.7;
  const THROW_FORWARD = 6;
  const THROW_UP = 2.5;
  /** A flying goose throws harder; it has a wing to put behind it. */
  const FLYING_THROW_SCALE = 1.3;
  const FASTBALL_SPEED = 8;
  /** Below this a release is a drop, not a throw, and nothing is announced. */
  const THROW_EVENT_SPEED = 3;
  const ITEM_FLIGHT_SECONDS = 6;
  const CHASE_CATCH_DISTANCE = 0.9;
  /**
   * The double take. A theft happens inside arm's reach, so without a moment
   * where the student is still working out what just happened there would be no
   * theft at all: the catch would land in the same second as the grab.
   */
  const CHASE_REACTION_SECONDS = 1.2;
  const CHASE_ESCAPE_DISTANCE = 25;
  const CHASE_ESCAPE_ALTITUDE = 6;
  const CHASE_ESCAPE_SECONDS = 2;
  /** Beak tip in rig-local space; the root scale turns it into meters. */
  const BEAK_LOCAL = new THREE.Vector3(0, 1.66, 0.95);

  const PROP_NAMES: Record<PropKind, string> = {
    cone: 'cone',
    bench: 'bench',
    trash: 'trash can',
    bike: 'bike',
    sign: 'sign',
    flag: 'flag',
  };
  const ITEM_NAMES: Record<ItemKind, string> = {
    phone: 'phone',
    coffee: 'coffee',
    sandwich: 'sandwich',
    'id-card': 'ID card',
    umbrella: 'umbrella',
  };
  type TheftAward = { points: number; label: string; id: string };
  /** Anything without a headline of its own is plain old petty theft. */
  const PETTY_THEFT: TheftAward = {
    points: 150,
    label: 'PETTY THEFT',
    id: 'petty-theft',
  };
  const THEFT_AWARDS: Partial<Record<ItemKind, TheftAward>> = {
    phone: { points: 170, label: 'DOOMSCROLL DENIED', id: 'doomscroll-denied' },
    coffee: { points: 180, label: 'CAFFEINE HEIST', id: 'caffeine-heist' },
    sandwich: { points: 160, label: 'LUNCH MONEY', id: 'lunch-money' },
    'id-card': { points: 260, label: 'IDENTITY THEFT', id: 'identity-theft' },
    umbrella: { points: 140, label: 'RAIN CHECK', id: 'rain-check' },
  };

  type HeldObject =
    | { target: 'prop'; id: string; kind: PropKind; mass: number }
    | { target: 'item'; kind: ItemKind; mesh: THREE.Mesh };
  type ThrownItem = {
    kind: ItemKind;
    mesh: THREE.Mesh;
    velocity: THREE.Vector3;
    spin: THREE.Vector3;
    age: number;
    ground: number;
    groundRefresh: number;
    resting: boolean;
  };
  /** One theft in flight: who is chasing, for what, and how it ends. */
  type ItemChase = {
    npc: CampusNpc;
    item: ItemKind;
    remaining: number;
    airborneTime: number;
    resolved: boolean;
  };

  let held: HeldObject | null = null;
  let grabQueued = false;
  /** How long a heavy load has been dragged around on foot. */
  let heldGroundSeconds = 0;
  const itemChases: ItemChase[] = [];
  const thrownItems: ThrownItem[] = [];
  const beakPoint = new THREE.Vector3();
  const holdPoint = new THREE.Vector3();
  const holdIdeal = new THREE.Vector3();
  const holdVelocity = new THREE.Vector3();
  const springDelta = new THREE.Vector3();
  const springTemp = new THREE.Vector3();
  const grabScratch = new THREE.Vector3();
  const releaseVelocity = new THREE.Vector3();

  // Held and thrown items are plain meshes, not props: a stolen phone has no
  // business waking the rigid body system up for six seconds of arc.
  const itemGeometries = new Map<ItemKind, THREE.BufferGeometry>();
  const itemMeshPool = new Map<ItemKind, THREE.Mesh[]>();
  const heldItemMaterial = createCampusItemMaterial();

  const takeItemMesh = (kind: ItemKind) => {
    const pooled = itemMeshPool.get(kind)?.pop();
    if (pooled) {
      pooled.visible = playing;
      return pooled;
    }
    let geometry = itemGeometries.get(kind);
    if (!geometry) {
      geometry = buildCampusItemGeometry(kind);
      itemGeometries.set(kind, geometry);
    }
    const mesh = new THREE.Mesh(geometry, heldItemMaterial);
    mesh.name = `Stolen item (${kind})`;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = playing;
    scene.add(mesh);
    return mesh;
  };

  const returnItemMesh = (kind: ItemKind, mesh: THREE.Mesh) => {
    mesh.visible = false;
    mesh.rotation.set(0, 0, 0);
    const pool = itemMeshPool.get(kind);
    if (pool) pool.push(mesh);
    else itemMeshPool.set(kind, [mesh]);
  };

  /** 1 at the authored size; a mutator that scales the goose scales its reach. */
  const gooseScaleFactor = () => {
    const scale = goose.root.scale.x;
    return Number.isFinite(scale) && scale > 0.01 ? scale / RIG_BASE_SCALE : 1;
  };

  const updateBeakPoint = () => {
    goose.root.updateMatrixWorld();
    beakPoint.copy(BEAK_LOCAL).applyMatrix4(goose.root.matrixWorld);
  };

  /** Where the beak wants a carried thing to sit, a little way out in front. */
  const updateHoldIdeal = () => {
    grabScratch.copy(state.forward);
    if (grabScratch.lengthSq() < 1e-6)
      grabScratch.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    grabScratch.normalize();
    holdIdeal
      .copy(beakPoint)
      .addScaledVector(grabScratch, HOLD_LEAD * gooseScaleFactor());
  };

  const springHoldPoint = (dt: number) => {
    // Textbook critically damped step, so the load trails the beak through a
    // turn and settles without ever overshooting into the goose.
    const decay = Math.exp(-HOLD_STIFFNESS * dt);
    springDelta.copy(holdPoint).sub(holdIdeal);
    springTemp
      .copy(holdVelocity)
      .addScaledVector(springDelta, HOLD_STIFFNESS)
      .multiplyScalar(dt);
    holdVelocity
      .addScaledVector(springTemp, -HOLD_STIFFNESS)
      .multiplyScalar(decay);
    holdPoint
      .copy(holdIdeal)
      .addScaledVector(springDelta.add(springTemp), decay);
  };

  /** A heavy load caps top speed; cones, flags and stolen lunches do not. */
  const carryingHeavyProp = () =>
    held?.target === 'prop' && held.mass >= HEAVY_PROP_MASS;
  const heldMassPenalty = () => (carryingHeavyProp() ? HEAVY_SPEED_PENALTY : 1);
  const heldStallPenalty = () =>
    carryingHeavyProp() ? HEAVY_STALL_PENALTY : 1;

  const heldLabel = () => (held ? held.kind : null);

  // The HUD does not mirror `holding` yet, so the engine publishes it on the
  // map container the way the prop counters were published before the HUD
  // picked those up. The steal target rides along because the harness has no
  // other way to see a student worth robbing: telemetry reports how far the
  // nearest one is, never which way. Both go away once data-holding lands on
  // the shell and the crowd is readable some better way.
  const mirrorHost = map.getContainer();
  const setMirror = (name: string, value: string) => {
    if (mirrorHost.dataset[name] !== value) mirrorHost.dataset[name] = value;
  };
  // Some readouts are engine-only: no HUD prop carries them, so they are
  // written straight onto the shell the harness reads its data attributes
  // from. React never diffs an attribute it does not render, so writing here
  // cannot fight the HUD.
  let shellHost: HTMLElement | null = null;
  const setShellMirror = (name: string, value: string) => {
    shellHost ??= mirrorHost.closest('main.game-shell');
    if (shellHost && shellHost.dataset[name] !== value) {
      shellHost.dataset[name] = value;
    }
  };
  const mirrorHarnessAttributes = () => {
    setMirror('holding', heldLabel() ?? '');
    let target: CampusNpc | null = null;
    let targetDistance = Number.POSITIVE_INFINITY;
    for (const npc of campusNpcs) {
      if (!npc.item) continue;
      if (npc.mode === 'ragdoll' || npc.mode === 'recover') continue;
      const distance = Math.hypot(
        npc.position.x - state.position.x,
        npc.position.z - state.position.z,
      );
      if (distance >= targetDistance) continue;
      targetDistance = distance;
      target = npc;
    }
    setMirror('stealTargetItem', target?.item ?? '');
    setMirror('stealTargetEast', target ? target.position.x.toFixed(2) : '');
    setMirror('stealTargetNorth', target ? target.position.z.toFixed(2) : '');
    // Phase 5 readouts are mirrored here as well as reported as telemetry, so
    // the harness can watch a ragdoll and a hit-stop without waiting for the
    // HUD to publish them on the shell.
    setMirror('ragdolling', tumbleRemaining > 0 ? 'true' : 'false');
    setMirror('timeScale', timeScale.toFixed(3));
    const resolvedBuildings = String(resolvedBuildingColliderCount());
    setMirror('buildingsResolved', resolvedBuildings);
    setShellMirror('buildingsResolved', resolvedBuildings);
  };

  /**
   * The closest student still carrying something. The aim point is the middle
   * of the body at hand height rather than the hand itself: the hand swings
   * through a third of a meter with the gait, and a grab that depended on gait
   * phase would read as broken rather than as skilful.
   */
  const nearestStudentWithItem = (reach: number) => {
    let best: CampusNpc | null = null;
    let bestDistance = reach * reach;
    for (const npc of campusNpcs) {
      if (!npc.item) continue;
      if (npc.mode === 'ragdoll' || npc.mode === 'recover') continue;
      const dx = npc.position.x - beakPoint.x;
      const dy = npc.ground + 1.05 * npc.heightScale - beakPoint.y;
      const dz = npc.position.z - beakPoint.z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared >= bestDistance) continue;
      bestDistance = distanceSquared;
      best = npc;
    }
    return best;
  };

  const beginHold = () => {
    updateHoldIdeal();
    holdPoint.copy(holdIdeal);
    holdVelocity.set(0, 0, 0);
    heldGroundSeconds = 0;
  };

  const stealItem = (npc: CampusNpc, item: ItemKind) => {
    npc.item = null;
    beginHold();
    const mesh = takeItemMesh(item);
    mesh.position.copy(holdPoint);
    held = { target: 'item', kind: item, mesh };
    const award = THEFT_AWARDS[item] ?? PETTY_THEFT;
    awardChaos(award.points, award.label, { id: award.id });
    // The grab is reported now; the steal waits for the chase to end, so a
    // quest counting uncaught thefts never has to unlearn one.
    recordEvent({ type: 'grab', target: 'item', kind: item });
    if (startCampusNpcChase(npc)) {
      itemChases.push({
        npc,
        item,
        remaining: CAMPUS_CHASE_SECONDS,
        airborneTime: 0,
        resolved: false,
      });
    } else {
      recordEvent({ type: 'steal', item, caught: false });
    }
  };

  const tryGrab = () => {
    if (held) return;
    updateBeakPoint();
    const reach = GRAB_REACH * gooseScaleFactor();
    const victim = nearestStudentWithItem(reach);
    // Students first: reaching past a cone for a coffee is the better joke.
    if (victim?.item) {
      stealItem(victim, victim.item);
      return;
    }
    const propId = propSystem.nearest(beakPoint, reach);
    if (!propId) return;
    const description = propSystem.describe(propId);
    if (!description) return;
    beginHold();
    if (!propSystem.hold(propId, holdPoint)) return;
    held = {
      target: 'prop',
      id: propId,
      kind: description.kind,
      mass: description.mass,
    };
    hooks.onToast(`Grabbed: ${PROP_NAMES[description.kind]}`);
    recordEvent({ type: 'grab', target: 'prop', kind: description.kind });
  };

  const spawnThrownItem = (
    kind: ItemKind,
    mesh: THREE.Mesh,
    velocity: THREE.Vector3,
  ) => {
    thrownItems.push({
      kind,
      mesh,
      velocity: velocity.clone(),
      // Tumble taken from the clock rather than a random number, so a replay of
      // the same inputs throws the same phone the same way.
      spin: new THREE.Vector3(
        Math.sin(elapsedTime * 7.7) * 9,
        Math.cos(elapsedTime * 5.3) * 6,
        Math.sin(elapsedTime * 3.1) * 7,
      ),
      age: 0,
      ground: state.ground,
      groundRefresh: 0,
      resting: false,
    });
  };

  /** Let go. `thrown` adds the arm; a drop just inherits the goose momentum. */
  const releaseHeld = (thrown: boolean) => {
    if (!held) return;
    releaseVelocity.set(0, 0, 0);
    if (thrown) {
      const power = state.mode === 'flying' ? FLYING_THROW_SCALE : 1;
      grabScratch.copy(state.forward);
      if (grabScratch.lengthSq() < 1e-6)
        grabScratch.set(Math.sin(state.heading), 0, Math.cos(state.heading));
      grabScratch.normalize();
      releaseVelocity.copy(grabScratch).multiplyScalar(THROW_FORWARD * power);
      releaseVelocity.y += THROW_UP * power;
    }
    releaseVelocity.add(state.velocity);
    const speed = releaseVelocity.length();
    if (held.target === 'prop') {
      propSystem.release(held.id, releaseVelocity);
      // props.ts stays out of this on purpose: only the thrower knows whether
      // the prop left the beak or was merely dropped.
      if (speed > THROW_EVENT_SPEED)
        recordEvent({ type: 'prop', kind: held.kind, action: 'thrown' });
    } else {
      spawnThrownItem(held.kind, held.mesh, releaseVelocity);
    }
    if (thrown && speed > FASTBALL_SPEED)
      awardChaos(90, 'FASTBALL', { id: 'fastball' });
    held = null;
    heldGroundSeconds = 0;
  };

  const updateThrownItems = (dt: number) => {
    for (let index = thrownItems.length - 1; index >= 0; index -= 1) {
      const item = thrownItems[index];
      item.age += dt;
      if (item.age >= ITEM_FLIGHT_SECONDS) {
        returnItemMesh(item.kind, item.mesh);
        thrownItems.splice(index, 1);
        continue;
      }
      if (item.resting) continue;
      item.groundRefresh -= dt;
      if (item.groundRefresh <= 0) {
        item.groundRefresh = 0.12;
        item.ground = propGroundAt(
          item.mesh.position.x,
          item.mesh.position.z,
          item.ground,
        );
      }
      item.velocity.y -= FLIGHT.gravity * dt;
      const drag = Math.exp(-0.5 * dt);
      item.velocity.x *= drag;
      item.velocity.z *= drag;
      item.mesh.position.addScaledVector(item.velocity, dt);
      item.mesh.rotation.x += item.spin.x * dt;
      item.mesh.rotation.y += item.spin.y * dt;
      item.mesh.rotation.z += item.spin.z * dt;
      const rest = item.ground + 0.04;
      if (item.mesh.position.y > rest) continue;
      item.mesh.position.y = rest;
      if (item.velocity.y < -1.2) {
        item.velocity.y *= -0.25;
        item.velocity.x *= 0.55;
        item.velocity.z *= 0.55;
        item.spin.multiplyScalar(0.5);
      } else {
        item.resting = true;
        item.velocity.set(0, 0, 0);
        item.spin.set(0, 0, 0);
        item.mesh.rotation.set(0, item.mesh.rotation.y, 0);
      }
    }
  };

  const endChase = (index: number) => {
    const chase = itemChases[index];
    itemChases.splice(index, 1);
    if (campusNpcs[chase.npc.index] !== chase.npc) return;
    if (chase.npc.mode === 'chase')
      resumeCampusNpcRoute(chase.npc, npcTerrainAt);
  };

  const resolveChase = (chase: ItemChase, caught: boolean) => {
    if (chase.resolved) return;
    chase.resolved = true;
    recordEvent({ type: 'steal', item: chase.item, caught });
  };

  /** The student takes its property back, out of the beak if it is still there. */
  const returnStolenItem = (chase: ItemChase) => {
    if (held?.target === 'item' && held.kind === chase.item) {
      returnItemMesh(held.kind, held.mesh);
      held = null;
      heldGroundSeconds = 0;
    }
    // An item already thrown stays where it landed; the student is holding a
    // replacement by the time it stops shouting.
    chase.npc.item = chase.item;
  };

  const updateChases = (dt: number) => {
    for (let index = itemChases.length - 1; index >= 0; index -= 1) {
      const chase = itemChases[index];
      const npc = chase.npc;
      // A respawn or a crowd recycle can swap the chaser out from under us.
      if (campusNpcs[npc.index] !== npc) {
        resolveChase(chase, false);
        itemChases.splice(index, 1);
        continue;
      }
      chase.remaining -= dt;
      const agl = state.position.y - state.ground;
      if (state.mode === 'flying' && agl > CHASE_ESCAPE_ALTITUDE)
        chase.airborneTime += dt;
      else chase.airborneTime = 0;
      const distance = Math.hypot(
        npc.position.x - state.position.x,
        npc.position.z - state.position.z,
      );

      if (
        state.mode !== 'flying' &&
        npc.mode === 'chase' &&
        CAMPUS_CHASE_SECONDS - chase.remaining > CHASE_REACTION_SECONDS &&
        distance <= CHASE_CATCH_DISTANCE
      ) {
        returnStolenItem(chase);
        tumbleRemaining = Math.max(tumbleRemaining, 0.8);
        tumbleAngularSpeed = 11 * (npc.position.x >= state.position.x ? -1 : 1);
        cameraShakeRemaining = Math.max(cameraShakeRemaining, 0.24);
        audio.thud(0.75);
        triggerHitStop(0.75);
        // Queued, not shown outright: the theft toast is usually still on
        // screen, and the HUD drops an info toast that lands on top of one.
        queueScoreToast(`CAUGHT · ${ITEM_NAMES[chase.item]} returned`);
        resolveChase(chase, true);
        endChase(index);
        continue;
      }

      const gotAway =
        distance > CHASE_ESCAPE_DISTANCE ||
        chase.airborneTime >= CHASE_ESCAPE_SECONDS;
      if (!gotAway && chase.remaining > 0) continue;
      resolveChase(chase, false);
      endChase(index);
      // Queued for the same reason as the catch: it often lands right on the
      // heels of the theft toast, and an info toast there is dropped.
      if (gotAway) queueScoreToast(`Clean getaway · ${ITEM_NAMES[chase.item]}`);
    }
  };

  const chaseContext: CampusChaseContext = {
    target: state.position,
    avoidBuildings: (point, radius) => {
      resolvePropBuilding(point, radius);
    },
  };

  /** Called once per fixed step, before the prop system integrates. */
  const updateGrabAndSteal = (dt: number) => {
    if (grabQueued) {
      grabQueued = false;
      if (held) releaseHeld(true);
      else tryGrab();
    }
    // A tumbling goose has no beak to spare.
    if (held && tumbleRemaining > 0) releaseHeld(false);
    if (held) {
      updateBeakPoint();
      updateHoldIdeal();
      springHoldPoint(dt);
      if (held.target === 'prop') {
        // A prop recycled out from under the beak simply stops being held.
        if (!propSystem.hold(held.id, holdPoint)) held = null;
        else if (state.mode === 'flying') heldGroundSeconds = 0;
        else heldGroundSeconds += dt;
        if (
          held?.target === 'prop' &&
          held.mass > HEAVY_PROP_MASS &&
          heldGroundSeconds > TOO_HEAVY_GROUND_SECONDS
        ) {
          // Queued rather than shown: dropping a bench usually wrecks it, and
          // the wreck award takes the toast slot in the same frame.
          queueScoreToast(`Too heavy · dropped the ${PROP_NAMES[held.kind]}`);
          releaseHeld(false);
        }
      } else {
        held.mesh.position.copy(holdPoint);
        held.mesh.quaternion.copy(goose.root.quaternion);
      }
    }
    goose.head.rotation.x = moveToward(
      goose.head.rotation.x,
      held ? HOLD_HEAD_TILT : 0,
      2.4 * dt,
    );
    updateChases(dt);
    updateThrownItems(dt);
  };

  const setPhase3Visibility = (visible: boolean) => {
    for (const kind of CAMPUS_ITEM_KINDS)
      crowdFleet.items[kind].visible = visible;
    if (held?.target === 'item') held.mesh.visible = visible;
    for (const item of thrownItems) item.mesh.visible = visible;
  };

  /** Respawn and travel: let go of everything, and every theft counts as clean. */
  const abandonGrabsForRespawn = () => {
    if (held) releaseHeld(false);
    for (const chase of itemChases) {
      resolveChase(chase, false);
      if (
        campusNpcs[chase.npc.index] === chase.npc &&
        chase.npc.mode === 'chase'
      )
        resumeCampusNpcRoute(chase.npc, npcTerrainAt);
    }
    itemChases.length = 0;
    for (const item of thrownItems) returnItemMesh(item.kind, item.mesh);
    thrownItems.length = 0;
    goose.head.rotation.x = 0;
  };

  // ------------------------- end Phase 3: grab and steal -------------------

  const simulate = (dt: number) => {
    updateChaosTimers(dt);
    // After the tumble timer has been decayed and before the flap check, so a
    // held KeyR re-arms the tumble in the same step that would have ended it
    // and beginFlapIfNeeded still refuses to fire mid-tumble.
    updateRagdollKey();
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
      simulateCampusNpc(npc, dt, elapsedTime, npcTerrainAt, chaseContext),
    );
    if (tumbleRemaining > 0) simulateTumble(dt);
    else if (state.mode === 'planing') simulateWaterPlaning(dt);
    else if (state.mode === 'flying') simulateFlight(dt);
    else simulateGround(dt);
    if (state.mode !== 'flying') {
      // Only flight arms the jetstream; a landing, splash or tumble lets it go.
      altitudeBoostActive = false;
      altitudeBoostRamp = Math.max(
        0,
        altitudeBoostRamp - dt / ALTITUDE_BOOST_RAMP_OUT,
      );
    }
    resolveBuildingInteractions();
    refreshBuildingSupport();
    enforceSurfacePostcondition();
    ensureWaterEntrySplash(dt);
    resolveTrafficInteractions();
    updateGrabAndSteal(dt);
    // Props run after traffic so the goose velocity a prop reads is the one it
    // will actually leave the step with.
    goosePropProbe.radius =
      (state.mode === 'flying' ? 0.68 : 0.58) * modifiers.gooseScale;
    goosePropProbe.mode = state.mode;
    propSystem.step(dt, goosePropProbe);
    propSystem.collideCars(traffic);
    propSystem.collideStudents(campusNpcs);
    resolveCrowdInteractions();
    recruitNearbyFlock();
    finishFlightIfLanded();
    updateCampusSecrets(dt);
    if (state.flapRemaining > 0) {
      state.flapRemaining = Math.max(0, state.flapRemaining - dt);
    }
  };

  const updateGoosePose = (pose: SimState, dt = 0) => {
    goose.root.position.copy(pose.position);
    // The rim shader cannot find the eye on its own (see GooseRimEye), so hand
    // both rigs the chase camera. A frame of lag on an edge highlight is free.
    goose.rimEye.value.copy(cameraPosition);
    flockPoseRig.rimEye.value.copy(cameraPosition);
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
      const poseBoost = altitudeBoostStrength(
        altitudeBoostRamp,
        modifiers.jetstreamAlways,
      );
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
        const cycle = flapCycle(
          (FLAP_PERIOD - pose.flapRemaining) / FLAP_PERIOD,
        );
        const arm = wingBeatAngle(cycle);
        // The hand trails the arm by a quarter beat and feathers nose-down
        // where the tip is moving fastest: the bow and the twist together are
        // what separate a wingbeat from a hinge swinging open and shut.
        const bend =
          (wingBeatAngle(cycle - WING_OUTER_LAG) - arm) * WING_OUTER_BEND;
        const twist = Math.sin(cycle * Math.PI * 2) * WING_OUTER_TWIST;
        // set() rather than rotation.z, because the folded stance sweeps the
        // shoulders about y and a takeoff has to clear that.
        goose.leftWing.rotation.set(0, 0, arm);
        goose.rightWing.rotation.set(0, 0, -arm);
        goose.leftWingOuter.rotation.set(twist, 0, bend);
        goose.rightWingOuter.rotation.set(twist, 0, -bend);
      } else {
        // Nothing on a bird is ever still: a slow breath through the wrists
        // plus a bank-dependent spread keeps the glide from reading as a
        // paper plane.
        const breath =
          Math.sin(elapsedTime * WING_BREATH_RATE) * WING_BREATH_ANGLE;
        const spread = pose.bank * WING_GLIDE_BANK_SPREAD;
        goose.leftWing.rotation.set(0, 0, -0.1 - pose.bank * 0.1 + breath);
        goose.rightWing.rotation.set(0, 0, 0.1 - pose.bank * 0.1 - breath);
        goose.leftWingOuter.rotation.set(
          breath * 0.5,
          0,
          WING_GLIDE_HAND_DROOP + breath * 0.8 + spread,
        );
        goose.rightWingOuter.rotation.set(
          breath * 0.5,
          0,
          -WING_GLIDE_HAND_DROOP - breath * 0.8 + spread,
        );
      }
    } else {
      goose.root.rotation.set(0, pose.heading, -waddle * 0.035);
      goose.legs.visible = pose.mode === 'waddling';
      setGooseLegStride(goose, waddle);
      setGooseWingsFolded(goose);
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
    gooseShadow.update(
      pose.position.x,
      pose.ground,
      pose.position.z,
      pose.position.y - pose.ground,
      modifiers.gooseScale,
    );
    animateHalo(dt);
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
      (isFlying ? 8.7 + 0.035 * speed : 5.65) *
      cameraDistanceScale *
      modifiers.gooseScale ** 0.6;
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
    const altitudeBoost = altitudeBoostStrength(
      altitudeBoostRamp,
      modifiers.jetstreamAlways,
    );
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
    const resolvedBuildingCount = resolvedBuildingColliderCount();
    const projectedGoose = state.position
      .clone()
      .applyMatrix4(camera.projectionMatrix);
    const mapCanvas = map.getCanvas();
    const saved = progress.get();
    const propStats = propSystem.stats();
    mirrorHarnessAttributes();
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
      // `shown`, not group.visible: a secret parked on the far side of the map
      // is still placed in the world, it is only skipped by the renderer.
      secretVisuals: campusSecrets.filter((secret) => secret.shown).length,
      nearestSecretLabel: nearestSecret?.secret.group.name ?? null,
      nearestSecretDistance: nearestSecret?.distance ?? null,
      nearestSecretDirection,
      nearestSecretBearing: secretBearing / DEG,
      secretMarkers: campusSecrets.map((secret) => ({
        id: secret.id,
        label: secret.group.name,
        east: secret.position.x,
        north: secret.position.z,
        found: secret.found,
      })),
      students: campusNpcs.length,
      studentsNearby,
      studentsOnMappedWalkways,
      nearestStudent: nearestNpc?.distance ?? null,
      nearestStudentVertical: nearestNpc
        ? nearestNpc.npc.position.y - state.ground
        : null,
      trees: treeCount,
      treesResolved: treeCount - unresolvedTreeCount,
      waterSurfaces: waterSurfaces.count,
      flockSize: recruitedFlockCount,
      flockTotal: flockGeese.length,
      recruitableGooseInRange,
      altitudeBoost,
      groundElevation: state.ground,
      east: state.position.x,
      north: state.position.z,
      heading: visualHeading,
      buildings: buildingColliders.length,
      buildingsResolved: resolvedBuildingCount,
      cameraZoom: map.getZoom(),
      cameraScale: cameraDistanceScale,
      insideBuilding,
      renderCalls: lastRenderCalls,
      gooseVisible: goose.root.visible,
      gooseScreenX: (projectedGoose.x * 0.5 + 0.5) * mapCanvas.clientWidth,
      gooseScreenY: (-projectedGoose.y * 0.5 + 0.5) * mapCanvas.clientHeight,
      duckCouncilEast: duckCouncil?.position.x ?? 0,
      duckCouncilNorth: duckCouncil?.position.z ?? 0,
      duckCouncilVisible: duckCouncil?.shown ?? false,
      paused,
      tokens: saved.tokens,
      questsCompleted: saved.completedQuests.length,
      questsTotal: QUESTS.length,
      props: propStats.props,
      propsAwake: propStats.propsAwake,
      holding: heldLabel(),
      activeMutators: saved.activeMutators,
      gooseScale: modifiers.gooseScale,
      ragdolling: tumbleRemaining > 0,
      timeScale,
    });
  };

  /**
   * Drop the goose into the world at a spot, airborne and pointed somewhere.
   * Shared by the respawn and by travelTo(), so a teleport gets exactly the same
   * per-life cleanup: no leftover tumble, no stale water state, and the
   * streaming anchors invalidated so the city rebuilds around the new spot.
   */
  const placeGoose = (
    east: number,
    north: number,
    headingRadians: number,
    altitudeAboveGround: number,
  ) => {
    keys.clear();
    abandonGrabsForRespawn();
    const spawnPoint = new THREE.Vector2(east, north);
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
      spawnGround + altitudeAboveGround,
      spawnPoint.y,
    );
    state.forward.set(Math.sin(headingRadians), 0, Math.cos(headingRadians));
    state.velocity.copy(state.forward).multiplyScalar(SPAWN_SPEED).setY(-0.4);
    state.heading = headingRadians;
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
    infamyPanicClock = 0;
    tumbleRemaining = 0;
    tumbleAngle = 0;
    tumbleAngularSpeed = 0;
    // A respawn or a travel must not arrive already in slow motion, and a
    // KeyR still held across it re-seeds its spin instead of continuing the
    // old one. The one-time ragdoll hint stays shown: it is per session.
    slowMotionRemaining = 0;
    timeScale = 1;
    ragdollLatched = false;
    ragdollSplashLatched = false;
    hitCooldown = 0;
    buildingHitCooldown = 0;
    cameraShakeRemaining = 0;
    lowGravityRemaining = 0;
    megaHonkRemaining = 0;
    slipperyRemaining = 0;
    airborneTime = 0;
    peakAgl = 0;
    flightMeters = 0;
    flightTopSpeed = 0;
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
    altitudeBoostRamp = 0;
    jetstreamToastShown = false;
    crowdRelocationClock = 0;
    trafficAnchor.set(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    buildingIngestAnchor.set(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    );
    mappedWaterAnchor.set(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    woodlandAnchor.set(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    lidarAnchor.set(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    buildingRefreshRequested = true;
    woodlandScanNeedsRetry = false;
    woodlandScanRetryAt = 0;
    trafficRefreshClock = 0;
    accumulator = 0;
    relocateNearbyCrowd(true);
    // Props follow the goose the way traffic and the crowd do: the authored
    // table spawns around wherever it just landed, and the POI scan restarts.
    propPoiAnchor.set(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    propPoiClock = PROP_POI_REFRESH_SECONDS;
    propPoiScans = 0;
    // A travel lands in a part of town whose colliders were ingested against
    // the old campus elevation; sweep them before the goose can stand on one.
    unresolvedColliderClock = 0;
    refreshUnresolvedColliderTerrain();
    refreshProps(spawnPoint.x, spawnPoint.y);
    propSystem.updateVisuals(1, elapsedTime);
    return spawnPoint;
  };

  const resetState = (clearProgress = false, updateView = true) => {
    const spawnPoint = placeGoose(0, 0, 0, SPAWN_ALTITUDE);
    // A new life stands every prop back up. Travel deliberately does not: the
    // wreckage the goose left behind is still there when it comes back.
    propSystem.resetAll();
    propSystem.updateVisuals(1, elapsedTime);
    if (clearProgress) {
      chaosScore = 0;
      campusInfamyUnlocked = false;
    }
    // A new life drops the combo; a travel (which also calls placeGoose) keeps
    // whatever streak was running.
    chaosCombo = 1;
    chaosComboEvents = 0;
    chaosComboRemaining = 0;
    cameraDistanceScale = DEFAULT_CAMERA_SCALE;
    cameraDistanceTarget = DEFAULT_CAMERA_SCALE;
    cameraOrbitYaw = 0;
    cameraOrbitYawTarget = 0;
    cameraOrbitPitch = DEFAULT_CAMERA_PITCH;
    cameraOrbitPitchTarget = DEFAULT_CAMERA_PITCH;
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
    });
    copyState(previousState, state);
    copyState(renderState, state);
    updateGoosePose(renderState);
    updateFlockVisuals(0, renderState);
    setGameplayVisibility(playing);
    if (updateView) updateCamera(1 / 60, renderState, true);
    emitTelemetry();
  };

  /** Replay the save into the world: found secrets stay found, flock stays flock. */
  const restoreSavedWorld = () => {
    const saved = progress.get();
    if (saved.secretsFound.length > 0) {
      const found = new Set(saved.secretsFound);
      campusSecrets.forEach((secret) => {
        if (found.has(secret.id)) markSecretFound(secret, true);
      });
    }
    saved.recruitedGeese.forEach((roostIndex) => {
      const member = flockGeese[roostIndex];
      if (member) recruitFlockMember(member, true);
    });
    updateFlockVisuals(0, renderState);
    setGameplayVisibility(playing);
    refreshSecretRange();
    secretRangeClock = SECRET_RANGE_INTERVAL;
    emitTelemetry();
  };

  /** The other direction: a fresh goose, so the world forgets everything. */
  const forgetSavedWorld = () => {
    campusSecrets.forEach((secret) => {
      secret.found = false;
      secret.activation = 0;
      secret.honkCount = 0;
      secret.honkWindow = 0;
      const baseY = secret.group.userData.baseY;
      if (typeof baseY === 'number') secret.group.position.y = baseY;
      secret.group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const { basePosition, baseEmissive, baseEmissiveIntensity } =
          object.userData;
        if (basePosition instanceof THREE.Vector3)
          object.position.copy(basePosition);
        if (!(object.material instanceof THREE.MeshStandardMaterial)) return;
        if (typeof baseEmissive === 'number')
          object.material.emissive.setHex(baseEmissive);
        if (typeof baseEmissiveIntensity === 'number')
          object.material.emissiveIntensity = baseEmissiveIntensity;
      });
    });
    secretsFound = 0;
    recruitedFlockCount = 0;
    flockGeese.forEach((member) => {
      member.recruited = false;
      member.waterContactLatched = false;
      member.waterContactReleaseTime = 0;
      member.position.set(member.home.x, member.ground + 0.04, member.home.y);
      member.drawnPosition.copy(member.position);
    });
    chaosScore = 0;
    chaosCombo = 1;
    chaosComboEvents = 0;
    chaosComboRemaining = 0;
    campusInfamyUnlocked = false;
    setGameplayVisibility(playing);
    updateFlockVisuals(0, renderState);
    emitTelemetry();
  };

  const customLayer: CustomLayerInterface = {
    id: 'kalamazoo-goose-3d-world',
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
      // Last moment before the draw, so a scan, a resolve pass and a texture
      // landing in the same frame all cost one merge between them.
      flushRoofOverlayBatches();
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
    const trafficChanged = buildTraffic();
    const crowdChanged = collectPedestrianRoutes();
    const buildingsChanged =
      buildingColliders.length === 0 ? buildTexturedBuildings() : false;
    const woodlandChanged = collectMappedWoodlandTrees();
    const treePlacementsChanged = refreshTreePlacementMask();
    collectStreamedProps();
    if (trafficChanged) updateTrafficVisuals(1);
    if (
      trafficChanged ||
      crowdChanged ||
      buildingsChanged ||
      woodlandChanged ||
      treePlacementsChanged
    )
      map.triggerRepaint();
  };
  const onSourceData = (event: MapSourceDataEvent) => {
    if (
      event.sourceId === 'wmug-aerial-imagery' &&
      map.isSourceLoaded('wmug-aerial-imagery')
    ) {
      buildingRefreshRequested = true;
      buildingRefreshClock = Math.min(buildingRefreshClock, 0.08);
    }
    if (event.sourceDataType !== 'content') return;
    if (event.sourceId === waterSourceId) waterRefreshRequested = true;
    if (event.sourceId === buildingSourceId) {
      buildingRefreshRequested = true;
      buildingRefreshClock = Math.min(buildingRefreshClock, 0.08);
    }
    if (terrainSourceId && event.sourceId === terrainSourceId) {
      // A DEM tile just decoded, so the collider sweep is worth running now
      // rather than on its next quarter-second tick.
      unresolvedColliderClock = Math.min(unresolvedColliderClock, 0.05);
      treeRefreshClock = Math.min(treeRefreshClock, 0.12);
      waterSurfaceClock = Math.min(waterSurfaceClock, 0.1);
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
  // The first ingestion happens while the DEM is still streaming, so give the
  // colliders one sweep before anyone can look at a roof.
  refreshUnresolvedColliderTerrain();

  const frame = (now: number) => {
    if (destroyed) return;
    const frameDt = Math.min(0.1, Math.max(0, (now - previousTime) / 1000));
    previousTime = now;
    // A paused game still renders and still lets the camera settle, but no
    // simulated time passes: the world is exactly where it was on unpause.
    const simulating = playing && !paused;
    // The animated map may never become idle. Ingest newly arrived water
    // tiles on a bounded cadence, including while the goose stays still.
    waterRefreshClock -= frameDt;
    if (waterRefreshClock <= 0) {
      waterRefreshClock = 0.25;
      refreshMappedWaterForCurrentArea();
    }
    if (simulating) elapsedTime += frameDt;
    drainPendingToasts(frameDt);
    if (simulating) {
      unsavedPlaySeconds += frameDt;
      if (unsavedPlaySeconds >= 15) {
        const banked = unsavedPlaySeconds;
        unsavedPlaySeconds = 0;
        progress.update((saved) => {
          saved.stats.playSeconds += banked;
        });
      }
    }
    buildingRefreshClock = Math.max(0, buildingRefreshClock - frameDt);
    trafficRefreshClock = Math.max(0, trafficRefreshClock - frameDt);
    if (
      Math.hypot(
        state.position.x - buildingIngestAnchor.x,
        state.position.z - buildingIngestAnchor.y,
      ) > BUILDING_RESCAN_DISTANCE
    ) {
      buildingRefreshRequested = true;
      buildingRefreshClock = Math.min(buildingRefreshClock, 0.08);
    }
    // Tile loads and long moves request scans, but the chunk set MapLibre
    // draws also changes when the camera merely orbits or zooms, and the
    // stale-chunk pruning needs scans to keep counting after the last tile
    // has landed. A slow steady cadence covers both.
    if (playing) {
      buildingRescanClock -= frameDt;
      if (buildingRescanClock <= 0) {
        buildingRescanClock = BUILDING_RESCAN_INTERVAL;
        buildingRefreshRequested = true;
      }
      secretRangeClock -= frameDt;
      if (secretRangeClock <= 0) {
        secretRangeClock = SECRET_RANGE_INTERVAL;
        refreshSecretRange();
      }
    }
    if (!buildingRefreshRequested && buildingRefreshClock <= 0) {
      // Unresolved terrain no longer re-triggers a full feature scan: that is
      // refreshUnresolvedColliderTerrain()'s job now, and it costs five DEM
      // lookups instead of a querySourceFeatures over the whole tile.
      refreshActiveBuildingColliders();
      buildingRefreshClock = 0.2;
    }
    if (buildingRefreshRequested && buildingRefreshClock <= 0) {
      buildingRefreshRequested = false;
      buildingRefreshClock = 0.28;
      if (buildTexturedBuildings()) {
        refreshTreePlacementMask();
        map.triggerRepaint();
      }
    }
    // Buildings arrive long before the DEM under them. This is the pass that
    // lands their collision boxes and roof overlays once it shows up.
    if (playing) {
      unresolvedColliderClock -= frameDt;
      if (unresolvedColliderClock <= 0) {
        unresolvedColliderClock = UNRESOLVED_COLLIDER_INTERVAL;
        if (refreshUnresolvedColliderTerrain()) map.triggerRepaint();
      }
    }
    if (simulating && trafficRefreshClock <= 0) {
      trafficRefreshClock = 1;
      if (buildTraffic()) {
        collectPedestrianRoutes();
        collectMappedWoodlandTrees();
        updateTrafficVisuals(1);
        refreshTreePlacementMask();
        map.triggerRepaint();
      }
    }
    if (simulating) {
      // The only place the hit-stop bites: real time is scaled on the way into
      // the fixed-step accumulator, so the simulation crawls while rendering,
      // the camera, the toast timers and the ambient bed all keep real time.
      accumulator += frameDt * timeScale;
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
        refreshMappedWaterForCurrentArea();
        collectMappedWoodlandTrees();
        updateTrees(true);
      }
      cloudRefreshClock -= frameDt;
      if (cloudRefreshClock <= 0) {
        cloudRefreshClock = 0.12;
        updateClouds();
      }
      propPoiClock -= frameDt;
      if (propPoiClock <= 0) {
        propPoiClock = PROP_POI_REFRESH_SECONDS;
        collectStreamedProps();
      }
    }
    if (!playing) {
      treeRefreshClock -= frameDt;
      if (treeRefreshClock <= 0) {
        treeRefreshClock = 0.35;
        refreshMappedWaterForCurrentArea();
        collectMappedWoodlandTrees();
        updateTrees(false);
      }
    }
    // The water polygons are re-collected by the scans above; this is only the
    // integer generation compare that notices when they changed.
    if (refreshWaterSurfaces()) map.triggerRepaint();
    waterSurfaceClock -= frameDt;
    if (waterSurfaceClock <= 0) {
      waterSurfaceClock = WATER_SURFACE_RESOLVE_INTERVAL;
      if (
        waterSurfaces.resolveElevations(
          waterSurfaceElevationAt,
          campusGroundFallback,
        )
      )
        map.triggerRepaint();
    }
    waterSurfaces.update(elapsedTime, cameraPosition);
    updateSplashes(simulating ? frameDt : 0);
    updateHonkWaves(simulating ? frameDt : 0);
    propSystem.updateVisuals(
      simulating ? accumulator / fixedStep : 1,
      elapsedTime,
    );
    updateGoosePose(renderState, simulating ? frameDt : 0);
    if (playing) {
      if (simulating) updateFlockVisuals(frameDt, renderState);
      updateCamera(frameDt, renderState);
    }
    // The ambient bed follows the goose every frame, not on the telemetry
    // tick: a 10 Hz update is audible as stepping in the wind filter.
    audio.setAmbient({
      agl: Math.max(0, renderState.position.y - renderState.ground),
      speed: renderState.velocity.length(),
      mode: renderState.mode,
      paused: paused || !playing,
    });
    // Combo (x2+) or the jetstream boost tops the backing track out; on the
    // ground/water it settles to a calm 0.4, in the air a livelier 0.7.
    audio.music.setIntensity(
      chaosCombo >= 2 || altitudeBoostActive
        ? 1
        : renderState.mode === 'waddling' || renderState.mode === 'swimming'
          ? 0.4
          : 0.7,
    );
    telemetryClock -= frameDt;
    if (telemetryClock <= 0) {
      telemetryClock = 0.1;
      emitTelemetry();
    }
    if (playing || splashes.length > 0 || honkWaves.length > 0)
      map.triggerRepaint();
    animationFrame = requestAnimationFrame(frame);
  };

  // ---------------------------------------------------------------------
  // Phase 4: mutators
  // ---------------------------------------------------------------------
  // Every mutator's behavior lives in this one region. The functions above
  // (simulateFlight, simulateTumble, resolveBuildingInteractions,
  // resolveCrowdInteractions, resolveTrafficInteractions, performHonk,
  // updateCampusSecrets, updateGoosePose, updateCamera, emitTelemetry, and
  // the goose prop probe in simulate()) each only gained a single line that
  // reads `modifiers` or calls one of these; none of them were reordered or
  // reformatted. `modifiers` is declared here, late in setup, but every
  // reader above is a closure that is only ever invoked later (inside
  // frame(), which does not run until the next animation frame), so the
  // declaration order is safe.

  /**
   * Restored whenever no skin is active. Shares GOOSE_PALETTE with the rig, so
   * dropping a skin puts back the exact colours createGooseRig built with.
   */
  const DEFAULT_GOOSE_COLORS: GooseColors = GOOSE_PALETTE;

  let modifiers: Modifiers = computeModifiers(progress.get().activeMutators);
  let lastActiveMutatorsKey = progress.get().activeMutators.join(',');
  // Ids already unlocked before this engine instance started never toast;
  // only ids that newly appear in the save do.
  let lastUnlockedMutators = new Set(progress.get().unlockedMutators);
  let jetstreamToastShown = false;
  let haloPhase = 0;

  /**
   * Everything a mutator changes that nothing else already reads live every
   * frame: the goose's base scale, its material colors, and the halo's
   * visibility. Called once at startup and again whenever activeMutators
   * changes (including a reset, where it puts everything back to default).
   */
  const applyModifiers = () => {
    goose.root.scale.setScalar(0.4 * modifiers.gooseScale);
    const palette = modifiers.colors ?? DEFAULT_GOOSE_COLORS;
    goose.materials.body.color.setHex(palette.body);
    goose.materials.breast.color.setHex(palette.breast);
    goose.materials.neck.color.setHex(palette.neck);
    goose.materials.wing.color.setHex(palette.wing);
    goose.materials.beak.color.setHex(palette.beak);
    goose.halo.visible = modifiers.halo;
    // Dropping Bronco Goose returns the horse's leash to its authored spot;
    // while the mutator is active the bronco branch re-homes it every step.
    if (!modifiers.broncoFollows && broncoSecret) {
      broncoHome.set(broncoSecret.position.x, broncoSecret.position.z);
    }
  };

  /**
   * Jet Goose forces the jetstream boost on regardless of altitude, so the
   * natural per-climb toast (armed each time altitudeBoostActive flips on)
   * would otherwise fire every time the player dips under the release
   * height and climbs back over it. Everyone else keeps the old behavior.
   */
  const announceJetstream = () => {
    if (modifiers.jetstreamAlways && jetstreamToastShown) return;
    jetstreamToastShown = true;
    hooks.onToast(
      `JETSTREAM · +${JETSTREAM_BOOST_PERCENT}% speed above ${ALTITUDE_BOOST_HEIGHT}m`,
    );
  };

  /** Angel Goose's halo: hidden unless active, gently bobbing and turning. */
  const animateHalo = (dt: number) => {
    if (!goose.halo.visible) return;
    haloPhase += dt * 1.4;
    goose.halo.position.y = 1.93 + Math.sin(haloPhase) * 0.04;
    goose.halo.rotation.z += dt * 0.6;
  };

  /** Party Goose's honk: the same shape as terrorizeCampusCrowd, but it
   * starts a dance instead of a panic. Kept as its own function (rather than
   * a flag on terrorizeCampusCrowd) so the grab branch's crowd work never
   * has to touch this file's panic path. */
  const partyCampusCrowd = (radius: number, awardable = true) => {
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
          npc.mode === 'walk' &&
          npc.honkCooldown <= 0,
      )
      .sort((a, b) => a.distance - b.distance)
      .slice(0, megaHonkRemaining > 0 ? 22 : 12);
    let scored = 0;
    nearby.forEach(({ npc }) => {
      const canScore = awardable && npc.scoreCooldown <= 0;
      if (startDanceCampusNpc(npc) && canScore) {
        npc.scoreCooldown = 8;
        scored += 1;
      }
    });
    return { panicked: nearby.length, scored };
  };

  /** The chaosScore >= 10,000 auto-panic timer routes through here so Party
   * Goose gets a dance floor instead of a stampede. */
  const applyInfamyReaction = (npc: CampusNpc) => {
    if (modifiers.honkStyle === 'party') startDanceCampusNpc(npc);
    else panicCampusNpc(npc, state.position);
  };

  /** Bronco Goose: any walking student the horse steps within 1.1m of gets
   * bowled over, same as the goose's own crowd collision. */
  const trampleNearbyCrowd = (
    secret: CampusSecret,
    heading: number,
    speed: number,
  ) => {
    for (const npc of campusNpcs) {
      if (npc.mode !== 'walk') continue;
      const dx = npc.position.x - secret.group.position.x;
      const dz = npc.position.z - secret.group.position.z;
      if (Math.hypot(dx, dz) > 1.1) continue;
      const impulse = new THREE.Vector3(
        Math.sin(heading),
        0,
        Math.cos(heading),
      ).multiplyScalar(speed * 0.6);
      impulse.y = 3.2;
      if (!knockDownCampusNpc(npc, impulse)) continue;
      if (npc.scoreCooldown <= 0) {
        npc.scoreCooldown = 6;
        triggerHitStop(0.8);
        awardChaos(150, 'BRONCO BUSTER', { id: 'bronco-trample' });
      }
    }
  };

  /**
   * Giga Goose flips who absorbs a car collision: the car eats the impulse
   * (a hard wobble and a long reaction window) and the goose barely slows,
   * instead of the goose tumbling. Everyone else keeps the old physics.
   */
  const applyTrafficImpact = (
    car: TrafficCar,
    normal: THREE.Vector3,
    severity: number,
    localX: number,
    gigaBounce: boolean,
  ) => {
    if (gigaBounce) {
      car.wobbleRemaining = Math.max(car.wobbleRemaining, 2.6);
      car.reactionRemaining = Math.max(car.reactionRemaining, 2.6);
      state.velocity.addScaledVector(normal, lerp(0.4, 1.2, severity));
      state.velocity.multiplyScalar(0.94);
    } else {
      state.velocity.addScaledVector(normal, lerp(2, 7, severity));
      state.velocity.y = Math.max(state.velocity.y, lerp(1.2, 3.5, severity));
      tumbleRemaining = lerp(0.55, 1.35, severity);
      tumbleAngularSpeed = lerp(8, 17, severity) * (localX >= 0 ? 1 : -1);
    }
  };

  /**
   * The "Unlocked: <name>" toast reuses the trick/quest-complete queue above
   * instead of calling hooks.onToast directly: unlocking something that also
   * completes 'new-feathers' fires a same-tick QUEST COMPLETE score toast via
   * recordEvent, and the HUD silently drops an 'info' toast that lands right
   * behind a fresh 'score' one. Queuing behind it (same discipline as a trick
   * toast queuing behind a quest banner) is how everything else here avoids
   * that exact collision, so this reuses it rather than fighting it.
   */
  const queueInfoToast = (message: string) => {
    if (scoreToastCooldown <= 0 && pendingToasts.length === 0) {
      hooks.onToast(message, 'info');
      scoreToastCooldown = QUEST_TOAST_DELAY;
      return;
    }
    pendingToasts.push({
      message,
      priority: 'info',
      remaining: scoreToastCooldown + pendingToasts.length * QUEST_TOAST_DELAY,
    });
  };

  applyModifiers();

  resetState(true, false);
  restoreSavedWorld();
  // The HUD owns the store, so a wipe can arrive from anywhere. Only a
  // generation bump is a wipe; every other update is ordinary bookkeeping.
  // Phase 4: mutators also live here; activeMutators/unlockedMutators are
  // just more progress fields, and this is already the funnel that watches
  // the whole store for changes made from anywhere (the HUD's Locker tab
  // included).
  const unsubscribeProgress = progress.subscribe((saved) => {
    // Phase 5: the audio settings and the hit-stop toggle live in the same
    // store the HUD writes them to, so this funnel is where they land. Both
    // are cheap idempotent assignments; no diffing is worth the code.
    audio.setEnabled(saved.settings.sound, saved.settings.ambient);
    audio.music.setEnabled(saved.settings.music);
    slowMotionEnabled = saved.settings.slowMotion;
    if (!slowMotionEnabled) {
      // Turning it off mid-dip should take effect now, not in 0.4 seconds.
      slowMotionRemaining = 0;
      timeScale = 1;
    }
    if (saved.generation !== progressGeneration) {
      progressGeneration = saved.generation;
      forgetSavedWorld();
      hooks.onToast('Fresh goose · progress wiped');
      // Fall through: a wipe also empties activeMutators/unlockedMutators,
      // and the diffing below has to see that to reset modifiers and the
      // "already announced" unlock set.
    }
    const activeKey = saved.activeMutators.join(',');
    if (activeKey !== lastActiveMutatorsKey) {
      lastActiveMutatorsKey = activeKey;
      modifiers = computeModifiers(saved.activeMutators);
      applyModifiers();
    }
    for (const id of saved.unlockedMutators) {
      if (lastUnlockedMutators.has(id)) continue;
      lastUnlockedMutators.add(id);
      // recordEvent completes the 'new-feathers' quest (it listens for
      // 'unlock') and toasts that through the normal quest path; this toast
      // is just the separate "you got a new thing" announcement. It goes
      // through queueInfoToast, and runs after recordEvent, so it queues
      // behind a same-tick QUEST COMPLETE banner instead of being dropped.
      recordEvent({ type: 'unlock', mutator: id });
      queueInfoToast(`Unlocked: ${MUTATOR_BY_ID.get(id)?.name ?? id}`);
    }
    if (saved.unlockedMutators.length < lastUnlockedMutators.size) {
      // A reset (or any other shrink) drops ids the save no longer lists,
      // so unlocking the same mutator again in a future life still toasts.
      lastUnlockedMutators = new Set(saved.unlockedMutators);
    }
  });
  animationFrame = requestAnimationFrame(frame);

  return {
    start() {
      audio.unlock();
      audio.music.start();
      playing = true;
      setGameplayVisibility(true);
      previousTime = performance.now();
      updateCamera(1 / 60, renderState, true);
      hooks.onToast(
        `${campusSecrets.length} Kalamazoo secrets are live · explore the city, find the runaway WMU Bronco, and build your flock`,
      );
    },
    reset() {
      audio.unlock();
      playing = true;
      resetState();
      setGameplayVisibility(true);
      previousTime = performance.now();
      hooks.onToast(
        'Respawned above WMU · your secret discoveries and score are safe',
      );
    },
    setKey(code, pressed) {
      if (pressed) {
        if (code === 'Space' && !keys.has(code)) {
          // A tap during a tumble used to be dropped, which read as the game
          // ignoring the player exactly when they wanted out. It now queues a
          // single flap that fires the moment the tumble ends; flaps still do
          // not fire during the tumble itself (beginFlapIfNeeded returns
          // early), so this is a buffered takeoff, not an escape hatch.
          queuedFlaps = tumbleRemaining > 0 ? 1 : Math.min(2, queuedFlaps + 1);
        }
        if ((code === 'KeyE' || code === 'KeyH') && !keys.has(code)) {
          audio.unlock();
          queuedHonks = Math.min(1, queuedHonks + 1);
        }
        if (code === 'KeyF' && !keys.has(code)) grabQueued = true;
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
      cameraDistanceTarget = DEFAULT_CAMERA_SCALE;
      cameraDistanceScale = cameraDistanceTarget;
      cameraOrbitYawTarget = 0;
      cameraOrbitYaw = cameraOrbitYawTarget;
      cameraOrbitPitchTarget = DEFAULT_CAMERA_PITCH;
      cameraOrbitPitch = cameraOrbitPitchTarget;
      updateCamera(1 / 60, renderState, true);
      map.triggerRepaint();
    },
    setPaused(next) {
      if (paused === next) return;
      paused = next;
      audio.music.setPaused(paused);
      if (paused) {
        // Held keys would otherwise still be held when the game comes back.
        keys.clear();
        queuedFlaps = 0;
        queuedHonks = 0;
        ragdollLatched = false;
        ragdollSplashLatched = false;
        // Unpausing into the tail of someone else's hit-stop would read as a
        // stutter, so the pause spends it.
        slowMotionRemaining = 0;
        timeScale = 1;
      } else {
        // Whatever real time the pause took is not a physics debt to repay.
        previousTime = performance.now();
        accumulator = 0;
      }
      emitTelemetry();
      map.triggerRepaint();
    },
    travelTo(secretId) {
      const secret = campusSecrets.find(
        (candidate) => candidate.id === secretId,
      );
      if (!secret?.found) return false;
      const toSecretX = secret.position.x - state.position.x;
      const toSecretZ = secret.position.z - state.position.z;
      // Arrive on the approach the player is already on, so the landmark is
      // straight ahead out of the gate rather than somewhere behind a wing.
      const heading =
        Math.hypot(toSecretX, toSecretZ) > 1
          ? Math.atan2(toSecretX, toSecretZ)
          : state.heading;
      placeGoose(
        secret.position.x - Math.sin(heading) * 30,
        secret.position.z - Math.cos(heading) * 30,
        heading,
        28,
      );
      sampleSurface();
      refreshActiveBuildingColliders(true);
      updateTrees(false);
      // The goose lands next to the secret this frame; waiting out the range
      // sweep's cadence would arrive at an empty landmark.
      refreshSecretRange();
      secretRangeClock = SECRET_RANGE_INTERVAL;
      copyState(previousState, state);
      copyState(renderState, state);
      updateGoosePose(renderState);
      updateFlockVisuals(0, renderState);
      updateCamera(1 / 60, renderState, true);
      previousTime = performance.now();
      hooks.onToast(`Traveled to ${secret.group.name}`);
      emitTelemetry();
      map.triggerRepaint();
      return true;
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(animationFrame);
      unsubscribeProgress();
      // Bank the tail of this session's play time before the store goes quiet.
      if (unsavedPlaySeconds > 0) {
        const banked = unsavedPlaySeconds;
        unsavedPlaySeconds = 0;
        progress.update((saved) => {
          saved.stats.playSeconds += banked;
        });
      }
      progress.flush();
      map.off('idle', onIdle);
      map.off('sourcedata', onSourceData);
      keys.clear();
      // Before the scene sweep below, so the prop meshes are already out of the
      // graph and their shared material is only disposed once.
      propSystem.dispose();
      treeTiles.dispose();
      // Same reason as the props: the shore-mask textures are the one thing
      // the scene sweep below cannot reach on its own.
      waterSurfaces.dispose();
      audio.dispose();
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
      // The flock pose rig shares its geometries and materials with the
      // instanced meshes the traverse just disposed, except the halo, which is
      // the one part that is never instanced.
      flockPoseRig.halo.geometry.dispose();
      flockPoseRig.halo.material.dispose();
      // Record geometries never enter the scene (only the merged batch mesh
      // does), so the traverse above cannot reach them.
      roofOverlayRecords.forEach((record) => record.geometry.dispose());
      roofOverlayRecords.clear();
      roofOverlayBatches.clear();
      buildingMaterials.forEach(({ texture }) => texture.dispose());
      buildingMaterials.clear();
    },
  };
}
