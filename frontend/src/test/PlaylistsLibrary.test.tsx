import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { PersistentMiniPlayer } from "@/features/playlists/PersistentMiniPlayer";
import { PlaylistProvider } from "@/features/playlists/PlaylistContext";
import { PlaylistsPage } from "@/features/playlists/PlaylistsPage";
import {
  applyImportedLibrary,
  buildPlaylistExportPayload,
  createDefaultLibrary,
  loadPlaylistLibrary,
  savePlaylistLibrary,
  validateAndParseImportJson,
} from "@/features/playlists/playlistStorage";
import { PLAYLISTS_STORAGE_KEY } from "@/features/playlists/playlistTypes";
import { resetYouTubeIframeApiForTests, YT_STATE } from "@/features/playlists/youtubeIframeApi";
import { extractYouTubeVideoId } from "@/features/playlists/youtubeUtils";
import { api } from "@/services/api";
import type { Project } from "@/types/api";

// Capture ProjectStudioPage handoff state in route tests without pulling full OSMD/WebAudio overhead
function MockStudioDestination() {
  const location = useLocation();
  const handoff = (location.state as { playlistHandoff?: Record<string, unknown> } | null)
    ?.playlistHandoff;
  return (
    <div data-testid="mock-studio-page">
      <div>Studio Destination</div>
      {handoff && (
        <div data-testid="studio-handoff-state">{JSON.stringify(handoff)}</div>
      )}
    </div>
  );
}

