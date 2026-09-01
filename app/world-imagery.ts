export const AERIAL_HOST_ORIGIN = 'https://server.arcgisonline.com';

export const AERIAL_TILE_TEMPLATE = `${AERIAL_HOST_ORIGIN}/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`;

export const AERIAL_INFORMATION_URL =
  'https://goto.arcgisonline.com/maps/World_Imagery';

export const AERIAL_ATTRIBUTION = `Source: <a href="${AERIAL_INFORMATION_URL}" target="_blank">Esri</a>, Vantor, Earthstar Geographics, and the GIS User Community`;

export const getAerialTileUrl = (zoom: number, x: number, y: number) =>
  `${AERIAL_HOST_ORIGIN}/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${y}/${x}`;
