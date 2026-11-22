import { useEffect, useMemo, useRef, useState } from "react";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { Maximize2, Minimize2, Pause, Play, Square, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  getCascadeTrackPalette,
  resolveTrackVoiceRole,
} from "@/features/editor/cascadeUtils";
import { midiSynth } from "@/features/editor/midiSynth";
import {
  buildMusicXmlTimeline,
  timeSecToWholeNotes,
  wholeNotesToTimeSec,
} from "@/features/editor/musicXmlTimeline";
import type { ScoreTrack } from "@/types/api";

interface SheetMusicViewerProps {
  musicxml: string | null;
  showChordSymbols?: boolean;
  onToggleChordSymbols?: (value: boolean) => void;
  playheadSec?: number;
  isPlaying?: boolean;
  tempoBpm?: number;
  tracks?: ScoreTrack[];
  satbSoloVoice?: string | null;
  satbMutedVoices?: Record<string, boolean>;
  onTogglePlay?: () => void;
  onStopPlay?: () => void;
  onSeek?: (sec: number) => void;
  isFocusMode?: boolean;
  onToggleFocusMode?: () => void;
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
  playheadSec = 0,
  isPlaying = false,
  tempoBpm = 120,
  tracks = [],
  satbSoloVoice = null,
  satbMutedVoices = {},
  onTogglePlay,
  onStopPlay,
  onSeek,
  isFocusMode = false,
  onToggleFocusMode,
}: SheetMusicViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const highlightedSvgRef = useRef<Array<{ el: Element; origFill: string | null }>>([]);
  const lastCursorWholeRef = useRef<number>(-1);
  const [zoom, setZoom] = useState(0.9);
  const [localShowChords, setLocalShowChords] = useState(true);
  const [followCursor, setFollowCursor] = useState(true);
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

  const timeline = useMemo(
    () => buildMusicXmlTimeline(musicxml, tempoBpm),
    [musicxml, tempoBpm],
  );

  const clearNoteheadHighlights = () => {
    for (const item of highlightedSvgRef.current) {
      if (item.origFill === null) {
        item.el.removeAttribute("fill");
      } else {
        item.el.setAttribute("fill", item.origFill);
      }
    }
    highlightedSvgRef.current = [];
  };

  const syncCursorToSeconds = (sec: number, shouldScroll: boolean) => {
    const osmd = osmdRef.current;
    if (!osmd || !osmd.cursor) return;
    const cursor = osmd.cursor;
    const targetWhole = timeSecToWholeNotes(timeline, sec, tempoBpm);

    if (Math.abs(targetWhole - lastCursorWholeRef.current) < 0.002 && sec > 0) {
      return;
    }

    try {
      if (!cursor.iterator) return;
      cursor.show();

      const curReal = cursor.iterator.currentTimeStamp?.RealValue ?? 0;
      if (sec <= 0.01 || targetWhole < curReal - 0.001) {
        cursor.reset();
      }

      let guard = 0;
      while (
        !cursor.iterator.EndReached &&
        (cursor.iterator.currentTimeStamp?.RealValue ?? 0) < targetWhole - 0.004 &&
        guard < 4000
      ) {
        cursor.next();
        guard++;
      }
      cursor.update();
      lastCursorWholeRef.current = cursor.iterator.currentTimeStamp?.RealValue ?? targetWhole;

      // Highlight sounding noteheads with SATB colors respecting Solo/Mute
      clearNoteheadHighlights();
      const gNotes = typeof cursor.GNotesUnderCursor === "function" ? cursor.GNotesUnderCursor() : [];
      for (const gn of gNotes) {
        const svgEl =
          typeof (gn as unknown as { getSVGGElement?: () => Element | null }).getSVGGElement === "function"
            ? (gn as unknown as { getSVGGElement: () => Element | null }).getSVGGElement()
            : null;
        if (!svgEl) continue;

        const staffIdx =
          (gn as unknown as { sourceNote?: { ParentStaffEntry?: { ParentStaff?: { idInMusicSheet?: number } } } })
            .sourceNote?.ParentStaffEntry?.ParentStaff?.idInMusicSheet ?? 0;
        const track = tracks[staffIdx];
        const role = resolveTrackVoiceRole(track);
        const isMuted = role !== "other" ? Boolean(satbMutedVoices[role]) : Boolean(track?.muted);
        if (isMuted) continue;
        if (satbSoloVoice && role !== satbSoloVoice) continue;

        const palette = getCascadeTrackPalette(track, staffIdx);
        const noteheadTargets = svgEl.querySelectorAll("path, ellipse");
        const els = noteheadTargets.length > 0 ? Array.from(noteheadTargets) : [svgEl];
        for (const el of els) {
          highlightedSvgRef.current.push({ el, origFill: el.getAttribute("fill") });
          el.setAttribute("fill", palette.fill);
        }
      }

      if (shouldScroll && followCursor && cursor.cursorElement && typeof cursor.cursorElement.scrollIntoView === "function") {
        cursor.cursorElement.scrollIntoView({
          block: "nearest",
          inline: "nearest",
          behavior: "smooth",
        });
      }
    } catch {
      // Ignore OSMD cursor boundary exceptions during re-render
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
            followCursor: true,
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
        lastCursorWholeRef.current = -1;
        osmd.cursor?.reset();
        if (playheadSec > 0 || isPlaying) {
          syncCursorToSeconds(playheadSec, false);
        } else {
          osmd.cursor?.show();
          osmd.cursor?.update();
        }
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
      clearNoteheadHighlights();
    };
  }, [musicxml, zoom, effectiveShowChords]);

  // Clean up OSMD instance and autoResize listeners on unmount
  useEffect(() => {
    return () => {
      clearNoteheadHighlights();
      try {
        (osmdRef.current as unknown as { Dispose?: () => void } | null)?.Dispose?.();
      } catch {
        // Ignore dispose errors
      }
      osmdRef.current = null;
    };
  }, []);

  // Keep cursor synced to playheadSec when paused/seeking
  useEffect(() => {
    if (isRendering) return;
    if (!isPlaying) {
      syncCursorToSeconds(playheadSec, false);
    }
  }, [playheadSec, isPlaying, isRendering, satbSoloVoice, satbMutedVoices, timeline]);

  // Smooth rAF cursor tracking synced to authoritative playback clock while playing
  useEffect(() => {
    if (!isPlaying || isRendering) return;
    let rafId: number | null = null;
    const tick = () => {
      const clock = midiSynth.getPlaybackClock();
      const sec = clock.isPlaying ? clock.currentSec : playheadSec;
      syncCursorToSeconds(sec, true);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [isPlaying, isRendering, followCursor, satbSoloVoice, satbMutedVoices, timeline, playheadSec]);

  const handleScoreClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek || !osmdRef.current || !containerRef.current) return;
    const measureList = osmdRef.current.GraphicSheet?.MeasureList;
    if (!measureList || measureList.length === 0) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const clickX = e.clientX - containerRect.left;
    const clickY = e.clientY - containerRect.top;

    // OSMD coordinates are in 10px units * zoom
    const scale = 10 * zoom;
    const osmdX = clickX / scale;
    const osmdY = clickY / scale;

    let bestDist = Infinity;
    let bestWhole = 0;

    for (const row of measureList) {
      const gm = row?.[0];
      if (!gm || !gm.PositionAndShape) continue;
      const pos = gm.PositionAndShape.AbsolutePosition;
      const size = gm.PositionAndShape.Size;
      if (!pos || !size) continue;
      const cx = pos.x + size.width / 2;
      const cy = pos.y + size.height / 2;
      const dist = Math.hypot(osmdX - cx, (osmdY - cy) * 1.5);
      if (dist < bestDist) {
        bestDist = dist;
        const mStart = gm.parentSourceMeasure?.AbsoluteTimestamp?.RealValue ?? 0;
        const mDur = gm.parentSourceMeasure?.Duration?.RealValue ?? 0;
        const frac = size.width > 0 ? Math.max(0, Math.min(0.95, (osmdX - pos.x) / size.width)) : 0;
        bestWhole = mStart + frac * mDur;
      }
    }

    if (Number.isFinite(bestDist) && bestDist < Infinity) {
      const targetSec = wholeNotesToTimeSec(timeline, bestWhole, tempoBpm);
      onSeek(targetSec);
    }
  };

  if (!musicxml) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-[#27273A] bg-[#09090F] text-sm text-[#A1A1AA]">
        Upload and transcribe audio to render sheet music notation.
      </div>
    );
  }

  return (
    <div
      data-testid="sheet-music-viewer"
      className={`space-y-3 w-full min-w-0 max-w-full ${isFocusMode ? "flex-1 min-h-0 flex flex-col" : ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-[#A1A1AA]">
            Sheet Music Notation (OpenSheetMusicDisplay)
          </span>
          {onTogglePlay && (
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                onClick={onTogglePlay}
                aria-label={isPlaying ? "Pause sheet music" : "Play sheet music"}
              >
                {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {isPlaying ? "Pause" : "Play"}
              </Button>
              {onStopPlay && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={onStopPlay}
                  aria-label="Stop sheet music"
                >
                  <Square className="h-3.5 w-3.5" />
                  Stop
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-label="Follow cursor"
            aria-pressed={followCursor}
            onClick={() => setFollowCursor((v) => !v)}
            className={`h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors ${followCursor
              ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200"
              : "border-[#27273A] bg-[#11111B] text-[#A1A1AA] hover:text-[#F5F3FF]"
              }`}
          >
            Follow Cursor
          </button>
          <button
            type="button"
            aria-label="Show chord symbols"
            aria-pressed={effectiveShowChords}
            onClick={handleToggleChords}
            className={`h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#A78BFA]/60 ${effectiveShowChords
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
          {onToggleFocusMode && (
            <Button
              size="sm"
              variant={isFocusMode ? "primary" : "secondary"}
              onClick={onToggleFocusMode}
              title={isFocusMode ? "Exit Focus" : "Maximize"}
              aria-label={isFocusMode ? "Exit Focus" : "Maximize"}
            >
              {isFocusMode ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              {isFocusMode && <span>Exit Focus</span>}
            </Button>
          )}
        </div>
      </div>

      {renderError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
          {renderError}
        </div>
      )}

      <div
        onClick={handleScoreClick}
        className={`relative w-full max-w-full overflow-auto rounded-xl border border-[#27273A] bg-[#F8FAFC] p-2 sm:p-4 touch-pan-x touch-pan-y ${isFocusMode ? "flex-1 min-h-0" : "min-h-[280px]"
          } ${onSeek ? "cursor-pointer" : ""}`}
      >
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
