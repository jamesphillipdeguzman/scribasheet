import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  computeCascadeNotePositions,
  computeKeyLayoutMap,
  getCascadeTrackPalette,
  type KeyRect,
  resolveTrackVoiceRole,
  SATB_CASCADE_COLORS,
} from "@/features/editor/cascadeUtils";
import { midiSynth } from "@/features/editor/midiSynth";
import { midiToNoteName } from "@/lib/utils";
import type { ScoreNote, ScoreTrack } from "@/types/api";

interface PracticeCascadeProps {
  notes: ScoreNote[];
  tracks: ScoreTrack[];
  durationSeconds: number;
  tempoBpm: number;
  timeSignature?: string;
  playheadSec: number;
  isPlaying?: boolean;
  activeMidiPitches: Set<number>;
  minPitch?: number;
  maxPitch?: number;
  keyboardBodyRef: React.RefObject<HTMLDivElement>;
  satbSoloVoice?: string | null;
  satbMutedVoices?: Record<string, boolean>;
  onSatbSoloChange?: (voice: string | null) => void;
  onTogglePlay?: () => void;
  onStop?: () => void;
  onPlayheadChange?: (sec: number) => void;
  onPlaybackRateChange?: (rate: number) => void;
  playbackRate?: number;
}

const CANVAS_HEIGHT = 280;
const HIT_LINE_Y = 262;

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.beginPath();
  ctx.rect(x, y, w, h);
}

