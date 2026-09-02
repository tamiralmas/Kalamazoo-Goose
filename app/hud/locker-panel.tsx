'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Coins,
  Flag,
  Lock,
  Maximize,
  PartyPopper,
  Rocket,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

import type {
  GooseColors,
  MutatorDefinition,
  ProgressState,
  ProgressStore,
} from '@/app/game-contract';
import { MUTATORS, canUnlock, toggleMutator } from '@/app/mutators';

type LockerPanelProps = {
  progress: ProgressState;
  progressStore: ProgressStore;
};

/** One ability icon each; skins get a color swatch strip instead. */
const ABILITY_ICONS: Record<string, LucideIcon> = {
  'jet-goose': Rocket,
  'angel-goose': Sparkles,
  'giga-goose': Maximize,
  'party-goose': PartyPopper,
  'bronco-goose': Flag,
};

const SWATCH_KEYS: (keyof GooseColors)[] = [
  'body',
  'breast',
  'neck',
  'wing',
  'beak',
];

const toHex = (value: number) => `#${value.toString(16).padStart(6, '0')}`;

/**
 * The Goose Locker: unlock and equip abilities and skins with tokens. Shared
 * by the pause menu's Locker tab and the launch card's pre-flight modal, so
 * both read and write the same progress store.
 */
export function LockerPanel({ progress, progressStore }: LockerPanelProps) {
  const abilities = MUTATORS.filter((mutator) => mutator.kind === 'ability');
  const skins = MUTATORS.filter((mutator) => mutator.kind === 'skin');
  const activeAbilities = abilities.filter((mutator) =>
    progress.activeMutators.includes(mutator.id),
  );

  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
    },
    [],
  );

  const handleUnlock = (mutator: MutatorDefinition) => {
    if (!canUnlock(progress, mutator.id)) return;
    progressStore.update((state) => {
      state.tokens -= mutator.cost;
      state.unlockedMutators = [...state.unlockedMutators, mutator.id];
    });
    if (flashTimerRef.current !== null)
      window.clearTimeout(flashTimerRef.current);
    setFlashId(mutator.id);
    flashTimerRef.current = window.setTimeout(() => setFlashId(null), 900);
  };

  const handleEquip = (mutator: MutatorDefinition) => {
    progressStore.update((state) => {
      state.activeMutators = toggleMutator(state.activeMutators, mutator.id);
    });
  };

  return (
    <div className="locker-panel">
      <header className="locker-head">
        <div className="locker-head-top">
          <span className="quest-token-pill">
            <Coins aria-hidden="true" />
            <strong>{progress.tokens}</strong>
          </span>
          {activeAbilities.length > 0 && (
            <div className="locker-chips" aria-label="Active abilities">
              {activeAbilities.map((mutator) => (
                <span key={mutator.id} className="locker-chip">
                  {mutator.name}
                </span>
              ))}
            </div>
          )}
        </div>
        <p className="locker-hint">Tokens come from quests and secrets.</p>
      </header>

      <section className="locker-section">
        <h3 className="quest-list-heading">Abilities</h3>
        <div className="locker-list">
          {abilities.map((mutator) => (
            <MutatorRow
              key={mutator.id}
              mutator={mutator}
              progress={progress}
              flashing={flashId === mutator.id}
              onUnlock={() => handleUnlock(mutator)}
              onEquip={() => handleEquip(mutator)}
            />
          ))}
        </div>
      </section>

      <section className="locker-section">
        <h3 className="quest-list-heading">Skins</h3>
        <div className="locker-list">
          {skins.map((mutator) => (
            <MutatorRow
              key={mutator.id}
              mutator={mutator}
              progress={progress}
              flashing={flashId === mutator.id}
              onUnlock={() => handleUnlock(mutator)}
              onEquip={() => handleEquip(mutator)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function MutatorRow({
  mutator,
  progress,
  flashing,
  onUnlock,
  onEquip,
}: {
  mutator: MutatorDefinition;
  progress: ProgressState;
  flashing: boolean;
  onUnlock: () => void;
  onEquip: () => void;
}) {
  const unlocked = progress.unlockedMutators.includes(mutator.id);
  const active = progress.activeMutators.includes(mutator.id);
  const affordable = progress.tokens >= mutator.cost;
  const Icon = ABILITY_ICONS[mutator.id];
  const colors = mutator.modifiers.colors;

  return (
    <div
      className={`locker-row${unlocked ? '' : ' is-locked'}${flashing ? ' is-flash' : ''}`}
    >
      <span
        className={`locker-row-icon${colors ? ' is-swatch' : ''}`}
        aria-hidden="true"
      >
        {colors
          ? SWATCH_KEYS.map((key) => (
              <i
                key={key}
                className="locker-swatch"
                style={{ background: toHex(colors[key]) }}
              />
            ))
          : Icon && <Icon aria-hidden="true" />}
      </span>
      <div className="locker-row-body">
        <strong>{mutator.name}</strong>
        <p>{mutator.tagline}</p>
      </div>
      <div className="locker-row-action">
        {unlocked ? (
          <button
            type="button"
            className={`locker-equip-btn${active ? ' is-active' : ''}`}
            aria-pressed={active}
            onClick={onEquip}
          >
            {active ? (
              <>
                <Check aria-hidden="true" /> Equipped
              </>
            ) : (
              'Equip'
            )}
          </button>
        ) : (
          <button
            type="button"
            className="locker-unlock-btn"
            disabled={!affordable}
            onClick={onUnlock}
          >
            <Lock aria-hidden="true" /> Unlock &middot; {mutator.cost} tokens
          </button>
        )}
      </div>
    </div>
  );
}
