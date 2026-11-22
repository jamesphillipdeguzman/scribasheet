import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { Pause, Play, Repeat, Square, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatDuration } from "@/lib/utils";
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
  const [metronome, setMetronome] = useState(false);
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
    };
  }, []);

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
      if (wsRef.current?.isPlaying()) wsRef.current.pause();
      setIsPlaying(true);
      midiSynth.start({
        notes,
        fromSec: target,
        durationSec: durationSeconds,
        tempoBpm,
        playbackRate,
        volume,
        loop,
        metronome,
        onPosition: onPlayheadChange,
        onEnd: () => setIsPlaying(false),
      });
    }
  }, [seekRequest?.nonce]);

  const stopAll = () => {
    midiSynth.stop();
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
      if (wsRef.current?.isPlaying()) wsRef.current.pause();
      setIsPlaying(true);
      midiSynth.start({
        notes,
        fromSec: playheadSec,
        durationSec: durationSeconds,
        tempoBpm,
        playbackRate,
        volume,
        loop,
        metronome,
        onPosition: onPlayheadChange,
        onEnd: () => setIsPlaying(false),
      });
    }
  };

  const handleStopReset = () => {
    stopAll();
    if (wsRef.current) wsRef.current.seekTo(0);
    onPlayheadChange(0);
  };

  return (
    <div className="rounded-xl border border-[#27273A] bg-[#11111B] p-3 sm:p-4 space-y-3 w-full min-w-0 overflow-hidden">
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
          <button
            type="button"
            onClick={() => setMetronome(!metronome)}
            className={`rounded px-2 py-1 border ${
              metronome ? "border-[#A78BFA] text-[#A78BFA] bg-[#181825]" : "border-[#27273A]"
            }`}
          >
            Metronome
          </button>
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
