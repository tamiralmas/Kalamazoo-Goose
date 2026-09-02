import type {
  GameEvent,
  ProgressState,
  QuestDefinition,
  QuestState,
} from './game-contract';

// Quest table. Each quest is a joke with a progress bar, in the game's voice.
// `advance` is pure: it receives the event and the quest's current state and
// returns the next state, or null when the event does not count.

const count =
  (by = 1) =>
  (_event: GameEvent, state: QuestState) => ({
    ...state,
    count: state.count + by,
  });

const countWhen =
  (test: (event: GameEvent) => boolean, by = 1) =>
  (event: GameEvent, state: QuestState) =>
    test(event) ? { ...state, count: state.count + by } : null;

/** Count each distinct subject once ("5 different cars"). */
const countDistinct =
  (
    test: (event: GameEvent) => boolean,
    subjectOf: (event: GameEvent) => string | undefined,
  ) =>
  (event: GameEvent, state: QuestState) => {
    if (!test(event)) return null;
    const subject = subjectOf(event);
    if (!subject || state.seen.includes(subject)) return null;
    return { count: state.count + 1, seen: [...state.seen, subject] };
  };

/** Track the best value seen; completes when it reaches the target. */
const reachValue =
  (valueOf: (event: GameEvent) => number | null) =>
  (event: GameEvent, state: QuestState) => {
    const value = valueOf(event);
    if (value === null || value <= state.count) return null;
    return { ...state, count: value };
  };

const trick = (event: GameEvent, ...ids: string[]) =>
  event.type === 'trick' && ids.includes(event.id);

