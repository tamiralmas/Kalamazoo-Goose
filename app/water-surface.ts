import * as THREE from 'three';

/**
 * Moving water for the campus ponds and lakes.
 *
 * The style's water fill is a flat blue wash over the aerial photo, which is
 * the right answer at map distance and the wrong one from three metres up: a
 * goose landing on Goldsworth Valley pond skids across a painted rectangle.
 * This turns the same OpenMapTiles polygons the engine already collides
 * against into real surfaces, animated entirely in the fragment shader so a
 * phone pays for one extra draw call per pond and nothing else.
 *
 * Everything here is in the engine's local frame (x east, y up, z north) and
 * in metres. Each surface builds its geometry around its own centre rather
 * than at the world origin, so a pond a kilometre out does not hand the
 * shader coordinates too large for a phone's mediump floats.
 */

/** One water polygon in the engine's local frame; y on a Vector2 is north. */
export type WaterPolygon = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  outer: THREE.Vector2[];
  holes: THREE.Vector2[][];
};

/**
 * Ground height in metres above sea level, or null while the DEM has not
 * landed yet (the caller applies its own "is this reading usable" rule).
 */
export type WaterElevationSampler = (
  east: number,
  north: number,
) => number | null;

export type WaterSurfaces = {
  readonly group: THREE.Group;
  /** Live meshes. Reported as telemetry so the harness can assert on it. */
  readonly count: number;
  /** Throw the old meshes away and build one per polygon. */
  rebuild(
    polygons: readonly WaterPolygon[],
    sample: WaterElevationSampler,
    fallbackElevation: number,
  ): void;
  /**
   * Re-sample terrain under the surfaces still sitting on the fallback
   * height. Returns true when any of them moved.
   */
  resolveElevations(
    sample: WaterElevationSampler,
    fallbackElevation: number,
  ): boolean;
  /** A splashdown at this spot: the surface itself rings out from it. */
  ripple(east: number, north: number, strength: number): void;
  /** Called every frame with the engine's clock and camera position. */
  update(elapsedSeconds: number, eye: THREE.Vector3): void;
  setVisible(visible: boolean): void;
  dispose(): void;
};

/**
 * Polygons wider than this stay MapLibre's flat fill. One horizontal plane
 * cannot follow the Kalamazoo River down a slope, and a river drawn as a
 * single flat sheet would bury half its valley.
 */
const MAX_SPAN_METERS = 1_500;

/** How far the sheet floats above the lowest terrain reading inside it. */
const SURFACE_LIFT = 0.12;

/** Width of the band over which alpha ramps from the shore to open water. */
const SHORE_FADE_METERS = 7;

/** Opacity over open water, and at the very edge where the photo shows through. */
const OPEN_WATER_ALPHA = 0.78;
const SHORE_ALPHA = 0.14;

/**
 * Shore mask resolution and cost ceiling. The mask is a tiny distance field
 * rasterised on the CPU once per rebuild: every cell walks the polygon's
 * edges, so both are capped to keep a lake with a thousand vertices from
 * spending tens of milliseconds on a texture nobody can see the pixels of.
 */
const SHORE_FIELD_MAX_CELLS = 48;
const SHORE_FIELD_MAX_EDGES = 320;

/** Terrain readings per polygon: its centre plus this many ring vertices. */
const ELEVATION_RING_SAMPLES = 8;

/** How far toward the centre a ring vertex is pulled before it is sampled. */
const ELEVATION_SAMPLE_INSET = 0.3;

/** Live splashdown ripples each surface's shader carries. */
const MAX_RIPPLES = 4;
const RIPPLE_LIFE_SECONDS = 2.5;

/** Metres per second the ripple ring expands. */
const RIPPLE_SPEED = 5.2;

/** Michigan pond: green-blue in the body, pale sky at a grazing angle. */
const DEEP_COLOR = new THREE.Color(0x24606a);
const SKY_COLOR = new THREE.Color(0xa8c8d8);
const SUN_GLINT_COLOR = new THREE.Color(0xfff6e4);

