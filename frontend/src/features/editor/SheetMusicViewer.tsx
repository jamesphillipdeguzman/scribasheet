import { useEffect, useRef, useState } from "react";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/Button";

interface SheetMusicViewerProps {
  musicxml: string | null;
}

export function SheetMusicViewer({ musicxml }: SheetMusicViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const [zoom, setZoom] = useState(0.9);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);

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
        await osmd.load(musicxml);
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
  }, [musicxml, zoom]);

  if (!musicxml) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-[#27273A] bg-[#09090F] text-sm text-[#A1A1AA]">
        Upload and transcribe audio to render sheet music notation.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[#A1A1AA]">
          Sheet Music Notation (OpenSheetMusicDisplay)
        </span>
        <div className="flex items-center gap-1.5">
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

      <div className="relative overflow-x-auto rounded-xl border border-[#27273A] bg-[#F8FAFC] p-4 min-h-[280px]">
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
