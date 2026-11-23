import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import {
  ArrowDown,
  ArrowUp,
  Maximize2,
  Minimize2,
  Pause,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { resolveTrackVoiceRole } from "@/features/editor/cascadeUtils";
import { midiSynth } from "@/features/editor/midiSynth";
import { diagLogOnce } from "@/features/editor/playbackDiag";
import {
  addMeasureToAllParts,
  convertXmlNoteToRest,
  deleteMeasureFromAllParts,
  type EditableNoteType,
  setXmlNoteAccidental,
  setXmlNoteDuration,
  transposeXmlNote,
  type XmlNoteTarget,
} from "@/features/editor/musicXmlEditor";
import {
  cleanDisplayScoreTitle,
  normalizeScorePayload,
  prepareDisplayMusicXml,
} from "@/features/editor/musicXmlNormalization";
import {
  buildMusicXmlTimeline,
  findCursorSnapshotIndex,
  type OsmdCursorSnapshot,
  timeSecToWholeNotes,
  wholeNotesToTimeSec,
} from "@/features/editor/musicXmlTimeline";
import { midiToNoteName } from "@/lib/utils";
import { getStoredTokens } from "@/services/api";
import type { ScoreNote, ScoreTrack } from "@/types/api";

export { cleanDisplayScoreTitle, prepareDisplayMusicXml };

const SATB_SHEET_COLORS: Record<string, string> = {
  soprano: "#3b82f6", // Blue
  alto: "#10b981", // Emerald
  tenor: "#f59e0b", // Gold
  bass: "#8b5cf6", // Purple
  other: "#3b82f6",
};

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
  notes?: ScoreNote[];
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
  onMusicXmlChange?: (nextXml: string) => void;
}

