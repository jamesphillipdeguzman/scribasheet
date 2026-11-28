import { Link, useLocation } from "react-router-dom";
import { ListMusic, Pause, Play, Repeat, SkipBack, SkipForward, X } from "lucide-react";
import { useAuth } from "@/features/auth/AuthContext";
import { useOptionalPlaylists } from "@/features/playlists/PlaylistContext";
import { formatDuration } from "@/lib/utils";

export function PersistentMiniPlayer() {
  const { user } = useAuth();
  const location = useLocation();
  const ctx = useOptionalPlaylists();

  if (!ctx || !user) return null;
  if (!ctx.library.preferences.miniPlayerEnabled) return null;
  if (!ctx.activeTrack) return null;
  if (location.pathname.startsWith("/playlists")) return null;

  const { activeTrack, activePlaylist, isPlaying, currentTimeSec, durationSec, appliedPlaybackRate } = ctx;
  const hasLoop =
    activeTrack.loop.aSec !== null &&
    activeTrack.loop.bSec !== null &&
    activeTrack.loop.bSec > activeTrack.loop.aSec;

  return (
    <aside
      data-testid="persistent-mini-player"
      aria-label="Persistent Listening Mini-Player"
      className="fixed bottom-4 right-4 z-40 w-[calc(100vw-2rem)] max-w-md rounded-xl border border-stone-300 bg-white/95 p-3 text-stone-900 shadow-2xl backdrop-blur-md dark:border-[#27273A] dark:bg-[#11111B]/95 dark:text-[#F5F3FF]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-900 dark:bg-violet-500/20 dark:text-violet-300">
              {activeTrack.sourceType === "youtube" ? "YouTube" : "Project Audio"}
            </span>
            {activePlaylist && (
              <span className="truncate text-[11px] text-stone-600 dark:text-[#A1A1AA]">
                {activePlaylist.title}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs font-semibold" title={activeTrack.title}>
            {activeTrack.title}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => void ctx.previousTrack()}
            aria-label="Previous track"
            title="Previous track"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-stone-300 bg-stone-50 text-stone-800 hover:bg-stone-200 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#F5F3FF] dark:hover:bg-white/10"
          >
            <SkipBack className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void ctx.togglePlay()}
            aria-label={isPlaying ? "Pause playback" : "Resume playback"}
            data-testid="mini-player-toggle-play"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#8B5CF6] text-white hover:bg-[#7C3AED]"
          >
            {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => void ctx.nextTrack()}
            aria-label="Next track"
            title="Next track"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-stone-300 bg-stone-50 text-stone-800 hover:bg-stone-200 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#F5F3FF] dark:hover:bg-white/10"
          >
            <SkipForward className="h-3.5 w-3.5" />
          </button>
          <Link
            to="/playlists"
            aria-label="Open Playlists workspace"
            title="Open Playlists workspace"
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-stone-300 px-2 text-[11px] font-medium text-stone-800 hover:bg-stone-100 dark:border-[#27273A] dark:text-[#F5F3FF] dark:hover:bg-white/10"
          >
            <ListMusic className="h-3.5 w-3.5 text-[#A78BFA]" />
          </Link>
          <button
            type="button"
            onClick={() => {
              ctx.pause();
              ctx.setMiniPlayerEnabled(false);
            }}
            aria-label="Close persistent mini-player"
            title="Hide and disable mini-player"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-200 hover:text-stone-900 dark:text-[#A1A1AA] dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-stone-600 dark:text-[#A1A1AA] font-mono tabular-nums">
        <span>
          {formatDuration(currentTimeSec)} / {durationSec > 0 ? formatDuration(durationSec) : "--:--"}
        </span>
        <div className="flex items-center gap-2">
          <span>{appliedPlaybackRate}x</span>
          {hasLoop && (
            <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-300">
              <Repeat className="h-2.5 w-2.5" />
              {formatDuration(activeTrack.loop.aSec!)}–{formatDuration(activeTrack.loop.bSec!)}
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}
