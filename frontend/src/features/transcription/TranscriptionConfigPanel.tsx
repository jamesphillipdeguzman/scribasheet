import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, Clock, Loader2, Play, RotateCcw, Square } from "lucide-react";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SUPPORTED_INSTRUMENTS, TRANSCRIPTION_MODES } from "@/lib/utils";
import type { TranscriptionJob, TranscriptionSettings } from "@/types/api";

interface Props {
  hasMedia: boolean;
  activeJob: TranscriptionJob | null;
  workerOnline?: boolean | null;
  defaultInstrument: string;
  defaultMode: string;
  onStart: (settings: TranscriptionSettings) => void;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  isStarting: boolean;
}

export function TranscriptionConfigPanel({
  hasMedia,
  activeJob,
  workerOnline = null,
  defaultInstrument,
  defaultMode,
  onStart,
  onCancel,
  onRetry,
  isStarting,
}: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmOfflineQueue, setConfirmOfflineQueue] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [settings, setSettings] = useState<TranscriptionSettings>({
    mode: defaultMode || "single_instrument",
    instrument: defaultInstrument || "piano",
    tempo_mode: "auto",
    manual_tempo_bpm: 120,
    time_signature: "auto",
    key_signature: "auto",
    concert_pitch_hz: 440,
    transpose_semitones: 0,
    quantization: "sixteenth",
    onset_threshold: 0.5,
    frame_threshold: 0.3,
    min_note_length_ms: 58,
    min_midi_pitch: 21,
    max_midi_pitch: 108,
    enable_source_separation: false,
  });

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
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[#A1A1AA]">Transcription Mode</label>
          <select
            value={settings.mode}
            onChange={(e) => setSettings({ ...settings, mode: e.target.value })}
            className="w-full h-9 rounded-lg border border-[#27273A] bg-[#09090F] px-3 text-xs text-[#F5F3FF]"
          >
            {TRANSCRIPTION_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[#A1A1AA]">Instrument</label>
          <select
            value={settings.instrument}
            onChange={(e) => setSettings({ ...settings, instrument: e.target.value })}
            className="w-full h-9 rounded-lg border border-[#27273A] bg-[#09090F] px-3 text-xs text-[#F5F3FF]"
          >
            {SUPPORTED_INSTRUMENTS.map((inst) => (
              <option key={inst.id} value={inst.id}>
                {inst.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {settings.mode === "multi_instrument" && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Spotify Basic Pitch is strongest on solo instruments. Full-band multi-instrument recordings may produce merged polyphonic lines requiring manual cleanup.
          </span>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[#A1A1AA]">Tempo</label>
          <select
            value={settings.tempo_mode}
            onChange={(e) => setSettings({ ...settings, tempo_mode: e.target.value as "auto" | "manual" })}
            className="w-full h-9 rounded-lg border border-[#27273A] bg-[#09090F] px-2.5 text-xs text-[#F5F3FF]"
          >
            <option value="auto">Auto-detect</option>
            <option value="manual">Manual BPM</option>
          </select>
        </div>

        {settings.tempo_mode === "manual" && (
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#A1A1AA]">BPM</label>
            <input
              type="number"
              min={30}
              max={300}
              value={settings.manual_tempo_bpm || 120}
              onChange={(e) => setSettings({ ...settings, manual_tempo_bpm: Number(e.target.value) })}
              className="w-full h-9 rounded-lg border border-[#27273A] bg-[#09090F] px-2.5 text-xs text-[#F5F3FF]"
            />
          </div>
        )}

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[#A1A1AA]">Quantization</label>
          <select
            value={settings.quantization}
            onChange={(e) =>
              setSettings({ ...settings, quantization: e.target.value as TranscriptionSettings["quantization"] })
            }
            className="w-full h-9 rounded-lg border border-[#27273A] bg-[#09090F] px-2.5 text-xs text-[#F5F3FF]"
          >
            <option value="none">None (Raw timing)</option>
            <option value="eighth">1/8 Note</option>
            <option value="sixteenth">1/16 Note</option>
            <option value="thirtysecond">1/32 Note</option>
          </select>
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

      {showAdvanced && (
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
          <label className="sm:col-span-2 flex items-center gap-2 text-[#A1A1AA]">
            <input
              type="checkbox"
              checked={settings.enable_source_separation}
              onChange={(e) => setSettings({ ...settings, enable_source_separation: e.target.checked })}
              className="accent-[#A78BFA]"
            />
            Attempt stem separation if configured on worker
          </label>
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
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300 space-y-2">
              <p>{activeJob.error_message || "Transcription failed."}</p>
              <Button size="sm" variant="outline" onClick={() => onRetry(activeJob.id)} className="min-h-[40px]">
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
          {confirmOfflineQueue ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-3 text-xs">
              <p className="text-amber-100">
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
                  className="min-h-[44px]"
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
              {isStarting ? "Starting..." : activeJob?.status === "completed" ? "Re-Transcribe Audio" : "Start AI Transcription"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
