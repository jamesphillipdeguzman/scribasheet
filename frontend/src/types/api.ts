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
  project_limit?: number | null;
  file_count?: number;
  storage_used_bytes?: number;
  storage_used_mb: number;
  storage_limit_mb?: number | null;
  storage_quota_enforced?: boolean;
  storage_backend?: string;
  storage_status?: string;
  storage_volume_free_mb?: number | null;
  storage_volume_total_mb?: number | null;
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
  playability_smoothing?: "original" | "standard" | "simplified";
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
  satb_mode?: "auto_satb" | "keep_original";
  source_asset_ids?: string[] | null;
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
  status: "online" | "busy" | "stale" | "offline";
  last_seen_seconds: number | null;
  worker_id: string | null;
  active_job_id?: string | null;
  active_job_count: number;
  queue_depth: number;
  freshness_threshold_seconds: number;
  busy_stale_threshold_seconds?: number;
}

export interface ScoreNote {
  id: string;
  pitch_midi: number;
  onset_sec: number;
  offset_sec: number;
  raw_onset_sec?: number | null;
  raw_offset_sec?: number | null;
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
  format:
    | "midi"
    | "musicxml"
    | "mxl"
    | "pdf"
    | "wav"
    | "mp3"
    | "soprano_mp3"
    | "alto_mp3"
    | "tenor_mp3"
    | "bass_mp3"
    | "extracted_mp3"
    | "extracted_wav";
  status: string;
  error_message: string | null;
  download_url: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ExtractedAudioItem {
  id: string;
  format: "mp3" | "wav";
  filename: string;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  sample_rate: number | null;
  channels: number | null;
  download_url: string;
}

export interface ExtractAudioResponse {
  source_asset_id: string;
  mp3: ExtractedAudioItem | null;
  wav: ExtractedAudioItem | null;
  assets: MediaAsset[];
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
  reviewed?: boolean;
  edited?: boolean;
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

export interface ArchiveMediaFileSummary {
  filename: string;
  asset_type: string;
  mime_type: string;
  size_bytes: number;
}

export interface ArchiveSummary {
  project_id: string;
  title: string;
  source_type: string;
  has_score: boolean;
  include_audio: boolean;
  available_media_count: number;
  included_media_count: number;
  available_media_bytes: number;
  included_media_bytes: number;
  media_files: ArchiveMediaFileSummary[];
}

export interface ArchiveValidationPreview {
  valid: boolean;
  schema_version: number;
  archive_format_version: string;
  exported_at: string;
  original_project_id?: string | null;
  title: string;
  source_type: string;
  has_score: boolean;
  included_media: boolean;
  original_audio_omitted: boolean;
  media_count: number;
  total_media_bytes: number;
  included_files: string[];
  tempo_bpm?: number | null;
  time_signature?: string | null;
  key_signature?: string | null;
  note_count: number;
  chord_count: number;
  has_lyrics: boolean;
  checksums_verified: boolean;
  warnings?: string[];
}

export interface OmrProposedFix {
  action: "set_accidental" | "set_pitch" | "add_tie" | "add_fingering" | "add_pedal";
  part_id?: string | null;
  measure: number;
  staff?: number | null;
  voice?: string | null;
  note_index?: number | null;
  step?: string | null;
  alter?: number | null;
  octave?: number | null;
  fingering?: string | null;
  pedal_type?: "start" | "stop" | null;
}

export interface OmrFinding {
  id: string;
  source: "structural" | "ai_vision";
  page?: number | null;
  measure: number;
  part_id?: string | null;
  staff?: number | null;
  voice?: string | null;
  category: string;
  severity: "high" | "medium" | "low";
  description: string;
  confidence?: number | null;
  proposed_fix?: OmrProposedFix | null;
}

export interface OmrVerificationReport {
  omr_match_score: number;
  score_status: "preliminary" | "verified" | "ai_unavailable" | "ai_failed";
  structural_score: number;
  rhythm_validity_score: number;
  structural_consistency_score: number;
  ai_verified: boolean;
  ai_confidence: number | null;
  source_available: boolean;
  source_message?: string | null;
  formula_note: string;
  total_measures: number;
  valid_rhythm_measures: number;
  flagged_measures: number[];
  findings: OmrFinding[];
  content_hash: string;
  verified_at?: string | null;
  model_used?: string | null;
  ai_error?: string | null;
  applied_finding_ids: string[];
  can_revert: boolean;
}

export interface OmrVerificationStatusResponse {
  verification: OmrVerificationReport;
  gemini_configured: boolean;
  source_available: boolean;
  source_message?: string | null;
  can_revert: boolean;
  can_restore_previous: boolean;
}

export interface OmrApplyFixesResponse {
  score: ProjectScoreResponse;
  verification: OmrVerificationReport;
  applied_ids: string[];
  skipped_ids: string[];
}
