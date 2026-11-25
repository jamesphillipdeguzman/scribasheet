import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { Pause, Play, Repeat, Square, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatDuration } from "@/lib/utils";
import { MetronomeControl } from "@/features/editor/MetronomeControl";
import {
  loadMetronomeSettings,
  metronomeEngine,
  type MetronomeSettings,
  saveMetronomeSettings,
} from "@/features/editor/metronome";
import { midiSynth } from "@/features/editor/midiSynth";
import { API_BASE_URL, api } from "@/services/api";
import type { ScoreNote } from "@/types/api";

interface WaveformPlayerProps {
  mediaAssetId: string | null;
  isScoreOnly?: boolean;
  notes: ScoreNote[];
  durationSeconds: number;
  tempoBpm: number;
  playheadSec: number;
  onPlayheadChange: (sec: number) => void;
  seekRequest?: { sec: number; autoplay?: boolean; nonce: number } | null;
  onPlayingChange?: (playing: boolean) => void;
  externalToggleSignal?: number;
  externalStopSignal?: number;
  externalPlaybackRate?: number;
  onPlaybackRateChange?: (rate: number) => void;
  externalLoop?: boolean;
  onLoopChange?: (loop: boolean) => void;
  timeSignature?: string;
  metronomeSettings?: MetronomeSettings;
  onMetronomeSettingsChange?: (next: MetronomeSettings) => void;
  activeBeat?: number | null;
  onActiveBeatChange?: (beat: number | null) => void;
  trimStartSec?: number | null;
  trimEndSec?: number | null;
  onTrimChange?: (startSec: number, endSec: number) => void;
  onDecodedAudioReady?: (info: {
    durationSec: number;
    audioBuffer: AudioBuffer | null;
    signedUrl: string | null;
  }) => void;
}

