import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Gauge, Mic, MicOff, Square, Volume2, X } from "lucide-react";
import {
  centsBetweenFrequencies,
  clampReferenceA4Hz,
  createPitchSmoother,
  DEFAULT_REFERENCE_A4_HZ,
  DEFAULT_TUNER_FFT_SIZE,
  detectPitchYin,
  findNearestStringTarget,
  getTunerPreset,
  IN_TUNE_CENTS_THRESHOLD,
  MAX_REFERENCE_A4_HZ,
  midiToFrequency,
  MIN_REFERENCE_A4_HZ,
  type PitchDetectionResult,
  TUNER_PRESETS,
  type TunerInstrumentId,
  type TunerStringTarget,
} from "@/utils/pitchTuner";
import { acquireExclusiveMic, releaseExclusiveMic } from "@/utils/micCoordinator";

type MicStatus = "idle" | "requesting" | "listening" | "paused_for_drone" | "error";
type DroneWaveform = "triangle" | "sine";

const UI_UPDATE_INTERVAL_MS = 45;
const DEFAULT_DRONE_GAIN = 0.14;
const MAX_DRONE_GAIN = 0.25;

interface ActiveAudioResources {
  audioCtx: AudioContext | null;
  stream: MediaStream | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  rafId: number | null;
  droneOsc: OscillatorNode | null;
  droneGain: GainNode | null;
}

function formatTunerMicError(err: unknown): string {
  const errName =
    err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  if (errName === "NotAllowedError" || errName === "PermissionDeniedError") {
    return "Microphone access was denied. Allow microphone permission in your browser to use live pitch detection, or use the string reference tones below.";
  }
  if (errName === "NotFoundError" || errName === "DevicesNotFoundError") {
    return "No microphone was found on this device. Connect a microphone or use the string reference tones below.";
  }
  if (errName === "NotReadableError" || errName === "TrackStartError") {
    return "Microphone is currently in use by another application.";
  }
  return err instanceof Error && err.message
    ? err.message
    : "Unable to start microphone tuner in this browser.";
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return win.AudioContext || win.webkitAudioContext || null;
}

