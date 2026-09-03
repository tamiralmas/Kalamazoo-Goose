// Packs the LiDAR tree dataset produced by scripts/lidar-trees/index.html
// into the zoom-14 binary tiles under public/trees that the engine streams
// (layout in app/tree-tiles-coverage.ts, which this also rewrites).
//
//   node scripts/build-tree-tiles.mjs data/kalamazoo-trees.json.gz

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const inputPath = process.argv[2];
if (!inputPath) {
  console.error('usage: node scripts/build-tree-tiles.mjs <trees.json[.gz]>');
  process.exit(1);
}

const MAGIC = 'KGT1';
const RECORD_BYTES = 12;
const HEADER_BYTES = 8;
const UNIT = 0.25;

const raw = readFileSync(inputPath);
const text = inputPath.endsWith('.gz')
  ? gunzipSync(raw).toString('utf8')
  : raw.toString('utf8');
const dataset = JSON.parse(text);
const { tiles, trees } = dataset;
if (!tiles || !Array.isArray(trees)) {
  throw new Error('The dataset must contain {tiles: {zoom, minX, maxX, minY, maxY}, trees: [...]}.');
}
const { zoom, minX, maxX, minY, maxY } = tiles;

const lngToTileX = (lng) => Math.floor(((lng + 180) / 360) * 2 ** zoom);
const latToTileY = (lat) => {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
      2 ** zoom,
  );
};

const byTile = new Map();
for (const tree of trees) {
  const [lng, lat, height, radius, fullness] = tree;
  const x = lngToTileX(lng);
  const y = latToTileY(lat);
  if (x < minX || x > maxX || y < minY || y > maxY) continue;
  const key = `${x}/${y}`;
  let list = byTile.get(key);
  if (!list) byTile.set(key, (list = []));
  list.push({ lng, lat, height, radius, fullness });
}

const outDir = resolve(repoRoot, 'public', 'trees');
rmSync(outDir, { recursive: true, force: true });
let written = 0;
let bytes = 0;
let largest = 0;
for (const [key, list] of byTile) {
  list.sort((a, b) => b.height - a.height);
  const buffer = Buffer.alloc(HEADER_BYTES + list.length * RECORD_BYTES);
  buffer.write(MAGIC, 0, 'ascii');
  buffer.writeUInt32LE(list.length, 4);
  list.forEach((tree, index) => {
    const offset = HEADER_BYTES + index * RECORD_BYTES;
    buffer.writeInt32LE(Math.round(tree.lng * 1e7), offset);
    buffer.writeInt32LE(Math.round(tree.lat * 1e7), offset + 4);
    buffer.writeUInt8(Math.min(255, Math.round(tree.height / UNIT)), offset + 8);
    buffer.writeUInt8(Math.min(255, Math.round(tree.radius / UNIT)), offset + 9);
    buffer.writeUInt8(Math.max(0, Math.min(255, Math.round(tree.fullness))), offset + 10);
    buffer.writeUInt8(0, offset + 11);
  });
  const [x, y] = key.split('/');
  const dir = resolve(outDir, String(zoom), x);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${y}.bin`), buffer);
  written += 1;
  bytes += buffer.length;
  largest = Math.max(largest, list.length);
}

const coveragePath = resolve(repoRoot, 'app', 'tree-tiles-coverage.ts');
const coverage = readFileSync(coveragePath, 'utf8').replace(
  /export const TREE_TILE_COVERAGE = \{[\s\S]*?\} as const;/,
  `export const TREE_TILE_COVERAGE = {
  minX: ${minX},
  maxX: ${maxX},
  minY: ${minY},
  maxY: ${maxY},
} as const;`,
);
writeFileSync(coveragePath, coverage);

console.log(
  `trees ${trees.length} in ${written} tiles (largest ${largest}), ${(bytes / 1024).toFixed(0)} KB; coverage x ${minX}-${maxX}, y ${minY}-${maxY}`,
);
