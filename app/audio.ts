// Kalamazoo Goose sound module.
//
// Everything here is synthesized with the Web Audio API. The game ships no
// audio files, so every honk, thud, and gust of wind is built from
// oscillators and one shared noise buffer at runtime. The module never
// touches an AudioContext at import time (autoplay policies would just
// suspend it anyway); a context is created lazily the first time unlock()
// or any play method runs, ideally from inside a user gesture.

// --- Tuning constants -----------------------------------------------------
// Plain numbers with no per-instance state, so they live at module scope.
// Every actual audio node lives inside createGameAudio() below, which keeps
// two independent GameAudio instances from fighting over one AudioContext.

const MASTER_GAIN = 0.35;
const NOISE_BUFFER_SECONDS = 2;
const MAX_CONCURRENT_VOICES = 12;

// Ambient params are only nudged with setTargetAtTime, never re-created, so
// a slower time constant here just means the bed drifts smoothly frame to
// frame instead of zippering toward every tiny change in speed or altitude.
const AMBIENT_TIME_CONSTANT = 0.25;
// Pausing wants a snappier fade; ~3x this time constant lands near zero in
// about the 0.25s the design calls for.
const AMBIENT_PAUSE_TIME_CONSTANT = 0.08;
const AMBIENT_GAIN_EPSILON = 0.01;
const AMBIENT_FREQ_EPSILON = 4;

const WIND_MIN_FREQ = 300;
const WIND_MAX_FREQ = 1800;
const WIND_MAX_GAIN = 0.25;
const WIND_FULL_SPEED = 40; // m/s where wind intensity tops out
const WIND_FULL_AGL = 100; // meters AGL where altitude stops adding wind

const HUM_FREQ = 72;
const HUM_GAIN = 0.035;

const WATER_FILTER_FREQ = 520;
const WATER_GAIN = 0.16;
const WATER_FULL_SPEED = 12; // m/s where water lap reaches full intensity
const WATER_LFO_FREQ = 0.35; // slow enough to read as lapping, not a buzz
const WATER_LFO_DEPTH = 0.05;

// Minimum seconds between two plays of the same one-shot, so a frame that
// fires a dozen events (twelve cones knocked over at once, say) can't stack
// into a wall of noise. Values are picked per sound: skim is explicitly
// capped at 8/s by the spec, coin and crunch can fire in quick succession
// during a combo so they stay tight, longer/rarer sounds get more room.
const RATE_LIMITS = {
  honk: 0.1,
  flap: 0.07,
  thud: 0.09,
  splash: 0.09,
  skim: 0.125,
  screech: 0.12,
  yelp: 0.1,
  crunch: 0.055,
  chime: 0.12,
  coin: 0.045,
  grab: 0.07,
  cheer: 0.12,
} as const;

// --- Public types -----------------------------------------------------

type AmbientMode = 'flying' | 'planing' | 'waddling' | 'swimming';

type AmbientInput = {
  agl: number;
  speed: number;
  mode: AmbientMode;
  paused: boolean;
};

type CrunchKind = 'cone' | 'bench' | 'trash' | 'bike' | 'sign' | 'flag';

export type GameAudio = {
  unlock(): void;
  setEnabled(sound: boolean, ambient: boolean): void;
  honk(mega?: boolean): void;
  flap(): void;
  thud(severity: number): void;
  splash(strength: number): void;
  skim(): void;
  screech(): void;
  yelp(): void;
  crunch(kind: CrunchKind): void;
  chime(): void;
  coin(): void;
  grab(): void;
  cheer(): void;
  setAmbient(input: AmbientInput): void;
  dispose(): void;
};

// --- Internal helper types -------------------------------------------

type AudioHandles = { context: AudioContext; master: GainNode };

type AmbientGraph = {
  windSource: AudioBufferSourceNode;
  windFilter: BiquadFilterNode;
  windGain: GainNode;
  humOsc: OscillatorNode;
  humGain: GainNode;
  waterSource: AudioBufferSourceNode;
  waterFilter: BiquadFilterNode;
  waterGain: GainNode;
  waterLfo: OscillatorNode;
  waterLfoDepth: GainNode;
};

