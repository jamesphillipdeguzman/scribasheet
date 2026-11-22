import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileAudio, FileMusic, FileText, Loader2, Music } from "lucide-react";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { formatLocalDateTime } from "@/lib/utils";
import { api, ApiError } from "@/services/api";
import type { ExportRecord } from "@/types/api";

interface ExportCenterProps {
  projectId: string;
  projectTitle: string;
  hasScore: boolean;
  isSatbScore?: boolean;
  showChordSymbols?: boolean;
  onToggleChordSymbols?: (value: boolean) => void;
}

type ExportFormatId =
  | "midi"
  | "musicxml"
  | "pdf"
  | "wav"
  | "soprano_mp3"
  | "alto_mp3"
  | "tenor_mp3"
  | "bass_mp3";

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
  hasScore,
  isSatbScore = false,
  showChordSymbols,
  onToggleChordSymbols,
}: ExportCenterProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [activeFmt, setActiveFmt] = useState<string | null>(null);
  const [localIncludeChords, setLocalIncludeChords] = useState<boolean>(true);
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

  const exportMutation = useMutation({
    mutationFn: async (fmt: ExportFormatId) => {
      setError(null);
      setActiveFmt(fmt);
      const record = await api.createExport(projectId, fmt, { include_chords: includeChords });
      if (record.download_url) {
        const satbItem = SATB_MP3_FORMATS.find((s) => s.id === fmt);
        const downloadName = satbItem
          ? satbItem.filename
          : `${projectTitle || "score"}${FORMATS.find((f) => f.id === fmt)?.ext || `.${fmt}`}`;
        await api.downloadExportBlob(record.download_url, downloadName);
      }
      return record;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["exports", projectId] });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Export failed.");
    },
    onSettled: () => setActiveFmt(null),
  });

  return (
    <div className="space-y-5">
      {!hasScore && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          Complete a transcription first to enable MIDI, MusicXML, PDF, and WAV exports.
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300" role="alert">
          {error}
        </div>
      )}

      {/* Export Options */}
      <div className="rounded-xl border border-[#27273A] bg-[#09090F] p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-0.5">
          <div className="text-sm font-medium text-[#FAFAFA]">Show Chord Symbols</div>
          <p className="text-xs text-[#A1A1AA]">
            Display automatically detected chord labels above the piano staff in the viewer, MusicXML, and PDF.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={includeChords}
          aria-label="Show Chord Symbols"
          onClick={() => setIncludeChords(!includeChords)}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-[#27273A] transition-colors focus:outline-none focus:ring-2 focus:ring-[#A78BFA]/60 ${
            includeChords ? "bg-[#7C3AED]" : "bg-[#27273A]"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              includeChords ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
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
              <Button
                size="sm"
                variant="secondary"
                disabled={!hasScore || loading}
                onClick={() => exportMutation.mutate(f.id)}
                className="w-full min-h-[44px]"
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {loading ? "Generating..." : `Export ${f.id.toUpperCase()}`}
              </Button>
            </div>
          );
        })}
      </div>

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
                    disabled={!hasScore || loading}
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
                      const ext = FORMATS.find((f) => f.id === ex.format)?.ext || `.${ex.format}`;
                      api.downloadExportBlob(ex.download_url!, `${projectTitle || "score"}${ext}`);
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
