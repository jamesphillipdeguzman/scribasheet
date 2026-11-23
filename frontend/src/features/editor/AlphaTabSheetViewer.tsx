import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as alphaTab from "@coderline/alphatab";
import { Maximize2, Minimize2, Pause, Play, Square, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { resolveTrackVoiceRole } from "@/features/editor/cascadeUtils";
import { midiSynth } from "@/features/editor/midiSynth";
import { injectChordsIntoMusicXml } from "@/features/editor/musicXmlChords";
import { normalizeScorePayload } from "@/features/editor/musicXmlNormalization";
import { getStoredTokens } from "@/services/api";
import type { ScoreChord, ScoreNote, ScoreTrack } from "@/types/api";

export interface AlphaTabSheetViewerProps {
  musicxml: string | null;
  notes?: ScoreNote[];
  chords?: ScoreChord[];
  showChordSymbols?: boolean;
  onToggleChordSymbols?: (value: boolean) => void;
  playheadSec?: number;
  isPlaying?: boolean;
  tempoBpm?: number;
  playbackRate?: number;
  tracks?: ScoreTrack[];
  satbSoloVoice?: string | null;
  satbMutedVoices?: Record<string, boolean>;
  onTogglePlay?: () => void;
  onStopPlay?: () => void;
  onSeek?: (sec: number) => void;
  isFocusMode?: boolean;
  onToggleFocusMode?: () => void;
  engineSwitcher?: React.ReactNode;
}

const SATB_COLORS: Record<string, string> = {
  soprano: "#3b82f6", // Sky blue
  alto: "#10b981", // Emerald
  tenor: "#f59e0b", // Gold
  bass: "#8b5cf6", // Purple
  other: "#3b82f6",
};

const EMPTY_NOTES: ScoreNote[] = [];
const EMPTY_CHORDS: ScoreChord[] = [];
const EMPTY_TRACKS: ScoreTrack[] = [];
const EMPTY_MUTED: Record<string, boolean> = {};

/**
 * Resolve an AlphaTab Track's SATB role from its explicit source metadata
 * (or matching ScribaSheet ScoreTrack), never guessing solely from pitch.
 */
export function resolveAlphaTabTrackRole(
  atTrack: { index: number; name?: string | null },
  scoreTracks: ScoreTrack[],
): string {
  const byName = resolveTrackVoiceRole({
    index: atTrack.index,
    name: atTrack.name || "",
    instrument: "",
    clef: "treble",
    program: 0,
    muted: false,
  });
  if (byName !== "other") return byName;
  const matched = scoreTracks.find((t) => t.index === atTrack.index) ?? scoreTracks[atTrack.index];
  return resolveTrackVoiceRole(matched);
}

export function AlphaTabSheetViewer({
  musicxml,
  notes = EMPTY_NOTES,
  chords = EMPTY_CHORDS,
  showChordSymbols = true,
  onToggleChordSymbols,
  playheadSec = 0,
  isPlaying = false,
  tempoBpm = 120,
  playbackRate = 1.0,
  tracks = EMPTY_TRACKS,
  satbSoloVoice = null,
  satbMutedVoices = EMPTY_MUTED,
  onTogglePlay,
  onStopPlay,
  onSeek,
  isFocusMode = false,
  onToggleFocusMode,
  engineSwitcher,
}: AlphaTabSheetViewerProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<alphaTab.AlphaTabApi | null>(null);
  const loadedTracksRef = useRef<alphaTab.model.Track[]>([]);
  const lastLoadedXmlRef = useRef<string | null>(null);
  const pendingXmlRef = useRef<string | null>(null);
  const safetyTimerRef = useRef<number | null>(null);
  const safetyRetriedRef = useRef<boolean>(false);

  const [zoom, setZoom] = useState(0.95);
  const [followCursor, setFollowCursor] = useState(true);
  const [localShowChords, setLocalShowChords] = useState(true);
  const [isRendering, setIsRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [payloadStatus, setPayloadStatus] = useState<"empty" | "loading" | "ready" | "error">("empty");
  const [activeBeatInfo, setActiveBeatInfo] = useState<{
    measureNumber: number;
    beatIndex: number;
    voiceRoles: string[];
  } | null>(null);

  const hasMusicXml = Boolean(musicxml?.trim());

  const effectiveShowChords = onToggleChordSymbols ? showChordSymbols : localShowChords;
  const handleToggleChords = () => {
    const next = !effectiveShowChords;
    if (onToggleChordSymbols) onToggleChordSymbols(next);
    else setLocalShowChords(next);
  };

  const playheadSecRef = useRef(playheadSec);
  playheadSecRef.current = playheadSec;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;
  const onTogglePlayRef = useRef(onTogglePlay);
  onTogglePlayRef.current = onTogglePlay;
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const soloRef = useRef(satbSoloVoice);
  soloRef.current = satbSoloVoice;
  const mutedRef = useRef(satbMutedVoices);
  mutedRef.current = satbMutedVoices;

  const durationMs = useMemo(() => {
    const maxNote = notes.reduce((m, n) => Math.max(m, n.offset_sec), 0);
    return Math.max(1000, Math.round(maxNote * 1000));
  }, [notes]);
  const durationMsRef = useRef(durationMs);
  durationMsRef.current = durationMs;

  const pushExternalPosition = useCallback((sec: number) => {
    const api = apiRef.current;
    if (!api?.player?.output) return;
    const output = api.player.output as unknown as alphaTab.synth.IExternalMediaSynthOutput;
    if (typeof output.updatePosition === "function") {
      output.updatePosition(Math.max(0, sec * 1000));
    }
  }, []);

  const clearSafetyTimer = useCallback(() => {
    if (safetyTimerRef.current !== null) {
      window.clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
  }, []);

  const loadXmlIntoApi = useCallback(
    (api: alphaTab.AlphaTabApi, xml: string) => {
      clearSafetyTimer();
      safetyRetriedRef.current = false;
      lastLoadedXmlRef.current = xml;
      pendingXmlRef.current = null;
      setRenderError(null);
      setIsRendering(true);
      setPayloadStatus("ready");
      const bytes = new TextEncoder().encode(xml);
      const loaded = api.load(bytes);
      if (!loaded) {
        setIsRendering(false);
        setRenderError("AlphaTab could not parse the MusicXML score.");
        setPayloadStatus("error");
      }
    },
    [clearSafetyTimer],
  );

  // Initialize AlphaTabApi once the surface container is mounted and has usable width
  useEffect(() => {
    if (!hasMusicXml) return;
    const surfaceEl = surfaceRef.current;
    if (!surfaceEl || apiRef.current) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let svgMutationObserver: MutationObserver | null = null;
    let unsubs: Array<() => void> = [];

    const hasRenderedSvg = () =>
      Boolean(
        surfaceRef.current?.querySelector("svg, .at-surface svg, .at-main svg") ||
          scrollContainerRef.current?.querySelector(".at-surface svg, .at-main svg, svg"),
      );

    const initApi = () => {
      if (disposed || apiRef.current) return;

      const settings = new alphaTab.Settings();
      settings.core.useWorkers = false;
      settings.core.engine = "svg";
      settings.core.fontDirectory = "/alphatab/font/";
      settings.display.layoutMode = alphaTab.LayoutMode.Page;
      settings.display.scale = zoom;
      settings.notation.elements.set(alphaTab.NotationElement.EffectChordNames, effectiveShowChords);
      settings.notation.elements.set(alphaTab.NotationElement.ChordDiagrams, false);
      settings.player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia;
      settings.player.enableCursor = true;
      settings.player.enableUserInteraction = true;
      if (scrollContainerRef.current) {
        settings.player.scrollElement = scrollContainerRef.current;
      }
      settings.player.scrollMode = followCursor
        ? alphaTab.ScrollMode.Continuous
        : alphaTab.ScrollMode.Off;

      const api = new alphaTab.AlphaTabApi(surfaceEl, settings);
      apiRef.current = api;

      unsubs = [];

      unsubs.push(
        api.playerReady.on(() => {
          const output = api.player?.output as unknown as alphaTab.synth.IExternalMediaSynthOutput | undefined;
          if (!output) return;
          output.handler = {
            get backingTrackDuration() {
              return durationMsRef.current;
            },
            get playbackRate() {
              return playbackRateRef.current;
            },
            set playbackRate(_val: number) {
              // Controlled by ScribaSheet WaveformPlayer
            },
            get masterVolume() {
              return 1;
            },
            set masterVolume(_val: number) {
              // Controlled by ScribaSheet WaveformPlayer
            },
            seekTo(timeMs: number) {
              onSeekRef.current?.(Math.max(0, timeMs / 1000));
            },
            play() {
              if (!isPlayingRef.current) {
                onTogglePlayRef.current?.();
              }
            },
            pause() {
              if (isPlayingRef.current) {
                onTogglePlayRef.current?.();
              }
            },
          };
          pushExternalPosition(playheadSecRef.current);
        }),
      );

      unsubs.push(
        api.scoreLoaded.on((score) => {
          loadedTracksRef.current = score.tracks || [];
          if (score.tracks && score.tracks.length > 0) {
            api.renderTracks(score.tracks);
          }
        }),
      );

      unsubs.push(
        api.renderFinished.on(() => {
          clearSafetyTimer();
          if (hasRenderedSvg()) {
            safetyRetriedRef.current = false;
            setRenderError(null);
            setIsRendering(false);
            setPayloadStatus("ready");
            pushExternalPosition(playheadSecRef.current);
            return;
          }

          // Bounded 4-second safety check if renderFinished fired before SVG appeared
          safetyTimerRef.current = window.setTimeout(() => {
            if (disposed) return;
            if (hasRenderedSvg()) {
              safetyRetriedRef.current = false;
              setRenderError(null);
              setIsRendering(false);
              setPayloadStatus("ready");
              pushExternalPosition(playheadSecRef.current);
              return;
            }
            if (!safetyRetriedRef.current && apiRef.current && lastLoadedXmlRef.current) {
              safetyRetriedRef.current = true;
              try {
                apiRef.current.render();
              } catch {
                // fall through to second bounded check
              }
              safetyTimerRef.current = window.setTimeout(() => {
                if (disposed) return;
                setIsRendering(false);
                if (hasRenderedSvg()) {
                  setRenderError(null);
                  setPayloadStatus("ready");
                  pushExternalPosition(playheadSecRef.current);
                } else {
                  setRenderError("AlphaTab finished rendering without producing notation SVG.");
                  setPayloadStatus("error");
                }
              }, 4000);
            } else {
              setIsRendering(false);
              setRenderError("AlphaTab finished rendering without producing notation SVG.");
              setPayloadStatus("error");
            }
          }, 4000);
        }),
      );

      unsubs.push(
        api.activeBeatsChanged.on((args) => {
          const activeBeats = args.activeBeats || [];
          if (activeBeats.length === 0) {
            setActiveBeatInfo(null);
            return;
          }
          const roles = new Set<string>();
          let mNum = 1;
          let bIdx = 0;
          for (const beat of activeBeats) {
            const track = beat.voice?.bar?.staff?.track;
            if (track) {
              const role = resolveAlphaTabTrackRole(track, tracksRef.current);
              const isMuted = role !== "other" ? Boolean(mutedRef.current[role]) : false;
              const isSoloHidden = Boolean(soloRef.current && role !== soloRef.current);
              if (!isMuted && !isSoloHidden) {
                roles.add(role);
              }
            }
            if (beat.voice?.bar?.index !== undefined) {
              mNum = beat.voice.bar.index + 1;
            }
            if (beat.index !== undefined) {
              bIdx = beat.index;
            }
          }
          setActiveBeatInfo({
            measureNumber: mNum,
            beatIndex: bIdx,
            voiceRoles: Array.from(roles),
          });
        }),
      );

      unsubs.push(
        api.beatMouseDown.on((beat) => {
          if (!onSeekRef.current) return;
          const startMs = beat.playbackStart;
          if (typeof startMs === "number" && Number.isFinite(startMs)) {
            onSeekRef.current(Math.max(0, startMs / 1000));
          }
        }),
      );

      unsubs.push(
        api.error.on((err) => {
          clearSafetyTimer();
          setIsRendering(false);
          setRenderError(err instanceof Error ? err.message : "AlphaTab failed to render MusicXML.");
          setPayloadStatus("error");
        }),
      );

      if (typeof MutationObserver !== "undefined") {
        svgMutationObserver = new MutationObserver(() => {
          if (disposed) return;
          if (hasRenderedSvg()) {
            clearSafetyTimer();
            safetyRetriedRef.current = false;
            setRenderError(null);
            setIsRendering(false);
            setPayloadStatus("ready");
          }
        });
        svgMutationObserver.observe(surfaceEl, { childList: true, subtree: true });
      }

      if (pendingXmlRef.current) {
        loadXmlIntoApi(api, pendingXmlRef.current);
      }
    };

    const isNoopJsdomObserver =
      typeof navigator !== "undefined" &&
      /jsdom/i.test(navigator.userAgent) &&
      typeof ResizeObserver !== "undefined" &&
      !ResizeObserver.toString().includes("MockResizeObserver");

    if (surfaceEl.clientWidth > 0 || typeof ResizeObserver === "undefined" || isNoopJsdomObserver) {
      initApi();
    } else {
      resizeObserver = new ResizeObserver((entries) => {
        const hasWidth =
          surfaceEl.clientWidth > 0 ||
          entries.some((entry) => entry.contentRect.width > 0);
        if (hasWidth) {
          resizeObserver?.disconnect();
          resizeObserver = null;
          initApi();
        }
      });
      resizeObserver.observe(surfaceEl);
    }

    return () => {
      disposed = true;
      clearSafetyTimer();
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (svgMutationObserver) {
        svgMutationObserver.disconnect();
        svgMutationObserver = null;
      }
      for (const u of unsubs) {
        try {
          u();
        } catch {
          // ignore
        }
      }
      loadedTracksRef.current = [];
      lastLoadedXmlRef.current = null;
      if (apiRef.current) {
        try {
          apiRef.current.destroy();
        } catch {
          // ignore
        }
        apiRef.current = null;
      }
    };
  }, [hasMusicXml, pushExternalPosition, clearSafetyTimer, loadXmlIntoApi]);

  // Update zoom / scrollMode / chord-display settings without destroying AlphaTab instance
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.settings.display.scale = zoom;
    api.settings.notation.elements.set(alphaTab.NotationElement.EffectChordNames, effectiveShowChords);
    api.settings.notation.elements.set(alphaTab.NotationElement.ChordDiagrams, false);
    api.settings.player.scrollMode = followCursor
      ? alphaTab.ScrollMode.Continuous
      : alphaTab.ScrollMode.Off;
    api.updateSettings();
    if (loadedTracksRef.current.length > 0) {
      api.render();
    }
  }, [zoom, followCursor, effectiveShowChords]);

  // Load and normalize MusicXML / MXL / URL payloads into AlphaTab
  useEffect(() => {
    const normalized = normalizeScorePayload(musicxml, effectiveShowChords);
    if (normalized.kind === "empty") {
      clearSafetyTimer();
      lastLoadedXmlRef.current = null;
      pendingXmlRef.current = null;
      safetyRetriedRef.current = false;
      setIsRendering(false);
      setRenderError(null);
      setPayloadStatus("empty");
      return;
    }
    if (normalized.kind === "compressed_mxl" || normalized.kind === "invalid") {
      clearSafetyTimer();
      lastLoadedXmlRef.current = null;
      pendingXmlRef.current = null;
      setIsRendering(false);
      setRenderError(normalized.message);
      setPayloadStatus("error");
      return;
    }

    let cancelled = false;
    setRenderError(null);
    setPayloadStatus("loading");

    const loadPayload = async () => {
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
          const fetchedText = await resp.text();
          const reNormalized = normalizeScorePayload(fetchedText, effectiveShowChords);
          if (reNormalized.kind !== "xml") {
            throw new Error("Retrieved score file is not valid MusicXML.");
          }
          displayXml = reNormalized.xml;
        } else {
          displayXml = normalized.xml;
        }

        if (cancelled) return;
        const enrichedXml = effectiveShowChords
          ? injectChordsIntoMusicXml(displayXml, chords, notes, tempoBpm)
          : displayXml;

        if (enrichedXml === lastLoadedXmlRef.current) {
          setPayloadStatus("ready");
          setIsRendering(false);
          return;
        }

        if (apiRef.current) {
          loadXmlIntoApi(apiRef.current, enrichedXml);
        } else {
          pendingXmlRef.current = enrichedXml;
          setIsRendering(true);
          setPayloadStatus("ready");
        }
      } catch (err) {
        if (!cancelled) {
          clearSafetyTimer();
          setIsRendering(false);
          setRenderError(err instanceof Error ? err.message : "Could not render MusicXML in AlphaTab.");
          setPayloadStatus("error");
        }
      }
    };

    void loadPayload();
    return () => {
      cancelled = true;
    };
  }, [musicxml, effectiveShowChords, chords, notes, tempoBpm, clearSafetyTimer, loadXmlIntoApi]);

  // Sync AlphaTab cursor when paused/seeking/stopped
  useEffect(() => {
    if (!isPlaying) {
      pushExternalPosition(playheadSec);
    }
  }, [playheadSec, isPlaying, pushExternalPosition]);

  // Smooth rAF sync to authoritative playback clock during active playback
  useEffect(() => {
    if (!isPlaying) return;
    const initClock = midiSynth.getPlaybackClock();
    pushExternalPosition(initClock.isPlaying ? initClock.currentSec : playheadSecRef.current);

    let rafId: number | null = null;
    const tick = () => {
      const clock = midiSynth.getPlaybackClock();
      const sec = clock.isPlaying ? clock.currentSec : playheadSecRef.current;
      pushExternalPosition(sec);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [isPlaying, pushExternalPosition]);

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

  return (
    <div
      data-testid="alphatab-sheet-music-viewer"
      data-focus-mode={isFocusMode ? "true" : "false"}
      className={
        isFocusMode
          ? "fixed inset-0 z-50 flex flex-col gap-3 bg-[#09090F] p-3 sm:p-4 w-screen h-screen overflow-hidden"
          : "space-y-3 w-full min-w-0"
      }
    >
      <style>{`
        .at-cursor-bar { background: rgba(59, 130, 246, 0.08); }
        .at-cursor-beat { background: #3b82f6 !important; width: 3px !important; box-shadow: 0 0 8px rgba(59, 130, 246, 0.75); }
        .at-highlight * { fill: ${
          activeBeatInfo?.voiceRoles?.[0] ? SATB_COLORS[activeBeatInfo.voiceRoles[0]] || "#3b82f6" : "#3b82f6"
        } !important; stroke: ${
          activeBeatInfo?.voiceRoles?.[0] ? SATB_COLORS[activeBeatInfo.voiceRoles[0]] || "#3b82f6" : "#3b82f6"
        } !important; }
      `}</style>

      <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-[#A1A1AA]">
            Sheet Music Notation (AlphaTab • {Math.round(tempoBpm * playbackRate)} BPM)
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
          {activeBeatInfo && activeBeatInfo.voiceRoles.length > 0 && (
            <div className="flex items-center gap-1" data-testid="alphatab-active-voices">
              {activeBeatInfo.voiceRoles.map((role) => (
                <span
                  key={role}
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: SATB_COLORS[role] || SATB_COLORS.other }}
                  title={role}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {engineSwitcher}
          <button
            type="button"
            aria-label="Follow cursor"
            aria-pressed={followCursor}
            onClick={() => setFollowCursor((v) => !v)}
            className={`h-8 rounded-lg border px-2.5 text-xs transition-colors ${
              followCursor
                ? "bg-emerald-100 text-emerald-900 border-emerald-400 font-semibold dark:border-emerald-500/40 dark:bg-emerald-500/20 dark:text-emerald-300 dark:font-medium"
                : "bg-white hover:bg-stone-100 text-stone-800 border-stone-300 font-medium dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#A1A1AA] dark:hover:text-[#F5F3FF]"
            }`}
          >
            Follow Cursor
          </button>
          <button
            type="button"
            aria-label="Show chord symbols"
            aria-pressed={effectiveShowChords}
            onClick={handleToggleChords}
            className={`h-8 rounded-lg border px-2.5 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500/40 ${
              effectiveShowChords
                ? "bg-violet-100 text-violet-900 border-violet-400 font-semibold dark:border-[#A78BFA]/60 dark:bg-[#7C3AED]/20 dark:text-[#F5F3FF] dark:font-medium"
                : "bg-white hover:bg-stone-100 text-stone-800 border-stone-300 font-medium dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#A1A1AA] dark:hover:text-[#F5F3FF]"
            }`}
          >
            Chords
          </button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.1).toFixed(2))))}
            aria-label="Zoom out notation"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="w-12 text-center font-mono text-xs text-[#A1A1AA]">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setZoom((z) => Math.min(1.8, Number((z + 0.1).toFixed(2))))}
            aria-label="Zoom in notation"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          {onToggleFocusMode && (
            <Button
              size="sm"
              variant="secondary"
              onClick={onToggleFocusMode}
              title={isFocusMode ? "Exit Focus" : "Maximize"}
              aria-label={isFocusMode ? "Exit Focus" : "Maximize"}
            >
              {isFocusMode ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
          )}
        </div>
      </div>

      {isRendering && (
        <div className="rounded-lg border border-[#27273A] bg-[#09090F] px-3 py-2 text-xs text-[#A1A1AA]">
          Rendering sheet music notation with AlphaTab...
        </div>
      )}

      {renderError && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {renderError}
        </div>
      )}

      <div
        ref={scrollContainerRef}
        data-testid="alphatab-scroll-container"
        className={`relative w-full max-w-full overflow-auto rounded-xl border border-[#27273A] bg-[#F8FAFC] p-2 sm:p-4 touch-pan-x touch-pan-y ${
          isFocusMode ? "flex-1 min-h-0" : "min-h-[280px] max-h-[560px]"
        }`}
      >
        <div ref={surfaceRef} data-testid="alphatab-surface" className="relative min-w-[560px]" />
      </div>
    </div>
  );
}
