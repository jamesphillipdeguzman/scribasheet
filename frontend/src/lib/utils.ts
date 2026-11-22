import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds) || seconds < 0) return "—";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function isScoreMediaAsset(
  asset?: { original_filename?: string | null; mime_type?: string | null } | null,
): boolean {
  if (!asset) return false;
  const mime = (asset.mime_type || "").toLowerCase();
  if (mime.includes("pdf") || mime.includes("musicxml")) return true;
  const name = (asset.original_filename || "").toLowerCase();
  return /\.(pdf|mxl|musicxml)$/i.test(name);
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

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function midiToNoteName(midi: number): string {
  const clamped = Math.max(0, Math.min(127, Math.round(midi)));
  const octave = Math.floor(clamped / 12) - 1;
  const name = NOTE_NAMES[clamped % 12];
  return `${name}${octave}`;
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
  { id: "piano", label: "Piano (Grand Staff)", description: "Splits treble & bass staves at middle C" },
  { id: "melody", label: "Lead Melody", description: "Monophonic treble melody with optional chord symbols" },
  { id: "piano_vocal", label: "Piano + Vocal", description: "Upper staff melody + lower staff playable piano accompaniment" },
  { id: "chords", label: "Chords & Harmony", description: "Polyphonic capture with chord detection" },
  { id: "vocal_melody", label: "Vocal Melody", description: "Optimized for singing & monophonic voice" },
  { id: "multi_instrument", label: "Multi-Instrument", description: "Experimental polyphonic mix capture" },
] as const;

export const AUDIO_SOURCE_TYPES = [
  { id: "auto", label: "Automatic", description: "Detects whether the recording is a full vocal mix or solo instrumental." },
  { id: "full_song", label: "Full Song with Vocals", description: "Prioritizes separated vocal melody and harmonic accompaniment." },
  { id: "solo_piano", label: "Solo Piano / Instrumental", description: "Uses direct polyphonic transcription without vocal-stem routing." },
] as const;
