import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  AlertCircle,
  ExternalLink,
  ListMusic,
  Loader2,
  Lock,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  Square,
  Youtube,
} from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { PLAYBACK_SPEEDS, type PlaybackSpeed, type PublicSharedPlaylist, type PublicSharedTrack } from "@/features/playlists/playlistTypes";
import {
  describeYouTubePlayerError,
  loadYouTubeIframeApi,
  YT_STATE,
  type YTPlayer,
} from "@/features/playlists/youtubeIframeApi";
import { formatDuration } from "@/lib/utils";
import { api, ApiError } from "@/services/api";

export function PublicSharedPlaylistPage() {
  const { shareToken = "" } = useParams();

  const [playlist, setPlaylist] = useState<PublicSharedPlaylist | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [selectedSpeed, setSelectedSpeed] = useState<PlaybackSpeed>(1.0);
  const [appliedSpeed, setAppliedSpeed] = useState<number>(1.0);
  const [speedNotice, setSpeedNotice] = useState<string | null>(null);

  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [loopError, setLoopError] = useState<string | null>(null);

  const ytMountRef = useRef<HTMLDivElement>(null);
  const ytPlayerRef = useRef<YTPlayer | null>(null);
  const activeTrackRef = useRef<PublicSharedTrack | null>(null);
  const loopARef = useRef<number | null>(null);
  const loopBRef = useRef<number | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const lastLoopSeekMsRef = useRef(0);

  isPlayingRef.current = isPlaying;
  loopARef.current = loopA;
  loopBRef.current = loopB;

  const activeTrack =
    playlist && activeIndex !== null ? playlist.tracks[activeIndex] ?? null : null;
  activeTrackRef.current = activeTrack;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setPlaylist(null);
    setActiveIndex(null);

    api
      .getPublicSharedPlaylist(shareToken)
      .then((data) => {
        if (cancelled) return;
        setPlaylist(data);
        const firstPlayableIdx = data.tracks.findIndex((t) => t.playablePublicly);
        if (firstPlayableIdx >= 0) {
          setActiveIndex(firstPlayableIdx);
          const t = data.tracks[firstPlayableIdx];
          setLoopA(t.loop.aSec);
          setLoopB(t.loop.bSec);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError
            ? err.message
            : "This shared playlist link is invalid or sharing has been disabled.",
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [shareToken]);

  useEffect(() => {
    return () => {
      try {
        ytPlayerRef.current?.destroy?.();
      } catch {
        // ignore
      }
      ytPlayerRef.current = null;
    };
  }, []);

  const applySpeedToYouTube = useCallback((rate: PlaybackSpeed) => {
    setSpeedNotice(null);
    const player = ytPlayerRef.current;
    if (!player) {
      setAppliedSpeed(rate);
      return;
    }
    try {
      const supported = player.getAvailablePlaybackRates?.();
      if (Array.isArray(supported) && supported.length > 0 && !supported.includes(rate)) {
        const closest = supported.reduce((best, cand) =>
          Math.abs(cand - rate) < Math.abs(best - rate) ? cand : best,
        );
        player.setPlaybackRate?.(closest);
        setAppliedSpeed(closest);
        setSpeedNotice(`YouTube adjusted ${rate}x to closest supported speed (${closest}x).`);
        return;
      }
      player.setPlaybackRate?.(rate);
      setAppliedSpeed(rate);
    } catch {
      setAppliedSpeed(1.0);
    }
  }, []);

  const playIndex = useCallback(
    async (idx: number) => {
      if (!playlist) return;
      const track = playlist.tracks[idx];
      if (!track) return;

      setActiveIndex(idx);
      setPlayerError(null);
      setLoopError(null);
      setLoopA(track.loop.aSec);
      setLoopB(track.loop.bSec);
      setCurrentTimeSec(track.loop.aSec ?? 0);

      if (!track.playablePublicly || !track.youtubeVideoId) {
        setIsPlaying(false);
        setPlayerError(
          track.unavailableReason ||
            "This private track is not available on public shared links.",
        );
        return;
      }

      try {
        const YT = await loadYouTubeIframeApi();
        const vid = track.youtubeVideoId;
        const startAt = track.loop.aSec ?? 0;

        if (ytPlayerRef.current) {
          ytPlayerRef.current.loadVideoById?.(vid, startAt);
          ytPlayerRef.current.playVideo?.();
          applySpeedToYouTube(selectedSpeed);
          setIsPlaying(true);
          return;
        }

        if (!ytMountRef.current) return;
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const player = new YT.Player(ytMountRef.current!, {
            width: "100%",
            height: "100%",
            videoId: vid,
            playerVars: {
              rel: 0,
              modestbranding: 1,
              playsinline: 1,
              enablejsapi: 1,
            },
            events: {
              onReady: (ev) => {
                ytPlayerRef.current = ev.target;
                if (startAt > 0) ev.target.seekTo?.(startAt, true);
                applySpeedToYouTube(selectedSpeed);
                ev.target.playVideo?.();
                setIsPlaying(true);
                if (!settled) {
                  settled = true;
                  resolve();
                }
              },
              onStateChange: (ev) => {
                if (ev.data === YT_STATE.PLAYING) {
                  setIsPlaying(true);
                  const d = ev.target.getDuration?.() ?? 0;
                  if (d > 0) setDurationSec(d);
                } else if (ev.data === YT_STATE.PAUSED || ev.data === YT_STATE.ENDED) {
                  setIsPlaying(false);
                }
              },
              onError: (ev) => {
                const msg = describeYouTubePlayerError(ev.data);
                setPlayerError(msg);
                setIsPlaying(false);
                ytPlayerRef.current = player;
                if (!settled) {
                  settled = true;
                  reject(new Error(msg));
                }
              },
            },
          });
          ytPlayerRef.current = player;
        });
      } catch (err) {
        setIsPlaying(false);
        setPlayerError(
          err instanceof Error ? err.message : "Could not load embedded YouTube player.",
        );
      }
    },
    [playlist, selectedSpeed, applySpeedToYouTube],
  );

  // Poll playback position & enforce session A-B loop cleanly
  useEffect(() => {
    if (!isPlaying) return;
    const id = window.setInterval(() => {
      const player = ytPlayerRef.current;
      if (!player) return;
      const t = player.getCurrentTime?.();
      if (typeof t === "number" && Number.isFinite(t)) {
        setCurrentTimeSec(t);
        const a = loopARef.current;
        const b = loopBRef.current;
        if (a !== null && b !== null && b > a && t >= b) {
          const now = Date.now();
          if (now - lastLoopSeekMsRef.current >= 250) {
            lastLoopSeekMsRef.current = now;
            player.seekTo?.(a, true);
            setCurrentTimeSec(a);
          }
        }
      }
      const d = player.getDuration?.();
      if (typeof d === "number" && Number.isFinite(d) && d > 0) {
        setDurationSec(d);
      }
    }, 150);
    return () => window.clearInterval(id);
  }, [isPlaying]);

  const playableIndices =
    playlist?.tracks
      .map((t, i) => (t.playablePublicly ? i : -1))
      .filter((i) => i >= 0) ?? [];

  const stepPlayable = (dir: 1 | -1) => {
    if (playableIndices.length === 0) return;
    const currPos = activeIndex !== null ? playableIndices.indexOf(activeIndex) : -1;
    const nextPos =
      currPos === -1
        ? 0
        : (currPos + dir + playableIndices.length) % playableIndices.length;
    void playIndex(playableIndices[nextPos]);
  };

  return (
    <div
      data-testid="public-shared-playlist-page"
      className="min-h-screen w-full bg-[#09090F] text-[#F5F3FF] flex flex-col"
    >
      {/* Clean Read-Only Public Header */}
      <header className="border-b border-[#27273A] bg-[#09090F]/95 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-3 min-w-0">
            <Link to="/" aria-label="ScribaSheet Home" className="shrink-0">
              <BrandMark size="sm" />
            </Link>
            <span
              data-testid="shared-readonly-badge"
              className="inline-flex items-center gap-1 rounded-full border border-violet-400/40 bg-violet-500/15 px-2.5 py-0.5 text-[11px] font-medium text-violet-200"
            >
              Read-Only Shared Playlist
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link
              to="/"
              className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-800 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF] dark:hover:bg-white/10"
            >
              About ScribaSheet
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        {loading ? (
          <div className="flex h-64 items-center justify-center gap-2 text-sm text-[#A1A1AA]">
            <Loader2 className="h-5 w-5 animate-spin text-[#A78BFA]" />
            Loading shared playlist...
          </div>
        ) : loadError || !playlist ? (
          <Card className="mx-auto max-w-lg mt-10">
            <CardContent className="p-8 text-center space-y-3" data-testid="shared-playlist-error">
              <AlertCircle className="mx-auto h-9 w-9 text-red-400" />
              <h1 className="text-lg font-semibold">Shared Playlist Unavailable</h1>
              <p className="text-xs text-stone-600 dark:text-[#A1A1AA]">
                {loadError || "This shared playlist link is invalid or sharing has been disabled."}
              </p>
              <Link
                to="/"
                className="inline-flex rounded-lg bg-[#8B5CF6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#7C3AED]"
              >
                Return to ScribaSheet
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* Playlist Summary */}
            <div className="rounded-2xl border border-stone-300 bg-white p-5 space-y-2 dark:border-[#27273A] dark:bg-[#11111B]">
              <div className="flex flex-wrap items-center gap-2">
                <ListMusic className="h-5 w-5 text-[#A78BFA]" />
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight" data-testid="shared-playlist-title">
                  {playlist.title}
                </h1>
                <span
                  data-testid="shared-playlist-category"
                  className="rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-medium text-violet-900 dark:bg-violet-500/20 dark:text-violet-300"
                >
                  {playlist.categoryName}
                </span>
                <span className="rounded-full bg-stone-200/80 px-2.5 py-0.5 text-xs font-medium text-stone-700 dark:bg-white/10 dark:text-slate-200">
                  {playlist.tracks.length} {playlist.tracks.length === 1 ? "track" : "tracks"}
                </span>
              </div>
              {playlist.description && (
                <p
                  data-testid="shared-playlist-description"
                  className="text-sm text-stone-700 dark:text-[#A1A1AA]"
                >
                  {playlist.description}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
              {/* Ordered Read-Only Track List */}
              <div className="lg:col-span-7 space-y-3" data-testid="shared-track-list">
                {playlist.tracks.length === 0 ? (
                  <Card>
                    <CardContent className="p-8 text-center text-xs text-stone-600 dark:text-[#A1A1AA]">
                      This shared playlist currently contains no tracks.
                    </CardContent>
                  </Card>
                ) : (
                  playlist.tracks.map((track, idx) => {
                    const isActive = idx === activeIndex;
                    const hasLoop =
                      track.loop.aSec !== null &&
                      track.loop.bSec !== null &&
                      track.loop.bSec > track.loop.aSec;

                    return (
                      <div
                        key={`${track.position}-${track.title}`}
                        data-testid={`shared-track-card-${idx}`}
                        className={`rounded-xl border p-3.5 space-y-2 transition-colors ${
                          isActive
                            ? "border-violet-500 bg-violet-50/70 dark:border-[#A78BFA]/70 dark:bg-violet-500/10"
                            : "border-stone-300 bg-white dark:border-[#27273A] dark:bg-[#11111B]"
                        }`}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                          <div className="h-14 w-24 shrink-0 overflow-hidden rounded-lg border border-stone-200 bg-stone-100 flex items-center justify-center dark:border-[#27273A] dark:bg-[#09090F]">
                            {track.thumbnailUrl ? (
                              <img
                                src={track.thumbnailUrl}
                                alt={track.title}
                                className="h-full w-full object-cover"
                              />
                            ) : track.sourceType === "youtube" ? (
                              <Youtube className="h-6 w-6 text-red-500" />
                            ) : (
                              <Lock className="h-5 w-5 text-stone-500 dark:text-[#A1A1AA]" />
                            )}
                          </div>

                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-[11px] text-stone-500 dark:text-[#71717A]">
                                #{track.position}
                              </span>
                              <span className="text-sm font-semibold break-words">
                                {track.title}
                              </span>
                              {hasLoop && (
                                <span
                                  data-testid={`shared-track-loop-${idx}`}
                                  className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-300"
                                >
                                  <Repeat className="h-2.5 w-2.5" />
                                  Section {formatDuration(track.loop.aSec!)}–{formatDuration(track.loop.bSec!)}
                                </span>
                              )}
                            </div>

                            {track.artist && (
                              <div className="text-xs text-stone-600 dark:text-[#A1A1AA]">
                                {track.artist}
                              </div>
                            )}

                            {track.practiceNotes && (
                              <p className="rounded-md border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-xs text-stone-800 dark:border-[#27273A] dark:bg-[#09090F] dark:text-slate-200">
                                {track.practiceNotes}
                              </p>
                            )}

                            {!track.playablePublicly && track.unavailableReason && (
                              <p
                                data-testid={`shared-track-private-notice-${idx}`}
                                className="text-[11px] text-amber-900 dark:text-amber-300"
                              >
                                {track.unavailableReason}
                              </p>
                            )}
                          </div>

                          {track.playablePublicly && (
                            <Button
                              type="button"
                              size="sm"
                              data-testid={`shared-play-btn-${idx}`}
                              onClick={() => void playIndex(idx)}
                            >
                              <Play className="h-3.5 w-3.5" />
                              {isActive && isPlaying ? "Playing" : "Play"}
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Integrated Public Read-Only Player */}
              <div className="lg:col-span-5" data-testid="shared-player-pane">
                <Card>
                  <CardContent className="p-4 space-y-4">
                    <h2 className="text-sm font-semibold">Practice Player</h2>

                    <div className="aspect-video w-full overflow-hidden rounded-xl border border-stone-300 bg-black dark:border-[#27273A]">
                      <div ref={ytMountRef} data-testid="shared-youtube-host" className="h-full w-full" />
                    </div>

                    {activeTrack ? (
                      <div className="space-y-0.5">
                        <div className="text-sm font-semibold">{activeTrack.title}</div>
                        <div className="text-xs text-stone-600 dark:text-[#A1A1AA]">
                          {activeTrack.artist}
                        </div>
                        {activeTrack.youtubeUrl && (
                          <a
                            href={activeTrack.youtubeUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-violet-700 hover:underline dark:text-[#A78BFA]"
                          >
                            Open on YouTube <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-stone-600 dark:text-[#A1A1AA]">
                        No publicly embeddable YouTube tracks are available in this playlist.
                      </p>
                    )}

                    {playerError && (
                      <div
                        role="alert"
                        data-testid="shared-player-error"
                        className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200"
                      >
                        {playerError}
                      </div>
                    )}

                    <div className="space-y-1">
                      <input
                        type="range"
                        min={0}
                        max={durationSec > 0 ? durationSec : Math.max(currentTimeSec, 1)}
                        step={0.5}
                        value={currentTimeSec}
                        disabled={!activeTrack?.playablePublicly}
                        onChange={(e) => {
                          const nextSec = Number.parseFloat(e.target.value);
                          setCurrentTimeSec(nextSec);
                          ytPlayerRef.current?.seekTo?.(nextSec, true);
                        }}
                        aria-label="Seek shared track position"
                        className="w-full accent-[#8B5CF6]"
                      />
                      <div className="flex justify-between text-[11px] font-mono text-stone-600 dark:text-[#A1A1AA]">
                        <span>{formatDuration(currentTimeSec)}</span>
                        <span>{durationSec > 0 ? formatDuration(durationSec) : "--:--"}</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={playableIndices.length === 0}
                        onClick={() => stepPlayable(-1)}
                        aria-label="Previous track"
                      >
                        <SkipBack className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={!activeTrack?.playablePublicly}
                        onClick={() => {
                          if (!ytPlayerRef.current && activeIndex !== null) {
                            void playIndex(activeIndex);
                            return;
                          }
                          if (isPlaying) {
                            ytPlayerRef.current?.pauseVideo?.();
                            setIsPlaying(false);
                          } else {
                            ytPlayerRef.current?.playVideo?.();
                            setIsPlaying(true);
                          }
                        }}
                        data-testid="shared-toggle-play-btn"
                      >
                        {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        {isPlaying ? "Pause" : "Play"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!activeTrack?.playablePublicly}
                        onClick={() => {
                          ytPlayerRef.current?.pauseVideo?.();
                          ytPlayerRef.current?.seekTo?.(0, true);
                          setIsPlaying(false);
                          setCurrentTimeSec(0);
                        }}
                        aria-label="Stop"
                      >
                        <Square className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={playableIndices.length === 0}
                        onClick={() => stepPlayable(1)}
                        aria-label="Next track"
                      >
                        <SkipForward className="h-3.5 w-3.5" />
                      </Button>
                    </div>

                    {/* Speed Selector */}
                    <div className="space-y-1.5 border-t border-stone-200 pt-3 dark:border-[#27273A]">
                      <div className="flex items-center justify-between text-xs">
                        <span>Practice Speed</span>
                        <span className="font-mono text-[11px] text-[#A78BFA]">
                          Active: {appliedSpeed}x
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {PLAYBACK_SPEEDS.map((rate) => (
                          <button
                            key={rate}
                            type="button"
                            onClick={() => {
                              setSelectedSpeed(rate);
                              applySpeedToYouTube(rate);
                            }}
                            className={`rounded-lg border px-2 py-1 text-xs font-mono ${
                              selectedSpeed === rate
                                ? "border-violet-500 bg-violet-600 text-white font-semibold"
                                : "border-stone-300 bg-white text-stone-800 dark:border-[#27273A] dark:bg-[#09090F] dark:text-slate-200"
                            }`}
                          >
                            {rate}x
                          </button>
                        ))}
                      </div>
                      {speedNotice && (
                        <p className="text-[11px] text-amber-800 dark:text-amber-300">
                          {speedNotice}
                        </p>
                      )}
                    </div>

                    {/* Session-Only A-B Section Loop */}
                    <div className="space-y-2 border-t border-stone-200 pt-3 dark:border-[#27273A]">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium">Practice A–B Loop</span>
                        {loopA !== null && loopB !== null && loopB > loopA ? (
                          <span className="rounded bg-emerald-100 px-2 py-0.5 font-mono text-[11px] text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-300">
                            {formatDuration(loopA)} – {formatDuration(loopB)}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!activeTrack?.playablePublicly}
                          onClick={() => {
                            const t = ytPlayerRef.current?.getCurrentTime?.() ?? currentTimeSec;
                            setLoopError(null);
                            setLoopA(t);
                            if (loopB !== null && loopB <= t) setLoopB(null);
                          }}
                        >
                          Set A
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!activeTrack?.playablePublicly}
                          onClick={() => {
                            const t = ytPlayerRef.current?.getCurrentTime?.() ?? currentTimeSec;
                            if (loopA === null) {
                              setLoopError("Set A first.");
                              return;
                            }
                            if (t <= loopA) {
                              setLoopError("B must be after A.");
                              return;
                            }
                            setLoopError(null);
                            setLoopB(t);
                          }}
                        >
                          Set B
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={loopA === null && loopB === null}
                          onClick={() => {
                            setLoopError(null);
                            setLoopA(null);
                            setLoopB(null);
                          }}
                        >
                          Clear Loop
                        </Button>
                      </div>
                      {loopError && (
                        <p className="text-[11px] text-red-600 dark:text-red-300">{loopError}</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
