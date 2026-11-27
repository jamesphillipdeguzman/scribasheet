import { useCallback, useEffect, useRef, useState } from "react";
import { ArchiveRestore, CheckCircle2, FileCheck2, Loader2, ShieldCheck, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatBytes } from "@/lib/utils";
import { api, ApiError } from "@/services/api";
import type { ArchiveValidationPreview, Project } from "@/types/api";

interface ArchiveImportModalProps {
  isOpen: boolean;
  initialFile?: File | null;
  onClose: () => void;
  onRestored: (project: Project) => void;
}

export function ArchiveImportModal({
  isOpen,
  initialFile = null,
  onClose,
  onRestored,
}: ArchiveImportModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [validating, setValidating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<ArchiveValidationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSelectFile = useCallback(async (file: File) => {
    setSelectedFile(file);
    setPreview(null);
    setError(null);
    setValidating(true);
    try {
      const result = await api.validateArchive(file);
      setPreview(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Invalid or corrupted .scribasheet archive.");
    } finally {
      setValidating(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setSelectedFile(null);
      setPreview(null);
      setError(null);
      setValidating(false);
      setImporting(false);
      importingRef.current = false;
      return;
    }
    if (initialFile) {
      void handleSelectFile(initialFile);
    }
  }, [isOpen, initialFile, handleSelectFile]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !validating && !importing) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, validating, importing, onClose]);

  if (!isOpen) return null;

  const handleImportConfirm = async () => {
    if (!selectedFile || !preview?.valid || importingRef.current) return;
    importingRef.current = true;
    setImporting(true);
    setError(null);
    try {
      const project = await api.importArchive(selectedFile);
      onRestored(project);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to restore .scribasheet archive.");
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Import ScribaSheet Archive"
      data-testid="archive-import-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget && !validating && !importing) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-[#27273A] bg-[#11111B] p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <ArchiveRestore className="h-5 w-5 text-[#A78BFA]" />
            <h2 className="text-lg font-semibold text-[#F5F3FF]">Import Archive (.scribasheet)</h2>
          </div>
          <button
            type="button"
            onClick={() => !validating && !importing && onClose()}
            disabled={validating || importing}
            aria-label="Close import modal"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            if (validating || importing) return;
            const file = e.dataTransfer.files?.[0];
            if (file) void handleSelectFile(file);
          }}
          className={`rounded-xl border-2 border-dashed p-5 text-center transition-colors ${
            dragActive ? "border-[#A78BFA] bg-[#A78BFA]/10" : "border-[#27273A] bg-[#09090F]"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".scribasheet,.zip"
            data-testid="archive-file-input"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleSelectFile(f);
              e.target.value = "";
            }}
          />
          <Upload className="mx-auto h-7 w-7 text-[#A78BFA]" />
          <div className="mt-2 text-sm font-medium text-[#F5F3FF]">
            {selectedFile ? selectedFile.name : "Drag & drop a .scribasheet archive, or browse"}
          </div>
          <div className="mt-1 text-xs text-[#A1A1AA]">
            Restores the canonical editable score, project settings, annotations, and optional original audio into a new cloud project.
          </div>
          <div className="mt-3">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={validating || importing}
              onClick={() => fileInputRef.current?.click()}
            >
              Choose .scribasheet File
            </Button>
          </div>
        </div>

        {validating && (
          <div className="flex items-center gap-2 rounded-lg border border-[#27273A] bg-[#09090F] p-3 text-xs text-[#A1A1AA]">
            <Loader2 className="h-4 w-4 animate-spin text-[#A78BFA]" />
            Validating ZIP structure, MusicXML/MIDI payloads, and SHA-256 checksums...
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="archive-import-error"
            className="rounded-lg border border-red-500/35 bg-red-500/10 p-3 text-xs text-red-300"
          >
            {error}
          </div>
        )}

        {preview && (
          <div
            data-testid="archive-import-preview"
            className="rounded-xl border border-[#27273A] bg-[#09090F] p-4 space-y-3 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold text-sm text-[#F5F3FF] truncate">{preview.title}</div>
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300 shrink-0">
                <ShieldCheck className="h-3.5 w-3.5" />
                Verified • SHA-256 Valid
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[#A1A1AA]">
              <div>
                <span className="block text-[10px] uppercase tracking-wider">Source Type</span>
                <span className="text-[#F5F3FF]">{preview.source_type.replace(/_/g, " ")}</span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wider">Original Audio</span>
                <span className="text-[#F5F3FF]">
                  {preview.included_media
                    ? `Included (${preview.media_count} file(s), ${formatBytes(preview.total_media_bytes)})`
                    : preview.original_audio_omitted
                      ? "Excluded (score-only backup)"
                      : "None"}
                </span>
              </div>
              {preview.key_signature && (
                <div>
                  <span className="block text-[10px] uppercase tracking-wider">Musical Metadata</span>
                  <span className="text-[#F5F3FF]">
                    {preview.key_signature} • {preview.time_signature || "4/4"} • {Math.round(preview.tempo_bpm || 120)} BPM
                  </span>
                </div>
              )}
              <div>
                <span className="block text-[10px] uppercase tracking-wider">Score Contents</span>
                <span className="text-[#F5F3FF]">
                  {preview.note_count} notes • {preview.chord_count} chords
                  {preview.has_lyrics ? " • Lyrics" : ""}
                </span>
              </div>
            </div>

            <div className="border-t border-[#27273A] pt-2">
              <div className="text-[11px] text-[#A1A1AA] mb-1">
                Included Files ({preview.included_files.length}):
              </div>
              <div className="flex flex-wrap gap-1.5">
                {preview.included_files.map((fname) => (
                  <span
                    key={fname}
                    className="inline-flex items-center gap-1 rounded bg-[#181825] px-2 py-0.5 font-mono text-[10px] text-[#C4C4D4]"
                  >
                    <FileCheck2 className="h-3 w-3 text-[#A78BFA]" />
                    {fname}
                  </span>
                ))}
              </div>
            </div>

            {preview.warnings && preview.warnings.length > 0 && (
              <div className="rounded bg-amber-500/10 border border-amber-500/30 p-2 text-[11px] text-amber-200">
                {preview.warnings.join(" ")}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={validating || importing}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!preview?.valid || validating || importing}
            data-testid="confirm-import-archive-btn"
            onClick={() => void handleImportConfirm()}
          >
            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {importing ? "Restoring Project..." : "Restore Project"}
          </Button>
        </div>
      </div>
    </div>
  );
}
