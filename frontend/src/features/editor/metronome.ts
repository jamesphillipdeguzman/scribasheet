import type { PlaybackMetronomeBeat } from "@/features/editor/playbackSequence";

export type MetronomeSound = "woodblock" | "studio_beep" | "stick_rimshot";
export type MetronomeSubdivision = "quarter" | "eighth";
export type MetronomeCountInBars = 0 | 1 | 2;

export interface MetronomeSettings {
  enabled: boolean;
  countInBars: MetronomeCountInBars;
  sound: MetronomeSound;
  accentBeatOne: boolean;
  subdivision: MetronomeSubdivision;
  volume: number; // 0.0 to 1.0
  timeSignatureOverride: string | null; // null = use score time signature
}

export const DEFAULT_METRONOME_SETTINGS: MetronomeSettings = {
  enabled: false,
  countInBars: 0,
  sound: "woodblock",
  accentBeatOne: true,
  subdivision: "quarter",
  volume: 0.75,
  timeSignatureOverride: null,
};

const STORAGE_KEY = "scribasheet_metronome_settings";

export function loadMetronomeSettings(): MetronomeSettings {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return { ...DEFAULT_METRONOME_SETTINGS };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_METRONOME_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<MetronomeSettings>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_METRONOME_SETTINGS.enabled,
      countInBars: parsed.countInBars === 1 || parsed.countInBars === 2 ? parsed.countInBars : 0,
      sound:
        parsed.sound === "studio_beep" || parsed.sound === "stick_rimshot"
          ? parsed.sound
          : "woodblock",
      accentBeatOne:
        typeof parsed.accentBeatOne === "boolean"
          ? parsed.accentBeatOne
          : DEFAULT_METRONOME_SETTINGS.accentBeatOne,
      subdivision: parsed.subdivision === "eighth" ? "eighth" : "quarter",
      volume:
        typeof parsed.volume === "number" && Number.isFinite(parsed.volume)
          ? Math.max(0, Math.min(1, parsed.volume))
          : DEFAULT_METRONOME_SETTINGS.volume,
      timeSignatureOverride:
        typeof parsed.timeSignatureOverride === "string" && parsed.timeSignatureOverride.includes("/")
          ? parsed.timeSignatureOverride
          : null,
    };
  } catch {
    return { ...DEFAULT_METRONOME_SETTINGS };
  }
}

export function saveMetronomeSettings(settings: MetronomeSettings): void {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota / private-mode errors
  }
}

export function parseTimeSignature(timeSignature?: string | null): { beatsPerBar: number; beatUnit: number } {
  const raw = (timeSignature || "4/4").trim();
  const [numStr, denStr] = raw.split("/");
  const num = Number.parseInt(numStr || "4", 10);
  const den = Number.parseInt(denStr || "4", 10);
  return {
    beatsPerBar: Number.isFinite(num) && num > 0 && num <= 16 ? num : 4,
    beatUnit: Number.isFinite(den) && den > 0 ? den : 4,
  };
}

export function resolveEffectiveTimeSignature(
  scoreTimeSignature?: string | null,
  override?: string | null,
): string {
  if (override && override.includes("/")) return override;
  return scoreTimeSignature && scoreTimeSignature.includes("/") ? scoreTimeSignature : "4/4";
}

export interface MetronomeClickParams {
  sound: MetronomeSound;
  isDownbeat: boolean;
  isSubdivision: boolean;
  volume: number;
}

/**
 * Lightweight Web Audio synthesizer for Woodblock, Studio Beep, and Stick/Rimshot clicks.
 * Requires zero external audio files.
 */