type AmbientTargets = {
  windFreq: number;
  windGain: number;
  humGain: number;
  waterGain: number;
};

type CrunchTone = {
  type: OscillatorType;
  freqFrom: number;
  freqTo: number;
  peak: number;
  duration: number;
};

type CrunchSpec = {
  filterType: BiquadFilterType;
  freq: number;
  q: number;
  duration: number;
  peak: number;
  tone?: CrunchTone;
  clatter?: number;
};

// Per-kind timbre for wrecked props. Every kind renders as a filtered noise
// hit; some add a tonal "pop" on top, and trash gets a few staggered extra
// taps so it reads as a can rattling rather than a single knock.
const CRUNCH_SPECS: Record<CrunchKind, CrunchSpec> = {
  cone: {
    filterType: 'bandpass',
    freq: 950,
    q: 2.4,
    duration: 0.16,
    peak: 0.16,
    tone: {
      type: 'triangle',
      freqFrom: 520,
      freqTo: 280,
      peak: 0.14,
      duration: 0.09,
    },
  },
  bench: {
    filterType: 'lowpass',
    freq: 300,
    q: 1.1,
    duration: 0.34,
    peak: 0.24,
    tone: {
      type: 'sine',
      freqFrom: 140,
      freqTo: 65,
      peak: 0.22,
      duration: 0.24,
    },
  },
  trash: {
    filterType: 'bandpass',
    freq: 1500,
    q: 6.5,
    duration: 0.3,
    peak: 0.18,
    clatter: 3,
  },
  bike: {
    filterType: 'bandpass',
    freq: 2200,
    q: 7,
    duration: 0.2,
    peak: 0.15,
    tone: {
      type: 'square',
      freqFrom: 900,
      freqTo: 450,
      peak: 0.08,
      duration: 0.12,
    },
  },
  sign: {
    filterType: 'bandpass',
    freq: 2700,
    q: 13,
    duration: 0.5,
    peak: 0.17,
  },
  flag: {
    filterType: 'highpass',
    freq: 750,
    q: 0.7,
    duration: 0.15,
    peak: 0.11,
  },
};

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// --- Factory ------------------------------------------------------------

