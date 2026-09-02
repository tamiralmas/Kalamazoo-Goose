// Shared contract between the simulation (game-engine.ts), the progression
// modules (progress.ts, quests.ts, mutators.ts), and the HUD (goose-game.tsx).
// Everything here is plain data or a narrow interface, so the modules can be
// built and tested independently of the 3D engine.

export type FlightMode = 'flying' | 'planing' | 'waddling' | 'swimming';

// ---------------------------------------------------------------------------
// World objects that other systems refer to by kind.
// ---------------------------------------------------------------------------

/** Wreckable campus furniture (Phase 2). */
export type PropKind = 'cone' | 'bench' | 'trash' | 'bike' | 'sign' | 'flag';

/** Things students carry that the goose can steal (Phase 3). */
export type ItemKind = 'phone' | 'sandwich' | 'coffee' | 'id-card' | 'umbrella';

/**
 * Hand-authored prop spawns. east/north are meters in the same authored frame
 * as chaos-secrets.ts (relative to WMU_CONTENT_ANCHOR, north up). A pattern
 * lays out `count` props starting at east/north: rows advance along `heading`
 * (radians, 0 = north, clockwise) by `spacing`; rings orbit the point at
 * radius `spacing`; clusters jitter within `spacing`.
 */
export type PropPlacement = {
  kind: PropKind;
  east: number;
  north: number;
  count?: number;
  pattern?: 'row' | 'ring' | 'cluster';
  spacing?: number;
  heading?: number;
};

// ---------------------------------------------------------------------------
// Events: the engine emits one of these for anything a quest could count.
// ---------------------------------------------------------------------------

export type GameEvent =
  /** A named chaos award from awardChaos(). `id` is the slug of the label
   *  ("INSURANCE FRAUD" -> "insurance-fraud"). `subject` identifies the
   *  thing involved when a quest needs "different" ones (car index, roof key). */
  | {
      type: 'trick';
      id: string;
      label: string;
      points: number;
      combo: number;
      mode: FlightMode;
      speed: number;
      agl: number;
      subject?: string;
    }
  | { type: 'secret'; id: string; label: string; found: number; total: number }
  | { type: 'flock'; recruited: number; total: number }
  | {
      type: 'honk';
      scattered: number;
      carsStopped: number;
      airborne: boolean;
      mega: boolean;
    }
  /** Emitted once when chaos crosses 10,000 in a life. */
  | { type: 'infamy' }
  /** Emitted when a flight ends (any touchdown). */
  | {
      type: 'flight';
      seconds: number;
      meters: number;
      peakAgl: number;
      topSpeed: number;
      surface: 'ground' | 'water' | 'roof';
    }
  /** A student knocked over by the goose or by a flying prop. */
  | { type: 'bowl'; by: 'goose' | 'prop'; airborne: boolean }
  | {
      type: 'prop';
      kind: PropKind;
      action: 'wrecked' | 'thrown' | 'hit-student' | 'hit-car';
    }
  | { type: 'grab'; target: 'prop' | 'item'; kind: PropKind | ItemKind }
  | { type: 'steal'; item: ItemKind; caught: boolean }
  | { type: 'ride'; what: 'bronco' | 'tray'; seconds: number }
  | { type: 'quest'; id: string; tokens: number }
  | { type: 'unlock'; mutator: string };

export type GameEventType = GameEvent['type'];

export const slugifyLabel = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// ---------------------------------------------------------------------------
// Quests
// ---------------------------------------------------------------------------

export type QuestState = {
  count: number;
  /** Distinct subjects already counted, for "N different X" quests. */
  seen: string[];
};

export type QuestDefinition = {
  id: string;
  title: string;
  /** One joke sentence in the game's voice, e.g. "The dean is not amused." */
  description: string;
  target: number;
  /** Tokens paid into the goose locker on completion. */
  reward: number;
  /** Rough order in the drawer; lower shows first. Ties keep table order. */
  tier: 1 | 2 | 3;
  /** Which event types can advance this quest; a cheap pre-filter. */
  listens: GameEventType[];
  /** Pure: return the next state, or null when the event does not count. */
  advance: (event: GameEvent, state: QuestState) => QuestState | null;
};

// ---------------------------------------------------------------------------
// Mutators (Phase 4)
// ---------------------------------------------------------------------------

export type GooseColors = {
  body: number;
  breast: number;
  neck: number;
  wing: number;
  beak: number;
};