export function scheduleMetronomeClickNode(
  ctx: AudioContext,
  whenSec: number,
  params: MetronomeClickParams,
): { stop: () => void } | null {
  const vol = Math.max(0, Math.min(1, params.volume));
  if (vol <= 0.001) return null;

  const ampScale = params.isSubdivision ? 0.45 : params.isDownbeat ? 1.0 : 0.72;
  const peakGain = Math.max(0.005, vol * 0.42 * ampScale);
  const t0 = Math.max(ctx.currentTime, whenSec);

  if (params.sound === "stick_rimshot") {
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(params.isDownbeat ? 1850 : params.isSubdivision ? 1100 : 1420, t0);
    osc.frequency.exponentialRampToValueAtTime(380, t0 + 0.025);

    oscGain.gain.setValueAtTime(peakGain, t0);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.032);
    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.036);

    let noiseSrc: AudioBufferSourceNode | null = null;
    if (typeof ctx.createBuffer === "function" && typeof ctx.createBufferSource === "function") {
      try {
        const len = Math.max(64, Math.floor(ctx.sampleRate * 0.025));
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.25));
        }
        noiseSrc = ctx.createBufferSource();
        noiseSrc.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.setValueAtTime(params.isDownbeat ? 2600 : 2100, t0);
        filter.Q.setValueAtTime(2.2, t0);
        const nGain = ctx.createGain();
        nGain.gain.setValueAtTime(peakGain * 0.8, t0);
        nGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.025);
        noiseSrc.connect(filter);
        filter.connect(nGain);
        nGain.connect(ctx.destination);
        noiseSrc.start(t0);
        noiseSrc.stop(t0 + 0.028);
      } catch {
        // Ignore in restricted environments
      }
    }

    return {
      stop: () => {
        try {
          osc.stop();
          noiseSrc?.stop();
        } catch {
          // already stopped
        }
      },
    };
  }

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  if (params.sound === "studio_beep") {
    osc.type = "sine";
    osc.frequency.setValueAtTime(params.isDownbeat ? 1320 : params.isSubdivision ? 660 : 880, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.048);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.055);
  } else {
    // Woodblock: resonant pitched click
    osc.type = "triangle";
    const baseFreq = params.isDownbeat ? 1180 : params.isSubdivision ? 640 : 840;
    osc.frequency.setValueAtTime(baseFreq, t0);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.82, t0 + 0.032);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peakGain * 1.05, t0 + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.038);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.042);
  }

  return {
    stop: () => {
      try {
        osc.stop();
      } catch {
        // already stopped
      }
    },
  };
}

type SyncConfig = {
  mode: "synced";
  getSongSec: () => number;
  bpm: number;
  playbackRate: number;
  scoreTimeSignature: string;
  settings: MetronomeSettings;
  beatSchedule?: PlaybackMetronomeBeat[];
  onBeatChange?: (beat: number | null) => void;
};

type StandaloneConfig = {
  mode: "standalone";
  bpm: number;
  scoreTimeSignature: string;
  settings: MetronomeSettings;
  onBeatChange?: (beat: number | null) => void;
  onStandaloneStop?: () => void;
};

type CountInConfig = {
  mode: "count_in";
  bars: 1 | 2;
  bpm: number;
  scoreTimeSignature: string;
  pickupBeats?: number;
  beatUnitQuarters?: number;
  settings: MetronomeSettings;
  onBeatChange?: (beat: number | null) => void;
  onComplete: () => void;
};

type ActiveSession = SyncConfig | StandaloneConfig | CountInConfig;

/**
 * Singleton Web Audio look-ahead metronome scheduler.
 * Guarantees at most one active scheduler at any time and cleans up immediately on stop.
 */
class MetronomeEngine {
  private ctx: AudioContext | null = null;
  private timerId: number | null = null;
  private activeNodes = new Set<{ stop: () => void }>();
  private session: ActiveSession | null = null;
  private lastScheduledStep = -1;
  private standaloneStartPerfMs = 0;
  private countInTimerId: number | null = null;

