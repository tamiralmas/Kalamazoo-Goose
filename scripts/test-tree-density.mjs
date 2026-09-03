import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { MercatorCoordinate } from 'maplibre-gl';
import ts from 'typescript';

// Run the production TypeScript without emitting build files or adding a runner.
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText,
  ).toString('base64')}`;
const coverageUrl = moduleUrl(
  await readFile(
    new URL('../app/tree-tiles-coverage.ts', import.meta.url),
    'utf8',
  ),
);
const { TREE_TILE_COVERAGE } = await import(coverageUrl);
const treeSource = await readFile(
  new URL('../app/tree-tiles.ts', import.meta.url),
  'utf8',
);
const {
  TREE_DENSITY_SCALE,
  retainTreeAtDensity,
  parseTreeTile,
  createTreeTileStore,
  createTreeSelection,
} = await import(
  moduleUrl(
    treeSource.replace("'./tree-tiles-coverage'", JSON.stringify(coverageUrl)),
  )
);
const { WMU_SPAWN } = await import(
  moduleUrl(
    await readFile(new URL('../app/world-config.ts', import.meta.url), 'utf8'),
  )
);
const origin = MercatorCoordinate.fromLngLat(WMU_SPAWN, 0);
const metreScale = origin.meterInMercatorCoordinateUnits();
const toLocal = (longitude, latitude, out) => {
  const coordinate = MercatorCoordinate.fromLngLat([longitude, latitude], 0);
  out.x = (coordinate.x - origin.x) / metreScale;
  out.z = (origin.y - coordinate.y) / metreScale;
  return out;
};
const treeRoot = new URL('../public/trees/14/', import.meta.url);
const files = (await readdir(treeRoot, { recursive: true }))
  .filter((file) => file.endsWith('.bin'))
  .sort();
const preloadFiles = files.toSorted((first, second) => {
  const [firstX, firstYWithExtension] = first.split(/[\\/]/);
  const [secondX, secondYWithExtension] = second.split(/[\\/]/);
  const firstY = firstYWithExtension.replace('.bin', '');
  const secondY = secondYWithExtension.replace('.bin', '');
  const centerX = (TREE_TILE_COVERAGE.minX + TREE_TILE_COVERAGE.maxX) / 2;
  const centerY = (TREE_TILE_COVERAGE.minY + TREE_TILE_COVERAGE.maxY) / 2;
  return (
    Math.abs(Number(firstX) - centerX) +
      Math.abs(Number(firstY) - centerY) -
      Math.abs(Number(secondX) - centerX) -
      Math.abs(Number(secondY) - centerY) ||
    Number(firstX) - Number(secondX) ||
    Number(firstY) - Number(secondY)
  );
});
const tiles = await Promise.all(
  files.map(async (file) => {
    const bytes = await readFile(new URL(file.replaceAll('\\', '/'), treeRoot));
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    return { buffer, parsed: parseTreeTile(buffer) };
  }),
);
const retainedCount = (tile) => {
  let count = 0;
  const local = { x: 0, z: 0 };
  for (let index = 0; index < tile.count; index += 1) {
    toLocal(tile.longitude[index], tile.latitude[index], local);
    if (retainTreeAtDensity(local.x, local.z)) count += 1;
  }
  return count;
};

test('tree budgets and all mapped LiDAR locations are reduced by 20%', () => {
  assert.equal(TREE_DENSITY_SCALE, 0.8);
  assert.equal(Math.floor(3_600 * TREE_DENSITY_SCALE), 2_880);
  assert.equal(Math.floor(1_000 * TREE_DENSITY_SCALE), 800);
  const original = tiles.reduce((sum, { parsed }) => sum + parsed.count, 0);
  const retained = tiles.reduce(
    (sum, { parsed }) => sum + retainedCount(parsed),
    0,
  );
  assert.ok(
    original > 100_000,
    'Exercise the actual campus/world tree dataset.',
  );
  assert.ok(Math.abs(retained / original - 0.8) < 0.005);
  console.log(
    `LiDAR density: ${original} → ${retained} (${((1 - retained / original) * 100).toFixed(2)}% fewer trees).`,
  );
});

test('density decisions depend only on position, not the traversal order', () => {
  const points = Array.from({ length: 10_000 }, (_, index) => [
    (index % 100) * 13.5 - 675,
    Math.floor(index / 100) * 13.5 - 675,
  ]);
  const original = points.map(([east, north]) =>
    retainTreeAtDensity(east, north),
  );
  const revisited = points
    .toReversed()
    .map(([east, north]) => retainTreeAtDensity(east, north))
    .toReversed();
  assert.deepEqual(revisited, original);
  assert.ok(
    Math.abs(original.filter(Boolean).length / points.length - 0.8) < 0.02,
  );
});

test('the store preloads compact tiles once and only ingests requested data', async () => {
  const requested = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let releaseFirstRequest;
  const firstRequestGate = new Promise((resolve) => {
    releaseFirstRequest = resolve;
  });
  const emptyTile = new Uint8Array(8);
  emptyTile.set([0x4b, 0x47, 0x54, 0x31]); // KGT1, followed by a zero count.
  const store = createTreeTileStore({
    base: '/Kalamazoo-Goose/',
    toLocal,
    fetchTile: async (url) => {
      requested.push(url);
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        if (requested.length === 1) await firstRequestGate;
        return new Response(emptyTile);
      } finally {
        activeRequests -= 1;
      }
    },
    scheduleSlice: (run) => run(),
  });
  try {
    const firstWarmup = store.preloadAll();
    assert.equal(
      store.preloadAll(),
      firstWarmup,
      'Repeated calls share one background warm-up.',
    );
    assert.deepEqual(store.stats(), { tiles: 0, pending: 1, trees: 0 });

    // Asking for the first tile while its preload is held must share the
    // in-flight promise rather than issuing a duplicate request. The other
    // nineteen buffers remain compact and unindexed after the warm-up.
    const [firstX, firstYWithExtension] = preloadFiles[0].split(/[\\/]/);
    const firstY = firstYWithExtension.replace('.bin', '');
    const span = 2 ** 14;
    const longitude = ((Number(firstX) + 0.5) / span) * 360 - 180;
    const mercator = Math.PI - (2 * Math.PI * (Number(firstY) + 0.5)) / span;
    const latitude = (180 / Math.PI) * Math.atan(Math.sinh(mercator));
    store.request(longitude, latitude, 0);
    assert.equal(requested.length, 1);

    releaseFirstRequest();
    await firstWarmup;
    assert.equal(maxActiveRequests, 1);
    assert.deepEqual(
      requested,
      preloadFiles.map(
        (file) => `/Kalamazoo-Goose/trees/14/${file.replaceAll('\\', '/')}`,
      ),
    );
    assert.deepEqual(store.stats(), {
      tiles: 1,
      pending: 0,
      trees: 0,
    });
  } finally {
    store.dispose();
  }
});

test('the real tile store thins before indexing and keeps selection stable', async () => {
  const tile = tiles.reduce((best, item) =>
    item.parsed.count > best.parsed.count ? item : best,
  );
  let served = false;
  const store = createTreeTileStore({
    base: '/',
    toLocal,
    fetchTile: async () => {
      if (served) return new Response(null, { status: 404 });
      served = true;
      return new Response(tile.buffer);
    },
    scheduleSlice: (run) => run(),
  });
  try {
    store.request(...WMU_SPAWN, 10_000);
    while (store.stats().pending > 0) await setImmediate();
    const expected = retainedCount(tile.parsed);
    assert.equal(store.stats().trees, expected);
    const all = createTreeSelection(tile.parsed.count);
    store.query(0, 0, 20_000, all);
    assert.equal(
      all.count,
      expected,
      'In-range omissions are thinning, not a shorter radius.',
    );
    const desktop = createTreeSelection(Math.floor(3_600 * TREE_DENSITY_SCALE));
    store.query(0, 0, 20_000, desktop);
    assert.equal(desktop.count, 2_880);
    const first = Array.from(desktop.ids);
    store.query(250, 250, 20_000, desktop);
    store.query(0, 0, 20_000, desktop);
    assert.deepEqual(Array.from(desktop.ids), first);
    const phone = createTreeSelection(Math.floor(1_000 * TREE_DENSITY_SCALE));
    store.query(0, 0, 20_000, phone);
    assert.equal(phone.count, 800);
  } finally {
    store.dispose();
  }
});
