import {
  TREE_TILE_COVERAGE,
  TREE_TILE_HEADER_BYTES,
  TREE_TILE_MAGIC,
  TREE_TILE_METRIC_UNIT,
  TREE_TILE_RECORD_BYTES,
  TREE_TILE_ZOOM,
} from './tree-tiles-coverage';

/**
 * The LiDAR trees, streamed as zoom-14 tiles.
 *
 * Inside the coverage rectangle every tree the 2015 flight found is on disk:
 * five to twenty thousand per tile, a quarter of a million in total. The
 * engine can draw a couple of thousand of them, so the loader's whole job is
 * to make "the trees nearest the goose, tallest first inside a band" cheap
 * enough to answer on the tree refresh tick and never on a frame.
 *
 * The compact binary tiles can all be warmed into memory in the background.
 * A tile is parsed and indexed only when the goose gets near it, then kept
 * because the goose may cross that ground again. Conversion to the engine's
 * local metres happens at ingest, in slices, so a dense tile never lands as
 * one long task in the middle of a flight.
 */

/** Spatial index cell, metres. A little wider than the crown of one tree. */
const GRID_CELL_METRES = 60;

/** Keep 80% of tree locations and of the renderer's original instance budget. */
export const TREE_DENSITY_SCALE = 0.8;

/**
 * Thin by fixed world coordinates, never by frame, query order or tile arrival.
 * The same trees stay absent on every visit; all sources share this rule.
 */
export const retainTreeAtDensity = (east: number, north: number) => {
  let hash =
    Math.imul(Math.round(east * 10), 0x45d9f3b) ^
    Math.imul(Math.round(north * 10), 0x27d4eb2d);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4_294_967_296 < TREE_DENSITY_SCALE;
};

/**
 * Ranking band, metres. Within one band of distance the taller tree wins, so
 * a stand of mature oaks fills the budget ahead of the saplings beneath them
 * while the far woods still lose to the near ones.
 */
const RANK_BAND_METRES = 45;

/** Trees converted and indexed per task, so a dense tile never blocks a frame. */
const INGEST_SLICE = 3_000;

/** Growth step for the flat tree store, in trees. */
const STORE_GROWTH_MINIMUM = 8_192;

/**
 * Index bits in a packed sort key. The rank rides above these, so one numeric
 * sort orders the candidates without a comparator or a pair of objects.
 */
const RANK_INDEX_STRIDE = 4_194_304;

/** Give up on a tile after this many failed requests (a 404 is not a failure). */
const TILE_FETCH_ATTEMPTS = 3;

/** Metres per degree of latitude, and of longitude at the equator. */
const METRES_PER_DEGREE_LATITUDE = 110_574;
const METRES_PER_DEGREE_LONGITUDE = 111_320;

const TILE_SPAN = 2 ** TREE_TILE_ZOOM;

/** Web Mercator tile column of a longitude, at the tree tile zoom. */
export const treeTileX = (longitude: number) =>
  Math.floor(((longitude + 180) / 360) * TILE_SPAN);

/** Web Mercator tile row of a latitude, at the tree tile zoom. */
export const treeTileY = (latitude: number) => {
  // The Mercator projection runs away at the poles; the coverage is in
  // Michigan, so clamping to the tile scheme's own limit is enough.
  const clamped = Math.min(85.0511, Math.max(-85.0511, latitude));
  const radians = (clamped * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) *
      TILE_SPAN,
  );
};

const tileWestLongitude = (x: number) => (x / TILE_SPAN) * 360 - 180;
const tileNorthLatitude = (y: number) =>
  (180 / Math.PI) *
  Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / TILE_SPAN));

/**
 * The lon/lat rectangle the tiles cover. The engine turns this into a local
 * metre rectangle once and uses it to decide where the LiDAR trees replace
 * the OpenStreetMap woodland scan.
 */
export const TREE_TILE_BOUNDS = {
  west: tileWestLongitude(TREE_TILE_COVERAGE.minX),
  east: tileWestLongitude(TREE_TILE_COVERAGE.maxX + 1),
  north: tileNorthLatitude(TREE_TILE_COVERAGE.minY),
  south: tileNorthLatitude(TREE_TILE_COVERAGE.maxY + 1),
} as const;

export const inTreeTileCoverage = (x: number, y: number) =>
  x >= TREE_TILE_COVERAGE.minX &&
  x <= TREE_TILE_COVERAGE.maxX &&
  y >= TREE_TILE_COVERAGE.minY &&
  y <= TREE_TILE_COVERAGE.maxY;