  public ensureContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!this.ctx) {
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  public playSingleClick(
    accent: boolean,
    volume = 0.75,
    sound: MetronomeSound = "woodblock",
  ): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const handle = scheduleMetronomeClickNode(ctx, ctx.currentTime, {
      sound,
      isDownbeat: accent,
      isSubdivision: false,
      volume,
    });
    if (handle) {
      this.activeNodes.add(handle);
      window.setTimeout(() => this.activeNodes.delete(handle), 80);
    }
  }

  public isRunning(): boolean {
    return this.session !== null;
  }

  public getMode(): ActiveSession["mode"] | null {
    return this.session?.mode ?? null;
  }

  public startSynced(config: Omit<SyncConfig, "mode">): void {
    this.stop();
    this.ensureContext();
    this.lastScheduledStep = -1;
    this.session = { mode: "synced", ...config };
    this.startLoop();
  }

  public updateSynced(partial: Partial<Omit<SyncConfig, "mode">>): void {
    if (!this.session || this.session.mode !== "synced") return;
    this.session = { ...this.session, ...partial };
    if (!this.session.settings.enabled) {
      this.stop();
    }
  }

  public startStandalone(config: Omit<StandaloneConfig, "mode">): void {
    this.stop();
    this.ensureContext();
    this.standaloneStartPerfMs = performance.now();
    this.lastScheduledStep = -1;
    this.session = { mode: "standalone", ...config };
    this.startLoop();
  }

  public updateStandalone(partial: Partial<Omit<StandaloneConfig, "mode">>): void {
    if (!this.session || this.session.mode !== "standalone") return;
    this.session = { ...this.session, ...partial };
  }

  public startCountIn(config: Omit<CountInConfig, "mode">): void {
    this.stop();
    this.ensureContext();
    this.standaloneStartPerfMs = performance.now();
    this.lastScheduledStep = -1;
    this.session = { mode: "count_in", ...config };

    const effSig = resolveEffectiveTimeSignature(
      config.scoreTimeSignature,
      config.settings.timeSignatureOverride,
    );
    const { beatsPerBar, beatUnit } = parseTimeSignature(effSig);
    const unitQ = config.beatUnitQuarters ?? (4 / Math.max(1, beatUnit));
    const beatSec = unitQ * (60 / Math.max(20, config.bpm));
    const rawPickupBeats = Math.max(0, config.pickupBeats ?? 0);
    let totalCountInBeats = config.bars * beatsPerBar - rawPickupBeats;
    if (rawPickupBeats > 0 && totalCountInBeats < 1) {
      totalCountInBeats += beatsPerBar;
    }
    const totalCountInMs = Math.max(100, Math.round(totalCountInBeats * beatSec * 1000));

    this.startLoop();
    this.countInTimerId = window.setTimeout(() => {
      if (this.session?.mode === "count_in") {
        const done = this.session.onComplete;
        this.stop();
        done();
      }
    }, totalCountInMs);
  }

  public stop(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.countInTimerId !== null) {
      window.clearTimeout(this.countInTimerId);
      this.countInTimerId = null;
    }
    for (const node of this.activeNodes) {
      node.stop();
    }
    this.activeNodes.clear();

    const prev = this.session;
    this.session = null;
    this.lastScheduledStep = -1;
    prev?.onBeatChange?.(null);
    if (prev?.mode === "standalone") {
      prev.onStandaloneStop?.();
    }
  }

  private startLoop(): void {
    const tick = () => {
      const s = this.session;
      if (!s) return;
      if (s.mode === "synced" && !s.settings.enabled) {
        this.stop();
        return;
      }

      const ctx = this.ensureContext();
      const effSig = resolveEffectiveTimeSignature(
        s.scoreTimeSignature,
        s.settings.timeSignatureOverride,
      );
      const { beatsPerBar } = parseTimeSignature(effSig);
      const subMult = s.settings.subdivision === "eighth" ? 2 : 1;

      if (s.mode === "synced") {
        const songSec = Math.max(0, s.getSongSec());
        const rate = Math.max(0.25, s.playbackRate || 1);
        const lookAheadSongSec = 0.1 * rate;

        if (s.beatSchedule && s.beatSchedule.length > 0) {
          const filtered = s.beatSchedule.filter((b) => subMult === 2 || !b.isSubdivision);
          const windowEnd = songSec + lookAheadSongSec;
          const prevActiveIdx = this.lastScheduledStep;
          // Detect loop wrap-around when playback seeks backward
          if (prevActiveIdx >= 0 && prevActiveIdx < filtered.length && filtered[prevActiveIdx].sec > windowEnd + 0.08) {
            this.lastScheduledStep = -1;
          }
          for (let i = Math.max(0, this.lastScheduledStep + 1); i < filtered.length; i++) {
            const ev = filtered[i];
            if (ev.sec < songSec - 0.04) {
              this.lastScheduledStep = i;
              continue;
            }
            if (ev.sec > windowEnd) break;
            const deltaRealSec = Math.max(0, (ev.sec - songSec) / rate);
            const isDownbeat = !ev.isSubdivision && s.settings.accentBeatOne && ev.isDownbeat;
            if (ctx) {
              const handle = scheduleMetronomeClickNode(ctx, ctx.currentTime + deltaRealSec, {
                sound: s.settings.sound,
                isDownbeat,
                isSubdivision: ev.isSubdivision,
                volume: s.settings.volume,
              });
              if (handle) {
                this.activeNodes.add(handle);
                window.setTimeout(() => this.activeNodes.delete(handle), Math.ceil((deltaRealSec + 0.08) * 1000));
              }
            }
            if (!ev.isSubdivision) {
              s.onBeatChange?.(ev.beatInBar);
            }
            this.lastScheduledStep = i;
          }
          return;
        }

        const songBeatSec = 60 / Math.max(20, s.bpm);
        const songStepSec = songBeatSec / subMult;

        // Handle loop wrap-around cleanly
        const currentStep = Math.floor(songSec / songStepSec);
        if (currentStep + 2 < this.lastScheduledStep) {
          this.lastScheduledStep = currentStep - 1;
        }

        const maxStep = Math.floor((songSec + lookAheadSongSec) / songStepSec);
        const startStep = Math.max(currentStep, this.lastScheduledStep + 1);

        for (let step = startStep; step <= maxStep; step++) {
          const stepSongSec = step * songStepSec;
          const deltaRealSec = Math.max(0, (stepSongSec - songSec) / rate);
          const beatIndex = Math.floor(step / subMult);
          const isSub = step % subMult !== 0;
          const beatInBar = (beatIndex % beatsPerBar) + 1;
          const isDownbeat = !isSub && s.settings.accentBeatOne && beatInBar === 1;

          if (ctx) {
            const handle = scheduleMetronomeClickNode(ctx, ctx.currentTime + deltaRealSec, {
              sound: s.settings.sound,
              isDownbeat,
              isSubdivision: isSub,
              volume: s.settings.volume,
            });
            if (handle) {
              this.activeNodes.add(handle);
              window.setTimeout(() => this.activeNodes.delete(handle), Math.ceil((deltaRealSec + 0.08) * 1000));
            }
          }
          if (!isSub) {
            s.onBeatChange?.(beatInBar);
          }
          this.lastScheduledStep = step;
        }
        return;
      }

      // Standalone or Count-in mode (real-time clock)
      const elapsedSec = Math.max(0, (performance.now() - this.standaloneStartPerfMs) / 1000);
      const beatSec = 60 / Math.max(20, s.bpm);
      const stepSec = beatSec / subMult;
      const currentStep = Math.floor(elapsedSec / stepSec);
      const maxStep = Math.floor((elapsedSec + 0.09) / stepSec);
      const startStep = Math.max(currentStep, this.lastScheduledStep + 1);

      for (let step = startStep; step <= maxStep; step++) {
        if (s.mode === "count_in") {
          const rawPickupBeats = Math.max(0, s.pickupBeats ?? 0);
          let countInBeats = s.bars * beatsPerBar - rawPickupBeats;
          if (rawPickupBeats > 0 && countInBeats < 1) countInBeats += beatsPerBar;
          const maxCountInSteps = Math.round(countInBeats * subMult);
          if (step >= maxCountInSteps) break;
        }
        const deltaSec = Math.max(0, step * stepSec - elapsedSec);
        const beatIndex = Math.floor(step / subMult);
        const isSub = step % subMult !== 0;
        const beatInBar = (beatIndex % beatsPerBar) + 1;
        const isDownbeat = !isSub && s.settings.accentBeatOne && beatInBar === 1;

        if (ctx) {
          const handle = scheduleMetronomeClickNode(ctx, ctx.currentTime + deltaSec, {
            sound: s.settings.sound,
            isDownbeat,
            isSubdivision: isSub,
            volume: s.settings.volume,
          });
          if (handle) {
            this.activeNodes.add(handle);
            window.setTimeout(() => this.activeNodes.delete(handle), Math.ceil((deltaSec + 0.08) * 1000));
          }
        }
        if (!isSub) {
          s.onBeatChange?.(beatInBar);
        }
        this.lastScheduledStep = step;
      }
    };

    tick();
    this.timerId = window.setInterval(tick, 25);
  }
}

export const metronomeEngine = new MetronomeEngine();