export function WaveformPlayer({
  mediaAssetId,
  isScoreOnly = false,
  notes,
  durationSeconds,
  tempoBpm,
  playheadSec,
  onPlayheadChange,
  seekRequest = null,
  onPlayingChange,
  externalToggleSignal = 0,
  externalStopSignal = 0,
  externalPlaybackRate,
  onPlaybackRateChange,
  externalLoop,
  onLoopChange,
  timeSignature = "4/4",
  metronomeSettings: controlledMetronome,
  onMetronomeSettingsChange,
  activeBeat: controlledBeat,
  onActiveBeatChange,
  trimStartSec = null,
  trimEndSec = null,
  onTrimChange,
  onDecodedAudioReady,
}: WaveformPlayerProps) {
  const waveContainerRef = useRef<HTMLDivElement>(null);
  const trimOverlayRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const draggingHandleRef = useRef<"start" | "end" | null>(null);
  const onDecodedAudioReadyRef = useRef(onDecodedAudioReady);
  onDecodedAudioReadyRef.current = onDecodedAudioReady;
  const [wsDurationSec, setWsDurationSec] = useState<number>(0);

  const [sourceMode, setSourceMode] = useState<"midi" | "original">(
    !isScoreOnly && mediaAssetId ? "original" : "midi",
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [volume, setVolume] = useState(0.8);
  const [loop, setLoop] = useState(false);
  const [internalMetronome, setInternalMetronome] = useState<MetronomeSettings>(() =>
    loadMetronomeSettings(),
  );
  const [internalBeat, setInternalBeat] = useState<number | null>(null);
  const metronomeSettings = controlledMetronome ?? internalMetronome;
  const activeBeat = controlledBeat !== undefined ? controlledBeat : internalBeat;
  const setMetronomeSettings = (next: MetronomeSettings) => {
    setInternalMetronome(next);
    saveMetronomeSettings(next);
    onMetronomeSettingsChange?.(next);
  };
  const setActiveBeat = (beat: number | null) => {
    setInternalBeat(beat);
    onActiveBeatChange?.(beat);
  };
  const [signedAudioUrl, setSignedAudioUrl] = useState<string | null>(null);

  useEffect(() => {
    if (isScoreOnly || !mediaAssetId) {
      if (isScoreOnly) setSourceMode("midi");
      setSignedAudioUrl(null);
      setWsDurationSec(0);
      onDecodedAudioReadyRef.current?.({ durationSec: 0, audioBuffer: null, signedUrl: null });
      if (wsRef.current) {
        if (wsRef.current.isPlaying()) wsRef.current.pause();
        wsRef.current.destroy();
        wsRef.current = null;
      }
      setIsPlaying(false);
      onPlayheadChange(0);
      return;
    }
    let cancelled = false;
    api
      .getSignedMediaUrl(mediaAssetId)
      .then((res) => {
        if (cancelled) return;
        const full = res.url.startsWith("http")
          ? res.url
          : `${API_BASE_URL.replace(/\/api\/v1$/, "")}${res.url}`;
        setSignedAudioUrl(full);
        onDecodedAudioReadyRef.current?.({
          durationSec: durationSeconds,
          audioBuffer: null,
          signedUrl: full,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setSignedAudioUrl(null);
          onDecodedAudioReadyRef.current?.({ durationSec: 0, audioBuffer: null, signedUrl: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mediaAssetId]);

  useEffect(() => {
    if (!waveContainerRef.current || !signedAudioUrl) return;
    const ws = WaveSurfer.create({
      container: waveContainerRef.current,
      waveColor: "#3F3F5C",
      progressColor: "#A78BFA",
      cursorColor: "#34D399",
      height: 64,
      barWidth: 2,
      barGap: 1,
      url: signedAudioUrl,
    });
    ws.on("ready", (dur) => {
      const resolvedDur = Number.isFinite(dur) && dur > 0 ? dur : ws.getDuration?.() || durationSeconds;
      if (resolvedDur > 0) setWsDurationSec(resolvedDur);
      // Do not forward WaveSurfer's preview getDecodedData() (default 8000 Hz) to AudioTrimPanel;
      // trimming decodes full-resolution audio directly via decodeAudioBufferFromUrl().
      onDecodedAudioReadyRef.current?.({
        durationSec: resolvedDur,
        audioBuffer: null,
        signedUrl: signedAudioUrl,
      });
    });
    ws.on("timeupdate", (t) => onPlayheadChange(t));
    ws.on("finish", () => {
      if (loop) {
        ws.play(0);
      } else {
        setIsPlaying(false);
      }
    });
    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [signedAudioUrl]);

  useEffect(() => {
    if (wsRef.current) {
      wsRef.current.setPlaybackRate(playbackRate);
      wsRef.current.setVolume(volume);
    }
  }, [playbackRate, volume]);

  useEffect(() => {
    midiSynth.preloadPiano();
    return () => {
      midiSynth.stop();
      if (metronomeEngine.getMode() !== "standalone") {
        metronomeEngine.stop();
      }
    };
  }, []);

  // Synchronize Web Audio metronome with active playback (Original Audio OR MIDI)
  useEffect(() => {
    if (!isPlaying) {
      if (metronomeEngine.getMode() === "synced") {
        metronomeEngine.stop();
      }
      return;
    }
    if (!metronomeSettings.enabled) {
      if (metronomeEngine.getMode() === "synced") {
        metronomeEngine.stop();
      }
      return;
    }
    if (metronomeEngine.getMode() === "count_in") {
      return;
    }

    const getSongSec = () => {
      if (sourceMode === "original" && wsRef.current) {
        return wsRef.current.getCurrentTime();
      }
      const clock = midiSynth.getPlaybackClock();
      return clock.isPlaying ? clock.currentSec : playheadSec;
    };

    if (metronomeEngine.getMode() === "synced") {
      metronomeEngine.updateSynced({
        getSongSec,
        bpm: tempoBpm,
        playbackRate,
        scoreTimeSignature: timeSignature,
        settings: metronomeSettings,
        onBeatChange: setActiveBeat,
      });
    } else {
      metronomeEngine.startSynced({
        getSongSec,
        bpm: tempoBpm,
        playbackRate,
        scoreTimeSignature: timeSignature,
        settings: metronomeSettings,
        onBeatChange: setActiveBeat,
      });
    }
  }, [isPlaying, sourceMode, metronomeSettings, tempoBpm, playbackRate, timeSignature]);

  const playAttemptRef = useRef(0);

  const startMidiPlayback = async (fromSec: number) => {
    const attemptId = ++playAttemptRef.current;
    if (wsRef.current?.isPlaying()) wsRef.current.pause();

    if (midiSynth.needsSamplerWait()) {
      await midiSynth.loaded();
      if (attemptId !== playAttemptRef.current) return;
    }

    const beginSynth = () => {
      if (attemptId !== playAttemptRef.current) return;
      setIsPlaying(true);
      void midiSynth.start({
        notes,
        fromSec,
        durationSec: durationSeconds,
        tempoBpm,
        playbackRate,
        volume,
        loop,
        metronome: false,
        onPosition: onPlayheadChange,
        onEnd: () => {
          setIsPlaying(false);
          metronomeEngine.stop();
        },
      });
    };

    if (
      metronomeSettings.enabled &&
      (metronomeSettings.countInBars === 1 || metronomeSettings.countInBars === 2)
    ) {
      setIsPlaying(true);
      metronomeEngine.startCountIn({
        bars: metronomeSettings.countInBars,
        bpm: tempoBpm,
        scoreTimeSignature: timeSignature,
        settings: metronomeSettings,
        onBeatChange: setActiveBeat,
        onComplete: beginSynth,
      });
    } else {
      beginSynth();
    }
  };

  useEffect(() => {
    if (!seekRequest) return;
    const target = Math.max(0, seekRequest.sec);
    onPlayheadChange(target);
    if (sourceMode === "original" && wsRef.current) {
      const dur = wsRef.current.getDuration() || durationSeconds || 1;
      wsRef.current.seekTo(Math.min(1, target / Math.max(0.01, dur)));
      if (seekRequest.autoplay) {
        midiSynth.stop();
        void wsRef.current.play();
        setIsPlaying(true);
      }
    } else if (seekRequest.autoplay) {
      startMidiPlayback(target);
    }
  }, [seekRequest?.nonce]);

  const stopAll = () => {
    playAttemptRef.current++;
    midiSynth.stop();
    if (metronomeEngine.getMode() !== "standalone") {
      metronomeEngine.stop();
    }
    if (wsRef.current?.isPlaying()) wsRef.current.pause();
    setIsPlaying(false);
  };

  const togglePlay = () => {
    if (isPlaying) {
      stopAll();
      return;
    }
    if (sourceMode === "original" && wsRef.current) {
      playAttemptRef.current++;
      midiSynth.stop();
      wsRef.current.play();
      setIsPlaying(true);
    } else {
      void startMidiPlayback(playheadSec);
    }
  };

  const togglePlayRef = useRef(togglePlay);
  togglePlayRef.current = togglePlay;

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable ||
          (typeof target.closest === "function" &&
            target.closest('input, textarea, select, [contenteditable="true"]') !== null))
      ) {
        return;
      }
      e.preventDefault();
      togglePlayRef.current();
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  const handleStopReset = () => {
    stopAll();
    if (wsRef.current) wsRef.current.seekTo(0);
    onPlayheadChange(0);
  };

  useEffect(() => {
    onPlayingChange?.(isPlaying);
  }, [isPlaying, onPlayingChange]);

  useEffect(() => {
    if (externalPlaybackRate !== undefined && externalPlaybackRate !== playbackRate) {
      setPlaybackRate(externalPlaybackRate);
    }
  }, [externalPlaybackRate]);

  useEffect(() => {
    onPlaybackRateChange?.(playbackRate);
  }, [playbackRate, onPlaybackRateChange]);

  useEffect(() => {
    if (externalLoop !== undefined && externalLoop !== loop) {
      setLoop(externalLoop);
    }
  }, [externalLoop]);

  useEffect(() => {
    onLoopChange?.(loop);
  }, [loop, onLoopChange]);

  const prevToggleRef = useRef(externalToggleSignal);
  useEffect(() => {
    if (externalToggleSignal > 0 && externalToggleSignal !== prevToggleRef.current) {
      prevToggleRef.current = externalToggleSignal;
      togglePlay();
    }
  }, [externalToggleSignal]);

  const prevStopRef = useRef(externalStopSignal);
  useEffect(() => {
    if (externalStopSignal > 0 && externalStopSignal !== prevStopRef.current) {
      prevStopRef.current = externalStopSignal;
      handleStopReset();
    }
  }, [externalStopSignal]);

  const trimTotalDuration = wsDurationSec > 0 ? wsDurationSec : durationSeconds;
  const showTrimOverlay = Boolean(
    !isScoreOnly &&
      signedAudioUrl &&
      onTrimChange &&
      trimStartSec != null &&
      trimEndSec != null &&
      trimTotalDuration > 0,
  );
  const clampedTrimStart = showTrimOverlay
    ? Math.max(0, Math.min(trimTotalDuration - 0.2, trimStartSec ?? 0))
    : 0;
  const clampedTrimEnd = showTrimOverlay
    ? Math.min(trimTotalDuration, Math.max(clampedTrimStart + 0.2, trimEndSec ?? trimTotalDuration))
    : trimTotalDuration;
  const startPct = trimTotalDuration > 0 ? (clampedTrimStart / trimTotalDuration) * 100 : 0;
  const endPct = trimTotalDuration > 0 ? (clampedTrimEnd / trimTotalDuration) * 100 : 100;

  const updateHandleFromClientX = (handle: "start" | "end", clientX: number) => {
    if (!trimOverlayRef.current || !onTrimChange || trimTotalDuration <= 0) return;
    const rect = trimOverlayRef.current.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const sec = Math.round(ratio * trimTotalDuration * 100) / 100;
    if (handle === "start") {
      onTrimChange(Math.min(sec, Math.max(0, clampedTrimEnd - 0.2)), clampedTrimEnd);
    } else {
      onTrimChange(clampedTrimStart, Math.max(sec, Math.min(trimTotalDuration, clampedTrimStart + 0.2)));
    }
  };

  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      if (!draggingHandleRef.current) return;
      updateHandleFromClientX(draggingHandleRef.current, ev.clientX);
    };
    const onUp = () => {
      draggingHandleRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  });

  const nudgeHandle = (handle: "start" | "end", delta: number) => {
    if (!onTrimChange || trimTotalDuration <= 0) return;
    if (handle === "start") {
      const next = Math.max(0, Math.min(clampedTrimEnd - 0.2, Math.round((clampedTrimStart + delta) * 100) / 100));
      onTrimChange(next, clampedTrimEnd);
    } else {
      const next = Math.min(
        trimTotalDuration,
        Math.max(clampedTrimStart + 0.2, Math.round((clampedTrimEnd + delta) * 100) / 100),
      );
      onTrimChange(clampedTrimStart, next);
    }
  };

  return (
    <div className="rounded-xl border border-[#27273A] bg-[#11111B] p-3 sm:p-4 space-y-3 w-full min-w-0 overflow-visible">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={togglePlay}
            title="Play / Stop (Space)"
            aria-label={isPlaying ? "Pause playback" : "Play"}
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {isPlaying ? "Pause" : "Play"}
          </Button>
          <Button size="sm" variant="secondary" onClick={handleStopReset} aria-label="Stop playback">
            <Square className="h-3.5 w-3.5" />
          </Button>
          <span className="font-mono text-xs text-[#A1A1AA] ml-1">
            {formatDuration(playheadSec)} / {formatDuration(durationSeconds)}
          </span>
        </div>

        {/* A/B Switch */}
        <div className="inline-flex rounded-lg border border-stone-300 bg-stone-200/80 p-0.5 text-xs dark:border-[#27273A] dark:bg-[#09090F]">
          {!isScoreOnly && (
            <button
              type="button"
              disabled={!signedAudioUrl}
              onClick={() => {
                stopAll();
                setSourceMode("original");
              }}
              className={`rounded-md px-3 py-1 transition-colors disabled:opacity-40 ${
                sourceMode === "original"
                  ? "bg-violet-600 text-white shadow-sm font-semibold dark:bg-[#8B5CF6] dark:text-[#F5F3FF] dark:font-medium"
                  : "text-stone-700 hover:text-stone-950 hover:bg-white/60 font-medium dark:text-[#A1A1AA] dark:hover:text-[#F5F3FF] dark:hover:bg-transparent"
              }`}
            >
              Original Audio
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              stopAll();
              setSourceMode("midi");
            }}
            className={`rounded-md px-3 py-1 transition-colors ${
              sourceMode === "midi"
                ? "bg-violet-600 text-white shadow-sm font-semibold dark:bg-[#8B5CF6] dark:text-[#F5F3FF] dark:font-medium"
                : "text-stone-700 hover:text-stone-950 hover:bg-white/60 font-medium dark:text-[#A1A1AA] dark:hover:text-[#F5F3FF] dark:hover:bg-transparent"
            }`}
          >
            {isScoreOnly ? "Synthesized Score Playback" : "Transcribed MIDI"}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-stone-700 dark:text-[#A1A1AA]">
          <button
            type="button"
            onClick={() => setLoop(!loop)}
            className={`inline-flex items-center gap-1 rounded px-2 py-1 border transition-colors ${
              loop
                ? "bg-violet-100 text-violet-900 border-violet-400 font-semibold dark:border-[#A78BFA] dark:text-[#A78BFA] dark:bg-[#181825] dark:font-medium"
                : "bg-white hover:bg-stone-100 text-stone-800 border-stone-300 font-medium dark:bg-transparent dark:text-[#A1A1AA] dark:border-[#27273A]"
            }`}
          >
            <Repeat className="h-3.5 w-3.5" />
            Loop
          </button>
          <MetronomeControl
            settings={metronomeSettings}
            onChangeSettings={setMetronomeSettings}
            scoreTimeSignature={timeSignature}
            tempoBpm={tempoBpm * playbackRate}
            activeBeat={activeBeat}
            isPlaybackActive={isPlaying}
            onBeatChange={setActiveBeat}
          />
          <select
            aria-label="Playback speed"
            value={playbackRate}
            onChange={(e) => setPlaybackRate(Number(e.target.value))}
            className="h-7 rounded border border-stone-300 bg-white px-2 pr-6 text-xs text-stone-900 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/20 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
          >
            <option value={0.5}>0.5x</option>
            <option value={0.75}>0.75x</option>
            <option value={1}>1.0x</option>
            <option value={1.25}>1.25x</option>
            <option value={1.5}>1.5x</option>
          </select>
          <div className="flex items-center gap-1.5">
            <Volume2 className="h-3.5 w-3.5" />
            <input
              type="range"
              aria-label="Volume"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="w-16 accent-[#A78BFA]"
            />
          </div>
        </div>
      </div>

      {signedAudioUrl ? (
        <div
          ref={trimOverlayRef}
          data-testid="waveform-trim-container"
          className="relative w-full min-w-0 overflow-hidden rounded-lg bg-[#09090F] p-2 border border-[#27273A]"
        >
          <div ref={waveContainerRef} className="w-full min-w-0" />
          {showTrimOverlay && (
            <>
              <div
                data-testid="trim-dim-left"
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-0 bg-black/55"
                style={{ width: `${startPct}%` }}
              />
              <div
                data-testid="trim-dim-right"
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-0 bg-black/55"
                style={{ width: `${Math.max(0, 100 - endPct)}%` }}
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 border-x-2 border-violet-400/90"
                style={{
                  left: `${startPct}%`,
                  width: `${Math.max(0, endPct - startPct)}%`,
                }}
              />
              <div
                role="slider"
                tabIndex={0}
                aria-label="Trim start handle"
                aria-valuemin={0}
                aria-valuemax={Math.round(clampedTrimEnd * 10) / 10}
                aria-valuenow={Math.round(clampedTrimStart * 10) / 10}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  draggingHandleRef.current = "start";
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                }}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 1.0 : 0.1;
                  if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    nudgeHandle("start", -step);
                  } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    nudgeHandle("start", step);
                  }
                }}
                className="absolute inset-y-0 -translate-x-1/2 w-3 cursor-ew-resize flex items-center justify-center focus:outline-none"
                style={{ left: `${startPct}%` }}
              >
                <span className="h-8 w-1.5 rounded-full bg-violet-400 shadow ring-1 ring-white/70" />
              </div>
              <div
                role="slider"
                tabIndex={0}
                aria-label="Trim end handle"
                aria-valuemin={Math.round(clampedTrimStart * 10) / 10}
                aria-valuemax={Math.round(trimTotalDuration * 10) / 10}
                aria-valuenow={Math.round(clampedTrimEnd * 10) / 10}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  draggingHandleRef.current = "end";
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                }}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 1.0 : 0.1;
                  if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    nudgeHandle("end", -step);
                  } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    nudgeHandle("end", step);
                  }
                }}
                className="absolute inset-y-0 -translate-x-1/2 w-3 cursor-ew-resize flex items-center justify-center focus:outline-none"
                style={{ left: `${endPct}%` }}
              >
                <span className="h-8 w-1.5 rounded-full bg-violet-400 shadow ring-1 ring-white/70" />
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="rounded-lg bg-[#09090F] p-3 text-xs text-[#71717A] border border-[#27273A]">
          Waveform preview appears after uploading an audio or video recording.
        </div>
      )}
    </div>
  );
}
