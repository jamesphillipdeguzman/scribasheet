export interface User {
  id: string;
  email: string;
  display_name: string;
  email_verified: boolean;
  plan_tier: "free" | "pro" | "studio" | "unlimited" | string;
  is_unlimited?: boolean;
  plan_label?: string;
  created_at: string;
  updated_at: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  user: User;
}

export interface UsageSummary {
  plan_tier: string;
  plan_label?: string;
  is_unlimited?: boolean;
  monthly_minutes_used: number;
  monthly_minutes_limit: number;
  project_count: number;
  project_limit: number;
  storage_used_mb: number;
  storage_limit_mb: number;
}

export interface MediaAsset {
  id: string;
  project_id: string;
  asset_type: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  sample_rate: number | null;
  channels: number | null;
  created_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  title: string;
  description: string;
  status: "draft" | "processing" | "ready" | "failed" | string;
  instrument: string;
  transcription_mode: string;
  duration_seconds: number | null;
  created_at: string;
  updated_at: string;
  media_assets: MediaAsset[];
}

export interface ProjectListResponse {
  items: Project[];
  total: number;
  page: number;
  page_size: number;
}

export interface TranscriptionSettings {
  mode: string;
  instrument: string;
  arrangement_detail?: "simple" | "balanced" | "detailed";
  tempo_mode: "auto" | "manual";
  manual_tempo_bpm?: number | null;
  time_signature: string;
  key_signature: string;
  concert_pitch_hz: number;
  transpose_semitones: number;
  quantization: "none" | "quarter" | "eighth" | "eighth_triplet" | "sixteenth" | "thirtysecond";
  onset_threshold: number;
  frame_threshold: number;
  min_note_length_ms: number;
  min_midi_pitch: number;
  max_midi_pitch: number;
  enable_source_separation: boolean;
  audio_source_type?: "auto" | "full_song" | "solo_piano";
  demucs_model?: string;
  show_chord_symbols?: boolean;
}

export interface TranscriptionJob {
  id: string;
  project_id: string;
  user_id: string;
  source_asset_id: string | null;
  status:
    | "uploaded"
    | "queued"
    | "validating"
    | "preprocessing"
    | "separating"
    | "transcribing"
    | "generating_notation"
    | "finalizing"
    | "completed"
    | "failed"
    | "cancelled";
  progress: number;
  current_stage: string;
  engine: string;
  settings_json: TranscriptionSettings;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  worker_online?: boolean | null;
}

export interface WorkerStatus {
  worker_online: boolean;
  status: "online" | "offline";
  last_seen_seconds: number | null;
  worker_id: string | null;
  active_job_count: number;
  queue_depth: number;
  freshness_threshold_seconds: number;
}

export interface ScoreNote {
  id: string;
  pitch_midi: number;
  onset_sec: number;
  offset_sec: number;
  velocity: number;
  confidence?: number | null;
  track_index: number;
  string_num?: number | null;
  fret_num?: number | null;
}

export interface ScoreChord {
  id: string;
  measure: number;
  beat: number;
  onset_sec: number;
  symbol: string;
  root: string;
  quality: string;
  confidence?: number | null;
}

export interface ScoreTrack {
  index: number;
  name: string;
  instrument: string;
  clef: "treble" | "bass" | "grand";
  program: number;
  muted: boolean;
}

export interface ScoreData {
  title: string;
  tempo_bpm: number;
  tempo_estimated: boolean;
  time_signature: string;
  time_signature_estimated: boolean;
  key_signature: string;
  key_signature_estimated: boolean;
  duration_seconds: number;
  tracks: ScoreTrack[];
  notes: ScoreNote[];
  chords: ScoreChord[];
  analysis: Record<string, unknown>;
}

export interface ProjectScoreResponse {
  id: string;
  project_id: string;
  version: number;
  score_json: ScoreData;
  musicxml: string | null;
  updated_at: string;
}

export interface ExportRecord {
  id: string;
  project_id: string;
  format: "midi" | "musicxml" | "pdf" | "wav";
  status: string;
  error_message: string | null;
  download_url: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface LyricWord {
  text: string;
  start_sec: number;
  end_sec: number;
  confidence?: number | null;
  needs_review?: boolean;
}

export interface LyricSegment {
  id: string;
  text: string;
  start_sec: number;
  end_sec: number;
  confidence?: number | null;
  needs_review?: boolean;
  words: LyricWord[];
}

export interface LyricsData {
  text: string;
  segments: LyricSegment[];
  language: string | null;
  language_probability?: number | null;
  source_used: "vocals_stem" | "original_audio" | "manual";
  demucs_requested: boolean;
  demucs_fallback_used: boolean;
  model_name: string;
  device: string;
  has_word_timestamps: boolean;
  uncertain_segments: Array<Record<string, unknown>>;
  alignment_uncertain_segments?: Array<Record<string, unknown>>;
  original_text?: string | null;
  processing_metadata?: Record<string, unknown>;
  manually_edited: boolean;
  updated_at: string | null;
}
