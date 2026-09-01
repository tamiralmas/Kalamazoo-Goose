'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Activity,
  Bird,
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Feather,
  Footprints,
  Gauge,
  MapPin,
  Mountain,
  Navigation,
  RotateCcw,
  Radar,
  TriangleAlert,
  Trophy,
  Users,
  Volume2,
  Waves,
  Wind,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { Map as MapLibreMap, MapSourceDataEvent } from 'maplibre-gl';
import type {
  FillExtrusionLayerSpecification,
  FilterSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

import { Button } from '@/components/ui/button';
import type { FlightMode, GameTelemetry, GooseEngine } from '@/app/game-engine';
import { WMU_SPAWN } from '@/app/world-config';
import {
  AERIAL_ATTRIBUTION,
  AERIAL_BOUNDS,
  AERIAL_INFORMATION_URL,
  AERIAL_TILE_TEMPLATE,
  getAerialTileUrl,
} from '@/app/world-imagery';

const MINIMAP_ZOOM = 16;
const MINIMAP_TILE_SIZE = 256;
const MINIMAP_GRID_RADIUS = 2;
const MINIMAP_GRID_SIZE = MINIMAP_GRID_RADIUS * 2 + 1;
const MINIMAP_WORLD_SIZE = MINIMAP_TILE_SIZE * 2 ** MINIMAP_ZOOM;
const EARTH_CIRCUMFERENCE_METERS = 40_075_016.686;

const lngLatToMinimapPixel = (longitude: number, latitude: number) => {
  const latitudeRadians = (latitude * Math.PI) / 180;
  const sine = Math.min(0.9999, Math.max(-0.9999, Math.sin(latitudeRadians)));
  return {
    x: ((longitude + 180) / 360) * MINIMAP_WORLD_SIZE,
    y:
      (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) *
      MINIMAP_WORLD_SIZE,
  };
};

const minimapSpawnPixel = lngLatToMinimapPixel(WMU_SPAWN[0], WMU_SPAWN[1]);
const minimapCenterTileX = Math.floor(minimapSpawnPixel.x / MINIMAP_TILE_SIZE);
const minimapCenterTileY = Math.floor(minimapSpawnPixel.y / MINIMAP_TILE_SIZE);
const minimapMinimumTileX = minimapCenterTileX - MINIMAP_GRID_RADIUS;
const minimapMinimumTileY = minimapCenterTileY - MINIMAP_GRID_RADIUS;
const minimapSpawnGridX =
  minimapSpawnPixel.x - minimapMinimumTileX * MINIMAP_TILE_SIZE;
const minimapSpawnGridY =
  minimapSpawnPixel.y - minimapMinimumTileY * MINIMAP_TILE_SIZE;
const minimapPixelsPerMeter =
  MINIMAP_WORLD_SIZE /
  (EARTH_CIRCUMFERENCE_METERS * Math.cos((WMU_SPAWN[1] * Math.PI) / 180));
const MINIMAP_TILES = Array.from(
  { length: MINIMAP_GRID_SIZE ** 2 },
  (_, index) => {
    const column = index % MINIMAP_GRID_SIZE;
    const row = Math.floor(index / MINIMAP_GRID_SIZE);
    const x = minimapMinimumTileX + column;
    const y = minimapMinimumTileY + row;
    const url = getAerialTileUrl(MINIMAP_ZOOM, x, y);
    return {
      key: `${MINIMAP_ZOOM}/${x}/${y}`,
      style: {
        left: column * MINIMAP_TILE_SIZE,
        top: row * MINIMAP_TILE_SIZE,
        backgroundImage: `url(${url})`,
      } as CSSProperties,
    };
  },
);

const INITIAL_TELEMETRY: GameTelemetry = {
  speed: 13.8,
  agl: 42,
  sink: 0.4,
  glideRatio: 12,
  stamina: 1,
  stall: 0,
  mode: 'flying',
  score: 0,
  combo: 1,
  secretsFound: 0,
  secretsTotal: 26,
  secretVisuals: 0,
  nearestSecretLabel: 'Council of Ducks',
  nearestSecretDistance: null,
  nearestSecretDirection: 0,
  nearestSecretBearing: 0,
  students: 0,
  studentsNearby: 0,
  studentsOnMappedWalkways: 0,
  nearestStudent: null,
  nearestStudentVertical: null,
  trees: 148,
  treesResolved: 0,
  flockSize: 0,
  flockTotal: 8,
  recruitableGooseInRange: false,
  altitudeBoost: 0,
  groundElevation: 0,
  east: 0,
  north: 0,
  heading: 0,
  buildings: 0,
  cameraZoom: 15.9,
  cameraScale: 1,
  insideBuilding: false,
  renderCalls: 0,
  gooseVisible: false,
  gooseScreenX: 0,
  gooseScreenY: 0,
  duckCouncilEast: 0,
  duckCouncilNorth: 0,
  duckCouncilVisible: false,
};

const CONTROL_CODES = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'KeyE',
  'KeyH',
];

const modeCopy: Record<FlightMode, { label: string; hint: string }> = {
  flying: { label: 'Gliding', hint: 'Stunt, flap, and cause chaos' },
  planing: {
    label: 'Planing',
    hint: 'Skim the surface and ride out the splashdown',
  },
  waddling: { label: 'Waddling', hint: 'Cause extremely polite gridlock' },
  swimming: { label: 'Swimming', hint: 'Space to take off again' },
};

type CameraPointer = {
  x: number;
  y: number;
  startX: number;
  startY: number;
  downAt: number;
};

type TouchControlPointer = {
  code: string | null;
  group: 'direction' | 'action';
  button: HTMLButtonElement | null;
};

