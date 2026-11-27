import type { ScoreNote } from "@/types/api";

export type SnapGridMode = "1/16" | "1/8" | "off";

export function getGridStepSec(tempoBpm: number, snapMode: SnapGridMode): number {
  const beatSec = 60 / Math.max(20, tempoBpm || 120);
  if (snapMode === "1/8") return beatSec * 0.5;
  if (snapMode === "1/16") return beatSec * 0.25;
  return 0;
}

export function quantizeSeconds(sec: number, gridStepSec: number): number {
  if (gridStepSec <= 0) return Math.max(0, Number(sec.toFixed(3)));
  return Math.max(0, Number((Math.round(sec / gridStepSec) * gridStepSec).toFixed(3)));
}

export function rePitchSelectedNotes(
  notes: ScoreNote[],
  selectedIds: Set<string>,
  targetPitch: number,
): ScoreNote[] {
  const selected = notes.filter((n) => selectedIds.has(n.id));
  if (selected.length === 0) return notes;

  const clampedTarget = Math.max(0, Math.min(127, targetPitch));
  if (selected.length === 1) {
    const onlyId = selected[0].id;
    return notes.map((n) => (n.id === onlyId ? { ...n, pitch_midi: clampedTarget } : n));
  }

  // Multi-note selection: preserve relative pitch intervals anchored on the lowest selected note
  const anchorPitch = Math.min(...selected.map((n) => n.pitch_midi));
  const delta = clampedTarget - anchorPitch;
  return notes.map((n) => {
    if (!selectedIds.has(n.id)) return n;
    const shifted = Math.max(0, Math.min(127, n.pitch_midi + delta));
    return { ...n, pitch_midi: shifted };
  });
}

export interface RecordedRawNote {
  pitchMidi: number;
  velocity: number;
  onsetSec: number;
  offsetSec: number;
}

export interface RecordedScoreNote extends ScoreNote {
  raw_onset_sec?: number | null;
  raw_offset_sec?: number | null;
}

export function buildQuantizedRecordedNotes(
  rawNotes: RecordedRawNote[],
  options: {
    tempoBpm: number;
    snapMode: SnapGridMode;
    targetTrackIndex: number;
  },
): RecordedScoreNote[] {
  const gridStep = getGridStepSec(options.tempoBpm, options.snapMode);
  const minDur = gridStep > 0 ? Math.max(0.06, Number((gridStep * 0.5).toFixed(3))) : 0.08;

  return rawNotes.map((raw, idx) => {
    const onset = quantizeSeconds(raw.onsetSec, gridStep);
    const rawDur = Math.max(0.05, raw.offsetSec - raw.onsetSec);
    const snappedEnd = gridStep > 0 ? quantizeSeconds(onset + rawDur, gridStep) : Number((onset + rawDur).toFixed(3));
    const offset = Math.max(Number((onset + minDur).toFixed(3)), snappedEnd);
    return {
      id: `midi_${Date.now().toString(36)}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
      pitch_midi: Math.max(0, Math.min(127, raw.pitchMidi)),
      onset_sec: onset,
      offset_sec: offset,
      velocity: Math.max(1, Math.min(127, raw.velocity || 85)),
      track_index: options.targetTrackIndex,
      raw_onset_sec: Number(raw.onsetSec.toFixed(4)),
      raw_offset_sec: Number(raw.offsetSec.toFixed(4)),
    };
  });
}

export function mergeOrReplaceRecordedNotes(
  existingNotes: ScoreNote[],
  recordedNotes: ScoreNote[],
  options: {
    mode: "merge" | "replace";
    targetTrackIndex: number;
  },
): ScoreNote[] {
  const base =
    options.mode === "replace"
      ? existingNotes.filter((n) => n.track_index !== options.targetTrackIndex)
      : existingNotes;
  return [...base, ...recordedNotes].sort(
    (a, b) => a.onset_sec - b.onset_sec || a.track_index - b.track_index || a.pitch_midi - b.pitch_midi,
  );
}