export function PracticeCascade({
  notes,
  tracks,
  durationSeconds,
  tempoBpm,
  timeSignature = "4/4",
  playheadSec,
  isPlaying = false,
  activeMidiPitches,
  minPitch = 21,
  maxPitch = 108,
  keyboardBodyRef,
  satbSoloVoice = null,
  satbMutedVoices = {},
  onSatbSoloChange,
  onTogglePlay,
  onStop,
  onPlayheadChange,
  onPlaybackRateChange,
  playbackRate = 1.0,
}: PracticeCascadeProps) {
  const [lookAheadSec, setLookAheadSec] = useState(3.0);
  const [showPitchLabels, setShowPitchLabels] = useState(true);
  const [showBeatIndicator, setShowBeatIndicator] = useState(true);
  const [localPartFilter, setLocalPartFilter] = useState<string>("all");
  const [localRate, setLocalRate] = useState(playbackRate);
  const [localPlaying, setLocalPlaying] = useState(false);
  const [containerWidth, setContainerWidth] = useState(780);
  const [keyLayout, setKeyLayout] = useState<Map<number, KeyRect>>(() =>
    computeKeyLayoutMap(minPitch, maxPitch, 780),
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);

  // Sync external playbackRate if controlled
  useEffect(() => {
    setLocalRate(playbackRate);
  }, [playbackRate]);

  // Refs for 60fps rAF loop without re-subscribing on every prop tick
  const stateRef = useRef({
    notes,
    tracks,
    tempoBpm,
    timeSignature,
    playheadSec,
    isPlaying,
    localPlaying,
    lookAheadSec,
    showPitchLabels,
    showBeatIndicator,
    activeMidiPitches,
    keyLayout,
    satbSoloVoice,
    satbMutedVoices,
    localPartFilter,
  });
  stateRef.current = {
    notes,
    tracks,
    tempoBpm,
    timeSignature,
    playheadSec,
    isPlaying,
    localPlaying,
    lookAheadSec,
    showPitchLabels,
    showBeatIndicator,
    activeMidiPitches,
    keyLayout,
    satbSoloVoice,
    satbMutedVoices,
    localPartFilter,
  };

  // Measure actual VirtualPianoKeyboard key elements & container width on mount and resize
  useEffect(() => {
    const measureKeyboard = () => {
      const el = keyboardBodyRef.current;
      const width = el?.clientWidth && el.clientWidth > 0 ? el.clientWidth : 780;
      const measured = new Map<number, { x: number; width: number }>();

      if (el) {
        const parentRect = el.getBoundingClientRect();
        if (parentRect.width > 0) {
          const buttons = el.querySelectorAll<HTMLButtonElement>("button[data-pitch]");
          buttons.forEach((btn) => {
            const p = Number(btn.dataset.pitch);
            const r = btn.getBoundingClientRect();
            if (Number.isFinite(p) && r.width > 0) {
              measured.set(p, { x: r.left - parentRect.left, width: r.width });
            }
          });
        }
      }

      setContainerWidth(width);
      setKeyLayout(computeKeyLayoutMap(minPitch, maxPitch, width, measured));
    };

    measureKeyboard();
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function" && keyboardBodyRef.current) {
      observer = new ResizeObserver(measureKeyboard);
      observer.observe(keyboardBodyRef.current);
    }
    window.addEventListener("resize", measureKeyboard);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureKeyboard);
    };
  }, [keyboardBodyRef, minPitch, maxPitch]);

  // Cleanup fallback local playback on unmount
  useEffect(() => {
    return () => {
      if (localPlaying) {
        midiSynth.stop();
      }
    };
  }, [localPlaying]);

  const effectivePlaying = onTogglePlay ? isPlaying : localPlaying;

  const handlePlayPause = () => {
    if (onTogglePlay) {
      onTogglePlay();
      return;
    }
    if (localPlaying) {
      midiSynth.stop();
      setLocalPlaying(false);
      return;
    }
    setLocalPlaying(true);
    midiSynth.start({
      notes,
      fromSec: playheadSec,
      durationSec: Math.max(1, durationSeconds),
      tempoBpm,
      playbackRate: localRate,
      volume: 0.85,
      loop: false,
      metronome: false,
      onPosition: (sec) => onPlayheadChange?.(sec),
      onEnd: () => setLocalPlaying(false),
    });
  };

  const handleStop = () => {
    if (onStop) {
      onStop();
      return;
    }
    midiSynth.stop();
    setLocalPlaying(false);
    onPlayheadChange?.(0);
  };

  // Determine available SATB / part options
  const trackByIndex = useMemo(() => {
    const m = new Map<number, ScoreTrack>();
    for (const t of tracks) m.set(t.index, t);
    return m;
  }, [tracks]);

  const hasSatbParts = useMemo(
    () => tracks.some((t) => resolveTrackVoiceRole(t) !== "other"),
    [tracks],
  );

  // Canvas requestAnimationFrame render loop driven by authoritative playback clock
  useEffect(() => {
    let active = true;
    const renderFrame = () => {
      if (!active) return;
      const canvas = canvasRef.current;
      const s = stateRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const dpr = window.devicePixelRatio || 1;
          const targetW = Math.max(1, Math.floor(containerWidth * dpr));
          const targetH = Math.floor(CANVAS_HEIGHT * dpr);
          if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
          }
          ctx.save();
          ctx.scale(dpr, dpr);

          // Authoritative playback clock: freeze immediately when paused/stopped
          const synthClock = midiSynth.getPlaybackClock();
          const currentSec =
            (s.isPlaying || s.localPlaying) && synthClock.isPlaying
              ? synthClock.currentSec
              : s.playheadSec;

          // 1. Background
          ctx.fillStyle = "#09090F";
          ctx.fillRect(0, 0, containerWidth, CANVAS_HEIGHT);

          // 2. Subtle octave vertical guides (C1..C8)
          for (const [pitch, rect] of s.keyLayout.entries()) {
            if (pitch % 12 === 0) {
              ctx.fillStyle = "rgba(167, 139, 250, 0.06)";
              ctx.fillRect(rect.x, 0, 1, HIT_LINE_Y);
            } else if (rect.isBlack) {
              ctx.fillStyle = "rgba(255, 255, 255, 0.015)";
              ctx.fillRect(rect.x, 0, rect.width, HIT_LINE_Y);
            }
          }

          // 3. Beat / measure horizontal time grid
          const secPerBeat = 60 / Math.max(20, s.tempoBpm || 120);
          const beatsPerBar = Math.max(1, Number.parseInt((s.timeSignature || "4/4").split("/")[0] || "4", 10) || 4);
          const pxPerSec = HIT_LINE_Y / Math.max(0.5, s.lookAheadSec);
          const firstBeat = Math.floor(currentSec / secPerBeat);
          const lastBeat = Math.ceil((currentSec + s.lookAheadSec) / secPerBeat);
          for (let b = firstBeat; b <= lastBeat; b++) {
            const beatSec = b * secPerBeat;
            const y = HIT_LINE_Y - (beatSec - currentSec) * pxPerSec;
            if (y < 0 || y > HIT_LINE_Y) continue;
            const isBar = b % beatsPerBar === 0;
            ctx.strokeStyle = isBar ? "rgba(167, 139, 250, 0.24)" : "rgba(39, 39, 58, 0.55)";
            ctx.lineWidth = isBar ? 1.2 : 0.75;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(containerWidth, y);
            ctx.stroke();
          }

          // 4. Falling MIDI note bars
          const positioned = computeCascadeNotePositions(
            s.notes,
            currentSec,
            s.lookAheadSec,
            HIT_LINE_Y,
            s.activeMidiPitches,
          );

          const activeFilter = s.satbSoloVoice || (s.localPartFilter !== "all" ? s.localPartFilter : null);

          for (let i = 0; i < positioned.length; i++) {
            const item = positioned[i];
            const rect = s.keyLayout.get(item.note.pitch_midi);
            if (!rect) continue;

            const track = s.tracks.find((t) => t.index === item.note.track_index);
            const role = resolveTrackVoiceRole(track);
            const roleKey = role !== "other" ? role : `track_${item.note.track_index}`;
            const isMuted = role !== "other" ? Boolean(s.satbMutedVoices[role]) : Boolean(track?.muted);
            const isDimmed =
              isMuted || (activeFilter !== null && roleKey !== activeFilter && role !== activeFilter);

            const palette = getCascadeTrackPalette(track, item.note.track_index);
            const pad = rect.isBlack ? 0.5 : 1;
            const barX = rect.x + pad;
            const barW = Math.max(4, rect.width - pad * 2);
            const clippedTop = Math.max(0, item.topY);
            const clippedBottom = Math.min(HIT_LINE_Y, item.bottomY);
            const barH = Math.max(3, clippedBottom - clippedTop);

            ctx.save();
            ctx.globalAlpha = isDimmed ? 0.18 : 0.94;

            if (item.isMatchedLive) {
              ctx.shadowColor = "#34D399";
              ctx.shadowBlur = 12;
            } else if (item.isAtHitLine && !isDimmed) {
              ctx.shadowColor = palette.fill;
              ctx.shadowBlur = 8;
            }

            ctx.fillStyle = item.isMatchedLive ? "#6EE7B7" : palette.fill;
            drawRoundedRect(ctx, barX, clippedTop, barW, barH, 3);
            ctx.fill();

            ctx.strokeStyle = item.isMatchedLive ? "#ECFDF5" : palette.stroke;
            ctx.lineWidth = item.isMatchedLive ? 1.5 : 0.75;
            ctx.stroke();

            // Subtle highlight edge
            if (barH > 6 && !isDimmed) {
              ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
              ctx.fillRect(barX + 1, clippedTop + 1, Math.max(1, barW - 2), 2);
            }

            // Pitch label when bar has sufficient height & width
            if (s.showPitchLabels && !isDimmed && barH >= 15 && barW >= 12) {
              ctx.fillStyle = palette.text;
              ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillText(
                midiToNoteName(item.note.pitch_midi),
                barX + barW / 2,
                clippedTop + barH / 2,
                barW - 2,
              );
            }
            ctx.restore();
          }

          // 5. Hit Line & Live MIDI Key Response
          const beatPhase = (currentSec / secPerBeat) % 1;
          const beatPulse = s.showBeatIndicator && (s.isPlaying || s.localPlaying) ? Math.max(0, 1 - beatPhase * 2.5) : 0;

          ctx.strokeStyle = beatPulse > 0.2 ? "rgba(52, 211, 153, 0.9)" : "rgba(167, 139, 250, 0.65)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(0, HIT_LINE_Y);
          ctx.lineTo(containerWidth, HIT_LINE_Y);
          ctx.stroke();

          for (const pitch of s.activeMidiPitches) {
            const rect = s.keyLayout.get(pitch);
            if (!rect) continue;
            ctx.save();
            ctx.fillStyle = "rgba(167, 139, 250, 0.85)";
            ctx.shadowColor = "#A78BFA";
            ctx.shadowBlur = 10;
            ctx.fillRect(rect.x, HIT_LINE_Y - 4, rect.width, 8);
            ctx.restore();
          }

          ctx.restore();
        }
      }
      rafRef.current = requestAnimationFrame(renderFrame);
    };

    rafRef.current = requestAnimationFrame(renderFrame);
    return () => {
      active = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [containerWidth]);

  // Visual beat pill indicator
  const secPerBeat = 60 / Math.max(20, tempoBpm || 120);
  const currentBeat = Math.floor(playheadSec / secPerBeat) + 1;

  return (
    <div data-testid="practice-cascade-view" className="space-y-2 w-full min-w-0">
      {/* Practice Cascade Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#27273A] bg-[#09090F] px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={handlePlayPause} aria-label={effectivePlaying ? "Pause cascade" : "Play cascade"}>
            {effectivePlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {effectivePlaying ? "Pause" : "Play"}
          </Button>
          <Button size="sm" variant="secondary" onClick={handleStop} aria-label="Stop cascade">
            <Square className="h-3.5 w-3.5" />
            Stop
          </Button>

          <label className="inline-flex items-center gap-1.5 text-[#A1A1AA]">
            <span>Speed:</span>
            <select
              aria-label="Cascade playback speed"
              value={localRate}
              onChange={(e) => {
                const next = Number(e.target.value);
                setLocalRate(next);
                onPlaybackRateChange?.(next);
              }}
              className="rounded border border-[#27273A] bg-[#181825] px-1.5 py-0.5 text-xs text-[#F5F3FF]"
            >
              <option value={0.5}>0.5x ({Math.round(tempoBpm * 0.5)} BPM)</option>
              <option value={0.75}>0.75x ({Math.round(tempoBpm * 0.75)} BPM)</option>
              <option value={1}>1.0x ({Math.round(tempoBpm)} BPM)</option>
              <option value={1.25}>1.25x ({Math.round(tempoBpm * 1.25)} BPM)</option>
            </select>
          </label>

          <label className="inline-flex items-center gap-1.5 text-[#A1A1AA]">
            <span>Look-ahead:</span>
            <input
              type="range"
              aria-label="Look-ahead window"
              min={1.5}
              max={6.0}
              step={0.5}
              value={lookAheadSec}
              onChange={(e) => setLookAheadSec(Number(e.target.value))}
              className="w-20 accent-[#8B5CF6]"
            />
            <span className="font-mono w-7 text-[#F5F3FF]">{lookAheadSec.toFixed(1)}s</span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {tracks.length > 0 && (
            <label className="inline-flex items-center gap-1.5 text-[#A1A1AA]">
              <span>Part:</span>
              <select
                aria-label="Cascade SATB part filter"
                value={satbSoloVoice ?? localPartFilter}
                onChange={(e) => {
                  const val = e.target.value;
                  setLocalPartFilter(val);
                  if (onSatbSoloChange) {
                    onSatbSoloChange(val === "all" ? null : val);
                  }
                }}
                className="rounded border border-[#27273A] bg-[#181825] px-1.5 py-0.5 text-xs text-[#F5F3FF]"
              >
                <option value="all">All Parts</option>
                {hasSatbParts ? (
                  <>
                    <option value="soprano">Soprano</option>
                    <option value="alto">Alto</option>
                    <option value="tenor">Tenor</option>
                    <option value="bass">Bass</option>
                  </>
                ) : (
                  tracks.map((t) => (
                    <option key={t.index} value={`track_${t.index}`}>
                      {t.name}
                    </option>
                  ))
                )}
              </select>
            </label>
          )}

          <label className="inline-flex items-center gap-1 text-[#A1A1AA] cursor-pointer">
            <input
              type="checkbox"
              checked={showPitchLabels}
              onChange={(e) => setShowPitchLabels(e.target.checked)}
              className="accent-[#8B5CF6]"
            />
            Pitch Labels
          </label>

          <label className="inline-flex items-center gap-1 text-[#A1A1AA] cursor-pointer">
            <input
              type="checkbox"
              checked={showBeatIndicator}
              onChange={(e) => setShowBeatIndicator(e.target.checked)}
              className="accent-[#8B5CF6]"
            />
            Beat
          </label>

          {showBeatIndicator && (
            <span
              data-testid="cascade-beat-indicator"
              className={`rounded px-1.5 py-0.5 font-mono text-[11px] border ${
                effectivePlaying
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                  : "border-[#27273A] bg-[#181825] text-[#A1A1AA]"
              }`}
            >
              Beat {currentBeat}
            </span>
          )}
        </div>
      </div>

      {/* SATB / Part Color Legend */}
      {hasSatbParts && (
        <div className="flex flex-wrap items-center gap-3 px-1 text-[11px] text-[#A1A1AA]">
          {(["soprano", "alto", "tenor", "bass"] as const).map((role) => {
            const p = SATB_CASCADE_COLORS[role];
            const muted = Boolean(satbMutedVoices[role]);
            return (
              <span key={role} className={`inline-flex items-center gap-1.5 ${muted ? "opacity-40 line-through" : ""}`}>
                <span className="h-2.5 w-2.5 rounded-sm inline-block" style={{ backgroundColor: p.fill }} />
                <span>{p.label}</span>
              </span>
            );
          })}
          {trackByIndex.size === 0 && null}
        </div>
      )}

      {/* Falling Notes Canvas aligned with VirtualPianoKeyboard */}
      <div className="w-full overflow-x-auto rounded-lg border border-[#27273A] bg-[#09090F] p-1.5">
        <div className="min-w-[780px] w-full">
          <canvas
            ref={canvasRef}
            data-testid="practice-cascade-canvas"
            style={{ width: `${containerWidth}px`, height: `${CANVAS_HEIGHT}px` }}
            className="block rounded-t-md"
          />
        </div>
      </div>
    </div>
  );
}