/** Everything the engine reads from the active mutator set. */
export type Modifiers = {
  gravityScale: number; // 1 = normal, 0.42 = angel
  jetstreamAlways: boolean; // jet goose: altitude boost at any height
  gooseScale: number; // 1 = normal, 3 = giga
  honkRadiusScale: number;
  honkStyle: 'panic' | 'party'; // party: students dance instead of flee
  broncoFollows: boolean; // the runaway Bronco tails the goose
  flapPowerScale: number;
  topSpeedScale: number;
  halo: boolean;
  colors: GooseColors | null; // null = default Canada goose
};

export type MutatorDefinition = {
  id: string;
  name: string;
  tagline: string;
  cost: number; // tokens
  kind: 'ability' | 'skin';
  /** Only the keys this mutator changes. */
  modifiers: Partial<Modifiers>;
};

// ---------------------------------------------------------------------------
// Persistent progress
// ---------------------------------------------------------------------------

export type Settings = {
  touchControls: 'auto' | 'on' | 'off';
  cameraSensitivity: number; // 0.5 .. 2, default 1
  sound: boolean;
  ambient: boolean;
  music: boolean;
  slowMotion: boolean;
  /** How many device pixels the 3D world (not the DOM HUD) renders at; see
   *  render-scale.ts. 'auto' balances sharpness against GPU cost. */
  renderScale: 'auto' | 'crisp' | 'fast';
};

export type ProgressStats = {
  flights: number;
  metersFlown: number;
  honks: number;
  studentsBowled: number;
  propsWrecked: number;
  itemsStolen: number;
  carsHit: number;
  playSeconds: number;
};

export type ProgressState = {
  version: 1;
  bestScore: number;
  lifetimeChaos: number;
  secretsFound: string[];
  /** Recruited roost indices (0..7). Restored as already recruited. */
  recruitedGeese: number[];
  tokens: number;
  tokensEarned: number;
  quests: Record<string, QuestState>;
  completedQuests: string[];
  unlockedMutators: string[];
  activeMutators: string[];
  settings: Settings;
  stats: ProgressStats;
  /** Bumped by reset() so subscribers can tell a wipe from an update. */
  generation: number;
};

export type ProgressStore = {
  get: () => ProgressState;
  /** Apply a mutation; the store persists (debounced) and notifies. */
  update: (mutate: (state: ProgressState) => void) => void;
  subscribe: (listener: (state: ProgressState) => void) => () => void;
  /** Fresh goose: wipe everything except settings. */
  reset: () => void;
  /** Write immediately (used on pagehide). */
  flush: () => void;
};

// ---------------------------------------------------------------------------
// Engine surface the HUD talks to
// ---------------------------------------------------------------------------

export type ToastPriority = 'info' | 'score';

export type SecretMarkerTelemetry = {
  id: string;
  label: string;
  east: number;
  north: number;
  found: boolean;
};

export type GooseEngineApi = {
  start: () => void;
  reset: () => void;
  setKey: (code: string, pressed: boolean) => void;
  scaleCameraZoom: (multiplier: number) => void;
  orbitCamera: (yawDelta: number, pitchDelta: number) => void;
  resetCamera: () => void;
  /** Freezes the simulation and input; rendering continues. */
  setPaused: (paused: boolean) => void;
  /** Teleport to a found secret. Returns false when it is not found yet. */
  travelTo: (secretId: string) => boolean;
  destroy: () => void;
};

/** Keyboard codes the game listens to. Touch buttons send the same codes. */
export const CONTROL_CODES = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'KeyE',
  'KeyH',
  'KeyF', // grab / steal (Phase 3)
  'KeyR', // ragdoll on demand (Phase 5)
] as const;

/**
 * How much faster the goose flies in the jetstream, as a percentage, so the
 * HUD can print the number the engine actually applies instead of its own
 * copy. The engine's ALTITUDE_BOOST_* speeds are derived from this.
 */
export const JETSTREAM_BOOST_PERCENT = 10;

export const DEFAULT_SETTINGS: Settings = {
  touchControls: 'auto',
  cameraSensitivity: 1,
  sound: true,
  ambient: true,
  music: true,
  slowMotion: true,
  renderScale: 'auto',
};

export const DEFAULT_MODIFIERS: Modifiers = {
  gravityScale: 1,
  jetstreamAlways: false,
  gooseScale: 1,
  honkRadiusScale: 1,
  honkStyle: 'panic',
  broncoFollows: false,
  flapPowerScale: 1,
  topSpeedScale: 1,
  halo: false,
  colors: null,
};