/** One tile's records, straight out of the file and still in lon/lat. */
export type ParsedTreeTile = {
  count: number;
  longitude: Float64Array;
  latitude: Float64Array;
  /** Canopy top above ground, metres. */
  height: Float32Array;
  crownRadius: Float32Array;
  /** Share of crown cells that returned points, 0..1. */
  fullness: Float32Array;
};

const MAGIC_BYTES = [
  TREE_TILE_MAGIC.charCodeAt(0),
  TREE_TILE_MAGIC.charCodeAt(1),
  TREE_TILE_MAGIC.charCodeAt(2),
  TREE_TILE_MAGIC.charCodeAt(3),
];

/**
 * Decode one tile. Throws on anything that is not a KGT1 tile so a truncated
 * download is dropped rather than planted as a forest at the equator.
 */
export const parseTreeTile = (buffer: ArrayBuffer): ParsedTreeTile => {
  if (buffer.byteLength < TREE_TILE_HEADER_BYTES)
    throw new Error('Tree tile shorter than its header.');
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < MAGIC_BYTES.length; index += 1) {
    if (bytes[index] !== MAGIC_BYTES[index])
      throw new Error('Tree tile is not a KGT1 tile.');
  }
  const view = new DataView(buffer);
  const count = view.getUint32(4, true);
  const needed = TREE_TILE_HEADER_BYTES + count * TREE_TILE_RECORD_BYTES;
  if (buffer.byteLength < needed)
    throw new Error(
      `Tree tile holds ${buffer.byteLength} bytes, needs ${needed}.`,
    );
  const longitude = new Float64Array(count);
  const latitude = new Float64Array(count);
  const height = new Float32Array(count);
  const crownRadius = new Float32Array(count);
  const fullness = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const offset = TREE_TILE_HEADER_BYTES + index * TREE_TILE_RECORD_BYTES;
    longitude[index] = view.getInt32(offset, true) / 1e7;
    latitude[index] = view.getInt32(offset + 4, true) / 1e7;
    height[index] = view.getUint8(offset + 8) * TREE_TILE_METRIC_UNIT;
    crownRadius[index] = view.getUint8(offset + 9) * TREE_TILE_METRIC_UNIT;
    fullness[index] = view.getUint8(offset + 10) / 255;
  }
  return { count, longitude, latitude, height, crownRadius, fullness };
};

/** A reusable answer buffer, so a selection pass allocates nothing. */
export type TreeSelection = {
  count: number;
  /** Stable per-tree ids, unique for the life of the store. */
  ids: Int32Array;
  east: Float32Array;
  north: Float32Array;
  /** Canopy top above ground, metres. */
  height: Float32Array;
  crownRadius: Float32Array;
  /** Share of crown cells that returned points, 0..1. */
  fullness: Float32Array;
};

export const createTreeSelection = (capacity: number): TreeSelection => ({
  count: 0,
  ids: new Int32Array(capacity),
  east: new Float32Array(capacity),
  north: new Float32Array(capacity),
  height: new Float32Array(capacity),
  crownRadius: new Float32Array(capacity),
  fullness: new Float32Array(capacity),
});

export type TreeTileStore = {
  /** Rises whenever trees land, so a caller knows its selection is stale. */
  readonly generation: number;
  /** True while the point sits inside the tiled rectangle. */
  covers(longitude: number, latitude: number): boolean;
  /**
   * Fetch the complete packaged data set into a compact background cache.
   *
   * Tiles advance one at a time and are not parsed or indexed until `request`
   * needs them near the goose. Repeated calls share the same warm-up rather
   * than downloading the data again.
   */
  preloadAll(): Promise<void>;
  /** Start fetching the tiles within `radius` metres. Never blocks. */
  request(longitude: number, latitude: number, radius: number): void;
  /** Fill `out` with the trees within `radius` of a local point, best first. */
  query(east: number, north: number, radius: number, out: TreeSelection): void;
  stats(): { tiles: number; pending: number; trees: number };
  dispose(): void;
};

export type TreeTileStoreOptions = {
  /** Path the site is served from ("/" or "/Kalamazoo-Goose/"). */
  base: string;
  /** The engine's lon/lat to local metres conversion, without the Vector3. */
  toLocal: (
    longitude: number,
    latitude: number,
    out: { x: number; z: number },
  ) => { x: number; z: number };
  /** Injected by the tests; the browser's fetch otherwise. */
  fetchTile?: (url: string, signal: AbortSignal) => Promise<Response>;
  /** Injected by the tests, which want the ingest to finish synchronously. */
  scheduleSlice?: (run: () => void) => void;
};

