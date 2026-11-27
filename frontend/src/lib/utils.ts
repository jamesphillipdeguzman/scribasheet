import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { spellMidiPitch } from "@/lib/keySignature";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds) || seconds < 0) return "—";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function isScoreImageAsset(
  asset?: { original_filename?: string | null; mime_type?: string | null } | null,
): boolean {
  if (!asset) return false;
  const name = (asset.original_filename || "").toLowerCase();
  if (/\.(jpg|jpeg|png|webp)$/i.test(name)) return true;
  const mime = (asset.mime_type || "").toLowerCase();
  return mime === "image/jpeg" || mime === "image/jpg" || mime === "image/png" || mime === "image/webp";
}

export function isScoreMediaAsset(
  asset?: { original_filename?: string | null; mime_type?: string | null } | null,
): boolean {
  if (!asset) return false;
  if (isScoreImageAsset(asset)) return true;
  const mime = (asset.mime_type || "").toLowerCase();
  if (mime.includes("pdf") || mime.includes("musicxml")) return true;
  const name = (asset.original_filename || "").toLowerCase();
  return /\.(pdf|mxl|musicxml)$/i.test(name);
}

export function isVideoMediaAsset(
  asset?: { original_filename?: string | null; mime_type?: string | null } | null,
): boolean {
  if (!asset || isScoreMediaAsset(asset)) return false;
  const name = (asset.original_filename || "").trim().toLowerCase();
  const mime = (asset.mime_type || "").trim().toLowerCase();
  if (/^(mic-recording-|tab-audio-)/i.test(name)) return false;
  if (/\.(mp4|mov|mkv)$/i.test(name)) return true;
  if (/\.webm$/i.test(name)) {
    return !mime.startsWith("audio/");
  }
  return mime.startsWith("video/");
}

export const GENERIC_PROJECT_TITLE_PLACEHOLDERS = new Set([
  "",
  "untitled",
  "untitled project",
  "untitled score",
  "untitled transcription",
  "new transcription",
  "scribasheet",
  "scribasheet transcription",
  "score",
]);

const SCORE_OR_MEDIA_EXT_RE =
  /\.(?:pdf|mxl|musicxml|xml|jpg|jpeg|png|webp|mid|midi|mp3|wav|webm|ogg|m4a|flac|aac)$/i;

const RECORDING_FILENAME_TITLE_RE =
  /^(?:tab[-_\s]?audio|mic[-_\s]?recording|recording)[-_\s]*\d+(?:[-_\s]*trimmed)?$/i;

export function deriveProjectTitleFromFilename(filename?: string | null): string {
  const base = (filename || "")
    .trim()
    .split(/[\\/]/)
    .pop()
    ?.replace(SCORE_OR_MEDIA_EXT_RE, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "";
  if (!base || GENERIC_PROJECT_TITLE_PLACEHOLDERS.has(base.toLowerCase())) {
    return "Untitled Score";
  }
  return base.slice(0, 120);
}

export function isPlaceholderProjectTitle(title?: string | null): boolean {
  const cleaned = (title || "").trim().replace(SCORE_OR_MEDIA_EXT_RE, "").trim().toLowerCase();
  if (GENERIC_PROJECT_TITLE_PLACEHOLDERS.has(cleaned)) return true;
  return RECORDING_FILENAME_TITLE_RE.test(cleaned);
}

export function resolveDisplayScoreTitle(projectTitle?: string | null): string {
  const cleaned = (projectTitle || "").trim().replace(SCORE_OR_MEDIA_EXT_RE, "").trim();
  if (!cleaned) return "Untitled Score";
  if (
    GENERIC_PROJECT_TITLE_PLACEHOLDERS.has(cleaned.toLowerCase()) ||
    RECORDING_FILENAME_TITLE_RE.test(cleaned)
  ) {
    return "Untitled Score";
  }
  return cleaned;
}

export function slugifyProjectTitle(projectTitle: string): string {
  const raw = (projectTitle || "").trim();
  if (!raw || isPlaceholderProjectTitle(raw)) {
    return "";
  }
  const normalized = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(SCORE_OR_MEDIA_EXT_RE, "");
  const asciiSafe = Array.from(normalized)
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
    .join("")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return asciiSafe.slice(0, 80).replace(/^_+|_+$/g, "");
}

export function buildRecordedAudioFilename(
  kind: "tab" | "mic",
  projectTitle?: string | null,
  extension = "webm",
  nowMs: number = Date.now(),
): string {
  const safeExt = (extension || "webm").trim().replace(/^\.+/, "").toLowerCase() || "webm";
  const slug = slugifyProjectTitle(projectTitle || "");
  if (slug) {
    return `${slug}.${safeExt}`;
  }
  const prefix = kind === "tab" ? "tab-audio" : "mic-recording";
  return `${prefix}-${nowMs}.${safeExt}`;
}

export function sanitizeDownloadTitle(title?: string | null, fallback = "Extracted Audio"): string {
  const withoutControls = Array.from(title || "")
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 32 || code === 127 ? " " : ch;
    })
    .join("");
  let cleaned = withoutControls.replace(/[<>:"/\\|?*;]+/g, " ");
  while (cleaned.includes("..")) {
    cleaned = cleaned.replace("..", " ");
  }
  cleaned = cleaned.replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "");
  const truncated = cleaned.slice(0, 100).replace(/[ .]+$/g, "");
  return truncated || fallback;
}

