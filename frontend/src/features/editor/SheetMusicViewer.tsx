import { useEffect, useMemo, useRef, useState } from "react";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { Maximize2, Minimize2, Pause, Play, Square, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { resolveTrackVoiceRole } from "@/features/editor/cascadeUtils";
import { midiSynth } from "@/features/editor/midiSynth";
import {
  buildMusicXmlTimeline,
  timeSecToWholeNotes,
  wholeNotesToTimeSec,
} from "@/features/editor/musicXmlTimeline";
import type { ScoreTrack } from "@/types/api";

const SATB_SHEET_COLORS: Record<string, string> = {
  soprano: "#3b82f6", // Blue
  alto: "#10b981", // Emerald
  tenor: "#f59e0b", // Gold
  bass: "#8b5cf6", // Purple
  other: "#3b82f6",
};

const TITLE_EXT_RE = /\.(?:pdf|mxl|musicxml|xml|mid|midi|mp3|wav)$/i;

export function cleanDisplayScoreTitle(rawTitle: string): string {
  return rawTitle.trim().replace(TITLE_EXT_RE, "").trim();
}

export function prepareDisplayMusicXml(xml: string, showChords: boolean): string {
  if (typeof DOMParser !== "undefined" && typeof XMLSerializer !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      if (!doc.querySelector("parsererror")) {
        if (!showChords) {
          const harmonies = Array.from(doc.getElementsByTagName("harmony"));
          for (const el of harmonies) {
            el.parentNode?.removeChild(el);
          }
        }
        for (const tag of ["work-title", "movement-title"]) {
          const el = doc.getElementsByTagName(tag)[0];
          if (el?.textContent) {
            el.textContent = cleanDisplayScoreTitle(el.textContent);
          }
        }
        return new XMLSerializer().serializeToString(doc);
      }
    } catch {
      // Fall back to regex removal below
    }
  }
  return showChords ? xml : xml.replace(/<harmony\b[^>]*>[\s\S]*?<\/harmony>/gi, "");
}

export function stripHarmonyFromMusicXml(xml: string): string {
  return prepareDisplayMusicXml(xml, false);
}

