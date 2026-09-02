// Collider geometry for OSM building footprints, split out of game-engine.ts.
//
// Every one of these functions is pure arithmetic over numbers: no map, no
// renderer, no THREE. That is the point. The floating-roof bug (a collider
// whose box was 7 m taller than the building MapLibre draws) came from mixing
// a real DEM reading with a fallback elevation, and the only way to keep that
// honest is to be able to unit test the rule that decides "resolved" from
// "still waiting on a tile" without booting a WebGL context.
//
// How MapLibre puts a fill-extrusion on terrain, because the collider has to
// copy it exactly: the whole polygon is lifted as one rigid slab by the DEM
// under the vertex centroid of its rings (fill_extrusion_bucket.ts averages
// every ring vertex, holes included, then get_elevation samples that point).
// Nothing tilts with the hillside. Uphill the slab is buried, downhill its
// base hangs in the air, and the roof is at `centroid DEM + render_height`
// everywhere. Overzoomed tiles slice a big building into per-tile chunks that
// each get their own centroid, which is why the engine treats each chunk
// polygon it is handed as its own collider.

/**
 * One DEM reading under a collider. `null` means the tile covering that point
 * has not decoded yet, so the value must never be blended with real readings:
 * on a hillside the fallback (the elevation under the goose) can be 10 m out,
 * and a single fallback corner is enough to inflate the whole box.
 */
export type ColliderTerrainSample = number | null;

/** Vertex centroid first, then the four AABB corners. */
export const COLLIDER_SAMPLE_COUNT = 5;

/**
 * The shortest box a building may get. Matches the floor the engine clamps
 * render_height to, so a one-storey shed still stops a goose.
 */
export const MIN_COLLIDER_HEIGHT = 2.6;

export type ColliderTerrain = {
  /**
   * Terrain under the vertex centroid: the elevation MapLibre lifts the whole
   * extrusion by, and where the roof overlay is drawn.
   */
  centerGround: number;
  /** Bottom of the collision box. */
  ground: number;
  /** Box height, so `ground + height` is the walkable roof. */
  height: number;
  /** False while any of the five readings was still unusable. */
  terrainResolved: boolean;
};

export type PlanarPoint = { x: number; z: number };

/**
 * The point MapLibre samples the DEM at for a polygon: the plain average of
 * every ring vertex (outer ring and holes alike), skipping a ring's closing
 * vertex when it repeats the first. Not the area centroid, and not the AABB
 * center, which on an L-shaped wing can sit 20 m and several metres of
 * hillside away from it.
 */
export const polygonVertexCentroid = (
  rings: readonly (readonly PlanarPoint[])[],
  out: PlanarPoint = { x: 0, z: 0 },
): PlanarPoint => {
  let sumX = 0;
  let sumZ = 0;
  let count = 0;
  for (const ring of rings) {
    const length = ring.length;
    if (length === 0) continue;
    const first = ring[0];
    const last = ring[length - 1];
    const closed = length > 1 && first.x === last.x && first.z === last.z;
    const end = closed ? length - 1 : length;
    for (let index = 0; index < end; index += 1) {
      sumX += ring[index].x;
      sumZ += ring[index].z;
      count += 1;
    }
  }
  if (count === 0) {
    out.x = 0;
    out.z = 0;
    return out;
  }
  out.x = sumX / count;
  out.z = sumZ / count;
  return out;
};

/**
 * Writes the five sample points (vertex centroid, then the four AABB corners)
 * into `out` as x,z pairs. Takes a caller-owned array because the resolve pass
 * runs this for dozens of buildings several times a second and must not
 * allocate.
 */
export const writeColliderSamplePoints = (
  out: number[],
  centroidX: number,
  centroidZ: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
) => {
  out[0] = centroidX;
  out[1] = centroidZ;
  out[2] = minX;
  out[3] = minZ;
  out[4] = minX;
  out[5] = maxZ;
  out[6] = maxX;
  out[7] = minZ;
  out[8] = maxX;
  out[9] = maxZ;
  return out;
};

/**
 * Fit a collision box to five terrain readings.
 *
 * All five usable: the roof is exactly where MapLibre draws it, at the
 * centroid reading plus render_height. The box reaches down to the lowest
 * corner so the downhill side, where the drawn slab hangs above the terrain,
 * is still a wall and not a gap to waddle through.
 *
 * Any reading unusable: the box is deliberately flat and anchored to the
 * fallback, and it is flagged unresolved so the caller can re-sample it later.
 * A flat box at a possibly wrong elevation is a small, self-correcting error;
 * a box fitted to one real corner and four fallbacks is a permanent one,
 * because a later refresh only ever shifts `ground`, never `height`.
 *
 * `out` lets the hot path reuse one object; omitting it returns a fresh one.
 */
export const resolveColliderTerrain = (
  samples: readonly ColliderTerrainSample[],
  renderHeight: number,
  renderMinHeight: number,
  fallbackGround: number,
  out: ColliderTerrain = {
    centerGround: 0,
    ground: 0,
    height: 0,
    terrainResolved: false,
  },
): ColliderTerrain => {
  let lowest = Number.POSITIVE_INFINITY;
  let resolved = samples.length >= COLLIDER_SAMPLE_COUNT;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample === null || !Number.isFinite(sample)) {
      resolved = false;
      break;
    }
    if (sample < lowest) lowest = sample;
  }

  if (!resolved) {
    out.centerGround = fallbackGround;
    out.ground = fallbackGround + renderMinHeight;
    out.height = Math.max(MIN_COLLIDER_HEIGHT, renderHeight);
    out.terrainResolved = false;
    return out;
  }

  const centerGround = samples[0] as number;
  const ground = lowest + renderMinHeight;
  out.centerGround = centerGround;
  out.ground = ground;
  out.height = Math.max(
    MIN_COLLIDER_HEIGHT,
    centerGround + renderHeight - ground,
  );
  out.terrainResolved = true;
  return out;
};

/** Where the goose stands when it lands on this box. */
export const colliderRoof = (collider: { ground: number; height: number }) =>
  collider.ground + collider.height;
