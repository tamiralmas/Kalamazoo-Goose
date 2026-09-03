// Builds the zoom-14 building tiles under public/buildings from the LiDAR
// height dataset produced by scripts/lidar-heights/index.html.
//
//   node scripts/build-building-tiles.mjs data/kalamazoo-buildings.json.gz
//
// Every tile that lies entirely inside the dataset's bounding box is written
// as public/buildings/14/{x}/{y}.pbf, and app/building-tiles-coverage.ts is
// rewritten with the tile range so the game knows where its own tiles end
// and the OpenFreeMap buildings take over.
//
// Feature properties mirror OpenMapTiles' building layer (render_height,
// render_min_height) because the engine and the style expressions already
// read those. Feature ids are the OSM way/relation ids.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const inputPath = process.argv[2];
if (!inputPath) {
  console.error(
    'usage: node scripts/build-building-tiles.mjs <buildings.json[.gz]>',
  );
  process.exit(1);
}

const ZOOM = 14;
const EXTENT = 4096;

/** Footprint types the LiDAR pass treats as small residential structures. */
const SMALL_RESIDENTIAL = new Set([
  'house',
  'detached',
  'residential',
  'semidetached_house',
  'terrace',
  'bungalow',
  'cabin',
  'static_caravan',
  'hut',
]);
/** Single-storey outbuildings and canopies: a tree over them is never the roof. */
const OUTBUILDINGS = new Set([
  'garage',
  'garages',
  'shed',
  'carport',
  'roof',
  'farm_auxiliary',
  'kiosk',
]);

const raw = readFileSync(inputPath);
const text = inputPath.endsWith('.gz')
  ? gunzipSync(raw).toString('utf8')
  : raw.toString('utf8');
const dataset = JSON.parse(text);
const { bbox, buildings } = dataset;
if (!bbox || !Array.isArray(buildings)) {
  throw new Error(
    'The dataset must contain {bbox: [w, s, e, n], buildings: [...]}.',
  );
}

const lngToTileX = (lng, zoom) => ((lng + 180) / 360) * 2 ** zoom;
const latToTileY = (lat, zoom) => {
  const rad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
    2 ** zoom
  );
};

// Tiles entirely inside the dataset: partial edge tiles would show a strip of
// missing buildings, so those stay with OpenFreeMap.
const minX = Math.ceil(lngToTileX(bbox[0], ZOOM));
const maxX = Math.floor(lngToTileX(bbox[2], ZOOM)) - 1;
const minY = Math.ceil(latToTileY(bbox[3], ZOOM));
const maxY = Math.floor(latToTileY(bbox[1], ZOOM)) - 1;

/** Planar footprint area in square metres (shoelace on a local tangent plane). */
const ringAreaSquareMetres = (ring) => {
  if (ring.length < 4) return 0;
  const lat0 = (ring[0][1] * Math.PI) / 180;
  const mx = 111_320 * Math.cos(lat0);
  const my = 110_574;
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0] * mx;
    const yi = ring[i][1] * my;
    const xj = ring[j][0] * mx;
    const yj = ring[j][1] * my;
    area += xj * yi - xi * yj;
  }
  return Math.abs(area) / 2;
};

const parseLevels = (value) => {
  const levels = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(levels) && levels > 0 ? levels : 0;
};

/** OSM-only estimate, used where the LiDAR did not see a roof. */
const taggedHeight = (tags) => {
  const explicit = Number.parseFloat(String(tags.height ?? ''));
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const levels = parseLevels(tags['building:levels']);
  if (levels > 0) return levels * 3.3 + 0.6;
  const type = tags.building ?? 'yes';
  if (OUTBUILDINGS.has(type)) return 3.2;
  if (SMALL_RESIDENTIAL.has(type)) return 6;
  if (type === 'apartments') return 10;
  return 5;
};

/**
 * The LiDAR pass stored percentiles of the per-cell maximum height inside
 * each footprint. The dataset has no vegetation class, so a tree hanging
 * over a house shows up as tall cells; the lower percentiles ignore that
 * for small footprints, while big buildings take a high percentile so a
 * fly tower or a hotel tower still counts.
 */
