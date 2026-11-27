/**
 * Client-side monophonic YIN pitch detection and equal-tempered tuning math.
 * Independent of React so it can be reused by both the Studio Instrument Tuner
 * and potential future monophonic live audio input workflows.
 */

export type TunerInstrumentId =
  | "chromatic"
  | "violin"
  | "guitar_standard"
  | "guitar_drop_d"
  | "ukulele_high_g"
  | "ukulele_low_g";

export interface TunerStringTarget {
  id: string;
  label: string;
  noteName: string;
  midi: number;
  stringNumber: number;
}

export interface TunerPreset {
  id: TunerInstrumentId;
  label: string;
  group: string;
  strings: readonly TunerStringTarget[];
  minHz: number;
  maxHz: number;
}

export interface PitchDetectionOptions {
  referenceA4Hz?: number;
  minFrequencyHz?: number;
  maxFrequencyHz?: number;
  rmsThreshold?: number;
  yinThreshold?: number;
  minConfidence?: number;
}

export interface PitchDetectionResult {
  frequencyHz: number;
  scientificNote: string;
  noteName: string;
  octave: number;
  midiNote: number;
  cents: number;
  confidence: number;
  rms: number;
}

export const DEFAULT_REFERENCE_A4_HZ = 440;
export const MIN_REFERENCE_A4_HZ = 432;
export const MAX_REFERENCE_A4_HZ = 445;
export const DEFAULT_TUNER_FFT_SIZE = 4096;
export const IN_TUNE_CENTS_THRESHOLD = 5;

const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"] as const;

export const TUNER_PRESETS: readonly TunerPreset[] = [
  {
    id: "chromatic",
    label: "Chromatic (All Notes)",
    group: "Chromatic",
    strings: [],
    minHz: 55,
    maxHz: 2093,
  },
  {
    id: "violin",
    label: "Violin (G3–D4–A4–E5)",
    group: "Strings",
    minHz: 140,
    maxHz: 1480,
    strings: [
      { id: "violin-g3", label: "G3", noteName: "G3", midi: 55, stringNumber: 4 },
      { id: "violin-d4", label: "D4", noteName: "D4", midi: 62, stringNumber: 3 },
      { id: "violin-a4", label: "A4", noteName: "A4", midi: 69, stringNumber: 2 },
      { id: "violin-e5", label: "E5", noteName: "E5", midi: 76, stringNumber: 1 },
    ],
  },
  {
    id: "guitar_standard",
    label: "Guitar Standard (E2–A2–D3–G3–B3–E4)",
    group: "Guitar",
    minHz: 60,
    maxHz: 660,
    strings: [
      { id: "guitar-6-e2", label: "E2", noteName: "E2", midi: 40, stringNumber: 6 },
      { id: "guitar-5-a2", label: "A2", noteName: "A2", midi: 45, stringNumber: 5 },
      { id: "guitar-4-d3", label: "D3", noteName: "D3", midi: 50, stringNumber: 4 },
      { id: "guitar-3-g3", label: "G3", noteName: "G3", midi: 55, stringNumber: 3 },
      { id: "guitar-2-b3", label: "B3", noteName: "B3", midi: 59, stringNumber: 2 },
      { id: "guitar-1-e4", label: "E4", noteName: "E4", midi: 64, stringNumber: 1 },
    ],
  },
  {
    id: "guitar_drop_d",
    label: "Guitar Drop D (D2–A2–D3–G3–B3–E4)",
    group: "Guitar",
    minHz: 55,
    maxHz: 660,
    strings: [
      { id: "guitar-dd-6-d2", label: "D2", noteName: "D2", midi: 38, stringNumber: 6 },
      { id: "guitar-dd-5-a2", label: "A2", noteName: "A2", midi: 45, stringNumber: 5 },
      { id: "guitar-dd-4-d3", label: "D3", noteName: "D3", midi: 50, stringNumber: 4 },
      { id: "guitar-dd-3-g3", label: "G3", noteName: "G3", midi: 55, stringNumber: 3 },
      { id: "guitar-dd-2-b3", label: "B3", noteName: "B3", midi: 59, stringNumber: 2 },
      { id: "guitar-dd-1-e4", label: "E4", noteName: "E4", midi: 64, stringNumber: 1 },
    ],
  },
  {
    id: "ukulele_high_g",
    label: "Ukulele Standard High-G (G4–C4–E4–A4)",
    group: "Ukulele",
    minHz: 180,
    maxHz: 920,
    strings: [
      { id: "uke-hg-4-g4", label: "G4", noteName: "G4", midi: 67, stringNumber: 4 },
      { id: "uke-hg-3-c4", label: "C4", noteName: "C4", midi: 60, stringNumber: 3 },
      { id: "uke-hg-2-e4", label: "E4", noteName: "E4", midi: 64, stringNumber: 2 },
      { id: "uke-hg-1-a4", label: "A4", noteName: "A4", midi: 69, stringNumber: 1 },
    ],
  },
  {
    id: "ukulele_low_g",
    label: "Ukulele Low-G (G3–C4–E4–A4)",
    group: "Ukulele",
    minHz: 145,
    maxHz: 920,
    strings: [
      { id: "uke-lg-4-g3", label: "G3", noteName: "G3", midi: 55, stringNumber: 4 },
      { id: "uke-lg-3-c4", label: "C4", noteName: "C4", midi: 60, stringNumber: 3 },
      { id: "uke-lg-2-e4", label: "E4", noteName: "E4", midi: 64, stringNumber: 2 },
      { id: "uke-lg-1-a4", label: "A4", noteName: "A4", midi: 69, stringNumber: 1 },
    ],
  },
] as const;

