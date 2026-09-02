'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ListChecks,
  MapPinned,
  RotateCcw,
  Settings2,
  Vault,
  X,
} from 'lucide-react';

import type {
  ProgressState,
  ProgressStore,
  SecretMarkerTelemetry,
  Settings,
} from '@/app/game-contract';
import { LockerPanel } from './locker-panel';
import { QuestList } from './quest-list';

type PauseTab = 'quests' | 'locker' | 'travel' | 'options';

type PauseMenuProps = {
  open: boolean;
  progress: ProgressState;
  progressStore: ProgressStore;
  secretMarkers: SecretMarkerTelemetry[];
  /** Resume: closes the menu and unpauses the sim. */
  onClose: () => void;
  /** Respawn: resets the flight, then closes and unpauses. */
  onRespawn: () => void;
  /** Snaps the chase camera back behind the goose. */
  onResetCamera: () => void;
  /** Raw engine.travelTo; the Travel tab closes the menu itself after. */
  travelTo: (secretId: string) => boolean;
};

export function PauseMenu({
  open,
  progress,
  progressStore,
  secretMarkers,
  onClose,
  onRespawn,
  onResetCamera,
  travelTo,
}: PauseMenuProps) {
  const [tab, setTab] = useState<PauseTab>('quests');

  if (!open) return null;

  return (
    <div className="pause-menu-backdrop">
      {/* A styled div rather than a native <dialog>: dialog's UA default
          `position: absolute; margin: auto;` needs overriding anyway to sit
          inside this backdrop, and a plain div keeps focus/ARIA behavior
          predictable across browsers. */}
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- see note above */}
      <div
        className="pause-menu-card"
        role="dialog"
        aria-modal="true"
        aria-label="Paused"
      >
        {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
        <header className="pause-menu-head">
          <h2>Paused</h2>
          <button
            type="button"
            className="pause-menu-close"
            onClick={onClose}
            aria-label="Resume flying"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div
          className="pause-menu-tabs"
          role="tablist"
          aria-label="Pause menu sections"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'quests'}
            className={tab === 'quests' ? 'is-active' : ''}
            onClick={() => setTab('quests')}
          >
            <ListChecks aria-hidden="true" /> Quests
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'locker'}
            className={tab === 'locker' ? 'is-active' : ''}
            onClick={() => setTab('locker')}
          >
            <Vault aria-hidden="true" /> Locker
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'travel'}
            className={tab === 'travel' ? 'is-active' : ''}
            onClick={() => setTab('travel')}
          >
            <MapPinned aria-hidden="true" /> Travel
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'options'}
            className={tab === 'options' ? 'is-active' : ''}
            onClick={() => setTab('options')}
          >
            <Settings2 aria-hidden="true" /> Options
          </button>
        </div>

        <div className="pause-menu-body" role="tabpanel">
          {tab === 'quests' && <QuestList progress={progress} />}
          {tab === 'locker' && (
            <LockerPanel progress={progress} progressStore={progressStore} />
          )}
          {tab === 'travel' && (
            <TravelTab
              secretMarkers={secretMarkers}
              travelTo={travelTo}
              onClose={onClose}
            />
          )}
          {tab === 'options' && (
            <OptionsTab
              progress={progress}
              progressStore={progressStore}
              onResetCamera={onResetCamera}
            />
          )}
        </div>

        <footer className="pause-menu-actions">
          <button
            type="button"
            className="pause-menu-primary"
            onClick={onClose}
          >
            Resume
          </button>
          <button
            type="button"
            className="pause-menu-secondary"
            onClick={onRespawn}
          >
            Respawn
          </button>
          <FreshGooseButton
            onConfirm={() => {
              progressStore.reset();
              onClose();
            }}
          />
        </footer>
      </div>
    </div>
  );
}

