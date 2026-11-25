import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileAudio, FileMusic, FileText, Loader2, Music, Printer } from "lucide-react";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/features/auth/AuthContext";
import { printScorePdf } from "@/lib/pdfPrint";
import { formatLocalDateTime, isVideoMediaAsset, sanitizeDownloadTitle } from "@/lib/utils";
import { api, ApiError } from "@/services/api";
import type { ExportRecord, MediaAsset } from "@/types/api";

interface ExportCenterProps {
  projectId: string;
  projectTitle: string;
  scoreTitle?: string | null;
  hasScore: boolean;
  isSatbScore?: boolean;
  uploadedVideoAsset?: MediaAsset | null;
  extractedAudioAssets?: MediaAsset[];
  onAudioExtracted?: () => void;
  showChordSymbols?: boolean;
  onToggleChordSymbols?: (value: boolean) => void;
  transcribedBy?: string;
  includeTranscribedBy?: boolean;
  onTranscribedByChange?: (value: string) => void;
  onToggleTranscribedBy?: (value: boolean) => void;
}

type ExportFormatId =
  | "midi"
  | "musicxml"
  | "pdf"
  | "wav"
  | "soprano_mp3"
  | "alto_mp3"
  | "tenor_mp3"
  | "bass_mp3"
  | "extracted_mp3"
  | "extracted_wav";

const SATB_MP3_FORMATS: Array<{
  id: "soprano_mp3" | "alto_mp3" | "tenor_mp3" | "bass_mp3";
  label: string;
  filename: string;
}> = [
    { id: "soprano_mp3", label: "Soprano", filename: "Soprano.mp3" },
    { id: "alto_mp3", label: "Alto", filename: "Alto.mp3" },
    { id: "tenor_mp3", label: "Tenor", filename: "Tenor.mp3" },
    { id: "bass_mp3", label: "Bass", filename: "Bass.mp3" },
  ];

const FORMATS: Array<{
  id: "midi" | "musicxml" | "pdf" | "wav";
  label: string;
  ext: string;
  desc: string;
  icon: typeof Music;
}> = [
    { id: "midi", label: "MIDI File", ext: ".mid", desc: "Standard MIDI for any DAW", icon: Music },
    { id: "musicxml", label: "MusicXML", ext: ".musicxml", desc: "MuseScore, Finale, Sibelius, Dorico", icon: FileMusic },
    { id: "pdf", label: "PDF Sheet Music", ext: ".pdf", desc: "Printable multi-page score", icon: FileText },
    { id: "wav", label: "WAV Audio", ext: ".wav", desc: "Synthesized playback render", icon: FileAudio },
  ];