export function GooseGame() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const engineRef = useRef<GooseEngine | null>(null);
  const playingRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const cameraPointersRef = useRef(new Map<number, CameraPointer>());
  const keyboardCodesRef = useRef(new Set<string>());
  const touchPointersRef = useRef(new Map<number, TouchControlPointer>());
  const touchCodesRef = useRef(new Set<string>());
  const touchPressedButtonsRef = useRef(new Set<HTMLButtonElement>());
  const lastCameraTapRef = useRef(0);
  const [mapReady, setMapReady] = useState(false);
  const [terrainReady, setTerrainReady] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [minimapOpen, setMinimapOpen] = useState(false);
  const [minimapTilesEnabled, setMinimapTilesEnabled] = useState(false);
  const [telemetry, setTelemetry] = useState(INITIAL_TELEMETRY);
  const [toast, setToast] = useState<string | null>(null);

  const syncTouchControls = useCallback(() => {
    const nextCodes = new Set<string>();
    const nextButtons = new Set<HTMLButtonElement>();
    touchPointersRef.current.forEach((pointer) => {
      if (pointer.code) nextCodes.add(pointer.code);
      if (pointer.button) nextButtons.add(pointer.button);
    });

    const changedCodes = new Set([...touchCodesRef.current, ...nextCodes]);
    changedCodes.forEach((code) => {
      if (touchCodesRef.current.has(code) === nextCodes.has(code)) return;
      engineRef.current?.setKey(
        code,
        nextCodes.has(code) || keyboardCodesRef.current.has(code),
      );
    });

    touchPressedButtonsRef.current.forEach((button) => {
      if (nextButtons.has(button)) return;
      button.dataset.pressed = 'false';
      button.setAttribute('aria-pressed', 'false');
    });
    nextButtons.forEach((button) => {
      button.dataset.pressed = 'true';
      button.setAttribute('aria-pressed', 'true');
    });

    touchCodesRef.current = nextCodes;
    touchPressedButtonsRef.current = nextButtons;
  }, []);

  const releaseTouchPointer = useCallback(
    (pointerId: number) => {
      if (!touchPointersRef.current.delete(pointerId)) return;
      syncTouchControls();
    },
    [syncTouchControls],
  );

  const clearAllControlInputs = useCallback(() => {
    CONTROL_CODES.forEach((code) => engineRef.current?.setKey(code, false));
    keyboardCodesRef.current.clear();
    touchPointersRef.current.clear();
    touchCodesRef.current.clear();
    touchPressedButtonsRef.current.forEach((button) => {
      button.dataset.pressed = 'false';
      button.setAttribute('aria-pressed', 'false');
    });
    touchPressedButtonsRef.current.clear();
    cameraPointersRef.current.clear();
  }, []);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    let cancelled = false;
    let loaded = false;
    let terrainTimer: number | null = null;
    let mapCanvas: HTMLCanvasElement | null = null;
    const coarsePointer = window.matchMedia('(any-pointer: coarse)').matches;
    if (!coarsePointer) {
      window.requestAnimationFrame(() => {
        if (!cancelled) setMinimapTilesEnabled(true);
      });
    }
    const pixelRatio = Math.min(
      window.devicePixelRatio || 1,
      coarsePointer ? 1.5 : 2,
    );

    const showToast = (message: string) => {
      if (cancelled) return;
      setToast(message);
      if (toastTimerRef.current !== null)
        window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = window.setTimeout(() => setToast(null), 3400);
    };
    const onWebglContextLost = (event: Event) => {
      event.preventDefault();
      clearAllControlInputs();
      showToast('Graphics paused — restoring the 3D campus…');
    };

    void import('maplibre-gl')
      .then((maplibre) => {
        if (cancelled) return;
        maplibre.setWorkerUrl(maplibreWorkerUrl);
        const map = new maplibre.Map({
          container,
          style: 'https://tiles.openfreemap.org/styles/liberty',
          center: WMU_SPAWN,
          zoom: 15.9,
          pitch: 44,
          bearing: -18,
          maxPitch: 84,
          maxZoom: 24,
          interactive: false,
          renderWorldCopies: false,
          centerClampedToGround: false,
          attributionControl: false,
          pixelRatio,
          fadeDuration: coarsePointer ? 0 : 300,
          refreshExpiredTiles: !coarsePointer,
          maxTileCacheZoomLevels: coarsePointer ? 2 : 5,
          cancelPendingTileRequestsWhileZooming: true,
          canvasContextAttributes: {
            antialias: !coarsePointer,
            powerPreference: 'high-performance',
          },
        });
        mapRef.current = map;
        mapCanvas = map.getCanvas();
        mapCanvas.addEventListener('webglcontextlost', onWebglContextLost);
        map.addControl(
          new maplibre.AttributionControl({ compact: true }),
          'bottom-right',
        );

        const previewSourceId = 'wmug-aerial-preview';
        const fullSourceId = 'wmug-aerial-imagery';
        let fullAerialTileSeen = false;

        const firstBaseLayerId = () =>
          map
            .getStyle()
            .layers?.find(
              (layer) =>
                layer.type !== 'background' &&
                layer.id !== previewSourceId &&
                layer.id !== fullSourceId,
            )?.id;

        const installAerialLayer = (sourceId: string, tileSize: 256 | 512) => {
          if (map.getSource(sourceId)) return;
          map.addSource(sourceId, {
            type: 'raster',
            tiles: [AERIAL_TILE_TEMPLATE],
            tileSize,
            minzoom: 1,
            maxzoom: 19,
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
                'raster-saturation': -0.06,
                'raster-contrast': 0.08,
                'raster-brightness-min': 0.04,
                'raster-brightness-max': 0.98,
                'raster-fade-duration': 0,
                'raster-resampling': 'linear',
              },
            },
            firstBaseLayerId(),
          );
        };

        const installAerialPreview = () =>
          installAerialLayer(previewSourceId, 512);
        const installAerialImagery = () =>
          installAerialLayer(fullSourceId, 256);
        const retireAerialPreview = (event: MapSourceDataEvent) => {
          if (!coarsePointer || cancelled || event.sourceId !== fullSourceId)
            return;
          if (event.coord) fullAerialTileSeen = true;
          if (!fullAerialTileSeen || !map.isSourceLoaded(fullSourceId)) return;
          if (map.getLayer(previewSourceId)) map.removeLayer(previewSourceId);
          if (map.getSource(previewSourceId)) map.removeSource(previewSourceId);
          map.off('sourcedata', retireAerialPreview);
        };

        // Phones first request a one-zoom-lower MiSAIL preview, reducing the
        // visible startup tile count by roughly 75%. The full original imagery
        // then streams above it and replaces the preview once the viewport is ready.
        map.on('style.load', () => {
          if (coarsePointer) installAerialPreview();
          else installAerialImagery();
        });
        map.on('sourcedata', retireAerialPreview);

        map.on('error', () => {
          if (!loaded && !cancelled) setMapError(true);
        });

        map.on('load', () => {
          if (cancelled) return;
          loaded = true;
          setMapError(false);
          // Three.js and the gameplay simulation are intentionally a second
          // download. Ground imagery wins the first mobile network/render pass.
          const engineModulePromise = import('@/app/game-engine');
          try {
            installAerialImagery();
            const layers = map.getStyle().layers ?? [];

            // Let the aerial photography supply the ground detail while preserving
            // OSM water hit-testing, road guidance, labels, and real 3D geometry.
            layers.forEach((layer) => {
              const sourceLayer =
                'source-layer' in layer ? layer['source-layer'] : undefined;
              if (layer.id === 'natural_earth') {
                map.setLayoutProperty(layer.id, 'visibility', 'none');
              }
              if (
                layer.type === 'fill' &&
                (sourceLayer === 'park' ||
                  sourceLayer === 'landuse' ||
                  sourceLayer === 'landcover')
              ) {
                map.setLayoutProperty(layer.id, 'visibility', 'none');
              }
              if (layer.type === 'fill' && sourceLayer === 'water') {
                map.setPaintProperty(layer.id, 'fill-color', '#4b9eb0');
                map.setPaintProperty(layer.id, 'fill-opacity', 0.24);
              }
              if (
                layer.type === 'fill' &&
                (sourceLayer === 'building' || layer.id === 'road_area_pattern')
              ) {
                map.setLayoutProperty(layer.id, 'visibility', 'none');
              }
              if (layer.type === 'line' && sourceLayer === 'transportation') {
                map.setPaintProperty(
                  layer.id,
                  'line-opacity',
                  layer.id.includes('casing') ? 0.26 : 0.48,
                );
              }
            });

            let buildingLayer = layers.find(
              (layer) =>
                layer.type === 'fill-extrusion' &&
                layer['source-layer'] === 'building',
            );
            const hideBuildingOutlines: FilterSpecification = [
              '!=',
              ['get', 'hide_3d'],
              true,
            ];

            if (!buildingLayer) {
              const buildingSourceLayer = layers.find(
                (layer) =>
                  'source-layer' in layer &&
                  layer['source-layer'] === 'building' &&
                  'source' in layer &&
                  typeof layer.source === 'string',
              );
              const firstSymbol = layers.find(
                (layer) => layer.type === 'symbol',
              )?.id;
              const buildingSourceId =
                buildingSourceLayer &&
                'source' in buildingSourceLayer &&
                typeof buildingSourceLayer.source === 'string'
                  ? buildingSourceLayer.source
                  : null;
              if (!buildingSourceId) {
                throw new Error(
                  'The map style did not provide OSM building data.',
                );
              }
              const fallbackBuildingLayer: FillExtrusionLayerSpecification = {
                id: 'wmug-building-3d',
                type: 'fill-extrusion',
                source: buildingSourceId,
                'source-layer': 'building',
                minzoom: 14,
                filter: hideBuildingOutlines,
                paint: {
                  'fill-extrusion-color': '#c7b99f',
                  'fill-extrusion-height': [
                    'coalesce',
                    ['get', 'render_height'],
                    5,
                  ],
                  'fill-extrusion-base': [
                    'coalesce',
                    ['get', 'render_min_height'],
                    0,
                  ],
                  'fill-extrusion-opacity': 1,
                  'fill-extrusion-vertical-gradient': true,
                },
              };
              map.addLayer(fallbackBuildingLayer, firstSymbol);
              buildingLayer = map
                .getStyle()
                .layers?.find((layer) => layer.id === 'wmug-building-3d');
            }

            if (!buildingLayer || buildingLayer.type !== 'fill-extrusion') {
              throw new Error('The 3D building layer could not be created.');
            }
            const buildingFilter = (
              buildingLayer.filter
                ? ['all', buildingLayer.filter, hideBuildingOutlines]
                : hideBuildingOutlines
            ) as FilterSpecification;
            map.setFilter(buildingLayer.id, buildingFilter);
            map.setPaintProperty(buildingLayer.id, 'fill-extrusion-color', [
              'interpolate',
              ['linear'],
              ['coalesce', ['get', 'render_height'], 5],
              0,
              '#aaa79f',
              18,
              '#cbc7bd',
              52,
              '#e7e2d7',
            ]);
            map.setPaintProperty(buildingLayer.id, 'fill-extrusion-height', [
              'coalesce',
              ['get', 'render_height'],
              5,
            ]);
            map.setPaintProperty(buildingLayer.id, 'fill-extrusion-base', [
              'coalesce',
              ['get', 'render_min_height'],
              0,
            ]);
            map.setPaintProperty(buildingLayer.id, 'fill-extrusion-opacity', 1);
            map.setPaintProperty(
              buildingLayer.id,
              'fill-extrusion-vertical-gradient',
              true,
            );

            try {
              map.setSky({
                'sky-color': '#8cc8d9',
                'horizon-color': '#eee4c5',
                'fog-color': '#d7dfd5',
                'sky-horizon-blend': 0.7,
                'horizon-fog-blend': 0.34,
                'fog-ground-blend': 0.5,
                'atmosphere-blend': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  10,
                  0.88,
                  17,
                  0.24,
                ],
              });
            } catch {
              // Sky styling is decorative and must not block the game.
            }

            let terrainConfigured = false;
            try {
              map.addSource('wmug-terrain-dem', {
                type: 'raster-dem',
                url: 'https://tiles.mapterhorn.com/tilejson.json',
                tileSize: 512,
                attribution: 'Terrain © Mapterhorn',
              });
              map.setTerrain({ source: 'wmug-terrain-dem', exaggeration: 1 });
              terrainConfigured = true;
            } catch {
              terrainConfigured = false;
            }

            let worldInitialized = false;
            const finishWorld = (hasTerrain: boolean) => {
              if (worldInitialized || cancelled) return;
              worldInitialized = true;
              map.off('idle', tryTerrainReady);
              if (terrainTimer !== null) window.clearTimeout(terrainTimer);
              terrainTimer = null;

              if (!hasTerrain && terrainConfigured) {
                try {
                  map.setTerrain(null);
                  map.removeSource('wmug-terrain-dem');
                } catch {
                  // A flat map is a safe fallback; all gameplay heights use zero MSL.
                }
              }

              void engineModulePromise
                .then(({ createGooseEngine }) => {
                  if (cancelled) return;
                  try {
                    engineRef.current = createGooseEngine(maplibre, map, {
                      onTelemetry: setTelemetry,
                      onToast: showToast,
                    });
                    setTerrainReady(hasTerrain);
                    setMapReady(true);
                    setMapError(false);
                  } catch {
                    setMapError(true);
                  }
                })
                .catch(() => {
                  if (!cancelled) setMapError(true);
                });
            };

            const tryTerrainReady = () => {
              const elevation = map.queryTerrainElevation(WMU_SPAWN);
              if (typeof elevation === 'number' && Number.isFinite(elevation))
                finishWorld(true);
            };

            if (terrainConfigured) {
              map.on('idle', tryTerrainReady);
              terrainTimer = window.setTimeout(() => finishWorld(false), 3500);
              tryTerrainReady();
            } else {
              finishWorld(false);
            }
          } catch {
            setMapError(true);
          }
        });
      })
      .catch(() => {
        if (!cancelled) setMapError(true);
      });

    const onKeyDown = (event: KeyboardEvent) => {
      if (!CONTROL_CODES.includes(event.code)) return;
      if (playingRef.current) event.preventDefault();
      keyboardCodesRef.current.add(event.code);
      engineRef.current?.setKey(event.code, true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!CONTROL_CODES.includes(event.code)) return;
      keyboardCodesRef.current.delete(event.code);
      engineRef.current?.setKey(
        event.code,
        touchCodesRef.current.has(event.code),
      );
    };
    const clearControls = () => clearAllControlInputs();
    const onGlobalPointerRelease = (event: PointerEvent) =>
      releaseTouchPointer(event.pointerId);
    const preventContextMenu = (event: Event) => event.preventDefault();
    const onVisibilityChange = () => {
      if (document.hidden) clearControls();
    };
    const onCameraWheel = (event: WheelEvent) => {
      if (!playingRef.current) return;
      event.preventDefault();
      const normalized =
        event.deltaMode === 1
          ? event.deltaY * 16
          : event.deltaMode === 2
            ? event.deltaY * container.clientHeight
            : event.deltaY;
      const bounded = Math.min(180, Math.max(-180, normalized));
      engineRef.current?.scaleCameraZoom(Math.exp(bounded * 0.0015));
    };
    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearControls);
    window.addEventListener('pagehide', clearControls);
    window.addEventListener('orientationchange', clearControls);
    window.addEventListener('pointerup', onGlobalPointerRelease, true);
    window.addEventListener('pointercancel', onGlobalPointerRelease, true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    container.addEventListener('contextmenu', preventContextMenu);
    container.addEventListener('wheel', onCameraWheel, { passive: false });

    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearControls);
      window.removeEventListener('pagehide', clearControls);
      window.removeEventListener('orientationchange', clearControls);
      window.removeEventListener('pointerup', onGlobalPointerRelease, true);
      window.removeEventListener('pointercancel', onGlobalPointerRelease, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      container.removeEventListener('contextmenu', preventContextMenu);
      container.removeEventListener('wheel', onCameraWheel);
      clearAllControlInputs();
      if (toastTimerRef.current !== null)
        window.clearTimeout(toastTimerRef.current);
      if (terrainTimer !== null) window.clearTimeout(terrainTimer);
      mapCanvas?.removeEventListener('webglcontextlost', onWebglContextLost);
      engineRef.current?.destroy();
      engineRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [clearAllControlInputs, releaseTouchPointer]);

  const startGame = () => {
    if (!engineRef.current) return;
    clearAllControlInputs();
    playingRef.current = true;
    setPlaying(true);
    engineRef.current.start();
    mapContainerRef.current?.focus({ preventScroll: true });
  };

  const resetGame = () => {
    if (!engineRef.current) return;
    clearAllControlInputs();
    playingRef.current = true;
    setPlaying(true);
    engineRef.current.reset();
    mapContainerRef.current?.focus({ preventScroll: true });
  };

  const setTouchKey = (
    event: ReactPointerEvent<HTMLButtonElement>,
    code: string,
    group: TouchControlPointer['group'],
    pressed: boolean,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (pressed) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      touchPointersRef.current.set(event.pointerId, {
        code,
        group,
        button: event.currentTarget,
      });
      syncTouchControls();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The input was already recorded; capture only helps guarantee release cleanup.
      }
      return;
    }
    releaseTouchPointer(event.pointerId);
  };

  const moveTouchDirection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = touchPointersRef.current.get(event.pointerId);
    if (!pointer || pointer.group !== 'direction') return;
    event.preventDefault();
    event.stopPropagation();
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const candidate = target?.closest<HTMLButtonElement>(
      'button[data-control-group="direction"]',
    );
    const nextButton =
      candidate && event.currentTarget.contains(candidate) ? candidate : null;
    const nextCode = nextButton?.dataset.controlCode ?? null;
    if (pointer.code === nextCode && pointer.button === nextButton) return;
    touchPointersRef.current.set(event.pointerId, {
      ...pointer,
      code: nextCode,
      button: nextButton,
    });
    syncTouchControls();
  };

  const setCameraPointer = (
    event: ReactPointerEvent<HTMLDivElement>,
    pressed: boolean,
  ) => {
    if (pressed) {
      if (!playingRef.current) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          '.maplibregl-control-container, .mobile-controls, .camera-toolbar, .campus-minimap',
        )
      )
        return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (cameraPointersRef.current.size >= 2) return;
      event.preventDefault();
      cameraPointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        downAt: performance.now(),
      });
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is a convenience; the camera still works without it.
      }
      return;
    }
    const pointer = cameraPointersRef.current.get(event.pointerId);
    if (!pointer) return;
    event.preventDefault();
    const wasOnlyPointer = cameraPointersRef.current.size === 1;
    cameraPointersRef.current.delete(event.pointerId);
    const isTap =
      event.pointerType !== 'mouse' &&
      wasOnlyPointer &&
      performance.now() - pointer.downAt < 280 &&
      Math.hypot(
        event.clientX - pointer.startX,
        event.clientY - pointer.startY,
      ) < 12;
    if (isTap) {
      const now = performance.now();
      if (now - lastCameraTapRef.current < 340) {
        engineRef.current?.resetCamera();
        lastCameraTapRef.current = 0;
      } else {
        lastCameraTapRef.current = now;
      }
    }
  };

  const moveCameraPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = cameraPointersRef.current.get(event.pointerId);
    if (!previous) return;
    event.preventDefault();
    if (cameraPointersRef.current.size === 1) {
      const yawSensitivity = event.pointerType === 'touch' ? 0.0036 : 0.0045;
      const pitchSensitivity = event.pointerType === 'touch' ? 0.0028 : 0.0035;
      cameraPointersRef.current.set(event.pointerId, {
        ...previous,
        x: event.clientX,
        y: event.clientY,
      });
      engineRef.current?.orbitCamera(
        -(event.clientX - previous.x) * yawSensitivity,
        -(event.clientY - previous.y) * pitchSensitivity,
      );
      return;
    }
    const before = [...cameraPointersRef.current.values()];
    const oldCenterX = (before[0].x + before[1].x) * 0.5;
    const oldCenterY = (before[0].y + before[1].y) * 0.5;
    const oldDistance = Math.hypot(
      before[1].x - before[0].x,
      before[1].y - before[0].y,
    );
    cameraPointersRef.current.set(event.pointerId, {
      ...previous,
      x: event.clientX,
      y: event.clientY,
    });
    const after = [...cameraPointersRef.current.values()];
    const newCenterX = (after[0].x + after[1].x) * 0.5;
    const newCenterY = (after[0].y + after[1].y) * 0.5;
    const newDistance = Math.hypot(
      after[1].x - after[0].x,
      after[1].y - after[0].y,
    );
    engineRef.current?.orbitCamera(
      -(newCenterX - oldCenterX) * 0.0045,
      -(newCenterY - oldCenterY) * 0.0035,
    );
    if (oldDistance > 1 && newDistance > 1) {
      engineRef.current?.scaleCameraZoom(oldDistance / newDistance);
    }
  };

  const toggleMinimap = () => {
    const nextOpen = !minimapOpen;
    setMinimapOpen(nextOpen);
    if (nextOpen) setMinimapTilesEnabled(true);
  };

  const mode = modeCopy[telemetry.mode];
  const glideRatio =
    telemetry.glideRatio === null
      ? '—'
      : `${telemetry.glideRatio.toFixed(1)}:1`;
  const sinkLabel =
    telemetry.sink > 0.05
      ? `${telemetry.sink.toFixed(1)} m/s sink`
      : `${Math.abs(telemetry.sink).toFixed(1)} m/s climb`;
  const nearestSecretLabel =
    telemetry.nearestSecretLabel ?? 'All anomalies found';
  const nearestSecretDistance =
    telemetry.nearestSecretDistance === null
      ? 'Complete'
      : `${Math.round(telemetry.nearestSecretDistance)} m`;
  const flockDiscoveryCopy = telemetry.recruitableGooseInRange
    ? 'Honk now to recruit this goose'
    : `Flock ${telemetry.flockSize}/${telemetry.flockTotal}`;
  const minimapHeadingDegrees = (telemetry.heading * 180) / Math.PI;
  const showMobileDiscoveryChip = playing && !toast && telemetry.stall <= 0.22;
  const minimapTileStyle = {
    transform: `translate3d(${-minimapSpawnGridX - telemetry.east * minimapPixelsPerMeter}px, ${-minimapSpawnGridY + telemetry.north * minimapPixelsPerMeter}px, 0)`,
  } as CSSProperties;
  const objectiveBearingRadians =
    (telemetry.nearestSecretBearing * Math.PI) / 180;
  const objectiveMarkerRadius =
    telemetry.nearestSecretDistance === null
      ? 0
      : Math.min(
          62,
          Math.max(18, telemetry.nearestSecretDistance * minimapPixelsPerMeter),
        );
  const minimapObjectiveStyle = {
    left: `calc(50% + ${Math.sin(objectiveBearingRadians) * objectiveMarkerRadius}px)`,
    top: `calc(50% - ${Math.cos(objectiveBearingRadians) * objectiveMarkerRadius}px)`,
  } as CSSProperties;
  const secretCompassStyle = {
    '--secret-bearing': `${telemetry.nearestSecretDirection}deg`,
  } as CSSProperties;

  return (
    <main
      className={`game-shell ${playing ? 'is-playing' : 'is-launching'}${minimapOpen ? ' is-minimap-open' : ''}`}
      data-campus-students={telemetry.students}
      data-nearby-students={telemetry.studentsNearby}
      data-students-on-mapped-walkways={telemetry.studentsOnMappedWalkways}
      data-nearest-student-meters={telemetry.nearestStudent?.toFixed(1) ?? ''}
      data-nearest-student-vertical={
        telemetry.nearestStudentVertical?.toFixed(1) ?? ''
      }
      data-ground-elevation={telemetry.groundElevation.toFixed(1)}
      data-goose-east={telemetry.east.toFixed(1)}
      data-goose-north={telemetry.north.toFixed(1)}
      data-goose-heading={telemetry.heading.toFixed(3)}
      data-building-colliders={telemetry.buildings}
      data-camera-map-zoom={telemetry.cameraZoom.toFixed(3)}
      data-camera-scale={telemetry.cameraScale.toFixed(3)}
      data-goose-inside-building={telemetry.insideBuilding}
      data-goose-visible={telemetry.gooseVisible}
      data-three-render-calls={telemetry.renderCalls}
      data-goose-screen-x={telemetry.gooseScreenX.toFixed(1)}
      data-goose-screen-y={telemetry.gooseScreenY.toFixed(1)}
      data-duck-council-east={telemetry.duckCouncilEast.toFixed(1)}
      data-duck-council-north={telemetry.duckCouncilNorth.toFixed(1)}
      data-duck-council-visible={telemetry.duckCouncilVisible}
      data-secret-visuals={telemetry.secretVisuals}
      data-nearest-secret={telemetry.nearestSecretLabel ?? ''}
      data-nearest-secret-meters={
        telemetry.nearestSecretDistance?.toFixed(1) ?? ''
      }
      data-tree-instances={telemetry.trees}
      data-tree-visuals={playing ? telemetry.trees : 0}
      data-tree-terrain-resolved={telemetry.treesResolved}
      data-flock-size={telemetry.flockSize}
      data-altitude-boost={telemetry.altitudeBoost.toFixed(3)}
      data-speed={telemetry.speed.toFixed(2)}
      data-agl={telemetry.agl.toFixed(2)}
    >
      <div
        ref={mapContainerRef}
        className="real-map-canvas"
        aria-label="Interactive real-scale goose flight over aerial imagery and OpenStreetMap 3D data at Western Michigan University"
        tabIndex={-1}
        onPointerDown={(event) => setCameraPointer(event, true)}
        onPointerMove={moveCameraPointer}
        onPointerUp={(event) => setCameraPointer(event, false)}
        onPointerCancel={(event) => setCameraPointer(event, false)}
        onLostPointerCapture={(event) => setCameraPointer(event, false)}
        onDoubleClick={() => engineRef.current?.resetCamera()}
      />
      <div className="sky-vignette" aria-hidden="true" />

      <header className="game-topbar">
        <div className="brand-lockup" aria-label="Kalamazoo Goose">
          <span className="brand-mark">
            <Bird />
          </span>
          <span>
            <strong>KALAMAZOO</strong>
            <small>GOOSE · WMU</small>
          </span>
        </div>
        <div className="location-chip">
          <MapPin />
          <span>
            <strong>Western Michigan University</strong>
            <small>42.284881° N · 85.616863° W</small>
          </span>
        </div>
        {playing && (
          <div className="top-actions">
            <div className="camera-toolbar" aria-label="Camera controls">
              <button
                type="button"
                title="Zoom in"
                aria-label="Zoom camera in"
                onClick={() => engineRef.current?.scaleCameraZoom(0.72)}
              >
                <ZoomIn />
              </button>
              <output
                className="camera-zoom-readout"
                aria-label="Camera zoom level"
              >
                {Math.round(100 / telemetry.cameraScale)}%
              </output>
              <button
                type="button"
                title="Zoom out"
                aria-label="Zoom camera out"
                onClick={() => engineRef.current?.scaleCameraZoom(1.38)}
              >
                <ZoomOut />
              </button>
              <button
                type="button"
                title="Reset camera"
                aria-label="Reset camera"
                onClick={() => engineRef.current?.resetCamera()}
              >
                <RotateCcw />
              </button>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="map-reset-button"
              onClick={resetGame}
              disabled={!mapReady}
            >
              <Navigation /> Respawn
            </Button>
          </div>
        )}
      </header>

      {!playing && (
        <section
          className="launch-card game-launch-card"
          aria-labelledby="launch-title"
        >
          <div className="eyebrow">
            <span /> REAL-SCALE CAMPUS · AERIAL ROOFS · CHAOS SANDBOX
          </div>
          <h1 id="launch-title">
            Take wing
            <br />
            over WMU.
          </h1>
          <p>
            Fly, honk, recruit a V-formation flock, scatter trail-walking
            students, skim across ponds, and uncover twenty-six campus secrets.
          </p>
          <Button
            className="launch-button"
            size="lg"
            onClick={startGame}
            disabled={!mapReady}
          >
            <Feather />{' '}
            {mapReady
              ? 'Fly from WMU'
              : mapError
                ? 'Map is reconnecting…'
                : 'Loading 3D campus…'}
          </Button>
          <div className="launch-features" aria-label="World data">
            <span>
              <Building2 />
              <strong>Real campus</strong>
            </span>
            <span>
              <Users />
              <strong>Trail crowds</strong>
            </span>
            <span>
              <Bird />
              <strong>8-goose flock</strong>
            </span>
          </div>
          <p className="launch-note">
            {mapError ? (
              'A map service failed to respond. It will retry when the page reloads.'
            ) : (
              <>
                <span className="desktop-instructions">
                  Tap Space for one wingbeat · Hold it for continuous flapping
                </span>
                <span className="touch-instructions">
                  Use the on-screen controls · Hold Flap for continuous
                  wingbeats
                </span>
              </>
            )}
          </p>
        </section>
      )}

      {playing && (
        <>
          <section className="telemetry-panel" aria-label="Flight telemetry">
            <div>
              <span className="telemetry-icon">
                <Gauge />
              </span>
              <span>
                <small>
                  {telemetry.altitudeBoost > 0 ? 'Jetstream speed' : 'Airspeed'}
                </small>
                <strong>{telemetry.speed.toFixed(1)}</strong>
                <em>m/s</em>
              </span>
            </div>
            <div>
              <span className="telemetry-icon">
                <Mountain />
              </span>
              <span>
                <small>Above ground</small>
                <strong>{telemetry.agl.toFixed(0)}</strong>
                <em>m</em>
              </span>
            </div>
            <div>
              <span className="telemetry-icon">
                <Wind />
              </span>
              <span>
                <small>Glide</small>
                <strong>{glideRatio}</strong>
                <em>{sinkLabel}</em>
              </span>
            </div>
          </section>

          <section
            className={`mobile-status-strip${telemetry.score >= 10_000 ? ' is-infamous' : ''}`}
            aria-label="Mobile flight status"
          >
            <span>
              <small>{telemetry.altitudeBoost > 0 ? 'Boost' : 'Speed'}</small>
              <strong>
                {telemetry.speed.toFixed(0)}
                <em>m/s</em>
              </strong>
            </span>
            <span>
              <small>Altitude</small>
              <strong>
                {telemetry.agl.toFixed(0)}
                <em>m</em>
              </strong>
            </span>
            <span>
              <small>Stamina</small>
              <strong>
                {Math.round(telemetry.stamina * 100)}
                <em>%</em>
              </strong>
            </span>
            <span>
              <small>Chaos</small>
              <strong>{telemetry.score.toLocaleString()}</strong>
            </span>
          </section>

          <div className="right-hud-stack">
            <aside className="objective-card">
              <span
                className="objective-icon secret-bearing"
                style={secretCompassStyle}
              >
                <Radar />
              </span>
              <span>
                <small>Nearest campus anomaly</small>
                <strong>{nearestSecretLabel}</strong>
                <em>
                  {nearestSecretDistance} · {telemetry.secretsFound}/
                  {telemetry.secretsTotal} secrets
                </em>
                <em className="flock-hint">{flockDiscoveryCopy}</em>
              </span>
            </aside>

            <div
              className="stamina-card"
              aria-label={`Wing stamina ${Math.round(telemetry.stamina * 100)} percent`}
            >
              <span>
                <Activity />
                <small>Wing stamina</small>
                <strong>{Math.round(telemetry.stamina * 100)}%</strong>
              </span>
              <i>
                <b style={{ width: `${telemetry.stamina * 100}%` }} />
              </i>
            </div>

            <div
              className="chaos-card"
              aria-label={`Chaos score ${telemetry.score}, combo times ${telemetry.combo}`}
            >
              <span>
                <Trophy />
                <small>Chaos score</small>
                <strong>{telemetry.score.toLocaleString()}</strong>
              </span>
              <em
                className={
                  telemetry.score >= 10_000
                    ? 'is-infamous'
                    : telemetry.combo > 1
                      ? 'is-hot'
                      : ''
                }
              >
                {telemetry.score >= 10_000
                  ? 'CROWD FEAR'
                  : `COMBO ×${telemetry.combo}`}
              </em>
            </div>
          </div>

          <aside
            className={`campus-minimap${minimapOpen ? ' is-open' : ''}`}
            aria-label="Campus minimap"
          >
            <div className="minimap-desktop-title">
              <span>
                <MapPin /> Campus map
              </span>
              <small>North up</small>
            </div>
            <button
              type="button"
              className="minimap-mobile-toggle"
              aria-expanded={minimapOpen}
              aria-controls="campus-minimap-panel"
              onClick={toggleMinimap}
            >
              <MapPin />
              <span>
                <strong>Campus map</strong>
                <small>{minimapOpen ? 'Tap to close' : 'Tap to open'}</small>
              </span>
              <ChevronDown className="minimap-toggle-chevron" />
            </button>
            <div className="minimap-panel" id="campus-minimap-panel">
              <figure
                className="minimap-viewport"
                aria-label={`Aerial map centered on the goose. ${telemetry.nearestSecretDistance === null ? 'All campus anomalies found.' : `Nearest anomaly ${nearestSecretLabel}, ${Math.round(telemetry.nearestSecretDistance)} meters away.`}`}
              >
                <div
                  className="minimap-tiles"
                  style={minimapTileStyle}
                  aria-hidden="true"
                >
                  {minimapTilesEnabled &&
                    MINIMAP_TILES.map((tile) => (
                      <span
                        key={tile.key}
                        className="minimap-tile"
                        aria-hidden="true"
                        style={tile.style}
                      />
                    ))}
                </div>
                <span className="minimap-north" aria-hidden="true">
                  N
                </span>
                {telemetry.nearestSecretDistance !== null && (
                  <span
                    className="minimap-objective-marker"
                    style={minimapObjectiveStyle}
                    aria-hidden="true"
                  >
                    <Radar />
                  </span>
                )}
                <span
                  className="minimap-goose-marker"
                  style={{
                    transform: `translate(-50%, -50%) rotate(${minimapHeadingDegrees}deg)`,
                  }}
                  aria-hidden="true"
                >
                  <Bird />
                </span>
              </figure>
              <a
                className="minimap-attribution"
                href={AERIAL_INFORMATION_URL}
                target="_blank"
                rel="noreferrer"
              >
                MiSAIL imagery · State of Michigan
              </a>
            </div>
          </aside>

          {telemetry.altitudeBoost > 0 && (
            <div className="jetstream-indicator">
              <Wind /> JETSTREAM · +{Math.round(telemetry.altitudeBoost * 21)}%
              TOP SPEED
            </div>
          )}

          <div className="flight-reticle" aria-hidden="true">
            <span />
            <i />
          </div>

          <div className="mode-stack">
            <span className={`mode-badge mode-${telemetry.mode}`}>
              {telemetry.mode === 'flying' ? (
                <Bird />
              ) : telemetry.mode === 'swimming' ||
                telemetry.mode === 'planing' ? (
                <Waves />
              ) : (
                <Footprints />
              )}
              {mode.label}
            </span>
            <span>{mode.hint}</span>
          </div>

          <div className="camera-hint">
            Drag to orbit · pinch to zoom · double-tap to reset
          </div>

          <div className="control-deck" aria-label="Controls">
            <span>
              <kbd>W</kbd> dive
            </span>
            <span>
              <kbd>S</kbd> pull up
            </span>
            <span>
              <kbd>A</kbd>
              <kbd>D</kbd> bank
            </span>
            <i />
            <span>
              <kbd>SPACE</kbd> tap / hold to flap
            </span>
            <span>
              <kbd>SHIFT</kbd> flare / brake
            </span>
            <span>
              <kbd>E</kbd> honk
            </span>
            <i />
            <span>
              <kbd>DRAG</kbd> camera
            </span>
            <span>
              <kbd>SCROLL</kbd> zoom
            </span>
          </div>

          <div className="mobile-controls" aria-label="Touch flight controls">
            <div className="touch-pad" onPointerMove={moveTouchDirection}>
              <button
                type="button"
                aria-label="Dive"
                aria-pressed="false"
                data-control-code="KeyW"
                data-control-group="direction"
                data-pressed="false"
                onPointerDown={(event) =>
                  setTouchKey(event, 'KeyW', 'direction', true)
                }
                onPointerUp={(event) =>
                  setTouchKey(event, 'KeyW', 'direction', false)
                }
                onPointerCancel={(event) =>
                  setTouchKey(event, 'KeyW', 'direction', false)
                }
                onLostPointerCapture={(event) =>
                  setTouchKey(event, 'KeyW', 'direction', false)
                }
              >
                <ChevronUp />
              </button>
              <button
                type="button"
                aria-label="Bank left"
                aria-pressed="false"
                data-control-code="KeyA"
                data-control-group="direction"
                data-pressed="false"
                onPointerDown={(event) =>
                  setTouchKey(event, 'KeyA', 'direction', true)
                }
                onPointerUp={(event) =>
                  setTouchKey(event, 'KeyA', 'direction', false)
                }
                onPointerCancel={(event) =>
                  setTouchKey(event, 'KeyA', 'direction', false)
                }
                onLostPointerCapture={(event) =>
                  setTouchKey(event, 'KeyA', 'direction', false)
                }
              >
                <ChevronLeft />
              </button>
              <button
                type="button"
                aria-label="Pull up"
                aria-pressed="false"
                data-control-code="KeyS"
                data-control-group="direction"
                data-pressed="false"
                onPointerDown={(event) =>
                  setTouchKey(event, 'KeyS', 'direction', true)
                }
                onPointerUp={(event) =>
                  setTouchKey(event, 'KeyS', 'direction', false)
                }
                onPointerCancel={(event) =>
                  setTouchKey(event, 'KeyS', 'direction', false)
                }
                onLostPointerCapture={(event) =>
                  setTouchKey(event, 'KeyS', 'direction', false)
                }
              >
                <ChevronDown />
              </button>
              <button
                type="button"
                aria-label="Bank right"
                aria-pressed="false"
                data-control-code="KeyD"
                data-control-group="direction"
                data-pressed="false"
                onPointerDown={(event) =>
                  setTouchKey(event, 'KeyD', 'direction', true)
                }
                onPointerUp={(event) =>
                  setTouchKey(event, 'KeyD', 'direction', false)
                }
                onPointerCancel={(event) =>
                  setTouchKey(event, 'KeyD', 'direction', false)
                }
                onLostPointerCapture={(event) =>
                  setTouchKey(event, 'KeyD', 'direction', false)
                }
              >
                <ChevronRight />
              </button>
            </div>
            <div className="touch-actions">
              <button
                type="button"
                className="honk-action"
                aria-label="Honk"
                aria-pressed="false"
                data-control-code="KeyE"
                data-control-group="action"
                data-pressed="false"
                onPointerDown={(event) =>
                  setTouchKey(event, 'KeyE', 'action', true)
                }
                onPointerUp={(event) =>
                  setTouchKey(event, 'KeyE', 'action', false)
                }
                onPointerCancel={(event) =>
                  setTouchKey(event, 'KeyE', 'action', false)
                }
                onLostPointerCapture={(event) =>
                  setTouchKey(event, 'KeyE', 'action', false)
                }
              >
                <Volume2 />
                <span>Honk</span>
              </button>
              <button
                type="button"
                aria-label="Flare and airbrake"
                aria-pressed="false"
                data-control-code="ShiftLeft"
                data-control-group="action"
                data-pressed="false"
                onPointerDown={(event) =>
                  setTouchKey(event, 'ShiftLeft', 'action', true)
                }
                onPointerUp={(event) =>
                  setTouchKey(event, 'ShiftLeft', 'action', false)
                }
                onPointerCancel={(event) =>
                  setTouchKey(event, 'ShiftLeft', 'action', false)
                }
                onLostPointerCapture={(event) =>
                  setTouchKey(event, 'ShiftLeft', 'action', false)
                }
              >
                <Wind />
                <span>Flare</span>
              </button>
              <button
                type="button"
                className="flap-action"
                aria-label="Flap wings"
                aria-pressed="false"
                data-control-code="Space"
                data-control-group="action"
                data-pressed="false"
                onPointerDown={(event) =>
                  setTouchKey(event, 'Space', 'action', true)
                }
                onPointerUp={(event) =>
                  setTouchKey(event, 'Space', 'action', false)
                }
                onPointerCancel={(event) =>
                  setTouchKey(event, 'Space', 'action', false)
                }
                onLostPointerCapture={(event) =>
                  setTouchKey(event, 'Space', 'action', false)
                }
              >
                <Feather />
                <span>Flap</span>
              </button>
            </div>
          </div>
        </>
      )}

      <div className="mobile-alert-stack">
        {showMobileDiscoveryChip && (
          <div
            className="mobile-discovery-chip"
            aria-label={`Nearest anomaly ${nearestSecretLabel}, ${nearestSecretDistance}. ${flockDiscoveryCopy}`}
          >
            <span className="secret-bearing" style={secretCompassStyle}>
              <Radar />
            </span>
            <strong>{nearestSecretLabel}</strong>
            <em>
              {nearestSecretDistance} · {flockDiscoveryCopy}
            </em>
          </div>
        )}
        {playing && telemetry.stall > 0.22 && (
          <div className="stall-warning">
            <TriangleAlert />
            <span className="desktop-instructions">
              STALL · LOWER THE NOSE WITH W
            </span>
            <span className="touch-instructions">STALL · HOLD DIVE</span>
          </div>
        )}
        {toast && <output className="game-toast">{toast}</output>}
      </div>

      <footer className="game-footer">
        <span>SATELLITE GROUND + AERIAL ROOFS + OSM 3D</span>
        <i />
        <span>{terrainReady ? 'REAL TERRAIN' : '3D BUILDINGS'} · WMU</span>
        <span className="map-credit">
          ©{' '}
          <a href={AERIAL_INFORMATION_URL} target="_blank" rel="noreferrer">
            State of Michigan MiSAIL
          </a>{' '}
          ·{' '}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
          >
            OpenStreetMap
          </a>{' '}
          ·{' '}
          <a href="https://openfreemap.org" target="_blank" rel="noreferrer">
            OpenFreeMap
          </a>
          {terrainReady && (
            <>
              {' '}
              ·{' '}
              <a
                href="https://mapterhorn.com/attribution/"
                target="_blank"
                rel="noreferrer"
              >
                Mapterhorn
              </a>
            </>
          )}
        </span>
      </footer>
    </main>
  );
}