export function SheetMusicViewer({
  musicxml,
  notes = [],
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
  onMusicXmlChange,
}: SheetMusicViewerProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const highlightedSvgRef = useRef<Array<{ el: Element; origFill: string | null }>>([]);
  const selectedSvgRef = useRef<Array<{ el: Element; origFill: string | null }>>([]);
  const svgNoteTargetMapRef = useRef<WeakMap<Element, XmlNoteTarget>>(new WeakMap());
  const cursorSnapshotsRef = useRef<OsmdCursorSnapshot[]>([]);
  const lastCursorWholeRef = useRef<number>(-1);
  const lastFollowedSystemRef = useRef<number>(-1);
  const playheadSecRef = useRef<number>(playheadSec);
  playheadSecRef.current = playheadSec;
  const manualScrollPauseUntilRef = useRef<number>(0);
  const programmaticScrollAtRef = useRef<number>(0);
  const savedScrollRef = useRef<{ top: number; left: number } | null>(null);

  const [zoom, setZoom] = useState(0.9);
  const [localShowChords, setLocalShowChords] = useState(true);
  const [followCursor, setFollowCursor] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<XmlNoteTarget | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [resolvedXml, setResolvedXml] = useState<string | null>(null);
  const [payloadStatus, setPayloadStatus] = useState<"empty" | "loading" | "ready" | "error">("empty");
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
    () => buildMusicXmlTimeline(resolvedXml ?? musicxml, tempoBpm),
    [resolvedXml, musicxml, tempoBpm],
  );

  const clearNoteheadHighlights = () => {
    for (const item of highlightedSvgRef.current) {
      if (item.origFill === null) item.el.removeAttribute("fill");
      else item.el.setAttribute("fill", item.origFill);
    }
    highlightedSvgRef.current = [];
  };

  const clearSelectedHighlight = () => {
    for (const item of selectedSvgRef.current) {
      if (item.origFill === null) item.el.removeAttribute("fill");
      else item.el.setAttribute("fill", item.origFill);
    }
    selectedSvgRef.current = [];
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

  const syncCursorToSeconds = useCallback(
    (sec: number, allowAutoScroll: boolean, force = false) => {
      const osmd = osmdRef.current;
      if (!osmd || !osmd.cursor) return;
      const cursor = osmd.cursor;

      // Use O(log N) snapshot lookup when OSMD iterator timeline is populated
      const snapshots = cursorSnapshotsRef.current;
      let targetWhole = timeSecToWholeNotes(timeline, sec, tempoBpm);
      if (snapshots.length > 1) {
        const idx = findCursorSnapshotIndex(snapshots, sec);
        if (idx >= 0) {
          targetWhole = snapshots[idx].wholeNote;
        }
      }

      if (!force && Math.abs(targetWhole - lastCursorWholeRef.current) < 0.002 && sec > 0) {
        return;
      }

      try {
        if (!cursor.iterator) return;
        cursor.show();
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
        lastCursorWholeRef.current = targetWhole;

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
        if (isPlaying) {
          diagLogOnce("firstCursor", "First cursor position calculated and applied", {
            sec,
            targetWhole,
            snapshotCount: snapshots.length,
            firstSnapshotSec: snapshots[0]?.sec,
            secondSnapshotSec: snapshots[1]?.sec,
            left: geom.left,
            visible: geom.visible,
          });
        }
        setPlayheadRect((prev) =>
          prev.visible === geom.visible &&
            prev.left === geom.left &&
            prev.top === geom.top &&
            prev.height === geom.height &&
            prev.systemIndex === geom.systemIndex
            ? prev
            : geom,
        );
        if (allowAutoScroll) {
          maybeAutoScroll(geom);
        }
      } catch {
        // Ignore OSMD cursor boundary exceptions during re-render
      }
    },
    [timeline, tempoBpm, tracks, satbMutedVoices, satbSoloVoice, followCursor, isPlaying],
  );

  // Build OSMD iterator timeline & SVG notehead -> XmlNoteTarget map after render
  const indexRenderedScore = (osmd: OpenSheetMusicDisplay, activeTimeline: ReturnType<typeof buildMusicXmlTimeline>) => {
    const snapshots: OsmdCursorSnapshot[] = [];

    // Map each measure index and measure number to its actual start in whole notes on the audio timeline
    const measureStartByIndex = new Map<number, number>();
    const measureStartByNumber = new Map<number, number>();
    for (const seg of activeTimeline.segments) {
      if (typeof seg.measureIndex === "number" && !measureStartByIndex.has(seg.measureIndex)) {
        measureStartByIndex.set(seg.measureIndex, seg.wholeNoteStart);
      }
      if (!measureStartByNumber.has(seg.measureNumber)) {
        measureStartByNumber.set(seg.measureNumber, seg.wholeNoteStart);
      }
    }

    // Sorted unique MIDI note onset_sec values for direct audio timeline alignment
    const sortedOnsets = Array.from(
      new Set(notes.map((n) => n.onset_sec).filter((v) => Number.isFinite(v) && v >= 0)),
    ).sort((a, b) => a - b);

    const findNearestOnset = (sec: number): number | null => {
      if (sortedOnsets.length === 0) return null;
      let lo = 0;
      let hi = sortedOnsets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedOnsets[mid] < sec) lo = mid + 1;
        else hi = mid;
      }
      let best = sortedOnsets[lo];
      if (lo > 0 && Math.abs(sortedOnsets[lo - 1] - sec) < Math.abs(best - sec)) {
        best = sortedOnsets[lo - 1];
      }
      return Math.abs(best - sec) <= 0.025 ? best : null;
    };

    if (osmd.cursor?.iterator) {
      try {
        osmd.cursor.reset();
        let prevReal = -1;
        let step = 0;
        let lastMeasureKey = "";
        let fallbackMeasureStartRaw = 0;

        while (!osmd.cursor.iterator.EndReached && step < 4000) {
          const iter = osmd.cursor.iterator as unknown as {
            currentTimeStamp?: { RealValue?: number };
            CurrentMeasureIndex?: number;
            CurrentMeasure?: {
              MeasureNumber?: number;
              AbsoluteTimestamp?: { RealValue?: number };
            };
            CurrentSourceMeasure?: {
              MeasureNumber?: number;
              AbsoluteTimestamp?: { RealValue?: number };
            };
            CurrentVoiceEntries?: Array<{
              Timestamp?: { RealValue?: number };
              ParentSourceStaffEntry?: {
                VerticalContainerParent?: {
                  ParentMeasure?: {
                    MeasureNumber?: number;
                    AbsoluteTimestamp?: { RealValue?: number };
                  };
                };
              };
            }>;
          };

          const rawReal = iter.currentTimeStamp?.RealValue ?? 0;
          if (step > 0 && rawReal <= prevReal) break; // Guard against mocked/non-advancing iterator

          const measureObj =
            iter.CurrentMeasure ??
            iter.CurrentSourceMeasure ??
            iter.CurrentVoiceEntries?.[0]?.ParentSourceStaffEntry?.VerticalContainerParent?.ParentMeasure;

          const mIdx = typeof iter.CurrentMeasureIndex === "number" ? iter.CurrentMeasureIndex : undefined;
          const mNum = typeof measureObj?.MeasureNumber === "number" ? measureObj.MeasureNumber : undefined;
          const measureKey = mNum !== undefined ? `n:${mNum}` : `i:${mIdx ?? ""}`;
          if (measureKey !== lastMeasureKey) {
            lastMeasureKey = measureKey;
            fallbackMeasureStartRaw = rawReal;
          }

          let beatOffsetWhole = 0;
          if (typeof measureObj?.AbsoluteTimestamp?.RealValue === "number") {
            beatOffsetWhole = Math.max(0, rawReal - measureObj.AbsoluteTimestamp.RealValue);
          } else if (typeof iter.CurrentVoiceEntries?.[0]?.Timestamp?.RealValue === "number") {
            beatOffsetWhole = Math.max(0, iter.CurrentVoiceEntries[0].Timestamp.RealValue);
          } else {
            beatOffsetWhole = Math.max(0, rawReal - fallbackMeasureStartRaw);
          }

          const measureWholeStart =
            (mNum !== undefined ? measureStartByNumber.get(mNum) : undefined) ??
            (mIdx !== undefined ? measureStartByIndex.get(mIdx) : undefined) ??
            activeTimeline.totalWholeNotes;

          const scoreWhole = measureWholeStart + beatOffsetWhole;
          let sec = wholeNotesToTimeSec(activeTimeline, scoreWhole, tempoBpm);

          let hasSounding = true;
          if (typeof osmd.cursor.NotesUnderCursor === "function") {
            const notesUnder = osmd.cursor.NotesUnderCursor() as Array<{ isRest?: () => boolean; IsRest?: boolean }>;
            if (Array.isArray(notesUnder) && notesUnder.length > 0) {
              hasSounding = notesUnder.some((n) =>
                typeof n.isRest === "function" ? !n.isRest() : !Boolean(n.IsRest),
              );
            }
          }
          if (hasSounding) {
            const matchedOnset = findNearestOnset(sec);
            if (matchedOnset !== null) {
              sec = matchedOnset;
            }
          }

          snapshots.push({
            wholeNote: rawReal,
            sec,
            stepIndex: step,
          });
          prevReal = rawReal;
          osmd.cursor.next();
          step++;
        }
        osmd.cursor.reset();
      } catch {
        // Ignore iterator indexing errors
      }
    }
    cursorSnapshotsRef.current = snapshots;

    // Map rendered SVG notehead elements to XmlNoteTarget for direct editing
    const newMap = new WeakMap<Element, XmlNoteTarget>();
    try {
      const measureList = osmd.GraphicSheet?.MeasureList;
      if (Array.isArray(measureList)) {
        for (let mIdx = 0; mIdx < measureList.length; mIdx++) {
          const row = measureList[mIdx];
          if (!Array.isArray(row)) continue;
          for (let sIdx = 0; sIdx < row.length; sIdx++) {
            const gm = row[sIdx] as unknown as {
              MeasureNumber?: number;
              parentSourceMeasure?: { MeasureNumber?: number };
              staffEntries?: Array<{
                getAbsoluteTimestamp?: () => { RealValue?: number };
                graphicalVoiceEntries?: Array<{
                  notes?: Array<{
                    getSVGGElement?: () => Element | null;
                    sourceNote?: { Pitch?: { halfTone?: number } };
                  }>;
                }>;
              }>;
            };
            if (!gm || !Array.isArray(gm.staffEntries)) continue;
            const mNum = gm.MeasureNumber ?? gm.parentSourceMeasure?.MeasureNumber ?? mIdx + 1;
            for (const se of gm.staffEntries) {
              const onsetWhole = se.getAbsoluteTimestamp?.()?.RealValue ?? 0;
              for (const gve of se.graphicalVoiceEntries || []) {
                for (const gn of gve.notes || []) {
                  const svgEl = gn.getSVGGElement?.();
                  if (!svgEl) continue;
                  const halfTone = gn.sourceNote?.Pitch?.halfTone;
                  const midi = typeof halfTone === "number" ? halfTone + 12 : null;
                  const target: XmlNoteTarget = {
                    partIndex: sIdx,
                    measureNumber: mNum,
                    onsetWhole,
                    pitchMidi: midi,
                  };
                  newMap.set(svgEl, target);
                  svgEl.setAttribute("data-mxml-note", "true");
                }
              }
            }
          }
        }
      }
    } catch {
      // Ignore graphic indexing errors
    }
    svgNoteTargetMapRef.current = newMap;
  };

  useEffect(() => {
    const normalized = normalizeScorePayload(musicxml, effectiveShowChords);
    if (normalized.kind === "empty") {
      setResolvedXml(null);
      setRenderError(null);
      setPayloadStatus("empty");
      return;
    }
    if (normalized.kind === "compressed_mxl" || normalized.kind === "invalid") {
      console.warn("[SheetMusicViewer] Unsupported score payload:", normalized.kind);
      setResolvedXml(null);
      setRenderError(normalized.message);
      setPayloadStatus("error");
      return;
    }

    let cancelled = false;
    setRenderError(null);
    setIsRendering(true);
    setPayloadStatus("loading");

    const renderScore = async () => {
      try {
        let displayXml: string;
        if (normalized.kind === "url") {
          const { accessToken } = getStoredTokens();
          const headers: Record<string, string> = {};
          if (accessToken && normalized.url.startsWith("/")) {
            headers.Authorization = `Bearer ${accessToken}`;
          }
          const resp = await fetch(normalized.url, { headers });
          if (!resp.ok) {
            throw new Error(`Failed to retrieve sheet music (${resp.status}).`);
          }
          const contentType = (resp.headers.get("content-type") || "").toLowerCase();
          if (contentType.includes("application/vnd.recordare.musicxml") && !contentType.includes("+xml")) {
            throw new Error("Compressed .mxl score cannot be loaded directly in browser notation.");
          }
          const fetchedText = await resp.text();
          const reNormalized = normalizeScorePayload(fetchedText, effectiveShowChords);
          if (reNormalized.kind !== "xml") {
            throw new Error(
              reNormalized.kind === "empty"
                ? "Retrieved score file is empty."
                : "Retrieved score file is not valid MusicXML.",
            );
          }
          displayXml = reNormalized.xml;
        } else {
          displayXml = normalized.xml;
        }

        if (cancelled || !containerRef.current) return;
        setResolvedXml(displayXml);
        setPayloadStatus("ready");

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
        await osmd.load(displayXml);
        if (cancelled) return;
        osmd.Zoom = zoom;
        osmd.render();

        const localTimeline = buildMusicXmlTimeline(displayXml, tempoBpm);
        indexRenderedScore(osmd, localTimeline);

        lastCursorWholeRef.current = -1;
        lastFollowedSystemRef.current = -1;
        osmd.cursor?.reset();
        if (osmd.cursor?.cursorElement) {
          osmd.cursor.cursorElement.style.opacity = "0";
          osmd.cursor.cursorElement.style.pointerEvents = "none";
        }
        syncCursorToSeconds(playheadSec, false);

        if (savedScrollRef.current && scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = savedScrollRef.current.top;
          scrollContainerRef.current.scrollLeft = savedScrollRef.current.left;
          savedScrollRef.current = null;
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("[SheetMusicViewer] Notation load failed:", err instanceof Error ? err.message : "unknown");
          setRenderError(err instanceof Error ? err.message : "Could not render MusicXML notation.");
          setPayloadStatus("error");
        }
      } finally {
        if (!cancelled) setIsRendering(false);
      }
    };

    void renderScore();
    return () => {
      cancelled = true;
      clearNoteheadHighlights();
      clearSelectedHighlight();
    };
  }, [musicxml, zoom, effectiveShowChords]);

  // Clean up OSMD instance and listeners on unmount
  useEffect(() => {
    return () => {
      clearNoteheadHighlights();
      clearSelectedHighlight();
      try {
        (osmdRef.current as unknown as { Dispose?: () => void } | null)?.Dispose?.();
      } catch {
        // Ignore dispose errors
      }
      osmdRef.current = null;
    };
  }, []);

  const syncCursorToSecondsRef = useRef(syncCursorToSeconds);
  syncCursorToSecondsRef.current = syncCursorToSeconds;

  // Re-index cursor timeline snapshots if notes or tempo change without re-rendering OSMD SVG
  useEffect(() => {
    if (isRendering || !osmdRef.current) return;
    indexRenderedScore(osmdRef.current, timeline);
    syncCursorToSecondsRef.current(playheadSecRef.current, false, true);
  }, [timeline, notes, tempoBpm, isRendering]);

  // Keep cursor synced to playheadSec when paused/seeking/stopped
  useEffect(() => {
    if (isRendering) return;
    if (!isPlaying) {
      syncCursorToSeconds(playheadSec, false, true);
      if (playheadSec === 0) {
        clearNoteheadHighlights();
      }
    }
  }, [playheadSec, isPlaying, isRendering, syncCursorToSeconds]);

  // Smooth, uninterrupted rAF cursor tracking synced to authoritative playback clock while playing
  useEffect(() => {
    if (!isPlaying || isRendering) return;

    // Immediately initialize playhead & notehead highlights at the current/first sounding position
    const initClock = midiSynth.getPlaybackClock();
    const initSec = initClock.isPlaying ? initClock.currentSec : playheadSecRef.current;
    lastCursorWholeRef.current = -1;
    syncCursorToSecondsRef.current(initSec, true, true);

    let rafId: number | null = null;
    const tick = () => {
      diagLogOnce("firstRaf", "First animation frame in SheetMusicViewer");
      const clock = midiSynth.getPlaybackClock();
      const sec = clock.isPlaying ? clock.currentSec : playheadSecRef.current;
      syncCursorToSecondsRef.current(sec, true);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [isPlaying, isRendering]);

  const applyXmlEdit = useCallback(
    (resultXml: string | null, nextTarget?: XmlNoteTarget | null) => {
      if (!resultXml || !onMusicXmlChange) return;
      if (isPlaying) {
        onTogglePlay?.();
        return;
      }
      if (scrollContainerRef.current) {
        savedScrollRef.current = {
          top: scrollContainerRef.current.scrollTop,
          left: scrollContainerRef.current.scrollLeft,
        };
      }
      if (nextTarget !== undefined) {
        setSelectedTarget(nextTarget);
      }
      onMusicXmlChange(resultXml);
    },
    [isPlaying, onMusicXmlChange, onTogglePlay],
  );

  // Keyboard shortcuts when Edit Notation is active
  useEffect(() => {
    if (!editMode || !selectedTarget || !resolvedXml) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const res = transposeXmlNote(resolvedXml, selectedTarget, e.shiftKey ? 12 : 1);
        if (res) applyXmlEdit(res.xml, res.nextTarget);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const res = transposeXmlNote(resolvedXml, selectedTarget, e.shiftKey ? -12 : -1);
        if (res) applyXmlEdit(res.xml, res.nextTarget);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const res = convertXmlNoteToRest(resolvedXml, selectedTarget);
        if (res) applyXmlEdit(res.xml, null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editMode, selectedTarget, resolvedXml, applyXmlEdit]);

  const handleManualScrollSignal = () => {
    if (performance.now() - programmaticScrollAtRef.current < 350) return;
    manualScrollPauseUntilRef.current = performance.now() + 3000;
  };

  const handleScoreClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // In Edit Notation mode, select clicked SVG notehead
    if (editMode) {
      let node: Element | null = e.target as Element | null;
      while (node && node !== containerRef.current) {
        const mapped = svgNoteTargetMapRef.current.get(node);
        if (mapped) {
          clearSelectedHighlight();
          const els = Array.from(node.querySelectorAll("path, ellipse"));
          const targets = els.length > 0 ? els : [node];
          for (const el of targets) {
            selectedSvgRef.current.push({ el, origFill: el.getAttribute("fill") });
            el.setAttribute("fill", "#f59e0b");
          }
          setSelectedTarget(mapped);
          return;
        }
        node = node.parentElement;
      }
      clearSelectedHighlight();
      setSelectedTarget(null);
      return;
    }

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

    for (let rowIdx = 0; rowIdx < measureList.length; rowIdx++) {
      const row = measureList[rowIdx];
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
        const mNum = gm.MeasureNumber ?? gm.parentSourceMeasure?.MeasureNumber;
        const mSeg =
          timeline.segments.find((s) => s.measureIndex === rowIdx) ??
          (typeof mNum === "number" ? timeline.segments.find((s) => s.measureNumber === mNum) : undefined);
        const mStart = mSeg?.wholeNoteStart ?? gm.parentSourceMeasure?.AbsoluteTimestamp?.RealValue ?? 0;
        const mDur =
          mSeg !== undefined
            ? Math.max(0, mSeg.wholeNoteEnd - mSeg.wholeNoteStart)
            : gm.parentSourceMeasure?.Duration?.RealValue ?? 0;
        const frac = size.width > 0 ? Math.max(0, Math.min(0.95, (osmdX - pos.x) / size.width)) : 0;
        bestWhole = mStart + frac * mDur;
      }
    }

    if (Number.isFinite(bestDist) && bestDist < Infinity) {
      const targetSec = wholeNotesToTimeSec(timeline, bestWhole, tempoBpm);
      onSeek(targetSec);
    }
  };

  if (payloadStatus === "empty" && !musicxml?.trim()) {
    return (
      <div
        data-testid="sheet-music-empty"
        className="flex h-64 items-center justify-center rounded-xl border border-[#27273A] bg-[#09090F] px-6 text-center text-sm text-[#A1A1AA]"
      >
        No sheet music XML available for this project. Click Re-Transcribe or Re-Process Score to generate notation.
      </div>
    );
  }

  const activeXml = resolvedXml ?? musicxml ?? "";

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
                title="Play / Stop (Space)"
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
          {onMusicXmlChange && (
            <button
              type="button"
              aria-label="Edit notation"
              aria-pressed={editMode}
              onClick={() => {
                if (!editMode && isPlaying) {
                  onTogglePlay?.();
                }
                setEditMode((v) => !v);
                clearSelectedHighlight();
                setSelectedTarget(null);
              }}
              className={`inline-flex items-center gap-1 h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors ${editMode
                ? "border-amber-400/60 bg-amber-500/20 text-amber-200"
                : "border-[#27273A] bg-[#11111B] text-[#A1A1AA] hover:text-[#F5F3FF]"
                }`}
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit Notation
            </button>
          )}
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

      {/* Direct Notation Editing Toolbar (only visible when Edit Notation is enabled) */}
      {editMode && (
        <div
          data-testid="notation-edit-toolbar"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-[#181825] px-3 py-2 text-xs shrink-0"
        >
          {isPlaying ? (
            <span className="text-amber-300">Pause playback before editing notation.</span>
          ) : (
            <>
              <span className="font-mono text-amber-200">
                {selectedTarget
                  ? `${selectedTarget.pitchMidi !== null ? midiToNoteName(selectedTarget.pitchMidi) : "Rest"} • m.${selectedTarget.measureNumber}`
                  : "Click a notehead to edit"}
              </span>

              <div className="flex items-center gap-1 border-l border-[#27273A] pl-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!selectedTarget}
                  aria-label="Pitch up"
                  onClick={() => {
                    if (!selectedTarget) return;
                    const res = transposeXmlNote(activeXml, selectedTarget, 1);
                    if (res) applyXmlEdit(res.xml, res.nextTarget);
                  }}
                >
                  <ArrowUp className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!selectedTarget}
                  aria-label="Pitch down"
                  onClick={() => {
                    if (!selectedTarget) return;
                    const res = transposeXmlNote(activeXml, selectedTarget, -1);
                    if (res) applyXmlEdit(res.xml, res.nextTarget);
                  }}
                >
                  <ArrowDown className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!selectedTarget}
                  aria-label="Octave up"
                  onClick={() => {
                    if (!selectedTarget) return;
                    const res = transposeXmlNote(activeXml, selectedTarget, 12);
                    if (res) applyXmlEdit(res.xml, res.nextTarget);
                  }}
                >
                  +8va
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!selectedTarget}
                  aria-label="Octave down"
                  onClick={() => {
                    if (!selectedTarget) return;
                    const res = transposeXmlNote(activeXml, selectedTarget, -12);
                    if (res) applyXmlEdit(res.xml, res.nextTarget);
                  }}
                >
                  -8va
                </Button>
              </div>

              <div className="flex items-center gap-1 border-l border-[#27273A] pl-2">
                {(["sharp", "flat", "natural"] as const).map((acc) => (
                  <Button
                    key={acc}
                    size="sm"
                    variant="secondary"
                    disabled={!selectedTarget}
                    aria-label={`Set accidental ${acc}`}
                    onClick={() => {
                      if (!selectedTarget) return;
                      const res = setXmlNoteAccidental(activeXml, selectedTarget, acc);
                      if (res) applyXmlEdit(res.xml, res.nextTarget);
                    }}
                  >
                    {acc === "sharp" ? "♯" : acc === "flat" ? "♭" : "♮"}
                  </Button>
                ))}
              </div>

              <div className="flex items-center gap-1 border-l border-[#27273A] pl-2">
                {(["whole", "half", "quarter", "eighth", "16th"] as EditableNoteType[]).map((dur) => (
                  <Button
                    key={dur}
                    size="sm"
                    variant="secondary"
                    disabled={!selectedTarget}
                    aria-label={`Set duration ${dur}`}
                    onClick={() => {
                      if (!selectedTarget) return;
                      const res = setXmlNoteDuration(activeXml, selectedTarget, dur);
                      if (res) applyXmlEdit(res.xml, res.nextTarget);
                    }}
                  >
                    {dur === "16th" ? "16th" : dur.charAt(0).toUpperCase() + dur.slice(1)}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!selectedTarget}
                  aria-label="Convert note to rest"
                  onClick={() => {
                    if (!selectedTarget) return;
                    const res = convertXmlNoteToRest(activeXml, selectedTarget);
                    if (res) applyXmlEdit(res.xml, null);
                  }}
                >
                  Rest
                </Button>
              </div>

              <div className="flex items-center gap-1 border-l border-[#27273A] pl-2">
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="Add measure"
                  onClick={() => {
                    const nextXml = addMeasureToAllParts(activeXml, selectedTarget?.measureNumber);
                    if (nextXml) applyXmlEdit(nextXml);
                  }}
                >
                  <Plus className="h-3 w-3" /> Add Measure
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!selectedTarget}
                  aria-label="Delete measure"
                  onClick={() => {
                    if (!selectedTarget) return;
                    if (
                      typeof window.confirm === "function" &&
                      !window.confirm(`Delete measure ${selectedTarget.measureNumber} across all parts?`)
                    ) {
                      return;
                    }
                    const nextXml = deleteMeasureFromAllParts(activeXml, selectedTarget.measureNumber);
                    if (nextXml) applyXmlEdit(nextXml, null);
                  }}
                >
                  <Trash2 className="h-3 w-3" /> Delete Measure
                </Button>
              </div>
            </>
          )}
        </div>
      )}

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
        className={`relative w-full max-w-full overflow-auto rounded-xl border border-[#27273A] bg-[#F8FAFC] p-2 sm:p-4 touch-pan-x touch-pan-y ${isFocusMode ? "flex-1 min-h-0" : "min-h-[280px] max-h-[560px]"
          } ${onSeek || editMode ? "cursor-pointer" : ""}`}
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