export function createGameAudio(): GameAudio {
  let audioContext: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let ambient: AmbientGraph | null = null;
  let ambientTargets: AmbientTargets = {
    windFreq: -1,
    windGain: -1,
    humGain: -1,
    waterGain: -1,
  };

  let soundEnabled = true;
  let ambientEnabled = true;

  const lastPlayedAt = new Map<string, number>();
  const activeVoiceEnds: number[] = [];

  // Lazily creates the AudioContext, master gain bus, and the persistent
  // ambient graph. Safe to call from every play method; it is a no-op once
  // the context already exists, and it never throws (autoplay restrictions
  // or an unavailable AudioContext just resolve to null downstream).
  function ensureContext(): AudioHandles | null {
    try {
      if (audioContext && masterGain) {
        return { context: audioContext, master: masterGain };
      }
      const context = new AudioContext();
      const master = context.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(context.destination);
      audioContext = context;
      masterGain = master;
      buildAmbientGraph(context, master);
      return { context, master };
    } catch {
      return null;
    }
  }

  // One 2-second white noise buffer, reused for every noise-based sound
  // (flap, splash, skim, screech, crunch, cheer, the wind and water beds).
  // AudioBuffers are not tied to the context that created them, so this
  // survives a dispose() + unlock() cycle without regenerating.
  function getNoiseBuffer(context: AudioContext): AudioBuffer {
    if (noiseBuffer) return noiseBuffer;
    const length = Math.floor(context.sampleRate * NOISE_BUFFER_SECONDS);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) {
      data[index] = Math.random() * 2 - 1;
    }
    noiseBuffer = buffer;
    return buffer;
  }

  function createNoiseSource(
    context: AudioContext,
    loop: boolean,
  ): AudioBufferSourceNode {
    const source = context.createBufferSource();
    source.buffer = getNoiseBuffer(context);
    source.loop = loop;
    return source;
  }

  // Standard attack/decay envelope shared by every one-shot: ramps up from
  // near-silence to peak, then back down. Never touches 0 directly since
  // exponentialRampToValueAtTime cannot ramp to or from zero.
  function createEnvelope(
    context: AudioContext,
    master: GainNode,
    peak: number,
    attack: number,
    duration: number,
    startTime?: number,
  ): GainNode {
    const gain = context.createGain();
    const now = startTime ?? context.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.0002, peak),
      now + attack,
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    gain.connect(master);
    return gain;
  }

  // Disconnects a batch of transient nodes shortly after they finish
  // playing. Web Audio would eventually garbage-collect them anyway, but
  // explicit cleanup keeps the graph tidy during long sessions.
  function scheduleCleanup(nodes: AudioNode[], seconds: number): void {
    const delayMs = Math.max(0, seconds) * 1000 + 60;
    window.setTimeout(() => {
      try {
        nodes.forEach((node) => node.disconnect());
      } catch {
        // Already disconnected or the context closed; nothing to clean up.
      }
    }, delayMs);
  }

  // Rate limiter: refuses a play if the same sound key fired too recently.
  function canPlayOneShot(
    context: AudioContext,
    key: string,
    minInterval: number,
  ): boolean {
    const now = context.currentTime;
    const last = lastPlayedAt.get(key) ?? -Infinity;
    if (now - last < minInterval) return false;
    lastPlayedAt.set(key, now);
    return true;
  }

  // Voice cap: prunes voices whose scheduled stop time has passed, then
  // refuses new ones once MAX_CONCURRENT_VOICES are in flight. This is a
  // coarse guard against pathological stacking (many events in one frame),
  // not a precise node count.
  function allocateVoice(context: AudioContext, duration: number): boolean {
    const now = context.currentTime;
    for (let index = activeVoiceEnds.length - 1; index >= 0; index -= 1) {
      if (activeVoiceEnds[index] <= now) activeVoiceEnds.splice(index, 1);
    }
    if (activeVoiceEnds.length >= MAX_CONCURRENT_VOICES) return false;
    activeVoiceEnds.push(now + duration);
    return true;
  }

  // Filtered noise burst: the workhorse behind flap, splash, skim, screech,
  // crunch, and cheer. freqTo (optional) sweeps the filter cutoff during
  // the sound, which is what gives splash its pitch dip and screech its
  // settle.
  function playFilteredNoise(
    handles: AudioHandles,
    options: {
      filterType: BiquadFilterType;
      freqFrom: number;
      freqTo?: number;
      q: number;
      peak: number;
      attack: number;
      duration: number;
      playbackRate?: number;
    },
  ): void {
    const { context, master } = handles;
    const now = context.currentTime;
    const source = createNoiseSource(context, false);
    source.playbackRate.value = options.playbackRate ?? 1;
    const filter = context.createBiquadFilter();
    filter.type = options.filterType;
    filter.Q.value = options.q;
    filter.frequency.setValueAtTime(options.freqFrom, now);
    if (options.freqTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(20, options.freqTo),
        now + options.duration,
      );
    }
    const envelope = createEnvelope(
      context,
      master,
      options.peak,
      options.attack,
      options.duration,
      now,
    );
    source.connect(filter).connect(envelope);
    // Start at a random offset into the shared buffer so repeated hits of
    // the same sound do not all play the exact same slice of noise.
    const maxOffset = Math.max(
      0,
      NOISE_BUFFER_SECONDS - options.duration - 0.1,
    );
    const offset = Math.random() * maxOffset;
    source.start(now, offset);
    source.stop(now + options.duration + 0.05);
    scheduleCleanup([source, filter, envelope], options.duration + 0.05);
  }

  // Tonal blip: an oscillator with an optional pitch slide, used for the
  // percussive/tonal parts of thud, crunch, and grab.
  function playTone(
    handles: AudioHandles,
    options: {
      type: OscillatorType;
      freqFrom: number;
      freqTo?: number;
      peak: number;
      attack: number;
      duration: number;
    },
  ): void {
    const { context, master } = handles;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    oscillator.type = options.type;
    oscillator.frequency.setValueAtTime(options.freqFrom, now);
    if (options.freqTo !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(20, options.freqTo),
        now + options.duration,
      );
    }
    const envelope = createEnvelope(
      context,
      master,
      options.peak,
      options.attack,
      options.duration,
      now,
    );
    oscillator.connect(envelope);
    oscillator.start(now);
    oscillator.stop(now + options.duration + 0.02);
    scheduleCleanup([oscillator, envelope], options.duration + 0.05);
  }

  // Builds the persistent ambient bed once per context lifetime: a wind
  // noise bed, a campus hum drone, and a water lap bed. All three are
  // started immediately at zero gain and only ever have their params
  // nudged afterward, so setAmbient never creates a node.
  function buildAmbientGraph(context: AudioContext, master: GainNode): void {
    const windSource = createNoiseSource(context, true);
    const windFilter = context.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = WIND_MIN_FREQ;
    windFilter.Q.value = 0.5;
    const windGain = context.createGain();
    windGain.gain.value = 0;
    windSource.connect(windFilter).connect(windGain).connect(master);
    windSource.start();

    const humOsc = context.createOscillator();
    humOsc.type = 'sine';
    humOsc.frequency.value = HUM_FREQ;
    const humGain = context.createGain();
    humGain.gain.value = 0;
    humOsc.connect(humGain).connect(master);
    humOsc.start();

    const waterSource = createNoiseSource(context, true);
    const waterFilter = context.createBiquadFilter();
    waterFilter.type = 'bandpass';
    waterFilter.frequency.value = WATER_FILTER_FREQ;
    waterFilter.Q.value = 0.9;
    const waterGain = context.createGain();
    waterGain.gain.value = 0;
    const waterLfo = context.createOscillator();
    waterLfo.type = 'sine';
    waterLfo.frequency.value = WATER_LFO_FREQ;
    const waterLfoDepth = context.createGain();
    waterLfoDepth.gain.value = WATER_LFO_DEPTH;
    waterSource.connect(waterFilter).connect(waterGain).connect(master);
    // The LFO rides on top of waterGain's own automation (they sum), which
    // is what gives the bed its slow lapping motion without ever creating
    // a new node per frame.
    waterLfo.connect(waterLfoDepth).connect(waterGain.gain);
    waterSource.start();
    waterLfo.start();

    ambient = {
      windSource,
      windFilter,
      windGain,
      humOsc,
      humGain,
      waterSource,
      waterFilter,
      waterGain,
      waterLfo,
      waterLfoDepth,
    };
    ambientTargets = {
      windFreq: WIND_MIN_FREQ,
      windGain: 0,
      humGain: 0,
      waterGain: 0,
    };
  }

  // Applies new ambient targets, skipping any param whose target has not
  // moved by more than a small epsilon since the last applied value. This
  // is what keeps setAmbient cheap when it is called every frame.
  function applyAmbient(
    context: AudioContext,
    windFreq: number,
    windGainTarget: number,
    humGainTarget: number,
    waterGainTarget: number,
    timeConstant: number,
  ): void {
    if (!ambient) return;
    const now = context.currentTime;
    if (Math.abs(windFreq - ambientTargets.windFreq) > AMBIENT_FREQ_EPSILON) {
      ambient.windFilter.frequency.setTargetAtTime(windFreq, now, timeConstant);
      ambientTargets.windFreq = windFreq;
    }
    if (
      Math.abs(windGainTarget - ambientTargets.windGain) > AMBIENT_GAIN_EPSILON
    ) {
      ambient.windGain.gain.setTargetAtTime(windGainTarget, now, timeConstant);
      ambientTargets.windGain = windGainTarget;
    }
    if (
      Math.abs(humGainTarget - ambientTargets.humGain) > AMBIENT_GAIN_EPSILON
    ) {
      ambient.humGain.gain.setTargetAtTime(humGainTarget, now, timeConstant);
      ambientTargets.humGain = humGainTarget;
    }
    if (
      Math.abs(waterGainTarget - ambientTargets.waterGain) >
      AMBIENT_GAIN_EPSILON
    ) {
      ambient.waterGain.gain.setTargetAtTime(
        waterGainTarget,
        now,
        timeConstant,
      );
      ambientTargets.waterGain = waterGainTarget;
    }
  }

  function unlock(): void {
    try {
      const handles = ensureContext();
      if (handles && handles.context.state === 'suspended') {
        void handles.context.resume();
      }
    } catch {
      // Autoplay restrictions or an unavailable AudioContext: no-op.
    }
  }

  function setEnabled(sound: boolean, ambientOn: boolean): void {
    try {
      soundEnabled = sound;
      ambientEnabled = ambientOn;
      if (!ambientEnabled && audioContext && ambient) {
        // Settings turned ambient off directly; fade the bed out quickly
        // rather than waiting for the next setAmbient call.
        applyAmbient(
          audioContext,
          ambientTargets.windFreq,
          0,
          0,
          0,
          AMBIENT_PAUSE_TIME_CONSTANT,
        );
      }
    } catch {
      // Flag updates should never throw, but guard for consistency anyway.
    }
  }

  // The existing honk: two square oscillators sliding down in pitch, tuned
  // to match app/game-engine.ts's inline playHonk. mega drops the pitch,
  // stretches the duration, and layers in a second harmonic (an octave up)
  // for a bigger, rounder honk. Peaks are scaled up from the original 0.11
  // so that after the 0.35 master gain they land at the same loudness the
  // engine's standalone honk had.
  function honk(mega = false): void {
    try {
      if (!soundEnabled) return;
      const handles = ensureContext();
      if (!handles) return;
      if (!canPlayOneShot(handles.context, 'honk', RATE_LIMITS.honk)) return;
      const duration = mega ? 0.58 : 0.34;
      if (!allocateVoice(handles.context, duration + 0.05)) return;
      const { context, master } = handles;
      const now = context.currentTime;
      const pitch = mega ? 0.72 : 1;
      const peak = mega ? 0.4 : 0.31;
      const attack = 0.018;
      const envelope = createEnvelope(
        context,
        master,
        peak,
        attack,
        duration,
        now,
      );
      const voices = [
        { start: 205 * pitch, end: 142 * pitch, volume: 0.7 },
        { start: 154 * pitch, end: 112 * pitch, volume: 0.42 },
      ];
      if (mega) {
        voices.push({
          start: 205 * pitch * 2,
          end: 142 * pitch * 2,
          volume: 0.22,
        });
      }
      const cleanupNodes: AudioNode[] = [envelope];
      voices.forEach(({ start, end, volume }) => {
        const oscillator = context.createOscillator();
        const voiceGain = context.createGain();
        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(start, now);
        oscillator.frequency.exponentialRampToValueAtTime(
          end,
          now + duration - 0.03,
        );
        voiceGain.gain.value = volume;
        oscillator.connect(voiceGain).connect(envelope);
        oscillator.start(now);
        oscillator.stop(now + duration + 0.02);
        cleanupNodes.push(oscillator, voiceGain);
      });
      scheduleCleanup(cleanupNodes, duration + 0.05);
    } catch {
      // Audio is a bonus; never let a synth glitch break the honk gesture.
    }
  }

  function flap(): void {
    try {
      if (!soundEnabled) return;
      const handles = ensureContext();
      if (!handles) return;
      if (!canPlayOneShot(handles.context, 'flap', RATE_LIMITS.flap)) return;
      const duration = 0.11 + Math.random() * 0.03;
      if (!allocateVoice(handles.context, duration + 0.05)) return;
      playFilteredNoise(handles, {
        filterType: 'lowpass',
        freqFrom: 700 + Math.random() * 200,
        q: 0.6,
        peak: 0.035,
        attack: 0.008,
        duration,
        playbackRate: 0.8 + Math.random() * 0.4,
      });
    } catch {
      // Wingbeats are decorative; a synth failure should never break flight.
    }
  }

  function thud(severity: number): void {
    try {
      if (!soundEnabled) return;
      const handles = ensureContext();
      if (!handles) return;
      if (!canPlayOneShot(handles.context, 'thud', RATE_LIMITS.thud)) return;
      const amount = clamp01(severity);
      const duration = 0.14 + amount * 0.16;
      if (!allocateVoice(handles.context, duration + 0.05)) return;
      // Low sine thump for the body of the impact...
      playTone(handles, {
        type: 'sine',
        freqFrom: 150 - amount * 60,
        freqTo: 55,
        peak: 0.1 + amount * 0.35,
        attack: 0.004,
        duration,
      });
      // ...plus a short filtered noise transient for the physical slap.
      playFilteredNoise(handles, {
        filterType: 'lowpass',
        freqFrom: 500 - amount * 250,
        q: 0.7,
        peak: 0.06 + amount * 0.2,
        attack: 0.003,
        duration: duration * 0.7,
      });
    } catch {
      // Impacts should never crash the frame loop.
    }
  }

  function splash(strength: number): void {
    try {
      if (!soundEnabled) return;
      const handles = ensureContext();
      if (!handles) return;
      if (!canPlayOneShot(handles.context, 'splash', RATE_LIMITS.splash))
        return;
      const amount = clamp01(strength);
      const duration = 0.22 + amount * 0.28;
      if (!allocateVoice(handles.context, duration + 0.05)) return;
      playFilteredNoise(handles, {
        filterType: 'bandpass',
        freqFrom: 1400,
        freqTo: 260, // the pitch dip as the splash settles into the water
        q: 1.1,
        peak: 0.1 + amount * 0.3,
        attack: 0.006,
        duration,
      });
    } catch {
      // Water hits are cosmetic only.
    }
  }

  function skim(): void {
    try {
      if (!soundEnabled) return;
      const handles = ensureContext();
      if (!handles) return;
      if (!canPlayOneShot(handles.context, 'skim', RATE_LIMITS.skim)) return;
      const duration = 0.035 + Math.random() * 0.015;
      if (!allocateVoice(handles.context, duration + 0.03)) return;
      playFilteredNoise(handles, {
        filterType: 'highpass',
        freqFrom: 2200 + Math.random() * 800,
        q: 0.8,
        peak: 0.03,
        attack: 0.002,
        duration,
        playbackRate: 1.3 + Math.random() * 0.5,
      });
    } catch {
      // Spray ticks are the smallest possible bonus sound.
    }
  }

  function screech(): void {
    try {
      if (!soundEnabled) return;
      const handles = ensureContext();
      if (!handles) return;
      if (!canPlayOneShot(handles.context, 'screech', RATE_LIMITS.screech))
        return;
      const duration = 0.4;
      if (!allocateVoice(handles.context, duration + 0.05)) return;
      playFilteredNoise(handles, {
        filterType: 'bandpass',
        freqFrom: 2600,
        freqTo: 1900, // tires settle slightly as the car comes to a stop
        q: 11,
        peak: 0.16,
        attack: 0.01,
        duration,
        playbackRate: 1.6,
      });
    } catch {
      // Traffic sounds are ambience, not gameplay-critical.
    }
  }

  function yelp(): void {
    try {
      if (!soundEnabled) return;
      const handles = ensureContext();
      if (!handles) return;
      if (!canPlayOneShot(handles.context, 'yelp', RATE_LIMITS.yelp)) return;
      const duration = 0.3;
      if (!allocateVoice(handles.context, duration + 0.05)) return;
      const { context, master } = handles;
      const now = context.currentTime;
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(220, now);
      oscillator.frequency.exponentialRampToValueAtTime(440, now + duration);
      // Vibrato: a fast, shallow wobble riding on top of the rising pitch.
      const vibrato = context.createOscillator();
      vibrato.type = 'sine';
      vibrato.frequency.value = 16;
      const vibratoDepth = context.createGain();
      vibratoDepth.gain.value = 10;
      vibrato.connect(vibratoDepth).connect(oscillator.frequency);
      const envelope = createEnvelope(
        context,
        master,
        0.16,
        0.01,
        duration,
        now,
      );
      oscillator.connect(envelope);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.02);
      vibrato.start(now);
      vibrato.stop(now + duration + 0.02);
      scheduleCleanup(
        [oscillator, vibrato, vibratoDepth, envelope],
        duration + 0.05,
      );
      // A thin layer of breathy noise gives the "whoa" some body.
      playFilteredNoise(handles, {
        filterType: 'bandpass',
        freqFrom: 900,
        q: 1,
        peak: 0.04,
        attack: 0.01,
        duration: duration * 0.8,
      });
    } catch {
      // Reaction sounds are cosmetic.
    }
  }

  function crunch(kind: CrunchKind): void {
    try {
      if (!soundEnabled) return;
      const handles = ensureContext();
      if (!handles) return;
      if (!canPlayOneShot(handles.context, 'crunch', RATE_LIMITS.crunch))
        return;
      const spec = CRUNCH_SPECS[kind];
      if (!allocateVoice(handles.context, spec.duration + 0.05)) return;
      playFilteredNoise(handles, {
        filterType: spec.filterType,
        freqFrom: spec.freq,
        q: spec.q,
        peak: spec.peak,
        attack: 0.004,
        duration: spec.duration,
      });
      if (spec.tone) {
        playTone(handles, {
          type: spec.tone.type,
          freqFrom: spec.tone.freqFrom,
          freqTo: spec.tone.freqTo,
          peak: spec.tone.peak,
          attack: 0.003,
          duration: spec.tone.duration,
        });
      }
      if (spec.clatter) {
        // A few staggered, fading noise taps for a rattly can-tumbling
        // feel, instead of one flat knock.
        for (let index = 0; index < spec.clatter; index += 1) {
          const delaySeconds = 0.05 + index * (0.04 + Math.random() * 0.03);
          const fade = 1 - index / spec.clatter;
          window.setTimeout(() => {
            try {
              playFilteredNoise(handles, {
                filterType: 'bandpass',
                freqFrom: spec.freq * (0.8 + Math.random() * 0.4),
                q: spec.q * 0.7,
                peak: spec.peak * 0.5 * fade,
                attack: 0.003,
                duration: 0.08,
              });
            } catch {
              // A dropped clatter tap is inaudible either way.
            }
          }, delaySeconds * 1000);
        }
      }
    } catch {
      // Prop destruction feedback is cosmetic; never let it throw.
    }
  }

  function chime(): void {
    try {
      if (!soundEnabled) return;
      const handles = ensureContext();
      if (!handles) return;
      if (!canPlayOneShot(handles.context, 'chime', RATE_LIMITS.chime)) return;
      if (!allocateVoice(handles.context, 0.8)) return;
      const { context, master } = handles;
      const notes = [660, 880]; // a rising two-note bell figure
      notes.forEach((base, index) => {
        const startTime = context.currentTime + index * 0.14;
        const envelope = createEnvelope(
          context,
          master,
          0.18,
          0.01,
          0.55,
          startTime,
        );
        const cleanupNodes: AudioNode[] = [envelope];
        // Fundamental plus two harmonics, each quieter than the last, to
        // read as a bell rather than a plain sine beep.
        [1, 2, 3].forEach((partial) => {
          const oscillator = context.createOscillator();
          oscillator.type = 'sine';
          oscillator.frequency.value = base * partial;
          const partialGain = context.createGain();
          partialGain.gain.value = 1 / (partial * 2);
          oscillator.connect(partialGain).connect(envelope);
          oscillator.start(startTime);
          oscillator.stop(startTime + 0.58);
          cleanupNodes.push(oscillator, partialGain);
        });
        scheduleCleanup(cleanupNodes, index * 0.14 + 0.6);
      });
    } catch {
      // A missed chime should never block quest logic.
    }
  }

  function coin(): void {
    try {
      if (!soundEnabled) return;
      const handles = ensureContext();
      if (!handles) return;
      if (!canPlayOneShot(handles.context, 'coin', RATE_LIMITS.coin)) return;
      if (!allocateVoice(handles.context, 0.15)) return;
      const { context, master } = handles;
      const now = context.currentTime;
      const oscillator = context.createOscillator();
      oscillator.type = 'square';
      // A discrete two-step upward jump reads as a bright blip rather than
      // a slide.
      oscillator.frequency.setValueAtTime(880, now);
      oscillator.frequency.setValueAtTime(1320, now + 0.05);
      const envelope = createEnvelope(context, master, 0.14, 0.006, 0.12, now);
      oscillator.connect(envelope);
      oscillator.start(now);
      oscillator.stop(now + 0.14);
      scheduleCleanup([oscillator, envelope], 0.16);
    } catch {
      // Collectible feedback is cosmetic.
    }
  }

  function grab(): void {
    try {
      if (!soundEnabled) return;
      const handles = ensureContext();
      if (!handles) return;
      if (!canPlayOneShot(handles.context, 'grab', RATE_LIMITS.grab)) return;
      if (!allocateVoice(handles.context, 0.1)) return;
      playTone(handles, {
        type: 'triangle',
        freqFrom: 500,
        freqTo: 180,
        peak: 0.12,
        attack: 0.003,
        duration: 0.08,
      });
    } catch {
      // A missed pluck should never block a grab.
    }
  }

  function cheer(): void {
    try {
      if (!soundEnabled) return;
      const handles = ensureContext();
      if (!handles) return;
      if (!canPlayOneShot(handles.context, 'cheer', RATE_LIMITS.cheer)) return;
      const duration = 0.4;
      if (!allocateVoice(handles.context, duration + 0.05)) return;
      // Two stacked formants over noise read as a shouted "hey" without
      // needing a real vocal sample.
      playFilteredNoise(handles, {
        filterType: 'bandpass',
        freqFrom: 800,
        q: 3,
        peak: 0.14,
        attack: 0.02,
        duration,
      });
      playFilteredNoise(handles, {
        filterType: 'bandpass',
        freqFrom: 1900,
        q: 4,
        peak: 0.06,
        attack: 0.02,
        duration: duration * 0.8,
      });
    } catch {
      // Celebration sounds are cosmetic.
    }
  }

  function setAmbient(input: AmbientInput): void {
    try {
      if (!ambientEnabled) return; // already silenced by setEnabled
      const context = audioContext;
      if (!context || !ambient) return; // not unlocked yet
      if (input.paused) {
        applyAmbient(
          context,
          ambientTargets.windFreq,
          0,
          0,
          0,
          AMBIENT_PAUSE_TIME_CONSTANT,
        );
        return;
      }
      const speed = Math.max(0, input.speed);
      const agl = Math.max(0, input.agl);
      const speedFactor = clamp01(speed / WIND_FULL_SPEED);
      const aglFactor = clamp01(agl / WIND_FULL_AGL);
      const windFactor = clamp01(speedFactor * 0.7 + aglFactor * 0.3);
      const windFreq =
        WIND_MIN_FREQ + windFactor * (WIND_MAX_FREQ - WIND_MIN_FREQ);
      const windGainTarget = windFactor * WIND_MAX_GAIN;
      const humGainTarget = input.mode === 'waddling' ? HUM_GAIN : 0;
      const onWater = input.mode === 'swimming' || input.mode === 'planing';
      const waterGainTarget = onWater
        ? WATER_GAIN * (0.6 + 0.4 * clamp01(speed / WATER_FULL_SPEED))
        : 0;
      applyAmbient(
        context,
        windFreq,
        windGainTarget,
        humGainTarget,
        waterGainTarget,
        AMBIENT_TIME_CONSTANT,
      );
    } catch {
      // Ambient is a bonus layer; never let it break the frame loop.
    }
  }

  function dispose(): void {
    try {
      if (ambient) {
        ambient.windSource.stop();
        ambient.humOsc.stop();
        ambient.waterSource.stop();
        ambient.waterLfo.stop();
        [
          ambient.windSource,
          ambient.windFilter,
          ambient.windGain,
          ambient.humOsc,
          ambient.humGain,
          ambient.waterSource,
          ambient.waterFilter,
          ambient.waterGain,
          ambient.waterLfo,
          ambient.waterLfoDepth,
        ].forEach((node) => node.disconnect());
      }
    } catch {
      // Nodes may already be stopped or disconnected; ignore.
    }
    try {
      masterGain?.disconnect();
    } catch {
      // Ignore; the context is going away regardless.
    }
    try {
      void audioContext?.close();
    } catch {
      // Ignore; nothing left to clean up if close fails.
    }
    audioContext = null;
    masterGain = null;
    ambient = null;
    noiseBuffer = null;
    ambientTargets = { windFreq: -1, windGain: -1, humGain: -1, waterGain: -1 };
    lastPlayedAt.clear();
    activeVoiceEnds.length = 0;
  }

  return {
    unlock,
    setEnabled,
    honk,
    flap,
    thud,
    splash,
    skim,
    screech,
    yelp,
    crunch,
    chime,
    coin,
    grab,
    cheer,
    setAmbient,
    dispose,
  };
}
