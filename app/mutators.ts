import type {
  Modifiers,
  MutatorDefinition,
  ProgressState,
} from './game-contract';
import { DEFAULT_MODIFIERS } from './game-contract';

export const MUTATORS: MutatorDefinition[] = [
  {
    id: 'jet-goose',
    name: 'Jet Goose',
    tagline: 'Supersonic sandwich enthusiast.',
    cost: 6,
    kind: 'ability',
    modifiers: {
      jetstreamAlways: true,
      topSpeedScale: 1.1,
    },
  },
  {
    id: 'angel-goose',
    name: 'Angel Goose',
    tagline: 'Wings and things.',
    cost: 8,
    kind: 'ability',
    modifiers: {
      gravityScale: 0.42,
      halo: true,
    },
  },
  {
    id: 'giga-goose',
    name: 'Giga Goose',
    tagline: 'Honks audible from space.',
    cost: 12,
    kind: 'ability',
    modifiers: {
      gooseScale: 3,
      honkRadiusScale: 1.6,
      flapPowerScale: 1.35,
    },
  },
  {
    id: 'party-goose',
    name: 'Party Goose',
    tagline: 'Students groove instead of flee.',
    cost: 5,
    kind: 'ability',
    modifiers: {
      honkStyle: 'party',
      honkRadiusScale: 1.25,
    },
  },
  {
    id: 'bronco-goose',
    name: 'Bronco Goose',
    tagline: 'You are no longer alone.',
    cost: 10,
    kind: 'ability',
    modifiers: {
      broncoFollows: true,
    },
  },
  {
    id: 'gold-goose',
    name: 'Gold Goose',
    tagline: 'For the scholarship photos.',
    cost: 3,
    kind: 'skin',
    modifiers: {
      colors: {
        body: 0xf1c500,
        breast: 0xfff2c4,
        neck: 0x532e1f,
        wing: 0xd9a900,
        beak: 0x3a2013,
      },
    },
  },
  {
    id: 'snow-goose',
    name: 'Snow Goose',
    tagline: 'Winter break happened early.',
    cost: 3,
    kind: 'skin',
    modifiers: {
      colors: {
        body: 0xf4f4f0,
        breast: 0xffffff,
        neck: 0xe9e6dc,
        wing: 0xd8d6cc,
        beak: 0xf28c28,
      },
    },
  },
  {
    id: 'bronco-brown',
    name: 'Bronco Brown',
    tagline: 'School spirit, feathered.',
    cost: 3,
    kind: 'skin',
    modifiers: {
      colors: {
        body: 0x6e3f25,
        breast: 0xc9a56a,
        neck: 0x25170f,
        wing: 0x4b2a18,
        beak: 0xf1c500,
      },
    },
  },
  {
    id: 'midnight-goose',
    name: 'Midnight Goose',
    tagline: 'You cannot see me in the dark.',
    cost: 3,
    kind: 'skin',
    modifiers: {
      colors: {
        body: 0x1b1f2a,
        breast: 0x394157,
        neck: 0x0d0f15,
        wing: 0x121520,
        beak: 0xff8f3d,
      },
    },
  },
];

export const MUTATOR_BY_ID = new Map(MUTATORS.map((m) => [m.id, m]));

const SKINS = MUTATORS.filter((m) => m.kind === 'skin').map((m) => m.id);

/**
 * Apply active mutators to compute the effective modifiers.
 * Scale fields multiply, booleans OR, honkStyle/colors are last-writer-wins.
 */
export const computeModifiers = (activeIds: readonly string[]): Modifiers => {
  const result: Modifiers = { ...DEFAULT_MODIFIERS };
  const scales: Record<string, number[]> = {
    gooseScale: [],
    honkRadiusScale: [],
    flapPowerScale: [],
    topSpeedScale: [],
    gravityScale: [],
  };

  for (const id of activeIds) {
    const mutator = MUTATOR_BY_ID.get(id);
    if (!mutator) continue;

    const mods = mutator.modifiers;

    // Track scale fields for multiplication
    if (mods.gooseScale !== undefined) scales.gooseScale.push(mods.gooseScale);
    if (mods.honkRadiusScale !== undefined)
      scales.honkRadiusScale.push(mods.honkRadiusScale);
    if (mods.flapPowerScale !== undefined)
      scales.flapPowerScale.push(mods.flapPowerScale);
    if (mods.topSpeedScale !== undefined)
      scales.topSpeedScale.push(mods.topSpeedScale);
    if (mods.gravityScale !== undefined)
      scales.gravityScale.push(mods.gravityScale);

    // Booleans OR
    if (mods.jetstreamAlways === true) result.jetstreamAlways = true;
    if (mods.halo === true) result.halo = true;
    if (mods.broncoFollows === true) result.broncoFollows = true;

    // Last-writer-wins for honkStyle
    if (mods.honkStyle !== undefined) result.honkStyle = mods.honkStyle;

    // Last-writer-wins for colors
    if (mods.colors !== undefined) result.colors = mods.colors;
  }

  // Apply multiplied scales
  const multiply = (key: keyof typeof scales) => {
    if (scales[key].length > 0) {
      result[key as keyof Modifiers] = scales[key].reduce(
        (a, b) => a * b,
        1,
      ) as never;
    }
  };
  multiply('gooseScale');
  multiply('honkRadiusScale');
  multiply('flapPowerScale');
  multiply('topSpeedScale');
  multiply('gravityScale');

  return result;
};

export const canUnlock = (state: ProgressState, id: string): boolean => {
  const mutator = MUTATOR_BY_ID.get(id);
  if (!mutator) return false;
  return state.tokens >= mutator.cost && !state.unlockedMutators.includes(id);
};

export const unlockCost = (id: string): number | null => {
  const mutator = MUTATOR_BY_ID.get(id);
  return mutator ? mutator.cost : null;
};

export const activeSkin = (activeIds: readonly string[]): string | null => {
  for (let i = activeIds.length - 1; i >= 0; i--) {
    if (SKINS.includes(activeIds[i])) {
      return activeIds[i];
    }
  }
  return null;
};

/**
 * Toggle a mutator's active state. If it's a skin, remove all other active skins.
 */
export const toggleMutator = (active: string[], id: string): string[] => {
  const isSkin = SKINS.includes(id);
  const isActive = active.includes(id);

  if (isActive) {
    // Deactivate
    return active.filter((x) => x !== id);
  } else {
    // Activate
    let result = [...active];
    if (isSkin) {
      // Remove all other skins
      result = result.filter((x) => !SKINS.includes(x));
    }
    result.push(id);
    return result;
  }
};