export const QUESTS: QuestDefinition[] = [
  // Tier 1: the first ten minutes.
  {
    id: 'wings-up',
    title: 'Wings Up',
    description: 'Stay airborne for five seconds. The pond geese are watching.',
    target: 1,
    reward: 1,
    tier: 1,
    listens: ['flight'],
    advance: countWhen(
      (event) => event.type === 'flight' && event.seconds >= 5,
    ),
  },
  {
    id: 'anomaly-detected',
    title: 'Anomaly Detected',
    description: 'Find one Kalamazoo secret. The radar card is not decorative.',
    target: 1,
    reward: 1,
    tier: 1,
    listens: ['secret'],
    advance: count(),
  },
  {
    id: 'freshman-orientation',
    title: 'Freshman Orientation',
    description:
      'Scatter 25 students with honks. They will find their classes eventually.',
    target: 25,
    reward: 2,
    tier: 1,
    listens: ['honk'],
    advance: (event, state) =>
      event.type === 'honk' && event.scattered > 0
        ? { ...state, count: state.count + event.scattered }
        : null,
  },
  {
    id: 'insurance-fraud',
    title: 'Insurance Fraud',
    description:
      'Get hit by five different cars. Each one is a separate claim.',
    target: 5,
    reward: 3,
    tier: 1,
    listens: ['trick'],
    advance: countDistinct(
      (event) => trick(event, 'insurance-fraud', 'airborne-car-bop'),
      (event) => (event.type === 'trick' ? event.subject : undefined),
    ),
  },
  {
    id: 'belly-flop-olympics',
    title: 'Belly Flop Olympics',
    description:
      'Three belly flops. Style points are deducted, chaos points are not.',
    target: 3,
    reward: 2,
    tier: 1,
    listens: ['trick'],
    advance: countWhen((event) => trick(event, 'belly-flop')),
  },
  {
    id: 'ten-point-landing',
    title: 'Ten Point Landing',
    description: 'One perfect splashdown: flare late, wings level, no drama.',
    target: 1,
    reward: 2,
    tier: 1,
    listens: ['trick'],
    advance: countWhen((event) => trick(event, 'perfect-splashdown')),
  },
  {
    id: 'sangren-skyline',
    title: 'Sangren Skyline',
    description: 'Land on ten different roofs. Facilities has been notified.',
    target: 10,
    reward: 3,
    tier: 1,
    listens: ['trick'],
    advance: countDistinct(
      (event) => trick(event, 'rooftop-landing', 'rooftop-pancake'),
      (event) => (event.type === 'trick' ? event.subject : undefined),
    ),
  },

  // Tier 2: the long game.
  {
    id: 'v-formation',
    title: 'V Formation',
    description: 'Recruit all eight campus geese. Honk near a roosting goose.',
    target: 8,
    reward: 4,
    tier: 2,
    listens: ['flock'],
    advance: reachValue((event) =>
      event.type === 'flock' ? event.recruited : null,
    ),
  },
  {
    id: 'campus-bowling-league',
    title: 'Campus Bowling League',
    description:
      'Bowl over 20 students. Airborne strikes count double in your heart.',
    target: 20,
    reward: 3,
    tier: 2,
    listens: ['bowl'],
    advance: count(),
  },
  {
    id: 'traffic-report',
    title: 'Traffic Report',
    description: 'Stop 15 cars with honks. Stadium Drive is now a goose lane.',
    target: 15,
    reward: 3,
    tier: 2,
    listens: ['honk'],
    advance: (event, state) =>
      event.type === 'honk' && event.carsStopped > 0
        ? { ...state, count: state.count + event.carsStopped }
        : null,
  },
  {
    id: 'low-pass',
    title: 'Low Pass',
    description: 'Ten campus flybys: skim a moving car without touching it.',
    target: 10,
    reward: 2,
    tier: 2,
    listens: ['trick'],
    advance: countWhen((event) => trick(event, 'campus-flyby')),
  },
  {
    id: 'jetstream-mile',
    title: 'Jetstream Mile',
    description:
      'Fly one kilometer in a single flight. Climb above 50 m for the tailwind.',
    target: 1,
    reward: 3,
    tier: 2,
    listens: ['flight'],
    advance: countWhen(
      (event) => event.type === 'flight' && event.meters >= 1000,
    ),
  },
  {
    id: 'above-the-bronco',
    title: 'Above the Bronco',
    description:
      'Reach 120 m above the ground. Sparks Tower is a suggestion, not a limit.',
    target: 120,
    reward: 3,
    tier: 2,
    listens: ['flight'],
    advance: reachValue((event) =>
      event.type === 'flight' ? Math.floor(event.peakAgl) : null,
    ),
  },
  {
    id: 'mach-goose',
    title: 'Mach Goose',
    description: 'Hit 40 m/s. Dive from the jetstream and hold W.',
    target: 40,
    reward: 3,
    tier: 2,
    listens: ['flight'],
    advance: reachValue((event) =>
      event.type === 'flight' ? Math.floor(event.topSpeed) : null,
    ),
  },
  {
    id: 'lawn-dart-champion',
    title: 'Lawn Dart Champion',
    description:
      'Five lawn darts. Grounds crew requests you aim for the mulch.',
    target: 5,
    reward: 2,
    tier: 2,
    listens: ['trick'],
    advance: countWhen((event) => trick(event, 'lawn-dart')),
  },
  {
    id: 'kalamazoo-cartographer',
    title: 'Kalamazoo Cartographer',
    description: 'Find ten secrets. Downtown has some; so does Asylum Lake.',
    target: 10,
    reward: 5,
    tier: 2,
    listens: ['secret'],
    advance: reachValue((event) =>
      event.type === 'secret' ? event.found : null,
    ),
  },
  {
    id: 'campus-infamy',
    title: 'Campus Infamy',
    description: 'Reach 10,000 chaos in one life. Students will flee on sight.',
    target: 1,
    reward: 5,
    tier: 2,
    listens: ['infamy'],
    advance: count(),
  },

  // Tier 3: props, theft, and the locker.
  {
    id: 'cone-crown',
    title: 'Cone Crown',
    description: 'Wreck 20 traffic cones. Parking Services is filing a report.',
    target: 20,
    reward: 3,
    tier: 3,
    listens: ['prop'],
    advance: countWhen(
      (event) =>
        event.type === 'prop' &&
        event.kind === 'cone' &&
        event.action === 'wrecked',
    ),
  },
  {
    id: 'bench-press',
    title: 'Bench Press',
    description: 'Flip ten benches. Nobody was sitting on them. Probably.',
    target: 10,
    reward: 3,
    tier: 3,
    listens: ['prop'],
    advance: countWhen(
      (event) =>
        event.type === 'prop' &&
        event.kind === 'bench' &&
        event.action === 'wrecked',
    ),
  },
  {
    id: 'friendly-fire',
    title: 'Friendly Fire',
    description:
      'Hit five students with flying props. Cones are aerodynamic, apparently.',
    target: 5,
    reward: 4,
    tier: 3,
    listens: ['prop'],
    advance: countWhen(
      (event) => event.type === 'prop' && event.action === 'hit-student',
    ),
  },
  {
    id: 'petty-theft',
    title: 'Petty Theft',
    description: 'Steal ten items from students. Phones, sandwiches, dignity.',
    target: 10,
    reward: 3,
    tier: 3,
    listens: ['steal'],
    advance: count(),
  },
  {
    id: 'identity-theft',
    title: 'Identity Theft',
    description: 'Steal three WMU ID cards. You are now enrolled in something.',
    target: 3,
    reward: 3,
    tier: 3,
    listens: ['steal'],
    advance: countWhen(
      (event) => event.type === 'steal' && event.item === 'id-card',
    ),
  },
  {
    id: 'clean-getaway',
    title: 'Clean Getaway',
    description: 'Steal five items without getting caught. Fly. Immediately.',
    target: 5,
    reward: 3,
    tier: 3,
    listens: ['steal'],
    advance: countWhen((event) => event.type === 'steal' && !event.caught),
  },
  {
    id: 'new-feathers',
    title: 'New Feathers',
    description:
      'Unlock anything in the goose locker. Tokens come from quests and secrets.',
    target: 1,
    reward: 1,
    tier: 3,
    listens: ['unlock'],
    advance: count(),
  },
  {
    id: 'kalamazoo-complete',
    title: 'Kalamazoo Complete',
    description:
      'Find every secret in the city. The Council of Ducks will remember you.',
    target: 33,
    reward: 10,
    tier: 3,
    listens: ['secret'],
    advance: reachValue((event) =>
      event.type === 'secret' ? event.found : null,
    ),
  },
];

