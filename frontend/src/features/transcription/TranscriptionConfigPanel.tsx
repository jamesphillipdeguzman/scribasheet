import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, Clock, Loader2, Play, RotateCcw, Square } from "lucide-react";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  AUDIO_SOURCE_TYPES,
  PLAYABILITY_SMOOTHING_OPTIONS,
  SUPPORTED_INSTRUMENTS,
  TRANSCRIPTION_MODES,
} from "@/lib/utils";
import type { TranscriptionJob, TranscriptionSettings } from "@/types/api";

interface Props {
  hasMedia: boolean;
  isScoreFile?: boolean;
  hasScore?: boolean;
  activeJob: TranscriptionJob | null;
  workerOnline?: boolean | null;
  defaultInstrument: string;
  defaultMode: string;
  initialMode?: string;
  initialArrangementDetail?: "simple" | "balanced" | "detailed";
  initialPlayabilitySmoothing?: "original" | "standard" | "simplified";
  initialQuantization?: TranscriptionSettings["quantization"];
  onStart: (settings: TranscriptionSettings) => void;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  onRegenerateArrangement?: (
    arrangementDetail: "simple" | "balanced" | "detailed",
    quantization: TranscriptionSettings["quantization"],
    mode?: string,
    playabilitySmoothing?: "original" | "standard" | "simplified",
  ) => Promise<void> | void;
  isRegeneratingArrangement?: boolean;
  isStarting: boolean;
}

function normalizeModeId(mode?: string | null): string {
  const cleaned = (mode || "").trim().toLowerCase();
  if (!cleaned) return "single_instrument";
  if (cleaned === "lead_melody") return "melody";
  return cleaned;
}

