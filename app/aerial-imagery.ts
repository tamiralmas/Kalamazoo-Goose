import type { Map as MapLibreMap, MapOptions } from 'maplibre-gl';
import {
  AERIAL_ATTRIBUTION,
  AERIAL_BOUNDS,
  AERIAL_TILE_TEMPLATE,
} from './world-imagery';

export const AERIAL_FALLBACK_SOURCE_ID = 'wmug-aerial-preview';
export const AERIAL_DETAIL_SOURCE_ID = 'wmug-aerial-imagery';
export const AERIAL_FALLBACK_MAX_ZOOM = 15;
export const AERIAL_GROUND_COLOR = '#65714c';

export const aerialTileRetentionOptions = (
  coarsePointer: boolean,
): Pick<
  MapOptions,
  'cancelPendingTileRequestsWhileZooming' | 'maxTileCacheZoomLevels'
> => ({
  // The chase camera changes zoom continuously. Let pending parent tiles
  // finish so they can cover detailed tiles that are still downloading.
  cancelPendingTileRequestsWhileZooming: false,
  maxTileCacheZoomLevels: coarsePointer ? 4 : 5,
});

type ImageryMap = Pick<
  MapLibreMap,
  'getSource' | 'addSource' | 'addLayer' | 'getStyle' | 'setPaintProperty'
>;

/** A durable low-resolution floor, with the original detailed photos above. */
export const createAerialImagery = (
  map: ImageryMap,
  coarsePointer: boolean,
  beforeLayer: () => string | undefined,
) => {
  const install = (sourceId: string, tileSize: 256 | 512, maxzoom: number) => {
    if (map.getSource(sourceId)) return;
    map.addSource(sourceId, {
      type: 'raster',
      tiles: [AERIAL_TILE_TEMPLATE],
      tileSize,
      minzoom: 1,
      maxzoom,
      bounds: AERIAL_BOUNDS,
      attribution: AERIAL_ATTRIBUTION,
    });
    map.addLayer(
      {
        id: sourceId,
        type: 'raster',
        source: sourceId,
        paint: {
          'raster-opacity': 1,
          'raster-saturation': 0.06,
          'raster-contrast': 0.14,
          'raster-brightness-min': 0.03,
          'raster-brightness-max': 0.99,
          'raster-fade-duration': coarsePointer ? 0 : 450,
          'raster-resampling': 'linear',
        },
      },
      beforeLayer(),
    );
  };

  const installFallback = () => {
    // The style's pale background otherwise shows up as white terrain when
    // visiting an area for which neither resolution has arrived yet.
    for (const layer of map.getStyle().layers ?? []) {
      if (layer.type !== 'background') continue;
      map.setPaintProperty(layer.id, 'background-color', AERIAL_GROUND_COLOR);
      map.setPaintProperty(layer.id, 'background-opacity', 1);
    }
    // Keep this source for the whole session. At z15 its tiles cover broad
    // areas cheaply; it is not another copy of the z19 detail workload.
    install(AERIAL_FALLBACK_SOURCE_ID, 512, AERIAL_FALLBACK_MAX_ZOOM);
  };

  return {
    installFallback,
    installDetailed() {
      installFallback();
      install(AERIAL_DETAIL_SOURCE_ID, 256, 19);
    },
  };
};
