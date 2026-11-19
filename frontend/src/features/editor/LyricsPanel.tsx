import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileText,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ApiError, api } from "@/services/api";
import type { LyricSegment, LyricsData, TranscriptionJob } from "@/types/api";

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
  const [draftSegments, setDraftSegments] = useState<LyricSegment[]>([]);
  const [segmentFilter, setSegmentFilter] = useState<"all" | "needs_review">("all");
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [editingSegmentDraft, setEditingSegmentDraft] = useState("");
  const [segmentsDirty, setSegmentsDirty] = useState(false);
  const [boundaryMismatch, setBoundaryMismatch] = useState(false);

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
      setDraftSegments(data.segments || []);
      setSegmentsDirty(false);
      setBoundaryMismatch(false);
      setEditingSegmentId(null);
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

  const handleFullTextChange = (nextText: string) => {
    setDraftText(nextText);
    if (draftSegments.length === 0) return;

    const lines = nextText
      .split(/\r?\n/)
      .map((ln) => ln.trim())
      .filter(Boolean);

    if (lines.length === draftSegments.length) {
      setBoundaryMismatch(false);
      const updated = draftSegments.map((seg, i) => {
        const changed = lines[i] !== seg.text.trim();
        if (!changed) return seg;
        return {
          ...seg,
          text: lines[i],
          needs_review: false,
          reviewed: true,
          edited: true,
          words: [],
        };
      });
      setDraftSegments(updated);
      setSegmentsDirty(true);
    } else {
      setBoundaryMismatch(true);
      setDraftSegments((prev) =>
        prev.map((seg) => ({
          ...seg,
          needs_review: true,
        })),
      );
      setSegmentsDirty(true);
    }
  };

  const openInlineEditor = (seg: LyricSegment) => {
    setEditingSegmentId(seg.id);
    setEditingSegmentDraft(seg.text);
  };

  const cancelInlineEdit = () => {
    setEditingSegmentId(null);
    setEditingSegmentDraft("");
  };

  const commitInlineEdit = (segId: string) => {
    const trimmed = editingSegmentDraft.trim();
    if (!trimmed) {
      cancelInlineEdit();
      return;
    }
    const nextSegments = draftSegments.map((seg) => {
      if (seg.id !== segId) return seg;
      const textChanged = trimmed !== seg.text.trim();
      return {
        ...seg,
        text: trimmed,
        needs_review: false,
        reviewed: true,
        edited: Boolean(seg.edited || textChanged),
        words: textChanged ? [] : seg.words,
      };
    });
    setDraftSegments(nextSegments);
    setDraftText(nextSegments.map((s) => s.text).join("\n"));
    setSegmentsDirty(true);
    setBoundaryMismatch(false);
    setEditingSegmentId(null);
    setEditingSegmentDraft("");
  };

  const toggleSegmentNeedsReview = (segId: string) => {
    setDraftSegments((prev) =>
      prev.map((seg) =>
        seg.id === segId
          ? {
              ...seg,
              needs_review: !seg.needs_review,
              reviewed: seg.needs_review ? true : false,
            }
          : seg,
      ),
    );
    setSegmentsDirty(true);
  };

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
        segments: draftSegments,
        language: lyrics?.language ?? null,
      });
      setLyrics(updated);
      setDraftText(updated.text);
      setDraftSegments(updated.segments || []);
      setSegmentsDirty(false);
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

  const hasContent = Boolean(draftText.trim() || draftSegments.length > 0);
  const isDirty = Boolean(lyrics && (draftText !== (lyrics.text || "") || segmentsDirty));
  const totalCount = draftSegments.length;
  const needsReviewCount = draftSegments.filter((s) => Boolean(s.needs_review)).length;
  const visibleSegments =
    segmentFilter === "needs_review"
      ? draftSegments.filter((s) => Boolean(s.needs_review))
      : draftSegments;

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
              onChange={(e) => handleFullTextChange(e.target.value)}
              rows={12}
              placeholder="Click Transcribe Lyrics to recognize sung lyrics, or paste/edit lyrics here..."
              className="w-full rounded-xl border border-[#27273A] bg-[#09090F] p-3 text-sm text-[#F5F3FF] leading-relaxed focus:border-[#8B5CF6] focus:outline-none"
            />
            {boundaryMismatch && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200">
                Line count changed — existing segment timestamps were preserved and flagged for review.
              </div>
            )}
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-medium text-[#A1A1AA]">
                Timestamped Segments ({totalCount})
              </div>
              {totalCount > 0 && (
                <div className="inline-flex items-center gap-1 rounded-lg border border-[#27273A] bg-[#09090F] p-0.5 text-[11px]">
                  <button
                    type="button"
                    aria-pressed={segmentFilter === "all"}
                    onClick={() => setSegmentFilter("all")}
                    className={`rounded-md px-2 py-1 font-medium transition-colors ${
                      segmentFilter === "all"
                        ? "bg-[#8B5CF6] text-white"
                        : "text-[#A1A1AA] hover:text-[#F5F3FF]"
                    }`}
                  >
                    All ({totalCount})
                  </button>
                  <button
                    type="button"
                    aria-pressed={segmentFilter === "needs_review"}
                    onClick={() => setSegmentFilter("needs_review")}
                    className={`rounded-md px-2 py-1 font-medium transition-colors ${
                      segmentFilter === "needs_review"
                        ? "bg-amber-500/30 text-amber-200"
                        : "text-[#A1A1AA] hover:text-[#F5F3FF]"
                    }`}
                  >
                    Needs Review ({needsReviewCount})
                  </button>
                </div>
              )}
            </div>

            <div className="max-h-[21rem] overflow-y-auto rounded-xl border border-[#27273A] bg-[#09090F] divide-y divide-[#1D1D2B]">
              {visibleSegments.length > 0 ? (
                visibleSegments.map((seg) => {
                  const isEditingThis = editingSegmentId === seg.id;
                  return (
                    <div key={seg.id} className="px-3 py-2.5 space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => onSeek?.(seg.start_sec)}
                          aria-label={`Play from ${formatTime(seg.start_sec)}`}
                          title="Seek audio player to this timestamp and play"
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-[#A78BFA] hover:bg-[#181825] focus:outline-none focus:ring-1 focus:ring-[#8B5CF6]"
                        >
                          <Play className="h-2.5 w-2.5 fill-current" />
                          [{formatTime(seg.start_sec)} → {formatTime(seg.end_sec)}]
                        </button>

                        <div className="flex flex-wrap items-center gap-1.5">
                          {seg.needs_review ? (
                            <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                              <AlertTriangle className="h-3 w-3" /> Needs Review
                            </span>
                          ) : seg.edited ? (
                            <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-300">
                              Edited
                            </span>
                          ) : seg.reviewed ? (
                            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                              Reviewed
                            </span>
                          ) : null}

                          <button
                            type="button"
                            onClick={() => toggleSegmentNeedsReview(seg.id)}
                            className="rounded px-1.5 py-0.5 text-[10px] text-[#A1A1AA] hover:bg-[#181825] hover:text-[#F5F3FF]"
                          >
                            {seg.needs_review ? "Mark Reviewed" : "Flag Review"}
                          </button>

                          {!isEditingThis && (
                            <button
                              type="button"
                              aria-label={`Edit segment ${seg.id}`}
                              onClick={() => openInlineEditor(seg)}
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[#A78BFA] hover:bg-[#181825]"
                            >
                              <Pencil className="h-3 w-3" /> Edit
                            </button>
                          )}
                        </div>
                      </div>

                      {isEditingThis ? (
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          <input
                            type="text"
                            aria-label={`Inline edit ${seg.id}`}
                            value={editingSegmentDraft}
                            onChange={(e) => setEditingSegmentDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitInlineEdit(seg.id);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelInlineEdit();
                              }
                            }}
                            autoFocus
                            className="flex-1 min-w-[180px] h-8 rounded-lg border border-[#8B5CF6] bg-[#11111B] px-2.5 text-xs text-[#F5F3FF] focus:outline-none"
                          />
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => commitInlineEdit(seg.id)}
                          >
                            <Check className="h-3 w-3" /> Apply
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={cancelInlineEdit}
                          >
                            <X className="h-3 w-3" /> Cancel
                          </Button>
                        </div>
                      ) : (
                        <p
                          onClick={() => openInlineEditor(seg)}
                          title="Click to edit segment"
                          className="text-xs text-[#F5F3FF] cursor-text rounded px-1 py-0.5 hover:bg-[#181825]/60"
                        >
                          {seg.text}
                        </p>
                      )}
                    </div>
                  );
                })
              ) : totalCount > 0 && segmentFilter === "needs_review" ? (
                <div className="p-6 text-center text-xs text-emerald-300">
                  No segments need review. All {totalCount} segments are reviewed.
                </div>
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
