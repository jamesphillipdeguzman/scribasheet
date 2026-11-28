import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  CloudOff,
  Download,
  HardDrive,
  ListMusic,
  Loader2,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/Button";
import { ListeningPlayerPane } from "@/features/playlists/ListeningPlayerPane";
import { usePlaylists } from "@/features/playlists/PlaylistContext";
import { PlaylistImportExportModal } from "@/features/playlists/PlaylistImportExportModal";
import { PlaylistShareModal } from "@/features/playlists/PlaylistShareModal";
import { PlaylistSidebar } from "@/features/playlists/PlaylistSidebar";
import { downloadPlaylistsJson } from "@/features/playlists/playlistStorage";
import type { PlaylistHandoffState, PlaylistTrack } from "@/features/playlists/playlistTypes";
import { TrackQueuePane } from "@/features/playlists/TrackQueuePane";
import { api, ApiError } from "@/services/api";

export function PlaylistsPage() {
  const navigate = useNavigate();
  const {
    library,
    selectedPlaylistId,
    selectedPlaylist,
    setSelectedPlaylistId,
    storageNotice,
    dismissStorageNotice,
    syncStatus,
    lastSyncError,
    retrySyncNow,
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
    addTracksToPlaylist,
    updateTrack,
    reorderTrack,
    removeTrack,
    importLibrary,
    activeTrackId,
    isPlaying,
    playTrack,
    setMiniPlayerEnabled,
  } = usePlaylists();

  const [categoryFilter, setCategoryFilter] = useState("all");
  const [mobileTab, setMobileTab] = useState<"playlists" | "queue" | "player">("queue");
  const [showImportModal, setShowImportModal] = useState(false);
  const [sharingPlaylistId, setSharingPlaylistId] = useState<string | null>(null);
  const [handoffBusyTrackId, setHandoffBusyTrackId] = useState<string | null>(null);
  const [bannerStatus, setBannerStatus] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const handleExportJson = () => {
    try {
      const filename = downloadPlaylistsJson(library);
      setBannerStatus({ kind: "success", text: `Exported playlists to ${filename}.` });
    } catch {
      setBannerStatus({ kind: "error", text: "Unable to export playlists JSON file." });
    }
  };

  const handleTranscribeHandoff = (track: PlaylistTrack) => {
    const handoff: PlaylistHandoffState = {
      action: "transcribe",
      sourceType: track.sourceType,
      trackId: track.id,
      trackTitle: track.title,
      artist: track.artist,
      categoryId: track.categoryId,
      practiceNotes: track.practiceNotes,
      youtubeVideoId: track.youtubeVideoId,
      youtubeUrl: track.youtubeUrl,
      sourceProjectId: track.projectId,
      sourceMediaAssetId: track.mediaAssetId,
      sourceMediaFilename: track.mediaFilename,
    };

    if (track.sourceType === "project_audio" && track.projectId) {
      navigate(`/projects/${track.projectId}`, {
        state: { playlistHandoff: handoff },
      });
      return;
    }

    // YouTube source: open existing Dashboard New Transcription workflow prefilled cleanly (no fake auto-download)
    navigate("/dashboard", {
      state: { openNewTranscription: handoff },
    });
  };

  const handleOpenInPlayground = async (track: PlaylistTrack) => {
    setBannerStatus(null);
    setHandoffBusyTrackId(track.id);
    const handoff: PlaylistHandoffState = {
      action: "playground",
      sourceType: track.sourceType,
      trackId: track.id,
      trackTitle: track.title,
      artist: track.artist,
      categoryId: track.categoryId,
      practiceNotes: track.practiceNotes,
      youtubeVideoId: track.youtubeVideoId,
      youtubeUrl: track.youtubeUrl,
      sourceProjectId: track.projectId,
      sourceMediaAssetId: track.mediaAssetId,
      sourceMediaFilename: track.mediaFilename,
    };

    try {
      const created = await api.createPlaygroundProject({
        title: `${track.title} (Practice Playground)`.slice(0, 115),
        description: track.practiceNotes || "",
        key_signature: "C Major",
        time_signature: "4/4",
        tempo_bpm: 120,
        clef_mode: "grand",
        measures: 4,
      });
      navigate(`/projects/${created.id}`, {
        state: { playlistHandoff: handoff },
      });
    } catch (err) {
      setBannerStatus({
        kind: "error",
        text:
          err instanceof ApiError
            ? err.message
            : "Could not open a new MIDI Playground project.",
      });
    } finally {
      setHandoffBusyTrackId(null);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 space-y-5">
        {/* Page Header */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <ListMusic className="h-5 w-5 text-[#A78BFA]" />
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">
                Playlists &amp; Listening Library
              </h1>
              <span
                data-testid="playlists-sync-badge"
                title={lastSyncError || undefined}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
                  syncStatus === "pending"
                    ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
                    : "border-stone-300 bg-stone-100 text-stone-700 dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#A1A1AA]"
                }`}
              >
                {syncStatus === "syncing" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Syncing...
                  </>
                ) : syncStatus === "synced" ? (
                  <>
                    <Cloud className="h-3 w-3 text-emerald-500" />
                    Local + Cloud Synced
                  </>
                ) : syncStatus === "pending" ? (
                  <>
                    <CloudOff className="h-3 w-3 text-amber-500" />
                    Saved Locally • Sync Pending
                  </>
                ) : (
                  <>
                    <HardDrive className="h-3 w-3 text-[#A78BFA]" />
                    Local-First Storage
                  </>
                )}
              </span>
              {syncStatus === "pending" && (
                <button
                  type="button"
                  data-testid="retry-playlist-sync-btn"
                  onClick={() => void retrySyncNow()}
                  className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-white px-2.5 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-50 dark:border-amber-500/40 dark:bg-[#181825] dark:text-amber-200 dark:hover:bg-amber-500/20"
                >
                  <RefreshCw className="h-3 w-3" />
                  Retry Sync
                </button>
              )}
            </div>
            <p className="text-xs sm:text-sm text-stone-600 dark:text-[#A1A1AA]">
              Organize YouTube recordings and your ScribaSheet audio, practice with speed and A–B loops, and launch Studio workflows.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex h-9 items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 text-xs font-medium text-stone-800 dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF]">
              <input
                type="checkbox"
                checked={library.preferences.miniPlayerEnabled}
                onChange={(e) => setMiniPlayerEnabled(e.target.checked)}
                data-testid="mini-player-setting-toggle"
              />
              Persistent Mini-Player
            </label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleExportJson}
              data-testid="export-playlists-btn"
            >
              <Download className="h-3.5 w-3.5" />
              Export Playlists (.json)
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setShowImportModal(true)}
              data-testid="import-playlists-btn"
            >
              <Upload className="h-3.5 w-3.5" />
              Import Playlists (.json)
            </Button>
          </div>
        </div>

        {storageNotice && (
          <div
            role="alert"
            data-testid="playlists-storage-notice"
            className="flex items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
          >
            <span>{storageNotice}</span>
            <button
              type="button"
              onClick={dismissStorageNotice}
              aria-label="Dismiss storage notice"
              className="rounded p-1 hover:bg-black/10"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {bannerStatus && (
          <div
            role={bannerStatus.kind === "error" ? "alert" : "status"}
            data-testid="playlists-status-banner"
            className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
              bannerStatus.kind === "error"
                ? "border-red-300 bg-red-50 text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200"
                : "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200"
            }`}
          >
            <div className="flex items-center gap-2">
              {bannerStatus.kind === "error" ? (
                <AlertCircle className="h-4 w-4 shrink-0" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              )}
              <span>{bannerStatus.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setBannerStatus(null)}
              aria-label="Dismiss notification"
              className="rounded p-1 hover:bg-black/10"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {handoffBusyTrackId && (
          <div className="flex items-center gap-2 text-xs text-[#A78BFA]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Preparing MIDI Playground workspace...
          </div>
        )}

        {/* Mobile / Small Viewport Tabs */}
        <div className="flex lg:hidden rounded-xl border border-stone-300 bg-stone-100 p-1 text-xs dark:border-[#27273A] dark:bg-[#11111B]">
          {(
            [
              { id: "playlists", label: "Playlists" },
              { id: "queue", label: "Queue" },
              { id: "player", label: "Player" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setMobileTab(t.id)}
              className={`flex-1 rounded-lg py-1.5 font-medium transition-colors ${
                mobileTab === t.id
                  ? "bg-white text-stone-900 shadow-sm dark:bg-[#181825] dark:text-[#F5F3FF]"
                  : "text-stone-600 dark:text-[#A1A1AA]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 3-Area Practice Workspace */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-start">
          <div
            className={`lg:col-span-4 xl:col-span-3 min-w-0 ${
              mobileTab === "playlists" ? "block" : "hidden lg:block"
            }`}
          >
            <PlaylistSidebar
              categories={library.categories}
              playlists={library.playlists}
              selectedPlaylistId={selectedPlaylistId}
              activeCategoryFilter={categoryFilter}
              onCategoryFilterChange={setCategoryFilter}
              onSelectPlaylist={(id) => {
                setSelectedPlaylistId(id);
                setMobileTab("queue");
              }}
              onAddCategory={addCategory}
              onDeleteCategory={deleteCategory}
              onCreatePlaylist={(title, catId) => {
                createPlaylist(title, catId);
              }}
              onRenamePlaylist={renamePlaylist}
              onSetPlaylistCategory={setPlaylistCategory}
              onDuplicatePlaylist={duplicatePlaylist}
              onDeletePlaylist={deletePlaylist}
              onSharePlaylist={(id) => setSharingPlaylistId(id)}
            />
          </div>

          <div
            className={`lg:col-span-8 xl:col-span-5 min-w-0 ${
              mobileTab === "queue" ? "block" : "hidden lg:block"
            }`}
          >
            <TrackQueuePane
              playlist={selectedPlaylist}
              categories={library.categories}
              activeTrackId={activeTrackId}
              isPlaying={isPlaying}
              onAddTrack={addTrackToPlaylist}
              onAddTracks={addTracksToPlaylist}
              onNotify={(kind, text) => setBannerStatus({ kind, text })}
              onUpdateTrack={updateTrack}
              onReorderTrack={reorderTrack}
              onRemoveTrack={removeTrack}
              onPlayTrack={(plId, trId) => {
                void playTrack(plId, trId);
                setMobileTab("player");
              }}
              onTranscribeTrack={handleTranscribeHandoff}
              onOpenInPlayground={(tr) => void handleOpenInPlayground(tr)}
            />
          </div>

          <div
            className={`lg:col-span-12 xl:col-span-4 min-w-0 ${
              mobileTab === "player" ? "block" : "hidden lg:block"
            }`}
          >
            <ListeningPlayerPane />
          </div>
        </div>
      </div>

      <PlaylistImportExportModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onApplyImport={(incoming, mode) => {
          importLibrary(incoming, mode);
          setBannerStatus({
            kind: "success",
            text:
              mode === "replace"
                ? `Replaced playlist library (${incoming.playlists.length} playlists imported).`
                : `Safely merged ${incoming.playlists.length} imported playlists into your library.`,
          });
        }}
      />

      <PlaylistShareModal
        playlist={library.playlists.find((p) => p.id === sharingPlaylistId) ?? null}
        syncStatus={syncStatus}
        onClose={() => setSharingPlaylistId(null)}
        onUpdateDescription={updatePlaylistDescription}
        onEnableSharing={enablePlaylistSharing}
        onRegenerateSharing={regeneratePlaylistSharing}
        onDisableSharing={disablePlaylistSharing}
      />
    </AppShell>
  );
}
