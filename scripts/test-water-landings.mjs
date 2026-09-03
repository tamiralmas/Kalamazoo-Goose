import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as THREE from 'three';

// Exercise the production physics closures with deterministic map/terrain
// fixtures. No WebGL, camera hit tests, or remote tile service is needed.
const engineSource = ts.createSourceFile(
  'game-engine.ts',
  readFileSync(new URL('../app/game-engine.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const declarations = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    if (node.initializer)
      declarations.set(node.name.text, node.initializer.getText(engineSource));
  }
  if (ts.isFunctionDeclaration(node) && node.name)
    declarations.set(node.name.text, node.getText(engineSource));
  ts.forEachChild(node, visit);
}
visit(engineSource);

const ring = (minX, minZ, maxX, maxZ) => [
  new THREE.Vector2(minX, minZ),
  new THREE.Vector2(maxX, minZ),
  new THREE.Vector2(maxX, maxZ),
  new THREE.Vector2(minX, maxZ),
];
const pond = {
  minX: 0,
  maxX: 60,
  minZ: 0,
  maxZ: 60,
  outer: ring(0, 0, 60, 60),
  holes: [ring(40, 40, 50, 50)],
};

function fixture() {
  const context = vm.createContext({
    THREE,
    Math,
    Number,
    JETSTREAM_BOOST_PERCENT: Number(
      readFileSync(
        new URL('../app/game-contract.ts', import.meta.url),
        'utf8',
      ).match(/JETSTREAM_BOOST_PERCENT = (\d+)/)[1],
    ),
    keys: new Set(),
    state: {
      position: new THREE.Vector3(20, 200.06, 20),
      velocity: new THREE.Vector3(12, -6, 0),
      forward: new THREE.Vector3(1, 0, 0),
      mode: 'flying',
      ground: 200,
      onWater: false,
      bank: 0,
      alpha: 0,
      heading: Math.PI / 2,
      stamina: 1,
      flapRemaining: 0,
      stall: 0,
    },
    previousState: {
      position: new THREE.Vector3(20, 201, 20),
      velocity: new THREE.Vector3(12, -6, 0),
    },
    renderState: { position: new THREE.Vector3(20, 201, 20) },
    cameraPosition: new THREE.Vector3(),
    cameraTarget: new THREE.Vector3(),
    modifiers: {
      jetstreamAlways: false,
      gravityScale: 1,
      topSpeedScale: 1,
      flapPowerScale: 1,
    },
    terrainEnabled: true,
    terrainSurfaceY: 200,
    campusGroundFallback: 200,
    campusGroundResolved: true,
    cloudBaseResolved: true,
    cloudBaseElevation: 200,
    cloudRefreshClock: 0,
    buildingRefreshRequested: false,
    treeRefreshClock: 1,
    campusSecrets: [],
    flockGeese: [],
    altitudeBoostActive: false,
    altitudeBoostRamp: 0,
    lowGravityRemaining: 0,
    airborneTime: 3,
    peakAgl: 10,
    queuedFlaps: 0,
    tumbleRemaining: 0,
    tumbleAngularSpeed: 0,
    cameraShakeRemaining: 0,
    buildingHitCooldown: 0,
    waterSurfaceY: 200,
    waterPlaningElapsed: 0,
    waterDryTime: 0,
    waterTouchdownSeverity: 0,
    waterSprayClock: 0,
    waterContactLatched: false,
    waterContactReleaseTime: 0,
    finalSurfaceSampleClock: 0,
    buildingContactThisStep: false,
    mappedWaterAreas: [pond],
    mappedWaterSignature: '',
    mappedWaterGeneration: 0,
    mappedWaterAnchor: new THREE.Vector2(20, 20),
    waterSourceId: 'water-source',
    waterRefreshRequested: true,
    dryMappedWalkwayCacheDirty: false,
    WATER_INGEST_RADIUS: 1600,
    TREE_PLACEMENT_ANCHOR_TOLERANCE: 300,
    roof: null,
    features: [],
    awards: [],
    splashes: [],
    flareHint: 'flare',
    announceJetstream() {},
    heldStallPenalty: () => 1,
    heldMassPenalty: () => 1,
    triggerHitStop() {},
    queryGroundElevation: () => 200,
    localToLngLat: (x, z) => ({ lng: x, lat: z }),
    geoToLocal: (x, z) => new THREE.Vector3(x, 0, z),
    audio: { thud() {} },
    hooks: { onToast() {} },
  });
  context.map = {
    getSource: () => ({}),
    querySourceFeatures: () => context.features,
    isSourceLoaded: () => false,
    project: () => {
      throw new Error('Physics must not project to the camera');
    },
    queryRenderedFeatures: () => {
      throw new Error('Physics must not query visible pixels');
    },
  };
  context.highestRoofAt = () => context.roof;
  context.roofKeyUnderGoose = () =>
    context.roof === null ? null : 'test-roof';
  context.awardChaos = (_amount, label) => context.awards.push(label);
  context.spawnSplash = (strength) => context.splashes.push(strength);
  const names = [
    'DEG',
    'UP',
    'FLAP_PERIOD',
    'DOWNSTROKE',
    'FLIGHT',
    'ALTITUDE_BOOST_HEIGHT',
    'ALTITUDE_BOOST_RELEASE_HEIGHT',
    'ALTITUDE_BOOST_RAMP_IN',
    'ALTITUDE_BOOST_RAMP_OUT',
    'BASE_CRUISE_SPEED',
    'BASE_MAX_FLIGHT_SPEED',
    'JETSTREAM_SPEED_SCALE',
    'ALTITUDE_BOOST_CRUISE_SPEED',
    'ALTITUDE_BOOST_ACCELERATION',
    'ALTITUDE_BOOST_MAX_SPEED',
    'clamp',
    'lerp',
    'smoothstep',
    'moveToward',
    'altitudeBoostStrength',
    'neutralFlightAlpha',
    'pointInRing',
    'isUsableTerrainElevation',
    'isPointInMappedWater',
    'collectMappedWaterAreas',
    'refreshMappedWaterForCurrentArea',
    'sampleSurface',
    'simulateFlight',
    'enforceSurfacePostcondition',
    'ensureWaterEntrySplash',
  ];
  for (const name of names) {
    assert.ok(declarations.has(name), `Production declaration exists: ${name}`);
    const script = `globalThis.${name} = ${declarations.get(name)};`;
    vm.runInContext(
      ts.transpileModule(script, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      context,
    );
  }
  return context;
}

test('50 m jetstream uses exactly 25% higher cruise and maximum speeds', () => {
  const c = fixture();
  assert.equal(c.ALTITUDE_BOOST_HEIGHT, 50);
  assert.equal(c.JETSTREAM_BOOST_PERCENT, 25);
  assert.equal(c.ALTITUDE_BOOST_CRUISE_SPEED, 23.125);
  assert.equal(c.ALTITUDE_BOOST_MAX_SPEED, 47.5);
});

test('pond geography is water even when the camera cannot see it', () => {
  const c = fixture();
  c.sampleSurface();
  assert.equal(c.state.onWater, true);
  c.state.position.set(45, 201, 45);
  c.sampleSurface();
  assert.equal(c.state.onWater, false, 'pond islands remain dry');
  c.state.position.set(-10, 201, 20);
  c.sampleSurface();
  assert.equal(c.state.onWater, false, 'banks remain dry');
});

test('a fast pond touchdown splashes and planes instead of awarding Lawn Dart', () => {
  const c = fixture();
  c.simulateFlight(1 / 60);
  assert.equal(c.state.onWater, true);
  assert.equal(c.state.mode, 'planing');
  assert.equal(c.splashes.length, 1);
  assert.ok(c.state.velocity.x > 9, 'water landing preserves forward momentum');
  assert.ok(c.awards.includes('BELLY FLOP'));
  assert.ok(!c.awards.includes('LAWN DART'));
  c.ensureWaterEntrySplash(1 / 60);
  assert.equal(c.splashes.length, 1, 'one splash per entry');
});

test('crossing the shoreline within one flight step uses the new position', () => {
  const c = fixture();
  c.state.position.x = -0.1;
  c.sampleSurface();
  assert.equal(c.state.onWater, false);
  c.simulateFlight(1 / 60);
  assert.ok(c.state.position.x > 0);
  assert.equal(c.state.mode, 'planing');
  assert.equal(c.splashes.length, 1);
  assert.ok(!c.awards.includes('LAWN DART'));
});

test('ground impacts and rooftops keep their own landing behavior', () => {
  const dry = fixture();
  dry.state.position.x = -20;
  dry.simulateFlight(1 / 60);
  assert.equal(dry.state.mode, 'waddling');
  assert.ok(dry.awards.includes('LAWN DART'));
  assert.equal(dry.splashes.length, 0);
  const roof = fixture();
  roof.roof = 205;
  roof.state.position.y = 205.06;
  roof.state.ground = 205;
  roof.simulateFlight(1 / 60);
  assert.equal(roof.state.onWater, false);
  assert.ok(roof.awards.includes('ROOFTOP PANCAKE'));
  assert.equal(roof.splashes.length, 0);
});

test('final terrain correction recognizes water and still creates an entry splash', () => {
  const c = fixture();
  c.state.position.y = 199.9;
  c.enforceSurfacePostcondition();
  c.ensureWaterEntrySplash(1 / 60);
  assert.equal(c.state.mode, 'planing');
  assert.equal(c.splashes.length, 1);
});

test('new water tiles are ingested without movement or a globally idle source', () => {
  const c = fixture();
  c.mappedWaterAreas.length = 0;
  c.features = [
    {
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [60, 0],
            [60, 60],
            [0, 60],
            [0, 0],
          ],
        ],
      },
    },
  ];
  assert.equal(c.refreshMappedWaterForCurrentArea(), true);
  assert.equal(c.isPointInMappedWater(20, 20), true);
  assert.equal(c.waterRefreshRequested, false);
});