function makeStorageMock() {
  const store = new Map<string, string>();
  return {
    store,
    api: {
      getItem: vi.fn((k: string) => (store.has(k) ? store.get(k)! : null)),
      setItem: vi.fn((k: string, v: string) => {
        store.set(k, String(v));
      }),
      removeItem: vi.fn((k: string) => {
        store.delete(k);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
    },
  };
}

function makeProject(id: string, title: string, withAudio = true): Project {
  return {
    id,
    user_id: "u-1",
    title,
    description: "",
    status: "ready",
    instrument: "violin",
    transcription_mode: "violin_solo",
    duration_seconds: 120,
    created_at: "2026-11-28T00:00:00Z",
    updated_at: "2026-11-28T00:00:00Z",
    media_assets: withAudio
      ? [
          {
            id: `asset-${id}`,
            project_id: id,
            asset_type: "original",
            original_filename: `${title.toLowerCase().replace(/\s+/g, "-")}.mp3`,
            mime_type: "audio/mpeg",
            size_bytes: 102400,
            duration_seconds: 120,
            sample_rate: 44100,
            channels: 2,
            created_at: "2026-11-28T00:00:00Z",
          },
        ]
      : [],
  };
}

function renderPlaylistApp(initialRoute = "/playlists") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[initialRoute]}>
          <PlaylistProvider>
            <Routes>
              <Route path="/playlists" element={<PlaylistsPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/projects/:projectId" element={<MockStudioDestination />} />
            </Routes>
            <PersistentMiniPlayer />
          </PlaylistProvider>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("Playlists & Listening Library", () => {
  let storageMock: ReturnType<typeof makeStorageMock>;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetYouTubeIframeApiForTests();
    storageMock = makeStorageMock();
    storageMock.api.setItem("scribasheet_access_token", "fake-access-token");
    storageMock.api.setItem("scribasheet_refresh_token", "fake-refresh-token");
    Object.defineProperty(window, "localStorage", {
      value: storageMock.api,
      configurable: true,
      writable: true,
    });

    vi.spyOn(api, "getMe").mockResolvedValue({
      id: "u-1",
      email: "violinist@example.com",
      display_name: "Clara Violin",
      email_verified: true,
      plan_tier: "pro",
      created_at: "2026-11-28T00:00:00Z",
      updated_at: "2026-11-28T00:00:00Z",
    });
    vi.spyOn(api, "getUsage").mockResolvedValue({
      plan_tier: "pro",
      monthly_minutes_used: 12,
      monthly_minutes_limit: 300,
      project_count: 1,
      storage_used_mb: 10,
    });
    vi.spyOn(api, "getPlaylistLibrary").mockRejectedValue(new Error("Offline local-first test"));
    vi.spyOn(api, "syncPlaylistLibrary").mockRejectedValue(new Error("Offline local-first test"));
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 1,
      worker_id: "w-1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 30,
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { YT?: unknown }).YT;
    vi.restoreAllMocks();
  });

  it("extracts exact 11-char YouTube IDs across URL variants, strips radio/list params, and rejects invalid IDs", () => {
    const watch = extractYouTubeVideoId(
      "https://www.youtube.com/watch?v=6KaYzg0ebfE&list=RD6KaYzg0ebfE&index=3",
    );
    expect(watch.valid).toBe(true);
    if (watch.valid) {
      expect(watch.videoId).toBe("6KaYzg0ebfE");
      expect(watch.canonicalUrl).toBe("https://www.youtube.com/watch?v=6KaYzg0ebfE");
    }

    const shortUrl = extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=42&list=RDMM");
    expect(shortUrl.valid).toBe(true);
    if (shortUrl.valid) {
      expect(shortUrl.videoId).toBe("dQw4w9WgXcQ");
    }

    const embedUrl = extractYouTubeVideoId("https://www.youtube.com/embed/M7lc1UVf-VE");
    expect(embedUrl.valid).toBe(true);
    if (embedUrl.valid) {
      expect(embedUrl.videoId).toBe("M7lc1UVf-VE");
    }

    expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=tooshort").valid).toBe(false);
    expect(extractYouTubeVideoId("https://www.youtube.com/playlist?list=PL12345").valid).toBe(false);
    expect(extractYouTubeVideoId("https://vimeo.com/123456789").valid).toBe(false);
  });

  it("handles localStorage persistence, schema migration, malformed recovery, storage failure, and safe JSON export/import", () => {
    // 1. Recover cleanly from malformed JSON
    storageMock.store.set(PLAYLISTS_STORAGE_KEY, "{not-valid-json");
    const recovered = loadPlaylistLibrary();
    expect(recovered.recoveredFromError).toBeTruthy();
    expect(recovered.library.categories).toHaveLength(5);

    // 2. Migrate v0 / missing schemaVersion cleanly
    storageMock.store.set(
      PLAYLISTS_STORAGE_KEY,
      JSON.stringify({
        categories: [{ id: "cat-custom", name: "Fiddle Tunes", isDefault: false }],
        playlists: [
          {
            id: "pl-old",
            title: "Legacy List",
            categoryId: "cat-custom",
            tracks: [
              {
                id: "t-old",
                sourceType: "youtube",
                title: "Partita Reference",
                youtubeVideoId: "6KaYzg0ebfE",
                loop: { aSec: 50, bSec: 20 }, // Invalid inverted loop gets cleared safely
              },
            ],
          },
        ],
      }),
    );
    const migrated = loadPlaylistLibrary();
    expect(migrated.library.schemaVersion).toBe(1);
    expect(migrated.library.playlists[0].tracks[0].loop).toEqual({ aSec: 50, bSec: null });

    // 3. Notify gracefully on localStorage save error
    storageMock.api.setItem.mockImplementationOnce(() => {
      throw Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" });
    });
    const saveErr = savePlaylistLibrary(createDefaultLibrary());
    expect(saveErr.ok).toBe(false);
    expect(saveErr.error).toContain("quota");

    // 4. Portable JSON export excludes auth secrets/binaries; malformed import preserves existing state; merge renames conflicts safely
    const base = migrated.library;
    const exportObj = buildPlaylistExportPayload(base);
    const serialized = JSON.stringify(exportObj);
    expect(serialized).not.toContain("fake-access-token");

    const invalidImport = validateAndParseImportJson("{broken");
    expect(invalidImport.valid).toBe(false);

    const binaryImport = validateAndParseImportJson(
      JSON.stringify({
        schemaVersion: 1,
        playlists: [
          {
            title: "Bad",
            tracks: [
              {
                sourceType: "youtube",
                title: "Pic",
                youtubeVideoId: "dQw4w9WgXcQ",
                thumbnailUrl: "data:image/png;base64,AAAA",
              },
            ],
          },
        ],
      }),
    );
    expect(binaryImport.valid).toBe(false);

    const validImport = validateAndParseImportJson(serialized);
    expect(validImport.valid).toBe(true);
    if (validImport.valid) {
      const merged = applyImportedLibrary(base, validImport.library, "merge");
      expect(merged.playlists).toHaveLength(2);
      expect(merged.playlists[1].title).toBe("Legacy List (Imported)");
      expect(merged.playlists[1].id).not.toBe(merged.playlists[0].id);
    }
  });

  it("supports navigation, category filtering, playlist CRUD, YouTube fallback, Project Audio reference, reordering, and notes", async () => {
    const projects = [
      makeProject("proj-vln-1", "Mendelssohn E Minor", true),
    ];
    vi.spyOn(api, "listProjects").mockResolvedValue({
      items: projects,
      total: 1,
      page: 1,
      page_size: 100,
    });
    vi.spyOn(api, "checkExternalUrl").mockRejectedValueOnce(new Error("oEmbed network timeout"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("Offline")),
    );

    renderPlaylistApp("/dashboard");

    // Navigate via main nav Playlists link
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    const playlistsNavLink = within(nav).getByRole("link", { name: /Playlists/i });
    fireEvent.click(playlistsNavLink);

    await waitFor(() => {
      expect(screen.getByText(/Playlists & Listening Library/i)).toBeInTheDocument();
    });

    // Verify all 5 default categories exist
    expect(screen.getByTestId("category-pill-cat-classical-violin")).toBeInTheDocument();
    expect(screen.getByTestId("category-pill-cat-choral-satb")).toBeInTheDocument();
    expect(screen.getByTestId("category-pill-cat-piano-arrangements")).toBeInTheDocument();
    expect(screen.getByTestId("category-pill-cat-practice-reference")).toBeInTheDocument();
    expect(screen.getByTestId("category-pill-cat-sight-reading")).toBeInTheDocument();

    // Create custom category
    fireEvent.click(screen.getByTestId("new-category-btn"));
    fireEvent.change(screen.getByLabelText("Custom category name"), {
      target: { value: "Chamber Strings" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/i }));
    expect(screen.getByRole("button", { name: "Chamber Strings" })).toBeInTheDocument();

    // Create a playlist in Classical Violin
    fireEvent.click(screen.getByTestId("category-pill-cat-classical-violin"));
    fireEvent.click(screen.getByTestId("new-playlist-btn"));
    fireEvent.change(screen.getByLabelText("New playlist title"), {
      target: { value: "Violin Audition Prep" },
    });
    fireEvent.click(screen.getByTestId("confirm-create-playlist-btn"));

    await waitFor(() => {
      expect(screen.getByText("Violin Audition Prep")).toBeInTheDocument();
    });

    // Duplicate & Delete with confirmation
    fireEvent.click(screen.getByLabelText("Duplicate Violin Audition Prep"));
    expect(screen.getByText("Violin Audition Prep (Copy)")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Delete Violin Audition Prep (Copy)"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));
    expect(screen.queryByText("Violin Audition Prep (Copy)")).not.toBeInTheDocument();

    // Rename playlist inline
    fireEvent.click(screen.getByLabelText("Rename Violin Audition Prep"));
    fireEvent.change(screen.getByLabelText("Rename playlist Violin Audition Prep"), {
      target: { value: "Concerto Repertoire" },
    });
    fireEvent.click(screen.getByLabelText("Save playlist title"));
    expect(screen.getByText("Concerto Repertoire")).toBeInTheDocument();

    // Test invalid YouTube ID rejection
    fireEvent.change(screen.getByTestId("youtube-url-input"), {
      target: { value: "https://youtube.com/watch?v=bad" },
    });
    fireEvent.click(screen.getByTestId("fetch-youtube-meta-btn"));
    expect(screen.getByTestId("youtube-url-error")).toBeInTheDocument();

    // Valid YouTube URL with radio params, metadata fetch fails -> manual entry fallback still allows saving!
    fireEvent.change(screen.getByTestId("youtube-url-input"), {
      target: {
        value: "https://www.youtube.com/watch?v=6KaYzg0ebfE&list=RD6KaYzg0ebfE&start_radio=1",
      },
    });
    fireEvent.click(screen.getByTestId("fetch-youtube-meta-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("parsed-youtube-video-id")).toHaveTextContent("6KaYzg0ebfE");
      expect(screen.getByTestId("youtube-meta-fallback-notice")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("quick-add-title-input"), {
      target: { value: "Bach Chaconne Reference" },
    });
    fireEvent.change(screen.getByTestId("quick-add-artist-input"), {
      target: { value: "J.S. Bach" },
    });
    fireEvent.change(screen.getByTestId("quick-add-notes-input"), {
      target: { value: "Watch shift to 3rd position at 1:42" },
    });
    fireEvent.click(screen.getByTestId("add-track-submit-btn"));

    await waitFor(() => {
      expect(screen.getByText("Bach Chaconne Reference")).toBeInTheDocument();
      expect(screen.getByText("Watch shift to 3rd position at 1:42")).toBeInTheDocument();
    });

    // Duplicate YouTube track warning & safe confirmation
    fireEvent.change(screen.getByTestId("youtube-url-input"), {
      target: { value: "https://youtu.be/6KaYzg0ebfE" },
    });
    fireEvent.change(screen.getByTestId("quick-add-title-input"), {
      target: { value: "Bach Chaconne Reference" },
    });
    fireEvent.click(screen.getByTestId("add-track-submit-btn"));
    expect(screen.getByTestId("add-track-error")).toBeInTheDocument();

    // Switch to Project Audio tab and attach existing ScribaSheet project audio
    fireEvent.click(screen.getByTestId("quick-add-tab-project"));
    fireEvent.change(screen.getByTestId("quick-add-title-input"), {
      target: { value: "Mendelssohn Take 2" },
    });
    fireEvent.click(screen.getByTestId("add-track-submit-btn"));

    await waitFor(() => {
      expect(screen.getByText("Mendelssohn Take 2")).toBeInTheDocument();
    });

    // Reorder track 2 up above track 1
    fireEvent.click(screen.getByLabelText("Move Mendelssohn Take 2 up"));
    const cards = screen.getAllByTestId(/^track-card-/);
    expect(cards[0]).toHaveTextContent("Mendelssohn Take 2");
    expect(cards[1]).toHaveTextContent("Bach Chaconne Reference");

    // Search tracks by composer
    fireEvent.change(screen.getByTestId("track-search-input"), {
      target: { value: "Bach" },
    });
    expect(screen.getByText("Bach Chaconne Reference")).toBeInTheDocument();
    expect(screen.queryByText("Mendelssohn Take 2")).not.toBeInTheDocument();

    // Removing a track leaves original project intact (no deleteProject API call!)
    const deleteProjectSpy = vi.spyOn(api, "deleteProject");
    fireEvent.change(screen.getByTestId("track-search-input"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Remove Mendelssohn Take 2 from playlist"));
    expect(screen.queryByText("Mendelssohn Take 2")).not.toBeInTheDocument();
    expect(deleteProjectSpy).not.toHaveBeenCalled();

    // Reload recovery check from localStorage
    const savedRaw = storageMock.store.get(PLAYLISTS_STORAGE_KEY);
    expect(savedRaw).toContain("Bach Chaconne Reference");
  });

  it("controls YouTube IFrame & HTML5 audio playback, speeds, A-B looping, error handling, and single-instance mini-player", async () => {
    // Seed library with 1 YouTube track + 1 Project Audio track
    const seed = createDefaultLibrary();
    seed.playlists.push({
      id: "pl-play-1",
      title: "Practice Mix",
      categoryId: "cat-classical-violin",
      createdAt: "2026-11-28T00:00:00Z",
      updatedAt: "2026-11-28T00:00:00Z",
      tracks: [
        {
          id: "tr-yt-1",
          sourceType: "youtube",
          title: "Vivaldi Spring Allegro",
          artist: "Vivaldi",
          categoryId: "cat-classical-violin",
          thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
          practiceNotes: "",
          loop: { aSec: null, bSec: null },
          youtubeVideoId: "dQw4w9WgXcQ",
          youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          addedAt: "2026-11-28T00:00:00Z",
          updatedAt: "2026-11-28T00:00:00Z",
        },
        {
          id: "tr-proj-1",
          sourceType: "project_audio",
          title: "My Practice Recording",
          artist: "Clara",
          categoryId: "cat-practice-reference",
          thumbnailUrl: null,
          practiceNotes: "",
          loop: { aSec: null, bSec: null },
          projectId: "proj-vln-1",
          mediaAssetId: "asset-proj-vln-1",
          projectTitle: "Studio Vln",
          mediaFilename: "vln.mp3",
          mediaMimeType: "audio/mpeg",
          durationSec: 120,
          addedAt: "2026-11-28T00:00:00Z",
          updatedAt: "2026-11-28T00:00:00Z",
        },
      ],
    });
    storageMock.store.set(PLAYLISTS_STORAGE_KEY, JSON.stringify(seed));

    vi.spyOn(api, "listProjects").mockResolvedValue({
      items: [makeProject("proj-vln-1", "Studio Vln", true)],
      total: 1,
      page: 1,
      page_size: 100,
    });
    vi.spyOn(api, "getSignedMediaUrl").mockResolvedValue({
      url: "/api/v1/uploads/asset-proj-vln-1/stream?sig=ok&exp=999999",
      expires_in: 3600,
    });

    // Mock Audio element & YouTube IFrame API (supporting restricted speeds [0.5, 0.75, 1, 1.25])
    let audioCurrentTime = 0;
    const audioPlaySpy = vi.fn().mockResolvedValue(undefined);
    const audioPauseSpy = vi.fn();
    const audioInstance = {
      preload: "",
      src: "",
      currentTime: 0,
      duration: 120,
      playbackRate: 1,
      preservesPitch: true,
      play: audioPlaySpy,
      pause: audioPauseSpy,
      load: vi.fn(),
      removeAttribute: vi.fn(() => {
        audioInstance.src = "";
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(audioInstance, "currentTime", {
      get: () => audioCurrentTime,
      set: (val: number) => {
        audioCurrentTime = val;
      },
    });
    vi.stubGlobal(
      "Audio",
      vi.fn(() => audioInstance),
    );

    let ytCurrentTime = 12;
    const ytPlaySpy = vi.fn();
    const ytPauseSpy = vi.fn();
    const ytSeekSpy = vi.fn((sec: number) => {
      ytCurrentTime = sec;
    });
    const ytSetRateSpy = vi.fn();
    let ytCallbacks: {
      onReady?: (e: { target: unknown }) => void;
      onStateChange?: (e: { target: unknown; data: number }) => void;
      onError?: (e: { target: unknown; data: number }) => void;
    } = {};

    const ytPlayerMock = {
      playVideo: ytPlaySpy,
      pauseVideo: ytPauseSpy,
      stopVideo: vi.fn(),
      seekTo: ytSeekSpy,
      getCurrentTime: vi.fn(() => ytCurrentTime),
      getDuration: vi.fn(() => 180),
      setPlaybackRate: ytSetRateSpy,
      getAvailablePlaybackRates: vi.fn(() => [0.5, 0.75, 1, 1.25]),
      loadVideoById: vi.fn(),
      destroy: vi.fn(),
    };
    const ytConstructorSpy = vi.fn((_el: unknown, opts: { events?: typeof ytCallbacks }) => {
      ytCallbacks = opts.events || {};
      queueMicrotask(() => {
        ytCallbacks.onReady?.({ target: ytPlayerMock });
        ytCallbacks.onStateChange?.({ target: ytPlayerMock, data: YT_STATE.PLAYING });
      });
      return ytPlayerMock;
    });
    (window as unknown as { YT?: unknown }).YT = {
      Player: ytConstructorSpy,
      PlayerState: YT_STATE,
    };

    renderPlaylistApp("/playlists");

    // 1. Play YouTube track
    fireEvent.click(await screen.findByTestId("play-track-btn-tr-yt-1"));
    await waitFor(() => {
      expect(ytConstructorSpy).toHaveBeenCalledTimes(1);
    });

    // Select 0.85x speed -> YouTube adjusts honestly to 0.75x and informs user
    fireEvent.click(screen.getByTestId("speed-btn-0.85"));
    expect(ytSetRateSpy).toHaveBeenCalledWith(0.75);
    expect(screen.getByTestId("applied-speed-display")).toHaveTextContent("Active: 0.75x");
    expect(screen.getByTestId("speed-capability-notice")).toBeInTheDocument();

    // 2. A-B Loop validation & repeated loop seek back to A (not 0!)
    ytCurrentTime = 15;
    fireEvent.click(screen.getByTestId("loop-set-a-btn"));
    ytCurrentTime = 10; // Before A -> rejected cleanly
    fireEvent.click(screen.getByTestId("loop-set-b-btn"));
    expect(screen.getByTestId("loop-error-msg")).toBeInTheDocument();

    ytCurrentTime = 24; // Valid B > A
    fireEvent.click(screen.getByTestId("loop-set-b-btn"));
    expect(screen.getByTestId("active-loop-range")).toHaveTextContent("0:15");
    expect(screen.getByTestId("active-loop-range")).toHaveTextContent("0:24");

    // Advance YT time past B -> polling interval seeks to A (15), not 0!
    ytCurrentTime = 25;
    await waitFor(
      () => {
        expect(ytSeekSpy).toHaveBeenCalledWith(15, true);
      },
      { timeout: 1000 },
    );

    fireEvent.click(screen.getByTestId("loop-clear-btn"));
    expect(screen.queryByTestId("active-loop-range")).not.toBeInTheDocument();

    // 3. YouTube embed error (code 150) displays clear error state
    act(() => {
      ytCallbacks.onError?.({ target: ytPlayerMock, data: 150 });
    });
    expect(screen.getByTestId("player-error-alert")).toHaveTextContent(
      /does not allow embedding/i,
    );

    // 4. Next track -> switches cleanly to HTML5 Project Audio & supports exact 0.85x speed
    fireEvent.click(screen.getByTestId("player-next-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("project-audio-viewport")).toBeInTheDocument();
      expect(audioPlaySpy).toHaveBeenCalled();
    });
    expect(ytPauseSpy).toHaveBeenCalled();
    expect(screen.getByTestId("applied-speed-display")).toHaveTextContent("Active: 0.85x");
    expect(audioInstance.playbackRate).toBe(0.85);

    // 5. Enable persistent mini-player and navigate to Dashboard -> keeps same player, no duplicate YT.Player
    fireEvent.click(screen.getByTestId("mini-player-setting-toggle"));
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    fireEvent.click(within(nav).getByRole("link", { name: /Dashboard/i }));

    await waitFor(() => {
      expect(screen.getByTestId("persistent-mini-player")).toBeInTheDocument();
      expect(screen.getByTestId("persistent-mini-player")).toHaveTextContent(
        "My Practice Recording",
      );
    });
    expect(ytConstructorSpy).toHaveBeenCalledTimes(1);
  });

  it("hands off tracks cleanly to New Transcription (with honest YouTube limitation) and MIDI Playground", async () => {
    const seed = createDefaultLibrary();
    seed.playlists.push({
      id: "pl-handoff",
      title: "Handoff List",
      categoryId: "cat-classical-violin",
      createdAt: "2026-11-28T00:00:00Z",
      updatedAt: "2026-11-28T00:00:00Z",
      tracks: [
        {
          id: "tr-h-yt",
          sourceType: "youtube",
          title: "Paganini Caprice 24",
          artist: "Paganini",
          categoryId: "cat-classical-violin",
          thumbnailUrl: "https://i.ytimg.com/vi/6KaYzg0ebfE/hqdefault.jpg",
          practiceNotes: "Check left-hand pizzicato bar 18",
          loop: { aSec: null, bSec: null },
          youtubeVideoId: "6KaYzg0ebfE",
          youtubeUrl: "https://www.youtube.com/watch?v=6KaYzg0ebfE",
          addedAt: "2026-11-28T00:00:00Z",
          updatedAt: "2026-11-28T00:00:00Z",
        },
        {
          id: "tr-h-proj",
          sourceType: "project_audio",
          title: "Existing Violin Study",
          artist: "Student",
          categoryId: "cat-classical-violin",
          thumbnailUrl: null,
          practiceNotes: "Measure 12 intonation",
          loop: { aSec: null, bSec: null },
          projectId: "proj-existing-1",
          mediaAssetId: "asset-existing-1",
          projectTitle: "Existing Violin Study",
          mediaFilename: "study.wav",
          mediaMimeType: "audio/wav",
          durationSec: 45,
          addedAt: "2026-11-28T00:00:00Z",
          updatedAt: "2026-11-28T00:00:00Z",
        },
      ],
    });
    storageMock.store.set(PLAYLISTS_STORAGE_KEY, JSON.stringify(seed));

    vi.spyOn(api, "listProjects").mockResolvedValue({
      items: [makeProject("proj-existing-1", "Existing Violin Study", true)],
      total: 1,
      page: 1,
      page_size: 100,
    });
    const createProjectSpy = vi.spyOn(api, "createProject");
    const createPlaygroundSpy = vi
      .spyOn(api, "createPlaygroundProject")
      .mockResolvedValue(makeProject("pg-new-1", "Paganini Caprice 24 (Practice Playground)", false));

    // 1. Transcribe handoff for YouTube track -> Dashboard New Transcription modal prefilled, NOT auto-submitted
    renderPlaylistApp("/playlists");
    fireEvent.click(await screen.findByTestId("transcribe-track-btn-tr-h-yt"));

    await waitFor(() => {
      expect(screen.getByText("New Transcription Project")).toBeInTheDocument();
      expect(screen.getByDisplayValue("Paganini Caprice 24")).toBeInTheDocument();
      expect(screen.getByTestId("dashboard-playlist-handoff-notice")).toHaveTextContent(
        /YouTube URLs cannot be downloaded or transcribed automatically/i,
      );
    });
    expect(createProjectSpy).not.toHaveBeenCalled();

    cleanup();

    // 2. Open in Playground handoff -> creates Playground project cleanly and forwards handoff state
    renderPlaylistApp("/playlists");
    fireEvent.click(await screen.findByTestId("playground-track-btn-tr-h-proj"));

    await waitFor(() => {
      expect(createPlaygroundSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("mock-studio-page")).toBeInTheDocument();
      expect(screen.getByTestId("studio-handoff-state")).toHaveTextContent("Existing Violin Study");
      expect(screen.getByTestId("studio-handoff-state")).toHaveTextContent("Measure 12 intonation");
    });
  });
});
