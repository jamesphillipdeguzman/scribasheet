import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  FileAudio,
  Loader2,
  Music,
  Pencil,
  Piano,
  Play,
  Plus,
  Repeat,
  Search,
  Sparkles,
  Trash2,
  X,
  Youtube,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import type { BatchAddTracksResult, TrackDraftInput } from "@/features/playlists/PlaylistContext";
import type {
  Playlist,
  PlaylistCategory,
  PlaylistTrack,
} from "@/features/playlists/playlistTypes";
import {
  fetchYouTubeMetadataBatch,
  parseYouTubeUrlsBatch,
} from "@/features/playlists/youtubeUtils";
import { formatDuration } from "@/lib/utils";
import { api } from "@/services/api";
import type { MediaAsset, Project } from "@/types/api";

interface BatchItemMeta {
  title: string;
  artist: string;
  thumbnailUrl: string;
  fetched: boolean;
  error?: string;
}

interface TrackQueuePaneProps {
  playlist: Playlist | null;
  categories: PlaylistCategory[];
  activeTrackId: string | null;
  isPlaying: boolean;
  onAddTrack: (
    playlistId: string,
    draft: TrackDraftInput,
    options?: { allowDuplicate?: boolean },
  ) => { ok: boolean; duplicate?: boolean; error?: string };
  onAddTracks: (
    playlistId: string,
    drafts: TrackDraftInput[],
    options?: { allowDuplicate?: boolean },
  ) => BatchAddTracksResult;
  onNotify?: (kind: "success" | "error", text: string) => void;
  onUpdateTrack: (
    playlistId: string,
    trackId: string,
    patch: Partial<Pick<PlaylistTrack, "title" | "artist" | "categoryId" | "practiceNotes">>,
  ) => void;
  onReorderTrack: (playlistId: string, fromIndex: number, toIndex: number) => void;
  onRemoveTrack: (playlistId: string, trackId: string) => void;
  onPlayTrack: (playlistId: string, trackId: string) => void;
  onTranscribeTrack: (track: PlaylistTrack) => void;
  onOpenInPlayground: (track: PlaylistTrack) => void;
}

function isAudioOrVideoAsset(asset: MediaAsset): boolean {
  const name = (asset.original_filename || "").toLowerCase();
  const mime = (asset.mime_type || "").toLowerCase();
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return true;
  return /\.(mp3|wav|flac|m4a|ogg|aac|mp4|mov|webm|mkv)$/i.test(name);
}

