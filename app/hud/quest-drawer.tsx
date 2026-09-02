'use client';

import { Coins, ListChecks, X } from 'lucide-react';

import type { ProgressState } from '@/app/game-contract';
import { QUESTS } from '@/app/quests';
import { QuestList } from './quest-list';

type QuestDrawerProps = {
  open: boolean;
  progress: ProgressState;
  onClose: () => void;
};

/**
 * Tab-toggled quest log. Slides in from the right on desktop and up from the
 * bottom on touch; never pauses the game.
 */
export function QuestDrawer({ open, progress, onClose }: QuestDrawerProps) {
  const completedCount = progress.completedQuests.length;
  return (
    <>
      <div
        className={`quest-drawer-scrim${open ? ' is-open' : ''}`}
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        className={`quest-drawer${open ? ' is-open' : ''}`}
        aria-label="Quest log"
        inert={!open}
      >
        <header className="quest-drawer-head">
          <span className="quest-drawer-title">
            <ListChecks aria-hidden="true" /> Quest log
          </span>
          <button
            type="button"
            className="quest-drawer-close"
            onClick={onClose}
            aria-label="Close quest log"
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="quest-drawer-summary">
          <span className="quest-token-pill">
            <Coins aria-hidden="true" />
            <strong>{progress.tokens}</strong>
          </span>
          <span className="quest-drawer-count">
            {completedCount}/{QUESTS.length} quests
          </span>
        </div>
        <div className="quest-drawer-body">
          <QuestList progress={progress} />
        </div>
      </aside>
    </>
  );
}
