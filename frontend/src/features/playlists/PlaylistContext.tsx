import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthContext";
import {
  applyImportedLibrary,
  createDefaultLibrary,
  createPlaylistId,
  loadPlaylistLibrary,
  migrateAndSanitizeLibrary,
  savePlaylistLibrary,
} from "@/features/playlists/playlistStorage";
import {
  PLAYLISTS_SCHEMA_VERSION,
  type PlaybackSpeed,
  type Playlist,
  type PlaylistCategory,
  type PlaylistLibraryState,
  type PlaylistTrack,
} from "@/features/playlists/playlistTypes";
import {
  describeYouTubePlayerError,
  loadYouTubeIframeApi,
  YT_STATE,
  type YTPlayer,
} from "@/features/playlists/youtubeIframeApi";
import { API_BASE_URL, api } from "@/services/api";

export interface TrackDraftInput {
  sourceType: "youtube" | "project_audio";
  title: string;
  artist: string;
  categoryId: string;
  thumbnailUrl?: string | null;
  practiceNotes?: string;
  youtubeVideoId?: string | null;
  youtubeUrl?: string | null;
  projectId?: string | null;
  mediaAssetId?: string | null;
  projectTitle?: string | null;
  mediaFilename?: string | null;
  mediaMimeType?: string | null;
  durationSec?: number | null;
}

export type SyncStatus = "local" | "syncing" | "synced" | "offline";

export interface PlaylistContextValue {
  library: PlaylistLibraryState;
  selectedPlaylistId: string | null;
  selectedPlaylist: Playlist | null;
  setSelectedPlaylistId: (id: string | null) => void;
  storageNotice: string | null;
  dismissStorageNotice: () => void;
  syncStatus: SyncStatus;

  // Category CRUD
  addCategory: (name: string) => PlaylistCategory | null;
  deleteCategory: (categoryId: string) => void;

  // Playlist CRUD
  createPlaylist: (title: string, categoryId?: string, description?: string) => Playlist | null;
  renamePlaylist: (playlistId: string, title: string) => void;
  updatePlaylistDescription: (playlistId: string, description: string) => void;
  setPlaylistCategory: (playlistId: string, categoryId: string) => void;
  duplicatePlaylist: (playlistId: string) => Playlist | null;
  deletePlaylist: (playlistId: string) => void;
  enablePlaylistSharing: (playlistId: string) => Promise<void>;
  regeneratePlaylistSharing: (playlistId: string) => Promise<void>;
  disablePlaylistSharing: (playlistId: string) => Promise<void>;

  // Track CRUD
  addTrackToPlaylist: (
    playlistId: string,
    draft: TrackDraftInput,
    options?: { allowDuplicate?: boolean },
  ) => { ok: boolean; track?: PlaylistTrack; duplicate?: boolean; error?: string };
  updateTrack: (
    playlistId: string,
    trackId: string,
    patch: Partial<Pick<PlaylistTrack, "title" | "artist" | "categoryId" | "practiceNotes" | "loop">>,
  ) => void;
  reorderTrack: (playlistId: string, fromIndex: number, toIndex: number) => void;
  removeTrack: (playlistId: string, trackId: string) => void;

  // Backup / Restore
  importLibrary: (incoming: PlaylistLibraryState, mode: "merge" | "replace") => void;

  // Player state & actions
  activePlaylistId: string | null;
  activeTrackId: string | null;
  activeTrack: PlaylistTrack | null;
  activePlaylist: Playlist | null;
  isPlaying: boolean;
  isLoadingMedia: boolean;
  playerError: string | null;
  currentTimeSec: number;
  durationSec: number;
  appliedPlaybackRate: number;
  speedNotice: string | null;
  loopError: string | null;
  youtubeReady: boolean;

  playTrack: (playlistId: string, trackId: string) => Promise<void>;
  togglePlay: () => Promise<void>;
  pause: () => void;
  stop: () => void;
  seekTo: (sec: number) => void;
  nextTrack: () => Promise<void>;
  previousTrack: () => Promise<void>;
  setPlaybackRate: (rate: PlaybackSpeed) => void;
  setShuffle: (enabled: boolean) => void;
  setAutoAdvance: (enabled: boolean) => void;
  setMiniPlayerEnabled: (enabled: boolean) => void;
  setLoopA: () => void;
  setLoopB: () => void;
  clearLoop: () => void;
  registerYouTubeViewport: (el: HTMLDivElement | null) => void;
}

const PlaylistContext = createContext<PlaylistContextValue | null>(null);

function resolveSignedUrl(rawUrl: string): string {
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  const origin = API_BASE_URL.replace(/\/api\/v1\/?$/, "");
  return `${origin}${rawUrl}`;
}

function getTrackSignature(draft: Pick<TrackDraftInput, "sourceType" | "youtubeVideoId" | "projectId" | "mediaAssetId">): string {
  if (draft.sourceType === "youtube") {
    return `yt:${(draft.youtubeVideoId || "").trim()}`;
  }
  return `proj:${(draft.projectId || "").trim()}:${(draft.mediaAssetId || "").trim()}`;
}