interface PlayheadRect {
  visible: boolean;
  left: number;
  top: number;
  height: number;
  systemIndex: number;
}

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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const highlightedSvgRef = useRef<Array<{ el: Element; origFill: string | null }>>([]);
  const lastCursorWholeRef = useRef<number>(-1);
  const lastFollowedSystemRef = useRef<number>(-1);
  const manualScrollPauseUntilRef = useRef<number>(0);
  const programmaticScrollAtRef = useRef<number>(0);

  const [zoom, setZoom] = useState(0.9);
  const [localShowChords, setLocalShowChords] = useState(true);
  const [followCursor, setFollowCursor] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [playheadRect, setPlayheadRect] = useState<PlayheadRect>({
    visible: false,
    left: 0,
    top: 0,
    height: 80,
    systemIndex: 0,
  });

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

  const computePlayheadGeometry = (osmd: OpenSheetMusicDisplay): PlayheadRect => {
    const cursorEl = osmd.cursor?.cursorElement;
    const containerEl = containerRef.current;
    if (!cursorEl || !containerEl) {
      return { visible: false, left: 0, top: 0, height: 80, systemIndex: 0 };
    }

    const cRect = containerEl.getBoundingClientRect();
    const kRect = cursorEl.getBoundingClientRect();
    const left =
      cRect.width > 0 && kRect.width >= 0 && kRect.left >= cRect.left - 2
        ? kRect.left - cRect.left
        : cursorEl.offsetLeft || 0;

    let top = cursorEl.offsetTop || 0;
    let height = cursorEl.offsetHeight || 96;
    let systemIndex = 0;

    try {
      const mIdx = (osmd.cursor.iterator as unknown as { CurrentMeasureIndex?: number })?.CurrentMeasureIndex ?? 0;
      const measureList = osmd.GraphicSheet?.MeasureList;
      const gm = measureList?.[mIdx]?.[0];
      const sys = (gm as unknown as {
        ParentMusicSystem?: {
          Id?: number;
          PositionAndShape?: { AbsolutePosition?: { y: number }; Size?: { height: number } };
        };
      })?.ParentMusicSystem;
      const scale = 10 * zoom;
      if (sys?.PositionAndShape?.AbsolutePosition && sys?.PositionAndShape?.Size) {
        top = sys.PositionAndShape.AbsolutePosition.y * scale;
        height = Math.max(40, sys.PositionAndShape.Size.height * scale);
        systemIndex = typeof sys.Id === "number" ? sys.Id : mIdx;
      } else {
        systemIndex = Math.floor(top / 160);
      }
    } catch {
      // Fallback to cursor element dimensions
    }

    return { visible: true, left, top, height, systemIndex };
  };

  const maybeAutoScroll = (geom: PlayheadRect) => {
    const scroller = scrollContainerRef.current;
    if (!scroller || !followCursor || !isPlaying || !geom.visible) return;
    if (performance.now() < manualScrollPauseUntilRef.current) return;

    const viewTop = scroller.scrollTop;
    const viewBottom = viewTop + scroller.clientHeight;
    const sysTop = geom.top;
    const sysBottom = geom.top + geom.height;
    const enteredNewSystem = geom.systemIndex !== lastFollowedSystemRef.current;
    const outsideComfortZone = sysTop < viewTop + 16 || sysBottom > viewBottom - 16;

    if ((enteredNewSystem || outsideComfortZone) && scroller.clientHeight > 0) {
      lastFollowedSystemRef.current = geom.systemIndex;
      programmaticScrollAtRef.current = performance.now();
      const targetTop = Math.max(0, sysTop - 36);
      if (typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top: targetTop, behavior: "smooth" });
      } else {
        scroller.scrollTop = targetTop;
      }
    }
  };

  const syncCursorToSeconds = (sec: number, allowAutoScroll: boolean) => {
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
      // Hide OSMD's built-in green cursor while retaining its DOM coordinates for tracking
      if (cursor.cursorElement) {
        cursor.cursorElement.style.opacity = "0";
        cursor.cursorElement.style.pointerEvents = "none";
      }

      const curReal = cursor.iterator.currentTimeStamp?.RealValue ?? 0;
      if (sec <= 0.01 || targetWhole < curReal - 0.001) {
        cursor.reset();
        if (sec <= 0.01) {
          lastFollowedSystemRef.current = -1;
        }
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

        const fillHex = SATB_SHEET_COLORS[role] || SATB_SHEET_COLORS.other;
        const noteheadTargets = svgEl.querySelectorAll("path, ellipse");
        const els = noteheadTargets.length > 0 ? Array.from(noteheadTargets) : [svgEl];
        for (const el of els) {
          highlightedSvgRef.current.push({ el, origFill: el.getAttribute("fill") });
          el.setAttribute("fill", fillHex);
        }
      }

      const geom = computePlayheadGeometry(osmd);
      setPlayheadRect(geom);
      if (allowAutoScroll) {
        maybeAutoScroll(geom);
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
            followCursor: false, // Controlled manually to prevent scroll shivering
          });
        }
        const osmd = osmdRef.current;
        if (!osmd) return;
        const rules = osmd.EngravingRules as unknown as Record<string, unknown> | undefined;
        if (rules && "RenderChordSymbols" in rules) {
          rules.RenderChordSymbols = effectiveShowChords;
        }
        const displayXml = prepareDisplayMusicXml(musicxml, effectiveShowChords);
        await osmd.load(displayXml);
        if (cancelled) return;
        osmd.Zoom = zoom;
        osmd.render();
        lastCursorWholeRef.current = -1;
        lastFollowedSystemRef.current = -1;
        osmd.cursor?.reset();
        if (osmd.cursor?.cursorElement) {
          osmd.cursor.cursorElement.style.opacity = "0";
          osmd.cursor.cursorElement.style.pointerEvents = "none";
        }
        syncCursorToSeconds(playheadSec, false);
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

  // Clean up OSMD instance and listeners on unmount
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

  // Keep cursor synced to playheadSec when paused/seeking/stopped
  useEffect(() => {
    if (isRendering) return;
    if (!isPlaying) {
      syncCursorToSeconds(playheadSec, false);
      if (playheadSec === 0) {
        clearNoteheadHighlights();
      }
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

  const handleManualScrollSignal = () => {
    // Ignore scroll events triggered by our own smooth scrollTo within 350ms
    if (performance.now() - programmaticScrollAtRef.current < 350) return;
    manualScrollPauseUntilRef.current = performance.now() + 3000;
  };

  const handleScoreClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek || !osmdRef.current || !containerRef.current) return;
    const measureList = osmdRef.current.GraphicSheet?.MeasureList;
    if (!measureList || measureList.length === 0) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const clickX = e.clientX - containerRect.left;
    const clickY = e.clientY - containerRect.top;

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
            className={`h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
              followCursor
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
        ref={scrollContainerRef}
        data-testid="sheet-music-scroll-container"
        onClick={handleScoreClick}
        onWheel={handleManualScrollSignal}
        onTouchMove={handleManualScrollSignal}
        onScroll={handleManualScrollSignal}
        className={`relative w-full max-w-full overflow-auto rounded-xl border border-[#27273A] bg-[#F8FAFC] p-2 sm:p-4 touch-pan-x touch-pan-y ${
          isFocusMode ? "flex-1 min-h-0" : "min-h-[280px] max-h-[560px]"
        } ${onSeek ? "cursor-pointer" : ""}`}
      >
        {isRendering && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 text-xs text-zinc-700 z-30">
            Rendering notation...
          </div>
        )}
        <div className="relative min-w-[560px]">
          <div ref={containerRef} />
          {playheadRect.visible && (
            <div
              data-testid="sheet-music-playhead"
              style={{
                position: "absolute",
                left: `${playheadRect.left}px`,
                top: `${playheadRect.top}px`,
                height: `${playheadRect.height}px`,
                width: "3px",
                backgroundColor: "#3b82f6",
                boxShadow: "0 0 8px rgba(59, 130, 246, 0.75)",
                zIndex: 20,
                pointerEvents: "none",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