const vertexShader = /* glsl */ `
  uniform vec2 uFieldOrigin;
  uniform vec2 uFieldSpan;
  varying vec2 vPlane;
  varying vec2 vField;
  void main() {
    vPlane = position.xy;
    vField = (position.xy - uFieldOrigin) / uFieldSpan;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  #define RIPPLE_COUNT ${MAX_RIPPLES}
  const float RIPPLE_LIFE = ${RIPPLE_LIFE_SECONDS.toFixed(2)};
  const float RIPPLE_SPEED = ${RIPPLE_SPEED.toFixed(2)};

  uniform float uTime;
  uniform vec3 uDeepColor;
  uniform vec3 uSkyColor;
  uniform vec3 uGlintColor;
  uniform vec3 uSunDirection;
  /** Camera in this mesh's frame: x east, y above the sheet, z north. */
  uniform vec3 uEye;
  uniform sampler2D uShoreField;
  uniform vec4 uRipples[RIPPLE_COUNT];
  uniform float uOpenAlpha;
  uniform float uShoreAlpha;
  varying vec2 vPlane;
  varying vec2 vField;

  // Each layer contributes its slope rather than its height: the surface is
  // never displaced, only lit as though it were, which is what sells water
  // at this distance for the price of three cosines.
  vec2 waveSlope(vec2 p, vec2 direction, float frequency, float slope, float speed) {
    return direction * slope * cos(dot(p, direction) * frequency + uTime * speed);
  }

  void main() {
    // A slow drift under the wave train, so the sum of sines never settles
    // into a still pattern that reads as a tiled texture.
    vec2 p = vPlane + vec2(uTime * 0.06, uTime * -0.041);
    vec2 slope = vec2(0.0);
    slope += waveSlope(p, vec2(0.94, 0.34), 0.55, 0.100, 1.40);
    slope += waveSlope(p, vec2(-0.42, 0.91), 1.25, 0.070, 2.10);
    slope += waveSlope(p, vec2(0.66, -0.75), 2.90, 0.035, 3.20);
    // One very long swell drifting across the pond, so some of it is glassy
    // while the rest is ruffled instead of the whole sheet chopping evenly.
    slope *= 0.75 + 0.25 * sin(dot(vPlane, vec2(0.031, 0.019)) - uTime * 0.21);

    for (int index = 0; index < RIPPLE_COUNT; index += 1) {
      vec4 ripple = uRipples[index];
      float age = uTime - ripple.z;
      // Branchless: a dead or expired slot multiplies out to nothing rather
      // than diverging the wavefront on a mobile GPU.
      float alive =
        step(0.001, ripple.w) * step(0.0, age) * step(age, RIPPLE_LIFE);
      vec2 outward = vPlane - ripple.xy;
      float radial = length(outward) + 1e-4;
      float band = (radial - age * RIPPLE_SPEED) / 1.1;
      slope +=
        (outward / radial) *
        (ripple.w * 0.5 * (1.0 - age / RIPPLE_LIFE) * band *
          exp(-band * band) * alive);
    }

    vec3 normal = normalize(vec3(-slope.x, 1.0, -slope.y));
    vec3 view = normalize(vec3(uEye.x - vPlane.x, uEye.y, uEye.z - vPlane.y));
    float facing = clamp(dot(normal, view), 0.0, 1.0);
    // Schlick: looking down into the water it is its own colour, looking
    // along it the sky wins. This is the whole reason it reads as a liquid.
    float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 4.0);
    vec3 color = mix(uDeepColor, uSkyColor, fresnel);

    vec3 halfway = normalize(uSunDirection + view);
    float glint = pow(max(dot(normal, halfway), 0.0), 64.0);
    color += uGlintColor * glint * 0.85;

    float shore = texture2D(uShoreField, vField).r;
    float alpha = mix(uShoreAlpha, uOpenAlpha, smoothstep(0.0, 1.0, shore));
    // Sun glitter still reads where the sheet is fading into the bank.
    alpha = clamp(alpha + glint * 0.45, 0.0, 1.0);
    gl_FragColor = vec4(color, alpha);
  }
`;

type ShoreField = {
  texture: THREE.DataTexture;
  data: Uint8Array;
  columns: number;
  rows: number;
  originX: number;
  originY: number;
  spanX: number;
  spanY: number;
};

