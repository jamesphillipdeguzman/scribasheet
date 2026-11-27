/**
 * Stateful monophonic pitch-to-note tracker for live acoustic violin input.
 *
 * Built directly on top of the shared YIN pitch engine in ``pitchTuner.ts``
 * rather than duplicating frequency estimation logic. Handles violin pitch
 * bounds (G3-E7), stable-onset debouncing, vibrato tolerance, bow-change
 * transient rejection, energy-gated note-off, and same-pitch rearticulation.
 */

import {
  centsBetweenFrequencies,
  detectPitchYin,
  frequencyToMidiFloat,
  midiToFrequency,
} from "@/utils/pitchTuner";

export const VIOLIN_MIN_MIDI = 55; // G3 (~196.0 Hz)
export const VIOLIN_MAX_MIDI = 100; // E7 (~2637.0 Hz)

export interface LivePitchTrackerConfig {
  minMidi: number;
  maxMidi: number;
  minFrequencyHz: number;
  maxFrequencyHz: number;
  referenceA4Hz: number;
  confidenceThreshold: number;
  yinThreshold: number;
  rmsOnsetThreshold: number;
  rmsReleaseThreshold: number;
  stableDebounceMs: number;
  vibratoToleranceCents: number;
  releaseGraceMs: number;
  retriggerCooldownMs: number;
  reattackDipRatio: number;
  reattackRiseRatio: number;
  smoothingWindowSize: number;
}

export const DEFAULT_VIOLIN_TRACKER_CONFIG: LivePitchTrackerConfig = {
  minMidi: VIOLIN_MIN_MIDI,
  maxMidi: VIOLIN_MAX_MIDI,
  minFrequencyHz: 185,
  maxFrequencyHz: 2850,
  referenceA4Hz: 440,
  confidenceThreshold: 0.8,
  yinThreshold: 0.15,
  rmsOnsetThreshold: 0.015,
  rmsReleaseThreshold: 0.008,
  stableDebounceMs: 120,
  vibratoToleranceCents: 55,
  releaseGraceMs: 65,
  retriggerCooldownMs: 85,
  reattackDipRatio: 0.58,
  reattackRiseRatio: 1.32,
  smoothingWindowSize: 3,
};

export interface LivePitchObservation {
  frequencyHz: number | null;
  confidence: number;
  rms: number;
  timestampMs: number;
}

export interface LivePitchEvent {
  type: "noteOn" | "noteOff";
  midi: number;
  velocity: number;
  timestampMs: number;
}

export type LivePitchTrackerState = "idle" | "stabilizing" | "active";

export interface LivePitchFrameResult {
  events: LivePitchEvent[];
  state: LivePitchTrackerState;
  detectedMidi: number | null;
  detectedHz: number | null;
  confidence: number;
  rms: number;
  stabilizingProgress: number;
  noteAcceptedFlash: boolean;
}

