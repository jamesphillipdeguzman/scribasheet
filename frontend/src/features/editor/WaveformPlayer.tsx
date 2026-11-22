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
}: WaveformPlayerProps) {
  const waveContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);

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
      })
      .catch(() => {
        if (!cancelled) setSignedAudioUrl(null);
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

  const startMidiPlayback = (fromSec: number) => {
    if (wsRef.current?.isPlaying()) wsRef.current.pause();
    const beginSynth = () => {
      setIsPlaying(true);
      midiSynth.start({
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
      midiSynth.stop();
      wsRef.current.play();
      setIsPlaying(true);
    } else {
      startMidiPlayback(playheadSec);
    }
  };

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

  return (
    <div className="rounded-xl border border-[#27273A] bg-[#11111B] p-3 sm:p-4 space-y-3 w-full min-w-0 overflow-visible">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={togglePlay} aria-label={isPlaying ? "Pause playback" : "Play"}>
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
        <div className="inline-flex rounded-lg border border-[#27273A] bg-[#09090F] p-0.5 text-xs">
          {!isScoreOnly && (
            <button
              type="button"
              disabled={!signedAudioUrl}
              onClick={() => {
                stopAll();
                setSourceMode("original");
              }}
              className={`rounded-md px-3 py-1 transition-colors disabled:opacity-40 ${
                sourceMode === "original" ? "bg-[#8B5CF6] text-[#F5F3FF]" : "text-[#A1A1AA]"
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
              sourceMode === "midi" ? "bg-[#8B5CF6] text-[#F5F3FF]" : "text-[#A1A1AA]"
            }`}
          >
            {isScoreOnly ? "Synthesized Score Playback" : "Transcribed MIDI"}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-[#A1A1AA]">
          <button
            type="button"
            onClick={() => setLoop(!loop)}
            className={`inline-flex items-center gap-1 rounded px-2 py-1 border ${
              loop ? "border-[#A78BFA] text-[#A78BFA] bg-[#181825]" : "border-[#27273A]"
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
            className="h-7 rounded border border-[#27273A] bg-[#09090F] px-2 text-xs text-[#F5F3FF]"
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
        <div ref={waveContainerRef} className="w-full min-w-0 overflow-hidden rounded-lg bg-[#09090F] p-2 border border-[#27273A]" />
      ) : (
        <div className="rounded-lg bg-[#09090F] p-3 text-xs text-[#71717A] border border-[#27273A]">
          Waveform preview appears after uploading an audio or video recording.
        </div>
      )}
    </div>
  );
}