type WaterSurface = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  field: ShoreField;
  /** World position the mesh's local frame is centred on. */
  centerX: number;
  centerY: number;
  /** Flat east/north pairs re-read while the DEM is still missing. */
  samplePoints: number[];
  surfaceY: number;
  terrainResolved: boolean;
  rippleCursor: number;
};

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Crossing count against a closed ring of plane-frame points. */
const pointInPlaneRing = (x: number, y: number, ring: THREE.Vector2[]) => {
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index, index += 1
  ) {
    const a = ring[index];
    const b = ring[previous];
    const crosses =
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y || 1e-9) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
};

const distanceToSegmentSquared = (
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared > 1e-9
      ? clamp01(((x - ax) * dx + (y - ay) * dy) / lengthSquared)
      : 0;
  const px = x - (ax + dx * t);
  const py = y - (ay + dy * t);
  return px * px + py * py;
};

/**
 * The rings, flattened to a segment list and thinned to a budget. The mask is
 * a soft alpha ramp a handful of metres wide, so dropping every other vertex
 * of a lake outline costs nothing anyone can see and bounds the rebuild.
 */
const collectFieldEdges = (rings: THREE.Vector2[][]) => {
  const total = rings.reduce((count, ring) => count + ring.length, 0);
  const stride = Math.max(1, Math.ceil(total / SHORE_FIELD_MAX_EDGES));
  const edges: number[] = [];
  rings.forEach((ring) => {
    const kept: THREE.Vector2[] = [];
    for (let index = 0; index < ring.length; index += stride)
      kept.push(ring[index]);
    if (kept.length < 3) {
      kept.length = 0;
      kept.push(...ring);
    }
    for (let index = 0; index < kept.length; index += 1) {
      const a = kept[index];
      const b = kept[(index + 1) % kept.length];
      edges.push(a.x, a.y, b.x, b.y);
    }
  });
  return edges;
};

/**
 * A little distance field: 0 on and outside the bank, 1 once the water is
 * SHORE_FADE_METERS deep into the polygon. The grid is padded by one cell so
 * the outermost texels are guaranteed to be outside, which is what makes the
 * bilinear fetch reach a true zero exactly at the geometry's edge.
 */
const buildShoreField = (
  outer: THREE.Vector2[],
  holes: THREE.Vector2[][],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): ShoreField => {
  const bodyX = Math.max(maxX - minX, 1);
  const bodyY = Math.max(maxY - minY, 1);
  const bodyColumns = Math.min(
    SHORE_FIELD_MAX_CELLS,
    Math.max(6, Math.round(bodyX / (SHORE_FADE_METERS * 0.5))),
  );
  const bodyRows = Math.min(
    SHORE_FIELD_MAX_CELLS,
    Math.max(6, Math.round(bodyY / (SHORE_FADE_METERS * 0.5))),
  );
  const cellX = bodyX / bodyColumns;
  const cellY = bodyY / bodyRows;
  const columns = bodyColumns + 2;
  const rows = bodyRows + 2;
  const originX = minX - cellX;
  const originY = minY - cellY;
  const spanX = bodyX + cellX * 2;
  const spanY = bodyY + cellY * 2;

  const edges = collectFieldEdges([outer, ...holes]);
  const data = new Uint8Array(columns * rows * 4);
  // The ramp is never narrower than a cell: on a big lake the grid is coarser
  // than SHORE_FADE_METERS, and dividing by the smaller number would quantise
  // the band into a visible staircase around the shore.
  const fade = Math.max(SHORE_FADE_METERS, Math.max(cellX, cellY));
  for (let row = 0; row < rows; row += 1) {
    const y = originY + ((row + 0.5) / rows) * spanY;
    for (let column = 0; column < columns; column += 1) {
      const x = originX + ((column + 0.5) / columns) * spanX;
      const offset = (row * columns + column) * 4;
      if (
        !pointInPlaneRing(x, y, outer) ||
        holes.some((hole) => pointInPlaneRing(x, y, hole))
      )
        continue;
      let nearest = Number.POSITIVE_INFINITY;
      for (let edge = 0; edge < edges.length; edge += 4) {
        const squared = distanceToSegmentSquared(
          x,
          y,
          edges[edge],
          edges[edge + 1],
          edges[edge + 2],
          edges[edge + 3],
        );
        if (squared < nearest) nearest = squared;
      }
      data[offset] = Math.round(clamp01(Math.sqrt(nearest) / fade) * 255);
    }
  }

  const texture = new THREE.DataTexture(data, columns, rows);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return {
    texture,
    data,
    columns,
    rows,
    originX,
    originY,
    spanX,
    spanY,
  };
};