export const QUEST_BY_ID = new Map(QUESTS.map((quest) => [quest.id, quest]));

export const isQuestComplete = (state: ProgressState, id: string) =>
  state.completedQuests.includes(id);

export const questState = (state: ProgressState, id: string): QuestState =>
  state.quests[id] ?? { count: 0, seen: [] };

export const questFraction = (state: ProgressState, quest: QuestDefinition) =>
  isQuestComplete(state, quest.id)
    ? 1
    : Math.min(1, questState(state, quest.id).count / quest.target);

/** The uncompleted quests to pin in the HUD, lowest tier first. */
export const activeQuests = (state: ProgressState, limit = 3) =>
  QUESTS.filter((quest) => !isQuestComplete(state, quest.id))
    .sort((a, b) => a.tier - b.tier)
    .slice(0, limit);

export type QuestApplyResult = {
  completed: QuestDefinition[];
  changed: boolean;
};

const applyStats = (state: ProgressState, event: GameEvent) => {
  const stats = state.stats;
  switch (event.type) {
    case 'honk':
      stats.honks += 1;
      return;
    case 'flight':
      stats.flights += 1;
      stats.metersFlown += Math.max(0, event.meters);
      return;
    case 'bowl':
      stats.studentsBowled += 1;
      return;
    case 'prop':
      if (event.action === 'wrecked') stats.propsWrecked += 1;
      return;
    case 'steal':
      stats.itemsStolen += 1;
      return;
    case 'trick':
      if (event.id === 'insurance-fraud' || event.id === 'airborne-car-bop')
        stats.carsHit += 1;
      return;
    default:
      return;
  }
};

/**
 * Mutates `state` in place (call inside store.update). Returns the quests
 * completed by this event; tokens for them are already added.
 */
export const applyGameEvent = (
  state: ProgressState,
  event: GameEvent,
): QuestApplyResult => {
  let changed = false;
  const completed: QuestDefinition[] = [];
  applyStats(state, event);
  changed = true;

  if (event.type === 'secret') {
    state.tokens += 1;
    state.tokensEarned += 1;
  }

  const quests = { ...state.quests };
  const completedQuests = [...state.completedQuests];
  for (const quest of QUESTS) {
    if (completedQuests.includes(quest.id)) continue;
    if (!quest.listens.includes(event.type)) continue;
    const current = quests[quest.id] ?? { count: 0, seen: [] };
    const next = quest.advance(event, current);
    if (!next) continue;
    quests[quest.id] = next;
    if (next.count >= quest.target) {
      completedQuests.push(quest.id);
      completed.push(quest);
      state.tokens += quest.reward;
      state.tokensEarned += quest.reward;
    }
  }
  state.quests = quests;
  state.completedQuests = completedQuests;
  return { completed, changed };
};
