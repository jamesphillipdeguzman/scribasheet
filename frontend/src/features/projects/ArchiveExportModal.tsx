import { useEffect, useRef, useState } from "react";
import { Archive, AlertTriangle, CheckCircle2, Download, Loader2, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatBytes } from "@/lib/utils";
import { api, ApiError } from "@/services/api";
import type { ArchiveSummary, Project } from "@/types/api";

interface ArchiveExportModalProps {
  isOpen: boolean;
  project: Pick<Project, "id" | "title"> | null;
  onClose: () => void;
  onDeleteProject?: (projectId: string) => Promise<void> | void;
}

export function ArchiveExportModal({
  isOpen,
  project,
  onClose,
  onDeleteProject,
}: ArchiveExportModalProps) {
  const [includeAudio, setIncludeAudio] = useState(true);
  const [summary, setSummary] = useState<ArchiveSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadedInfo, setDownloadedInfo] = useState<{
    filename: string;
    sizeBytes: number;
    includedMedia: boolean;
  } | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!isOpen || !project) return;
    setIncludeAudio(true);
    setError(null);
    setDownloadedInfo(null);
    setConfirmDelete(false);
  }, [isOpen, project]);

  useEffect(() => {
    if (!isOpen || !project) return;
    let cancelled = false;
    setLoadingSummary(true);
    api
      .getProjectArchiveSummary(project.id, includeAudio)
      .then((res) => {
        if (!cancelled) setSummary(res);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingSummary(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, project, includeAudio]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !downloading && !deleting) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, downloading, deleting, onClose]);

  if (!isOpen || !project) return null;

  const handleDownloadArchive = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setDownloading(true);
    setError(null);
    try {
      const res = await api.downloadProjectArchive(project.id, project.title, includeAudio);
      setDownloadedInfo(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to generate .scribasheet archive.");
    } finally {
      busyRef.current = false;
      setDownloading(false);
    }
  };

  const handleExplicitDelete = async () => {
    if (!onDeleteProject || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await onDeleteProject(project.id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete cloud project.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Archive Project Session"
      data-testid="archive-export-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget && !downloading && !deleting) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-[#27273A] bg-[#11111B] p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Archive className="h-5 w-5 text-[#A78BFA]" />
            <h2 className="text-lg font-semibold text-[#F5F3FF]">Archive Session (.scribasheet)</h2>
          </div>
          <button
            type="button"
            onClick={() => !downloading && !deleting && onClose()}
            disabled={downloading || deleting}
            aria-label="Close archive modal"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-[#A1A1AA]">
          Export <span className="font-semibold text-[#F5F3FF]">{project.title}</span> into a portable{" "}
          <span className="font-mono text-[#A78BFA]">.scribasheet</span> backup archive with full canonical notation, settings, annotations, and SHA-256 checksums.
        </p>

        <div className="rounded-xl border border-[#27273A] bg-[#09090F] p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-[#F5F3FF]">Include Original Audio</div>
              <div className="text-xs text-[#A1A1AA]">
                Preserve uploaded or recorded audio inside this portable backup archive.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={includeAudio}
              aria-label="Include Original Audio"
              data-testid="modal-include-audio-toggle"
              onClick={() => setIncludeAudio((v) => !v)}
              disabled={downloading}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-[#27273A] transition-colors ${
                includeAudio ? "bg-[#7C3AED]" : "bg-[#27273A]"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  includeAudio ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {!includeAudio && (
            <div
              data-testid="archive-audio-excluded-warning"
              className="flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 p-2.5 text-xs text-amber-200"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300 mt-0.5" />
              <span>
                Excluding audio reduces archive size, but the original recording cannot be recovered or used for audio-based re-transcription.
              </span>
            </div>
          )}

          <div className="border-t border-[#27273A] pt-3 text-xs text-[#A1A1AA] space-y-1">
            {loadingSummary ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#A78BFA]" />
                Inspecting project contents...
              </div>
            ) : summary ? (
              <>
                <div className="flex justify-between">
                  <span>Notation &amp; Project State</span>
                  <span className="text-[#F5F3FF]">
                    {summary.has_score ? "Score, MusicXML, MIDI & settings" : "Project metadata"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Included Media Files</span>
                  <span className="text-[#F5F3FF]">
                    {summary.included_media_count > 0
                      ? `${summary.included_media_count} file(s) • ${formatBytes(summary.included_media_bytes)}`
                      : summary.available_media_count > 0
                        ? "Excluded (score-only archive)"
                        : "None stored"}
                  </span>
                </div>
              </>
            ) : null}
          </div>
        </div>

        {error && (
          <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
            {error}
          </div>
        )}

        {downloadedInfo && (
          <div
            data-testid="archive-export-success-banner"
            className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3.5 space-y-2.5 text-xs text-emerald-200"
          >
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold text-emerald-100">
                  Downloaded {downloadedInfo.filename} ({formatBytes(downloadedInfo.sizeBytes)})
                </div>
                <p>
                  Your archive has been downloaded. The original cloud project is still stored in ScribaSheet. Delete the cloud project separately if you want to reclaim its storage.
                </p>
              </div>
            </div>
            {onDeleteProject && (
              <div className="pt-1 flex flex-wrap items-center gap-2">
                {!confirmDelete ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    data-testid="post-archive-delete-prompt-btn"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete Cloud Project to Reclaim Storage...
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={deleting}
                      data-testid="post-archive-delete-confirm-btn"
                      onClick={() => void handleExplicitDelete()}
                    >
                      {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      Confirm Permanent Cloud Deletion
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                      Keep Cloud Project
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={downloading || deleting}>
            Close
          </Button>
          <Button
            type="button"
            disabled={downloading || deleting}
            data-testid="confirm-download-archive-btn"
            onClick={() => void handleDownloadArchive()}
          >
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {downloading ? "Building & Verifying Archive..." : "Download Archive (.scribasheet)"}
          </Button>
        </div>
      </div>
    </div>
  );
}
