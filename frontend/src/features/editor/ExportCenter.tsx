import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileAudio, FileMusic, FileText, Loader2, Music } from "lucide-react";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { api, ApiError } from "@/services/api";
import type { ExportRecord } from "@/types/api";

interface ExportCenterProps {
  projectId: string;
  projectTitle: string;
  hasScore: boolean;
}

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

export function ExportCenter({ projectId, projectTitle, hasScore }: ExportCenterProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [activeFmt, setActiveFmt] = useState<string | null>(null);

  const { data: exportsList = [] } = useQuery({
    queryKey: ["exports", projectId],
    queryFn: () => api.listExports(projectId),
  });

  const exportMutation = useMutation({
    mutationFn: async (fmt: "midi" | "musicxml" | "pdf" | "wav") => {
      setError(null);
      setActiveFmt(fmt);
      const record = await api.createExport(projectId, fmt);
      if (record.download_url) {
        const ext = FORMATS.find((f) => f.id === fmt)?.ext || `.${fmt}`;
        await api.downloadExportBlob(record.download_url, `${projectTitle || "score"}${ext}`);
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
                  <span className="text-[#71717A]">{new Date(ex.created_at).toLocaleString()}</span>
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