export function ExportCenter({
  projectId,
  projectTitle,
  scoreTitle,
  hasScore,
  isSatbScore = false,
  uploadedVideoAsset = null,
  extractedAudioAssets = [],
  onAudioExtracted,
  showChordSymbols,
  onToggleChordSymbols,
  transcribedBy,
  includeTranscribedBy,
  onTranscribedByChange,
  onToggleTranscribedBy,
}: ExportCenterProps) {
  let user: { display_name?: string } | null = null;
  try {
    user = useAuth().user;
  } catch {
    user = null;
  }
  const queryClient = useQueryClient();
  const activeRequestRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFmt, setActiveFmt] = useState<string | null>(null);
  const [localIncludeChords, setLocalIncludeChords] = useState<boolean>(true);
  const DEFAULT_TRANSCRIBED_BY = "James De Guzman";
  const [localTranscribedBy, setLocalTranscribedBy] = useState<string>(
    () => user?.display_name?.trim() || DEFAULT_TRANSCRIBED_BY,
  );
  const [localIncludeTranscribedBy, setLocalIncludeTranscribedBy] = useState<boolean>(true);
  const [creditInteracted, setCreditInteracted] = useState<boolean>(false);

  useEffect(() => {
    if (transcribedBy === undefined && !localTranscribedBy) {
      setLocalTranscribedBy(user?.display_name?.trim() || DEFAULT_TRANSCRIBED_BY);
    }
  }, [user?.display_name, transcribedBy, localTranscribedBy]);

  const effectiveTranscribedBy = transcribedBy ?? localTranscribedBy;
  const setEffectiveTranscribedBy = (val: string) => {
    setCreditInteracted(true);
    if (onTranscribedByChange) {
      onTranscribedByChange(val);
    } else {
      setLocalTranscribedBy(val);
    }
  };
  const effectiveIncludeTranscribedBy = includeTranscribedBy ?? localIncludeTranscribedBy;
  const setEffectiveIncludeTranscribedBy = (val: boolean) => {
    setCreditInteracted(true);
    if (onToggleTranscribedBy) {
      onToggleTranscribedBy(val);
    } else {
      setLocalIncludeTranscribedBy(val);
    }
  };

  const includeChords = showChordSymbols ?? localIncludeChords;
  const setIncludeChords = (next: boolean) => {
    if (onToggleChordSymbols) {
      onToggleChordSymbols(next);
    } else {
      setLocalIncludeChords(next);
    }
  };

  const { data: exportsList = [] } = useQuery({
    queryKey: ["exports", projectId],
    queryFn: () => api.listExports(projectId),
  });

  const buildExportOptions = () => {
    const shouldSendCredit = creditInteracted || transcribedBy !== undefined || includeTranscribedBy === false;
    return {
      include_chords: includeChords,
      ...(shouldSendCredit
        ? {
          transcribed_by: effectiveTranscribedBy,
          include_transcribed_by: effectiveIncludeTranscribedBy,
        }
        : {}),
    };
  };

  const exportMutation = useMutation({
    mutationFn: async (fmt: ExportFormatId) => {
      if (activeRequestRef.current) return null;
      activeRequestRef.current = true;
      setError(null);
      setActiveFmt(fmt);
      try {
        const record = await api.createExport(projectId, fmt, buildExportOptions());
        if (record.download_url) {
          const satbItem = SATB_MP3_FORMATS.find((s) => s.id === fmt);
          let downloadName: string;
          if (satbItem) {
            downloadName = satbItem.filename;
          } else if (fmt === "extracted_mp3" || fmt === "extracted_wav") {
            const ext = fmt === "extracted_mp3" ? "mp3" : "wav";
            downloadName = `${sanitizeDownloadTitle(projectTitle)}.${ext}`;
          } else {
            downloadName = `${projectTitle || "score"}${FORMATS.find((f) => f.id === fmt)?.ext || `.${fmt}`}`;
          }
          await api.downloadExportBlob(record.download_url, downloadName);
        }
        return record;
      } finally {
        activeRequestRef.current = false;
      }
    },
    onSuccess: (_record, fmt) => {
      queryClient.invalidateQueries({ queryKey: ["exports", projectId] });
      if (fmt === "extracted_mp3" || fmt === "extracted_wav") {
        queryClient.invalidateQueries({ queryKey: ["project", projectId] });
        onAudioExtracted?.();
      }
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Export failed.");
    },
    onSettled: () => setActiveFmt(null),
  });

  const hasUploadedVideo = Boolean(uploadedVideoAsset && isVideoMediaAsset(uploadedVideoAsset));
  const titleBase = sanitizeDownloadTitle(projectTitle);
  const existingExtractedMp3 = extractedAudioAssets.find(
    (a) => a.mime_type === "audio/mpeg" || a.original_filename.toLowerCase().endsWith(".mp3"),
  );
  const existingExtractedWav = extractedAudioAssets.find(
    (a) => a.mime_type === "audio/wav" || a.original_filename.toLowerCase().endsWith(".wav"),
  );

  const printMutation = useMutation({
    mutationFn: async () => {
      setError(null);
      setActiveFmt("print_pdf");
      const { blob } = await api.generateScorePdfBlob(projectId, buildExportOptions());
      await printScorePdf(blob);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["exports", projectId] });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to prepare PDF for printing.");
    },
    onSettled: () => setActiveFmt(null),
  });

  return (
    <div className="space-y-5">
      {!hasScore && (
        <div
          data-testid="export-center-amber-notice"
          className="rounded-lg bg-amber-50 border border-amber-300 p-3 text-xs text-amber-950 font-medium dark:bg-amber-500/10 dark:border-amber-500/30 dark:text-amber-200"
        >
          Complete a transcription first to enable MIDI, MusicXML, PDF, and WAV exports.
        </div>
      )}
      {error && (
        <div
          className="rounded-lg bg-red-50 border border-red-300 p-3 text-xs text-red-900 font-medium dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* Export Options */}
      <div className="rounded-xl border border-[#27273A] bg-[#09090F] p-4 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <div className="text-sm text-stone-900 font-semibold dark:text-white">Show Chord Symbols</div>
            <p className="text-xs text-stone-600 dark:text-slate-400">
              Display automatically detected chord labels above the piano staff in the viewer, MusicXML, and PDF.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={includeChords}
            aria-label="Show Chord Symbols"
            onClick={() => setIncludeChords(!includeChords)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-[#27273A] transition-colors focus:outline-none focus:ring-2 focus:ring-[#A78BFA]/60 ${includeChords ? "bg-[#7C3AED]" : "bg-[#27273A]"
              }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${includeChords ? "translate-x-6" : "translate-x-1"
                }`}
            />
          </button>
        </div>

        <div className="border-t border-[#27273A] pt-3 space-y-2.5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <label htmlFor="export-transcribed-by" className="text-sm text-stone-900 font-semibold dark:text-white">
                Transcribed by / Arranger Credit
              </label>
              <p className="text-xs text-stone-600 dark:text-slate-400">
                Included on Page 1 of exported MusicXML and PDF scores when enabled.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={effectiveIncludeTranscribedBy}
              aria-label="Include Transcribed by credit"
              onClick={() => setEffectiveIncludeTranscribedBy(!effectiveIncludeTranscribedBy)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-[#27273A] transition-colors focus:outline-none focus:ring-2 focus:ring-[#A78BFA]/60 ${effectiveIncludeTranscribedBy ? "bg-[#7C3AED]" : "bg-[#27273A]"
                }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${effectiveIncludeTranscribedBy ? "translate-x-6" : "translate-x-1"
                  }`}
              />
            </button>
          </div>
          <input
            id="export-transcribed-by"
            type="text"
            aria-label="Transcribed by / Arranger Credit"
            placeholder="Enter arranger or transcriber name..."
            value={effectiveTranscribedBy}
            disabled={!effectiveIncludeTranscribedBy}
            onChange={(e) => setEffectiveTranscribedBy(e.target.value)}
            className="w-full h-9 rounded-lg border border-stone-300 bg-white px-3 text-xs text-stone-900 placeholder:text-stone-400 focus:border-violet-500 focus:outline-none disabled:opacity-50 dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF] dark:placeholder:text-[#71717A]"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 min-w-0">
        {FORMATS.map((f) => {
          const Icon = f.icon;
          const loading = activeFmt === f.id;

          return (
            <div key={f.id} className="min-w-0 rounded-xl border border-[#27273A] bg-[#09090F] p-4 flex flex-col justify-between space-y-3">
              <div>
                <div className="flex items-center justify-between">
                  <Icon className="h-5 w-5 text-[#A78BFA]" />
                  <span className="font-mono text-xs text-[#A1A1AA]">{f.ext}</span>
                </div>
                <div className="mt-2 font-semibold text-sm">{f.label}</div>
                <div className="text-xs text-[#A1A1AA]">{f.desc}</div>
              </div>
              <div className="space-y-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!hasScore || activeFmt !== null}
                  onClick={() => exportMutation.mutate(f.id)}
                  className="w-full min-h-[44px]"
                >
                  {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  {loading ? "Generating..." : `Export ${f.id.toUpperCase()}`}
                </Button>
                {f.id === "pdf" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!hasScore || activeFmt !== null}
                    onClick={() => printMutation.mutate()}
                    className="w-full min-h-[40px]"
                  >
                    {activeFmt === "print_pdf" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Printer className="h-3.5 w-3.5" />
                    )}
                    {activeFmt === "print_pdf" ? "Preparing..." : "Print Sheet Music"}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {hasUploadedVideo && (
        <div data-testid="export-center-extracted-audio" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-[#A1A1AA]">
              Extracted Video Audio
            </h3>
            <span className="text-[11px] text-[#71717A]">
              Extracted from {uploadedVideoAsset?.original_filename} • Original video preserved
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 min-w-0">
            {(
              [
                {
                  id: "extracted_mp3" as const,
                  label: `${titleBase}.mp3`,
                  ext: ".mp3",
                  desc: "44.1 kHz • 192 kbps MP3 (libmp3lame)",
                  buttonLabel: existingExtractedMp3 ? "Download MP3" : "Extract & Download MP3",
                },
                {
                  id: "extracted_wav" as const,
                  label: `${titleBase}.wav`,
                  ext: ".wav",
                  desc: "44.1 kHz • 16-bit PCM WAV",
                  buttonLabel: existingExtractedWav ? "Download WAV" : "Extract & Download WAV",
                },
              ] as const
            ).map((item) => {
              const loading = activeFmt === item.id;
              return (
                <div
                  key={item.id}
                  className="min-w-0 rounded-xl border border-[#27273A] bg-[#09090F] p-4 flex flex-col justify-between space-y-3"
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <FileAudio className="h-5 w-5 text-[#A78BFA]" />
                      <span className="font-mono text-xs text-[#A1A1AA]">{item.ext}</span>
                    </div>
                    <div className="mt-2 font-semibold text-sm truncate">{item.label}</div>
                    <div className="text-xs text-[#A1A1AA]">{item.desc}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={activeFmt !== null}
                    onClick={() => exportMutation.mutate(item.id)}
                    className="w-full min-h-[44px]"
                  >
                    {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    {loading ? "Extracting..." : item.buttonLabel}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {isSatbScore && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wider text-[#A1A1AA]">
              Individual SATB Rehearsal MP3s
            </h3>
            <span className="text-[11px] text-[#71717A]">
              Each track isolates one vocal part with all other voices muted
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 min-w-0">
            {SATB_MP3_FORMATS.map((s) => {
              const loading = activeFmt === s.id;

              return (
                <div
                  key={s.id}
                  className="min-w-0 rounded-xl border border-[#27273A] bg-[#09090F] p-3 flex flex-col justify-between space-y-2.5"
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <FileAudio className="h-4 w-4 text-[#A78BFA]" />
                      <span className="font-mono text-[11px] text-[#A1A1AA]">.mp3</span>
                    </div>
                    <div className="mt-1.5 font-semibold text-sm">{s.filename}</div>
                    <div className="text-[11px] text-[#A1A1AA]">{s.label} solo track</div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!hasScore || activeFmt !== null}
                    onClick={() => exportMutation.mutate(s.id)}
                    className="w-full"
                  >
                    {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    {loading ? "Rendering..." : `Export ${s.label}`}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Export History */}
      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-[#A1A1AA]">Export History</h3>
        {exportsList.length === 0 ? (
          <p className="text-xs text-[#71717A]">No exports generated for this project yet.</p>
        ) : (
          <div className="space-y-2">
            {exportsList.map((ex: ExportRecord) => (
              <div
                key={ex.id}
                className="flex items-center justify-between rounded-lg border border-[#27273A] bg-[#11111B] px-3 py-2 text-xs"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono uppercase text-[#A78BFA]">{ex.format}</span>
                  <StatusBadge status={ex.status} />
                  <span className="text-[#71717A]">{formatLocalDateTime(ex.completed_at || ex.created_at)}</span>
                </div>
                {ex.download_url && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const satb = SATB_MP3_FORMATS.find((s) => s.id === ex.format);
                      let filename: string;
                      if (satb) {
                        filename = satb.filename;
                      } else if (ex.format === "extracted_mp3" || ex.format === "extracted_wav") {
                        filename = `${titleBase}.${ex.format === "extracted_mp3" ? "mp3" : "wav"}`;
                      } else {
                        const ext = FORMATS.find((f) => f.id === ex.format)?.ext || `.${ex.format}`;
                        filename = `${projectTitle || "score"}${ext}`;
                      }
                      void api.downloadExportBlob(ex.download_url!, filename);
                    }}
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
