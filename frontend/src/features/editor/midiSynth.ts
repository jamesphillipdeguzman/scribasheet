import { Soundfont, SplendidGrandPiano } from "smplr";
import { metronomeEngine } from "@/features/editor/metronome";
import { midiToFreq } from "@/lib/utils";
import type { ScoreNote } from "@/types/api";

export const GM_INSTRUMENT_PRESETS = [
  { program: 0, label: "Acoustic Grand Piano", soundfontName: "acoustic_grand_piano" },
  { program: 4, label: "Electric Piano", soundfontName: "electric_piano_1" },
  { program: 48, label: "String Ensemble", soundfontName: "string_ensemble_1" },
  { program: 52, label: "Choir Aahs", soundfontName: "choir_aahs" },
] as const;

function programToSoundfontName(program: number): string {
  const match = GM_INSTRUMENT_PRESETS.find((p) => p.program === program);
  return match ? match.soundfontName : "acoustic_grand_piano";
}

export interface PianoEnvelopeParams {
  peakGain: number;
  sustainGain: number;
  attackSec: number;
  holdEndSec: number;
  releaseSec: number;
  filterCutoffHz: number;
}

export function computePianoEnvelopeParams(
  pitchMidi: number,
  durationSec = 0.35,
  velocity = 85,
  volume = 0.7
): PianoEnvelopeParams {
  const clampedVel = Math.max(1, Math.min(127, velocity));
  const velNorm = clampedVel / 127;
  const clampedVol = Math.max(0, Math.min(1.5, volume));
  const freq = midiToFreq(pitchMidi);

  const peakGain = Math.max(0.025, Math.pow(velNorm, 1.1) * 0.32 * clampedVol);
  const attackSec = 0.008;
  const holdEndSec = Math.max(0.06, durationSec);
  // Natural string decay during the held note without collapsing mid-note
  const decayFactor = Math.max(0.38, 0.75 - 0.12 * Math.min(2.5, holdEndSec));
  const sustainGain = Math.max(0.01, peakGain * decayFactor);
  // Piano damper release tail after Note-Off
  const releaseSec = Math.min(0.26, Math.max(0.14, 0.15 + holdEndSec * 0.04));
  const filterCutoffHz = Math.min(10000, Math.max(300, freq * (2.5 + 5.5 * velNorm)));

  return {
    peakGain,
    sustainGain,
    attackSec,
    holdEndSec,
    releaseSec,
    filterCutoffHz,
  };
}

export class MidiSynthesizer {
  private ctx: AudioContext | null = null;
  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private pianoSampler: SplendidGrandPiano | null = null;
  private pianoLoaded = false;
  private sfSamplers = new Map<number, { inst: Soundfont; loaded: boolean }>();
  private activeOscs: Set<{ stop: () => void }> = new Set();
  private sustainedVoices: Map<number, { release: () => void }> = new Map();
  private rafId: number | null = null;
  private isPlaying = false;
  private startPerfMs = 0;
  private startOffsetSec = 0;
  private currentPlaybackRate = 1;
  private scheduledNotes = new Set<string>();
  private lastBeatTick = -1;

  public getPlaybackClock(): { isPlaying: boolean; currentSec: number } {
    if (!this.isPlaying) {
      return { isPlaying: false, currentSec: this.startOffsetSec };
    }
    const elapsed = ((performance.now() - this.startPerfMs) / 1000) * this.currentPlaybackRate;
    return { isPlaying: true, currentSec: this.startOffsetSec + elapsed };
  }