export function PlaylistProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();

  const initialLoad = useMemo(() => loadPlaylistLibrary(), []);
  const [library, setLibrary] = useState<PlaylistLibraryState>(initialLoad.library);
  const [storageNotice, setStorageNotice] = useState<string | null>(() => {
    if (initialLoad.recoveredFromError) return initialLoad.recoveredFromError;
    if (!initialLoad.storageAvailable) {
      return "LocalStorage is unavailable; playlist edits will last only for this session.";
    }
    return null;
  });
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("local");
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(
    () => initialLoad.library.playlists[0]?.id ?? null,
  );

  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(null);
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [appliedPlaybackRate, setAppliedPlaybackRate] = useState<number>(
    initialLoad.library.preferences.playbackRate,
  );
  const [speedNotice, setSpeedNotice] = useState<string | null>(null);
  const [loopError, setLoopError] = useState<string | null>(null);
  const [youtubeReady, setYoutubeReady] = useState(false);

  const libraryRef = useRef(library);
  libraryRef.current = library;
  const activePlaylistIdRef = useRef(activePlaylistId);
  activePlaylistIdRef.current = activePlaylistId;
  const activeTrackIdRef = useRef(activeTrackId);
  activeTrackIdRef.current = activeTrackId;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const currentTimeRef = useRef(currentTimeSec);
  currentTimeRef.current = currentTimeSec;
  const loadRequestIdRef = useRef(0);
  const lastLoopSeekMsRef = useRef(0);

  // Shared single HTML5 Audio instance
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Single YouTube player instance & dynamic overlay container
  const ytHostRef = useRef<HTMLDivElement | null>(null);
  const ytMountTargetRef = useRef<HTMLDivElement | null>(null);
  const ytViewportRef = useRef<HTMLDivElement | null>(null);
  const ytPlayerRef = useRef<YTPlayer | null>(null);
  const ytInitPromiseRef = useRef<Promise<YTPlayer> | null>(null);
  const ytCurrentVideoIdRef = useRef<string | null>(null);

  const syncTimerRef = useRef<number | null>(null);
  const hasHydratedRemoteRef = useRef<string | null>(null);

  const activePlaylist = useMemo(
    () => library.playlists.find((p) => p.id === activePlaylistId) ?? null,
    [library.playlists, activePlaylistId],
  );
  const activeTrack = useMemo(
    () => activePlaylist?.tracks.find((t) => t.id === activeTrackId) ?? null,
    [activePlaylist, activeTrackId],
  );
  const activeTrackRef = useRef(activeTrack);
  activeTrackRef.current = activeTrack;

  const selectedPlaylist = useMemo(
    () =>
      library.playlists.find((p) => p.id === selectedPlaylistId) ??
      library.playlists[0] ??
      null,
    [library.playlists, selectedPlaylistId],
  );

  // Keep selectedPlaylistId valid if playlists change
  useEffect(() => {
    if (library.playlists.length === 0) {
      if (selectedPlaylistId !== null) setSelectedPlaylistId(null);
    } else if (!selectedPlaylistId || !library.playlists.some((p) => p.id === selectedPlaylistId)) {
      setSelectedPlaylistId(library.playlists[0].id);
    }
  }, [library.playlists, selectedPlaylistId]);

  const scheduleRemoteSync = useCallback(
    (nextLib: PlaylistLibraryState) => {
      if (!user) return;
      if (syncTimerRef.current) {
        window.clearTimeout(syncTimerRef.current);
      }
      setSyncStatus("syncing");
      syncTimerRef.current = window.setTimeout(() => {
        void api
          .syncPlaylistLibrary({
            schemaVersion: nextLib.schemaVersion,
            categories: nextLib.categories,
            playlists: nextLib.playlists,
            preferences: nextLib.preferences as unknown as Record<string, unknown>,
          })
          .then((remote) => {
            setSyncStatus("synced");
            const remoteByClientId = new Map(
              (remote.playlists || []).map((rp) => [String(rp.id || ""), rp]),
            );
            setLibrary((curr) => {
              let changed = false;
              const nextPlaylists = curr.playlists.map((pl) => {
                const matched = remoteByClientId.get(pl.id);
                if (!matched) return pl;
                const nextServerId =
                  typeof matched.serverId === "string" ? matched.serverId : pl.serverId ?? null;
                const nextIsShared = Boolean(matched.isShared && matched.shareToken);
                const nextToken =
                  nextIsShared && typeof matched.shareToken === "string"
                    ? matched.shareToken
                    : null;
                const nextSharedAt =
                  nextIsShared && typeof matched.sharedAt === "string" ? matched.sharedAt : null;
                if (
                  pl.serverId !== nextServerId ||
                  Boolean(pl.isShared) !== nextIsShared ||
                  (pl.shareToken ?? null) !== nextToken
                ) {
                  changed = true;
                  return {
                    ...pl,
                    serverId: nextServerId,
                    isShared: nextIsShared,
                    shareToken: nextToken,
                    sharedAt: nextSharedAt,
                  };
                }
                return pl;
              });
              if (!changed) return curr;
              const updated = { ...curr, playlists: nextPlaylists };
              savePlaylistLibrary(updated);
              return updated;
            });
          })
          .catch(() => {
            setSyncStatus("local");
          });
      }, 450);
    },
    [user],
  );

  const commitLibrary = useCallback(
    (
      updater: (prev: PlaylistLibraryState) => PlaylistLibraryState,
      options: { skipRemote?: boolean } = {},
    ) => {
      setLibrary((prev) => {
        const nextRaw = updater(prev);
        const next: PlaylistLibraryState = {
          ...nextRaw,
          schemaVersion: PLAYLISTS_SCHEMA_VERSION,
          updatedAt: new Date().toISOString(),
        };
        const saveRes = savePlaylistLibrary(next);
        if (!saveRes.ok && saveRes.error) {
          setStorageNotice(saveRes.error);
        }
        if (!options.skipRemote) {
          scheduleRemoteSync(next);
        }
        return next;
      });
    },
    [scheduleRemoteSync],
  );

  // Optional Neon PostgreSQL hydration on login (localStorage remains authoritative fallback)
  useEffect(() => {
    if (!user) {
      hasHydratedRemoteRef.current = null;
      setSyncStatus("local");
      return;
    }
    if (hasHydratedRemoteRef.current === user.id) return;
    hasHydratedRemoteRef.current = user.id;

    let cancelled = false;
    void api
      .getPlaylistLibrary()
      .then((remote) => {
        if (cancelled) return;
        const remotePlaylists = Array.isArray(remote.playlists) ? remote.playlists : [];
        const localLib = libraryRef.current;

        if (remotePlaylists.length > 0 && localLib.playlists.length === 0) {
          const hydrated = migrateAndSanitizeLibrary({
            ...remote,
            preferences: { ...localLib.preferences, ...remote.preferences },
          });
          setLibrary(hydrated);
          savePlaylistLibrary(hydrated);
          setSyncStatus("synced");
        } else if (localLib.playlists.length > 0 && remotePlaylists.length === 0) {
          scheduleRemoteSync(localLib);
        } else {
          // Reconcile serverId & server sharing metadata into matching local playlists
          const remoteByClient = new Map(
            remotePlaylists.map((rp) => [String(rp.id || ""), rp]),
          );
          const mergedPlaylists = localLib.playlists.map((pl) => {
            const matched = remoteByClient.get(pl.id);
            if (!matched) return pl;
            const isShared = Boolean(matched.isShared && matched.shareToken);
            return {
              ...pl,
              serverId: typeof matched.serverId === "string" ? matched.serverId : pl.serverId ?? null,
              isShared,
              shareToken: isShared && typeof matched.shareToken === "string" ? matched.shareToken : null,
              sharedAt: isShared && typeof matched.sharedAt === "string" ? matched.sharedAt : null,
            };
          });
          const updated = { ...localLib, playlists: mergedPlaylists };
          setLibrary(updated);
          savePlaylistLibrary(updated);
          setSyncStatus("synced");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSyncStatus("local");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [user, scheduleRemoteSync]);

  // Apply requested speed to the currently active media backend cleanly
  const applyRateToActiveBackend = useCallback(
    (rate: PlaybackSpeed, sourceType: PlaylistTrack["sourceType"] | null) => {
      setSpeedNotice(null);
      if (sourceType === "project_audio") {
        if (audioRef.current) {
          audioRef.current.playbackRate = rate;
          (audioRef.current as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
        }
        setAppliedPlaybackRate(rate);
        return;
      }

      if (sourceType === "youtube" && ytPlayerRef.current) {
        const player = ytPlayerRef.current;
        try {
          const supported = player.getAvailablePlaybackRates?.();
          if (Array.isArray(supported) && supported.length > 0 && !supported.includes(rate)) {
            const closest = supported.reduce((best, cand) =>
              Math.abs(cand - rate) < Math.abs(best - rate) ? cand : best,
            );
            player.setPlaybackRate?.(closest);
            setAppliedPlaybackRate(closest);
            setSpeedNotice(
              `YouTube IFrame player does not support ${rate}x for this video; adjusted to closest supported speed (${closest}x).`,
            );
            return;
          }
          player.setPlaybackRate?.(rate);
          setAppliedPlaybackRate(rate);
        } catch {
          setAppliedPlaybackRate(1.0);
          setSpeedNotice("Playback speed control is temporarily unavailable for this video.");
        }
        return;
      }

      setAppliedPlaybackRate(rate);
    },
    [],
  );

  // Align single persistent YouTube IFrame container over registered ListeningPlayerPane viewport
  const syncYouTubeHostGeometry = useCallback(() => {
    const hostEl = ytHostRef.current;
    if (!hostEl) return;

    const onPlaylistsRoute = location.pathname === "/playlists";
    const isYtActive = activeTrackRef.current?.sourceType === "youtube";
    const viewportEl = ytViewportRef.current;

    if (onPlaylistsRoute && isYtActive && viewportEl) {
      const rect = viewportEl.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        hostEl.style.position = "fixed";
        hostEl.style.left = `${rect.left}px`;
        hostEl.style.top = `${rect.top}px`;
        hostEl.style.width = `${rect.width}px`;
        hostEl.style.height = `${rect.height}px`;
        hostEl.style.opacity = "1";
        hostEl.style.pointerEvents = "auto";
        hostEl.style.zIndex = "20";
        return;
      }
      // Fallback for headless/jsdom environments where getBoundingClientRect() returns zeros
      hostEl.style.position = "fixed";
      hostEl.style.left = "0px";
      hostEl.style.top = "0px";
      hostEl.style.width = "320px";
      hostEl.style.height = "180px";
      hostEl.style.opacity = "1";
      hostEl.style.pointerEvents = "auto";
      hostEl.style.zIndex = "20";
      return;
    }

    // Keep single YT.Player mounted off-screen when navigating with mini-player active so it keeps playing without reload
    hostEl.style.position = "fixed";
    hostEl.style.left = "-9999px";
    hostEl.style.top = "-9999px";
    hostEl.style.width = "1px";
    hostEl.style.height = "1px";
    hostEl.style.opacity = "0";
    hostEl.style.pointerEvents = "none";
    hostEl.style.zIndex = "-1";
  }, [location.pathname]);

  useEffect(() => {
    syncYouTubeHostGeometry();
    if (typeof window === "undefined") return;
    const onResizeOrScroll = () => syncYouTubeHostGeometry();
    window.addEventListener("resize", onResizeOrScroll);
    window.addEventListener("scroll", onResizeOrScroll, true);

    let observer: ResizeObserver | null = null;
    if (ytViewportRef.current && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => syncYouTubeHostGeometry());
      observer.observe(ytViewportRef.current);
    }
    return () => {
      window.removeEventListener("resize", onResizeOrScroll);
      window.removeEventListener("scroll", onResizeOrScroll, true);
      observer?.disconnect();
    };
  }, [syncYouTubeHostGeometry, activeTrack]);

  const registerYouTubeViewport = useCallback(
    (el: HTMLDivElement | null) => {
      ytViewportRef.current = el;
      syncYouTubeHostGeometry();
    },
    [syncYouTubeHostGeometry],
  );

  // Stop & release active playback helper
  const stopAudioBackend = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      try {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      } catch {
        // ignore jsdom/unimplemented load
      }
    }
  }, []);

  const pauseYouTubeBackend = useCallback(() => {
    try {
      ytPlayerRef.current?.pauseVideo?.();
    } catch {
      // ignore
    }
  }, []);

  const stop = useCallback(() => {
    loadRequestIdRef.current += 1;
    stopAudioBackend();
    pauseYouTubeBackend();
    setIsPlaying(false);
    setIsLoadingMedia(false);
    setCurrentTimeSec(0);
  }, [stopAudioBackend, pauseYouTubeBackend]);

  // Pause playback when leaving /playlists if mini-player is disabled
  useEffect(() => {
    if (location.pathname !== "/playlists" && !library.preferences.miniPlayerEnabled && isPlayingRef.current) {
      stopAudioBackend();
      pauseYouTubeBackend();
      setIsPlaying(false);
    }
  }, [location.pathname, library.preferences.miniPlayerEnabled, stopAudioBackend, pauseYouTubeBackend]);

  // Clean up all media resources on logout or provider unmount
  useEffect(() => {
    if (!user) {
      stop();
      setActiveTrackId(null);
      setActivePlaylistId(null);
      setPlayerError(null);
    }
  }, [user, stop]);

  useEffect(() => {
    return () => {
      if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
      stopAudioBackend();
      try {
        ytPlayerRef.current?.destroy?.();
      } catch {
        // ignore
      }
      ytPlayerRef.current = null;
      ytInitPromiseRef.current = null;
    };
  }, [stopAudioBackend]);

  const pickNextTrack = useCallback(
    (direction: 1 | -1): { playlistId: string; trackId: string } | null => {
      const pid = activePlaylistIdRef.current ?? selectedPlaylist?.id ?? null;
      if (!pid) return null;
      const pl = libraryRef.current.playlists.find((p) => p.id === pid);
      if (!pl || pl.tracks.length === 0) return null;

      const currentIdx = activeTrackIdRef.current
        ? pl.tracks.findIndex((t) => t.id === activeTrackIdRef.current)
        : -1;

      if (libraryRef.current.preferences.shuffle && pl.tracks.length > 1) {
        const candidates = pl.tracks.filter((_, idx) => idx !== currentIdx);
        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        return chosen ? { playlistId: pl.id, trackId: chosen.id } : null;
      }

      if (currentIdx === -1) {
        return { playlistId: pl.id, trackId: pl.tracks[0].id };
      }
      const nextIdx = (currentIdx + direction + pl.tracks.length) % pl.tracks.length;
      return { playlistId: pl.id, trackId: pl.tracks[nextIdx].id };
    },
    [selectedPlaylist?.id],
  );

  const playTrackRef = useRef<(playlistId: string, trackId: string) => Promise<void>>(async () => {});

  const handleTrackEnded = useCallback(() => {
    setIsPlaying(false);
    const track = activeTrackRef.current;
    if (track?.loop.aSec !== null && track?.loop.bSec !== null && track && track.loop.bSec > track.loop.aSec) {
      // Edge case: if B is near track end and natural ended fires first, seek cleanly back to A
      if (track.sourceType === "project_audio" && audioRef.current) {
        audioRef.current.currentTime = track.loop.aSec;
        void audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
        return;
      }
      if (track.sourceType === "youtube" && ytPlayerRef.current) {
        ytPlayerRef.current.seekTo?.(track.loop.aSec, true);
        ytPlayerRef.current.playVideo?.();
        return;
      }
    }

    if (libraryRef.current.preferences.autoAdvance) {
      const next = pickNextTrack(1);
      if (next && (next.trackId !== activeTrackIdRef.current || (activePlaylist?.tracks.length ?? 0) > 1)) {
        void playTrackRef.current(next.playlistId, next.trackId);
      }
    }
  }, [pickNextTrack, activePlaylist?.tracks.length]);

  const ensureYouTubePlayer = useCallback(
    async (videoId: string): Promise<YTPlayer> => {
      if (ytPlayerRef.current) {
        return ytPlayerRef.current;
      }
      if (ytInitPromiseRef.current) {
        return ytInitPromiseRef.current;
      }

      ytInitPromiseRef.current = (async () => {
        const YT = await loadYouTubeIframeApi();
        const targetEl = ytMountTargetRef.current;
        if (!targetEl) {
          throw new Error("YouTube player host container is not mounted.");
        }

        return await new Promise<YTPlayer>((resolve, reject) => {
          let settled = false;
          const player = new YT.Player(targetEl, {
            width: "100%",
            height: "100%",
            videoId,
            playerVars: {
              rel: 0,
              modestbranding: 1,
              playsinline: 1,
              enablejsapi: 1,
            },
            events: {
              onReady: (ev) => {
                ytPlayerRef.current = ev.target;
                ytCurrentVideoIdRef.current = videoId;
                setYoutubeReady(true);
                applyRateToActiveBackend(libraryRef.current.preferences.playbackRate, "youtube");
                if (!settled) {
                  settled = true;
                  resolve(ev.target);
                }
              },
              onStateChange: (ev) => {
                if (ev.data === YT_STATE.PLAYING) {
                  setIsPlaying(true);
                  setIsLoadingMedia(false);
                  setPlayerError(null);
                  const dur = ev.target.getDuration?.() ?? 0;
                  if (dur > 0) setDurationSec(dur);
                } else if (ev.data === YT_STATE.PAUSED) {
                  setIsPlaying(false);
                  setIsLoadingMedia(false);
                } else if (ev.data === YT_STATE.BUFFERING) {
                  setIsLoadingMedia(true);
                } else if (ev.data === YT_STATE.ENDED) {
                  handleTrackEnded();
                }
              },
              onPlaybackRateChange: (ev) => {
                if (typeof ev.data === "number" && Number.isFinite(ev.data)) {
                  setAppliedPlaybackRate(ev.data);
                }
              },
              onError: (ev) => {
                const msg = describeYouTubePlayerError(ev.data);
                setPlayerError(msg);
                setIsPlaying(false);
                setIsLoadingMedia(false);
                if (!settled) {
                  settled = true;
                  // Keep reference if created cleanly even on video error
                  ytPlayerRef.current = player;
                  reject(new Error(msg));
                }
              },
            },
          });
          ytPlayerRef.current = player;
        });
      })().finally(() => {
        ytInitPromiseRef.current = null;
      });

      return ytInitPromiseRef.current;
    },
    [applyRateToActiveBackend, handleTrackEnded],
  );

  // Single HTML5 audio element setup & cleanup
  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    audioRef.current = audio;

    const onLoadedMetadata = () => {
      if (activeTrackRef.current?.sourceType !== "project_audio") return;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDurationSec(audio.duration);
      }
      audio.playbackRate = libraryRef.current.preferences.playbackRate;
      (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    };
    const onTimeUpdate = () => {
      if (activeTrackRef.current?.sourceType !== "project_audio") return;
      setCurrentTimeSec(audio.currentTime || 0);
    };
    const onPlay = () => {
      if (activeTrackRef.current?.sourceType !== "project_audio") return;
      setIsPlaying(true);
      setIsLoadingMedia(false);
    };
    const onPause = () => {
      if (activeTrackRef.current?.sourceType !== "project_audio") return;
      setIsPlaying(false);
    };
    const onEnded = () => {
      if (activeTrackRef.current?.sourceType !== "project_audio") return;
      handleTrackEnded();
    };
    const onError = () => {
      if (activeTrackRef.current?.sourceType !== "project_audio") return;
      setPlayerError("Unable to load project audio file. The source project or audio file may have been removed.");
      setIsPlaying(false);
      setIsLoadingMedia(false);
    };

    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      try {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      } catch {
        // ignore
      }
      audioRef.current = null;
    };
  }, [handleTrackEnded]);

  const seekTo = useCallback((sec: number) => {
    const safeSec = Math.max(0, Number.isFinite(sec) ? sec : 0);
    const track = activeTrackRef.current;
    setCurrentTimeSec(safeSec);

    if (track?.sourceType === "project_audio" && audioRef.current) {
      try {
        audioRef.current.currentTime = safeSec;
      } catch {
        // ignore seek error before metadata loads
      }
      return;
    }

    if (track?.sourceType === "youtube" && ytPlayerRef.current) {
      if (typeof ytPlayerRef.current.seekTo !== "function") {
        setPlayerError("Seeking is currently unavailable for this YouTube video.");
        return;
      }
      try {
        ytPlayerRef.current.seekTo(safeSec, true);
      } catch {
        setPlayerError("Seeking failed on the embedded YouTube player.");
      }
    }
  }, []);

  // Poll YouTube progress + enforce A–B section loop reliably across both engines
  useEffect(() => {
    if (!isPlaying && activeTrack?.sourceType !== "youtube") return;

    const timerId = window.setInterval(() => {
      const track = activeTrackRef.current;
      if (!track) return;

      let pos = currentTimeRef.current;
      if (track.sourceType === "youtube" && ytPlayerRef.current) {
        try {
          const ytTime = ytPlayerRef.current.getCurrentTime?.();
          if (typeof ytTime === "number" && Number.isFinite(ytTime)) {
            pos = ytTime;
            setCurrentTimeSec(ytTime);
          }
          const ytDur = ytPlayerRef.current.getDuration?.();
          if (typeof ytDur === "number" && Number.isFinite(ytDur) && ytDur > 0) {
            setDurationSec(ytDur);
          }
        } catch {
          // ignore transient poll error
        }
      } else if (track.sourceType === "project_audio" && audioRef.current) {
        const audioTime = audioRef.current.currentTime;
        if (Number.isFinite(audioTime)) {
          pos = audioTime;
          setCurrentTimeSec(audioTime);
        }
      }

      if (
        isPlayingRef.current &&
        track.loop.aSec !== null &&
        track.loop.bSec !== null &&
        track.loop.bSec > track.loop.aSec &&
        pos >= track.loop.bSec
      ) {
        const now = Date.now();
        if (now - lastLoopSeekMsRef.current >= 250) {
          lastLoopSeekMsRef.current = now;
          seekTo(track.loop.aSec);
        }
      }
    }, 150);

    return () => window.clearInterval(timerId);
  }, [isPlaying, activeTrack?.id, activeTrack?.sourceType, seekTo]);

  const playTrack = useCallback(
    async (playlistId: string, trackId: string) => {
      const pl = libraryRef.current.playlists.find((p) => p.id === playlistId);
      const track = pl?.tracks.find((t) => t.id === trackId);
      if (!pl || !track) return;

      const reqId = ++loadRequestIdRef.current;
      setSelectedPlaylistId(pl.id);
      setActivePlaylistId(pl.id);
      setActiveTrackId(track.id);
      setPlayerError(null);
      setLoopError(null);
      setSpeedNotice(null);
      setCurrentTimeSec(track.loop.aSec ?? 0);
      setDurationSec(track.durationSec ?? 0);
      setIsLoadingMedia(true);

      if (track.sourceType === "youtube") {
        stopAudioBackend();
        const vid = track.youtubeVideoId;
        if (!vid) {
          setIsLoadingMedia(false);
          setIsPlaying(false);
          setPlayerError("Invalid or missing YouTube video ID on this track.");
          return;
        }
        try {
          const alreadyCreated = Boolean(ytPlayerRef.current);
          const startAt = track.loop.aSec ?? 0;
          const player = await ensureYouTubePlayer(vid);
          if (reqId !== loadRequestIdRef.current) return;

          if (alreadyCreated && ytCurrentVideoIdRef.current !== vid) {
            player.loadVideoById?.(vid, startAt);
            ytCurrentVideoIdRef.current = vid;
          } else {
            if (startAt > 0) {
              player.seekTo?.(startAt, true);
            }
            player.playVideo?.();
          }
          applyRateToActiveBackend(libraryRef.current.preferences.playbackRate, "youtube");
          setIsPlaying(true);
          setIsLoadingMedia(false);
          syncYouTubeHostGeometry();
        } catch (err) {
          if (reqId !== loadRequestIdRef.current) return;
          setIsPlaying(false);
          setIsLoadingMedia(false);
          setPlayerError(
            err instanceof Error
              ? err.message
              : "Failed to initialize YouTube embedded player.",
          );
        }
        return;
      }

      // Project Audio playback via shared HTML5 Audio
      pauseYouTubeBackend();
      try {
        let assetId = track.mediaAssetId || null;
        if (!assetId && track.projectId) {
          const proj = await api.getProject(track.projectId);
          if (reqId !== loadRequestIdRef.current) return;
          const audioAsset = proj.media_assets.find(
            (a) =>
              a.mime_type.startsWith("audio/") ||
              a.mime_type.startsWith("video/") ||
              /\.(mp3|wav|flac|m4a|ogg|aac|mp4|mov|webm|mkv)$/i.test(a.original_filename),
          );
          assetId = audioAsset?.id ?? null;
        }
        if (!assetId) {
          throw new Error("No playable audio asset was found on the linked ScribaSheet project.");
        }

        const signed = await api.getSignedMediaUrl(assetId);
        if (reqId !== loadRequestIdRef.current) return;

        const audio = audioRef.current;
        if (!audio) {
          throw new Error("HTML5 audio player is unavailable.");
        }
        audio.src = resolveSignedUrl(signed.url);
        audio.currentTime = track.loop.aSec ?? 0;
        applyRateToActiveBackend(libraryRef.current.preferences.playbackRate, "project_audio");
        await audio.play();
        if (reqId !== loadRequestIdRef.current) return;
        setIsPlaying(true);
        setIsLoadingMedia(false);
      } catch (err) {
        if (reqId !== loadRequestIdRef.current) return;
        setIsPlaying(false);
        setIsLoadingMedia(false);
        setPlayerError(
          err instanceof Error
            ? err.message
            : "Could not load audio from this project. It may have been deleted.",
        );
      }
    },
    [
      stopAudioBackend,
      pauseYouTubeBackend,
      ensureYouTubePlayer,
      applyRateToActiveBackend,
      syncYouTubeHostGeometry,
    ],
  );

  playTrackRef.current = playTrack;

  const togglePlay = useCallback(async () => {
    const track = activeTrackRef.current;
    if (!track) {
      const targetPl =
        libraryRef.current.playlists.find((p) => p.id === (activePlaylistIdRef.current ?? selectedPlaylist?.id)) ??
        libraryRef.current.playlists[0];
      if (targetPl && targetPl.tracks.length > 0) {
        await playTrack(targetPl.id, targetPl.tracks[0].id);
      }
      return;
    }

    if (isPlayingRef.current) {
      if (track.sourceType === "project_audio") {
        audioRef.current?.pause();
      } else {
        pauseYouTubeBackend();
      }
      setIsPlaying(false);
      return;
    }

    if (track.sourceType === "project_audio" && audioRef.current?.src) {
      try {
        await audioRef.current.play();
        setIsPlaying(true);
        setPlayerError(null);
      } catch (err) {
        setPlayerError(err instanceof Error ? err.message : "Audio playback failed.");
      }
      return;
    }

    if (track.sourceType === "youtube" && ytPlayerRef.current) {
      ytPlayerRef.current.playVideo?.();
      setIsPlaying(true);
      setPlayerError(null);
      return;
    }

    if (activePlaylistIdRef.current) {
      await playTrack(activePlaylistIdRef.current, track.id);
    }
  }, [playTrack, pauseYouTubeBackend, selectedPlaylist?.id]);

  const pause = useCallback(() => {
    if (activeTrackRef.current?.sourceType === "project_audio") {
      audioRef.current?.pause();
    } else {
      pauseYouTubeBackend();
    }
    setIsPlaying(false);
  }, [pauseYouTubeBackend]);

  const nextTrack = useCallback(async () => {
    const next = pickNextTrack(1);
    if (next) {
      await playTrack(next.playlistId, next.trackId);
    }
  }, [pickNextTrack, playTrack]);

  const previousTrack = useCallback(async () => {
    const prev = pickNextTrack(-1);
    if (prev) {
      await playTrack(prev.playlistId, prev.trackId);
    }
  }, [pickNextTrack, playTrack]);

  // Preferences & Loop Markers
  const setPlaybackRate = useCallback(
    (rate: PlaybackSpeed) => {
      commitLibrary((prev) => ({
        ...prev,
        preferences: { ...prev.preferences, playbackRate: rate },
      }));
      applyRateToActiveBackend(rate, activeTrackRef.current?.sourceType ?? null);
    },
    [commitLibrary, applyRateToActiveBackend],
  );

  const setShuffle = useCallback(
    (enabled: boolean) => {
      commitLibrary((prev) => ({
        ...prev,
        preferences: { ...prev.preferences, shuffle: enabled },
      }));
    },
    [commitLibrary],
  );

  const setAutoAdvance = useCallback(
    (enabled: boolean) => {
      commitLibrary((prev) => ({
        ...prev,
        preferences: { ...prev.preferences, autoAdvance: enabled },
      }));
    },
    [commitLibrary],
  );

  const setMiniPlayerEnabled = useCallback(
    (enabled: boolean) => {
      commitLibrary((prev) => ({
        ...prev,
        preferences: { ...prev.preferences, miniPlayerEnabled: enabled },
      }));
    },
    [commitLibrary],
  );

  const getAuthoritativePosition = useCallback((): number => {
    const track = activeTrackRef.current;
    if (track?.sourceType === "youtube" && ytPlayerRef.current?.getCurrentTime) {
      const t = ytPlayerRef.current.getCurrentTime();
      if (typeof t === "number" && Number.isFinite(t)) return Math.max(0, Number(t.toFixed(2)));
    }
    if (track?.sourceType === "project_audio" && audioRef.current) {
      const t = audioRef.current.currentTime;
      if (Number.isFinite(t)) return Math.max(0, Number(t.toFixed(2)));
    }
    return Math.max(0, Number((currentTimeRef.current || 0).toFixed(2)));
  }, []);

  const updateTrack = useCallback(
    (
      playlistId: string,
      trackId: string,
      patch: Partial<Pick<PlaylistTrack, "title" | "artist" | "categoryId" | "practiceNotes" | "loop">>,
    ) => {
      const nowIso = new Date().toISOString();
      commitLibrary((prev) => ({
        ...prev,
        playlists: prev.playlists.map((pl) =>
          pl.id !== playlistId
            ? pl
            : {
                ...pl,
                updatedAt: nowIso,
                tracks: pl.tracks.map((tr) =>
                  tr.id !== trackId
                    ? tr
                    : {
                        ...tr,
                        ...patch,
                        updatedAt: nowIso,
                      },
                ),
              },
        ),
      }));
    },
    [commitLibrary],
  );

  const setLoopA = useCallback(() => {
    const track = activeTrackRef.current;
    const pid = activePlaylistIdRef.current;
    if (!track || !pid) return;
    if (track.sourceType === "youtube" && ytPlayerRef.current && typeof ytPlayerRef.current.seekTo !== "function") {
      setLoopError("A–B looping requires YouTube seeking controls, which are unavailable here.");
      return;
    }
    const pos = getAuthoritativePosition();
    setLoopError(null);
    const keepB = track.loop.bSec !== null && track.loop.bSec > pos ? track.loop.bSec : null;
    updateTrack(pid, track.id, { loop: { aSec: pos, bSec: keepB } });
  }, [getAuthoritativePosition, updateTrack]);

  const setLoopB = useCallback(() => {
    const track = activeTrackRef.current;
    const pid = activePlaylistIdRef.current;
    if (!track || !pid) return;
    if (track.sourceType === "youtube" && ytPlayerRef.current && typeof ytPlayerRef.current.seekTo !== "function") {
      setLoopError("A–B looping requires YouTube seeking controls, which are unavailable here.");
      return;
    }
    const pos = getAuthoritativePosition();
    if (track.loop.aSec === null) {
      setLoopError("Set marker A first before setting loop end B.");
      return;
    }
    if (pos <= track.loop.aSec) {
      setLoopError("Point B must occur strictly after Point A.");
      return;
    }
    setLoopError(null);
    updateTrack(pid, track.id, { loop: { aSec: track.loop.aSec, bSec: pos } });
  }, [getAuthoritativePosition, updateTrack]);

  const clearLoop = useCallback(() => {
    const track = activeTrackRef.current;
    const pid = activePlaylistIdRef.current;
    if (!track || !pid) return;
    setLoopError(null);
    updateTrack(pid, track.id, { loop: { aSec: null, bSec: null } });
  }, [updateTrack]);

  // Category & Playlist CRUD
  const addCategory = useCallback(
    (name: string): PlaylistCategory | null => {
      const cleaned = name.trim().slice(0, 60);
      if (!cleaned) return null;
      const existing = libraryRef.current.categories.find(
        (c) => c.name.toLowerCase() === cleaned.toLowerCase(),
      );
      if (existing) return existing;
      const created: PlaylistCategory = {
        id: createPlaylistId("cat"),
        name: cleaned,
        isDefault: false,
      };
      commitLibrary((prev) => ({
        ...prev,
        categories: [...prev.categories, created],
      }));
      return created;
    },
    [commitLibrary],
  );

  const deleteCategory = useCallback(
    (categoryId: string) => {
      const target = libraryRef.current.categories.find((c) => c.id === categoryId);
      if (!target || target.isDefault) return;
      commitLibrary((prev) => ({
        ...prev,
        categories: prev.categories.filter((c) => c.id !== categoryId),
        playlists: prev.playlists.map((pl) => ({
          ...pl,
          categoryId: pl.categoryId === categoryId ? "cat-practice-reference" : pl.categoryId,
          tracks: pl.tracks.map((tr) => ({
            ...tr,
            categoryId: tr.categoryId === categoryId ? "cat-practice-reference" : tr.categoryId,
          })),
        })),
      }));
    },
    [commitLibrary],
  );

  const createPlaylist = useCallback(
    (title: string, categoryId = "cat-practice-reference", description = ""): Playlist | null => {
      const cleaned = title.trim().slice(0, 200);
      if (!cleaned) return null;
      const nowIso = new Date().toISOString();
      const created: Playlist = {
        id: createPlaylistId("pl"),
        serverId: null,
        title: cleaned,
        description: description.trim().slice(0, 2000),
        categoryId,
        tracks: [],
        isShared: false,
        shareToken: null,
        sharedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      commitLibrary((prev) => ({
        ...prev,
        playlists: [...prev.playlists, created],
      }));
      setSelectedPlaylistId(created.id);
      return created;
    },
    [commitLibrary],
  );

  const renamePlaylist = useCallback(
    (playlistId: string, title: string) => {
      const cleaned = title.trim().slice(0, 200);
      if (!cleaned) return;
      const nowIso = new Date().toISOString();
      commitLibrary((prev) => ({
        ...prev,
        playlists: prev.playlists.map((pl) =>
          pl.id === playlistId ? { ...pl, title: cleaned, updatedAt: nowIso } : pl,
        ),
      }));
    },
    [commitLibrary],
  );

  const updatePlaylistDescription = useCallback(
    (playlistId: string, description: string) => {
      const nowIso = new Date().toISOString();
      commitLibrary((prev) => ({
        ...prev,
        playlists: prev.playlists.map((pl) =>
          pl.id === playlistId
            ? { ...pl, description: description.slice(0, 2000), updatedAt: nowIso }
            : pl,
        ),
      }));
    },
    [commitLibrary],
  );

  const setPlaylistCategory = useCallback(
    (playlistId: string, categoryId: string) => {
      const nowIso = new Date().toISOString();
      commitLibrary((prev) => ({
        ...prev,
        playlists: prev.playlists.map((pl) =>
          pl.id === playlistId ? { ...pl, categoryId, updatedAt: nowIso } : pl,
        ),
      }));
    },
    [commitLibrary],
  );

  const duplicatePlaylist = useCallback(
    (playlistId: string): Playlist | null => {
      const source = libraryRef.current.playlists.find((p) => p.id === playlistId);
      if (!source) return null;
      const nowIso = new Date().toISOString();
      const copy: Playlist = {
        id: createPlaylistId("pl"),
        serverId: null,
        title: `${source.title} (Copy)`,
        description: source.description || "",
        categoryId: source.categoryId,
        tracks: source.tracks.map((tr) => ({
          ...tr,
          id: createPlaylistId("trk"),
          addedAt: nowIso,
          updatedAt: nowIso,
        })),
        isShared: false,
        shareToken: null,
        sharedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      commitLibrary((prev) => ({
        ...prev,
        playlists: [...prev.playlists, copy],
      }));
      setSelectedPlaylistId(copy.id);
      return copy;
    },
    [commitLibrary],
  );

  const deletePlaylist = useCallback(
    (playlistId: string) => {
      if (activePlaylistIdRef.current === playlistId) {
        stop();
        setActivePlaylistId(null);
        setActiveTrackId(null);
      }
      commitLibrary((prev) => ({
        ...prev,
        playlists: prev.playlists.filter((pl) => pl.id !== playlistId),
      }));
    },
    [commitLibrary, stop],
  );

  const syncPlaylistBeforeShare = useCallback(async () => {
    if (!user) {
      throw new Error("Sign in and synchronize with the backend before creating a public link.");
    }
    const curr = libraryRef.current;
    try {
      const remote = await api.syncPlaylistLibrary({
        schemaVersion: curr.schemaVersion,
        categories: curr.categories,
        playlists: curr.playlists,
        preferences: curr.preferences as unknown as Record<string, unknown>,
      });
      setSyncStatus("synced");
      const remoteByClientId = new Map(
        (remote.playlists || []).map((rp) => [String(rp.id || ""), rp]),
      );
      commitLibrary(
        (prev) => ({
          ...prev,
          playlists: prev.playlists.map((pl) => {
            const matched = remoteByClientId.get(pl.id);
            if (!matched) return pl;
            return {
              ...pl,
              serverId: typeof matched.serverId === "string" ? matched.serverId : pl.serverId ?? null,
              isShared: Boolean(matched.isShared && matched.shareToken),
              shareToken:
                Boolean(matched.isShared) && typeof matched.shareToken === "string"
                  ? matched.shareToken
                  : null,
              sharedAt: typeof matched.sharedAt === "string" ? matched.sharedAt : null,
            };
          }),
        }),
        { skipRemote: true },
      );
    } catch {
      setSyncStatus("local");
      throw new Error(
        "This playlist is saved locally only and could not be synchronized to the backend server yet. Public sharing requires backend storage so anyone with the link can load it.",
      );
    }
  }, [user, commitLibrary]);

  const applyShareStatus = useCallback(
    (
      playlistId: string,
      res: {
        serverId: string;
        isShared: boolean;
        shareToken: string | null;
        sharedAt: string | null;
      },
    ) => {
      commitLibrary(
        (prev) => ({
          ...prev,
          playlists: prev.playlists.map((pl) =>
            pl.id === playlistId
              ? {
                  ...pl,
                  serverId: res.serverId,
                  isShared: res.isShared,
                  shareToken: res.shareToken,
                  sharedAt: res.sharedAt,
                }
              : pl,
          ),
        }),
        { skipRemote: true },
      );
    },
    [commitLibrary],
  );

  const enablePlaylistSharing = useCallback(
    async (playlistId: string) => {
      await syncPlaylistBeforeShare();
      const target = libraryRef.current.playlists.find((p) => p.id === playlistId);
      const remoteKey = target?.serverId || playlistId;
      const res = await api.enablePlaylistShare(remoteKey);
      applyShareStatus(playlistId, res);
    },
    [syncPlaylistBeforeShare, applyShareStatus],
  );

  const regeneratePlaylistSharing = useCallback(
    async (playlistId: string) => {
      await syncPlaylistBeforeShare();
      const target = libraryRef.current.playlists.find((p) => p.id === playlistId);
      const remoteKey = target?.serverId || playlistId;
      const res = await api.regeneratePlaylistShare(remoteKey);
      applyShareStatus(playlistId, res);
    },
    [syncPlaylistBeforeShare, applyShareStatus],
  );

  const disablePlaylistSharing = useCallback(
    async (playlistId: string) => {
      const target = libraryRef.current.playlists.find((p) => p.id === playlistId);
      const remoteKey = target?.serverId || playlistId;
      const res = await api.disablePlaylistShare(remoteKey);
      applyShareStatus(playlistId, res);
    },
    [applyShareStatus],
  );

  const addTrackToPlaylist = useCallback(
    (
      playlistId: string,
      draft: TrackDraftInput,
      options: { allowDuplicate?: boolean } = {},
    ): { ok: boolean; track?: PlaylistTrack; duplicate?: boolean; error?: string } => {
      const targetPl = libraryRef.current.playlists.find((p) => p.id === playlistId);
      if (!targetPl) {
        return { ok: false, error: "Select or create a playlist before adding a track." };
      }
      const cleanTitle = draft.title.trim().slice(0, 200);
      if (!cleanTitle) {
        return { ok: false, error: "Track title is required." };
      }

      const incomingSig = getTrackSignature(draft);
      if (!options.allowDuplicate) {
        const dup = targetPl.tracks.find((t) => getTrackSignature(t) === incomingSig);
        if (dup) {
          return {
            ok: false,
            duplicate: true,
            error: `"${dup.title}" is already in this playlist. Click "Add Anyway" to add a duplicate copy.`,
          };
        }
      }

      const nowIso = new Date().toISOString();
      const createdTrack: PlaylistTrack = {
        id: createPlaylistId("trk"),
        sourceType: draft.sourceType,
        title: cleanTitle,
        artist: (draft.artist || "").trim().slice(0, 160),
        categoryId: draft.categoryId || targetPl.categoryId || "cat-practice-reference",
        thumbnailUrl: draft.thumbnailUrl ?? null,
        practiceNotes: (draft.practiceNotes || "").slice(0, 2000),
        loop: { aSec: null, bSec: null },
        youtubeVideoId: draft.youtubeVideoId ?? null,
        youtubeUrl: draft.youtubeUrl ?? null,
        projectId: draft.projectId ?? null,
        mediaAssetId: draft.mediaAssetId ?? null,
        projectTitle: draft.projectTitle ?? null,
        mediaFilename: draft.mediaFilename ?? null,
        mediaMimeType: draft.mediaMimeType ?? null,
        durationSec: draft.durationSec ?? null,
        addedAt: nowIso,
        updatedAt: nowIso,
      };

      commitLibrary((prev) => ({
        ...prev,
        playlists: prev.playlists.map((pl) =>
          pl.id !== playlistId
            ? pl
            : { ...pl, updatedAt: nowIso, tracks: [...pl.tracks, createdTrack] },
        ),
      }));

      return { ok: true, track: createdTrack };
    },
    [commitLibrary],
  );

  const reorderTrack = useCallback(
    (playlistId: string, fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex) return;
      const nowIso = new Date().toISOString();
      commitLibrary((prev) => ({
        ...prev,
        playlists: prev.playlists.map((pl) => {
          if (pl.id !== playlistId) return pl;
          if (
            fromIndex < 0 ||
            fromIndex >= pl.tracks.length ||
            toIndex < 0 ||
            toIndex >= pl.tracks.length
          ) {
            return pl;
          }
          const copy = [...pl.tracks];
          const [moved] = copy.splice(fromIndex, 1);
          copy.splice(toIndex, 0, moved);
          return { ...pl, updatedAt: nowIso, tracks: copy };
        }),
      }));
    },
    [commitLibrary],
  );

  const removeTrack = useCallback(
    (playlistId: string, trackId: string) => {
      if (activePlaylistIdRef.current === playlistId && activeTrackIdRef.current === trackId) {
        stop();
        setActiveTrackId(null);
      }
      const nowIso = new Date().toISOString();
      commitLibrary((prev) => ({
        ...prev,
        playlists: prev.playlists.map((pl) =>
          pl.id !== playlistId
            ? pl
            : {
                ...pl,
                updatedAt: nowIso,
                tracks: pl.tracks.filter((tr) => tr.id !== trackId),
              },
        ),
      }));
    },
    [commitLibrary, stop],
  );

  const importLibrary = useCallback(
    (incoming: PlaylistLibraryState, mode: "merge" | "replace") => {
      if (mode === "replace") {
        stop();
        setActivePlaylistId(null);
        setActiveTrackId(null);
      }
      commitLibrary((prev) => applyImportedLibrary(prev, incoming, mode));
    },
    [commitLibrary, stop],
  );

  const dismissStorageNotice = useCallback(() => setStorageNotice(null), []);

  const value = useMemo<PlaylistContextValue>(
    () => ({
      library,
      selectedPlaylistId,
      selectedPlaylist,
      setSelectedPlaylistId,
      storageNotice,
      dismissStorageNotice,
      syncStatus,
      addCategory,
      deleteCategory,
      createPlaylist,
      renamePlaylist,
      updatePlaylistDescription,
      setPlaylistCategory,
      duplicatePlaylist,
      deletePlaylist,
      enablePlaylistSharing,
      regeneratePlaylistSharing,
      disablePlaylistSharing,
      addTrackToPlaylist,
      updateTrack,
      reorderTrack,
      removeTrack,
      importLibrary,
      activePlaylistId,
      activeTrackId,
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
      youtubeReady,
      playTrack,
      togglePlay,
      pause,
      stop,
      seekTo,
      nextTrack,
      previousTrack,
      setPlaybackRate,
      setShuffle,
      setAutoAdvance,
      setMiniPlayerEnabled,
      setLoopA,
      setLoopB,
      clearLoop,
      registerYouTubeViewport,
    }),
    [
      library,
      selectedPlaylistId,
      selectedPlaylist,
      storageNotice,
      dismissStorageNotice,
      syncStatus,
      addCategory,
      deleteCategory,
      createPlaylist,
      renamePlaylist,
      updatePlaylistDescription,
      setPlaylistCategory,
      duplicatePlaylist,
      deletePlaylist,
      enablePlaylistSharing,
      regeneratePlaylistSharing,
      disablePlaylistSharing,
      addTrackToPlaylist,
      updateTrack,
      reorderTrack,
      removeTrack,
      importLibrary,
      activePlaylistId,
      activeTrackId,
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
      youtubeReady,
      playTrack,
      togglePlay,
      pause,
      stop,
      seekTo,
      nextTrack,
      previousTrack,
      setPlaybackRate,
      setShuffle,
      setAutoAdvance,
      setMiniPlayerEnabled,
      setLoopA,
      setLoopB,
      clearLoop,
      registerYouTubeViewport,
    ],
  );

  return (
    <PlaylistContext.Provider value={value}>
      {children}
      {/* Single persistent YouTube host reused cleanly without duplicating players */}
      <div
        ref={ytHostRef}
        data-testid="persistent-youtube-player-host"
        className="overflow-hidden rounded-lg bg-black"
        style={{
          position: "fixed",
          left: "-9999px",
          top: "-9999px",
          width: "1px",
          height: "1px",
          opacity: 0,
          pointerEvents: "none",
          zIndex: -1,
        }}
      >
        <div ref={ytMountTargetRef} className="h-full w-full" />
      </div>
    </PlaylistContext.Provider>
  );
}

export function usePlaylists(): PlaylistContextValue {
  const ctx = useContext(PlaylistContext);
  if (!ctx) {
    throw new Error("usePlaylists must be used within a PlaylistProvider.");
  }
  return ctx;
}

export function useOptionalPlaylists(): PlaylistContextValue | null {
  return useContext(PlaylistContext);
}

export { createDefaultLibrary };
