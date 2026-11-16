import { midiToFreq } from "@/lib/utils";
import type { ScoreNote } from "@/types/api";

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
  private activeOscs: Set<{ stop: () => void }> = new Set();
  private rafId: number | null = null;
  private isPlaying = false;
  private startPerfMs = 0;
  private startOffsetSec = 0;
  private scheduledNotes = new Set<string>();
  private lastBeatTick = -1;

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
    return this.ctx;
  }

  public triggerNote(
    pitchMidi: number,
    durationSec = 0.35,
    velocity = 85,
    volume = 0.7,
    startDelaySec = 0
  ) {
    const ctx = this.ensureContext();
    const startAt = ctx.currentTime + Math.max(0, startDelaySec);
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
    masterGain.connect(ctx.destination);

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

  private triggerMetronomeClick(accent: boolean, volume: number) {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(accent ? 1200 : 850, now);
    gain.gain.setValueAtTime(0.15 * volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
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
    onPosition: (sec: number) => void;
    onEnd: () => void;
  }) {
    this.stop();
    this.ensureContext();
    this.isPlaying = true;
    this.startPerfMs = performance.now();
    this.startOffsetSec = options.fromSec;
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
          this.triggerNote(note.pitch_midi, dur, note.velocity, options.volume, delay);
        }
      }
      prevSec = currentSec;

      if (options.metronome) {
        const beatIdx = Math.floor(currentSec / secPerBeat);
        if (beatIdx !== this.lastBeatTick) {
          this.lastBeatTick = beatIdx;
          this.triggerMetronomeClick(beatIdx % 4 === 0, options.volume);
        }
      }

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