function TravelTab({
  secretMarkers,
  travelTo,
  onClose,
}: {
  secretMarkers: SecretMarkerTelemetry[];
  travelTo: (secretId: string) => boolean;
  onClose: () => void;
}) {
  const found = secretMarkers
    .filter((secret) => secret.found)
    .sort((a, b) => a.label.localeCompare(b.label));

  if (found.length === 0) {
    return (
      <p className="pause-menu-empty">Find a secret to unlock fast travel.</p>
    );
  }

  return (
    <ul className="travel-list">
      {found.map((secret) => (
        <li key={secret.id}>
          <button
            type="button"
            onClick={() => {
              travelTo(secret.id);
              onClose();
            }}
          >
            <MapPinned aria-hidden="true" />
            <span>{secret.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Same list the control-deck shows, so it stays readable on screens too
 * small for the deck. `touch` names the on-screen button where one exists;
 * ragdoll, drag, and pinch have no dedicated button so they repeat as-is.
 */
const CONTROLS: { action: string; key: string; touch: string }[] = [
  { action: 'Dive', key: 'W', touch: 'Dive' },
  { action: 'Pull up', key: 'S', touch: 'Pull up' },
  { action: 'Bank', key: 'A / D', touch: 'Bank left / right' },
  { action: 'Flap', key: 'SPACE', touch: 'Flap' },
  { action: 'Flare / brake', key: 'SHIFT', touch: 'Flare' },
  { action: 'Honk', key: 'E', touch: 'Honk' },
  { action: 'Grab / throw', key: 'F', touch: 'Grab' },
  { action: 'Ragdoll', key: 'R', touch: 'R' },
  { action: 'Camera', key: 'DRAG', touch: 'Drag' },
  { action: 'Zoom', key: 'SCROLL', touch: 'Pinch' },
  { action: 'Quests', key: 'TAB', touch: 'Quest button' },
  { action: 'Menu', key: 'ESC', touch: 'Pause button' },
];

function OptionsTab({
  progress,
  progressStore,
  onResetCamera,
}: {
  progress: ProgressState;
  progressStore: ProgressStore;
  onResetCamera: () => void;
}) {
  const settings = progress.settings;
  const setSettings = (patch: Partial<Settings>) => {
    progressStore.update((state) => {
      state.settings = { ...state.settings, ...patch };
    });
  };

  return (
    <div className="options-tab">
      <div className="option-row">
        <span>Touch controls</span>
        <fieldset className="segmented">
          <legend className="sr-only">Touch controls</legend>
          {(['auto', 'on', 'off'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={settings.touchControls === mode}
              className={settings.touchControls === mode ? 'is-active' : ''}
              onClick={() => setSettings({ touchControls: mode })}
            >
              {mode}
            </button>
          ))}
        </fieldset>
      </div>

      <div className="option-row option-row-slider">
        <span>Camera sensitivity</span>
        <div className="option-slider">
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={settings.cameraSensitivity}
            onChange={(event) =>
              setSettings({ cameraSensitivity: Number(event.target.value) })
            }
            aria-label="Camera sensitivity"
          />
          <output>{settings.cameraSensitivity.toFixed(2)}x</output>
        </div>
      </div>

      <ToggleRow
        label="Sound"
        value={settings.sound}
        onChange={(value) => setSettings({ sound: value })}
      />
      <ToggleRow
        label="Ambient"
        value={settings.ambient}
        onChange={(value) => setSettings({ ambient: value })}
      />
      <ToggleRow
        label="Slow motion"
        value={settings.slowMotion}
        onChange={(value) => setSettings({ slowMotion: value })}
      />

      <div className="option-row">
        <span>Camera</span>
        <button
          type="button"
          className="pause-menu-secondary options-reset-camera"
          onClick={onResetCamera}
        >
          <RotateCcw aria-hidden="true" /> Reset camera
        </button>
      </div>

      <div className="options-controls">
        <h3 className="quest-list-heading">Controls</h3>
        <ul className="controls-list">
          {CONTROLS.map((control) => (
            <li key={control.action}>
              <span className="controls-list-key">
                <span className="desktop-instructions">{control.key}</span>
                <span className="touch-instructions">{control.touch}</span>
              </span>
              <span className="controls-list-action">{control.action}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="option-row">
      <span>{label}</span>
      <button
        type="button"
        className={`toggle-pill${value ? ' is-on' : ''}`}
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
      >
        {value ? 'On' : 'Off'}
      </button>
    </div>
  );
}

/** "Fresh goose": a second tap within 4s confirms the wipe. */
function FreshGooseButton({ onConfirm }: { onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const handleClick = () => {
    if (confirming) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      setConfirming(false);
      onConfirm();
      return;
    }
    setConfirming(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setConfirming(false);
    }, 4000);
  };

  return (
    <button
      type="button"
      className={`pause-menu-danger${confirming ? ' is-confirming' : ''}`}
      onClick={handleClick}
    >
      {confirming ? 'Tap again to wipe the save' : 'Fresh goose'}
    </button>
  );
}
