import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText,
  ).toString('base64')}`;

const renderScaleSource = await read('../app/render-scale.ts');
const { resolveRenderPixelRatio } = await import(moduleUrl(renderScaleSource));
const gameSource = await read('../app/goose-game.tsx');
const engineSource = await read('../app/game-engine.ts');
const pagesHtml = await read('../github-pages/index.html');

test('mobile Auto renders fewer pixels while Crisp keeps its quality override', () => {
  const auto = resolveRenderPixelRatio('auto', 2, true, 390, 844);
  const crisp = resolveRenderPixelRatio('crisp', 2, true, 390, 844);
  assert.equal(auto, 1.35);
  assert.equal(crisp, 1.5);
  assert.ok(
    (390 * auto * 844 * auto) / (390 * crisp * 844 * crisp) < 0.82,
    'Auto should shade about 19 percent fewer pixels than mobile Crisp.',
  );
});

test('the engine bundle overlaps map loading and terrain no longer blocks for 12 seconds', () => {
  const importAt = gameSource.indexOf(
    "const engineModulePromise = import('@/app/game-engine')",
  );
  const mapAt = gameSource.indexOf('const map = new maplibre.Map');
  assert.ok(importAt >= 0 && importAt < mapAt);
  assert.match(gameSource, /const TERRAIN_READY_GRACE_MS = 1_500/);
  assert.doesNotMatch(gameSource, /TERRAIN_READY_DEADLINE_MS|12_000/);
});

test('only a confirmed terrain failure disables the late-loading DEM', () => {
  const disableAt = gameSource.indexOf('const disableTerrain = () =>');
  const errorAt = gameSource.indexOf('const onTerrainTileError =');
  const timerAt = gameSource.indexOf('terrainTimer = window.setTimeout');
  assert.ok(disableAt >= 0 && errorAt > disableAt && timerAt > errorAt);
  assert.match(
    gameSource,
    /const disableTerrain = \(\) => \{[\s\S]*?map\.setTerrain\(null\);[\s\S]*?map\.removeSource\('wmug-terrain-dem'\);[\s\S]*?terrainConfigured = false;/,
  );
  assert.match(
    gameSource,
    /const onTerrainTileError = [\s\S]*?sourceId === 'wmug-terrain-dem'\) \{[\s\S]*?disableTerrain\(\);[\s\S]*?finishWorld\(false\);/,
  );
  const timerBlock = gameSource.slice(timerAt, timerAt + 180);
  assert.match(timerBlock, /\(\) => finishWorld\(false\)/);
  assert.doesNotMatch(timerBlock, /disableTerrain/);
});

test('GitHub Pages connects critical map hosts and preloads the WMU terrain tile', () => {
  assert.match(
    pagesHtml,
    /preconnect" href="https:\/\/tiles\.openfreemap\.org"/,
  );
  assert.match(
    pagesHtml,
    /preconnect" href="https:\/\/tiles\.mapterhorn\.com"/,
  );
  assert.match(
    pagesHtml,
    /preload"[\s\S]*?href="https:\/\/tiles\.mapterhorn\.com\/16\/17181\/24258\.webp"/,
  );
});

test('touch devices rescan buildings less often without changing event triggers', () => {
  assert.match(engineSource, /BUILDING_RESCAN_INTERVAL_DESKTOP = 2/);
  assert.match(engineSource, /BUILDING_RESCAN_INTERVAL_TOUCH = 4/);
  assert.match(
    engineSource,
    /const buildingRescanInterval = coarsePointer[\s\S]*?BUILDING_RESCAN_INTERVAL_TOUCH[\s\S]*?BUILDING_RESCAN_INTERVAL_DESKTOP/,
  );
  assert.match(engineSource, /buildingRescanClock = buildingRescanInterval/);
  assert.match(engineSource, /BUILDING_RESCAN_DISTANCE = 240/);
  assert.match(engineSource, /buildingRefreshRequested = true/);
});