export function getTunerPreset(id: TunerInstrumentId): TunerPreset {
  return TUNER_PRESETS.find((p) => p.id === id) || TUNER_PRESETS[0];
}

export function clampReferenceA4Hz(hz: number): number {
  if (!Number.isFinite(hz)) return DEFAULT_REFERENCE_A4_HZ;
  return Math.min(MAX_REFERENCE_A4_HZ, Math.max(MIN_REFERENCE_A4_HZ, Math.round(hz * 10) / 10));
}

export function midiToFrequency(midi: number, referenceA4Hz = DEFAULT_REFERENCE_A4_HZ): number {
  const ref = clampReferenceA4Hz(referenceA4Hz);
  return ref * Math.pow(2, (midi - 69) / 12);
}

export function frequencyToMidiFloat(freqHz: number, referenceA4Hz = DEFAULT_REFERENCE_A4_HZ): number {
  const ref = clampReferenceA4Hz(referenceA4Hz);
  return 69 + 12 * Math.log2(freqHz / ref);
}

export function midiToScientificNote(midi: number): {
  noteName: string;
  octave: number;
  scientific: string;
} {
  const rounded = Math.round(midi);
  const pc = ((rounded % 12) + 12) % 12;
  const noteName = NOTE_NAMES[pc];
  const octave = Math.floor(rounded / 12) - 1;
  return { noteName, octave, scientific: `${noteName}${octave}` };
}

export function centsBetweenFrequencies(detectedHz: number, targetHz: number): number {
  if (detectedHz <= 0 || targetHz <= 0 || !Number.isFinite(detectedHz) || !Number.isFinite(targetHz)) {
    return 0;
  }
  return 1200 * Math.log2(detectedHz / targetHz);
}

export function findNearestStringTarget(
  detectedHz: number,
  strings: readonly TunerStringTarget[],
  referenceA4Hz = DEFAULT_REFERENCE_A4_HZ,
): TunerStringTarget | null {
  if (!strings.length || detectedHz <= 0) return null;
  let bestTarget: TunerStringTarget | null = null;
  let bestAbsCents = Number.POSITIVE_INFINITY;
  for (const s of strings) {
    const targetHz = midiToFrequency(s.midi, referenceA4Hz);
    const absCents = Math.abs(centsBetweenFrequencies(detectedHz, targetHz));
    if (absCents < bestAbsCents) {
      bestAbsCents = absCents;
      bestTarget = s;
    }
  }
  return bestTarget;
}

/**
 * Detect fundamental frequency from time-domain PCM samples using the YIN algorithm
 * with DC-removal, RMS noise gate, CMNDF dip picking, and parabolic interpolation.
 */
