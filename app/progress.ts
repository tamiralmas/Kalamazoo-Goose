import {
  DEFAULT_SETTINGS,
  type ProgressState,
  type ProgressStore,
  type Settings,
} from './game-contract';

export const PROGRESS_STORAGE_KEY = 'kalamazoo-goose-progress';
const SAVE_DEBOUNCE_MS = 400;

export const createDefaultProgress = (
  settings: Settings = DEFAULT_SETTINGS,
): ProgressState => ({
  version: 1,
  bestScore: 0,
  lifetimeChaos: 0,
  secretsFound: [],
  recruitedGeese: [],
  tokens: 0,
  tokensEarned: 0,
  quests: {},
  completedQuests: [],
  unlockedMutators: [],
  activeMutators: [],
  settings: { ...DEFAULT_SETTINGS, ...settings },
  stats: {
    flights: 0,
    metersFlown: 0,
    honks: 0,
    studentsBowled: 0,
    propsWrecked: 0,
    itemsStolen: 0,
    carsHit: 0,
    playSeconds: 0,
  },
  generation: 0,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringList = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

const numberList = (value: unknown) =>
  Array.isArray(value)
    ? value.filter(
        (item): item is number =>
          typeof item === 'number' && Number.isFinite(item),
      )
    : [];

const finite = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Coerce whatever is in storage into a valid state; never throws. */
export const sanitizeProgress = (raw: unknown): ProgressState => {
  const base = createDefaultProgress();
  if (!isRecord(raw)) return base;
  const settings = isRecord(raw.settings) ? raw.settings : {};
  const stats = isRecord(raw.stats) ? raw.stats : {};
  const quests: ProgressState['quests'] = {};
  if (isRecord(raw.quests)) {
    for (const [id, state] of Object.entries(raw.quests)) {
      if (!isRecord(state)) continue;
      quests[id] = {
        count: Math.max(0, Math.floor(finite(state.count, 0))),
        seen: stringList(state.seen),
      };
    }
  }
  const touchControls = settings.touchControls;
  return {
    version: 1,
    bestScore: Math.max(0, finite(raw.bestScore, 0)),
    lifetimeChaos: Math.max(0, finite(raw.lifetimeChaos, 0)),
    secretsFound: [...new Set(stringList(raw.secretsFound))],
    recruitedGeese: [...new Set(numberList(raw.recruitedGeese))],
    tokens: Math.max(0, Math.floor(finite(raw.tokens, 0))),
    tokensEarned: Math.max(0, Math.floor(finite(raw.tokensEarned, 0))),
    quests,
    completedQuests: [...new Set(stringList(raw.completedQuests))],
    unlockedMutators: [...new Set(stringList(raw.unlockedMutators))],
    activeMutators: [...new Set(stringList(raw.activeMutators))],
    settings: {
      touchControls:
        touchControls === 'on' || touchControls === 'off'
          ? touchControls
          : 'auto',
      cameraSensitivity: Math.min(
        2,
        Math.max(0.5, finite(settings.cameraSensitivity, 1)),
      ),
      sound: settings.sound !== false,
      ambient: settings.ambient !== false,
      slowMotion: settings.slowMotion !== false,
    },
    stats: {
      flights: Math.max(0, finite(stats.flights, 0)),
      metersFlown: Math.max(0, finite(stats.metersFlown, 0)),
      honks: Math.max(0, finite(stats.honks, 0)),
      studentsBowled: Math.max(0, finite(stats.studentsBowled, 0)),
      propsWrecked: Math.max(0, finite(stats.propsWrecked, 0)),
      itemsStolen: Math.max(0, finite(stats.itemsStolen, 0)),
      carsHit: Math.max(0, finite(stats.carsHit, 0)),
      playSeconds: Math.max(0, finite(stats.playSeconds, 0)),
    },
    generation: Math.max(0, Math.floor(finite(raw.generation, 0))),
  };
};

const readStorage = (key: string): ProgressState => {
  try {
    if (typeof window === 'undefined') return createDefaultProgress();
    const raw = window.localStorage.getItem(key);
    if (!raw) return createDefaultProgress();
    return sanitizeProgress(JSON.parse(raw));
  } catch {
    return createDefaultProgress();
  }
};

const writeStorage = (key: string, state: ProgressState) => {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Private mode or a full quota: the game keeps running without a save.
  }
};

/**
 * One store per page. Mutations go through update(); the store persists on a
 * short debounce and notifies subscribers synchronously with the new state.
 */
export const createProgressStore = (
  storageKey = PROGRESS_STORAGE_KEY,
): ProgressStore => {
  let state = readStorage(storageKey);
  const listeners = new Set<(state: ProgressState) => void>();
  let saveTimer: number | null = null;
  let dirty = false;

  const flush = () => {
    if (saveTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!dirty) return;
    dirty = false;
    writeStorage(storageKey, state);
  };

  const scheduleSave = () => {
    dirty = true;
    if (typeof window === 'undefined') return;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  const notify = () => {
    listeners.forEach((listener) => {
      try {
        listener(state);
      } catch {
        // A HUD listener must never break the simulation.
      }
    });
  };

  return {
    get: () => state,
    update(mutate) {
      // Shallow copy so React subscribers see a new reference per update.
      const next: ProgressState = { ...state, stats: { ...state.stats } };
      mutate(next);
      state = next;
      scheduleSave();
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      const fresh = createDefaultProgress(state.settings);
      fresh.generation = state.generation + 1;
      state = fresh;
      dirty = true;
      flush();
      notify();
    },
    flush,
  };
};
