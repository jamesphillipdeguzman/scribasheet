import { useState } from "react";
import { AlertTriangle, CheckCircle2, FileUp, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { validateAndParseImportJson } from "@/features/playlists/playlistStorage";
import type { PlaylistLibraryState } from "@/features/playlists/playlistTypes";

interface PlaylistImportExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApplyImport: (library: PlaylistLibraryState, mode: "merge" | "replace") => void;
}

export function PlaylistImportExportModal({
  isOpen,
  onClose,
  onApplyImport,
}: PlaylistImportExportModalProps) {
  const [rawFilename, setRawFilename] = useState<string | null>(null);
  const [parsedLibrary, setParsedLibrary] = useState<PlaylistLibraryState | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");

  if (!isOpen) return null;

  const handleFilePicked = async (file: File) => {
    setError(null);
    setWarnings([]);
    setParsedLibrary(null);
    setRawFilename(file.name);
    try {
      const text = typeof file.text === "function" ? await file.text() : await new Response(file).text();
      const res = validateAndParseImportJson(text);
      if (!res.valid) {
        setError(res.error);
        return;
      }
      setParsedLibrary(res.library);
      setWarnings(res.warnings);
    } catch {
      setError("Could not read the selected JSON file.");
    }
  };

  const trackCount = parsedLibrary
    ? parsedLibrary.playlists.reduce((sum, p) => sum + p.tracks.length, 0)
    : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Import Playlists JSON"
      data-testid="playlist-import-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-stone-300 bg-white p-5 text-stone-900 shadow-2xl space-y-4 dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Import Playlists (.json)</h2>
          <button
            type="button"
            aria-label="Close import modal"
            onClick={onClose}
            className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-100 dark:text-[#A1A1AA] dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-xs text-stone-600 dark:text-[#A1A1AA]">
          Restore or merge a portable ScribaSheet playlists JSON backup. Existing playlists remain untouched if validation fails.
        </p>

        <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-stone-300 bg-stone-50 p-4 text-center hover:border-violet-400 dark:border-[#27273A] dark:bg-[#09090F]">
          <FileUp className="mb-1.5 h-6 w-6 text-[#A78BFA]" />
          <span className="text-xs font-medium">
            {rawFilename ? rawFilename : "Choose ScribaSheet Playlists JSON file"}
          </span>
          <input
            type="file"
            accept=".json,application/json"
            data-testid="import-playlists-file-input"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFilePicked(f);
              e.currentTarget.value = "";
            }}
          />
        </label>

        {error && (
          <div
            role="alert"
            data-testid="import-playlists-error"
            className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {parsedLibrary && (
          <div className="space-y-3">
            <div
              data-testid="import-playlists-preview"
              className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-950 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200"
            >
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-semibold">
                  Validated schema v{parsedLibrary.schemaVersion}
                </div>
                <div>
                  Found {parsedLibrary.playlists.length} playlists ({trackCount} tracks) across{" "}
                  {parsedLibrary.categories.length} categories.
                </div>
              </div>
            </div>

            {warnings.map((w, idx) => (
              <p key={idx} className="text-[11px] text-amber-800 dark:text-amber-300">
                {w}
              </p>
            ))}

            <div className="space-y-1.5">
              <div className="text-xs font-medium">Import Mode</div>
              <label className="flex items-start gap-2 rounded-lg border border-stone-200 p-2 text-xs dark:border-[#27273A]">
                <input
                  type="radio"
                  name="playlist-import-mode"
                  checked={mode === "merge"}
                  onChange={() => setMode("merge")}
                  className="mt-0.5"
                />
                <span>
                  <strong>Merge safely (recommended):</strong> Keep existing playlists, rename conflicting titles, and deduplicate categories.
                </span>
              </label>
              <label className="flex items-start gap-2 rounded-lg border border-stone-200 p-2 text-xs dark:border-[#27273A]">
                <input
                  type="radio"
                  name="playlist-import-mode"
                  checked={mode === "replace"}
                  onChange={() => setMode("replace")}
                  className="mt-0.5"
                />
                <span>
                  <strong>Replace library:</strong> Replace current local playlists with the imported backup.
                </span>
              </label>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!parsedLibrary}
            data-testid="confirm-import-playlists-btn"
            onClick={() => {
              if (!parsedLibrary) return;
              onApplyImport(parsedLibrary, mode);
              onClose();
            }}
          >
            Import Playlists
          </Button>
        </div>
      </div>
    </div>
  );
}