  private setupOutputBus(ctx: AudioContext) {
    if (this.dryGain) return;
    const dry = ctx.createGain();
    dry.gain.value = 0.88;
    dry.connect(ctx.destination);
    this.dryGain = dry;

    if (typeof ctx.createConvolver === "function" && typeof ctx.createBuffer === "function") {
      try {
        const len = Math.floor(ctx.sampleRate * 1.15);
        const impulse = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          const data = impulse.getChannelData(ch);
          for (let i = 0; i < len; i++) {
            const decay = Math.pow(1 - i / len, 2.8);
            data[i] = (Math.random() * 2 - 1) * decay * 0.28;
          }
        }
        const conv = ctx.createConvolver();
        conv.buffer = impulse;
        const wet = ctx.createGain();
        wet.gain.value = 0.16;
        conv.connect(wet);
        wet.connect(ctx.destination);
        this.convolver = conv;
        this.wetGain = wet;
      } catch {
        // Ignore convolver errors in restricted environments
      }
    }
  }

  private getOutputNode(ctx: AudioContext): AudioNode {
    this.setupOutputBus(ctx);
    return this.dryGain || ctx.destination;
  }

  private connectWithReverb(ctx: AudioContext, node: AudioNode) {
    const out = this.getOutputNode(ctx);
    node.connect(out);
    if (this.convolver) {
      node.connect(this.convolver);
    }
  }

  private ensureSampler(ctx: AudioContext, program = 0) {
    if (typeof fetch !== "function") return;
    const dest = this.getOutputNode(ctx);
    if (program === 0) {
      if (!this.pianoSampler) {
        try {
          const piano = new SplendidGrandPiano(ctx, { destination: dest });
          this.pianoSampler = piano;
          void piano.load.then(() => {
            this.pianoLoaded = true;
          }).catch(() => {});
        } catch {
          // Fallback to WebAudio synth
        }
      }
      return;
    }

    if (!this.sfSamplers.has(program)) {
      try {
        const sf = new Soundfont(ctx, {
          instrument: programToSoundfontName(program),
          destination: dest,
        });
        const entry = { inst: sf, loaded: false };
        this.sfSamplers.set(program, entry);
        void sf.load.then(() => {
          entry.loaded = true;
        }).catch(() => {});
      } catch {
        // Fallback to WebAudio synth
      }
    }
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    this.setupOutputBus(this.ctx);
    this.ensureSampler(this.ctx, 0);
    return this.ctx;
  }

  public triggerNote(
    pitchMidi: number,
    durationSec = 0.35,
    velocity = 85,
    volume = 0.7,
    startDelaySec = 0,
    program = 0
  ) {
    const ctx = this.ensureContext();
    this.ensureSampler(ctx, program);
    const startAt = ctx.currentTime + Math.max(0, startDelaySec);
    const clampedVel = Math.max(1, Math.min(127, Math.round(velocity)));
    const scaledVel = Math.max(1, Math.min(127, Math.round(clampedVel * Math.max(0.1, Math.min(1.4, volume)))));
    const holdSec = Math.max(0.06, durationSec);

    if (program === 0 && this.pianoSampler && this.pianoLoaded) {
      const stopFn = this.pianoSampler.start({
        note: pitchMidi,
        velocity: scaledVel,
        time: startAt,
        duration: holdSec,
      });
      const handle = { stop: () => { try { stopFn(); } catch { /* ignore */ } } };
      this.activeOscs.add(handle);
      window.setTimeout(() => this.activeOscs.delete(handle), Math.ceil((startDelaySec + holdSec + 0.5) * 1000));
      return;
    }

    const sfEntry = this.sfSamplers.get(program);
    if (sfEntry && sfEntry.loaded) {
      const stopFn = sfEntry.inst.start({
        note: pitchMidi,
        velocity: scaledVel,
        time: startAt,
        duration: holdSec,
      });
      const handle = { stop: () => { try { stopFn(); } catch { /* ignore */ } } };
      this.activeOscs.add(handle);
      window.setTimeout(() => this.activeOscs.delete(handle), Math.ceil((startDelaySec + holdSec + 0.5) * 1000));
      return;
    }

    const freq = midiToFreq(pitchMidi);
    const env = computePianoEnvelopeParams(pitchMidi, durationSec, velocity, volume);

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const osc3 = ctx.createOscillator();
    const harm2Gain = ctx.createGain();
    const harm3Gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const masterGain = ctx.createGain();

    osc1.type = "triangle";
    osc1.frequency.setValueAtTime(freq, startAt);
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(freq * 2, startAt);
    osc3.type = "sine";
    osc3.frequency.setValueAtTime(freq * 3, startAt);

    harm2Gain.gain.setValueAtTime(0.32, startAt);
    harm3Gain.gain.setValueAtTime(0.10, startAt);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(env.filterCutoffHz, startAt);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(220, env.filterCutoffHz * 0.45),
      startAt + env.holdEndSec
    );

    const noteOffAt = startAt + env.holdEndSec;
    const stopAt = noteOffAt + env.releaseSec + 0.02;

    masterGain.gain.setValueAtTime(0.0001, startAt);
    masterGain.gain.linearRampToValueAtTime(env.peakGain, startAt + env.attackSec);
    masterGain.gain.exponentialRampToValueAtTime(
      env.sustainGain,
      Math.max(startAt + env.attackSec + 0.01, noteOffAt)
    );
    masterGain.gain.exponentialRampToValueAtTime(0.0001, noteOffAt + env.releaseSec);

    osc1.connect(filter);
    osc2.connect(harm2Gain);
    harm2Gain.connect(filter);
    osc3.connect(harm3Gain);
    harm3Gain.connect(filter);
    filter.connect(masterGain);
    this.connectWithReverb(ctx, masterGain);

    osc1.start(startAt);
    osc2.start(startAt);
    osc3.start(startAt);
    osc1.stop(stopAt);
    osc2.stop(stopAt);
    osc3.stop(stopAt);

    const handle = {
      stop: () => {
        try {
          osc1.stop();
          osc2.stop();
          osc3.stop();
        } catch {
          // already stopped
        }
      },
    };
    this.activeOscs.add(handle);
    osc1.onended = () => this.activeOscs.delete(handle);
  }

  public startSustainedNote(pitchMidi: number, velocity = 85, volume = 0.7, program = 0) {
    // Stop any previous voice on the same pitch cleanly to avoid stuck notes
    this.stopSustainedNote(pitchMidi);
    const ctx = this.ensureContext();
    this.ensureSampler(ctx, program);
    const clampedVel = Math.max(1, Math.min(127, Math.round(velocity * Math.max(0.1, Math.min(1.4, volume)))));

    if (program === 0 && this.pianoSampler && this.pianoLoaded) {
      const stopSampler = this.pianoSampler.start({ note: pitchMidi, velocity: clampedVel });
      const handle = { stop: () => { try { stopSampler(); } catch { /* ignore */ } } };
      this.activeOscs.add(handle);
      this.sustainedVoices.set(pitchMidi, {
        release: () => {
          this.activeOscs.delete(handle);
          handle.stop();
        },
      });
      return;
    }

    const startAt = ctx.currentTime;
    const freq = midiToFreq(pitchMidi);
    const env = computePianoEnvelopeParams(pitchMidi, 2.0, velocity, volume);

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const osc3 = ctx.createOscillator();
    const harm2Gain = ctx.createGain();
    const harm3Gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const masterGain = ctx.createGain();

    osc1.type = "triangle";
    osc1.frequency.setValueAtTime(freq, startAt);
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(freq * 2, startAt);
    osc3.type = "sine";
    osc3.frequency.setValueAtTime(freq * 3, startAt);

    harm2Gain.gain.setValueAtTime(0.32, startAt);
    harm3Gain.gain.setValueAtTime(0.10, startAt);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(env.filterCutoffHz, startAt);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(220, env.filterCutoffHz * 0.45),
      startAt + 1.5
    );

    masterGain.gain.setValueAtTime(0.0001, startAt);
    masterGain.gain.linearRampToValueAtTime(env.peakGain, startAt + env.attackSec);
    masterGain.gain.exponentialRampToValueAtTime(env.sustainGain, startAt + 0.35);

    osc1.connect(filter);
    osc2.connect(harm2Gain);
    harm2Gain.connect(filter);
    osc3.connect(harm3Gain);
    harm3Gain.connect(filter);
    filter.connect(masterGain);
    this.connectWithReverb(ctx, masterGain);

    osc1.start(startAt);
    osc2.start(startAt);
    osc3.start(startAt);

    let released = false;
    const stopAll = () => {
      try {
        osc1.stop();
        osc2.stop();
        osc3.stop();
      } catch {
        // already stopped
      }
    };
    const handle = { stop: stopAll };
    this.activeOscs.add(handle);
    osc1.onended = () => this.activeOscs.delete(handle);

    this.sustainedVoices.set(pitchMidi, {
      release: () => {
        if (released) return;
        released = true;
        const now = ctx.currentTime;
        try {
          masterGain.gain.cancelScheduledValues(now);
          masterGain.gain.setValueAtTime(Math.max(0.0001, masterGain.gain.value), now);
          masterGain.gain.exponentialRampToValueAtTime(0.0001, now + env.releaseSec);
          const stopAt = now + env.releaseSec + 0.03;
          osc1.stop(stopAt);
          osc2.stop(stopAt);
          osc3.stop(stopAt);
        } catch {
          stopAll();
        }
      },
    });
  }

  public stopSustainedNote(pitchMidi: number) {
    const voice = this.sustainedVoices.get(pitchMidi);
    if (voice) {
      this.sustainedVoices.delete(pitchMidi);
      voice.release();
    }
  }

  public stopAllSustainedNotes() {
    for (const [pitch, voice] of this.sustainedVoices.entries()) {
      this.sustainedVoices.delete(pitch);
      voice.release();
    }
  }

  public playMetronomeClick(accent = false, volume = 0.7) {
    metronomeEngine.playSingleClick(accent, volume);
  }

  public start(options: {
    notes: ScoreNote[];
    fromSec: number;
    durationSec: number;
    tempoBpm: number;
    playbackRate: number;
    volume: number;
    loop: boolean;
    metronome: boolean;
    trackPrograms?: Record<number, number>;
    trackVolumes?: Record<number, number>;
    onPosition: (sec: number) => void;
    onEnd: () => void;
  }) {
    this.stop();
    this.ensureContext();
    this.isPlaying = true;
    this.startPerfMs = performance.now();
    this.startOffsetSec = options.fromSec;
    this.currentPlaybackRate = options.playbackRate || 1;
    this.scheduledNotes.clear();
    this.lastBeatTick = -1;

    const totalDur = Math.max(
      options.durationSec,
      options.notes.reduce((m, n) => Math.max(m, n.offset_sec), 0) + 0.35
    );
    const secPerBeat = 60 / Math.max(20, options.tempoBpm);
    let prevSec = options.fromSec - 0.01;

    const tick = () => {
      if (!this.isPlaying) return;
      const elapsedSec = ((performance.now() - this.startPerfMs) / 1000) * options.playbackRate;
      let currentSec = this.startOffsetSec + elapsedSec;

      if (currentSec >= totalDur) {
        if (options.loop && totalDur > 0.2) {
          this.startPerfMs = performance.now();
          this.startOffsetSec = 0;
          this.scheduledNotes.clear();
          this.lastBeatTick = -1;
          prevSec = -0.01;
          currentSec = 0;
        } else {
          this.stop();
          options.onPosition(0);
          options.onEnd();
          return;
        }
      }

      options.onPosition(currentSec);

      // Schedule notes in [prevSec, currentSec + 0.05] with sub-frame AudioContext offset
      const lookaheadSec = currentSec + 0.05;
      for (const note of options.notes) {
        if (
          !this.scheduledNotes.has(note.id) &&
          note.onset_sec >= prevSec &&
          note.onset_sec <= lookaheadSec
        ) {
          this.scheduledNotes.add(note.id);
          const dur = Math.max(0.05, (note.offset_sec - note.onset_sec) / options.playbackRate);
          const delay = Math.max(0, (note.onset_sec - currentSec) / options.playbackRate);
          const prog = options.trackPrograms?.[note.track_index] ?? 0;
          const tVol = options.trackVolumes?.[note.track_index] ?? 1.0;
          this.triggerNote(note.pitch_midi, dur, note.velocity, options.volume * tVol, delay, prog);
        }
      }
      prevSec = currentSec;

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  public stop() {
    this.isPlaying = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.activeOscs.forEach((o) => o.stop());
    this.activeOscs.clear();
  }
}

export const midiSynth = new MidiSynthesizer();