/**
 * Water is flat, so the whole sheet takes one height: the lowest usable
 * reading from its centre and a ring of pulled-in vertices. Lowest, not
 * average, because a vertex that lands on the bank instead of the water
 * reads high, and a sheet a metre too high floats above its own shoreline.
 */
const sampleSurfaceHeight = (
  samplePoints: number[],
  sample: WaterElevationSampler,
) => {
  let lowest: number | null = null;
  for (let index = 0; index < samplePoints.length; index += 2) {
    const reading = sample(samplePoints[index], samplePoints[index + 1]);
    if (reading === null || !Number.isFinite(reading)) continue;
    if (lowest === null || reading < lowest) lowest = reading;
  }
  return lowest;
};

const fieldValueAt = (surface: WaterSurface, x: number, y: number) => {
  const field = surface.field;
  const u = (x - field.originX) / field.spanX;
  const v = (y - field.originY) / field.spanY;
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const column = Math.min(field.columns - 1, Math.floor(u * field.columns));
  const row = Math.min(field.rows - 1, Math.floor(v * field.rows));
  return field.data[(row * field.columns + column) * 4] / 255;
};

/**
 * `sun` is the unit vector toward the sun in the engine's local frame, the
 * same one world-light.ts hands the Three.js key light.
 */
export const createWaterSurfaces = (sun: {
  x: number;
  y: number;
  z: number;
}): WaterSurfaces => {
  const group = new THREE.Group();
  group.name = 'water-surfaces';
  // Ahead of the splash rings, spray drops and clouds in the transparent
  // pass: this is the sheet everything else in the water sits on top of.
  group.renderOrder = -1;
  const sunDirection = new THREE.Vector3(sun.x, sun.y, sun.z).normalize();
  const surfaces: WaterSurface[] = [];
  let clock = 0;

  const disposeSurface = (surface: WaterSurface) => {
    group.remove(surface.mesh);
    surface.mesh.geometry.dispose();
    surface.mesh.material.dispose();
    surface.field.texture.dispose();
  };

  const buildSurface = (
    polygon: WaterPolygon,
    sample: WaterElevationSampler,
    fallbackElevation: number,
  ): WaterSurface | null => {
    const spanX = polygon.maxX - polygon.minX;
    const spanZ = polygon.maxZ - polygon.minZ;
    if (
      !Number.isFinite(spanX) ||
      !Number.isFinite(spanZ) ||
      spanX < 2 ||
      spanZ < 2 ||
      spanX > MAX_SPAN_METERS ||
      spanZ > MAX_SPAN_METERS ||
      polygon.outer.length < 3
    )
      return null;

    const centerX = (polygon.minX + polygon.maxX) * 0.5;
    const centerY = (polygon.minZ + polygon.maxZ) * 0.5;
    const toPlane = (ring: THREE.Vector2[]) =>
      ring.map(
        (point) => new THREE.Vector2(point.x - centerX, point.y - centerY),
      );
    const outer = toPlane(polygon.outer);
    const holes = polygon.holes
      .filter((hole) => hole.length >= 3)
      .map((hole) => toPlane(hole));
    if (outer.some((point) => !Number.isFinite(point.x + point.y))) return null;

    const shape = new THREE.Shape(outer);
    holes.forEach((hole) => shape.holes.push(new THREE.Path(hole)));
    const geometry = new THREE.ShapeGeometry(shape);
    const index = geometry.getIndex();
    if (!index || index.count < 3) {
      geometry.dispose();
      return null;
    }

    const field = buildShoreField(
      outer,
      holes,
      -spanX * 0.5,
      -spanZ * 0.5,
      spanX * 0.5,
      spanZ * 0.5,
    );

    const samplePoints: number[] = [centerX, centerY];
    const stride = Math.max(
      1,
      Math.floor(polygon.outer.length / ELEVATION_RING_SAMPLES),
    );
    for (let vertex = 0; vertex < polygon.outer.length; vertex += stride) {
      const point = polygon.outer[vertex];
      samplePoints.push(
        point.x + (centerX - point.x) * ELEVATION_SAMPLE_INSET,
        point.y + (centerY - point.y) * ELEVATION_SAMPLE_INSET,
      );
    }
    const lowest = sampleSurfaceHeight(samplePoints, sample);
    const surfaceY = (lowest ?? fallbackElevation) + SURFACE_LIFT;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: clock },
        uDeepColor: { value: DEEP_COLOR.clone() },
        uSkyColor: { value: SKY_COLOR.clone() },
        uGlintColor: { value: SUN_GLINT_COLOR.clone() },
        uSunDirection: { value: sunDirection.clone() },
        uEye: { value: new THREE.Vector3(0, 40, 0) },
        uShoreField: { value: field.texture },
        uFieldOrigin: {
          value: new THREE.Vector2(field.originX, field.originY),
        },
        uFieldSpan: { value: new THREE.Vector2(field.spanX, field.spanY) },
        uRipples: {
          value: Array.from(
            { length: MAX_RIPPLES },
            () => new THREE.Vector4(0, 0, -1e4, 0),
          ),
        },
        uOpenAlpha: { value: OPEN_WATER_ALPHA },
        uShoreAlpha: { value: SHORE_ALPHA },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      // The map's projection mirrors an axis, so a single-sided sheet would
      // face away from the camera.
      side: THREE.DoubleSide,
      // The terrain mesh under a pond is drawn at very nearly this height;
      // win the depth test against it rather than z-fighting the shoreline.
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });

    const mesh = new THREE.Mesh(geometry, material);
    // ShapeGeometry lays its triangles out in XY; a quarter turn about east
    // maps shape y onto world north and leaves the sheet horizontal.
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(centerX, surfaceY, centerY);
    mesh.frustumCulled = false;
    group.add(mesh);
    return {
      mesh,
      field,
      centerX,
      centerY,
      samplePoints,
      surfaceY,
      terrainResolved: lowest !== null,
      rippleCursor: 0,
    };
  };

  return {
    group,
    get count() {
      return surfaces.length;
    },
    rebuild(polygons, sample, fallbackElevation) {
      surfaces.forEach(disposeSurface);
      surfaces.length = 0;
      polygons.forEach((polygon) => {
        const surface = buildSurface(polygon, sample, fallbackElevation);
        if (surface) surfaces.push(surface);
      });
    },
    resolveElevations(sample, fallbackElevation) {
      let moved = false;
      surfaces.forEach((surface) => {
        if (surface.terrainResolved) return;
        const lowest = sampleSurfaceHeight(surface.samplePoints, sample);
        const surfaceY = (lowest ?? fallbackElevation) + SURFACE_LIFT;
        if (lowest !== null) surface.terrainResolved = true;
        if (Math.abs(surfaceY - surface.surfaceY) < 0.01) return;
        surface.surfaceY = surfaceY;
        surface.mesh.position.y = surfaceY;
        moved = true;
      });
      return moved;
    },
    ripple(east, north, strength) {
      for (const surface of surfaces) {
        const x = east - surface.centerX;
        const y = north - surface.centerY;
        if (fieldValueAt(surface, x, y) <= 0) continue;
        const ripples = surface.mesh.material.uniforms.uRipples
          .value as THREE.Vector4[];
        ripples[surface.rippleCursor % MAX_RIPPLES].set(
          x,
          y,
          clock,
          clamp01(strength) * 0.85 + 0.15,
        );
        surface.rippleCursor += 1;
        return;
      }
    },
    update(elapsedSeconds, eye) {
      clock = elapsedSeconds;
      surfaces.forEach((surface) => {
        const uniforms = surface.mesh.material.uniforms;
        uniforms.uTime.value = elapsedSeconds;
        (uniforms.uEye.value as THREE.Vector3).set(
          eye.x - surface.centerX,
          eye.y - surface.surfaceY,
          eye.z - surface.centerY,
        );
      });
    },
    setVisible(visible) {
      group.visible = visible;
    },
    dispose() {
      surfaces.forEach(disposeSurface);
      surfaces.length = 0;
    },
  };
};
