export const AERIAL_HOST_ORIGIN = 'https://imagery.michigan.gov';

export const AERIAL_TILE_TEMPLATE = `${AERIAL_HOST_ORIGIN}/server/rest/services/Michigan_imagery_public/MapServer/tile/{z}/{y}/{x}`;

export const AERIAL_INFORMATION_URL =
  'https://www.michigan.gov/dtmb/services/maps/misail';

export const AERIAL_ATTRIBUTION = `Imagery © <a href="${AERIAL_INFORMATION_URL}" target="_blank">State of Michigan (MiSAIL)</a>`;

export const AERIAL_BOUNDS: [number, number, number, number] = [
  -90.52734, 41.64008, -82.26563, 48.34165,
];

export const getAerialTileUrl = (zoom: number, x: number, y: number) =>
  `${AERIAL_HOST_ORIGIN}/server/rest/services/Michigan_imagery_public/MapServer/tile/${zoom}/${y}/${x}`;

export const AERIAL_SPAWN_PRELOAD_URL = getAerialTileUrl(15, 8590, 12129);

// Mapterhorn publishes global Terrarium-encoded DEM tiles. Its TileJSON omits
// maxzoom, and the Kalamazoo coverage ends at zoom 16, so the source declares
// the ceiling itself instead of letting MapLibre probe zooms 17-22.
export const TERRAIN_HOST_ORIGIN = 'https://tiles.mapterhorn.com';
export const TERRAIN_TILE_TEMPLATE = `${TERRAIN_HOST_ORIGIN}/{z}/{x}/{y}.webp`;
export const TERRAIN_MAX_ZOOM = 16;
export const TERRAIN_ATTRIBUTION =
  'Terrain © <a href="https://mapterhorn.com/attribution/" target="_blank">Mapterhorn</a>';
export const getTerrainTileUrl = (zoom: number, x: number, y: number) =>
  `${TERRAIN_HOST_ORIGIN}/${zoom}/${x}/${y}.webp`;

/** Zoom-16 DEM tile containing the WMU spawn, fetched while the app starts. */
export const TERRAIN_SPAWN_PRELOAD_URL = getTerrainTileUrl(16, 17181, 24258);