test('an empty tile reload retains nearby ponds and evicts distant ones', () => {
  const c = fixture();
  c.collectMappedWaterAreas();
  assert.equal(c.isPointInMappedWater(20, 20), true);
  c.state.position.x = 5000;
  c.collectMappedWaterAreas();
  assert.equal(c.mappedWaterAreas.length, 0);
});

test('a partial tile reload retains a missing nearby pond without duplicates', () => {
  const c = fixture();
  c.features = [
    {
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [80, 0],
            [120, 0],
            [120, 60],
            [80, 60],
            [80, 0],
          ],
        ],
      },
    },
  ];
  c.collectMappedWaterAreas();
  assert.equal(c.isPointInMappedWater(20, 20), true, 'original pond stays wet');
  assert.equal(c.isPointInMappedWater(100, 20), true, 'new pond is available');
  assert.equal(c.mappedWaterAreas.length, 2);
  const generation = c.mappedWaterGeneration;
  c.collectMappedWaterAreas();
  assert.equal(c.mappedWaterAreas.length, 2, 'no duplicate water surfaces');
  assert.equal(c.mappedWaterGeneration, generation, 'no pointless rebuild');
  c.map.isSourceLoaded = () => true;
  c.collectMappedWaterAreas();
  assert.equal(
    c.mappedWaterAreas.length,
    1,
    'complete snapshots replace old geometry',
  );
});
