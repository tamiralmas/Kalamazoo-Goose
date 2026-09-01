'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Activity,
  Bird,
  Building2,
  CarFront,
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
  Trees,
  TriangleAlert,
  Trophy,
  Volume2,
  Waves,
  Wind,
} from 'lucide-react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FillExtrusionLayerSpecification, FilterSpecification } from '@maplibre/maplibre-gl-style-spec';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

import { Button } from '@/components/ui/button';
import {
  createGooseEngine,
  WMU_SPAWN,
  type FlightMode,
  type GameTelemetry,
  type GooseEngine,
} from '@/app/game-engine';

const INITIAL_TELEMETRY: GameTelemetry = {
  speed: 16.2,
  agl: 64,
  sink: 0.4,
  glideRatio: 12,
  stamina: 1,
  stall: 0,
  mode: 'flying',
  score: 0,
  combo: 1,
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
  waddling: { label: 'Waddling', hint: 'Cause extremely polite gridlock' },
  swimming: { label: 'Swimming', hint: 'Space to take off again' },
};

export function GooseGame() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const engineRef = useRef<GooseEngine | null>(null);
  const playingRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [terrainReady, setTerrainReady] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [telemetry, setTelemetry] = useState(INITIAL_TELEMETRY);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    let cancelled = false;
    let loaded = false;
    let terrainTimer: number | null = null;

    const showToast = (message: string) => {
      if (cancelled) return;
      setToast(message);
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = window.setTimeout(() => setToast(null), 3400);
    };

    void import('maplibre-gl')
      .then((maplibre) => {
        if (cancelled) return;
        maplibre.setWorkerUrl(maplibreWorkerUrl);
        const map = new maplibre.Map({
          container,
          style: 'https://tiles.openfreemap.org/styles/liberty',
          center: WMU_SPAWN,
          zoom: 16.7,
          pitch: 62,
          bearing: -15,
          maxPitch: 84,
          maxZoom: 20,
          interactive: false,
          renderWorldCopies: false,
          centerClampedToGround: false,
          attributionControl: false,
          canvasContextAttributes: { antialias: true },
        });
        mapRef.current = map;
        map.addControl(new maplibre.AttributionControl({ compact: true }), 'bottom-right');

        map.on('error', () => {
          if (!loaded && !cancelled) setMapError(true);
        });

        map.on('load', () => {
          if (cancelled) return;
          loaded = true;
          setMapError(false);
          try {
            const layers = map.getStyle().layers ?? [];
            const firstMapLayer = layers.find((layer) => layer.type !== 'background')?.id;
            map.addSource('wmug-aerial-imagery', {
              type: 'raster',
              tiles: [
                'https://imagery.michigan.gov/server/rest/services/Michigan_imagery_public/MapServer/tile/{z}/{y}/{x}',
              ],
              tileSize: 256,
              minzoom: 1,
              maxzoom: 19,
              bounds: [-90.52734, 41.64008, -82.26563, 48.34165],
              attribution: 'Imagery © State of Michigan (MiSAIL)',
            });
            map.addLayer(
              {
                id: 'wmug-aerial-imagery',
                type: 'raster',
                source: 'wmug-aerial-imagery',
                paint: {
                  'raster-opacity': 1,
                  'raster-saturation': -0.06,
                  'raster-contrast': 0.08,
                  'raster-brightness-min': 0.04,
                  'raster-brightness-max': 0.98,
                  'raster-fade-duration': 0,
                },
              },
              firstMapLayer,
            );

            // Let the aerial photography supply the ground detail while preserving
            // OSM water hit-testing, road guidance, labels, and real 3D geometry.
            layers.forEach((layer) => {
              const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : undefined;
              if (layer.id === 'natural_earth') {
                map.setLayoutProperty(layer.id, 'visibility', 'none');
              }
              if (
                layer.type === 'fill' &&
                (sourceLayer === 'park' || sourceLayer === 'landuse' || sourceLayer === 'landcover')
              ) {
                map.setLayoutProperty(layer.id, 'visibility', 'none');
              }
              if (layer.type === 'fill' && sourceLayer === 'water') {
                map.setPaintProperty(layer.id, 'fill-color', '#4b9eb0');
                map.setPaintProperty(layer.id, 'fill-opacity', 0.24);
              }
              if (layer.type === 'fill' && (sourceLayer === 'building' || layer.id === 'road_area_pattern')) {
                map.setLayoutProperty(layer.id, 'visibility', 'none');
              }
              if (layer.type === 'line' && sourceLayer === 'transportation') {
                map.setPaintProperty(layer.id, 'line-opacity', layer.id.includes('casing') ? 0.26 : 0.48);
              }
            });

            let buildingLayer = layers.find(
              (layer) => layer.type === 'fill-extrusion' && layer['source-layer'] === 'building',
            );
            const hideBuildingOutlines: FilterSpecification = ['!=', ['get', 'hide_3d'], true];

            if (!buildingLayer) {
              const buildingSourceLayer = layers.find(
                (layer) =>
                  'source-layer' in layer &&
                  layer['source-layer'] === 'building' &&
                  'source' in layer &&
                  typeof layer.source === 'string',
              );
              const firstSymbol = layers.find((layer) => layer.type === 'symbol')?.id;
              const buildingSourceId =
                buildingSourceLayer &&
                'source' in buildingSourceLayer &&
                typeof buildingSourceLayer.source === 'string'
                  ? buildingSourceLayer.source
                  : null;
              if (!buildingSourceId) {
                throw new Error('The map style did not provide OSM building data.');
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
                  'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 5],
                  'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
                  'fill-extrusion-opacity': 1,
                  'fill-extrusion-vertical-gradient': true,
                },
              };
              map.addLayer(
                fallbackBuildingLayer,
                firstSymbol,
              );
              buildingLayer = map.getStyle().layers?.find((layer) => layer.id === 'wmug-building-3d');
            }

            if (!buildingLayer || buildingLayer.type !== 'fill-extrusion') {
              throw new Error('The 3D building layer could not be created.');
            }
            const buildingFilter = (buildingLayer.filter
              ? ['all', buildingLayer.filter, hideBuildingOutlines]
              : hideBuildingOutlines) as FilterSpecification;
            map.setFilter(buildingLayer.id, buildingFilter);
            map.setPaintProperty(
              buildingLayer.id,
              'fill-extrusion-color',
              [
                'interpolate',
                ['linear'],
                ['coalesce', ['get', 'render_height'], 5],
                0,
                '#aaa79f',
                18,
                '#cbc7bd',
                52,
                '#e7e2d7',
              ],
            );
            map.setPaintProperty(
              buildingLayer.id,
              'fill-extrusion-height',
              ['coalesce', ['get', 'render_height'], 5],
            );
            map.setPaintProperty(
              buildingLayer.id,
              'fill-extrusion-base',
              ['coalesce', ['get', 'render_min_height'], 0],
            );
            map.setPaintProperty(buildingLayer.id, 'fill-extrusion-opacity', 1);
            map.setPaintProperty(buildingLayer.id, 'fill-extrusion-vertical-gradient', true);

            try {
              map.setSky({
                'sky-color': '#8cc8d9',
                'horizon-color': '#eee4c5',
                'fog-color': '#d7dfd5',
                'sky-horizon-blend': 0.7,
                'horizon-fog-blend': 0.34,
                'fog-ground-blend': 0.5,
                'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 10, 0.88, 17, 0.24],
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
            };

            const tryTerrainReady = () => {
              const elevation = map.queryTerrainElevation(WMU_SPAWN);
              if (typeof elevation === 'number' && Number.isFinite(elevation)) finishWorld(true);
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
      engineRef.current?.setKey(event.code, true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!CONTROL_CODES.includes(event.code)) return;
      engineRef.current?.setKey(event.code, false);
    };
    const clearControls = () => {
      CONTROL_CODES.forEach((code) => engineRef.current?.setKey(code, false));
    };
    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearControls);

    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearControls);
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      if (terrainTimer !== null) window.clearTimeout(terrainTimer);
      engineRef.current?.destroy();
      engineRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  const startGame = () => {
    if (!engineRef.current) return;
    playingRef.current = true;
    setPlaying(true);
    engineRef.current.start();
    mapContainerRef.current?.focus({ preventScroll: true });
  };

  const resetGame = () => {
    if (!engineRef.current) return;
    playingRef.current = true;
    setPlaying(true);
    engineRef.current.reset();
    mapContainerRef.current?.focus({ preventScroll: true });
  };

  const setTouchKey = (
    event: ReactPointerEvent<HTMLButtonElement>,
    code: string,
    pressed: boolean,
  ) => {
    event.preventDefault();
    engineRef.current?.setKey(code, pressed);
    if (pressed) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The input was already recorded; capture only helps guarantee release cleanup.
      }
    }
  };

  const mode = modeCopy[telemetry.mode];
  const glideRatio = telemetry.glideRatio === null ? '—' : `${telemetry.glideRatio.toFixed(1)}:1`;
  const sinkLabel = telemetry.sink > 0.05
    ? `${telemetry.sink.toFixed(1)} m/s sink`
    : `${Math.abs(telemetry.sink).toFixed(1)} m/s climb`;

  return (
    <main className={`game-shell ${playing ? 'is-playing' : 'is-launching'}`}>
      <div
        ref={mapContainerRef}
        className="real-map-canvas"
        aria-label="Interactive real-scale goose flight over aerial imagery and OpenStreetMap 3D data at Western Michigan University"
        tabIndex={-1}
      />
      <div className="sky-vignette" aria-hidden="true" />

      <header className="game-topbar">
        <div className="brand-lockup" aria-label="Wild Goose Open Earth">
          <span className="brand-mark"><Bird /></span>
          <span><strong>WILD GOOSE</strong><small>OPEN EARTH · WMU</small></span>
        </div>
        <div className="location-chip">
          <MapPin />
          <span><strong>Western Michigan University</strong><small>42.284996° N · 85.617710° W</small></span>
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
      </header>

      {!playing && (
        <section className="launch-card game-launch-card" aria-labelledby="launch-title">
          <div className="eyebrow"><span /> REAL-SCALE CAMPUS · AERIAL ROOFS · CHAOS SANDBOX</div>
          <h1 id="launch-title">Take wing<br />over WMU.</h1>
          <p>
            Fly, honk, bonk traffic, botch landings, and make a mess over a real-scale WMU built from aerial imagery and OpenStreetMap data.
          </p>
          <Button className="launch-button" size="lg" onClick={startGame} disabled={!mapReady}>
            <Feather /> {mapReady ? 'Fly from WMU' : mapError ? 'Map is reconnecting…' : 'Loading 3D campus…'}
          </Button>
          <div className="launch-features" aria-label="World data">
            <span><Building2 /><strong>Aerial roofs</strong></span>
            <span><CarFront /><strong>Dense traffic</strong></span>
            <span><Trees /><strong>Campus chaos</strong></span>
          </div>
          <p className="launch-note">
            {mapError ? 'A map service failed to respond. It will retry when the page reloads.' : 'Tap Space for one wingbeat · Hold it for continuous flapping'}
          </p>
        </section>
      )}

      {playing && (
        <>
          <section className="telemetry-panel" aria-label="Flight telemetry">
            <div>
              <span className="telemetry-icon"><Gauge /></span>
              <span><small>Airspeed</small><strong>{telemetry.speed.toFixed(1)}</strong><em>m/s</em></span>
            </div>
            <div>
              <span className="telemetry-icon"><Mountain /></span>
              <span><small>Above ground</small><strong>{telemetry.agl.toFixed(0)}</strong><em>m</em></span>
            </div>
            <div>
              <span className="telemetry-icon"><Wind /></span>
              <span><small>Glide</small><strong>{glideRatio}</strong><em>{sinkLabel}</em></span>
            </div>
          </section>

          <aside className="objective-card">
            <span className="objective-icon"><Trophy /></span>
            <span>
              <small>Campus chaos</small>
              <strong>Honk, bonk cars, stick the landing</strong>
              <em>E to honk · chain stunts for combos</em>
            </span>
          </aside>

          <div className="stamina-card" aria-label={`Wing stamina ${Math.round(telemetry.stamina * 100)} percent`}>
            <span><Activity /><small>Wing stamina</small><strong>{Math.round(telemetry.stamina * 100)}%</strong></span>
            <i><b style={{ width: `${telemetry.stamina * 100}%` }} /></i>
          </div>

          <div className="chaos-card" aria-live="polite" aria-label={`Chaos score ${telemetry.score}, combo times ${telemetry.combo}`}>
            <span><Trophy /><small>Chaos score</small><strong>{telemetry.score.toLocaleString()}</strong></span>
            <em className={telemetry.combo > 1 ? 'is-hot' : ''}>COMBO ×{telemetry.combo}</em>
          </div>

          {telemetry.stall > 0.22 && (
            <div className="stall-warning"><TriangleAlert /> STALL · LOWER THE NOSE WITH W</div>
          )}

          <div className="flight-reticle" aria-hidden="true"><span /><i /></div>

          <div className="mode-stack">
            <span className={`mode-badge mode-${telemetry.mode}`}>
              {telemetry.mode === 'flying' ? <Bird /> : telemetry.mode === 'swimming' ? <Waves /> : <Footprints />}
              {mode.label}
            </span>
            <span>{mode.hint}</span>
          </div>

          <div className="control-deck" aria-label="Controls">
            <span><kbd>W</kbd> dive</span>
            <span><kbd>S</kbd> pull up</span>
            <span><kbd>A</kbd><kbd>D</kbd> bank</span>
            <i />
            <span><kbd>SPACE</kbd> tap / hold to flap</span>
            <span><kbd>SHIFT</kbd> flare / brake</span>
            <span><kbd>E</kbd> honk</span>
          </div>

          <div className="mobile-controls" aria-label="Touch flight controls">
            <div className="touch-pad">
              <button aria-label="Dive" onPointerDown={(event) => setTouchKey(event, 'KeyW', true)} onPointerUp={(event) => setTouchKey(event, 'KeyW', false)} onPointerCancel={(event) => setTouchKey(event, 'KeyW', false)} onLostPointerCapture={(event) => setTouchKey(event, 'KeyW', false)}><ChevronUp /></button>
              <button aria-label="Bank left" onPointerDown={(event) => setTouchKey(event, 'KeyA', true)} onPointerUp={(event) => setTouchKey(event, 'KeyA', false)} onPointerCancel={(event) => setTouchKey(event, 'KeyA', false)} onLostPointerCapture={(event) => setTouchKey(event, 'KeyA', false)}><ChevronLeft /></button>
              <button aria-label="Pull up" onPointerDown={(event) => setTouchKey(event, 'KeyS', true)} onPointerUp={(event) => setTouchKey(event, 'KeyS', false)} onPointerCancel={(event) => setTouchKey(event, 'KeyS', false)} onLostPointerCapture={(event) => setTouchKey(event, 'KeyS', false)}><ChevronDown /></button>
              <button aria-label="Bank right" onPointerDown={(event) => setTouchKey(event, 'KeyD', true)} onPointerUp={(event) => setTouchKey(event, 'KeyD', false)} onPointerCancel={(event) => setTouchKey(event, 'KeyD', false)} onLostPointerCapture={(event) => setTouchKey(event, 'KeyD', false)}><ChevronRight /></button>
            </div>
            <div className="touch-actions">
              <button className="honk-action" aria-label="Honk" onPointerDown={(event) => setTouchKey(event, 'KeyE', true)} onPointerUp={(event) => setTouchKey(event, 'KeyE', false)} onPointerCancel={(event) => setTouchKey(event, 'KeyE', false)} onLostPointerCapture={(event) => setTouchKey(event, 'KeyE', false)}><Volume2 /><span>Honk</span></button>
              <button aria-label="Flare and airbrake" onPointerDown={(event) => setTouchKey(event, 'ShiftLeft', true)} onPointerUp={(event) => setTouchKey(event, 'ShiftLeft', false)} onPointerCancel={(event) => setTouchKey(event, 'ShiftLeft', false)} onLostPointerCapture={(event) => setTouchKey(event, 'ShiftLeft', false)}><Wind /><span>Flare</span></button>
              <button className="flap-action" aria-label="Flap wings" onPointerDown={(event) => setTouchKey(event, 'Space', true)} onPointerUp={(event) => setTouchKey(event, 'Space', false)} onPointerCancel={(event) => setTouchKey(event, 'Space', false)} onLostPointerCapture={(event) => setTouchKey(event, 'Space', false)}><Feather /><span>Flap</span></button>
            </div>
          </div>
        </>
      )}

      {toast && <output className="game-toast">{toast}</output>}

      <footer className="game-footer">
        <span>MISAIL AERIAL ROOFS + OSM 3D</span><i /><span>{terrainReady ? 'REAL TERRAIN' : '3D BUILDINGS'} · WMU</span>
        <span className="map-credit">
          © <a href="https://www.michigan.gov/dtmb/services/maps/misail" target="_blank" rel="noreferrer">State of Michigan MiSAIL</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> · <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>{terrainReady && <> · <a href="https://mapterhorn.com/attribution/" target="_blank" rel="noreferrer">Mapterhorn</a></>}
        </span>
      </footer>
    </main>
  );
}
