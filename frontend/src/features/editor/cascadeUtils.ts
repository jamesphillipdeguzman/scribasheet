import type { ScoreNote, ScoreTrack } from "@/types/api";

export type VoiceRole = "soprano" | "alto" | "tenor" | "bass" | "other";

export interface KeyRect {
  pitch: number;
  x: number;
  width: number;
  isBlack: boolean;
}

export interface CascadePalette {
  fill: string;
  stroke: string;
  highlight: string;
  text: string;
  label: string;
}

export const SATB_CASCADE_COLORS: Record<VoiceRole, CascadePalette> = {
  soprano: {
    fill: "#38BDF8", // Sky Blue
    stroke: "#BAE6FD",
    highlight: "#E0F2FE",
    text: "#082F49",
    label: "Soprano",
  },
  alto: {
    fill: "#34D399", // Emerald Green
    stroke: "#A7F3D0",
    highlight: "#ECFDF5",
    text: "#022C22",
    label: "Alto",
  },
  tenor: {
    fill: "#FBBF24", // Amber
    stroke: "#FDE68A",
    highlight: "#FFFBEB",
    text: "#451A03",
    label: "Tenor",
  },
  bass: {
    fill: "#A78BFA", // Violet
    stroke: "#DDD6FE",
    highlight: "#F5F3FF",
    text: "#1E1B4B",
    label: "Bass",
  },
  other: {
    fill: "#8B5CF6",
    stroke: "#C4B5FD",
    highlight: "#F5F3FF",
    text: "#F5F3FF",
    label: "Part",
  },
};

const FALLBACK_TRACK_PALETTES: CascadePalette[] = [
  SATB_CASCADE_COLORS.bass,
  SATB_CASCADE_COLORS.soprano,
  SATB_CASCADE_COLORS.alto,
  SATB_CASCADE_COLORS.tenor,
];

const BLACK_PCS = new Set([1, 3, 6, 8, 10]);

export function resolveTrackVoiceRole(track: ScoreTrack | undefined): VoiceRole {
  if (!track) return "other";
  const name = (track.name || "").trim().toLowerCase();
  if (name.includes("soprano") || name === "sop") return "soprano";
  if (name.includes("alto")) return "alto";
  if (name.includes("tenor") || name === "ten") return "tenor";
  if (name.includes("bass")) return "bass";
  return "other";
}

export function getCascadeTrackPalette(track: ScoreTrack | undefined, trackIndex: number): CascadePalette {
  const role = resolveTrackVoiceRole(track);
  if (role !== "other") return SATB_CASCADE_COLORS[role];
  return FALLBACK_TRACK_PALETTES[Math.abs(trackIndex) % FALLBACK_TRACK_PALETTES.length];
}

/**
 * Compute exact horizontal key coordinates matching VirtualPianoKeyboard's layout.
 * When DOM button measurements are supplied with non-zero widths, they take precedence
 * so alignment stays locked to the rendered keyboard across resizes.
 */
export function computeKeyLayoutMap(
  minPitch: number,
  maxPitch: number,
  containerWidth: number,
  measuredRects?: Map<number, { x: number; width: number }>,
): Map<number, KeyRect> {
  const map = new Map<number, KeyRect>();
  const safeWidth = Math.max(1, containerWidth);

  const whites: number[] = [];
  for (let p = minPitch; p <= maxPitch; p++) {
    if (!BLACK_PCS.has(p % 12)) whites.push(p);
  }
  const totalWhites = Math.max(1, whites.length);
  const whiteW = safeWidth / totalWhites;
  const blackW = whiteW * 0.66;

  let whiteIdx = 0;
  for (let p = minPitch; p <= maxPitch; p++) {
    const isBlack = BLACK_PCS.has(p % 12);
    const measured = measuredRects?.get(p);
    if (measured && measured.width > 0) {
      map.set(p, { pitch: p, x: measured.x, width: measured.width, isBlack });
      if (!isBlack) whiteIdx++;
      continue;
    }

    if (!isBlack) {
      map.set(p, { pitch: p, x: whiteIdx * whiteW, width: whiteW, isBlack: false });
      whiteIdx++;
    } else {
      const x = ((whiteIdx - 0.34) / totalWhites) * safeWidth;
      map.set(p, { pitch: p, x, width: blackW, isBlack: true });
    }
  }
  return map;
}

export interface PositionedCascadeNote {
  note: ScoreNote;
  topY: number;
  bottomY: number;
  height: number;
  isAtHitLine: boolean;
  isMatchedLive: boolean;
}

/**
 * Filter and project MIDI notes onto vertical falling-bar coordinates.
 * Hit line sits at `hitLineY`. At `onset_sec === currentSec`, `bottomY === hitLineY`.
 */
export function computeCascadeNotePositions(
  notes: ScoreNote[],
  currentSec: number,
  lookAheadSec: number,
  hitLineY: number,
  activeMidiPitches: Set<number>,
  hitToleranceSec = 0.18,
): PositionedCascadeNote[] {
  const safeLookAhead = Math.max(0.5, lookAheadSec);
  const pxPerSec = hitLineY / safeLookAhead;
  const windowStart = currentSec - 0.25;
  const windowEnd = currentSec + safeLookAhead + 0.05;
  const result: PositionedCascadeNote[] = [];

  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.offset_sec < windowStart || n.onset_sec > windowEnd) continue;

    const dtOnset = n.onset_sec - currentSec;
    const dtOffset = n.offset_sec - currentSec;
    const bottomY = hitLineY - dtOnset * pxPerSec;
    const topY = hitLineY - dtOffset * pxPerSec;
    const height = Math.max(4, bottomY - topY);

    if (bottomY < 0 || topY > hitLineY + 12) continue;

    const isAtHitLine = currentSec >= n.onset_sec && currentSec < n.offset_sec;
    const isMatchedLive =
      activeMidiPitches.has(n.pitch_midi) &&
      currentSec >= n.onset_sec - hitToleranceSec &&
      currentSec <= n.offset_sec + hitToleranceSec;

    result.push({
      note: n,
      topY,
      bottomY,
      height,
      isAtHitLine,
      isMatchedLive,
    });
  }
  return result;
}
