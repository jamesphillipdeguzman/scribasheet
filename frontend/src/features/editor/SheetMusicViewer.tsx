import { useEffect, useRef, useState } from "react";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/Button";

interface SheetMusicViewerProps {
  musicxml: string | null;
  showChordSymbols?: boolean;
  onToggleChordSymbols?: (value: boolean) => void;
}

export function stripHarmonyFromMusicXml(xml: string): string {
  if (typeof DOMParser !== "undefined" && typeof XMLSerializer !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      if (!doc.querySelector("parsererror")) {
        const harmonies = Array.from(doc.getElementsByTagName("harmony"));
        for (const el of harmonies) {
          el.parentNode?.removeChild(el);
        }
        return new XMLSerializer().serializeToString(doc);
      }
    } catch {
      // Fall back to regex removal below
    }
  }
  return xml.replace(/<harmony\b[^>]*>[\s\S]*?<\/harmony>/gi, "");
}

export function SheetMusicViewer({
  musicxml,
  showChordSymbols = true,
  onToggleChordSymbols,
}: SheetMusicViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const [zoom, setZoom] = useState(0.9);
  const [localShowChords, setLocalShowChords] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);

  const effectiveShowChords = onToggleChordSymbols ? showChordSymbols : localShowChords;
  const handleToggleChords = () => {
    const next = !effectiveShowChords;
    if (onToggleChordSymbols) {
      onToggleChordSymbols(next);
    } else {
      setLocalShowChords(next);
    }
  };

  useEffect(() => {
    if (!containerRef.current || !musicxml) return;

    let cancelled = false;
    setRenderError(null);
    setIsRendering(true);

    const renderScore = async () => {
      try {
        if (!osmdRef.current && containerRef.current) {
          osmdRef.current = new OpenSheetMusicDisplay(containerRef.current, {
            autoResize: true,
            backend: "svg",
            drawTitle: true,
            drawSubtitle: false,
            drawComposer: true,
            drawCredits: false,
            drawMeasureNumbers: true,
            measureNumberInterval: 4,
            drawingParameters: "default",
            pageBackgroundColor: "#F8FAFC",
          });
        }
        const osmd = osmdRef.current;
        if (!osmd) return;
        const rules = osmd.EngravingRules as unknown as Record<string, unknown> | undefined;
        if (rules && "RenderChordSymbols" in rules) {
          rules.RenderChordSymbols = effectiveShowChords;
        }
        const displayXml = effectiveShowChords ? musicxml : stripHarmonyFromMusicXml(musicxml);
        await osmd.load(displayXml);
        if (cancelled) return;
        osmd.Zoom = zoom;
        osmd.render();
      } catch (err) {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : "Could not render MusicXML notation.");
        }
      } finally {
        if (!cancelled) setIsRendering(false);
      }
    };

    renderScore();
    return () => {
      cancelled = true;
    };
  }, [musicxml, zoom, effectiveShowChords]);

  if (!musicxml) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-[#27273A] bg-[#09090F] text-sm text-[#A1A1AA]">
        Upload and transcribe audio to render sheet music notation.
      </div>
    );
  }

  return (
    <div className="space-y-3 w-full min-w-0 max-w-full">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-[#A1A1AA]">
          Sheet Music Notation (OpenSheetMusicDisplay)
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-label="Show chord symbols"
            aria-pressed={effectiveShowChords}
            onClick={handleToggleChords}
            className={`h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#A78BFA]/60 ${
              effectiveShowChords
                ? "border-[#A78BFA]/60 bg-[#7C3AED]/20 text-[#F5F3FF]"
                : "border-[#27273A] bg-[#11111B] text-[#A1A1AA] hover:text-[#F5F3FF]"
            }`}
          >
            Chords
          </button>
          <Button
            size="sm"
            variant="secondary"
            aria-label="Zoom out notation"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.1).toFixed(1))))}
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="w-12 text-center font-mono text-xs text-[#A1A1AA]">{Math.round(zoom * 100)}%</span>
          <Button
            size="sm"
            variant="secondary"
            aria-label="Zoom in notation"
            onClick={() => setZoom((z) => Math.min(1.6, Number((z + 0.1).toFixed(1))))}
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {renderError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
          {renderError}
        </div>
      )}

      <div className="relative w-full max-w-full overflow-x-auto rounded-xl border border-[#27273A] bg-[#F8FAFC] p-2 sm:p-4 min-h-[280px] touch-pan-x touch-pan-y">
        {isRendering && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 text-xs text-zinc-700">
            Rendering notation...
          </div>
        )}
        <div ref={containerRef} className="min-w-[560px]" />
      </div>
    </div>
  );
}
