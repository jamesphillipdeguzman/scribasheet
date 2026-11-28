import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { PlaylistProvider } from "@/features/playlists/PlaylistContext";
import { PlaylistsPage } from "@/features/playlists/PlaylistsPage";
import { createDefaultLibrary } from "@/features/playlists/playlistStorage";
import { PLAYLISTS_STORAGE_KEY } from "@/features/playlists/playlistTypes";
import { api } from "@/services/api";

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

function renderPlaylists() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={["/playlists"]}>
          <PlaylistProvider>
            <Routes>
              <Route path="/playlists" element={<PlaylistsPage />} />
            </Routes>
          </PlaylistProvider>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("Playlist Track Addition, Batch YouTube URLs & Local-First Cloud Sync", () => {
  let storageMock: ReturnType<typeof makeStorageMock>;

  beforeEach(() => {
    vi.restoreAllMocks();
    storageMock = makeStorageMock();
    storageMock.api.setItem("scribasheet_access_token", "auth-token");
    storageMock.api.setItem("scribasheet_refresh_token", "refresh-token");
    Object.defineProperty(window, "localStorage", {
      value: storageMock.api,
      configurable: true,
      writable: true,
    });

    vi.spyOn(api, "getMe").mockResolvedValue({
      id: "user-1",
      email: "violinist@example.com",
      display_name: "Violinist",
      email_verified: true,
      plan_tier: "pro",
      created_at: "2026-11-28T00:00:00Z",
      updated_at: "2026-11-28T00:00:00Z",
    });
    vi.spyOn(api, "getUsage").mockResolvedValue({
      plan_tier: "pro",
      monthly_minutes_used: 0,
      monthly_minutes_limit: 300,
      project_count: 0,
      storage_used_mb: 0,
    });
    vi.spyOn(api, "listProjects").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 100,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("1 & 5 & 6 & 7 & 8: adds one YouTube track immediately locally even when sync fails, survives reload, and retries sync cleanly without duplication", async () => {
    // Seed named playlist starting at 0 tracks
    const seed = createDefaultLibrary();
    seed.playlists.push({
      id: "pl-classical-main",
      title: "My Favorite Classical Music and Violin Concerto",
      categoryId: "cat-classical-violin",
      tracks: [],
      createdAt: "2026-11-28T00:00:00Z",
      updatedAt: "2026-11-28T00:00:00Z",
    });
    storageMock.store.set(PLAYLISTS_STORAGE_KEY, JSON.stringify(seed));

    vi.spyOn(api, "getPlaylistLibrary").mockResolvedValue({
      schemaVersion: 1,
      updatedAt: "2026-11-28T00:00:00Z",
      categories: seed.categories,
      playlists: [seed.playlists[0] as unknown as Record<string, unknown>],
      preferences: seed.preferences as unknown as Record<string, unknown>,
    });
    const syncSpy = vi
      .spyOn(api, "syncPlaylistLibrary")
      .mockRejectedValueOnce(new Error("503 Service Unavailable"));

    vi.spyOn(api, "checkExternalUrl").mockResolvedValue({
      supported: false,
      is_youtube: true,
      video_id: "6KaYzg0ebfE",
      title: "Bach Chaconne - Violin Solo",
      author_name: "Hilary Hahn",
      thumbnail_url: "https://i.ytimg.com/vi/6KaYzg0ebfE/hqdefault.jpg",
      reason: "DRM",
    });

    const firstRender = renderPlaylists();

    const sidebarCard = await screen.findByTestId("playlist-card-pl-classical-main");
    expect(within(sidebarCard).getByText("0 tracks")).toBeInTheDocument();

    // Protocol-less URL with extra whitespace still fetches metadata AND submits cleanly
    fireEvent.change(screen.getByTestId("youtube-url-input"), {
      target: { value: "  youtu.be/6KaYzg0ebfE?list=RD6KaYzg0ebfE  " },
    });
    fireEvent.click(screen.getByTestId("fetch-youtube-meta-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-add-title-input")).toHaveValue("Bach Chaconne - Violin Solo");
    });

    fireEvent.click(screen.getByTestId("add-track-submit-btn"));

    // Immediately updates queue, sidebar count ("1 track"), feedback, and localStorage BEFORE sync resolves
    await waitFor(() => {
      expect(screen.getByTestId("add-track-feedback")).toHaveTextContent(
        /Added "Bach Chaconne - Violin Solo"/i,
      );
      expect(within(screen.getByTestId("playlist-card-pl-classical-main")).getByText("1 track")).toBeInTheDocument();
      expect(within(screen.getByTestId("track-queue-list")).getByText("Bach Chaconne - Violin Solo")).toBeInTheDocument();
    });

    const persistedAfterAdd = JSON.parse(storageMock.store.get(PLAYLISTS_STORAGE_KEY)!);
    expect(persistedAfterAdd.playlists[0].tracks).toHaveLength(1);
    expect(persistedAfterAdd.playlists[0].tracks[0].youtubeVideoId).toBe("6KaYzg0ebfE");

    // Failed backend sync shows honest Pending status (NEVER false "Local + Cloud Synced")
    await waitFor(() => {
      expect(screen.getByTestId("playlists-sync-badge")).toHaveTextContent("Saved Locally • Sync Pending");
      expect(screen.getByTestId("retry-playlist-sync-btn")).toBeInTheDocument();
    });

    // Simulate page refresh / remount: stale server (0 tracks) MUST NOT wipe out locally added track
    firstRender.unmount();

    syncSpy.mockImplementation(async (payload) => ({
      schemaVersion: 1,
      updatedAt: "2026-11-28T01:00:00Z",
      categories: payload.categories,
      playlists: (payload.playlists as Array<Record<string, unknown>>).map((p) => ({
        ...p,
        serverId: "srv-classical-main",
      })),
      preferences: payload.preferences,
    }));

    renderPlaylists();

    await waitFor(() => {
      expect(
        within(screen.getByTestId("track-queue-list")).getByText("Bach Chaconne - Violin Solo"),
      ).toBeInTheDocument();
      expect(
        within(screen.getByTestId("playlist-card-pl-classical-main")).getByText("1 track"),
      ).toBeInTheDocument();
    });

    // Pending changes sync back cleanly without duplicating the track
    await waitFor(() => {
      expect(syncSpy).toHaveBeenCalled();
      expect(screen.getByTestId("playlists-sync-badge")).toHaveTextContent("Local + Cloud Synced");
    });
    expect(screen.getAllByTestId(/^track-card-/)).toHaveLength(1);
  });

  it("2, 3, 4 & 9: adds 3 valid YouTube URLs in one paste (watch, youtu.be, shorts), handles invalid IDs + duplicates, and preserves existing tracks", async () => {
    const seed = createDefaultLibrary();
    seed.playlists.push({
      id: "pl-batch-1",
      title: "Etude Queue",
      categoryId: "cat-classical-violin",
      tracks: [
        {
          id: "tr-existing",
          sourceType: "youtube",
          title: "Existing Track",
          artist: "Vivaldi",
          categoryId: "cat-classical-violin",
          thumbnailUrl: "https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg",
          practiceNotes: "",
          loop: { aSec: null, bSec: null },
          youtubeVideoId: "M7lc1UVf-VE",
          youtubeUrl: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
          addedAt: "2026-11-28T00:00:00Z",
          updatedAt: "2026-11-28T00:00:00Z",
        },
      ],
      createdAt: "2026-11-28T00:00:00Z",
      updatedAt: "2026-11-28T00:00:00Z",
    });
    storageMock.store.set(PLAYLISTS_STORAGE_KEY, JSON.stringify(seed));

    vi.spyOn(api, "getPlaylistLibrary").mockRejectedValue(new Error("Offline"));
    vi.spyOn(api, "syncPlaylistLibrary").mockResolvedValue({
      schemaVersion: 1,
      updatedAt: "2026-11-28T00:00:00Z",
      categories: seed.categories,
      playlists: [],
      preferences: {},
    });

    vi.spyOn(api, "checkExternalUrl").mockImplementation(async (url: string) => {
      if (url.includes("6KaYzg0ebfE")) {
        return {
          supported: false,
          is_youtube: true,
          video_id: "6KaYzg0ebfE",
          title: "Bach Chaconne",
          author_name: "Hahn",
          reason: "DRM",
        };
      }
      if (url.includes("dQw4w9WgXcQ")) {
        return {
          supported: false,
          is_youtube: true,
          video_id: "dQw4w9WgXcQ",
          title: "Concerto No. 1",
          author_name: "Menuhin",
          reason: "DRM",
        };
      }
      return {
        supported: false,
        is_youtube: true,
        video_id: "kXYiU_JCYtU",
        title: "Short Violin Etude",
        author_name: "Perlman",
        reason: "DRM",
      };
    });

    renderPlaylists();
    await screen.findByTestId("playlist-card-pl-batch-1");

    // Mix newlines, spaces, commas, watch?v=, youtu.be, /shorts/, 1 duplicate inside batch, 1 invalid ID
    fireEvent.change(screen.getByTestId("youtube-url-input"), {
      target: {
        value: [
          "https://www.youtube.com/watch?v=6KaYzg0ebfE&list=RD6KaYzg0ebfE",
          "https://youtu.be/dQw4w9WgXcQ, https://www.youtube.com/shorts/kXYiU_JCYtU",
          "https://youtu.be/6KaYzg0ebfE",
          "https://www.youtube.com/watch?v=badid",
        ].join("\n"),
      },
    });

    // Dynamic button shows 3 valid tracks ready to add
    const submitBtn = screen.getByTestId("add-track-submit-btn");
    expect(submitBtn).toHaveTextContent("Add 3 Tracks to Playlist");

    // Batch preview + invalid/duplicate warning shown without blocking valid URLs
    const preview = screen.getByTestId("youtube-batch-preview");
    expect(preview).toHaveTextContent("Detected YouTube Batch (3 videos)");
    expect(screen.getByTestId("youtube-batch-warnings")).toHaveTextContent(/badid/);
    expect(screen.getByTestId("youtube-batch-warnings")).toHaveTextContent(/Deduplicated 1/);

    // Fetch metadata concurrently for all 3 valid URLs before adding
    fireEvent.click(screen.getByTestId("fetch-youtube-meta-btn"));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Bach Chaconne")).toBeInTheDocument();
      expect(screen.getByDisplayValue("Concerto No. 1")).toBeInTheDocument();
      expect(screen.getByDisplayValue("Short Violin Etude")).toBeInTheDocument();
    });

    // Add all 3 in a single submission; existing track remains intact (1 + 3 = 4 tracks)
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByTestId("add-track-feedback")).toHaveTextContent(/Added 3 tracks/i);
      expect(within(screen.getByTestId("playlist-card-pl-batch-1")).getByText("4 tracks")).toBeInTheDocument();
      expect(screen.getByText("Existing Track")).toBeInTheDocument();
      expect(screen.getByText("Bach Chaconne")).toBeInTheDocument();
      expect(screen.getByText("Concerto No. 1")).toBeInTheDocument();
      expect(screen.getByText("Short Violin Etude")).toBeInTheDocument();
    });

    // Pasting the already-present video ID alongside a new valid one skips duplicate cleanly
    fireEvent.change(screen.getByTestId("youtube-url-input"), {
      target: { value: "https://youtu.be/M7lc1UVf-VE https://youtu.be/oHg5SJYRHA0" },
    });
    expect(screen.getByTestId("add-track-submit-btn")).toHaveTextContent("Add 1 Track to Playlist");
  });
});