export function InstrumentTunerControl() {
  const [open, setOpen] = useState(false);
  const [instrumentId, setInstrumentId] = useState<TunerInstrumentId>("chromatic");
  const [referenceA4Hz, setReferenceA4Hz] = useState<number>(DEFAULT_REFERENCE_A4_HZ);
  const [selectedStringId, setSelectedStringId] = useState<string | null>(null);
  const [autoStringDetect, setAutoStringDetect] = useState<boolean>(true);
  const [micStatus, setMicStatus] = useState<MicStatus>("idle");
  const [micError, setMicError] = useState<string | null>(null);
  const [detectedPitch, setDetectedPitch] = useState<PitchDetectionResult | null>(null);

  const [droneWaveform, setDroneWaveform] = useState<DroneWaveform>("triangle");
  const [droneVolume, setDroneVolume] = useState<number>(DEFAULT_DRONE_GAIN);
  const [activeDroneMidi, setActiveDroneMidi] = useState<number | null>(null);
  const [activeDroneLabel, setActiveDroneLabel] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dialogId = useId();
  const presetSelectId = useId();
  const sessionTokenRef = useRef(0);
  const resourcesRef = useRef<ActiveAudioResources>({
    audioCtx: null,
    stream: null,
    sourceNode: null,
    analyser: null,
    rafId: null,
    droneOsc: null,
    droneGain: null,
  });

  const smootherRef = useRef(createPitchSmoother());
  const instrumentIdRef = useRef(instrumentId);
  instrumentIdRef.current = instrumentId;
  const referenceA4Ref = useRef(referenceA4Hz);
  referenceA4Ref.current = referenceA4Hz;
  const activeDroneMidiRef = useRef(activeDroneMidi);
  activeDroneMidiRef.current = activeDroneMidi;

  const preset = useMemo(() => getTunerPreset(instrumentId), [instrumentId]);

  const stopDrone = useCallback(() => {
    const res = resourcesRef.current;
    if (res.droneOsc) {
      try {
        res.droneOsc.stop();
      } catch {
        // Ignore if oscillator has not started or already stopped
      }
      try {
        res.droneOsc.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      res.droneOsc = null;
    }
    if (res.droneGain) {
      try {
        res.droneGain.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      res.droneGain = null;
    }
    activeDroneMidiRef.current = null;
    setActiveDroneMidi(null);
    setActiveDroneLabel(null);
    setMicStatus((prev) => (prev === "paused_for_drone" ? "listening" : prev));
  }, []);

  const stopAllTunerAudio = useCallback(() => {
    sessionTokenRef.current += 1;
    const res = resourcesRef.current;

    if (res.rafId !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(res.rafId);
      res.rafId = null;
    }

    stopDrone();

    if (res.sourceNode) {
      try {
        res.sourceNode.disconnect();
      } catch {
        // Ignore
      }
      res.sourceNode = null;
    }
    if (res.analyser) {
      try {
        res.analyser.disconnect();
      } catch {
        // Ignore
      }
      res.analyser = null;
    }
    if (res.stream) {
      for (const track of res.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore
        }
      }
      res.stream = null;
    }
    if (res.audioCtx) {
      const ctx = res.audioCtx;
      res.audioCtx = null;
      if (ctx.state !== "closed" && typeof ctx.close === "function") {
        try {
          void Promise.resolve(ctx.close()).catch(() => undefined);
        } catch {
          // Ignore close errors
        }
      }
    }

    smootherRef.current.reset();
    setDetectedPitch(null);
    setMicStatus("idle");
    releaseExclusiveMic("tuner");
  }, [stopDrone]);

  const startDroneTone = useCallback(
    async (midi: number, label: string) => {
      const CtxCtor = getAudioContextConstructor();
      if (!CtxCtor) {
        setMicError("Web Audio API is unavailable in this browser.");
        return;
      }

      // Toggle off if clicking the already-playing tone
      if (activeDroneMidiRef.current === midi) {
        stopDrone();
        return;
      }

      stopDrone();
      const res = resourcesRef.current;
      let ctx = res.audioCtx;
      if (!ctx || ctx.state === "closed") {
        ctx = new CtxCtor();
        res.audioCtx = ctx;
      }
      if (ctx.state === "suspended" && typeof ctx.resume === "function") {
        await Promise.resolve(ctx.resume()).catch(() => undefined);
      }

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = droneWaveform;
      osc.frequency.setValueAtTime(midiToFrequency(midi, referenceA4Ref.current), ctx.currentTime);
      const clampedVol = Math.min(MAX_DRONE_GAIN, Math.max(0.02, droneVolume));
      gain.gain.setValueAtTime(clampedVol, ctx.currentTime);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();

      res.droneOsc = osc;
      res.droneGain = gain;
      activeDroneMidiRef.current = midi;
      setActiveDroneMidi(midi);
      setActiveDroneLabel(label);

      // Isolate microphone detection while drone sounds
      smootherRef.current.reset();
      setDetectedPitch(null);
      setMicStatus((prev) => (prev === "listening" ? "paused_for_drone" : prev));
    },
    [droneVolume, droneWaveform, stopDrone],
  );

  // Live-update playing drone pitch/volume/waveform when calibration controls change
  useEffect(() => {
    const res = resourcesRef.current;
    if (!res.audioCtx || !res.droneOsc || activeDroneMidi === null) return;
    res.droneOsc.type = droneWaveform;
    res.droneOsc.frequency.setValueAtTime(
      midiToFrequency(activeDroneMidi, referenceA4Hz),
      res.audioCtx.currentTime,
    );
    if (res.droneGain) {
      const clampedVol = Math.min(MAX_DRONE_GAIN, Math.max(0.02, droneVolume));
      res.droneGain.gain.setValueAtTime(clampedVol, res.audioCtx.currentTime);
    }
  }, [activeDroneMidi, droneVolume, droneWaveform, referenceA4Hz]);

  const startMicrophoneAnalysis = useCallback(async () => {
    stopAllTunerAudio();
    const myToken = sessionTokenRef.current;
    setMicError(null);

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      setMicStatus("error");
      setMicError(
        "Microphone capture is not supported in this browser. You can still play reference string tones below.",
      );
      return;
    }

    const CtxCtor = getAudioContextConstructor();
    if (!CtxCtor) {
      setMicStatus("error");
      setMicError("Web Audio API is unavailable in this browser.");
      return;
    }

    acquireExclusiveMic("tuner", () => {
      stopAllTunerAudio();
      setOpen(false);
    });

    setMicStatus("requesting");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
    } catch (err) {
      if (sessionTokenRef.current !== myToken) return;
      setMicStatus("error");
      setMicError(formatTunerMicError(err));
      return;
    }

    // Guard against close/reopen race while permission prompt resolved
    if (sessionTokenRef.current !== myToken) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore
        }
      }
      return;
    }

    try {
      const audioCtx = new CtxCtor();
      if (audioCtx.state === "suspended" && typeof audioCtx.resume === "function") {
        await Promise.resolve(audioCtx.resume()).catch(() => undefined);
      }

      if (sessionTokenRef.current !== myToken) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        if (audioCtx.state !== "closed" && typeof audioCtx.close === "function") {
          void Promise.resolve(audioCtx.close()).catch(() => undefined);
        }
        return;
      }

      const sourceNode = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = DEFAULT_TUNER_FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      sourceNode.connect(analyser);

      resourcesRef.current = {
        ...resourcesRef.current,
        audioCtx,
        stream,
        sourceNode,
        analyser,
        rafId: null,
      };
      smootherRef.current.reset();
      setMicStatus("listening");

      const sampleBuffer = new Float32Array(analyser.fftSize);
      let lastUiUpdateMs = 0;

      const tick = (nowMs: number) => {
        if (sessionTokenRef.current !== myToken) return;
        const activeAnalyser = resourcesRef.current.analyser;
        const activeCtx = resourcesRef.current.audioCtx;
        if (!activeAnalyser || !activeCtx) return;

        // Suspend mic analysis while reference drone plays to prevent acoustic feedback
        if (activeDroneMidiRef.current === null) {
          if (nowMs - lastUiUpdateMs >= UI_UPDATE_INTERVAL_MS) {
            lastUiUpdateMs = nowMs;
            activeAnalyser.getFloatTimeDomainData(sampleBuffer);
            const curPreset = getTunerPreset(instrumentIdRef.current);
            const curRefHz = referenceA4Ref.current;
            const rawPitch = detectPitchYin(sampleBuffer, activeCtx.sampleRate, {
              referenceA4Hz: curRefHz,
              minFrequencyHz: curPreset.minHz,
              maxFrequencyHz: curPreset.maxHz,
            });
            const smoothed = smootherRef.current.update(rawPitch, curRefHz);
            setDetectedPitch(smoothed);
          }
        }

        if (sessionTokenRef.current === myToken) {
          resourcesRef.current.rafId = window.requestAnimationFrame(tick);
        }
      };

      resourcesRef.current.rafId = window.requestAnimationFrame(tick);
    } catch (err) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore
        }
      }
      if (sessionTokenRef.current !== myToken) return;
      setMicStatus("error");
      setMicError(formatTunerMicError(err));
    }
  }, [stopAllTunerAudio]);

  // Trigger mic start ONLY when user explicitly opens the tuner; stop completely when closed or unmounted
  useEffect(() => {
    if (open) {
      void startMicrophoneAnalysis();
      return () => {
        stopAllTunerAudio();
      };
    }
    stopAllTunerAudio();
    return undefined;
  }, [open, startMicrophoneAnalysis, stopAllTunerAudio]);

  // Close popover on outside click or Escape key
  useEffect(() => {
    if (!open) return undefined;
    const handlePointer = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const handleInstrumentChange = (nextId: TunerInstrumentId) => {
    setInstrumentId(nextId);
    setSelectedStringId(null);
    setAutoStringDetect(true);
    smootherRef.current.reset();
    setDetectedPitch(null);
  };

  // Determine effective string target for instrument presets
  const activeStringTarget: TunerStringTarget | null = useMemo(() => {
    if (preset.strings.length === 0) return null;
    if (!autoStringDetect && selectedStringId) {
      return preset.strings.find((s) => s.id === selectedStringId) || preset.strings[0];
    }
    if (detectedPitch) {
      return findNearestStringTarget(detectedPitch.frequencyHz, preset.strings, referenceA4Hz);
    }
    if (selectedStringId) {
      return preset.strings.find((s) => s.id === selectedStringId) || null;
    }
    return null;
  }, [autoStringDetect, detectedPitch, preset.strings, referenceA4Hz, selectedStringId]);

  // Compute displayed cents relative to locked/detected string target or nearest chromatic note
  const displayedCents = useMemo(() => {
    if (!detectedPitch) return null;
    if (activeStringTarget && preset.strings.length > 0) {
      const targetHz = midiToFrequency(activeStringTarget.midi, referenceA4Hz);
      return centsBetweenFrequencies(detectedPitch.frequencyHz, targetHz);
    }
    return detectedPitch.cents;
  }, [activeStringTarget, detectedPitch, preset.strings.length, referenceA4Hz]);

  const clampedNeedleCents =
    displayedCents === null ? 0 : Math.max(-50, Math.min(50, displayedCents));
  const needleLeftPct = 50 + clampedNeedleCents;
  const isSignalReliable = detectedPitch !== null && activeDroneMidi === null;
  const isInTune =
    isSignalReliable &&
    displayedCents !== null &&
    Math.abs(displayedCents) <= IN_TUNE_CENTS_THRESHOLD;
  const isFlat = isSignalReliable && displayedCents !== null && displayedCents < -IN_TUNE_CENTS_THRESHOLD;

  const signedCentsLabel =
    isSignalReliable && displayedCents !== null
      ? `${displayedCents >= 0 ? "+" : ""}${displayedCents.toFixed(0)}¢`
      : "—";

  const statusText =
    activeDroneMidi !== null
      ? `Tone Playing (${activeDroneLabel}) — Mic Paused`
      : !isSignalReliable
        ? micStatus === "requesting"
          ? "Requesting Mic..."
          : micStatus === "error"
            ? "Mic Unavailable"
            : "Listening..."
        : isInTune
          ? "In Tune"
          : isFlat
            ? activeStringTarget
              ? `Flat vs ${activeStringTarget.label} — Tune Up`
              : "Flat — Tune Up"
            : activeStringTarget
              ? `Sharp vs ${activeStringTarget.label} — Tune Down`
              : "Sharp — Tune Down";

  return (
    <div ref={containerRef} className="relative inline-flex items-center shrink-0">
      <button
        type="button"
        data-testid="studio-tuner-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? dialogId : undefined}
        onClick={() => setOpen((v) => !v)}
        title="Open client-side instrument tuner"
        className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
          open
            ? "border-violet-400 bg-violet-50 text-violet-900 dark:border-violet-500/50 dark:bg-violet-500/20 dark:text-violet-200"
            : "border-stone-300 bg-white text-stone-800 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#F5F3FF] dark:hover:bg-[#232336]"
        }`}
      >
        <Gauge className="h-3.5 w-3.5 text-violet-600 dark:text-[#A78BFA]" aria-hidden="true" />
        <span>Tuner</span>
        {open && micStatus === "listening" && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-emerald-500"
            aria-hidden="true"
          />
        )}
      </button>

      {open && (
        <div
          id={dialogId}
          role="dialog"
          aria-label="Instrument Tuner"
          data-testid="instrument-tuner-popover"
          className="absolute right-0 top-full mt-2 z-50 w-[340px] sm:w-[380px] max-w-[calc(100vw-2rem)] box-border overflow-x-hidden rounded-xl border border-stone-200 bg-white p-4 shadow-2xl space-y-3.5 text-xs text-stone-900 dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF]"
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b border-stone-200 pb-2.5 dark:border-[#27273A]">
            <div className="flex items-center gap-2 min-w-0">
              <Gauge className="h-4 w-4 shrink-0 text-violet-600 dark:text-[#A78BFA]" aria-hidden="true" />
              <span className="text-sm font-semibold whitespace-nowrap truncate">Instrument Tuner</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <span
                className={`inline-flex items-center gap-1 whitespace-nowrap shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  micStatus === "listening"
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
                    : micStatus === "paused_for_drone"
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
                      : micStatus === "error"
                        ? "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300"
                        : "bg-stone-100 text-stone-600 dark:bg-[#181825] dark:text-[#A1A1AA]"
                }`}
              >
                {micStatus === "listening" ? (
                  <Mic className="h-3 w-3 shrink-0" aria-hidden="true" />
                ) : (
                  <MicOff className="h-3 w-3 shrink-0" aria-hidden="true" />
                )}
                {micStatus === "listening"
                  ? "Live"
                  : micStatus === "paused_for_drone"
                    ? "Paused"
                    : micStatus === "requesting"
                      ? "Starting"
                      : micStatus === "error"
                        ? "Off"
                        : "Idle"}
              </span>
              <button
                type="button"
                aria-label="Close tuner"
                onClick={() => setOpen(false)}
                className="shrink-0 rounded-lg p-1 text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:text-[#A1A1AA] dark:hover:bg-white/10 dark:hover:text-white"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Preset Selector */}
          <div className="space-y-1 min-w-0">
            <label
              htmlFor={presetSelectId}
              className="block text-[11px] font-medium text-stone-600 dark:text-[#A1A1AA]"
            >
              Instrument Tuning
            </label>
            <select
              id={presetSelectId}
              aria-label="Instrument preset"
              value={instrumentId}
              onChange={(e) => handleInstrumentChange(e.target.value as TunerInstrumentId)}
              className="w-full min-w-0 max-w-full box-border h-8 rounded-lg border border-stone-300 bg-white px-2.5 text-xs text-stone-900 focus:border-violet-500 focus:outline-none dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
            >
              {TUNER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {/* Error state if mic denied/missing/unsupported */}
          {micError && (
            <div
              role="alert"
              data-testid="tuner-mic-error"
              className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-[11px] text-amber-900 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-200 space-y-2"
            >
              <p>{micError}</p>
              <button
                type="button"
                onClick={() => void startMicrophoneAnalysis()}
                className="rounded border border-amber-400 bg-white px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-[#181825] dark:text-amber-200 dark:hover:bg-amber-500/20"
              >
                Retry Microphone
              </button>
            </div>
          )}

          {/* Readout & Cents Meter */}
          <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 space-y-3 min-w-0 box-border dark:border-[#27273A] dark:bg-[#09090F]">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <div className="min-w-0 shrink-0">
                <div
                  data-testid="tuner-detected-note"
                  className={`text-3xl font-bold tracking-tight font-mono ${
                    !isSignalReliable
                      ? "text-stone-400 dark:text-[#52526B]"
                      : isInTune
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-stone-900 dark:text-[#F5F3FF]"
                  }`}
                >
                  {isSignalReliable && detectedPitch ? detectedPitch.scientificNote : "—"}
                </div>
                <div
                  data-testid="tuner-detected-hz"
                  className="text-[11px] font-mono text-stone-600 dark:text-[#A1A1AA]"
                >
                  {isSignalReliable && detectedPitch
                    ? `${detectedPitch.frequencyHz.toFixed(1)} Hz`
                    : "No pitch detected"}
                </div>
              </div>

              <div className="min-w-0 text-right space-y-1">
                <div
                  data-testid="tuner-detected-cents"
                  className={`text-base font-semibold font-mono ${
                    !isSignalReliable
                      ? "text-stone-400 dark:text-[#52526B]"
                      : isInTune
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-amber-600 dark:text-amber-300"
                  }`}
                >
                  {signedCentsLabel}
                </div>
                <div
                  data-testid="tuner-status-badge"
                  className={`inline-block max-w-full truncate rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    !isSignalReliable
                      ? "bg-stone-200 text-stone-600 dark:bg-[#181825] dark:text-[#A1A1AA]"
                      : isInTune
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300"
                        : "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
                  }`}
                >
                  {statusText}
                </div>
              </div>
            </div>

            {/* Visual Cents Meter (-50 to +50) */}
            <div className="space-y-1.5 min-w-0">
              <div className="relative w-full h-5 rounded-full bg-stone-200 dark:bg-[#181825] overflow-hidden border border-stone-300 dark:border-[#27273A]">
                {/* ±5c In-tune green zone */}
                <div
                  aria-hidden="true"
                  className="absolute inset-y-0 left-[45%] w-[10%] bg-emerald-500/25 border-x border-emerald-500/50"
                />
                {/* Center 0c tick */}
                <div
                  aria-hidden="true"
                  className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-stone-500/60 dark:bg-white/40"
                />
                {/* Moving Needle */}
                <div
                  data-testid="tuner-meter-needle"
                  style={{ left: `${needleLeftPct}%` }}
                  className={`absolute top-0.5 bottom-0.5 w-2 -translate-x-1/2 rounded-full transition-[left] duration-75 ${
                    !isSignalReliable
                      ? "bg-stone-400/70 dark:bg-[#52526B]"
                      : isInTune
                        ? "bg-emerald-500 shadow-sm shadow-emerald-500/50"
                        : "bg-amber-500 dark:bg-amber-400"
                  }`}
                />
              </div>
              <div className="space-y-0.5">
                <div
                  data-testid="tuner-cents-scale"
                  className="flex items-center justify-between text-xs font-mono text-stone-500 dark:text-[#A1A1AA]"
                >
                  <span className="whitespace-nowrap">-50¢</span>
                  <span className="whitespace-nowrap">0¢</span>
                  <span className="whitespace-nowrap">+50¢</span>
                </div>
                <div
                  data-testid="tuner-cents-labels"
                  className="flex items-center justify-between text-[11px] text-stone-500 dark:text-[#A1A1AA]"
                >
                  <span className="whitespace-nowrap">Flat</span>
                  <span className="whitespace-nowrap font-medium text-emerald-700 dark:text-emerald-400">
                    In Tune
                  </span>
                  <span className="whitespace-nowrap">Sharp</span>
                </div>
              </div>
            </div>
          </div>

          {/* String Target Buttons & Reference Drone Controls */}
          <div className="space-y-2 min-w-0">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <span className="text-[11px] font-medium text-stone-600 dark:text-[#A1A1AA] truncate">
                {preset.strings.length > 0
                  ? "Strings (Click to hear reference tone & target)"
                  : "Reference Tone"}
              </span>
              {preset.strings.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setAutoStringDetect(true);
                    setSelectedStringId(null);
                  }}
                  className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                    autoStringDetect
                      ? "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-300"
                      : "text-stone-500 hover:bg-stone-100 dark:text-[#A1A1AA] dark:hover:bg-white/10"
                  }`}
                >
                  Auto Target
                </button>
              )}
            </div>

            {preset.strings.length > 0 ? (
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5 min-w-0">
                {preset.strings.map((str) => {
                  const isTarget = activeStringTarget?.id === str.id;
                  const isPlayingDrone = activeDroneMidi === str.midi;
                  const targetHz = midiToFrequency(str.midi, referenceA4Hz);
                  return (
                    <button
                      key={str.id}
                      type="button"
                      data-testid={`tuner-string-${str.label}`}
                      aria-pressed={isTarget || isPlayingDrone}
                      title={`${str.label} (${targetHz.toFixed(1)} Hz) — click to play reference tone`}
                      onClick={() => {
                        setSelectedStringId(str.id);
                        setAutoStringDetect(false);
                        void startDroneTone(str.midi, str.label);
                      }}
                      className={`min-w-0 box-border flex flex-col items-center justify-center rounded-lg border py-1.5 px-1 transition-colors cursor-pointer ${
                        isPlayingDrone
                          ? "border-emerald-500 bg-emerald-50 text-emerald-900 dark:border-emerald-500/60 dark:bg-emerald-500/20 dark:text-emerald-200"
                          : isTarget
                            ? "border-violet-500 bg-violet-50 text-violet-900 dark:border-[#A78BFA] dark:bg-violet-500/20 dark:text-violet-200"
                            : "border-stone-300 bg-white text-stone-800 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#F5F3FF] dark:hover:bg-[#232336]"
                      }`}
                    >
                      <span className="font-mono font-semibold text-xs">{str.label}</span>
                      <span className="text-[9px] text-stone-500 dark:text-[#A1A1AA]">
                        {targetHz.toFixed(0)}Hz
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                <button
                  type="button"
                  data-testid="tuner-drone-a4"
                  onClick={() => void startDroneTone(69, `A4 (${referenceA4Hz} Hz)`)}
                  className={`inline-flex items-center gap-1.5 max-w-full box-border whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                    activeDroneMidi === 69
                      ? "border-emerald-500 bg-emerald-50 text-emerald-900 dark:border-emerald-500/60 dark:bg-emerald-500/20 dark:text-emerald-200"
                      : "border-stone-300 bg-white text-stone-800 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#F5F3FF]"
                  }`}
                >
                  <Volume2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>Play A4 ({referenceA4Hz} Hz)</span>
                </button>
              </div>
            )}

            {/* Drone waveform, volume & Stop control */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
                <select
                  aria-label="Reference tone waveform"
                  value={droneWaveform}
                  onChange={(e) => setDroneWaveform(e.target.value as DroneWaveform)}
                  className="h-7 min-w-0 max-w-full box-border rounded border border-stone-300 bg-white px-2 text-[11px] text-stone-800 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
                >
                  <option value="triangle">Triangle tone</option>
                  <option value="sine">Sine tone</option>
                </select>
                <label className="inline-flex items-center gap-1.5 min-w-0 text-[10px] text-stone-500 dark:text-[#A1A1AA]">
                  <span className="shrink-0">Vol</span>
                  <input
                    type="range"
                    aria-label="Reference tone volume"
                    min={0.02}
                    max={MAX_DRONE_GAIN}
                    step={0.02}
                    value={droneVolume}
                    onChange={(e) => setDroneVolume(Number(e.target.value))}
                    className="w-20 min-w-0 max-w-full box-border accent-violet-600 dark:accent-[#8B5CF6]"
                  />
                </label>
              </div>

              {activeDroneMidi !== null && (
                <button
                  type="button"
                  data-testid="tuner-stop-drone-btn"
                  onClick={stopDrone}
                  className="inline-flex h-7 shrink-0 whitespace-nowrap items-center gap-1 rounded border border-red-300 bg-red-50 px-2 text-[11px] font-medium text-red-700 hover:bg-red-100 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300"
                >
                  <Square className="h-3 w-3 shrink-0" aria-hidden="true" />
                  Stop Tone
                </button>
              )}
            </div>
          </div>

          {/* Reference Frequency Calibration (432 - 445 Hz) */}
          <div className="border-t border-stone-200 pt-2.5 space-y-1.5 min-w-0 dark:border-[#27273A]">
            <div className="flex items-center justify-between gap-2 text-[11px] min-w-0">
              <span className="truncate text-stone-600 dark:text-[#A1A1AA]">Calibration (A4 Reference)</span>
              <span data-testid="tuner-reference-hz" className="font-mono font-semibold whitespace-nowrap shrink-0">
                {referenceA4Hz} Hz
              </span>
            </div>
            <div className="flex items-center gap-2 min-w-0 w-full box-border">
              <button
                type="button"
                aria-label="Decrease A4 reference frequency"
                onClick={() => setReferenceA4Hz((v) => clampReferenceA4Hz(v - 1))}
                disabled={referenceA4Hz <= MIN_REFERENCE_A4_HZ}
                className="h-6 w-6 shrink-0 rounded border border-stone-300 bg-white text-xs font-semibold hover:bg-stone-100 disabled:opacity-40 dark:border-[#27273A] dark:bg-[#181825] dark:hover:bg-white/10"
              >
                -
              </button>
              <input
                type="range"
                aria-label="A4 reference frequency"
                min={MIN_REFERENCE_A4_HZ}
                max={MAX_REFERENCE_A4_HZ}
                step={1}
                value={referenceA4Hz}
                onChange={(e) => setReferenceA4Hz(clampReferenceA4Hz(Number(e.target.value)))}
                className="flex-1 min-w-0 w-full box-border accent-violet-600 dark:accent-[#8B5CF6]"
              />
              <button
                type="button"
                aria-label="Increase A4 reference frequency"
                onClick={() => setReferenceA4Hz((v) => clampReferenceA4Hz(v + 1))}
                disabled={referenceA4Hz >= MAX_REFERENCE_A4_HZ}
                className="h-6 w-6 shrink-0 rounded border border-stone-300 bg-white text-xs font-semibold hover:bg-stone-100 disabled:opacity-40 dark:border-[#27273A] dark:bg-[#181825] dark:hover:bg-white/10"
              >
                +
              </button>
              {referenceA4Hz !== DEFAULT_REFERENCE_A4_HZ && (
                <button
                  type="button"
                  onClick={() => setReferenceA4Hz(DEFAULT_REFERENCE_A4_HZ)}
                  className="shrink-0 whitespace-nowrap text-[10px] text-violet-700 hover:underline dark:text-[#A78BFA]"
                >
                  440
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
