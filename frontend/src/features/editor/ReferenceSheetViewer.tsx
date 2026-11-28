import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  FileUp,
  Maximize,
  RefreshCw,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

const MAX_REFERENCE_FILE_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp"]);
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface LoadedReferenceFile {
  name: string;
  size: number;
  kind: "pdf" | "image";
  objectUrl: string;
  pageCount: number;
}

interface ReferenceSheetViewerProps {
  onClose: () => void;
}

function getFileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") {
    return file.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error("Unable to read file buffer."));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read file."));
    reader.readAsArrayBuffer(file);
  });
}

function matchesMagicBytes(bytes: Uint8Array, kind: "pdf" | "image"): boolean {
  if (bytes.length < 4) return false;
  if (kind === "pdf") {
    // Allow leading ASCII whitespace before %PDF-
    const head = new TextDecoder("ascii", { fatal: false }).decode(bytes.slice(0, 16)).trimStart();
    return head.startsWith("%PDF-");
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  // WEBP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true;
  }
  return false;
}

function estimatePdfPageCount(buffer: ArrayBuffer): number {
  try {
    const sample = new Uint8Array(buffer.slice(0, Math.min(buffer.byteLength, 2 * 1024 * 1024)));
    const text = new TextDecoder("latin1", { fatal: false }).decode(sample);
    const pageMatches = text.match(/\/Type\s*\/Page\b(?!s)/g);
    if (pageMatches && pageMatches.length > 0) {
      return pageMatches.length;
    }
    const countMatch = text.match(/\/Type\s*\/Pages[\s\S]{0,120}?\/Count\s+(\d+)/);
    if (countMatch) {
      const parsed = Number.parseInt(countMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // Fallback safely to 1 page if PDF is compressed/object-streamed
  }
  return 1;
}

export function ReferenceSheetViewer({ onClose }: ReferenceSheetViewerProps) {
  const [loaded, setLoaded] = useState<LoadedReferenceFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);
  const [zoom, setZoom] = useState<number>(1);
  const [fitToWidth, setFitToWidth] = useState<boolean>(true);
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeUrlRef = useRef<string | null>(null);

  const revokeActiveUrl = useCallback(() => {
    if (activeUrlRef.current) {
      try {
        URL.revokeObjectURL(activeUrlRef.current);
      } catch {
        // Ignore cleanup errors
      }
      activeUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      revokeActiveUrl();
    };
  }, [revokeActiveUrl]);

  const handleClear = useCallback(() => {
    revokeActiveUrl();
    setLoaded(null);
    setError(null);
    setPage(1);
    setZoom(1);
    setFitToWidth(true);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [revokeActiveUrl]);

  const processSelectedFile = useCallback(
    async (file: File) => {
      setError(null);

      const ext = getFileExtension(file.name || "");
      const mime = (file.type || "").toLowerCase();
      const validExt = ALLOWED_EXTENSIONS.has(ext);
      const validMime = !mime || ALLOWED_MIME_TYPES.has(mime);

      if (!validExt || (!validMime && ext !== ".pdf" && !ALLOWED_EXTENSIONS.has(ext))) {
        setError(
          `Unsupported file format "${file.name}". Please choose a PDF, JPG, JPEG, PNG, or WebP sheet music file.`,
        );
        return;
      }

      if (!Number.isFinite(file.size) || file.size <= 0) {
        setError(`Selected file "${file.name}" is empty.`);
        return;
      }
      if (file.size > MAX_REFERENCE_FILE_BYTES) {
        setError(`Selected file "${file.name}" exceeds the 50 MB local reference limit.`);
        return;
      }

      const kind: "pdf" | "image" = ext === ".pdf" || mime === "application/pdf" ? "pdf" : "image";

      let buffer: ArrayBuffer;
      try {
        buffer = await readFileAsArrayBuffer(file);
      } catch {
        setError(`Unable to read "${file.name}" from disk.`);
        return;
      }

      const headBytes = new Uint8Array(buffer.slice(0, 32));
      if (!matchesMagicBytes(headBytes, kind)) {
        setError(
          `File "${file.name}" does not contain valid ${kind === "pdf" ? "PDF" : "image (JPG/PNG/WebP)"} content.`,
        );
        return;
      }

      const pageCount = kind === "pdf" ? estimatePdfPageCount(buffer) : 1;
      const nextUrl = URL.createObjectURL(file);

      revokeActiveUrl();
      activeUrlRef.current = nextUrl;

      setLoaded({
        name: file.name || (kind === "pdf" ? "reference.pdf" : "reference-image"),
        size: file.size,
        kind,
        objectUrl: nextUrl,
        pageCount,
      });
      setPage(1);
      setZoom(1);
      setFitToWidth(true);
    },
    [revokeActiveUrl],
  );

  const openPicker = () => {
    fileInputRef.current?.click();
  };

  const pdfSrc =
    loaded && loaded.kind === "pdf"
      ? `${loaded.objectUrl}#page=${page}&${fitToWidth ? "view=FitH" : `zoom=${Math.round(zoom * 100)}`}`
      : undefined;

  return (
    <section
      data-testid="reference-sheet-viewer"
      aria-label="Reference Sheet Music"
      className="flex h-full min-h-[420px] flex-col rounded-xl border border-stone-300 bg-white text-stone-900 dark:border-[#27273A] dark:bg-[#0D0D16] dark:text-[#F5F3FF] overflow-hidden"
    >
      <input
        ref={fileInputRef}
        type="file"
        data-testid="reference-file-input"
        aria-label="Select local reference sheet music file"
        accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) {
            void processSelectedFile(picked);
          }
          e.currentTarget.value = "";
        }}
      />

      {/* Viewer Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 bg-stone-50 px-3 py-2 text-xs dark:border-[#27273A] dark:bg-[#11111B]">
        <div className="flex items-center gap-2 min-w-0">
          <FileSpreadsheet className="h-4 w-4 shrink-0 text-violet-600 dark:text-[#A78BFA]" />
          <span className="font-semibold whitespace-nowrap">Reference Sheet</span>
          {loaded && (
            <span
              data-testid="reference-filename"
              title={loaded.name}
              className="truncate max-w-[160px] rounded bg-stone-200/80 px-2 py-0.5 text-[11px] font-medium text-stone-800 dark:bg-white/10 dark:text-slate-200"
            >
              {loaded.name}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1 shrink-0">
          {loaded && (
            <>
              {loaded.kind === "pdf" && (
                <div className="inline-flex items-center gap-1 rounded-md border border-stone-300 bg-white px-1 py-0.5 dark:border-[#27273A] dark:bg-[#181825]">
                  <button
                    type="button"
                    aria-label="Previous PDF page"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="rounded p-0.5 text-stone-700 hover:bg-stone-100 disabled:opacity-40 dark:text-slate-200 dark:hover:bg-white/10"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <span
                    data-testid="reference-page-indicator"
                    className="px-1 text-[11px] font-mono tabular-nums whitespace-nowrap"
                  >
                    Page {page} / {loaded.pageCount}
                  </span>
                  <button
                    type="button"
                    aria-label="Next PDF page"
                    disabled={page >= loaded.pageCount}
                    onClick={() => setPage((p) => Math.min(loaded.pageCount, p + 1))}
                    className="rounded p-0.5 text-stone-700 hover:bg-stone-100 disabled:opacity-40 dark:text-slate-200 dark:hover:bg-white/10"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              <button
                type="button"
                aria-label="Zoom out reference"
                onClick={() => {
                  setFitToWidth(false);
                  setZoom((z) => Math.max(0.5, Number((z - 0.15).toFixed(2))));
                }}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-stone-300 bg-white text-stone-700 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#181825] dark:text-slate-200 dark:hover:bg-white/10"
                title="Zoom Out"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <span
                data-testid="reference-zoom-label"
                className="min-w-[44px] text-center font-mono text-[11px] text-stone-700 dark:text-slate-300"
              >
                {fitToWidth ? "Fit" : `${Math.round(zoom * 100)}%`}
              </span>
              <button
                type="button"
                aria-label="Zoom in reference"
                onClick={() => {
                  setFitToWidth(false);
                  setZoom((z) => Math.min(3.0, Number((z + 0.15).toFixed(2))));
                }}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-stone-300 bg-white text-stone-700 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#181825] dark:text-slate-200 dark:hover:bg-white/10"
                title="Zoom In"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-pressed={fitToWidth}
                onClick={() => setFitToWidth((v) => !v)}
                className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium ${
                  fitToWidth
                    ? "border-violet-500 bg-violet-50 text-violet-900 dark:border-violet-400 dark:bg-violet-500/20 dark:text-violet-200"
                    : "border-stone-300 bg-white text-stone-700 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#181825] dark:text-slate-200"
                }`}
              >
                <Maximize className="h-3 w-3" />
                Fit Width
              </button>
              <button
                type="button"
                data-testid="reference-replace-btn"
                onClick={openPicker}
                title="Replace local reference file"
                className="inline-flex h-7 items-center gap-1 rounded-md border border-stone-300 bg-white px-2 text-[11px] font-medium text-stone-700 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#181825] dark:text-slate-200 dark:hover:bg-white/10"
              >
                <RefreshCw className="h-3 w-3" />
                Replace
              </button>
              <button
                type="button"
                data-testid="reference-clear-btn"
                onClick={handleClear}
                title="Clear reference file"
                className="inline-flex h-7 items-center gap-1 rounded-md border border-stone-300 bg-white px-2 text-[11px] font-medium text-red-700 hover:bg-red-50 dark:border-[#27273A] dark:bg-[#181825] dark:text-red-300 dark:hover:bg-red-500/15"
              >
                <Trash2 className="h-3 w-3" />
                Clear
              </button>
            </>
          )}
          <button
            type="button"
            data-testid="reference-close-btn"
            aria-label="Close reference sheet"
            onClick={onClose}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-stone-300 bg-white px-2 text-[11px] font-medium text-stone-700 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#181825] dark:text-slate-200 dark:hover:bg-white/10"
          >
            <X className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Close</span>
          </button>
        </div>
      </div>

      {/* Validation Error Banner */}
      {error && (
        <div
          role="alert"
          data-testid="reference-sheet-error"
          className="m-3 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">{error}</div>
        </div>
      )}

      {/* Content Area */}
      {!loaded ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingOver(true);
          }}
          onDragLeave={() => setIsDraggingOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDraggingOver(false);
            const dropped = e.dataTransfer?.files?.[0];
            if (dropped) {
              void processSelectedFile(dropped);
            }
          }}
          className={`m-3 flex flex-1 flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
            isDraggingOver
              ? "border-violet-500 bg-violet-50/70 dark:bg-violet-500/10"
              : "border-stone-300 bg-stone-50/70 dark:border-[#27273A] dark:bg-[#11111B]/60"
          }`}
        >
          <FileUp className="h-8 w-8 text-violet-600 dark:text-[#A78BFA] mb-2" />
          <h3 className="text-sm font-semibold">Load Local Reference Sheet Music</h3>
          <p className="mt-1 max-w-xs text-xs text-stone-600 dark:text-[#A1A1AA]">
            Open a PDF, JPG, JPEG, PNG, or WebP score side-by-side while writing in MIDI Playground.
          </p>
          <p className="mt-1 text-[11px] text-stone-500 dark:text-[#71717A]">
            Rendered locally in your browser — never uploaded or stored on the server.
          </p>
          <button
            type="button"
            data-testid="reference-select-btn"
            onClick={openPicker}
            className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg bg-violet-600 px-3 text-xs font-semibold text-white hover:bg-violet-700"
          >
            <FileUp className="h-3.5 w-3.5" />
            Select File (PDF or Image)
          </button>
        </div>
      ) : loaded.kind === "pdf" ? (
        <div className="flex-1 min-h-[380px] bg-stone-100 dark:bg-[#09090F]">
          <iframe
            key={pdfSrc}
            data-testid="reference-pdf-frame"
            title={`Reference PDF: ${loaded.name}`}
            src={pdfSrc}
            className="h-full min-h-[460px] w-full border-0"
          />
        </div>
      ) : (
        <div
          data-testid="reference-image-scroll"
          className="flex-1 min-h-[380px] max-h-[680px] overflow-auto bg-stone-100 p-3 dark:bg-[#09090F]"
        >
          <img
            data-testid="reference-image-preview"
            src={loaded.objectUrl}
            alt={`Reference sheet: ${loaded.name}`}
            style={
              fitToWidth
                ? { width: "100%", height: "auto" }
                : { width: `${Math.round(zoom * 100)}%`, maxWidth: "none", height: "auto" }
            }
            className="mx-auto block rounded shadow-sm bg-white"
          />
        </div>
      )}
    </section>
  );
}