export function detectPitchYin(
  samples: Float32Array,
  sampleRate: number,
  options: PitchDetectionOptions = {},
): PitchDetectionResult | null {
  if (!samples || samples.length < 512 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return null;
  }

  const refA4 = clampReferenceA4Hz(options.referenceA4Hz ?? DEFAULT_REFERENCE_A4_HZ);
  const minHz = Math.max(25, options.minFrequencyHz ?? 55);
  const maxHz = Math.min(sampleRate * 0.45, options.maxFrequencyHz ?? 2093);
  if (maxHz <= minHz) return null;

  const rmsThreshold = options.rmsThreshold ?? 0.01;
  const yinThreshold = options.yinThreshold ?? 0.15;
  const minConfidence = options.minConfidence ?? 0.78;

  const n = samples.length;
  const halfLen = Math.floor(n / 2);

  // Compute DC mean and RMS over the full buffer
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += samples[i];
  }
  const mean = sum / n;

  let energySum = 0;
  const centered = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = samples[i] - mean;
    centered[i] = v;
    energySum += v * v;
  }
  const rms = Math.sqrt(energySum / n);
  if (!Number.isFinite(rms) || rms < rmsThreshold) {
    return null;
  }

  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(halfLen - 2, Math.ceil(sampleRate / minHz));
  if (tauMax <= tauMin + 2) {
    return null;
  }

  // Step 1 & 2: Squared difference function & Cumulative Mean Normalized Difference (CMNDF)
  const diff = new Float32Array(tauMax + 2);
  const cmndf = new Float32Array(tauMax + 2);
  cmndf[0] = 1;

  let runningSum = 0;
  for (let tau = 1; tau <= tauMax + 1; tau += 1) {
    let sqDiff = 0;
    for (let i = 0; i < halfLen; i += 1) {
      const delta = centered[i] - centered[i + tau];
      sqDiff += delta * delta;
    }
    diff[tau] = sqDiff;
    runningSum += sqDiff;
    cmndf[tau] = runningSum > 1e-12 ? (sqDiff * tau) / runningSum : 1;
  }

  // Step 3: Absolute threshold pick (first dip below yinThreshold), else best dip if confident
  let tauEstimate = -1;
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    if (cmndf[tau] < yinThreshold) {
      while (tau + 1 <= tauMax && cmndf[tau + 1] < cmndf[tau]) {
        tau += 1;
      }
      tauEstimate = tau;
      break;
    }
  }

  if (tauEstimate === -1) {
    let minVal = Number.POSITIVE_INFINITY;
    let minTau = -1;
    for (let tau = tauMin; tau <= tauMax; tau += 1) {
      if (cmndf[tau] < minVal) {
        minVal = cmndf[tau];
        minTau = tau;
      }
    }
    if (minTau === -1 || 1 - minVal < minConfidence) {
      return null;
    }
    tauEstimate = minTau;
  }

  const confidence = Math.max(0, Math.min(1, 1 - cmndf[tauEstimate]));
  if (confidence < minConfidence) {
    return null;
  }

  // Step 4: Parabolic interpolation around tauEstimate for sub-sample accuracy
  let betterTau = tauEstimate;
  if (tauEstimate > 1 && tauEstimate <= tauMax) {
    const s0 = cmndf[tauEstimate - 1];
    const s1 = cmndf[tauEstimate];
    const s2 = cmndf[tauEstimate + 1];
    const denom = 2 * s1 - s2 - s0;
    if (Math.abs(denom) > 1e-12) {
      const shift = (s2 - s0) / (2 * denom);
      if (Number.isFinite(shift) && Math.abs(shift) <= 0.5) {
        betterTau = tauEstimate + shift;
      }
    }
  }

  const frequencyHz = sampleRate / betterTau;
  if (!Number.isFinite(frequencyHz) || frequencyHz < minHz * 0.9 || frequencyHz > maxHz * 1.1) {
    return null;
  }

  const midiFloat = frequencyToMidiFloat(frequencyHz, refA4);
  const nearestMidi = Math.round(midiFloat);
  const targetHz = midiToFrequency(nearestMidi, refA4);
  const cents = centsBetweenFrequencies(frequencyHz, targetHz);
  const { noteName, octave, scientific } = midiToScientificNote(nearestMidi);

  return {
    frequencyHz,
    scientificNote: scientific,
    noteName,
    octave,
    midiNote: nearestMidi,
    cents,
    confidence,
    rms,
  };
}

export interface PitchSmootherOptions {
  alpha?: number;
  jumpResetCents?: number;
  maxSilentFrames?: number;
}

/**
 * Lightweight exponential frequency smoother that stabilizes meter jitter
 * while resetting immediately on genuine pitch jumps (e.g. switching strings)
 * and clearing to null after a short run of silent/unreliable frames.
 */
export function createPitchSmoother(options: PitchSmootherOptions = {}) {
  const alpha = options.alpha ?? 0.35;
  const jumpResetCents = options.jumpResetCents ?? 60;
  const maxSilentFrames = options.maxSilentFrames ?? 6;

  let smoothedFreqHz: number | null = null;
  let silentFrames = 0;

  return {
    update(
      raw: PitchDetectionResult | null,
      referenceA4Hz = DEFAULT_REFERENCE_A4_HZ,
    ): PitchDetectionResult | null {
      if (!raw) {
        silentFrames += 1;
        if (silentFrames >= maxSilentFrames) {
          smoothedFreqHz = null;
        }
        return null;
      }

      silentFrames = 0;
      if (
        smoothedFreqHz === null ||
        Math.abs(centsBetweenFrequencies(raw.frequencyHz, smoothedFreqHz)) >= jumpResetCents
      ) {
        smoothedFreqHz = raw.frequencyHz;
      } else {
        smoothedFreqHz = alpha * raw.frequencyHz + (1 - alpha) * smoothedFreqHz;
      }

      const midiFloat = frequencyToMidiFloat(smoothedFreqHz, referenceA4Hz);
      const nearestMidi = Math.round(midiFloat);
      const targetHz = midiToFrequency(nearestMidi, referenceA4Hz);
      const cents = centsBetweenFrequencies(smoothedFreqHz, targetHz);
      const { noteName, octave, scientific } = midiToScientificNote(nearestMidi);

      return {
        frequencyHz: smoothedFreqHz,
        scientificNote: scientific,
        noteName,
        octave,
        midiNote: nearestMidi,
        cents,
        confidence: raw.confidence,
        rms: raw.rms,
      };
    },

    reset() {
      smoothedFreqHz = null;
      silentFrames = 0;
    },
  };
}
