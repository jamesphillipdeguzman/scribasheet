import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  ExternalLink,
  FileAudio,
  Loader2,
  Pause,
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  Square,
  Youtube,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { usePlaylists } from "@/features/playlists/PlaylistContext";
import { PLAYBACK_SPEEDS } from "@/features/playlists/playlistTypes";
import { formatDuration } from "@/lib/utils";

export function ListeningPlayerPane() {
  const {
    library,
    activeTrack,
    activePlaylist,
    isPlaying,
    isLoadingMedia,
    playerError,
    currentTimeSec,
    durationSec,
    appliedPlaybackRate,
    speedNotice,
    loopError,
    togglePlay,
    stop,
    seekTo,
    nextTrack,
    previousTrack,
    setPlaybackRate,
    setShuffle,
    setAutoAdvance,
    setLoopA,
    setLoopB,
    clearLoop,
    registerYouTubeViewport,
  } = usePlaylists();

  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerYouTubeViewport(viewportRef.current);
    return () => {
      registerYouTubeViewport(null);
    };
  }, [registerYouTubeViewport, activeTrack?.id, activeTrack?.sourceType]);

  const { preferences } = library;
  const maxSeek = durationSec > 0 ? durationSec : Math.max(currentTimeSec, 1);

  const hasLoopA = activeTrack?.loop.aSec !== null && activeTrack?.loop.aSec !== undefined;
  const hasFullLoop =
    hasLoopA &&
    activeTrack?.loop.bSec !== null &&
    activeTrack?.loop.bSec !== undefined &&
    activeTrack.loop.bSec > (activeTrack.loop.aSec ?? 0);

  return (
    <Card className="overflow-hidden" data-testid="listening-player-pane">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-stone-900 dark:text-[#F5F3FF]">
            Listening &amp; Practice Player
          </h2>
          {activeTrack && (
            <span className="inline-flex items-center gap-1 rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-700 dark:border-[#27273A] dark:bg-[#09090F] dark:text-slate-200">
              {activeTrack.sourceType === "youtube" ? (
                <>
                  <Youtube className="h-3 w-3 text-red-500" />
                  YouTube IFrame
                </>
              ) : (
                <>
                  <FileAudio className="h-3 w-3 text-[#A78BFA]" />
                  Project Audio
                </>
              )}
            </span>
          )}
        </div>

        {/* Media Viewport */}
        {!activeTrack ? (
          <div
            data-testid="player-empty-state"
            className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-stone-300 bg-stone-50 p-4 text-center dark:border-[#27273A] dark:bg-[#09090F]"
          >
            <Play className="mb-2 h-7 w-7 text-[#A78BFA]" />
            <p className="text-xs font-medium text-stone-800 dark:text-[#F5F3FF]">
              No Track Loaded
            </p>
            <p className="mt-1 text-[11px] text-stone-600 dark:text-[#A1A1AA]">
              Click Play on any YouTube track or ScribaSheet project recording to listen and practice.
            </p>
          </div>
        ) : activeTrack.sourceType === "youtube" ? (
          <div className="space-y-2">
            <div
              ref={viewportRef}
              data-testid="youtube-viewport-slot"
              className="relative aspect-video w-full overflow-hidden rounded-xl border border-stone-300 bg-black dark:border-[#27273A]"
            >
              {isLoadingMedia && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/55 text-xs text-white">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading embedded YouTube player...
                </div>
              )}
            </div>
            {activeTrack.youtubeUrl && (
              <div className="flex items-center justify-between text-[11px] text-stone-600 dark:text-[#A1A1AA]">
                <span>Official YouTube IFrame Player API</span>
                <a
                  href={activeTrack.youtubeUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-violet-700 hover:underline dark:text-[#A78BFA]"
                >
                  Open on YouTube
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
          </div>
        ) : (
          <div
            data-testid="project-audio-viewport"
            className="rounded-xl border border-stone-300 bg-stone-50 p-4 space-y-2 dark:border-[#27273A] dark:bg-[#09090F]"
          >
            <div className="flex items-center gap-2.5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-[#A78BFA]">
                <FileAudio className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold text-stone-900 dark:text-[#F5F3FF]">
                  {activeTrack.mediaFilename || activeTrack.title}
                </div>
                <div className="truncate text-[11px] text-stone-600 dark:text-[#A1A1AA]">
                  Project: {activeTrack.projectTitle || activeTrack.projectId}
                </div>
              </div>
            </div>
            {activeTrack.projectId && (
              <Link
                to={`/projects/${activeTrack.projectId}`}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-violet-700 hover:underline dark:text-[#A78BFA]"
              >
                Open Source Project in Studio
                <ExternalLink className="h-3 w-3" />
              </Link>
            )}
          </div>
        )}

        {/* Active Track Details & Error Banner */}
        {activeTrack && (
          <div className="space-y-1">
            <div className="text-sm font-semibold text-stone-900 dark:text-[#F5F3FF] break-words">
              {activeTrack.title}
            </div>
            <div className="text-xs text-stone-600 dark:text-[#A1A1AA]">
              {activeTrack.artist || "Unknown artist"}
              {activePlaylist ? ` • ${activePlaylist.title}` : ""}
            </div>
          </div>
        )}

        {playerError && (
          <div
            role="alert"
            data-testid="player-error-alert"
            className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{playerError}</span>
          </div>
        )}

        {/* Progress & Seek Bar */}
        <div className="space-y-1.5">
          <input
            type="range"
            min={0}
            max={maxSeek}
            step={0.25}
            value={Math.min(currentTimeSec, maxSeek)}
            disabled={!activeTrack}
            onChange={(e) => seekTo(Number.parseFloat(e.target.value))}
            aria-label="Seek playback position"
            data-testid="player-seek-slider"
            className="w-full accent-[#8B5CF6]"
          />
          <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-stone-600 dark:text-[#A1A1AA]">
            <span data-testid="player-current-time">{formatDuration(currentTimeSec)}</span>
            <span data-testid="player-duration">
              {durationSec > 0 ? formatDuration(durationSec) : "--:--"}
            </span>
          </div>
        </div>

        {/* Transport Controls */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void previousTrack()}
              disabled={!activePlaylist || activePlaylist.tracks.length === 0}
              aria-label="Previous track"
              data-testid="player-prev-btn"
            >
              <SkipBack className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void togglePlay()}
              aria-label={isPlaying ? "Pause" : "Play"}
              data-testid="player-play-toggle-btn"
            >
              {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {isPlaying ? "Pause" : "Play"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={stop}
              disabled={!activeTrack}
              aria-label="Stop playback"
              data-testid="player-stop-btn"
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void nextTrack()}
              disabled={!activePlaylist || activePlaylist.tracks.length === 0}
              aria-label="Next track"
              data-testid="player-next-btn"
            >
              <SkipForward className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-pressed={preferences.shuffle}
              data-testid="player-shuffle-btn"
              onClick={() => setShuffle(!preferences.shuffle)}
              className={`inline-flex h-8 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium transition-colors ${
                preferences.shuffle
                  ? "border-violet-500 bg-violet-100 text-violet-900 dark:border-violet-400 dark:bg-violet-500/20 dark:text-violet-200"
                  : "border-stone-300 bg-white text-stone-700 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#A1A1AA]"
              }`}
            >
              <Shuffle className="h-3 w-3" />
              Shuffle
            </button>
            <button
              type="button"
              aria-pressed={preferences.autoAdvance}
              data-testid="player-autoadvance-btn"
              onClick={() => setAutoAdvance(!preferences.autoAdvance)}
              className={`inline-flex h-8 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium transition-colors ${
                preferences.autoAdvance
                  ? "border-emerald-500 bg-emerald-100 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/20 dark:text-emerald-300"
                  : "border-stone-300 bg-white text-stone-700 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#A1A1AA]"
              }`}
            >
              Auto-Advance
            </button>
          </div>
        </div>

        {/* Practice Speed Controls */}
        <div className="space-y-1.5 border-t border-stone-200 pt-3 dark:border-[#27273A]">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-stone-700 dark:text-[#A1A1AA]">
              Practice Speed
            </span>
            <span
              data-testid="applied-speed-display"
              className="font-mono text-[11px] font-semibold text-violet-700 dark:text-[#A78BFA]"
            >
              Active: {appliedPlaybackRate}x
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Playback speed selector">
            {PLAYBACK_SPEEDS.map((rate) => {
              const selected = preferences.playbackRate === rate;
              return (
                <button
                  key={rate}
                  type="button"
                  aria-pressed={selected}
                  data-testid={`speed-btn-${rate}`}
                  onClick={() => setPlaybackRate(rate)}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-mono transition-colors ${
                    selected
                      ? "border-violet-500 bg-violet-600 text-white font-semibold"
                      : "border-stone-300 bg-white text-stone-800 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#09090F] dark:text-slate-200 dark:hover:bg-white/10"
                  }`}
                >
                  {rate}x
                </button>
              );
            })}
          </div>
          {speedNotice && (
            <p
              data-testid="speed-capability-notice"
              className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
            >
              {speedNotice}
            </p>
          )}
        </div>

        {/* A–B Section Loop */}
        <div className="space-y-2 border-t border-stone-200 pt-3 dark:border-[#27273A]">
          <div className="flex items-center justify-between text-xs">
            <span className="inline-flex items-center gap-1.5 font-medium text-stone-700 dark:text-[#A1A1AA]">
              <Repeat className="h-3.5 w-3.5 text-emerald-500" />
              A–B Section Loop
            </span>
            {hasFullLoop ? (
              <span
                data-testid="active-loop-range"
                className="rounded bg-emerald-100 px-2 py-0.5 font-mono text-[11px] font-semibold text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-300"
              >
                Looping {formatDuration(activeTrack!.loop.aSec!)} – {formatDuration(activeTrack!.loop.bSec!)}
              </span>
            ) : hasLoopA ? (
              <span
                data-testid="active-loop-range"
                className="rounded bg-amber-100 px-2 py-0.5 font-mono text-[11px] font-medium text-amber-900 dark:bg-amber-500/20 dark:text-amber-300"
              >
                A: {formatDuration(activeTrack!.loop.aSec!)} (Set B next)
              </span>
            ) : (
              <span className="text-[11px] text-stone-500 dark:text-[#71717A]">Inactive</span>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!activeTrack}
              data-testid="loop-set-a-btn"
              onClick={setLoopA}
            >
              Set A
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!activeTrack}
              data-testid="loop-set-b-btn"
              onClick={setLoopB}
            >
              Set B
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!activeTrack || (!hasLoopA && !hasFullLoop)}
              data-testid="loop-clear-btn"
              onClick={clearLoop}
            >
              Clear Loop
            </Button>
          </div>

          {loopError && (
            <p
              role="alert"
              data-testid="loop-error-msg"
              className="text-[11px] text-red-700 dark:text-red-300"
            >
              {loopError}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