const defaultFetchTile = (url: string, signal: AbortSignal) =>
  fetch(url, { signal });

// Prefer true browser idle time, with a short deadline so a busy animation
// cannot starve nearby trees forever. The fallback is still a macrotask, not
// a microtask: microtasks all run before the browser gets the thread back, so
// slicing across them would still land as one long task.
const defaultScheduleSlice = (run: () => void) => {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(run, { timeout: 100 });
    return;
  }
  setTimeout(run, 0);
};

export const createTreeTileStore = ({
  base,
  toLocal,
  fetchTile = defaultFetchTile,
  scheduleSlice = defaultScheduleSlice,
}: TreeTileStoreOptions): TreeTileStore => {
  const aborter = new AbortController();
  let generation = 0;
  let count = 0;
  let capacity = 0;
  let east = new Float32Array(0);
  let north = new Float32Array(0);
  let heightCode = new Uint8Array(0);
  let crownCode = new Uint8Array(0);
  let fullnessCode = new Uint8Array(0);
  // Cell key to the tree indices inside it. Tiles are never dropped, so an
  // index stays valid for the life of the store and the grid only grows.
  const grid = new Map<number, number[]>();
  const attempts = new Map<number, number>();
  /** Compact fetched bytes waiting for a proximity request. */
  const prefetched = new Map<number, ArrayBuffer>();
  /** Successful 404/204 answers, also consumed only by a proximity request. */
  const knownEmpty = new Set<number>();
  const loaded = new Set<number>();
  // Keeping both promises lets background prefetch and proximity loading
  // share a download, while repeated proximity passes also share one ingest.
  const fetchInFlight = new Map<number, Promise<void>>();
  const ingestInFlight = new Map<number, Promise<void>>();
  const scratchLocal = { x: 0, z: 0 };
  let sortKeys = new Float64Array(0);
  let preloadPromise: Promise<void> | null = null;

  // Cell coordinates are signed and small (the coverage is nine kilometres
  // across), so one shifted product keys the grid without a string.
  const cellKey = (cellX: number, cellZ: number) =>
    (cellX + 32_768) * 65_536 + (cellZ + 32_768);
  const tileKey = (x: number, y: number) => x * 65_536 + y;

  const grow = (needed: number) => {
    if (needed <= capacity) return;
    let next = Math.max(capacity * 2, STORE_GROWTH_MINIMUM);
    while (next < needed) next *= 2;
    const nextEast = new Float32Array(next);
    const nextNorth = new Float32Array(next);
    const nextHeight = new Uint8Array(next);
    const nextCrown = new Uint8Array(next);
    const nextFullness = new Uint8Array(next);
    nextEast.set(east.subarray(0, count));
    nextNorth.set(north.subarray(0, count));
    nextHeight.set(heightCode.subarray(0, count));
    nextCrown.set(crownCode.subarray(0, count));
    nextFullness.set(fullnessCode.subarray(0, count));
    east = nextEast;
    north = nextNorth;
    heightCode = nextHeight;
    crownCode = nextCrown;
    fullnessCode = nextFullness;
    capacity = next;
  };

  const appendRange = (tile: ParsedTreeTile, from: number, to: number) => {
    grow(count + (to - from));
    for (let index = from; index < to; index += 1) {
      const local = toLocal(
        tile.longitude[index],
        tile.latitude[index],
        scratchLocal,
      );
      if (!retainTreeAtDensity(local.x, local.z)) continue;
      const slot = count;
      east[slot] = local.x;
      north[slot] = local.z;
      heightCode[slot] = Math.min(
        255,
        Math.round(tile.height[index] / TREE_TILE_METRIC_UNIT),
      );
      crownCode[slot] = Math.min(
        255,
        Math.round(tile.crownRadius[index] / TREE_TILE_METRIC_UNIT),
      );
      fullnessCode[slot] = Math.min(
        255,
        Math.round(tile.fullness[index] * 255),
      );
      count += 1;
      const key = cellKey(
        Math.floor(local.x / GRID_CELL_METRES),
        Math.floor(local.z / GRID_CELL_METRES),
      );
      const cell = grid.get(key);
      if (cell) cell.push(slot);
      else grid.set(key, [slot]);
    }
    generation += 1;
  };

  const ingest = (tile: ParsedTreeTile) =>
    new Promise<void>((resolve) => {
      const step = (from: number) => {
        if (aborter.signal.aborted) {
          resolve();
          return;
        }
        const to = Math.min(tile.count, from + INGEST_SLICE);
        appendRange(tile, from, to);
        if (to < tile.count) scheduleSlice(() => step(to));
        else resolve();
      };
      step(0);
    });

  const prefetch = (x: number, y: number) => {
    const key = tileKey(x, y);
    if (loaded.has(key) || prefetched.has(key) || knownEmpty.has(key))
      return Promise.resolve();
    const pending = fetchInFlight.get(key);
    if (pending) return pending;
    if ((attempts.get(key) ?? 0) >= TILE_FETCH_ATTEMPTS)
      return Promise.resolve();
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    let response: Promise<Response>;
    try {
      response = fetchTile(
        `${base}trees/${TREE_TILE_ZOOM}/${x}/${y}.bin`,
        aborter.signal,
      );
    } catch {
      // A test adapter can throw before returning a promise. Treat it like a
      // rejected fetch so the bounded retry rule stays true for every caller.
      return Promise.resolve();
    }
    const request = response
      .then(async (response) => {
        // A missing tile is an answer, not a failure: no trees stand there.
        if (response.status === 404 || response.status === 204) {
          if (!aborter.signal.aborted) knownEmpty.add(key);
          return;
        }
        if (!response.ok)
          throw new Error(`Tree tile request failed: HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (!aborter.signal.aborted) prefetched.set(key, buffer);
      })
      .catch(() => {
        // Offline or a failed response: leave the tile absent so the bounded
        // preload loop or a later proximity pass can try again.
      })
      .finally(() => {
        fetchInFlight.delete(key);
      });
    fetchInFlight.set(key, request);
    return request;
  };

  const load = (x: number, y: number) => {
    const key = tileKey(x, y);
    if (loaded.has(key)) return Promise.resolve();
    const pending = ingestInFlight.get(key);
    if (pending) return pending;
    const request = (async () => {
      await prefetch(x, y);
      if (aborter.signal.aborted) return;
      if (knownEmpty.delete(key)) {
        loaded.add(key);
        return;
      }
      const buffer = prefetched.get(key);
      if (!buffer) return;
      try {
        await ingest(parseTreeTile(buffer));
        prefetched.delete(key);
        if (!aborter.signal.aborted) loaded.add(key);
      } catch {
        // A truncated or invalid tile must not stop the game. Its successful
        // fetch already counted as one attempt, so later passes remain bounded.
        prefetched.delete(key);
      }
    })().finally(() => {
      ingestInFlight.delete(key);
    });
    ingestInFlight.set(key, request);
    return request;
  };

  const preloadAll = () => {
    if (preloadPromise) return preloadPromise;
    preloadPromise = (async () => {
      // One background tile at a time keeps the 3.25 MiB data set from
      // competing with map/terrain requests or producing a parse burst on a
      // phone. Centre-first ordering starts with WMU's spawn tile, so the
      // initial proximity request shares it instead of opening a second tree
      // download while the map is settling.
      const centerX = (TREE_TILE_COVERAGE.minX + TREE_TILE_COVERAGE.maxX) / 2;
      const centerY = (TREE_TILE_COVERAGE.minY + TREE_TILE_COVERAGE.maxY) / 2;
      const tiles: Array<[number, number]> = [];
      for (
        let x = TREE_TILE_COVERAGE.minX;
        x <= TREE_TILE_COVERAGE.maxX;
        x += 1
      )
        for (
          let y = TREE_TILE_COVERAGE.minY;
          y <= TREE_TILE_COVERAGE.maxY;
          y += 1
        )
          tiles.push([x, y]);
      tiles.sort(
        ([firstX, firstY], [secondX, secondY]) =>
          Math.abs(firstX - centerX) +
            Math.abs(firstY - centerY) -
            Math.abs(secondX - centerX) -
            Math.abs(secondY - centerY) ||
          firstX - secondX ||
          firstY - secondY,
      );
      for (const [x, y] of tiles) {
        if (aborter.signal.aborted) return;
        const key = tileKey(x, y);
        do {
          await prefetch(x, y);
        } while (
          !aborter.signal.aborted &&
          !loaded.has(key) &&
          !prefetched.has(key) &&
          !knownEmpty.has(key) &&
          (attempts.get(key) ?? 0) < TILE_FETCH_ATTEMPTS
        );
      }
    })();
    return preloadPromise;
  };

  const query = (
    queryEast: number,
    queryNorth: number,
    radius: number,
    out: TreeSelection,
  ) => {
    out.count = 0;
    const limit = out.ids.length;
    if (limit === 0 || count === 0) return;
    if (sortKeys.length < count) sortKeys = new Float64Array(count);
    const centreX = Math.floor(queryEast / GRID_CELL_METRES);
    const centreZ = Math.floor(queryNorth / GRID_CELL_METRES);
    const maxRing = Math.ceil(radius / GRID_CELL_METRES) + 1;
    const radiusSquared = radius * radius;
    let found = 0;

    const visit = (cellX: number, cellZ: number) => {
      const cell = grid.get(cellKey(cellX, cellZ));
      if (!cell) return;
      for (const index of cell) {
        const dx = east[index] - queryEast;
        const dz = north[index] - queryNorth;
        const distanceSquared = dx * dx + dz * dz;
        if (distanceSquared > radiusSquared) continue;
        const band = Math.floor(Math.sqrt(distanceSquared) / RANK_BAND_METRES);
        // Nearer band first, taller first inside it, packed into one number
        // so the sort below needs no comparator and no pair of objects.
        const rank = band * 256 + (255 - heightCode[index]);
        sortKeys[found] = rank * RANK_INDEX_STRIDE + index;
        found += 1;
        if (found >= sortKeys.length) return;
      }
    };

    // Rings outward, stopping once the budget is full and every remaining
    // cell is farther than the farthest tree already in hand. A ring-r cell
    // is at least (r - 1) cells away; a tree found by ring r is at most
    // (r + 1) * sqrt(2) cells away, which is where stopRing comes from.
    let stopRing = maxRing;
    visit(centreX, centreZ);
    for (let ring = 1; ring <= stopRing && found < sortKeys.length; ring += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        visit(centreX + dx, centreZ - ring);
        visit(centreX + dx, centreZ + ring);
      }
      for (let dz = -ring + 1; dz <= ring - 1; dz += 1) {
        visit(centreX - ring, centreZ + dz);
        visit(centreX + ring, centreZ + dz);
      }
      if (found >= limit) {
        stopRing = Math.min(
          stopRing,
          Math.ceil((ring + 1) * Math.SQRT2) + 1,
          maxRing,
        );
      }
    }
    if (found === 0) return;

    const ordered = sortKeys.subarray(0, found);
    ordered.sort();
    const taken = Math.min(found, limit);
    for (let slot = 0; slot < taken; slot += 1) {
      const index = ordered[slot] % RANK_INDEX_STRIDE;
      out.ids[slot] = index;
      out.east[slot] = east[index];
      out.north[slot] = north[index];
      out.height[slot] = heightCode[index] * TREE_TILE_METRIC_UNIT;
      out.crownRadius[slot] = crownCode[index] * TREE_TILE_METRIC_UNIT;
      out.fullness[slot] = fullnessCode[index] / 255;
    }
    out.count = taken;
  };

  return {
    get generation() {
      return generation;
    },
    covers: (longitude: number, latitude: number) =>
      inTreeTileCoverage(treeTileX(longitude), treeTileY(latitude)),
    preloadAll,
    request: (longitude: number, latitude: number, radius: number) => {
      if (aborter.signal.aborted) return;
      const latitudeSpan = radius / METRES_PER_DEGREE_LATITUDE;
      const longitudeSpan =
        radius /
        (METRES_PER_DEGREE_LONGITUDE *
          Math.max(0.05, Math.cos((latitude * Math.PI) / 180)));
      const fromX = treeTileX(longitude - longitudeSpan);
      const toX = treeTileX(longitude + longitudeSpan);
      // Tile rows count southward, so the northern edge is the lower row.
      const fromY = treeTileY(latitude + latitudeSpan);
      const toY = treeTileY(latitude - latitudeSpan);
      for (let x = fromX; x <= toX; x += 1) {
        for (let y = fromY; y <= toY; y += 1) {
          if (inTreeTileCoverage(x, y)) void load(x, y);
        }
      }
    },
    query,
    stats: () => {
      let pending = fetchInFlight.size;
      for (const key of ingestInFlight.keys())
        if (!fetchInFlight.has(key)) pending += 1;
      return { tiles: loaded.size, pending, trees: count };
    },
    dispose: () => {
      aborter.abort();
      prefetched.clear();
      knownEmpty.clear();
      grid.clear();
    },
  };
};
