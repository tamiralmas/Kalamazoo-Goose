import { useSyncExternalStore } from 'react';
import type { ProgressState, ProgressStore } from '@/app/game-contract';

/**
 * Subscribes a component to the progress store so it re-renders whenever
 * saved progress changes (quests, tokens, settings, secrets, ...).
 */
export function useProgress(store: ProgressStore): ProgressState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
