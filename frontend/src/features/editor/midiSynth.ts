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

const MAX_VOICES_PER_BURST_WINDOW = 8;
const BURST_WINDOW_SEC = 0.005;
const STALE_NOTE_TOLERANCE_SEC = 0.08;

export class MidiSynthesizer {
  private ctx: AudioContext | null = null;
  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  private masterGainBus: GainNode | null = null;
  private liveGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private convolver: ConvolverNode | null = null;
  private pianoSampler: SplendidGrandPiano | null = null;
  private pianoLoaded = false;
  private pianoLoadFailed = false;
  private pianoLoadPromise: Promise<boolean> | null = null;
  private sfSamplers = new Map<
    number,
    { inst: Soundfont; loaded: boolean; failed: boolean; loadPromise: Promise<boolean> }
  >();
  private activeOscs: Set<{ stop: () => void }> = new Set();
  private sustainedVoices: Map<number, { release: () => void }> = new Map();
  private wakeScheduledForCtx = new WeakSet<AudioContext>();
  private sustainPedalDown = false;
  private pedalDeferredNotes = new Set<number>();
  private lastLiveScheduleMs: number | null = null;
  private lastAudioContextLatencyHint: string | null = null;
  private rafId: number | null = null;
  private isPlaying = false;
  private startPerfMs = 0;
  private startOffsetSec = 0;
  private currentPlaybackRate = 1;
  private scheduledNotes = new Set<string>();
  private activeSortedNotes: ScoreNote[] = [];
  private nextNoteIndex = 0;
  private lastScheduledSongTime = 0;
  private lastBeatTick = -1;
  private startToken = 0;
  private sessionAllowPianoSampler = true;
  private sessionAllowSfSamplers = new Set<number>();
  private gestureListenersAttached = false;
  private visibilityListenerAttached = false;

  public getPlaybackClock(): { isPlaying: boolean; currentSec: number } {
    if (!this.isPlaying) {
      return { isPlaying: false, currentSec: this.startOffsetSec };
    }
    const elapsed = ((performance.now() - this.startPerfMs) / 1000) * this.currentPlaybackRate;
    return { isPlaying: true, currentSec: this.startOffsetSec + elapsed };
  }