export function TranscriptionConfigPanel({
  hasMedia,
  isScoreFile = false,
  hasScore = false,
  activeJob,
  workerOnline = null,
  defaultInstrument,
  defaultMode,
  initialMode,
  initialArrangementDetail,
  initialPlayabilitySmoothing,
  initialQuantization,
  onStart,
  onCancel,
  onRetry,
  onRegenerateArrangement,
  isRegeneratingArrangement = false,
  isStarting,
}: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmOfflineQueue, setConfirmOfflineQueue] = useState(false);
  const [quantizationManuallySet, setQuantizationManuallySet] = useState(false);
  const [modeManuallySet, setModeManuallySet] = useState(false);
  const [playabilityTouched, setPlayabilityTouched] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [settings, setSettings] = useState<TranscriptionSettings>({
    mode: normalizeModeId(initialMode || activeJob?.settings_json?.mode || defaultMode),
    instrument: defaultInstrument || "piano",
    arrangement_detail: initialArrangementDetail || activeJob?.settings_json?.arrangement_detail || "balanced",
    playability_smoothing:
      initialPlayabilitySmoothing || activeJob?.settings_json?.playability_smoothing || "standard",
    tempo_mode: "auto",
    manual_tempo_bpm: 120,
    time_signature: "auto",
    key_signature: "auto",
    concert_pitch_hz: 440,
    transpose_semitones: 0,
    quantization: initialQuantization || activeJob?.settings_json?.quantization || "sixteenth",
    onset_threshold: 0.5,
    frame_threshold: 0.3,
    min_note_length_ms: 58,
    min_midi_pitch: 21,
    max_midi_pitch: 108,
    enable_source_separation: activeJob?.settings_json?.enable_source_separation ?? false,
    audio_source_type: activeJob?.settings_json?.audio_source_type || "auto",
    satb_mode: activeJob?.settings_json?.satb_mode || "auto_satb",
  });

  const isScoreImport = Boolean(
    isScoreFile || (!hasMedia && normalizeModeId(settings.mode) === "satb_pdf"),
  );

  useEffect(() => {
    if (isScoreFile && normalizeModeId(settings.mode) !== "satb_pdf") {
      setSettings((prev) => ({
        ...prev,
        mode: "satb_pdf",
        enable_source_separation: false,
      }));
    } else if (!isScoreFile && hasMedia && normalizeModeId(settings.mode) === "satb_pdf") {
      setSettings((prev) => ({
        ...prev,
        mode: normalizeModeId(defaultMode) === "satb_pdf" ? "piano" : normalizeModeId(defaultMode),
      }));
    }
  }, [isScoreFile, hasMedia, defaultMode, settings.mode]);

  useEffect(() => {
    const restoredMode = initialMode || activeJob?.settings_json?.mode;
    const restoredDetail = initialArrangementDetail || activeJob?.settings_json?.arrangement_detail;
    const restoredSmoothing = initialPlayabilitySmoothing || activeJob?.settings_json?.playability_smoothing;
    const restoredQuant = initialQuantization || activeJob?.settings_json?.quantization;
    const restoredSourceType = activeJob?.settings_json?.audio_source_type;
    const restoredSep = activeJob?.settings_json?.enable_source_separation;
    if (
      restoredMode ||
      restoredDetail ||
      restoredSmoothing ||
      restoredQuant ||
      restoredSourceType !== undefined ||
      restoredSep !== undefined
    ) {
      setSettings((prev) => ({
        ...prev,
        ...(restoredMode ? { mode: normalizeModeId(restoredMode) } : {}),
        ...(restoredDetail ? { arrangement_detail: restoredDetail } : {}),
        ...(restoredSmoothing ? { playability_smoothing: restoredSmoothing } : {}),
        ...(restoredQuant ? { quantization: restoredQuant } : {}),
        ...(restoredSourceType ? { audio_source_type: restoredSourceType } : {}),
        ...(restoredSep !== undefined ? { enable_source_separation: restoredSep } : {}),
      }));
    }
  }, [
    initialMode,
    initialArrangementDetail,
    initialPlayabilitySmoothing,
    initialQuantization,
    activeJob?.settings_json?.mode,
    activeJob?.settings_json?.arrangement_detail,
    activeJob?.settings_json?.playability_smoothing,
    activeJob?.settings_json?.quantization,
    activeJob?.settings_json?.audio_source_type,
    activeJob?.settings_json?.enable_source_separation,
  ]);

  const currentScoreMode = normalizeModeId(initialMode || activeJob?.settings_json?.mode || defaultMode);
  const modeChangedSinceScore = Boolean(hasScore && normalizeModeId(settings.mode) !== currentScoreMode);

  const isRunning =
    activeJob &&
    !["completed", "failed", "cancelled"].includes(activeJob.status);
  const isQueued = activeJob?.status === "queued";
  const effectiveWorkerOnline = workerOnline ?? activeJob?.worker_online ?? null;
  const isWaitingOffline = Boolean(isQueued && effectiveWorkerOnline === false);

  useEffect(() => {
    if (!isQueued) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [isQueued]);

  const createdMs = activeJob?.created_at ? Date.parse(activeJob.created_at) : NaN;
  const waitedLong =
    isQueued && Number.isFinite(createdMs) && nowMs - createdMs >= 30000;

  const handlePrimaryClick = () => {
    if (effectiveWorkerOnline === false && !confirmOfflineQueue) {
      setConfirmOfflineQueue(true);
      return;
    }
    setConfirmOfflineQueue(false);
    onStart(settings);
  };

  return (
    <div className="space-y-4">
      {!isScoreImport && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="transcription-mode-select" className="block text-xs font-medium text-[#A1A1AA]">
              Output Arrangement
            </label>
            <select
              id="transcription-mode-select"
              value={settings.mode}
              onChange={(e) => {
                setModeManuallySet(true);
                setSettings({ ...settings, mode: e.target.value });
              }}
              className="w-full h-9 rounded-lg border border-[#27273A] bg-[#09090F] px-2 pr-6 text-[11px] text-[#F5F3FF]"
            >
              {TRANSCRIPTION_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-[#71717A]">
              {TRANSCRIPTION_MODES.find((m) => m.id === settings.mode)?.description}
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="instrument-select" className="block text-xs font-medium text-[#A1A1AA]">
              Instrument
            </label>
            <select
              id="instrument-select"
              value={settings.instrument}
              onChange={(e) => {
                const nextInst = e.target.value;
                setSettings((prev) => {
                  let nextMode = prev.mode;
                  if (!modeManuallySet && !hasScore) {
                    if (nextInst === "piano" && prev.mode === "single_instrument") {
                      nextMode = "piano";
                    } else if (nextInst !== "piano" && prev.mode === "piano") {
                      nextMode = "single_instrument";
                    }
                  }
                  return { ...prev, instrument: nextInst, mode: nextMode };
                });
              }}
              className="w-full h-9 rounded-lg border border-[#27273A] bg-[#09090F] px-2 pr-6 text-[11px] text-[#F5F3FF]"
            >
              {SUPPORTED_INSTRUMENTS.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {inst.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Score Import Mode vs Audio Source & Demucs Stem Separation */}
      {isScoreImport ? (
        <div className="space-y-1.5 rounded-lg border border-[#27273A] bg-[#09090F] p-3">
          <label htmlFor="satb-mode-select" className="block text-xs font-medium text-[#A1A1AA]">
            Score Processing Mode
          </label>
          <select
            id="satb-mode-select"
            value={settings.satb_mode || "auto_satb"}
            onChange={(e) =>
              setSettings({
                ...settings,
                mode: "satb_pdf",
                satb_mode: e.target.value as "auto_satb" | "keep_original",
                enable_source_separation: false,
              })
            }
            className="w-full h-9 rounded-lg border border-[#27273A] bg-[#11111B] px-3 text-xs text-[#F5F3FF]"
          >
            <option value="auto_satb">Auto-Detect SATB (Separate Voices)</option>
            <option value="keep_original">Keep Original Staves</option>
          </select>
          <p className="text-[11px] text-[#71717A]">
            MXL/MusicXML files parse directly without OMR; PDF files run OMR. Audio-only options like Demucs are hidden for score files.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="audio-source-select" className="block text-xs font-medium text-[#A1A1AA]">
              Audio Source
            </label>
            <select
              id="audio-source-select"
              value={settings.audio_source_type || "auto"}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  audio_source_type: e.target.value as TranscriptionSettings["audio_source_type"],
                })
              }
              className="w-full h-9 rounded-lg border border-[#27273A] bg-[#09090F] px-2 pr-6 text-[11px] text-[#F5F3FF]"
            >
              {AUDIO_SOURCE_TYPES.map((src) => (
                <option key={src.id} value={src.id}>
                  {src.label}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-[#71717A]">
              {AUDIO_SOURCE_TYPES.find((src) => src.id === (settings.audio_source_type || "auto"))?.description}
            </p>
          </div>

          <div className="space-y-1.5 min-w-0">
            <label htmlFor="demucs-separation-toggle" className="block text-xs font-medium text-[#A1A1AA]">
              Separate Audio Stems (Demucs)
            </label>
            <label
              htmlFor="demucs-separation-toggle"
              className="flex items-start gap-2 rounded-lg border border-stone-300 bg-white p-2.5 text-xs text-stone-800 cursor-pointer dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
            >
              <input
                id="demucs-separation-toggle"
                type="checkbox"
                checked={settings.enable_source_separation}
                onChange={(e) => setSettings({ ...settings, enable_source_separation: e.target.checked })}
                className="mt-0.5 shrink-0 accent-violet-600 dark:accent-[#A78BFA]"
              />
              <span className="leading-snug">
                {settings.enable_source_separation ? "On — Separate Vocals & Accompaniment" : "Off"}
              </span>
            </label>
            <p className="text-[11px] text-[#71717A]">
              Separates vocals, bass, drums, and other instruments before transcription. Recommended for full songs with vocals and accompaniment.
            </p>
          </div>
        </div>
      )}

      {settings.mode === "multi_instrument" && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Spotify Basic Pitch is strongest on solo instruments. Full-band multi-instrument recordings may produce merged polyphonic lines requiring manual cleanup.
          </span>
        </div>
      )}

      {!isScoreImport && (
        <>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
            <div className="space-y-1.5 min-w-0">
              <label htmlFor="tempo-mode-select" className="block text-xs font-medium text-[#A1A1AA]">Tempo</label>
              <select
                id="tempo-mode-select"
                value={settings.tempo_mode}
                onChange={(e) => setSettings({ ...settings, tempo_mode: e.target.value as "auto" | "manual" })}
                className="w-full min-w-0 h-9 rounded-lg border border-stone-300 bg-white px-2.5 pr-7 text-xs text-stone-900 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/20 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
              >
                <option value="auto">Auto-detect</option>
                <option value="manual">Manual BPM</option>
              </select>
            </div>

            {settings.tempo_mode === "manual" && (
              <div className="space-y-1.5 min-w-0">
                <label className="block text-xs font-medium text-[#A1A1AA]">BPM</label>
                <input
                  type="number"
                  min={30}
                  max={300}
                  value={settings.manual_tempo_bpm || 120}
                  onChange={(e) => setSettings({ ...settings, manual_tempo_bpm: Number(e.target.value) })}
                  className="w-full min-w-0 h-9 rounded-lg border border-stone-300 bg-white px-2.5 text-xs text-stone-900 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/20 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
                />
              </div>
            )}

            <div className="space-y-1.5 min-w-0">
              <label htmlFor="quantization-select" className="block text-xs font-medium text-[#A1A1AA]">
                Quantization
              </label>
              <select
                id="quantization-select"
                value={settings.quantization}
                onChange={(e) => {
                  setQuantizationManuallySet(true);
                  setSettings({ ...settings, quantization: e.target.value as TranscriptionSettings["quantization"] });
                }}
                className="w-full min-w-0 h-9 rounded-lg border border-stone-300 bg-white px-2.5 pr-7 text-xs text-stone-900 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/20 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
              >
                <option value="none">None (Raw timing)</option>
                <option value="quarter">1/4 Note</option>
                <option value="eighth">1/8 Note</option>
                <option value="eighth_triplet">1/8 Triplet</option>
                <option value="sixteenth">1/16 Note</option>
                <option value="thirtysecond">1/32 Note</option>
              </select>
            </div>
          </div>

          {/* Arrangement Detail & Playability Smoothing */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="arrangement-detail-select" className="block text-xs font-medium text-[#A1A1AA]">
                  Arrangement Detail
                </label>
                {hasScore && onRegenerateArrangement && (
                  <button
                    type="button"
                    disabled={isRegeneratingArrangement || modeChangedSinceScore}
                    title={
                      modeChangedSinceScore
                        ? "Transcription mode changed — click Re-Transcribe below to regenerate."
                        : undefined
                    }
                    onClick={() => {
                      const detail = settings.arrangement_detail || "balanced";
                      if (playabilityTouched || initialPlayabilitySmoothing !== undefined) {
                        onRegenerateArrangement(
                          detail,
                          settings.quantization,
                          settings.mode,
                          settings.playability_smoothing || "standard",
                        );
                      } else {
                        onRegenerateArrangement(detail, settings.quantization, settings.mode);
                      }
                    }}
                    className="text-xs font-medium text-[#A78BFA] hover:underline disabled:opacity-50"
                  >
                    {isRegeneratingArrangement ? "Updating..." : "Apply Arrangement"}
                  </button>
                )}
              </div>
              <select
                id="arrangement-detail-select"
                value={settings.arrangement_detail || "balanced"}
                onChange={(e) => {
                  const nextDetail = e.target.value as "simple" | "balanced" | "detailed";
                  setSettings((prev) => ({
                    ...prev,
                    arrangement_detail: nextDetail,
                    ...(!quantizationManuallySet
                      ? { quantization: nextDetail === "simple" ? "eighth" : "sixteenth" }
                      : {}),
                  }));
                }}
                className="w-full h-9 rounded-lg border border-stone-300 bg-white px-2.5 text-xs text-stone-900 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/20 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
              >
                <option value="simple">Simple / Syllabic</option>
                <option value="balanced">Balanced (Recommended)</option>
                <option value="detailed">Detailed / Solo</option>
              </select>
              <p className="text-[11px] text-[#71717A]">
                Controls note density, LH/RH complexity, and phrase continuity without changing the original audio.
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="playability-smoothing-select" className="block text-xs font-medium text-[#A1A1AA]">
                Playability Smoothing
              </label>
              <select
                id="playability-smoothing-select"
                value={settings.playability_smoothing || "standard"}
                onChange={(e) => {
                  setPlayabilityTouched(true);
                  setSettings((prev) => ({
                    ...prev,
                    playability_smoothing: e.target.value as "original" | "standard" | "simplified",
                  }));
                }}
                className="w-full h-9 rounded-lg border border-stone-300 bg-white px-2.5 text-xs text-stone-900 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/20 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
              >
                {PLAYABILITY_SMOOTHING_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-[#71717A]">
                {PLAYABILITY_SMOOTHING_OPTIONS.find(
                  (o) => o.id === (settings.playability_smoothing || "standard"),
                )?.description}
              </p>
            </div>
          </div>

          {/* Advanced Musical Settings Toggle */}
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-xs text-[#A78BFA] hover:underline"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
            Advanced Pitch &amp; Sensitivity Settings
          </button>
        </>
      )}

      {!isScoreImport && showAdvanced && (
        <div className="grid gap-3 sm:grid-cols-2 rounded-lg border border-[#27273A] bg-[#09090F] p-3 text-xs">
          <div className="space-y-1">
            <label className="text-[#A1A1AA]">Key Signature</label>
            <select
              value={settings.key_signature}
              onChange={(e) => setSettings({ ...settings, key_signature: e.target.value })}
              className="w-full h-8 rounded border border-[#27273A] bg-[#11111B] px-2"
            >
              <option value="auto">Auto-detect</option>
              {["C", "G", "D", "A", "E", "F", "Bb", "Eb", "Am", "Em", "Dm", "Gm"].map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[#A1A1AA]">Time Signature</label>
            <select
              value={settings.time_signature}
              onChange={(e) => setSettings({ ...settings, time_signature: e.target.value })}
              className="w-full h-8 rounded border border-[#27273A] bg-[#11111B] px-2"
            >
              <option value="auto">Auto (4/4 default)</option>
              <option value="4/4">4/4</option>
              <option value="3/4">3/4</option>
              <option value="6/8">6/8</option>
              <option value="2/4">2/4</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[#A1A1AA]">Onset Sensitivity ({settings.onset_threshold})</label>
            <input
              type="range"
              min={0.15}
              max={0.85}
              step={0.05}
              value={settings.onset_threshold}
              onChange={(e) => setSettings({ ...settings, onset_threshold: Number(e.target.value) })}
              className="w-full accent-[#A78BFA]"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[#A1A1AA]">Transpose (Semitones: {settings.transpose_semitones})</label>
            <input
              type="number"
              min={-24}
              max={24}
              value={settings.transpose_semitones}
              onChange={(e) => setSettings({ ...settings, transpose_semitones: Number(e.target.value) })}
              className="w-full h-8 rounded border border-[#27273A] bg-[#11111B] px-2"
            />
          </div>
        </div>
      )}

      {/* Action & Live Progress */}
      {isRunning && activeJob ? (
        <div
          className={`rounded-xl border p-4 space-y-3 ${
            isWaitingOffline
              ? "border-amber-500/30 bg-amber-500/10"
              : "border-[#A78BFA]/30 bg-[#181825]"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium min-w-0">
              {isQueued ? (
                <Clock className={`h-4 w-4 shrink-0 ${isWaitingOffline ? "text-amber-300" : "text-[#A78BFA]"}`} />
              ) : (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#A78BFA]" />
              )}
              <span className="truncate">
                {isWaitingOffline ? "Waiting for Desktop Worker" : activeJob.current_stage}
              </span>
            </div>
            <StatusBadge status={isWaitingOffline ? "waiting_for_worker" : activeJob.status} />
          </div>

          {isQueued ? (
            <p className="text-xs text-[#A1A1AA]">
              {isWaitingOffline
                ? "Your song is safely queued. ScribaSheet's desktop transcription worker is currently offline. Keep your Windows PC awake and the ScribaSheet worker running to begin transcription."
                : "Desktop transcription worker online. Your queued songs will be processed automatically."}
            </p>
          ) : (
            <div className="h-2 w-full rounded-full bg-[#09090F] overflow-hidden">
              <div
                className="h-full bg-[#8B5CF6] transition-all duration-300"
                style={{ width: `${activeJob.progress}%` }}
              />
            </div>
          )}

          {waitedLong && (
            <p className="text-xs text-amber-200">
              Still waiting for a desktop worker to claim this job. You can keep it queued or cancel below.
            </p>
          )}

          <div className="flex items-center justify-between gap-2 text-xs text-[#A1A1AA]">
            <span>{isQueued ? "Queued (not yet claimed)" : `${activeJob.progress}% complete`}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onCancel(activeJob.id)}
              className="min-h-[40px]"
            >
              <Square className="h-3 w-3 mr-1" />
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {activeJob?.status === "failed" && (
            <div
              data-testid="sidebar-job-error-card"
              className="rounded-lg bg-red-50 border border-red-300 p-3 text-xs space-y-2 dark:bg-red-500/10 dark:border-red-500/30"
            >
              <p className="text-red-900 font-medium break-words dark:text-red-200">
                {activeJob.error_message || "Transcription failed."}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={isStarting}
                onClick={() => onRetry(activeJob.id)}
                className="min-h-[40px] bg-white hover:bg-red-100/70 text-red-900 border border-red-300 font-semibold shadow-xs dark:bg-white/10 dark:hover:bg-white/15 dark:text-white dark:border-white/15"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Retry Job
              </Button>
            </div>
          )}
          {activeJob?.status === "cancelled" && (
            <div className="rounded-lg border border-[#27273A] bg-[#09090F] p-2.5 text-xs text-[#A1A1AA]">
              Previous transcription job was cancelled.
            </div>
          )}
          {modeChangedSinceScore && (
            <div className="rounded-lg border border-violet-300 bg-violet-50 p-2.5 text-xs text-violet-950 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200">
              Transcription mode changed — click{" "}
              <span className="font-semibold text-violet-700 dark:text-violet-300">
                {normalizeModeId(settings.mode) === "melody"
                  ? "Re-Transcribe in Lead Melody Mode"
                  : normalizeModeId(settings.mode) === "piano_vocal"
                    ? "Re-Transcribe in Piano + Vocal Mode"
                    : "Re-Transcribe Audio"}
              </span>{" "}
              below to apply the new mode.
            </div>
          )}
          {confirmOfflineQueue ? (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 space-y-3 text-xs dark:border-amber-500/30 dark:bg-amber-500/10">
              <p className="text-amber-950 dark:text-amber-200 font-medium">
                Desktop worker is currently offline. Queue this song to transcribe automatically when your Windows PC comes online?
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setConfirmOfflineQueue(false);
                    onStart(settings);
                  }}
                  disabled={isStarting}
                  className="flex-1 min-h-[44px]"
                >
                  Queue for Later
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmOfflineQueue(false)}
                  className="min-h-[44px] bg-white hover:bg-stone-100 text-stone-800 border border-stone-300 dark:bg-white/5 dark:hover:bg-white/10 dark:text-slate-300 dark:border-white/10"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              className="w-full min-h-[44px]"
              disabled={!hasMedia || isStarting}
              onClick={handlePrimaryClick}
            >
              <Play className="h-4 w-4" />
              {isStarting
                ? "Starting..."
                : isScoreImport
                  ? activeJob?.status === "completed"
                    ? "Re-Process Score"
                    : "Process Score & Separate Voices"
                  : modeChangedSinceScore && normalizeModeId(settings.mode) === "melody"
                    ? "Re-Transcribe in Lead Melody Mode"
                    : modeChangedSinceScore && normalizeModeId(settings.mode) === "piano_vocal"
                      ? "Re-Transcribe in Piano + Vocal Mode"
                      : activeJob?.status === "completed"
                        ? "Re-Transcribe Audio"
                        : "Start AI Transcription"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
