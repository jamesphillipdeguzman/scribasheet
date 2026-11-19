import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, Download, FileText, Loader2, RefreshCw, Save, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ApiError, api } from "@/services/api";
import type { LyricsData, TranscriptionJob } from "@/types/api";

interface Props {
  projectId: string;
  projectTitle: string;
  hasMedia: boolean;
  activeJob: TranscriptionJob | null;
  onJobStarted?: (job: TranscriptionJob) => void;
  onSeek?: (sec: number) => void;
  onLyricsSaved?: () => void;
}

function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const mins = Math.floor(s / 60);
  const rem = (s % 60).toFixed(2).padStart(5, "0");
  return `${String(mins).padStart(2, "0")}:${rem}`;
}

export function LyricsPanel({
  projectId,
  projectTitle,
  hasMedia,
  activeJob,
  onJobStarted,
  onSeek,
  onLyricsSaved,
}: Props) {
  const [lyrics, setLyrics] = useState<LyricsData | null>(null);
  const [draftText, setDraftText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [useDemucs, setUseDemucs] = useState(true);
  const [selectedLang, setSelectedLang] = useState<string>("auto");
  const [selectedModel, setSelectedModel] = useState<string>("auto");
  const [showOriginal, setShowOriginal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadLyrics = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getLyrics(projectId);
      setLyrics(data);
      setDraftText(data.text || "");
      if (data.language) {
        setSelectedLang(data.language);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load lyrics.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLyrics();
  }, [projectId]);

  const isLyricsJobRunning = Boolean(
    activeJob &&
      activeJob.settings_json?.mode === "lyrics_transcription" &&
      !["completed", "failed", "cancelled"].includes(activeJob.status),
  );

  useEffect(() => {
    if (
      activeJob?.settings_json?.mode === "lyrics_transcription" &&
      activeJob.status === "completed"
    ) {
      loadLyrics();
    }
  }, [activeJob?.id, activeJob?.status]);

  const handleTranscribe = async () => {
    setError(null);
    setNotice(null);
    setStarting(true);
    try {
      const job = await api.transcribeLyrics(projectId, {
        enable_source_separation: useDemucs,
        whisper_model: selectedModel,
        language: selectedLang === "auto" ? null : selectedLang,
        force_overwrite: Boolean(lyrics?.manually_edited),
      });
      onJobStarted?.(job);
      setNotice("Lyrics recognition queued on local worker.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to start lyrics recognition.");
    } finally {
      setStarting(false);
    }
  };

  const handleSave = async () => {
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const updated = await api.updateLyrics(projectId, {
        text: draftText,
        language: lyrics?.language ?? null,
      });
      setLyrics(updated);
      setDraftText(updated.text);
      setNotice("Lyrics saved and synchronized.");
      onLyricsSaved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save lyrics.");
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(draftText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Clipboard access was denied.");
    }
  };

  const handleExport = async (fmt: "txt" | "timestamped_txt" | "srt") => {
    setError(null);
    try {
      const ext = fmt === "srt" ? "srt" : "txt";
      const suffix = fmt === "timestamped_txt" ? "_timestamped" : "";
      await api.exportLyrics(projectId, fmt, `${projectTitle || "lyrics"}${suffix}.${ext}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Lyrics export failed.");
    }
  };

  const hasContent = Boolean(draftText.trim() || (lyrics?.segments && lyrics.segments.length > 0));
  const isDirty = Boolean(lyrics && draftText !== (lyrics.text || ""));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#27273A] bg-[#09090F] p-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-[#F5F3FF]">
            <FileText className="h-4 w-4 text-[#A78BFA]" />
            <span>Song Lyrics</span>
            {lyrics?.language && (
              <span className="rounded bg-[#181825] px-2 py-0.5 text-[11px] uppercase text-[#A78BFA]">
                {lyrics.language}
              </span>
            )}
            {hasContent && lyrics && (
              <span className="rounded bg-[#181825] px-2 py-0.5 text-[11px] text-[#A1A1AA]">
                {lyrics.source_used === "vocals_stem" ? "Vocals Stem (Demucs)" : "Original Audio"}
              </span>
            )}
            {lyrics?.manually_edited && (
              <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">
                Edited
              </span>
            )}
          </div>
          <p className="text-xs text-[#71717A]">
            Recognizes sung lyrics with timestamps and embeds aligned syllables under the melody staff.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Lyrics Language"
            value={selectedLang}
            onChange={(e) => setSelectedLang(e.target.value)}
            className="h-8 rounded-lg border border-[#27273A] bg-[#11111B] px-2 text-xs text-[#F5F3FF]"
          >
            <option value="auto">Auto Language</option>
            <option value="tl">Tagalog (tl)</option>
            <option value="en">English (en)</option>
            <option value="es">Spanish (es)</option>
            <option value="ja">Japanese (ja)</option>
            <option value="ko">Korean (ko)</option>
          </select>
          <select
            aria-label="Whisper Model"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="h-8 rounded-lg border border-[#27273A] bg-[#11111B] px-2 text-xs text-[#F5F3FF]"
          >
            <option value="auto">Model: Auto</option>
            <option value="medium">Model: Medium</option>
            <option value="small">Model: Small</option>
            <option value="large-v3-turbo">Model: Large v3 Turbo</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-[#A1A1AA] cursor-pointer">
            <input
              type="checkbox"
              checked={useDemucs}
              onChange={(e) => setUseDemucs(e.target.checked)}
              className="accent-[#A78BFA]"
            />
            Use Demucs Vocals Stem
          </label>
          <Button
            size="sm"
            onClick={handleTranscribe}
            disabled={!hasMedia || starting || isLyricsJobRunning}
          >
            {starting || isLyricsJobRunning ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {isLyricsJobRunning ? `${activeJob?.current_stage || "Transcribing"} (${activeJob?.progress ?? 0}%)` : "Starting..."}
              </>
            ) : hasContent ? (
              <>
                <RefreshCw className="h-3.5 w-3.5" />
                Re-Transcribe Lyrics
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                Transcribe Lyrics
              </>
            )}
          </Button>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
          {notice}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10 text-xs text-[#A1A1AA]">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading lyrics...
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="lyrics-editor-textarea" className="text-xs font-medium text-[#A1A1AA]">
                Editable Lyrics Text
              </label>
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="ghost" onClick={handleCopy} disabled={!draftText.trim()}>
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button size="sm" variant="secondary" onClick={handleSave} disabled={saving || !isDirty}>
                  <Save className="h-3.5 w-3.5" />
                  {saving ? "Saving..." : "Save Edits"}
                </Button>
              </div>
            </div>
            <textarea
              id="lyrics-editor-textarea"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              rows={12}
              placeholder="Click Transcribe Lyrics to recognize sung lyrics, or paste/edit lyrics here..."
              className="w-full rounded-xl border border-[#27273A] bg-[#09090F] p-3 text-sm text-[#F5F3FF] leading-relaxed focus:border-[#8B5CF6] focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-[11px] text-[#71717A]">Export:</span>
              <Button size="sm" variant="outline" onClick={() => handleExport("txt")} disabled={!hasContent}>
                <Download className="h-3 w-3" /> .txt
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleExport("timestamped_txt")} disabled={!hasContent}>
                <Download className="h-3 w-3" /> Timestamped .txt
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleExport("srt")} disabled={!hasContent}>
                <Download className="h-3 w-3" /> .srt
              </Button>
              {lyrics?.manually_edited && lyrics.original_text && lyrics.original_text !== lyrics.text && (
                <button
                  type="button"
                  onClick={() => setShowOriginal((prev) => !prev)}
                  className="ml-auto text-[11px] text-[#A78BFA] hover:underline"
                >
                  {showOriginal ? "Hide Original Whisper Transcript" : "Compare Original Whisper Transcript"}
                </button>
              )}
            </div>
            {showOriginal && lyrics?.original_text && (
              <div className="rounded-xl border border-[#27273A] bg-[#11111B] p-3 space-y-1">
                <div className="text-[11px] font-medium text-[#A1A1AA]">
                  Original Whisper Transcript (for comparison)
                </div>
                <pre className="whitespace-pre-wrap text-xs text-[#A1A1AA] font-sans leading-relaxed">
                  {lyrics.original_text}
                </pre>
              </div>
            )}
            {lyrics?.alignment_uncertain_segments && lyrics.alignment_uncertain_segments.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] text-amber-200 flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>
                  {lyrics.alignment_uncertain_segments.length} lyric syllable(s) could not be matched cleanly to melody note onsets and were flagged for review.
                </span>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-[#A1A1AA]">
              Timestamped Segments ({lyrics?.segments?.length || 0})
            </div>
            <div className="max-h-[19rem] overflow-y-auto rounded-xl border border-[#27273A] bg-[#09090F] divide-y divide-[#1D1D2B]">
              {lyrics?.segments && lyrics.segments.length > 0 ? (
                lyrics.segments.map((seg) => (
                  <button
                    key={seg.id}
                    type="button"
                    onClick={() => onSeek?.(seg.start_sec)}
                    className="w-full text-left px-3 py-2.5 hover:bg-[#181825] transition-colors space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-[#A78BFA]">
                        [{formatTime(seg.start_sec)} → {formatTime(seg.end_sec)}]
                      </span>
                      {seg.needs_review && (
                        <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                          <AlertTriangle className="h-3 w-3" /> Needs Review
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[#F5F3FF]">{seg.text}</p>
                  </button>
                ))
              ) : (
                <div className="p-6 text-center text-xs text-[#71717A]">
                  No timestamped segments yet. Run lyrics recognition to inspect segment timings.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
