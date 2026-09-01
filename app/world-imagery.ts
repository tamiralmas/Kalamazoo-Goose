export const AERIAL_HOST_ORIGIN = 'https://clarity.maptiles.arcgis.com';

export const AERIAL_TILE_TEMPLATE = `${AERIAL_HOST_ORIGIN}/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`;

export const AERIAL_INFORMATION_URL =
  'https://www.arcgis.com/home/item.html?id=ab399b847323487dba26809bf11ea91a';

export const AERIAL_ATTRIBUTION = `Source: <a href="${AERIAL_INFORMATION_URL}" target="_blank">Esri</a>, Vantor, Earthstar Geographics, IGN, and the GIS User Community`;

export const getAerialTileUrl = (zoom: number, x: number, y: number) =>
  `${AERIAL_HOST_ORIGIN}/arcgis/rest/services/World_Imagery/MapServer/tile/${zoom}/${y}/${x}`;