function rmsToMidiVelocity(rms: number, minRms: number): number {
  const safeFloor = Math.max(0.004, minRms);
  const norm = Math.min(1, Math.max(0, (rms - safeFloor) / Math.max(0.08, safeFloor * 8)));
  return Math.max(48, Math.min(120, Math.round(64 + norm * 52)));
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface LivePitchNoteTracker {
  processSamples: (samples: Float32Array, sampleRate: number, timestampMs: number) => LivePitchFrameResult;
  processObservation: (obs: LivePitchObservation) => LivePitchFrameResult;
  flush: (timestampMs: number) => LivePitchEvent[];
  reset: () => void;
  updateConfig: (partial: Partial<LivePitchTrackerConfig>) => void;
  getActiveNote: () => number | null;
}

export function createLivePitchNoteTracker(
  initialConfig: Partial<LivePitchTrackerConfig> = {},
): LivePitchNoteTracker {
  let cfg: LivePitchTrackerConfig = {
    ...DEFAULT_VIOLIN_TRACKER_CONFIG,
    ...initialConfig,
  };

  let activeNoteMidi: number | null = null;
  let lastNoteOnMs = -Infinity;
  let lastNoteOffMs = -Infinity;
  let activePeakRms = 0;
  let reattackInDip = false;
  let reattackDipRms = 0;

  let candidateMidi: number | null = null;
  let candidateStartMs = 0;
  let silenceStartMs: number | null = null;

  let midiHistory: number[] = [];

  const resetCandidate = () => {
    candidateMidi = null;
    candidateStartMs = 0;
  };

  const reset = () => {
    activeNoteMidi = null;
    lastNoteOnMs = -Infinity;
    lastNoteOffMs = -Infinity;
    activePeakRms = 0;
    reattackInDip = false;
    reattackDipRms = 0;
    resetCandidate();
    silenceStartMs = null;
    midiHistory = [];
  };

  const updateConfig = (partial: Partial<LivePitchTrackerConfig>) => {
    cfg = { ...cfg, ...partial };
  };

  const flush = (timestampMs: number): LivePitchEvent[] => {
    const events: LivePitchEvent[] = [];
    if (activeNoteMidi !== null) {
      events.push({
        type: "noteOff",
        midi: activeNoteMidi,
        velocity: 0,
        timestampMs,
      });
      activeNoteMidi = null;
      lastNoteOffMs = timestampMs;
    }
    resetCandidate();
    silenceStartMs = null;
    midiHistory = [];
    activePeakRms = 0;
    reattackInDip = false;
    reattackDipRms = 0;
    return events;
  };

  const processObservation = (obs: LivePitchObservation): LivePitchFrameResult => {
    const events: LivePitchEvent[] = [];
    const { frequencyHz, confidence, rms, timestampMs } = obs;

    let rawMidiFloat: number | null = null;
    let isVoicedValid = false;

    if (
      frequencyHz !== null &&
      Number.isFinite(frequencyHz) &&
      frequencyHz >= cfg.minFrequencyHz &&
      frequencyHz <= cfg.maxFrequencyHz &&
      confidence >= cfg.confidenceThreshold &&
      rms >= cfg.rmsReleaseThreshold
    ) {
      const mFloat = frequencyToMidiFloat(frequencyHz, cfg.referenceA4Hz);
      const nearest = Math.round(mFloat);
      if (nearest >= cfg.minMidi && nearest <= cfg.maxMidi) {
        rawMidiFloat = mFloat;
        isVoicedValid = true;
      }
    }

    let smoothedHz: number | null = null;
    let smoothedMidiFloat: number | null = null;
    if (isVoicedValid && rawMidiFloat !== null) {
      // Only smooth frames belonging to the same ~semitone neighborhood so genuine note
      // transitions start their debounce timer immediately on the first new-pitch frame.
      if (midiHistory.length > 0 && Math.abs(rawMidiFloat - midiHistory[midiHistory.length - 1]) > 0.75) {
        midiHistory = [];
      }
      midiHistory.push(rawMidiFloat);
      const winSize = Math.max(1, Math.round(cfg.smoothingWindowSize));
      if (midiHistory.length > winSize) {
        midiHistory = midiHistory.slice(midiHistory.length - winSize);
      }
      smoothedMidiFloat = medianOf(midiHistory);
      smoothedHz = midiToFrequency(smoothedMidiFloat, cfg.referenceA4Hz);
    } else {
      midiHistory = [];
    }

    if (activeNoteMidi !== null) {
      if (isVoicedValid && smoothedHz !== null && smoothedMidiFloat !== null) {
        const activeTargetHz = midiToFrequency(activeNoteMidi, cfg.referenceA4Hz);
        const centsFromActive = centsBetweenFrequencies(smoothedHz, activeTargetHz);

        if (Math.abs(centsFromActive) <= cfg.vibratoToleranceCents) {
          // Stay locked inside vibrato window around the current note
          silenceStartMs = null;
          resetCandidate();

          if (rms > activePeakRms) {
            activePeakRms = rms;
          }

          if (!reattackInDip) {
            if (activePeakRms > 0 && rms < activePeakRms * cfg.reattackDipRatio) {
              reattackInDip = true;
              reattackDipRms = rms;
            }
          } else {
            if (rms < reattackDipRms) {
              reattackDipRms = rms;
            }
            const roseEnough =
              rms >= Math.max(cfg.rmsOnsetThreshold, reattackDipRms * cfg.reattackRiseRatio);
            const cooldownElapsed =
              timestampMs - lastNoteOnMs >= cfg.retriggerCooldownMs + cfg.stableDebounceMs;
            if (roseEnough && cooldownElapsed) {
              const vel = rmsToMidiVelocity(rms, cfg.rmsOnsetThreshold);
              events.push({
                type: "noteOff",
                midi: activeNoteMidi,
                velocity: 0,
                timestampMs,
              });
              events.push({
                type: "noteOn",
                midi: activeNoteMidi,
                velocity: vel,
                timestampMs,
              });
              lastNoteOnMs = timestampMs;
              activePeakRms = rms;
              reattackInDip = false;
              reattackDipRms = 0;
            }
          }
        } else {
          // Pitch moved significantly outside active vibrato band (>= ~1 semitone shift)
          silenceStartMs = null;
          const nextMidi = Math.max(cfg.minMidi, Math.min(cfg.maxMidi, Math.round(smoothedMidiFloat)));
          const nextTargetHz = midiToFrequency(nextMidi, cfg.referenceA4Hz);
          const withinCandidateBand =
            candidateMidi === nextMidi &&
            Math.abs(centsBetweenFrequencies(smoothedHz, nextTargetHz)) <= cfg.vibratoToleranceCents;

          if (!withinCandidateBand) {
            candidateMidi = nextMidi;
            candidateStartMs = timestampMs;
          } else if (
            timestampMs - candidateStartMs >= cfg.stableDebounceMs &&
            rms >= cfg.rmsOnsetThreshold &&
            nextMidi !== activeNoteMidi
          ) {
            const vel = rmsToMidiVelocity(rms, cfg.rmsOnsetThreshold);
            events.push({
              type: "noteOff",
              midi: activeNoteMidi,
              velocity: 0,
              timestampMs,
            });
            events.push({
              type: "noteOn",
              midi: nextMidi,
              velocity: vel,
              timestampMs,
            });
            activeNoteMidi = nextMidi;
            lastNoteOnMs = timestampMs;
            activePeakRms = rms;
            reattackInDip = false;
            reattackDipRms = 0;
            resetCandidate();
          }
        }
      } else {
        // Silence or unvoiced transient while a note is sounding
        resetCandidate();
        if (silenceStartMs === null) {
          silenceStartMs = timestampMs;
        } else if (timestampMs - silenceStartMs >= cfg.releaseGraceMs) {
          events.push({
            type: "noteOff",
            midi: activeNoteMidi,
            velocity: 0,
            timestampMs,
          });
          activeNoteMidi = null;
          lastNoteOffMs = timestampMs;
          activePeakRms = 0;
          reattackInDip = false;
          reattackDipRms = 0;
          silenceStartMs = null;
        }
      }
    } else {
      // Currently idle: wait for continuous stable voiced pitch >= stableDebounceMs
      silenceStartMs = null;
      if (isVoicedValid && smoothedHz !== null && smoothedMidiFloat !== null && rms >= cfg.rmsOnsetThreshold) {
        const nextMidi = Math.max(cfg.minMidi, Math.min(cfg.maxMidi, Math.round(smoothedMidiFloat)));
        const nextTargetHz = midiToFrequency(nextMidi, cfg.referenceA4Hz);
        const matchesCandidate =
          candidateMidi === nextMidi &&
          Math.abs(centsBetweenFrequencies(smoothedHz, nextTargetHz)) <= cfg.vibratoToleranceCents;

        if (!matchesCandidate) {
          candidateMidi = nextMidi;
          candidateStartMs = timestampMs;
        } else if (
          timestampMs - candidateStartMs >= cfg.stableDebounceMs &&
          timestampMs - lastNoteOffMs >= cfg.retriggerCooldownMs
        ) {
          const vel = rmsToMidiVelocity(rms, cfg.rmsOnsetThreshold);
          events.push({
            type: "noteOn",
            midi: nextMidi,
            velocity: vel,
            timestampMs,
          });
          activeNoteMidi = nextMidi;
          lastNoteOnMs = timestampMs;
          activePeakRms = rms;
          reattackInDip = false;
          reattackDipRms = 0;
          resetCandidate();
        }
      } else {
        resetCandidate();
      }
    }

    const noteAcceptedFlash = events.some((e) => e.type === "noteOn");
    const state: LivePitchTrackerState =
      activeNoteMidi !== null ? "active" : candidateMidi !== null ? "stabilizing" : "idle";
    const stabilizingProgress =
      state === "stabilizing" && cfg.stableDebounceMs > 0
        ? Math.min(1, Math.max(0, (timestampMs - candidateStartMs) / cfg.stableDebounceMs))
        : state === "active"
          ? 1
          : 0;

    return {
      events,
      state,
      detectedMidi: activeNoteMidi ?? candidateMidi,
      detectedHz: smoothedHz ?? frequencyHz,
      confidence,
      rms,
      stabilizingProgress,
      noteAcceptedFlash,
    };
  };

  const processSamples = (
    samples: Float32Array,
    sampleRate: number,
    timestampMs: number,
  ): LivePitchFrameResult => {
    const pitch = detectPitchYin(samples, sampleRate, {
      referenceA4Hz: cfg.referenceA4Hz,
      minFrequencyHz: cfg.minFrequencyHz,
      maxFrequencyHz: cfg.maxFrequencyHz,
      rmsThreshold: cfg.rmsReleaseThreshold * 0.5,
      yinThreshold: cfg.yinThreshold,
      minConfidence: cfg.confidenceThreshold * 0.85,
    });

    if (!pitch) {
      let energy = 0;
      for (let i = 0; i < samples.length; i += 1) {
        energy += samples[i] * samples[i];
      }
      const rms = samples.length > 0 ? Math.sqrt(energy / samples.length) : 0;
      return processObservation({
        frequencyHz: null,
        confidence: 0,
        rms,
        timestampMs,
      });
    }

    return processObservation({
      frequencyHz: pitch.frequencyHz,
      confidence: pitch.confidence,
      rms: pitch.rms,
      timestampMs,
    });
  };

  return {
    processSamples,
    processObservation,
    flush,
    reset,
    updateConfig,
    getActiveNote: () => activeNoteMidi,
  };
}