export const DEFAULT_APP_TIMEZONE = "Asia/Manila";

export function getAppTimeZone(): string {
  const configured = import.meta.env.VITE_APP_TIMEZONE?.trim();
  if (!configured) return DEFAULT_APP_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-PH", { timeZone: configured });
    return configured;
  } catch {
    return DEFAULT_APP_TIMEZONE;
  }
}

function parseUtcTimestamp(value?: string | null): Date | null {
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const normalized = hasTimezone ? trimmed : `${trimmed}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(
  value?: string | null,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = parseUtcTimestamp(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: getAppTimeZone(),
    dateStyle: "short",
    timeStyle: "medium",
    ...options,
  }).format(date);
}

export function formatDate(
  value?: string | null,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = parseUtcTimestamp(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: getAppTimeZone(),
    dateStyle: "medium",
    ...options,
  }).format(date);
}

export function formatTime(
  value?: string | null,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = parseUtcTimestamp(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: getAppTimeZone(),
    timeStyle: "medium",
    ...options,
  }).format(date);
}

export function formatLocalDateTime(value?: string | null): string {
  return formatDateTime(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function midiToNoteName(midi: number, keyFifths = 0): string {
  return spellMidiPitch(midi, keyFifths).label;
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export const SUPPORTED_INSTRUMENTS = [
  { id: "piano", label: "Piano" },
  { id: "acoustic_guitar", label: "Acoustic Guitar" },
  { id: "electric_guitar", label: "Electric Guitar" },
  { id: "bass_guitar", label: "Bass Guitar" },
  { id: "violin", label: "Violin" },
  { id: "viola", label: "Viola" },
  { id: "cello", label: "Cello" },
  { id: "double_bass", label: "Double Bass" },
  { id: "flute", label: "Flute" },
  { id: "clarinet", label: "Clarinet" },
  { id: "saxophone", label: "Saxophone" },
  { id: "trumpet", label: "Trumpet" },
  { id: "trombone", label: "Trombone" },
  { id: "drums", label: "Drums & Percussion" },
  { id: "vocals", label: "Vocals" },
  { id: "other", label: "Other / Unknown" },
] as const;

export const TRANSCRIPTION_MODES = [
  { id: "single_instrument", label: "Single Instrument", description: "Best accuracy for solo recordings" },
  { id: "piano", label: "Piano (Grand Staff)", description: "Context-aware RH & LH grand staff arrangement" },
  { id: "melody", label: "Lead Melody", description: "Monophonic treble melody with optional chord symbols" },
  { id: "piano_vocal", label: "Piano + Vocal", description: "Upper staff melody + lower staff playable piano accompaniment" },
  { id: "chords", label: "Chords & Harmony", description: "Polyphonic capture with chord detection" },
  { id: "vocal_melody", label: "Vocal Melody", description: "Optimized for singing & monophonic voice" },
  {
    id: "violin_solo",
    label: "Violin (Solo Monophonic)",
    description: "Single-staff treble monophonic violin transcription with vibrato handling (G3–E7)",
  },
  { id: "multi_instrument", label: "Multi-Instrument", description: "Experimental polyphonic mix capture" },
] as const;

export const PLAYABILITY_SMOOTHING_OPTIONS = [
  {
    id: "original",
    label: "Original Performance",
    description: "Preserve detected notes and timing with minimal smoothing.",
  },
  {
    id: "standard",
    label: "Standard (Recommended)",
    description: "Clean playable RH/LH voicings while keeping musical expression.",
  },
  {
    id: "simplified",
    label: "Simplified Playable Piano",
    description: "Cleaner chord voicings, melody focus, and comfortable hand spans for sight-reading.",
  },
] as const;

export const AUDIO_SOURCE_TYPES = [
  { id: "auto", label: "Automatic", description: "Detects whether the recording is a full vocal mix or solo instrumental." },
  { id: "full_song", label: "Full Song with Vocals", description: "Prioritizes separated vocal melody and harmonic accompaniment." },
  { id: "solo_piano", label: "Solo Piano / Instrumental", description: "Uses direct polyphonic transcription without vocal-stem routing." },
] as const;
