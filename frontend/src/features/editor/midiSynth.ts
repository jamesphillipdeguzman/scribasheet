import { midiToFreq } from "@/lib/utils";
import type { ScoreNote } from "@/types/api";

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

  public triggerNote(pitchMidi: number, durationSec = 0.35, velocity = 85, volume = 0.7) {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const freq = midiToFreq(pitchMidi);
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, now);
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(freq * 2, now);

    const peakGain = Math.max(0.02, (velocity / 127) * 0.22 * volume);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.08, durationSec));

    osc.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc2.start(now);
    osc.stop(now + Math.max(0.09, durationSec) + 0.02);
    osc2.stop(now + Math.max(0.09, durationSec) + 0.02);

    const handle = {
      stop: () => {
        try {
          osc.stop();
          osc2.stop();
        } catch {
          // already stopped
        }
      },
    };
    this.activeOscs.add(handle);
    osc.onended = () => this.activeOscs.delete(handle);
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
      options.notes.reduce((m, n) => Math.max(m, n.offset_sec), 0) + 0.25
    );
    const secPerBeat = 60 / Math.max(20, options.tempoBpm);

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
          currentSec = 0;
        } else {
          this.stop();
          options.onPosition(0);
          options.onEnd();
          return;
        }
      }

      options.onPosition(currentSec);

      // Schedule notes whose onset falls in the current frame window
      for (const note of options.notes) {
        if (
          !this.scheduledNotes.has(note.id) &&
          note.onset_sec >= currentSec - 0.03 &&
          note.onset_sec <= currentSec + 0.04
        ) {
          this.scheduledNotes.add(note.id);
          const dur = (note.offset_sec - note.onset_sec) / options.playbackRate;
          this.triggerNote(note.pitch_midi, dur, note.velocity, options.volume);
        }
      }

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