const lidarHeight = (building, area) => {
  const lidar = building.lidar;
  if (!lidar || !(lidar.cells >= 4)) return null;
  const type = building.tags.building ?? 'yes';
  let estimate;
  let cap;
  if (OUTBUILDINGS.has(type)) {
    estimate = lidar.c40;
    cap = 8;
  } else if (SMALL_RESIDENTIAL.has(type) || (type === 'yes' && area < 220)) {
    estimate = lidar.c40;
    cap = 15;
  } else if (area < 400) {
    estimate = lidar.c60;
    cap = 60;
  } else {
    estimate = lidar.c80;
    cap = 130;
  }
  if (!Number.isFinite(estimate) || estimate < 2) return null;
  // The flight is from 2015. A footprint mapped with several storeys that
  // the LiDAR saw at a fraction of that height is a building that went up
  // after the flight, standing on whatever was there before.
  const levels = parseLevels(building.tags['building:levels']);
  if (levels >= 3 && estimate < levels * 3.3 * 0.5) return levels * 3.3 + 0.6;
  return Math.min(estimate, cap);
};

let lidarCount = 0;
let taggedCount = 0;
const features = [];
for (const building of buildings) {
  const rings = building.rings;
  if (!rings?.length || rings[0].length < 4) continue;
  const area = ringAreaSquareMetres(rings[0]);
  if (area < 1) continue;
  const tags = building.tags ?? {};
  let height = lidarHeight(building, area);
  let source = 'lidar';
  if (height === null) {
    height = taggedHeight(tags);
    source = 'osm';
  } else {
    lidarCount += 1;
  }
  if (source === 'osm') taggedCount += 1;
  const minHeight = Math.max(
    0,
    Number.parseFloat(String(tags.min_height ?? '')) || 0,
  );
  const id = Number.parseInt(String(building.id).replace(/^[wr]/, ''), 10);
  features.push({
    type: 'Feature',
    id: Number.isFinite(id) ? id : undefined,
    properties: {
      render_height: Math.round(Math.max(2.6, height) * 10) / 10,
      render_min_height:
        Math.round(Math.min(minHeight, height - 0.5) * 10) / 10,
    },
    geometry: { type: 'Polygon', coordinates: rings },
  });
}

const index = geojsonvt(
  { type: 'FeatureCollection', features },
  {
    maxZoom: ZOOM,
    indexMaxZoom: ZOOM,
    indexMaxPoints: 0,
    tolerance: 1,
    extent: EXTENT,
    buffer: 64,
    lineMetrics: false,
    promoteId: null,
    generateId: false,
  },
);

const outDir = resolve(repoRoot, 'public', 'buildings');
rmSync(outDir, { recursive: true, force: true });
let tileCount = 0;
let bytes = 0;
let featureCount = 0;
for (let x = minX; x <= maxX; x += 1) {
  for (let y = minY; y <= maxY; y += 1) {
    const tile = index.getTile(ZOOM, x, y);
    if (!tile || tile.features.length === 0) continue;
    const buffer = vtpbf.fromGeojsonVt(
      { building: tile },
      { version: 2, extent: EXTENT },
    );
    const dir = resolve(outDir, String(ZOOM), String(x));
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${y}.pbf`), buffer);
    tileCount += 1;
    bytes += buffer.length;
    featureCount += tile.features.length;
  }
}

const coverage = `// Generated by scripts/build-building-tiles.mjs. Do not edit by hand.
//
// The zoom-14 tiles under public/buildings that carry the LiDAR-measured
// building heights. Tiles outside this range come from OpenFreeMap.
export const BUILDING_TILE_ZOOM = ${ZOOM};
export const BUILDING_TILE_COVERAGE = {
  minX: ${minX},
  maxX: ${maxX},
  minY: ${minY},
  maxY: ${maxY},
} as const;
`;
writeFileSync(resolve(repoRoot, 'app', 'building-tiles-coverage.ts'), coverage);

console.log(
  `buildings ${features.length} (lidar ${lidarCount}, osm-estimated ${taggedCount}); ` +
    `tiles ${tileCount} covering x ${minX}-${maxX}, y ${minY}-${maxY}; ` +
    `${featureCount} tile features, ${(bytes / 1024).toFixed(0)} KB`,
);
