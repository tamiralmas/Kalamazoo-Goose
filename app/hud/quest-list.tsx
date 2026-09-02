'use client';

import { useState } from 'react';
import { ChevronDown, CircleCheckBig } from 'lucide-react';

import type { ProgressState, QuestDefinition } from '@/app/game-contract';
import { QUESTS, activeQuests, questFraction, questState } from '@/app/quests';

/**
 * The pinned active quests plus a collapsible completed list. Shared by the
 * quest drawer and the pause menu's Quests tab so both stay in sync.
 */
export function QuestList({ progress }: { progress: ProgressState }) {
  const [showCompleted, setShowCompleted] = useState(false);
  const pinned = activeQuests(progress, 3);
  const completed = QUESTS.filter((quest) =>
    progress.completedQuests.includes(quest.id),
  );

  return (
    <div className="quest-list">
      <h3 className="quest-list-heading">Active</h3>
      {pinned.length === 0 ? (
        <p className="quest-list-empty">
          Every quest is done. The Council of Ducks is impressed.
        </p>
      ) : (
        pinned.map((quest) => (
          <QuestRow key={quest.id} progress={progress} quest={quest} />
        ))
      )}

      <button
        type="button"
        className="quest-list-completed-toggle"
        aria-expanded={showCompleted}
        onClick={() => setShowCompleted((value) => !value)}
      >
        <span>
          Completed <em>{completed.length}</em>
        </span>
        <ChevronDown className="quest-list-completed-chevron" />
      </button>
      {showCompleted && (
        <ul className="quest-list-completed">
          {completed.length === 0 ? (
            <li className="quest-list-empty">
              Nothing finished yet. Go honk something.
            </li>
          ) : (
            completed.map((quest) => (
              <li key={quest.id}>
                <CircleCheckBig aria-hidden="true" />
                <span>{quest.title}</span>
                <em>+{quest.reward}</em>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function QuestRow({
  progress,
  quest,
}: {
  progress: ProgressState;
  quest: QuestDefinition;
}) {
  const fraction = questFraction(progress, quest);
  const state = questState(progress, quest.id);
  return (
    <div className="quest-row">
      <div className="quest-row-head">
        <strong>{quest.title}</strong>
        <em>+{quest.reward}</em>
      </div>
      <p>{quest.description}</p>
      <i className="quest-row-bar">
        <b style={{ width: `${fraction * 100}%` }} />
      </i>
      <span className="quest-row-count">
        {Math.min(state.count, quest.target)}/{quest.target}
      </span>
    </div>
  );
}
