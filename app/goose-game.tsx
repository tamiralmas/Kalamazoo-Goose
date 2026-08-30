'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
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
  Route,
  Trees,
  TriangleAlert,
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
  speed: 15.2,
  agl: 32,
  sink: 0.45,
  glideRatio: 12,
  stamina: 1,
  stall: 0,
  mode: 'flying',
};

const CONTROL_CODES = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
  'ShiftLeft',
  'ShiftRight',
];

const modeCopy: Record<FlightMode, { label: string; hint: string }> = {
  flying: { label: 'Gliding', hint: 'Trade height for speed' },
  waddling: { label: 'Waddling', hint: 'Traffic will yield' },
  swimming: { label: 'Swimming', hint: 'Space to take off' },
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
    if (pressed) event.currentTarget.setPointerCapture(event.pointerId);
    engineRef.current?.setKey(code, pressed);
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
        aria-label="Interactive goose flight over actual OpenStreetMap data at Western Michigan University"
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
          <div className="eyebrow"><span /> ACTUAL MAP DATA · REAL GLIDING</div>
          <h1 id="launch-title">Take wing<br />over WMU.</h1>
          <p>
            Fly a Canada goose through real OpenStreetMap buildings and roads, weave through mapped campus trees, then flare into a lake with a splash.
          </p>
          <Button className="launch-button" size="lg" onClick={startGame} disabled={!mapReady}>
            <Feather /> {mapReady ? 'Fly from WMU' : mapError ? 'Map is reconnecting…' : 'Loading 3D campus…'}
          </Button>
          <div className="launch-features" aria-label="World data">
            <span><Building2 /><strong>3D buildings</strong></span>
            <span><Route /><strong>OSM roads</strong></span>
            <span><Trees /><strong>Mapped trees</strong></span>
          </div>
          <p className="launch-note">
            {mapError ? 'A map service failed to respond. It will retry when the page reloads.' : 'Best glide: about 15 m/s · Hold Space for repeated wingbeats'}
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
            <span className="objective-icon"><Waves /></span>
            <span>
              <small>Open-world objective</small>
              <strong>Find a mapped lake and land</strong>
              <em>Hold Shift to flare before touchdown</em>
            </span>
          </aside>

          <div className="stamina-card" aria-label={`Wing stamina ${Math.round(telemetry.stamina * 100)} percent`}>
            <span><Activity /><small>Wing stamina</small><strong>{Math.round(telemetry.stamina * 100)}%</strong></span>
            <i><b style={{ width: `${telemetry.stamina * 100}%` }} /></i>
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
            <span><kbd>SPACE</kbd> flap</span>
            <span><kbd>SHIFT</kbd> flare / brake</span>
          </div>

          <div className="mobile-controls" aria-label="Touch flight controls">
            <div className="touch-pad">
              <button aria-label="Dive" onPointerDown={(event) => setTouchKey(event, 'KeyW', true)} onPointerUp={(event) => setTouchKey(event, 'KeyW', false)} onPointerCancel={(event) => setTouchKey(event, 'KeyW', false)} onLostPointerCapture={(event) => setTouchKey(event, 'KeyW', false)}><ChevronUp /></button>
              <button aria-label="Bank left" onPointerDown={(event) => setTouchKey(event, 'KeyA', true)} onPointerUp={(event) => setTouchKey(event, 'KeyA', false)} onPointerCancel={(event) => setTouchKey(event, 'KeyA', false)} onLostPointerCapture={(event) => setTouchKey(event, 'KeyA', false)}><ChevronLeft /></button>
              <button aria-label="Pull up" onPointerDown={(event) => setTouchKey(event, 'KeyS', true)} onPointerUp={(event) => setTouchKey(event, 'KeyS', false)} onPointerCancel={(event) => setTouchKey(event, 'KeyS', false)} onLostPointerCapture={(event) => setTouchKey(event, 'KeyS', false)}><ChevronDown /></button>
              <button aria-label="Bank right" onPointerDown={(event) => setTouchKey(event, 'KeyD', true)} onPointerUp={(event) => setTouchKey(event, 'KeyD', false)} onPointerCancel={(event) => setTouchKey(event, 'KeyD', false)} onLostPointerCapture={(event) => setTouchKey(event, 'KeyD', false)}><ChevronRight /></button>
            </div>
            <div className="touch-actions">
              <button aria-label="Flare and airbrake" onPointerDown={(event) => setTouchKey(event, 'ShiftLeft', true)} onPointerUp={(event) => setTouchKey(event, 'ShiftLeft', false)} onPointerCancel={(event) => setTouchKey(event, 'ShiftLeft', false)} onLostPointerCapture={(event) => setTouchKey(event, 'ShiftLeft', false)}><Wind /><span>Flare</span></button>
              <button className="flap-action" aria-label="Flap wings" onPointerDown={(event) => setTouchKey(event, 'Space', true)} onPointerUp={(event) => setTouchKey(event, 'Space', false)} onPointerCancel={(event) => setTouchKey(event, 'Space', false)} onLostPointerCapture={(event) => setTouchKey(event, 'Space', false)}><Feather /><span>Flap</span></button>
            </div>
          </div>
        </>
      )}

      {toast && <output className="game-toast">{toast}</output>}

      <footer className="game-footer">
        <span>OSM VECTOR WORLD</span><i /><span>{terrainReady ? 'REAL TERRAIN' : '3D BUILDINGS'} · WMU</span>
        <span className="map-credit">
          © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> · <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>{terrainReady && <> · <a href="https://mapterhorn.com/attribution/" target="_blank" rel="noreferrer">Mapterhorn</a></>}
        </span>
      </footer>
    </main>
  );
}
