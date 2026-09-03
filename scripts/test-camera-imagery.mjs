import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Import the production controller without a browser or emitted build files.
const readApp = (name) =>
  readFileSync(new URL(`../app/${name}`, import.meta.url), 'utf8');
const transpile = (source, module = ts.ModuleKind.ESNext) =>
  ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module },
  }).outputText;
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(transpile(source)).toString('base64')}`;
const imageryUrl = moduleUrl(readApp('world-imagery.ts'));
const { AERIAL_TILE_TEMPLATE, AERIAL_BOUNDS, AERIAL_ATTRIBUTION } =
  await import(imageryUrl);
const {
  AERIAL_FALLBACK_SOURCE_ID: fallbackId,
  AERIAL_DETAIL_SOURCE_ID: detailId,
  AERIAL_FALLBACK_MAX_ZOOM,
  AERIAL_GROUND_COLOR,
  aerialTileRetentionOptions,
  createAerialImagery,
} = await import(
  moduleUrl(
    readApp('aerial-imagery.ts').replace(
      "'./world-imagery'",
      JSON.stringify(imageryUrl),
    ),
  )
);

function mapFixture(coarsePointer) {
  const sources = new Map();
  const layers = [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#f8f4f0' },
    },
    { id: 'roads', type: 'line' },
    { id: 'game', type: 'custom' },
  ];
  const calls = [];
  const map = {
    getSource: (id) => sources.get(id),
    getStyle: () => ({ layers }),
    addSource(id, source) {
      assert.ok(!sources.has(id), `Duplicate source ${id}`);
      sources.set(id, source);
      calls.push(['source', id]);
    },
    addLayer(layer, before) {
      assert.ok(
        sources.has(layer.source),
        'Source must exist before its layer',
      );
      assert.ok(!layers.some(({ id }) => id === layer.id));
      const index =
        before === undefined
          ? layers.length
          : layers.findIndex(({ id }) => id === before);
      assert.ok(index >= 0, `Missing insertion anchor ${before}`);
      layers.splice(index, 0, layer);
      calls.push(['layer', layer.id]);
    },
    setPaintProperty(id, property, value) {
      const layer = layers.find((candidate) => candidate.id === id);
      assert.ok(layer, `Missing layer ${id}`);
      layer.paint ??= {};
      layer.paint[property] = value;
    },
  };
  const beforeLayer = () =>
    layers.find(
      (layer) =>
        layer.type !== 'background' &&
        layer.id !== fallbackId &&
        layer.id !== detailId,
    )?.id;
  return {
    sources,
    layers,
    calls,
    imagery: createAerialImagery(map, coarsePointer, beforeLayer),
  };
}

test('mobile starts with a capped original-imagery fallback, then adds full detail above it', () => {
  const { imagery, sources, layers, calls } = mapFixture(true);
  imagery.installFallback();
  assert.equal(sources.size, 1);
  const fallback = sources.get(fallbackId);
  assert.equal(fallback.tileSize, 512);
  assert.equal(fallback.maxzoom, 15);
  assert.equal(AERIAL_FALLBACK_MAX_ZOOM, 15);
  assert.deepEqual(fallback.tiles, [AERIAL_TILE_TEMPLATE]);
  assert.match(AERIAL_TILE_TEMPLATE, /^https:\/\/imagery\.michigan\.gov\//);
  imagery.installDetailed();
  const detailed = sources.get(detailId);
  assert.equal(detailed.tileSize, 256);
  assert.equal(detailed.maxzoom, 19);
  assert.deepEqual(detailed.tiles, fallback.tiles);
  assert.deepEqual(detailed.bounds, AERIAL_BOUNDS);
  assert.equal(detailed.attribution, AERIAL_ATTRIBUTION);
  assert.deepEqual(
    layers.map(({ id }) => id),
    ['background', fallbackId, detailId, 'roads', 'game'],
  );
  assert.deepEqual(calls, [
    ['source', fallbackId],
    ['layer', fallbackId],
    ['source', detailId],
    ['layer', detailId],
  ]);
});

test('desktop also keeps a same-provider fallback beneath detailed imagery', () => {
  const { imagery, sources, layers } = mapFixture(false);
  imagery.installDetailed();
  assert.equal(sources.size, 2);
  assert.deepEqual(sources.get(fallbackId).tiles, sources.get(detailId).tiles);
  assert.ok(
    layers.findIndex(({ id }) => id === fallbackId) <
      layers.findIndex(({ id }) => id === detailId),
  );
  for (const id of [fallbackId, detailId]) {
    assert.equal(
      layers.find((layer) => layer.id === id).paint['raster-opacity'],
      1,
    );
  }
});

test('repeated installation never removes or recreates the fallback or duplicates layers', () => {
  for (const coarsePointer of [false, true]) {
    const { imagery, sources, layers, calls } = mapFixture(coarsePointer);
    imagery.installDetailed();
    const fallback = sources.get(fallbackId);
    const detail = sources.get(detailId);
    for (let index = 0; index < 12; index += 1) {
      imagery.installFallback();
      imagery.installDetailed();
    }
    assert.equal(sources.get(fallbackId), fallback);
    assert.equal(sources.get(detailId), detail);
    assert.equal(sources.size, 2);
    assert.equal(calls.length, 4);
    assert.equal(layers.filter(({ type }) => type === 'raster').length, 2);
  }
});

test('missing imagery exposes an opaque muted ground color, not white', () => {
  const { imagery, layers } = mapFixture(true);
  imagery.installFallback();
  const background = layers.find(({ type }) => type === 'background');
  assert.equal(background.paint['background-color'], AERIAL_GROUND_COLOR);
  assert.equal(background.paint['background-opacity'], 1);
  assert.match(AERIAL_GROUND_COLOR, /^#[\da-f]{6}$/i);
  const rgb = AERIAL_GROUND_COLOR.slice(1)
    .match(/../g)
    .map((channel) => parseInt(channel, 16));
  assert.ok(
    Math.max(...rgb) < 180,
    'Fallback must not recreate the near-white blank tiles',
  );
  assert.ok(
    rgb[1] > rgb[0] && rgb[1] > rgb[2],
    'Fallback should read as muted ground',
  );
});

test('continuous chase zoom retains pending parents with bounded mobile cache growth', () => {
  assert.deepEqual(aerialTileRetentionOptions(true), {
    cancelPendingTileRequestsWhileZooming: false,
    maxTileCacheZoomLevels: 4,
  });
  assert.deepEqual(aerialTileRetentionOptions(false), {
    cancelPendingTileRequestsWhileZooming: false,
    maxTileCacheZoomLevels: 5,
  });
});

// Evaluate the real camera initializers and reset body in a small fixture.
// For the full game reset, run its actual camera assignment statements only,
// leaving NPC/audio/world reconstruction outside this focused regression.
const engine = ts.createSourceFile(
  'game-engine.ts',
  readApp('game-engine.ts'),
  ts.ScriptTarget.Latest,
  true,
);
const declarations = new Map();
let resetCamera;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
    declarations.set(node.name.text, node);
  if (
    ts.isMethodDeclaration(node) &&
    node.name.getText(engine) === 'resetCamera'
  )
    resetCamera = node;
  ts.forEachChild(node, visit);
}
visit(engine);
const cameraNames = [
  'cameraDistanceScale',
  'cameraDistanceTarget',
  'cameraOrbitYaw',
  'cameraOrbitYawTarget',
  'cameraOrbitPitch',
  'cameraOrbitPitchTarget',
];
function cameraFixture() {
  const context = vm.createContext({
    Math,
    map: { triggerRepaint() {} },
    renderState: {},
    updateCamera() {},
  });
  const names = [
    'DEG',
    'DEFAULT_CAMERA_SCALE',
    'DEFAULT_CAMERA_PITCH',
    ...cameraNames,
  ];
  const code = names
    .map((name) => {
      const declaration = declarations.get(name);
      assert.ok(
        declaration?.initializer,
        `Missing production camera initializer ${name}`,
      );
      return `var ${name} = ${declaration.initializer.getText(engine)};`;
    })
    .join('\n');
  vm.runInContext(transpile(code, ts.ModuleKind.None), context);
  return context;
}
function assertDefaultCamera(context) {
  assert.ok(Math.abs(context.cameraOrbitPitch / context.DEG - 16) < 1e-10);
  assert.equal(context.cameraOrbitPitchTarget, context.cameraOrbitPitch);
  assert.equal(Math.round(100 / context.cameraDistanceScale), 70);
  assert.equal(context.cameraDistanceTarget, context.cameraDistanceScale);
  assert.equal(context.cameraOrbitYaw, 0);
  assert.equal(context.cameraOrbitYawTarget, 0);
}
function orbitAway(context) {
  for (const name of cameraNames) context[name] = 2.5;
}

test('initial camera is a shallower 16 degrees while preserving 70 percent zoom', () => {
  assertDefaultCamera(cameraFixture());
});

test('reset-camera restores the same 16-degree angle and 70 percent zoom', () => {
  const context = cameraFixture();
  orbitAway(context);
  assert.ok(resetCamera?.body, 'Production resetCamera method must exist');
  vm.runInContext(
    transpile(resetCamera.body.getText(engine), ts.ModuleKind.None),
    context,
  );
  assertDefaultCamera(context);
});

test('new-game reset restores both current and target camera settings', () => {
  const context = cameraFixture();
  orbitAway(context);
  const initializer = declarations.get('resetState')?.initializer;
  assert.ok(
    initializer &&
      ts.isArrowFunction(initializer) &&
      ts.isBlock(initializer.body),
  );
  const assignments = initializer.body.statements.filter(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(statement.expression.left) &&
      cameraNames.includes(statement.expression.left.text),
  );
  assert.equal(assignments.length, cameraNames.length);
  vm.runInContext(
    transpile(
      assignments.map((node) => node.getText(engine)).join('\n'),
      ts.ModuleKind.None,
    ),
    context,
  );
  assertDefaultCamera(context);
});