  private setupOutputBus(ctx: AudioContext) {
    if (this.dryGain) return;

    const masterBus = ctx.createGain();
    masterBus.gain.value = 1.0;
    this.masterGainBus = masterBus;

    if (typeof ctx.createDynamicsCompressor === "function") {
      try {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -6;
        comp.knee.value = 6;
        comp.ratio.value = 12;
        comp.attack.value = 0.002;
        comp.release.value = 0.15;
        masterBus.connect(comp);
        comp.connect(ctx.destination);
        this.compressor = comp;
      } catch {
        masterBus.connect(ctx.destination);
      }
    } else {
      masterBus.connect(ctx.destination);
    }

    const dry = ctx.createGain();
    dry.gain.value = 0.88;
    dry.connect(masterBus);
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
        wet.connect(masterBus);
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

  private getLiveOutputNode(ctx: AudioContext): AudioNode {
    if (!this.liveGain) {
      const gain = ctx.createGain();
      gain.gain.value = 0.92;
      gain.connect(ctx.destination);
      this.liveGain = gain;
    }
    return this.liveGain;
  }

  private createInteractiveAudioContext(AudioCtx: typeof AudioContext): AudioContext {
    try {
      const ctx = new AudioCtx({ latencyHint: "interactive" });
      this.lastAudioContextLatencyHint = "interactive";
      return ctx;
    } catch {
      this.lastAudioContextLatencyHint = "default";
      return new AudioCtx();
    }
  }

  private wakeAudioHardware(ctx: AudioContext) {
    if (this.wakeScheduledForCtx.has(ctx)) return;
    this.wakeScheduledForCtx.add(ctx);
    if (typeof ctx.createBuffer !== "function" || typeof ctx.createBufferSource !== "function") {
      return;
    }
    try {
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate || 48000);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.getLiveOutputNode(ctx));
      src.start(ctx.currentTime);
    } catch {
      // Ignore silent wake errors in restricted or mocked environments
    }
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
      if (!this.pianoSampler && !this.pianoLoadFailed) {
        try {
          const liveDest = this.getLiveOutputNode(ctx);
          const piano = new SplendidGrandPiano(ctx, { destination: liveDest });
          this.pianoSampler = piano;
          const maybeLoaded = (piano as unknown as { loaded?: () => Promise<unknown> }).loaded;
          const rawPromise =
            typeof maybeLoaded === "function" ? maybeLoaded.call(piano) : piano.load;
          this.pianoLoadPromise = Promise.resolve(rawPromise)
            .then(() => {
              this.pianoLoaded = true;
              this.pianoLoadFailed = false;
              return true;
            })
            .catch(() => {
              this.pianoLoadFailed = true;
              return false;
            });
        } catch {
          this.pianoLoadFailed = true;
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
        const entry = {
          inst: sf,
          loaded: false,
          failed: false,
          loadPromise: Promise.resolve(false),
        };
        const maybeLoaded = (sf as unknown as { loaded?: () => Promise<unknown> }).loaded;
        const rawPromise = typeof maybeLoaded === "function" ? maybeLoaded.call(sf) : sf.load;
        entry.loadPromise = Promise.resolve(rawPromise)
          .then(() => {
            entry.loaded = true;
            entry.failed = false;
            return true;
          })
          .catch(() => {
            entry.failed = true;
            return false;
          });
        this.sfSamplers.set(program, entry);
      } catch {
        // Fallback to WebAudio synth
      }
    }
  }

  private attachGestureResumeListeners() {
    if (this.gestureListenersAttached || typeof window === "undefined") return;
    this.gestureListenersAttached = true;

    const events = ["pointerdown", "keydown", "touchstart"] as const;
    const cleanup = () => {
      for (const evt of events) {
        window.removeEventListener(evt, onGesture);
      }
      this.gestureListenersAttached = false;
    };
    const onGesture = () => {
      if (!this.ctx) return;
      if (this.ctx.state === "suspended") {
        void this.ctx
          .resume()
          .then(() => {
            if (this.ctx?.state === "running") cleanup();
          })
          .catch(() => {});
      } else if (this.ctx.state === "running") {
        cleanup();
      }
    };

    for (const evt of events) {
      window.addEventListener(evt, onGesture, { passive: true });
    }
  }

  private handleVisibilityChange = () => {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    if (!this.isPlaying || !this.ctx) return;

    const { currentSec } = this.getPlaybackClock();
    const rate = this.currentPlaybackRate || 1;
    const ctxNow = this.ctx.currentTime;

    while (this.nextNoteIndex < this.activeSortedNotes.length) {
      const note = this.activeSortedNotes[this.nextNoteIndex];
      const noteStartAudioTime = ctxNow + (note.onset_sec - currentSec) / rate;
      if (noteStartAudioTime < ctxNow - STALE_NOTE_TOLERANCE_SEC) {
        this.scheduledNotes.add(note.id);
        this.nextNoteIndex += 1;
      } else {
        break;
      }
    }
    this.lastScheduledSongTime = Math.max(this.lastScheduledSongTime, currentSec);

    if (this.ctx.state === "suspended") {
      this.attachGestureResumeListeners();
    }
  };

  private attachVisibilityListener() {
    if (this.visibilityListenerAttached || typeof document === "undefined") return;
    this.visibilityListenerAttached = true;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private detachVisibilityListener() {
    if (!this.visibilityListenerAttached || typeof document === "undefined") return;
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.visibilityListenerAttached = false;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = this.createInteractiveAudioContext(AudioCtx);
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }
    this.attachGestureResumeListeners();
    this.attachVisibilityListener();
    this.setupOutputBus(this.ctx);
    this.ensureSampler(this.ctx, 0);
    return this.ctx;
  }

  public preloadPiano(): void {
    if (typeof window === "undefined") return;
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      if (!this.ctx) {
        this.ctx = this.createInteractiveAudioContext(AudioCtx);
      }
      this.attachGestureResumeListeners();
      this.attachVisibilityListener();
      this.setupOutputBus(this.ctx);
      this.getLiveOutputNode(this.ctx);
      this.ensureSampler(this.ctx, 0);
    } catch {
      // Ignore in restricted environments
    }
  }

  public async prepareLiveMidi(): Promise<void> {
    if (typeof window === "undefined") return;
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      if (!this.ctx) {
        this.ctx = this.createInteractiveAudioContext(AudioCtx);
      }
      this.attachGestureResumeListeners();
      this.attachVisibilityListener();
      if (this.ctx.state === "suspended") {
        await this.ctx.resume().catch(() => {});
      }
      this.getLiveOutputNode(this.ctx);
      this.wakeAudioHardware(this.ctx);
      this.setupOutputBus(this.ctx);
      this.ensureSampler(this.ctx, 0);
    } catch {
      // Ignore in restricted environments
    }
  }

  public isPianoReady(): boolean {
    return this.pianoLoaded;
  }

  public needsSamplerWait(programs: number[] = [0]): boolean {
    const unique = programs.length > 0 ? Array.from(new Set(programs)) : [0];
    for (const prog of unique) {
      if (prog === 0) {
        if (this.pianoLoadPromise !== null && !this.pianoLoaded && !this.pianoLoadFailed) {
          return true;
        }
      } else {
        const entry = this.sfSamplers.get(prog);
        if (entry && !entry.loaded && !entry.failed) {
          return true;
        }
      }
    }
    return false;
  }

  public async loaded(programs: number[] = [0]): Promise<boolean> {
    try {
      const ctx = this.ensureContext();
      const unique = programs.length > 0 ? Array.from(new Set(programs)) : [0];
      const waits: Promise<boolean>[] = [];
      for (const prog of unique) {
        this.ensureSampler(ctx, prog);
        if (prog === 0) {
          if (this.pianoLoadPromise && !this.pianoLoaded && !this.pianoLoadFailed) {
            waits.push(this.pianoLoadPromise);
          }
        } else {
          const entry = this.sfSamplers.get(prog);
          if (entry && !entry.loaded && !entry.failed) {
            waits.push(entry.loadPromise);
          }
        }
      }
      if (waits.length > 0) {
        await Promise.all(waits);
      }
    } catch {
      // Ignore in restricted environments
    }
    return this.pianoLoaded;
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

    const allowPiano = !this.isPlaying || this.sessionAllowPianoSampler;
    if (program === 0 && allowPiano && this.pianoSampler && this.pianoLoaded) {
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
    const allowSf = !this.isPlaying || this.sessionAllowSfSamplers.has(program);
    if (sfEntry && allowSf && sfEntry.loaded) {
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

  private releaseSustainedVoiceImmediate(pitchMidi: number) {
    this.pedalDeferredNotes.delete(pitchMidi);
    const voice = this.sustainedVoices.get(pitchMidi);
    if (voice) {
      this.sustainedVoices.delete(pitchMidi);
      voice.release();
    }
  }

  public startSustainedNote(pitchMidi: number, velocity = 85, volume = 0.7, program = 0) {
    const scheduleStartMs = typeof performance !== "undefined" ? performance.now() : 0;
    // Stop any previous voice on the same pitch cleanly to avoid stuck notes
    this.releaseSustainedVoiceImmediate(pitchMidi);
    const ctx = this.ctx && this.ctx.state === "running" ? this.ctx : this.ensureContext();
    if (program !== 0 || (!this.pianoSampler && !this.pianoLoadFailed)) {
      this.ensureSampler(ctx, program);
    }
    const clampedVel = Math.max(1, Math.min(127, Math.round(velocity * Math.max(0.1, Math.min(1.4, volume)))));

    if (program === 0 && this.pianoSampler && this.pianoLoaded) {
      const stopSampler = this.pianoSampler.start({
        note: pitchMidi,
        velocity: clampedVel,
        time: ctx.currentTime,
      });
      if (typeof performance !== "undefined") {
        this.lastLiveScheduleMs = Math.max(0, performance.now() - scheduleStartMs);
      }
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
    const liveAttackSec = 0.004;

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
    masterGain.gain.linearRampToValueAtTime(env.peakGain, startAt + liveAttackSec);
    masterGain.gain.exponentialRampToValueAtTime(env.sustainGain, startAt + 0.35);

    osc1.connect(filter);
    osc2.connect(harm2Gain);
    harm2Gain.connect(filter);
    osc3.connect(harm3Gain);
    harm3Gain.connect(filter);
    filter.connect(masterGain);
    // Live monitor oscillators route straight to ctx.destination, bypassing compressor lookahead & convolver
    masterGain.connect(this.getLiveOutputNode(ctx));

    osc1.start(startAt);
    osc2.start(startAt);
    osc3.start(startAt);

    if (typeof performance !== "undefined") {
      this.lastLiveScheduleMs = Math.max(0, performance.now() - scheduleStartMs);
    }

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

  public setSustainPedal(down: boolean) {
    this.sustainPedalDown = down;
    if (!down && this.pedalDeferredNotes.size > 0) {
      const toRelease = Array.from(this.pedalDeferredNotes);
      this.pedalDeferredNotes.clear();
      for (const pitch of toRelease) {
        this.releaseSustainedVoiceImmediate(pitch);
      }
    }
  }

  public stopSustainedNote(pitchMidi: number) {
    if (this.sustainPedalDown && this.sustainedVoices.has(pitchMidi)) {
      this.pedalDeferredNotes.add(pitchMidi);
      return;
    }
    this.releaseSustainedVoiceImmediate(pitchMidi);
  }

  public stopAllSustainedNotes() {
    this.sustainPedalDown = false;
    this.pedalDeferredNotes.clear();
    for (const [pitch, voice] of this.sustainedVoices.entries()) {
      this.sustainedVoices.delete(pitch);
      voice.release();
    }
  }

  public stopAllMonitorNotes() {
    this.stopAllSustainedNotes();
  }

  public getLiveLatencyDiagnostics() {
    const extCtx = this.ctx as (AudioContext & { baseLatency?: number; outputLatency?: number }) | null;
    return {
      contextState: this.ctx?.state ?? "uninitialized",
      sampleRate: this.ctx?.sampleRate ?? null,
      baseLatencySec: extCtx?.baseLatency ?? null,
      outputLatencySec: extCtx?.outputLatency ?? null,
      latencyHint: this.lastAudioContextLatencyHint,
      pianoLoaded: this.pianoLoaded,
      lastLiveScheduleMs: this.lastLiveScheduleMs,
    };
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
  }): Promise<void> | void {
    const token = ++this.startToken;
    this.stopPlaybackOnly();
    const ctx = this.ensureContext();
    const requiredPrograms = Array.from(
      new Set([0, ...Object.values(options.trackPrograms ?? {})])
    );
    for (const prog of requiredPrograms) {
      this.ensureSampler(ctx, prog);
    }

    if (this.needsSamplerWait(requiredPrograms)) {
      return this.loaded(requiredPrograms).then(() => {
        if (token !== this.startToken) return;
        this.beginPlaybackLoop(options, requiredPrograms);
      });
    }
    this.beginPlaybackLoop(options, requiredPrograms);
  }

  private beginPlaybackLoop(
    options: {
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
    },
    requiredPrograms: number[]
  ) {
    this.sessionAllowPianoSampler = this.pianoLoaded;
    this.sessionAllowSfSamplers.clear();
    for (const prog of requiredPrograms) {
      if (prog !== 0 && this.sfSamplers.get(prog)?.loaded) {
        this.sessionAllowSfSamplers.add(prog);
      }
    }

    this.isPlaying = true;
    this.startPerfMs = performance.now();
    this.startOffsetSec = options.fromSec;
    this.currentPlaybackRate = options.playbackRate || 1;
    this.scheduledNotes.clear();
    this.lastBeatTick = -1;
    this.activeSortedNotes = [...options.notes].sort((a, b) => a.onset_sec - b.onset_sec);
    this.nextNoteIndex = 0;
    while (
      this.nextNoteIndex < this.activeSortedNotes.length &&
      this.activeSortedNotes[this.nextNoteIndex].onset_sec < options.fromSec - 0.01
    ) {
      this.nextNoteIndex += 1;
    }
    this.lastScheduledSongTime = options.fromSec;
    this.attachVisibilityListener();
    options.onPosition(options.fromSec);

    const totalDur = Math.max(
      options.durationSec,
      options.notes.reduce((m, n) => Math.max(m, n.offset_sec), 0) + 0.35
    );

    const tick = () => {
      if (!this.isPlaying) return;
      const rate = options.playbackRate || 1;
      const elapsedSec = ((performance.now() - this.startPerfMs) / 1000) * rate;
      let currentSec = this.startOffsetSec + elapsedSec;

      if (currentSec >= totalDur) {
        if (options.loop && totalDur > 0.2) {
          this.startPerfMs = performance.now();
          this.startOffsetSec = 0;
          this.scheduledNotes.clear();
          this.lastBeatTick = -1;
          this.nextNoteIndex = 0;
          this.lastScheduledSongTime = 0;
          currentSec = 0;
        } else {
          this.stop();
          options.onPosition(0);
          options.onEnd();
          return;
        }
      }

      options.onPosition(currentSec);

      const ctxNow = this.ctx ? this.ctx.currentTime : 0;
      const lookaheadSec = currentSec + 0.05;
      let windowStartAudioTime: number | null = null;
      let voicesInWindow = 0;

      while (this.nextNoteIndex < this.activeSortedNotes.length) {
        const note = this.activeSortedNotes[this.nextNoteIndex];
        if (note.onset_sec > lookaheadSec) {
          break;
        }
        if (this.scheduledNotes.has(note.id)) {
          this.nextNoteIndex += 1;
          continue;
        }

        const audioOffsetSec = (note.onset_sec - currentSec) / rate;
        const noteStartAudioTime = ctxNow + audioOffsetSec;

        // Skip overdue notes from background-tab throttling instead of firing a burst
        if (noteStartAudioTime < ctxNow - STALE_NOTE_TOLERANCE_SEC) {
          this.scheduledNotes.add(note.id);
          this.nextNoteIndex += 1;
          continue;
        }

        // Bound simultaneous voices within a 5ms scheduling window
        if (
          windowStartAudioTime === null ||
          Math.abs(noteStartAudioTime - windowStartAudioTime) > BURST_WINDOW_SEC
        ) {
          windowStartAudioTime = noteStartAudioTime;
          voicesInWindow = 0;
        }
        if (voicesInWindow >= MAX_VOICES_PER_BURST_WINDOW) {
          break;
        }

        this.scheduledNotes.add(note.id);
        this.nextNoteIndex += 1;
        voicesInWindow += 1;
        this.lastScheduledSongTime = Math.max(this.lastScheduledSongTime, note.onset_sec);

        const dur = Math.max(0.05, (note.offset_sec - note.onset_sec) / rate);
        const delay = Math.max(0, audioOffsetSec);
        const prog = options.trackPrograms?.[note.track_index] ?? 0;
        const tVol = options.trackVolumes?.[note.track_index] ?? 1.0;
        this.triggerNote(note.pitch_midi, dur, note.velocity, options.volume * tVol, delay, prog);
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private stopPlaybackOnly() {
    this.isPlaying = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.activeOscs.forEach((o) => o.stop());
    this.activeOscs.clear();
  }

  public stop() {
    this.startToken++;
    this.stopPlaybackOnly();
  }

  public dispose() {
    this.stop();
    this.stopAllSustainedNotes();
    this.detachVisibilityListener();
    for (const node of [this.dryGain, this.wetGain, this.convolver, this.masterGainBus, this.liveGain, this.compressor]) {
      try {
        node?.disconnect();
      } catch {
        // ignore
      }
    }
    this.dryGain = null;
    this.wetGain = null;
    this.convolver = null;
    this.masterGainBus = null;
    this.liveGain = null;
    this.compressor = null;
  }
}

export const midiSynth = new MidiSynthesizer();
