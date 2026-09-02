'use client';

import {
  useCallback,
  useEffect,
  useMemo,
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
  Coins,
  Feather,
  Footprints,
  Gauge,
  Hand,
  ListChecks,
  MapPin,
  Mountain,
  Navigation,
  Pause,
  RotateCcw,
  Radar,
  TriangleAlert,
  Trophy,
  Users,
  Vault,
  Volume2,
  Waves,
  Wind,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  ErrorEvent as MapLibreErrorEvent,
  Map as MapLibreMap,
  MapSourceDataEvent,
} from 'maplibre-gl';
import type {
  FillExtrusionLayerSpecification,
  FilterSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

import { Button } from '@/components/ui/button';
import { TOTAL_CAMPUS_SECRETS } from '@/app/chaos-secrets';
import { isTouchDevice } from '@/app/device';
import { CONTROL_CODES, JETSTREAM_BOOST_PERCENT } from '@/app/game-contract';
import type {
  MutatorDefinition,
  ProgressState,
  ProgressStore,
} from '@/app/game-contract';
import type {
  FlightMode,
  GameTelemetry,
  GooseEngine,
  ToastPriority,
} from '@/app/game-engine';
import { LockerPanel } from '@/app/hud/locker-panel';
import { PauseMenu } from '@/app/hud/pause-menu';
import { QuestDrawer } from '@/app/hud/quest-drawer';
import { useProgress } from '@/app/hud/use-progress';
import { MUTATOR_BY_ID } from '@/app/mutators';
import { createProgressStore } from '@/app/progress';
import { resolveRenderPixelRatio } from '@/app/render-scale';
import { QUESTS } from '@/app/quests';
import { WMU_SPAWN } from '@/app/world-config';
import {
  AERIAL_ATTRIBUTION,
  AERIAL_BOUNDS,
  AERIAL_INFORMATION_URL,
  AERIAL_TILE_TEMPLATE,
  TERRAIN_ATTRIBUTION,
  TERRAIN_MAX_ZOOM,
  TERRAIN_TILE_TEMPLATE,
  getAerialTileUrl,
} from '@/app/world-imagery';

// Zoom 15 (~4.8 m/px at Kalamazoo's latitude) rather than 16 (~2.4 m/px): at
// 16 the minimap's edge-clamp radius only covered ~150m, so nearly every
// unfound secret sat pinned to a small ring around the goose. At 15 the
// ~198px desktop viewport shows roughly 900m across, wide enough that most
// nearby secrets render at their true position instead of on the edge.
const MINIMAP_ZOOM = 15;
const MINIMAP_TILE_SIZE = 256;
const MINIMAP_GRID_RADIUS = 1;
const MINIMAP_GRID_SIZE = MINIMAP_GRID_RADIUS * 2 + 1;
const MINIMAP_WORLD_SIZE = MINIMAP_TILE_SIZE * 2 ** MINIMAP_ZOOM;
// Edge indicators clamp to the viewport rectangle, inset this many px from
// the true edge, and a marker within this margin of the true edge still
// counts as "in view" (so it never renders half-clipped before flipping).
const MINIMAP_EDGE_INSET_PX = 8;
const MINIMAP_IN_VIEW_MARGIN_PX = 9;
const MINIMAP_EDGE_MARKER_LIMIT = 3;
/** How long the launch waits for the spawn DEM tile before starting flat. */
const TERRAIN_READY_DEADLINE_MS = 12_000;
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
const minimapPixelsPerMeter =
  MINIMAP_WORLD_SIZE /
  (EARTH_CIRCUMFERENCE_METERS * Math.cos((WMU_SPAWN[1] * Math.PI) / 180));

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
  secretsTotal: TOTAL_CAMPUS_SECRETS,
  secretVisuals: 0,
  nearestSecretLabel: 'Council of Ducks',
  nearestSecretDistance: null,
  nearestSecretDirection: 0,
  nearestSecretBearing: 0,
  secretMarkers: [],
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
  buildingsResolved: 0,
  cameraZoom: 15.9,
  cameraScale: 10 / 7,
  insideBuilding: false,
  renderCalls: 0,
  gooseVisible: false,
  gooseScreenX: 0,
  gooseScreenY: 0,
  duckCouncilEast: 0,
  duckCouncilNorth: 0,
  duckCouncilVisible: false,
  paused: false,
  tokens: 0,
  questsCompleted: 0,
  questsTotal: QUESTS.length,
  props: 0,
  propsAwake: 0,
  holding: null,
  activeMutators: [],
  gooseScale: 1,
  ragdolling: false,
  timeScale: 1,
};