export function TrackQueuePane({
  playlist,
  categories,
  activeTrackId,
  isPlaying,
  onAddTrack,
  onAddTracks,
  onNotify,
  onUpdateTrack,
  onReorderTrack,
  onRemoveTrack,
  onPlayTrack,
  onTranscribeTrack,
  onOpenInPlayground,
}: TrackQueuePaneProps) {
  const [sourceTab, setSourceTab] = useState<"youtube" | "project_audio">("youtube");
  const [youtubeInput, setYoutubeInput] = useState("");
  const [fetchingMeta, setFetchingMeta] = useState(false);
  const [youtubeError, setYoutubeError] = useState<string | null>(null);
  const [youtubeMetaNotice, setYoutubeMetaNotice] = useState<string | null>(null);
  const [batchMetaMap, setBatchMetaMap] = useState<Record<string, BatchItemMeta>>({});
  const [excludedVideoIds, setExcludedVideoIds] = useState<Set<string>>(() => new Set());

  const [draftTitle, setDraftTitle] = useState("");
  const [draftArtist, setDraftArtist] = useState("");
  const [draftCategoryId, setDraftCategoryId] = useState(
    playlist?.categoryId ?? categories[0]?.id ?? "cat-practice-reference",
  );
  const [draftNotes, setDraftNotes] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addFeedback, setAddFeedback] = useState<string | null>(null);
  const [duplicateDraft, setDuplicateDraft] = useState<TrackDraftInput | null>(null);
  const isSubmittingRef = useRef(false);

  const [projectSearch, setProjectSearch] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [selectedAssetId, setSelectedAssetId] = useState<string>("");

  useEffect(() => {
    if (playlist?.categoryId) {
      setDraftCategoryId(playlist.categoryId);
    }
  }, [playlist?.id, playlist?.categoryId]);

  const batchParse = useMemo(() => parseYouTubeUrlsBatch(youtubeInput), [youtubeInput]);
  const activeBatchItems = useMemo(
    () => batchParse.validItems.filter((item) => !excludedVideoIds.has(item.videoId)),
    [batchParse.validItems, excludedVideoIds],
  );
  const existingYouTubeIds = useMemo(
    () =>
      new Set(
        (playlist?.tracks ?? [])
          .filter((t) => t.sourceType === "youtube" && t.youtubeVideoId)
          .map((t) => t.youtubeVideoId!),
      ),
    [playlist?.tracks],
  );
  const addableBatchItems = useMemo(
    () => activeBatchItems.filter((item) => !existingYouTubeIds.has(item.videoId)),
    [activeBatchItems, existingYouTubeIds],
  );

  // Queue filter controls
  const [queueSearch, setQueueSearch] = useState("");
  const [queueCategoryFilter, setQueueCategoryFilter] = useState("all");
  const [dragTrackIdx, setDragTrackIdx] = useState<number | null>(null);

  // Track inline editor state
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editArtist, setEditArtist] = useState("");
  const [editCategoryId, setEditCategoryId] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const { data: projectsData, isLoading: projectsLoading } = useQuery({
    queryKey: ["projects", "playlist-picker"],
    queryFn: () => api.listProjects({ page_size: 100 }),
  });

  const userProjects = useMemo(() => projectsData?.items ?? [], [projectsData]);
  const projectsById = useMemo(
    () => new Map<string, Project>(userProjects.map((p) => [p.id, p])),
    [userProjects],
  );

  const projectsWithAudio = useMemo(
    () =>
      userProjects
        .map((proj) => ({
          project: proj,
          audioAssets: proj.media_assets.filter(isAudioOrVideoAsset),
        }))
        .filter((entry) => entry.audioAssets.length > 0),
    [userProjects],
  );

  const filteredPickerProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    if (!q) return projectsWithAudio;
    return projectsWithAudio.filter(({ project }) => project.title.toLowerCase().includes(q));
  }, [projectsWithAudio, projectSearch]);

  const activePickerEntry = useMemo(
    () =>
      projectsWithAudio.find((p) => p.project.id === selectedProjectId) ??
      filteredPickerProjects[0] ??
      null,
    [projectsWithAudio, filteredPickerProjects, selectedProjectId],
  );

  const activePickerAsset = useMemo(() => {
    if (!activePickerEntry) return null;
    return (
      activePickerEntry.audioAssets.find((a) => a.id === selectedAssetId) ??
      activePickerEntry.audioAssets[0] ??
      null
    );
  }, [activePickerEntry, selectedAssetId]);

  const categoryMap = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories],
  );

  const handleFetchYouTube = async () => {
    setYoutubeError(null);
    setYoutubeMetaNotice(null);
    setAddError(null);
    setAddFeedback(null);
    setDuplicateDraft(null);

    if (activeBatchItems.length === 0) {
      setYoutubeError(
        batchParse.invalidItems[0]?.error ||
          "Please enter at least one valid YouTube URL (youtube.com/watch?v=... or youtu.be/...).",
      );
      return;
    }

    setFetchingMeta(true);
    try {
      const metaMap = await fetchYouTubeMetadataBatch(
        activeBatchItems.map((i) => i.videoId),
        3,
      );
      setBatchMetaMap((prev) => {
        const next = { ...prev };
        for (const item of activeBatchItems) {
          const res = metaMap.get(item.videoId);
          next[item.videoId] = {
            title: res?.title || prev[item.videoId]?.title || "",
            artist: res?.authorName || prev[item.videoId]?.artist || "",
            thumbnailUrl: res?.thumbnailUrl || item.thumbnailUrl,
            fetched: Boolean(res?.fetched),
            error: res?.error,
          };
        }
        return next;
      });

      if (activeBatchItems.length === 1) {
        const onlyMeta = metaMap.get(activeBatchItems[0].videoId);
        if (onlyMeta?.title) setDraftTitle(onlyMeta.title);
        if (onlyMeta?.authorName) setDraftArtist(onlyMeta.authorName);
        if (onlyMeta && !onlyMeta.fetched && onlyMeta.error) {
          setYoutubeMetaNotice(onlyMeta.error);
        }
      } else {
        const failedCount = activeBatchItems.filter(
          (i) => !metaMap.get(i.videoId)?.fetched,
        ).length;
        if (failedCount > 0) {
          setYoutubeMetaNotice(
            `Metadata unavailable for ${failedCount} of ${activeBatchItems.length} videos; you can edit titles below or add with default labels.`,
          );
        }
      }
    } finally {
      setFetchingMeta(false);
    }
  };

  const resetDraft = () => {
    setYoutubeInput("");
    setExcludedVideoIds(new Set());
    setBatchMetaMap({});
    setYoutubeError(null);
    setYoutubeMetaNotice(null);
    setDraftTitle("");
    setDraftArtist("");
    setDraftNotes("");
    setAddError(null);
    setDuplicateDraft(null);
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingRef.current) return;
    if (!playlist) {
      setAddError("Select or create a playlist before adding tracks.");
      return;
    }
    isSubmittingRef.current = true;
    try {
      setAddError(null);
      setAddFeedback(null);
      setDuplicateDraft(null);

      if (sourceTab === "youtube") {
        if (activeBatchItems.length === 0) {
          setYoutubeError(
            batchParse.invalidItems[0]?.error ||
              "Could not extract a valid 11-character YouTube video ID.",
          );
          return;
        }

        if (activeBatchItems.length === 1) {
          const item = activeBatchItems[0];
          const fetchedMeta = batchMetaMap[item.videoId];
          const resolvedTitle =
            draftTitle.trim() ||
            fetchedMeta?.title?.trim() ||
            `YouTube Practice Track (${item.videoId})`;
          const resolvedArtist = draftArtist.trim() || fetchedMeta?.artist?.trim() || "";
          const draft: TrackDraftInput = {
            sourceType: "youtube",
            title: resolvedTitle,
            artist: resolvedArtist,
            categoryId: draftCategoryId || playlist.categoryId,
            thumbnailUrl: fetchedMeta?.thumbnailUrl || item.thumbnailUrl,
            practiceNotes: draftNotes,
            youtubeVideoId: item.videoId,
            youtubeUrl: item.canonicalUrl,
          };
          const res = onAddTrack(playlist.id, draft);
          if (!res.ok) {
            setAddError(res.error || "Could not add YouTube track.");
            if (res.duplicate) setDuplicateDraft(draft);
            return;
          }
          const okMsg = `Added "${resolvedTitle}" to "${playlist.title}".`;
          resetDraft();
          setAddFeedback(okMsg);
          onNotify?.("success", okMsg);
          return;
        }

        // Batch add multiple valid YouTube URLs atomically
        const drafts: TrackDraftInput[] = activeBatchItems.map((item) => {
          const meta = batchMetaMap[item.videoId];
          return {
            sourceType: "youtube",
            title: meta?.title?.trim() || `YouTube Practice Track (${item.videoId})`,
            artist: meta?.artist?.trim() || "",
            categoryId: draftCategoryId || playlist.categoryId,
            thumbnailUrl: meta?.thumbnailUrl || item.thumbnailUrl,
            practiceNotes: draftNotes,
            youtubeVideoId: item.videoId,
            youtubeUrl: item.canonicalUrl,
          };
        });

        const batchRes = onAddTracks(playlist.id, drafts);
        if (!batchRes.ok) {
          setAddError(batchRes.error || "No new valid tracks could be added.");
          return;
        }

        const notes: string[] = [
          `Added ${batchRes.addedTracks.length} ${
            batchRes.addedTracks.length === 1 ? "track" : "tracks"
          } to "${playlist.title}".`,
        ];
        if (batchRes.skippedDuplicates.length > 0 || batchParse.duplicateInBatch.length > 0) {
          const dupCount =
            batchRes.skippedDuplicates.length + batchParse.duplicateInBatch.length;
          notes.push(`Skipped ${dupCount} duplicate ${dupCount === 1 ? "link" : "links"}.`);
        }
        if (batchParse.invalidItems.length > 0) {
          notes.push(
            `Ignored ${batchParse.invalidItems.length} invalid ${
              batchParse.invalidItems.length === 1 ? "URL" : "URLs"
            } (${batchParse.invalidItems.map((i) => i.rawUrl).join(", ")}).`,
          );
        }
        const summary = notes.join(" ");
        resetDraft();
        setAddFeedback(summary);
        onNotify?.("success", summary);
        return;
      }

      // ScribaSheet Project Audio
      if (!activePickerEntry || !activePickerAsset) {
        setAddError("Select a ScribaSheet project with an audio or video recording first.");
        return;
      }
      const resolvedTitle = draftTitle.trim() || activePickerEntry.project.title;
      const draft: TrackDraftInput = {
        sourceType: "project_audio",
        title: resolvedTitle,
        artist: draftArtist.trim() || activePickerEntry.project.instrument,
        categoryId: draftCategoryId || playlist.categoryId,
        thumbnailUrl: null,
        practiceNotes: draftNotes,
        projectId: activePickerEntry.project.id,
        mediaAssetId: activePickerAsset.id,
        projectTitle: activePickerEntry.project.title,
        mediaFilename: activePickerAsset.original_filename,
        mediaMimeType: activePickerAsset.mime_type,
        durationSec: activePickerAsset.duration_seconds ?? activePickerEntry.project.duration_seconds,
      };
      const res = onAddTrack(playlist.id, draft);
      if (!res.ok) {
        setAddError(res.error || "Could not attach project audio.");
        if (res.duplicate) setDuplicateDraft(draft);
        return;
      }
      const okMsg = `Added "${resolvedTitle}" to "${playlist.title}".`;
      resetDraft();
      setAddFeedback(okMsg);
      onNotify?.("success", okMsg);
    } finally {
      isSubmittingRef.current = false;
    }
  };

  if (!playlist) {
    return (
      <Card>
        <CardContent className="py-14 text-center space-y-2" data-testid="no-playlist-selected">
          <Music className="mx-auto h-8 w-8 text-[#A78BFA]" />
          <h2 className="text-base font-semibold">Select or Create a Playlist</h2>
          <p className="mx-auto max-w-md text-xs text-stone-600 dark:text-[#A1A1AA]">
            Use the left sidebar to create your first playlist for Classical Violin, Choral / SATB,
            Piano Arrangements, or Sight-Reading practice.
          </p>
        </CardContent>
      </Card>
    );
  }

  const normalizedSearch = queueSearch.trim().toLowerCase();
  const visibleTracks = playlist.tracks
    .map((track, originalIndex) => ({ track, originalIndex }))
    .filter(({ track }) => {
      if (queueCategoryFilter !== "all" && track.categoryId !== queueCategoryFilter) {
        return false;
      }
      if (!normalizedSearch) return true;
      return (
        track.title.toLowerCase().includes(normalizedSearch) ||
        track.artist.toLowerCase().includes(normalizedSearch) ||
        track.practiceNotes.toLowerCase().includes(normalizedSearch)
      );
    });

  return (
    <div className="space-y-4 min-w-0" data-testid="track-queue-pane">
      {/* Quick Add Track */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-stone-900 dark:text-[#F5F3FF]">
                Quick Add Track to &ldquo;{playlist.title}&rdquo;
              </h2>
              <p className="text-[11px] text-stone-600 dark:text-[#A1A1AA]">
                Add YouTube recordings or link existing ScribaSheet project audio without duplicating files.
              </p>
            </div>
            <div
              role="tablist"
              aria-label="Track source type"
              className="inline-flex rounded-lg border border-stone-300 bg-stone-100 p-0.5 text-xs dark:border-[#27273A] dark:bg-[#09090F]"
            >
              <button
                type="button"
                role="tab"
                aria-selected={sourceTab === "youtube"}
                data-testid="quick-add-tab-youtube"
                onClick={() => {
                  setSourceTab("youtube");
                  setAddError(null);
                  setDuplicateDraft(null);
                }}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors ${
                  sourceTab === "youtube"
                    ? "bg-white text-stone-900 shadow-sm dark:bg-[#181825] dark:text-[#F5F3FF]"
                    : "text-stone-600 hover:text-stone-900 dark:text-[#A1A1AA] dark:hover:text-white"
                }`}
              >
                <Youtube className="h-3.5 w-3.5 text-red-500" />
                YouTube URL
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sourceTab === "project_audio"}
                data-testid="quick-add-tab-project"
                onClick={() => {
                  setSourceTab("project_audio");
                  setAddError(null);
                  setDuplicateDraft(null);
                }}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors ${
                  sourceTab === "project_audio"
                    ? "bg-white text-stone-900 shadow-sm dark:bg-[#181825] dark:text-[#F5F3FF]"
                    : "text-stone-600 hover:text-stone-900 dark:text-[#A1A1AA] dark:hover:text-white"
                }`}
              >
                <FileAudio className="h-3.5 w-3.5 text-[#A78BFA]" />
                Project Audio
              </button>
            </div>
          </div>

          <form noValidate onSubmit={handleAddSubmit} className="space-y-3">
            {sourceTab === "youtube" ? (
              <div className="space-y-2">
                <div className="flex flex-col sm:flex-row gap-2 items-start">
                  <textarea
                    rows={2}
                    value={youtubeInput}
                    onChange={(e) => {
                      setYoutubeInput(e.target.value);
                      setYoutubeError(null);
                      setAddError(null);
                      setAddFeedback(null);
                      setExcludedVideoIds(new Set());
                    }}
                    placeholder="Paste one or multiple YouTube URLs (separated by new lines, spaces, or commas)..."
                    aria-label="YouTube Video URLs"
                    data-testid="youtube-url-input"
                    className="min-h-[60px] w-full sm:flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs text-stone-900 placeholder:text-stone-400 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF] dark:placeholder:text-[#52526B]"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void handleFetchYouTube()}
                    disabled={fetchingMeta}
                    data-testid="fetch-youtube-meta-btn"
                    className="shrink-0"
                  >
                    {fetchingMeta ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    {activeBatchItems.length > 1
                      ? `Fetch Metadata (${activeBatchItems.length})`
                      : "Fetch Metadata"}
                  </Button>
                </div>

                {youtubeError && (
                  <p
                    role="alert"
                    data-testid="youtube-url-error"
                    className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200"
                  >
                    {youtubeError}
                  </p>
                )}

                {youtubeMetaNotice && (
                  <p
                    data-testid="youtube-meta-fallback-notice"
                    className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                  >
                    {youtubeMetaNotice}
                  </p>
                )}

                {activeBatchItems.length === 1 && (
                  <div className="flex items-center gap-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                    <Check className="h-3.5 w-3.5" />
                    <span>
                      Validated Video ID:{" "}
                      <code data-testid="parsed-youtube-video-id" className="font-mono font-semibold">
                        {activeBatchItems[0].videoId}
                      </code>
                    </span>
                  </div>
                )}

                {(batchParse.invalidItems.length > 0 || batchParse.duplicateInBatch.length > 0) &&
                  activeBatchItems.length > 0 && (
                    <div
                      data-testid="youtube-batch-warnings"
                      className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-950 space-y-1 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                    >
                      {batchParse.invalidItems.length > 0 && (
                        <div>
                          Ignored {batchParse.invalidItems.length} invalid{" "}
                          {batchParse.invalidItems.length === 1 ? "URL" : "URLs"}:{" "}
                          <span className="font-mono">
                            {batchParse.invalidItems.map((i) => i.rawUrl).join(", ")}
                          </span>
                        </div>
                      )}
                      {batchParse.duplicateInBatch.length > 0 && (
                        <div>
                          Deduplicated {batchParse.duplicateInBatch.length} repeated video{" "}
                          {batchParse.duplicateInBatch.length === 1 ? "ID" : "IDs"} in paste.
                        </div>
                      )}
                    </div>
                  )}

                {activeBatchItems.length > 1 && (
                  <div
                    data-testid="youtube-batch-preview"
                    className="rounded-xl border border-stone-200 bg-stone-50 p-3 space-y-2 dark:border-[#27273A] dark:bg-[#09090F]"
                  >
                    <div className="flex items-center justify-between text-[11px] font-semibold text-stone-700 dark:text-[#A1A1AA]">
                      <span>Detected YouTube Batch ({activeBatchItems.length} videos)</span>
                      <span>
                        {addableBatchItems.length} new to add
                      </span>
                    </div>
                    <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                      {activeBatchItems.map((item, idx) => {
                        const meta = batchMetaMap[item.videoId];
                        const alreadyExists = existingYouTubeIds.has(item.videoId);
                        return (
                          <div
                            key={item.videoId}
                            data-testid={`batch-preview-item-${item.videoId}`}
                            className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-lg border border-stone-200 bg-white p-2 dark:border-[#27273A] dark:bg-[#11111B]"
                          >
                            <img
                              src={meta?.thumbnailUrl || item.thumbnailUrl}
                              alt={meta?.title || item.videoId}
                              className="h-10 w-16 shrink-0 rounded object-cover bg-stone-200"
                            />
                            <div className="min-w-0 flex-1 grid gap-1.5 sm:grid-cols-2">
                              <input
                                type="text"
                                value={meta?.title ?? ""}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setBatchMetaMap((prev) => ({
                                    ...prev,
                                    [item.videoId]: {
                                      title: val,
                                      artist: prev[item.videoId]?.artist || "",
                                      thumbnailUrl:
                                        prev[item.videoId]?.thumbnailUrl || item.thumbnailUrl,
                                      fetched: Boolean(prev[item.videoId]?.fetched),
                                    },
                                  }));
                                }}
                                placeholder={`Track #${idx + 1} (${item.videoId})`}
                                aria-label={`Batch title for ${item.videoId}`}
                                className="h-7 rounded border border-stone-300 bg-white px-2 text-[11px] text-stone-900 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
                              />
                              <input
                                type="text"
                                value={meta?.artist ?? ""}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setBatchMetaMap((prev) => ({
                                    ...prev,
                                    [item.videoId]: {
                                      title: prev[item.videoId]?.title || "",
                                      artist: val,
                                      thumbnailUrl:
                                        prev[item.videoId]?.thumbnailUrl || item.thumbnailUrl,
                                      fetched: Boolean(prev[item.videoId]?.fetched),
                                    },
                                  }));
                                }}
                                placeholder="Composer / Channel"
                                aria-label={`Batch artist for ${item.videoId}`}
                                className="h-7 rounded border border-stone-300 bg-white px-2 text-[11px] text-stone-900 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
                              />
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {alreadyExists && (
                                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-500/20 dark:text-amber-300">
                                  In Playlist
                                </span>
                              )}
                              <button
                                type="button"
                                aria-label={`Remove ${item.videoId} from batch`}
                                onClick={() =>
                                  setExcludedVideoIds((prev) => new Set([...prev, item.videoId]))
                                }
                                className="rounded p-1 text-stone-400 hover:text-red-500"
                                title="Exclude from batch"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {projectsLoading ? (
                  <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-[#A1A1AA]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading your ScribaSheet projects...
                  </div>
                ) : projectsWithAudio.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-stone-300 p-3 text-xs text-stone-600 dark:border-[#27273A] dark:text-[#A1A1AA]">
                    No projects with uploaded audio or video files were found yet. Create a transcription project and upload MP3/WAV/MP4 media first.
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-stone-600 dark:text-[#A1A1AA]">
                        Search & Select Project
                      </label>
                      <input
                        type="search"
                        value={projectSearch}
                        onChange={(e) => setProjectSearch(e.target.value)}
                        placeholder="Filter projects..."
                        className="mb-1 h-8 w-full rounded-lg border border-stone-300 bg-white px-2.5 text-xs text-stone-900 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
                      />
                      <select
                        aria-label="Select project audio source"
                        data-testid="project-picker-select"
                        value={activePickerEntry?.project.id ?? ""}
                        onChange={(e) => {
                          const nextProjId = e.target.value;
                          setSelectedProjectId(nextProjId);
                          const found = projectsWithAudio.find((x) => x.project.id === nextProjId);
                          if (found) {
                            setSelectedAssetId(found.audioAssets[0]?.id ?? "");
                            if (!draftTitle.trim()) setDraftTitle(found.project.title);
                            if (!draftArtist.trim()) setDraftArtist(found.project.instrument);
                          }
                        }}
                        className="h-9 w-full rounded-lg border border-stone-300 bg-white px-2.5 text-xs text-stone-900 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
                      >
                        {filteredPickerProjects.map(({ project }) => (
                          <option key={project.id} value={project.id}>
                            {project.title} ({project.instrument})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-stone-600 dark:text-[#A1A1AA]">
                        Audio / Recording Asset
                      </label>
                      <select
                        aria-label="Select project media asset"
                        value={activePickerAsset?.id ?? ""}
                        onChange={(e) => setSelectedAssetId(e.target.value)}
                        className="h-9 w-full rounded-lg border border-stone-300 bg-white px-2.5 text-xs text-stone-900 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
                      >
                        {(activePickerEntry?.audioAssets ?? []).map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {asset.original_filename} ({asset.mime_type})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            )}

            {!(sourceTab === "youtube" && activeBatchItems.length > 1) && (
              <div className="grid gap-2 sm:grid-cols-3">
                <input
                  type="text"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder="Track title (editable)"
                  aria-label="Track title"
                  data-testid="quick-add-title-input"
                  className="h-9 rounded-lg border border-stone-300 bg-white px-3 text-xs text-stone-900 placeholder:text-stone-400 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF] dark:placeholder:text-[#52526B]"
                />
                <input
                  type="text"
                  value={draftArtist}
                  onChange={(e) => setDraftArtist(e.target.value)}
                  placeholder="Composer / Artist"
                  aria-label="Composer or Artist"
                  data-testid="quick-add-artist-input"
                  className="h-9 rounded-lg border border-stone-300 bg-white px-3 text-xs text-stone-900 placeholder:text-stone-400 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF] dark:placeholder:text-[#52526B]"
                />
                <select
                  aria-label="Track category"
                  value={draftCategoryId}
                  onChange={(e) => setDraftCategoryId(e.target.value)}
                  className="h-9 rounded-lg border border-stone-300 bg-white px-2.5 text-xs text-stone-900 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
                >
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={draftNotes}
                onChange={(e) => setDraftNotes(e.target.value)}
                placeholder="Practice notes (e.g., Watch shift to 3rd position at 1:42)"
                aria-label="Practice notes"
                data-testid="quick-add-notes-input"
                className="h-9 min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 text-xs text-stone-900 placeholder:text-stone-400 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF] dark:placeholder:text-[#52526B]"
              />
              <Button type="submit" size="sm" data-testid="add-track-submit-btn">
                <Plus className="h-3.5 w-3.5" />
                {sourceTab === "youtube" && activeBatchItems.length > 1
                  ? `Add ${addableBatchItems.length > 0 ? addableBatchItems.length : activeBatchItems.length} ${
                      (addableBatchItems.length > 0 ? addableBatchItems.length : activeBatchItems.length) === 1
                        ? "Track"
                        : "Tracks"
                    } to Playlist`
                  : "Add to Playlist"}
              </Button>
            </div>

            {addFeedback && (
              <div
                role="status"
                data-testid="add-track-feedback"
                className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-950 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200"
              >
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>{addFeedback}</span>
              </div>
            )}

            {addError && (
              <div
                role="alert"
                data-testid="add-track-error"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
              >
                <span>{addError}</span>
                {duplicateDraft && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-testid="add-duplicate-anyway-btn"
                    onClick={() => {
                      const forced = onAddTrack(playlist.id, duplicateDraft, {
                        allowDuplicate: true,
                      });
                      if (forced.ok) {
                        const msg = `Added "${duplicateDraft.title}" to "${playlist.title}".`;
                        resetDraft();
                        setAddFeedback(msg);
                        onNotify?.("success", msg);
                      }
                    }}
                  >
                    Add Anyway
                  </Button>
                )}
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      {/* Track Search & Filter */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400 dark:text-[#71717A]" />
          <input
            type="search"
            value={queueSearch}
            onChange={(e) => setQueueSearch(e.target.value)}
            placeholder="Search tracks by title, composer, or notes..."
            aria-label="Search playlist tracks"
            data-testid="track-search-input"
            className="h-9 w-full rounded-lg border border-stone-300 bg-white pl-8 pr-3 text-xs text-stone-900 placeholder:text-stone-400 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF] dark:placeholder:text-[#52526B]"
          />
        </div>
        <select
          aria-label="Filter tracks by category"
          value={queueCategoryFilter}
          onChange={(e) => setQueueCategoryFilter(e.target.value)}
          className="h-9 rounded-lg border border-stone-300 bg-white px-2.5 text-xs text-stone-900 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF]"
        >
          <option value="all">All Track Categories</option>
          {categories.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.name}
            </option>
          ))}
        </select>
      </div>

      {/* Track Queue Items */}
      {visibleTracks.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-xs text-stone-600 dark:text-[#A1A1AA]">
            {playlist.tracks.length === 0
              ? "This playlist has no tracks yet. Add a YouTube recording or attach an existing ScribaSheet project audio track above."
              : "No tracks match your current search or category filter."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2.5" data-testid="track-queue-list">
          {visibleTracks.map(({ track, originalIndex }) => {
            const isActive = track.id === activeTrackId;
            const catName = categoryMap.get(track.categoryId)?.name ?? "Practice / Reference";
            const sourceProject =
              track.sourceType === "project_audio" && track.projectId
                ? projectsById.get(track.projectId) ?? null
                : null;
            const projectUnavailable =
              track.sourceType === "project_audio" &&
              !projectsLoading &&
              Boolean(track.projectId) &&
              !sourceProject;
            const hasLoop =
              track.loop.aSec !== null &&
              track.loop.bSec !== null &&
              track.loop.bSec > track.loop.aSec;
            const isEditing = editingTrackId === track.id;

            return (
              <div
                key={track.id}
                draggable
                onDragStart={() => setDragTrackIdx(originalIndex)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragTrackIdx !== null && dragTrackIdx !== originalIndex) {
                    onReorderTrack(playlist.id, dragTrackIdx, originalIndex);
                  }
                  setDragTrackIdx(null);
                }}
                data-testid={`track-card-${track.id}`}
                className={`rounded-xl border p-3 transition-colors space-y-2 ${
                  isActive
                    ? "border-violet-500 bg-violet-50/70 dark:border-[#A78BFA]/70 dark:bg-violet-500/10"
                    : "border-stone-200 bg-white dark:border-[#27273A] dark:bg-[#11111B]"
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                  {/* Thumbnail or Icon */}
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
                      <FileAudio className="h-6 w-6 text-[#A78BFA]" />
                    )}
                  </div>

                  {/* Metadata */}
                  <div className="min-w-0 flex-1 space-y-1">
                    {isEditing ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!editTitle.trim()) return;
                          onUpdateTrack(playlist.id, track.id, {
                            title: editTitle.trim(),
                            artist: editArtist.trim(),
                            categoryId: editCategoryId,
                            practiceNotes: editNotes,
                          });
                          setEditingTrackId(null);
                        }}
                        className="space-y-2"
                      >
                        <div className="grid gap-2 sm:grid-cols-3">
                          <input
                            type="text"
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            aria-label="Edit track title"
                            className="h-8 rounded border border-stone-300 bg-white px-2 text-xs text-stone-900 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
                          />
                          <input
                            type="text"
                            value={editArtist}
                            onChange={(e) => setEditArtist(e.target.value)}
                            aria-label="Edit composer or artist"
                            className="h-8 rounded border border-stone-300 bg-white px-2 text-xs text-stone-900 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
                          />
                          <select
                            value={editCategoryId}
                            onChange={(e) => setEditCategoryId(e.target.value)}
                            aria-label="Edit track category"
                            className="h-8 rounded border border-stone-300 bg-white px-2 text-xs text-stone-900 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
                          >
                            {categories.map((cat) => (
                              <option key={cat.id} value={cat.id}>
                                {cat.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <input
                          type="text"
                          value={editNotes}
                          onChange={(e) => setEditNotes(e.target.value)}
                          placeholder="Practice notes"
                          aria-label="Edit practice notes"
                          className="h-8 w-full rounded border border-stone-300 bg-white px-2 text-xs text-stone-900 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
                        />
                        <div className="flex justify-end gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingTrackId(null)}
                          >
                            <X className="h-3.5 w-3.5" />
                            Cancel
                          </Button>
                          <Button type="submit" size="sm">
                            <Check className="h-3.5 w-3.5" />
                            Save Track
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-semibold text-stone-900 dark:text-[#F5F3FF] break-words">
                            {track.title}
                          </span>
                          <span className="inline-flex items-center rounded bg-stone-200/80 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-700 dark:bg-white/10 dark:text-slate-200">
                            {track.sourceType === "youtube" ? "YouTube" : "Project Audio"}
                          </span>
                          <span className="inline-flex rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-900 dark:bg-violet-500/20 dark:text-violet-300">
                            {catName}
                          </span>
                          {hasLoop && (
                            <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-300">
                              <Repeat className="h-2.5 w-2.5" />
                              A–B {formatDuration(track.loop.aSec!)}–{formatDuration(track.loop.bSec!)}
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-stone-600 dark:text-[#A1A1AA]">
                          {track.artist && <span>{track.artist}</span>}
                          {track.sourceType === "project_audio" && (
                            <span className="text-[11px]">
                              Source: {sourceProject?.title ?? track.projectTitle ?? "Project"}{" "}
                              {track.mediaFilename ? `• ${track.mediaFilename}` : ""}
                            </span>
                          )}
                          {track.sourceType === "youtube" && track.youtubeVideoId && (
                            <span className="font-mono text-[11px]">ID: {track.youtubeVideoId}</span>
                          )}
                        </div>

                        {projectUnavailable && (
                          <div
                            data-testid={`unavailable-project-${track.id}`}
                            className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
                          >
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            Source project is no longer available. You can keep notes or remove this entry.
                          </div>
                        )}

                        {track.practiceNotes && (
                          <p
                            data-testid={`track-notes-${track.id}`}
                            className="rounded-md border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-xs text-stone-800 dark:border-[#27273A] dark:bg-[#09090F] dark:text-slate-200"
                          >
                            {track.practiceNotes}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* Action Row */}
                {!isEditing && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 pt-2 dark:border-[#27273A]">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        data-testid={`play-track-btn-${track.id}`}
                        onClick={() => onPlayTrack(playlist.id, track.id)}
                      >
                        <Play className="h-3.5 w-3.5" />
                        {isActive && isPlaying ? "Playing" : "Play"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        data-testid={`transcribe-track-btn-${track.id}`}
                        onClick={() => onTranscribeTrack(track)}
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        Transcribe
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid={`playground-track-btn-${track.id}`}
                        onClick={() => onOpenInPlayground(track)}
                      >
                        <Piano className="h-3.5 w-3.5" />
                        Open in Playground
                      </Button>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Move ${track.title} up`}
                        disabled={originalIndex === 0}
                        onClick={() => onReorderTrack(playlist.id, originalIndex, originalIndex - 1)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded border border-stone-300 text-stone-600 hover:bg-stone-100 disabled:opacity-40 dark:border-[#27273A] dark:text-[#A1A1AA] dark:hover:bg-white/10"
                        title="Move Up"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${track.title} down`}
                        disabled={originalIndex === playlist.tracks.length - 1}
                        onClick={() => onReorderTrack(playlist.id, originalIndex, originalIndex + 1)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded border border-stone-300 text-stone-600 hover:bg-stone-100 disabled:opacity-40 dark:border-[#27273A] dark:text-[#A1A1AA] dark:hover:bg-white/10"
                        title="Move Down"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Edit ${track.title}`}
                        onClick={() => {
                          setEditingTrackId(track.id);
                          setEditTitle(track.title);
                          setEditArtist(track.artist);
                          setEditCategoryId(track.categoryId);
                          setEditNotes(track.practiceNotes);
                        }}
                        className="inline-flex h-7 w-7 items-center justify-center rounded border border-stone-300 text-stone-600 hover:bg-stone-100 dark:border-[#27273A] dark:text-[#A1A1AA] dark:hover:bg-white/10"
                        title="Edit track metadata"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${track.title} from playlist`}
                        onClick={() => onRemoveTrack(playlist.id, track.id)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded border border-stone-300 text-stone-600 hover:bg-red-50 hover:text-red-700 dark:border-[#27273A] dark:text-[#A1A1AA] dark:hover:bg-red-500/15 dark:hover:text-red-300"
                        title="Remove from playlist (keeps original project)"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
