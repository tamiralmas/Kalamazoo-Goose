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