const CONTROL_CODE_SET = new Set<string>(CONTROL_CODES);

const modeCopy: Record<FlightMode, { label: string; hint: string }> = {
  flying: { label: 'Gliding', hint: 'Stunt, flap, and cause chaos' },
  planing: {
    label: 'Planing',
    hint: 'Skim the surface and ride out the splashdown',
  },
  waddling: { label: 'Waddling', hint: 'Cause extremely polite gridlock' },
  swimming: { label: 'Swimming', hint: 'Space to take off again' },
};

/** Display names for `telemetry.holding` (a PropKind | ItemKind id). */
const HOLDING_NAMES: Record<string, string> = {
  cone: 'cone',
  bench: 'bench',
  trash: 'trash can',
  bike: 'bike',
  sign: 'sign',
  flag: 'flag',
  phone: 'phone',
  coffee: 'coffee',
  sandwich: 'sandwich',
  'id-card': 'ID card',
  umbrella: 'umbrella',
};

const QUEST_PULSE_MS = 900;

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

type GameToast = {
  message: string;
  priority: ToastPriority;
  shownAt: number;
};

const TOAST_DURATION_MS = 3400;
// An informational toast waits this long before it may replace a score toast.
const SCORE_TOAST_HOLD_MS = 1800;

export function GooseGame() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const engineRef = useRef<GooseEngine | null>(null);
  const progressRef = useRef<ReturnType<typeof createProgressStore> | null>(
    null,
  );
  const progressStore = (progressRef.current ??= createProgressStore());
  const progress = useProgress(progressStore);
  const playingRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const toastRef = useRef<GameToast | null>(null);
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
  const minimapViewportRef = useRef<HTMLElement>(null);
  // Measured px size of the (square) .minimap-viewport box, so the in-view
  // vs. edge-indicator split below matches what actually renders -- the
  // panel is 214px on desktop but 156px/190px collapsed/open on touch (see
  // MINIMAP_IN_VIEW_MARGIN_PX etc. above), and this keeps the same geometry
  // logic correct at every size without hard-coding per-breakpoint numbers.
  const [minimapViewportPx, setMinimapViewportPx] = useState(198);
  useEffect(() => {
    const node = minimapViewportRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && entry.contentRect.width > 0) {
        setMinimapViewportPx(entry.contentRect.width);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const [telemetry, setTelemetry] = useState(INITIAL_TELEMETRY);
  const [toast, setToast] = useState<GameToast | null>(null);
  const [questDrawerOpen, setQuestDrawerOpen] = useState(false);
  const [pauseMenuOpen, setPauseMenuOpen] = useState(false);
  const [launchLockerOpen, setLaunchLockerOpen] = useState(false);
  const [questPulse, setQuestPulse] = useState(false);
  const previousCompletedQuestsRef = useRef(progress.completedQuests.length);

  const handleTelemetry = useCallback((nextTelemetry: GameTelemetry) => {
    setTelemetry(nextTelemetry);
  }, []);

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
    const coarsePointer = isTouchDevice();
    if (!coarsePointer) {
      window.requestAnimationFrame(() => {
        if (!cancelled) setMinimapTilesEnabled(true);
      });
    }
    const pixelRatio = resolveRenderPixelRatio(
      progressStore.get().settings.renderScale,
      window.devicePixelRatio || 1,
      coarsePointer,
      container.clientWidth || window.innerWidth,
      container.clientHeight || window.innerHeight,
    );

    const showToast = (message: string, priority: ToastPriority = 'info') => {
      if (cancelled) return;
      const now = performance.now();
      const current = toastRef.current;
      if (
        priority === 'info' &&
        current?.priority === 'score' &&
        now - current.shownAt < SCORE_TOAST_HOLD_MS
      )
        return;
      const nextToast: GameToast = { message, priority, shownAt: now };
      toastRef.current = nextToast;
      setToast(nextToast);
      if (toastTimerRef.current !== null)
        window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = window.setTimeout(() => {
        toastRef.current = null;
        setToast(null);
      }, TOAST_DURATION_MS);
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
          // MapLibre 6 slices vector tiles into finer chunks for the first
          // few zoom levels past the source's maxzoom (14 here), and with
          // terrain on it lifts every chunk by the DEM under that chunk's
          // own centroid. Flying toward a building therefore re-cut it into
          // smaller pieces four times, each piece jumping to a new height:
          // the "buildings keep updating as you get closer" effect. Leaving
          // this undefined keeps the whole zoom-14 geometry per tile, so a
          // building is one piece at one height from any distance.
          zoomLevelsToOverscale: undefined,
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
        const collapseAttribution = () =>
          map
            .getContainer()
            .querySelector('.maplibregl-ctrl-attrib')
            ?.classList.remove('maplibregl-compact-show');
        collapseAttribution();
        map.once('load', collapseAttribution);

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
                // Sharper imagery streams in as the goose approaches; a
                // cross-fade keeps that from reading as the ground popping.
                // Phones skip it: every extra blended tile costs fill rate.
                'raster-fade-duration': coarsePointer ? 0 : 450,
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

        map.on('error', (event) => {
          // A single failed tile (an aerial or DEM request that timed out)
          // is retried by MapLibre and must not flip the launch button into
          // its "reconnecting" state. Only style/source level failures do.
          if ((event as { tile?: unknown }).tile) return;
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

            // Symbol placement is the single largest main-thread cost with
            // a chase camera: MapLibre re-runs label collision every frame
            // the camera moves, and with terrain on every road-name glyph
            // also samples the DEM. Measured on an RTX laptop at 1080p:
            // 2.7 ms per frame on average with 50 ms spikes with the full
            // Liberty label set, 0.07 ms with only the POI layers. Road
            // names, shields, one-way arrows and water names are the cost
            // and add nothing at goose height; campus POI names and the
            // town labels stay.
            for (const layer of layers) {
              if (layer.type !== 'symbol') continue;
              const keep =
                layer.id.startsWith('poi') || layer.id.startsWith('label_');
              if (!keep) map.setLayoutProperty(layer.id, 'visibility', 'none');
            }

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
              // Mapterhorn's TileJSON declares no maxzoom, so MapLibre would
              // request DEM tiles up to zoom 22 while the chase camera sits at
              // zoom 21-23. Around Kalamazoo the dataset stops at zoom 16;
              // every deeper request was a guaranteed 404 (about 60 per
              // session) that also delayed terrain readiness at spawn.
              map.addSource('wmug-terrain-dem', {
                type: 'raster-dem',
                tiles: [TERRAIN_TILE_TEMPLATE],
                encoding: 'terrarium',
                tileSize: 512,
                minzoom: 0,
                maxzoom: TERRAIN_MAX_ZOOM,
                attribution: TERRAIN_ATTRIBUTION,
              });
              map.setTerrain({ source: 'wmug-terrain-dem', exaggeration: 1 });
              terrainConfigured = true;
            } catch {
              terrainConfigured = false;
            }

            let worldInitialized = false;
            let terrainPoll: number | null = null;
            const finishWorld = (hasTerrain: boolean) => {
              if (worldInitialized || cancelled) return;
              worldInitialized = true;
              map.off('idle', tryTerrainReady);
              map.off('error', onTerrainTileError);
              if (terrainTimer !== null) window.clearTimeout(terrainTimer);
              terrainTimer = null;
              if (terrainPoll !== null) window.clearInterval(terrainPoll);
              terrainPoll = null;

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
                    const progress = progressRef.current;
                    if (!progress) throw new Error('Progress store missing.');
                    engineRef.current = createGooseEngine(
                      maplibre,
                      map,
                      {
                        onTelemetry: handleTelemetry,
                        onToast: showToast,
                      },
                      progress,
                    );
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
              // MapLibre answers 0 until the first DEM tile has decoded, and a
              // source declared with explicit tiles makes the terrain object
              // exist immediately. Treat that placeholder like the engine
              // does (WMU sits near 275 m, so anything under 20 m is not real)
              // or the goose gets placed at sea level under the terrain.
              const elevation = map.queryTerrainElevation(WMU_SPAWN);
              if (
                typeof elevation === 'number' &&
                Number.isFinite(elevation) &&
                Math.abs(elevation) >= 20
              )
                finishWorld(true);
            };

            // A DEM tile that fails outright (not a 404, MapLibre swallows
            // those) while the world is still waiting means the terrain host
            // is unreachable: start flat now rather than at the deadline.
            const onTerrainTileError = (event: MapLibreErrorEvent) => {
              const detail = event as { tile?: unknown; sourceId?: string };
              if (detail.tile && detail.sourceId === 'wmug-terrain-dem')
                finishWorld(false);
            };

            if (terrainConfigured) {
              map.on('idle', tryTerrainReady);
              map.on('error', onTerrainTileError);
              // The deadline is generous because a flat campus is permanent
              // for the session: on a slow connection the spawn DEM tile can
              // take several seconds, and 3.5 s was turning real terrain into
              // a coin flip. The poll covers a background tab, where 'idle'
              // waits on a throttled animation frame.
              terrainTimer = window.setTimeout(
                () => finishWorld(false),
                TERRAIN_READY_DEADLINE_MS,
              );
              terrainPoll = window.setInterval(tryTerrainReady, 250);
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
      if (!CONTROL_CODE_SET.has(event.code)) return;
      if (playingRef.current) event.preventDefault();
      keyboardCodesRef.current.add(event.code);
      engineRef.current?.setKey(event.code, true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!CONTROL_CODE_SET.has(event.code)) return;
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
  }, [
    clearAllControlInputs,
    handleTelemetry,
    releaseTouchPointer,
    progressStore,
  ]);

  // Keeps the 3D world's pixel ratio in sync with the Render scale setting,
  // recomputing on window resize too since 'auto' depends on the viewport's
  // css size. MapLibre's setPixelRatio resizes the shared canvas in place
  // (see render-scale.ts for why only the 3D world, not the DOM HUD, is
  // affected); the >0.01 guard skips a no-op resize when the resolved ratio
  // hasn't actually moved.
  const renderScaleSetting = progress.settings.renderScale;
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    const container = mapContainerRef.current;
    if (!map || !container) return;
    const coarsePointer = isTouchDevice();
    const applyRenderScale = () => {
      const ratio = resolveRenderPixelRatio(
        renderScaleSetting,
        window.devicePixelRatio || 1,
        coarsePointer,
        container.clientWidth || window.innerWidth,
        container.clientHeight || window.innerHeight,
      );
      if (Math.abs(ratio - map.getPixelRatio()) > 0.01) {
        map.setPixelRatio(ratio);
      }
    };
    applyRenderScale();
    window.addEventListener('resize', applyRenderScale);
    return () => window.removeEventListener('resize', applyRenderScale);
  }, [renderScaleSetting, mapReady]);

  // Tab opens/closes the quest drawer; Esc opens/closes the pause menu (or
  // closes the drawer first, if that is what is open). Neither is wired to
  // the CONTROL_CODES gameplay input path above.
  useEffect(() => {
    const onMenuKeyDown = (event: KeyboardEvent) => {
      if (!playingRef.current) return;
      if (event.code === 'Tab') {
        event.preventDefault();
        if (pauseMenuOpen) return;
        setQuestDrawerOpen((open) => !open);
        return;
      }
      if (event.code === 'Escape') {
        if (questDrawerOpen) {
          setQuestDrawerOpen(false);
          return;
        }
        const next = !pauseMenuOpen;
        setPauseMenuOpen(next);
        engineRef.current?.setPaused(next);
      }
    };
    window.addEventListener('keydown', onMenuKeyDown);
    return () => window.removeEventListener('keydown', onMenuKeyDown);
  }, [pauseMenuOpen, questDrawerOpen]);

  // Esc also closes the pre-flight locker modal on the launch card.
  useEffect(() => {
    if (!launchLockerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Escape') setLaunchLockerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [launchLockerOpen]);

  // Brief gold-ring pulse on the Quests toggle whenever a quest finishes
  // mid-flight. Ref holds the last seen count so a save loaded with quests
  // already completed never pulses on mount.
  useEffect(() => {
    const count = progress.completedQuests.length;
    const previous = previousCompletedQuestsRef.current;
    previousCompletedQuestsRef.current = count;
    if (!playing || count <= previous) return;
    setQuestPulse(true);
    const timer = window.setTimeout(() => setQuestPulse(false), QUEST_PULSE_MS);
    return () => window.clearTimeout(timer);
  }, [progress.completedQuests.length, playing]);

  // A short debounce sits between an update() and its localStorage write;
  // flush it immediately whenever the tab may never get another frame.
  useEffect(() => {
    const flush = () => progressStore.flush();
    const onVisibilityChange = () => {
      if (document.hidden) flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [progressStore]);

  const toggleQuestDrawer = () => setQuestDrawerOpen((open) => !open);
  const closeQuestDrawer = () => setQuestDrawerOpen(false);
  const openPauseMenu = () => {
    setPauseMenuOpen(true);
    engineRef.current?.setPaused(true);
  };
  const closePauseMenu = () => {
    setPauseMenuOpen(false);
    engineRef.current?.setPaused(false);
  };

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

  const handlePauseRespawn = () => {
    resetGame();
    setPauseMenuOpen(false);
    engineRef.current?.setPaused(false);
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
    const sensitivity = progress.settings.cameraSensitivity;
    if (cameraPointersRef.current.size === 1) {
      const yawSensitivity =
        (event.pointerType === 'touch' ? 0.0036 : 0.0045) * sensitivity;
      const pitchSensitivity =
        (event.pointerType === 'touch' ? 0.0028 : 0.0035) * sensitivity;
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
      -(newCenterX - oldCenterX) * 0.0045 * sensitivity,
      -(newCenterY - oldCenterY) * 0.0035 * sensitivity,
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
  const holdingName = telemetry.holding
    ? (HOLDING_NAMES[telemetry.holding] ?? telemetry.holding)
    : null;
  const activeAbilityMutators = telemetry.activeMutators
    .map((id) => MUTATOR_BY_ID.get(id))
    .filter(
      (mutator): mutator is MutatorDefinition => mutator?.kind === 'ability',
    );
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
  const minimapGoosePixelX =
    minimapSpawnPixel.x + telemetry.east * minimapPixelsPerMeter;
  const minimapGoosePixelY =
    minimapSpawnPixel.y - telemetry.north * minimapPixelsPerMeter;
  const minimapCenterTileX = Math.floor(minimapGoosePixelX / MINIMAP_TILE_SIZE);
  const minimapCenterTileY = Math.floor(minimapGoosePixelY / MINIMAP_TILE_SIZE);
  const minimapMinimumTileX = minimapCenterTileX - MINIMAP_GRID_RADIUS;
  const minimapMinimumTileY = minimapCenterTileY - MINIMAP_GRID_RADIUS;
  const minimapTiles = useMemo(
    () =>
      Array.from({ length: MINIMAP_GRID_SIZE ** 2 }, (_, index) => {
        const column = index % MINIMAP_GRID_SIZE;
        const row = Math.floor(index / MINIMAP_GRID_SIZE);
        const x = minimapMinimumTileX + column;
        const y = minimapMinimumTileY + row;
        return {
          key: `${MINIMAP_ZOOM}/${x}/${y}`,
          style: {
            left: column * MINIMAP_TILE_SIZE,
            top: row * MINIMAP_TILE_SIZE,
            backgroundImage: `url(${getAerialTileUrl(MINIMAP_ZOOM, x, y)})`,
          } as CSSProperties,
        };
      }),
    [minimapMinimumTileX, minimapMinimumTileY],
  );
  const minimapGooseGridX =
    minimapGoosePixelX - minimapMinimumTileX * MINIMAP_TILE_SIZE;
  const minimapGooseGridY =
    minimapGoosePixelY - minimapMinimumTileY * MINIMAP_TILE_SIZE;
  const minimapTileStyle = {
    transform: `translate3d(${-minimapGooseGridX}px, ${-minimapGooseGridY}px, 0)`,
  } as CSSProperties;
  // Every unfound secret inside the viewport shows at its true position, no
  // limit and no enter/exit hysteresis (see the header comment on
  // MINIMAP_ZOOM). Secrets outside the viewport show as at most 3 edge
  // indicators, nearest first, clamped to the viewport rectangle. The
  // overall-nearest unfound secret (the objective card's target) gets a
  // distinct highlighted marker whichever bucket it lands in.
  const minimapHalfPx = minimapViewportPx / 2;
  const minimapInViewHalfPx = Math.max(
    0,
    minimapHalfPx - MINIMAP_IN_VIEW_MARGIN_PX,
  );
  const minimapEdgeHalfPx = Math.max(0, minimapHalfPx - MINIMAP_EDGE_INSET_PX);
  const minimapSecretEntries = telemetry.secretMarkers.map((secret) => {
    const offsetX = (secret.east - telemetry.east) * minimapPixelsPerMeter;
    const offsetY = -(secret.north - telemetry.north) * minimapPixelsPerMeter;
    return {
      secret,
      offsetX,
      offsetY,
      distance: Math.hypot(
        secret.east - telemetry.east,
        secret.north - telemetry.north,
      ),
      inView:
        Math.abs(offsetX) <= minimapInViewHalfPx &&
        Math.abs(offsetY) <= minimapInViewHalfPx,
    };
  });
  const nearestUnfoundSecretId = minimapSecretEntries
    .filter((entry) => !entry.secret.found)
    .reduce<(typeof minimapSecretEntries)[number] | null>(
      (closest, entry) =>
        closest === null || entry.distance < closest.distance ? entry : closest,
      null,
    )?.secret.id;
  const minimapFoundMarkers = minimapSecretEntries
    .filter((entry) => entry.secret.found && entry.inView)
    .map((entry) => ({
      secret: entry.secret,
      style: {
        left: `calc(50% + ${entry.offsetX}px)`,
        top: `calc(50% + ${entry.offsetY}px)`,
      } as CSSProperties,
    }));
  const minimapUnfoundEntries = minimapSecretEntries.filter(
    (entry) => !entry.secret.found,
  );
  const minimapInViewMarkers = minimapUnfoundEntries
    .filter((entry) => entry.inView)
    .map((entry) => ({
      secret: entry.secret,
      isNearest: entry.secret.id === nearestUnfoundSecretId,
      style: {
        left: `calc(50% + ${entry.offsetX}px)`,
        top: `calc(50% + ${entry.offsetY}px)`,
      } as CSSProperties,
    }));
  const minimapEdgeMarkers = minimapUnfoundEntries
    .filter((entry) => !entry.inView)
    .sort((first, second) => first.distance - second.distance)
    .slice(0, MINIMAP_EDGE_MARKER_LIMIT)
    .map((entry) => {
      // Rectangle raycast from the center: scale (dx, dy) down just enough
      // that the larger axis lands on the inset viewport edge.
      const dx = entry.offsetX === 0 ? 0.0001 : entry.offsetX;
      const dy = entry.offsetY === 0 ? 0.0001 : entry.offsetY;
      const edgeScale = Math.min(
        minimapEdgeHalfPx / Math.abs(dx),
        minimapEdgeHalfPx / Math.abs(dy),
      );
      const angleDegrees = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      return {
        secret: entry.secret,
        isNearest: entry.secret.id === nearestUnfoundSecretId,
        distanceLabel: `${Math.round(entry.distance)}m`,
        style: {
          left: `calc(50% + ${dx * edgeScale}px)`,
          top: `calc(50% + ${dy * edgeScale}px)`,
          '--minimap-edge-angle': `${angleDegrees}deg`,
        } as CSSProperties,
      };
    });
  const secretCompassStyle = {
    '--secret-bearing': `${telemetry.nearestSecretDirection}deg`,
  } as CSSProperties;
  const touchControlsSetting = progress.settings.touchControls;
  const dataInput =
    touchControlsSetting === 'on'
      ? 'touch'
      : touchControlsSetting === 'off'
        ? 'pointer'
        : undefined;
  const hasSave =
    progress.bestScore > 0 ||
    progress.secretsFound.length > 0 ||
    progress.completedQuests.length > 0;
  const equippedNames = progress.activeMutators
    .map((id) => MUTATOR_BY_ID.get(id)?.name ?? id)
    .join(', ');

  return (
    <main
      className={`game-shell ${playing ? 'is-playing' : 'is-launching'}${minimapOpen ? ' is-minimap-open' : ''}`}
      data-input={dataInput}
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
      data-props={telemetry.props}
      data-props-awake={telemetry.propsAwake}
      data-paused={telemetry.paused}
      data-tokens={telemetry.tokens}
      data-holding={telemetry.holding ?? ''}
      data-goose-scale={telemetry.gooseScale.toFixed(2)}
      data-active-mutators={telemetry.activeMutators.join(' ')}
      data-ragdolling={telemetry.ragdolling}
      data-time-scale={telemetry.timeScale.toFixed(2)}
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
            <button
              type="button"
              className="pause-button-touch"
              aria-label="Pause"
              onClick={openPauseMenu}
            >
              <Pause aria-hidden="true" />
            </button>
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
            <span /> REAL-SCALE KALAMAZOO · AERIAL ROOFS · CHAOS SANDBOX
          </div>
          <h1 id="launch-title">
            Take wing
            <br />
            over WMU.
          </h1>
          <p>
            Fly, honk, recruit a V-formation flock, scatter trail-walking
            students, skim across ponds, and uncover {TOTAL_CAMPUS_SECRETS}{' '}
            Kalamazoo secrets.
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
          <Button
            variant="secondary"
            className="launch-locker-button"
            onClick={() => setLaunchLockerOpen(true)}
          >
            <Vault /> Goose locker
          </Button>
          {hasSave && (
            <div className="launch-save-summary" aria-label="Saved progress">
              <span>
                <Trophy />
                <strong>{progress.bestScore.toLocaleString()}</strong>
                <em>Best chaos</em>
              </span>
              <span>
                <Radar />
                <strong>
                  {progress.secretsFound.length}/{TOTAL_CAMPUS_SECRETS}
                </strong>
                <em>Secrets</em>
              </span>
              <span>
                <ListChecks />
                <strong>{progress.completedQuests.length}</strong>
                <em>Quests</em>
              </span>
              <span>
                <Coins />
                <strong>{progress.tokens}</strong>
                <em>Tokens</em>
              </span>
            </div>
          )}
          {hasSave && progress.activeMutators.length > 0 && (
            <p className="launch-equipped">Equipped: {equippedNames}</p>
          )}
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
                  Tap Space for one wingbeat · Hold it to climb · E honks · F
                  grabs · Tab opens quests
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

      {!playing && launchLockerOpen && (
        <LaunchLockerModal
          progress={progress}
          progressStore={progressStore}
          onClose={() => setLaunchLockerOpen(false)}
        />
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
            {activeAbilityMutators.length > 0 && (
              <div className="mobile-abilities-row">
                {activeAbilityMutators
                  .map((mutator) => mutator.name)
                  .join(' · ')}
              </div>
            )}
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

            {activeAbilityMutators.length > 0 && (
              <div className="abilities-strip" aria-label="Active abilities">
                {activeAbilityMutators.map((mutator) => (
                  <span key={mutator.id} className="locker-chip">
                    {mutator.name}
                  </span>
                ))}
              </div>
            )}

            <button
              type="button"
              className={`quest-toggle-desktop${questPulse ? ' is-pulse' : ''}`}
              onClick={toggleQuestDrawer}
              aria-haspopup="dialog"
              aria-expanded={questDrawerOpen}
            >
              <ListChecks aria-hidden="true" />
              <span>
                <small>Quests</small>
                <strong>
                  {progress.completedQuests.length}/{QUESTS.length}
                </strong>
              </span>
              <kbd>TAB</kbd>
            </button>
          </div>

          <div className="minimap-dock">
            <button
              type="button"
              className={`quest-toggle-touch${questPulse ? ' is-pulse' : ''}`}
              onClick={toggleQuestDrawer}
              aria-haspopup="dialog"
              aria-expanded={questDrawerOpen}
              aria-label="Quest log"
            >
              <ListChecks aria-hidden="true" />
            </button>
            <aside
              className={`campus-minimap${minimapOpen ? ' is-open' : ''}`}
              aria-label="Campus minimap"
            >
              <div className="minimap-desktop-title">
                <span>
                  <MapPin /> Kalamazoo map
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
                  <strong>Kalamazoo map</strong>
                  <small>{minimapOpen ? 'Tap to close' : 'Tap to open'}</small>
                </span>
                <ChevronDown className="minimap-toggle-chevron" />
              </button>
              <div className="minimap-panel" id="campus-minimap-panel">
                <figure
                  ref={minimapViewportRef}
                  className="minimap-viewport"
                  aria-label={`Aerial map centered on the goose with ${minimapInViewMarkers.length + minimapEdgeMarkers.length} nearby secret markers. ${telemetry.nearestSecretDistance === null ? 'All Kalamazoo anomalies found.' : `Nearest anomaly ${nearestSecretLabel}, ${Math.round(telemetry.nearestSecretDistance)} meters away.`}`}
                >
                  <div
                    className="minimap-tiles"
                    style={minimapTileStyle}
                    aria-hidden="true"
                  >
                    {minimapTilesEnabled &&
                      minimapTiles.map((tile) => (
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
                  {minimapFoundMarkers.map(({ secret, style }) => (
                    <span
                      key={secret.id}
                      className="minimap-secret-marker is-found"
                      style={style}
                      aria-hidden="true"
                      title={`${secret.label}: found`}
                    />
                  ))}
                  {minimapInViewMarkers.map(({ secret, isNearest, style }) => (
                    <span
                      key={secret.id}
                      className={`minimap-secret-marker${isNearest ? ' is-nearest' : ''}`}
                      style={style}
                      aria-hidden="true"
                      title={secret.label}
                    >
                      <Radar />
                    </span>
                  ))}
                  {minimapEdgeMarkers.map(
                    ({ secret, isNearest, distanceLabel, style }) => (
                      <span
                        key={secret.id}
                        className={`minimap-edge-marker${isNearest ? ' is-nearest' : ''}`}
                        style={style}
                        aria-hidden="true"
                        title={`${secret.label}: ${distanceLabel} away`}
                      >
                        <ChevronUp
                          style={{
                            transform: 'rotate(var(--minimap-edge-angle))',
                          }}
                        />
                        <small>{distanceLabel}</small>
                      </span>
                    ),
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
                  <figcaption className="sr-only">
                    <span>Secret markers:</span>
                    <ul>
                      {minimapInViewMarkers.map(({ secret }) => (
                        <li key={secret.id}>{secret.label}: nearby, in view</li>
                      ))}
                      {minimapEdgeMarkers.map(({ secret, distanceLabel }) => (
                        <li key={secret.id}>
                          {secret.label}: {distanceLabel} away, off screen
                        </li>
                      ))}
                    </ul>
                  </figcaption>
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
            {/* A chip beside the mode badge, not a banner over the goose:
                the jetstream is a status, and the middle of the screen is
                where the player is looking. */}
            {telemetry.altitudeBoost > 0 && (
              <span className="carry-chip jetstream-chip">
                <Wind aria-hidden="true" />
                Jetstream · +{JETSTREAM_BOOST_PERCENT}% top speed
              </span>
            )}
            {holdingName && (
              <span className="carry-chip">
                <Hand aria-hidden="true" />
                Carrying: {holdingName}
                <b className="desktop-instructions">· F to throw</b>
              </span>
            )}
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
            <span>
              <kbd>F</kbd> grab / throw
            </span>
            <span>
              <kbd>R</kbd> ragdoll
            </span>
            <i />
            <span>
              <kbd>DRAG</kbd> camera
            </span>
            <span>
              <kbd>SCROLL</kbd> zoom
            </span>
            <i />
            <span>
              <kbd>TAB</kbd> quests
            </span>
            <span>
              <kbd>ESC</kbd> menu
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
                className="grab-action"
                aria-label={holdingName ? 'Throw' : 'Grab'}
                aria-pressed="false"
                data-control-code="KeyF"
                data-control-group="action"
                data-pressed="false"
                data-holding={telemetry.holding ? 'true' : 'false'}
                onPointerDown={(event) =>
                  setTouchKey(event, 'KeyF', 'action', true)
                }
                onPointerUp={(event) =>
                  setTouchKey(event, 'KeyF', 'action', false)
                }
                onPointerCancel={(event) =>
                  setTouchKey(event, 'KeyF', 'action', false)
                }
                onLostPointerCapture={(event) =>
                  setTouchKey(event, 'KeyF', 'action', false)
                }
              >
                <Hand />
                <span>{holdingName ? 'Throw' : 'Grab'}</span>
              </button>
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
                className="flare-action"
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

          <QuestDrawer
            open={questDrawerOpen}
            progress={progress}
            onClose={closeQuestDrawer}
          />
          <PauseMenu
            open={pauseMenuOpen}
            progress={progress}
            progressStore={progressStore}
            secretMarkers={telemetry.secretMarkers}
            onClose={closePauseMenu}
            onRespawn={handlePauseRespawn}
            onResetCamera={() => engineRef.current?.resetCamera()}
            travelTo={(secretId) =>
              engineRef.current?.travelTo(secretId) ?? false
            }
          />
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
        {toast && (
          <output
            key={toast.shownAt}
            className={`game-toast${toast.priority === 'score' ? ' is-score' : ''}`}
          >
            {toast.message}
          </output>
        )}
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

/**
 * Pre-flight locker: same store and panel as the pause menu's Locker tab,
 * reusing its card styling. No engine to pause here, so this is just a modal.
 */
function LaunchLockerModal({
  progress,
  progressStore,
  onClose,
}: {
  progress: ProgressState;
  progressStore: ProgressStore;
  onClose: () => void;
}) {
  return (
    <div className="pause-menu-backdrop">
      {/* A styled div rather than a native <dialog>: see the same note in
          app/hud/pause-menu.tsx. */}
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- see note above */}
      <div
        className="pause-menu-card"
        role="dialog"
        aria-modal="true"
        aria-label="Goose locker"
      >
        {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
        <header className="pause-menu-head">
          <h2>Goose locker</h2>
          <button
            type="button"
            className="pause-menu-close"
            onClick={onClose}
            aria-label="Close goose locker"
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="pause-menu-body" role="tabpanel">
          <LockerPanel progress={progress} progressStore={progressStore} />
        </div>
        <footer className="pause-menu-actions">
          <button
            type="button"
            className="pause-menu-primary"
            onClick={onClose}
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
