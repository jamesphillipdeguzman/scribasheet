import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { PlaylistProvider } from "@/features/playlists/PlaylistContext";
import { PlaylistsPage } from "@/features/playlists/PlaylistsPage";
import { createDefaultLibrary } from "@/features/playlists/playlistStorage";
import { PLAYLISTS_STORAGE_KEY } from "@/features/playlists/playlistTypes";
import { PublicSharedPlaylistPage } from "@/features/playlists/PublicSharedPlaylistPage";
import { resetYouTubeIframeApiForTests, YT_STATE } from "@/features/playlists/youtubeIframeApi";
import { api, ApiError } from "@/services/api";

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

describe("Public Playlist Sharing (Account-Free Teacher Access)", () => {
  let storageMock: ReturnType<typeof makeStorageMock>;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetYouTubeIframeApiForTests();
    storageMock = makeStorageMock();
    Object.defineProperty(window, "localStorage", {
      value: storageMock.api,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { YT?: unknown }).YT;
    vi.restoreAllMocks();
  });

  it("renders a read-only shared playlist for unauthenticated visitors without redirecting to login and plays YouTube tracks", async () => {
    // No tokens stored — completely unauthenticated visitor
    vi.spyOn(api, "getPublicSharedPlaylist").mockResolvedValue({
      title: "Studio Repertoire: Baroque Violin",
      description: "Focus on clean double stops in bars 20-36.",
      categoryName: "Classical Violin",
      sharedAt: "2026-11-28T10:00:00Z",
      updatedAt: "2026-11-28T10:00:00Z",
      tracks: [
        {
          position: 1,
          title: "Bach Chaconne",
          artist: "Hilary Hahn",
          sourceType: "youtube",
          thumbnailUrl: "https://i.ytimg.com/vi/6KaYzg0ebfE/hqdefault.jpg",
          practiceNotes: "Watch shift to 3rd position at 1:42",
          loop: { aSec: 102, bSec: 118 },
          youtubeVideoId: "6KaYzg0ebfE",
          youtubeUrl: "https://www.youtube.com/watch?v=6KaYzg0ebfE",
          playablePublicly: true,
          unavailableReason: null,
        },
        {
          position: 2,
          title: "Private Student Runthrough",
          artist: "Student",
          sourceType: "project_audio",
          thumbnailUrl: null,
          practiceNotes: "Lesson 3 notes",
          loop: { aSec: null, bSec: null },
          youtubeVideoId: null,
          youtubeUrl: null,
          playablePublicly: false,
          unavailableReason: "Private ScribaSheet project audio files are kept private and are not exposed on public links.",
        },
      ],
    });

    const ytPlaySpy = vi.fn();
    const ytPlayerMock = {
      playVideo: ytPlaySpy,
      pauseVideo: vi.fn(),
      seekTo: vi.fn(),
      getCurrentTime: vi.fn(() => 102),
      getDuration: vi.fn(() => 240),
      setPlaybackRate: vi.fn(),
      getAvailablePlaybackRates: vi.fn(() => [0.5, 0.75, 1, 1.25]),
      loadVideoById: vi.fn(),
      destroy: vi.fn(),
    };
    const ytConstructorSpy = vi.fn((_el: unknown, opts: { events?: { onReady?: (e: { target: unknown }) => void } }) => {
      queueMicrotask(() => {
        opts.events?.onReady?.({ target: ytPlayerMock });
      });
      return ytPlayerMock;
    });
    (window as unknown as { YT?: unknown }).YT = {
      Player: ytConstructorSpy,
      PlayerState: YT_STATE,
    };

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/shared/playlist/teacher_token_abcdefghijklmnopqrst"]}>
            <Routes>
              <Route path="/shared/playlist/:shareToken" element={<PublicSharedPlaylistPage />} />
              <Route path="/login" element={<div data-testid="login-redirect-page">Login</div>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    // Must render public page without redirecting to /login
    expect(await screen.findByTestId("public-shared-playlist-page")).toBeInTheDocument();
    expect(screen.queryByTestId("login-redirect-page")).not.toBeInTheDocument();

    expect(screen.getByTestId("shared-readonly-badge")).toHaveTextContent("Read-Only Shared Playlist");
    expect(screen.getByTestId("shared-playlist-title")).toHaveTextContent("Studio Repertoire: Baroque Violin");
    expect(screen.getByTestId("shared-playlist-description")).toHaveTextContent("Focus on clean double stops in bars 20-36.");
    expect(screen.getByTestId("shared-playlist-category")).toHaveTextContent("Classical Violin");

    // Track 1 (YouTube) displays notes + loop timestamps; Track 2 (project_audio) stays private without play button
    expect(screen.getByText("Watch shift to 3rd position at 1:42")).toBeInTheDocument();
    expect(screen.getByTestId("shared-track-loop-0")).toHaveTextContent("1:42–1:58");
    expect(screen.getByTestId("shared-track-private-notice-1")).toHaveTextContent(/kept private/i);
    expect(screen.queryByTestId("shared-play-btn-1")).not.toBeInTheDocument();

    // No edit/rename/delete/add controls exist anywhere on the read-only page
    expect(screen.queryByRole("button", { name: /Delete|Rename|Add to Playlist|Disable Sharing/i })).not.toBeInTheDocument();

    // Visitor can play the YouTube track directly
    fireEvent.click(screen.getByTestId("shared-play-btn-0"));
    await waitFor(() => {
      expect(ytConstructorSpy).toHaveBeenCalledTimes(1);
      expect(ytPlaySpy).toHaveBeenCalled();
    });
  });

  it("shows clean unavailable state when a shared link token is invalid or revoked", async () => {
    vi.spyOn(api, "getPublicSharedPlaylist").mockRejectedValue(
      new ApiError(404, "Shared playlist not found or sharing has been disabled."),
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/shared/playlist/revoked_token_12345"]}>
          <Routes>
            <Route path="/shared/playlist/:shareToken" element={<PublicSharedPlaylistPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId("shared-playlist-error")).toHaveTextContent(
      /not found or sharing has been disabled/i,
    );
  });

  it("handles local-only sync requirement honestly and supports enable, copy, regenerate, and revoke in Share modal", async () => {
    storageMock.store.set("scribasheet_access_token", "owner-token");
    storageMock.store.set("scribasheet_refresh_token", "owner-refresh");

    const seed = createDefaultLibrary();
    seed.playlists.push({
      id: "pl-owner-1",
      title: "Choral SATB Assignment",
      description: "",
      categoryId: "cat-choral-satb",
      tracks: [],
      isShared: false,
      shareToken: null,
      sharedAt: null,
      createdAt: "2026-11-28T10:00:00Z",
      updatedAt: "2026-11-28T10:00:00Z",
    });
    storageMock.store.set(PLAYLISTS_STORAGE_KEY, JSON.stringify(seed));

    vi.spyOn(api, "getMe").mockResolvedValue({
      id: "owner-1",
      email: "owner@example.com",
      display_name: "Owner",
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
    vi.spyOn(api, "getPlaylistLibrary").mockRejectedValue(new Error("Local-only initially"));

    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextSpy },
      configurable: true,
    });

    const syncSpy = vi.spyOn(api, "syncPlaylistLibrary").mockRejectedValueOnce(new Error("Offline"));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
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

    // Playlist starts Private
    const shareBtn = await screen.findByTestId("share-playlist-btn-pl-owner-1");
    expect(screen.getByTestId("playlist-privacy-badge-pl-owner-1")).toHaveTextContent("Private");

    // 1. Open Share modal -> fails cleanly & honestly if backend sync is unavailable (no fake URL!)
    fireEvent.click(shareBtn);
    expect(screen.getByTestId("share-local-only-notice")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("enable-sharing-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("share-modal-error")).toHaveTextContent(
        /could not be synchronized to the backend server/i,
      );
      expect(screen.queryByTestId("public-share-url-input")).not.toBeInTheDocument();
    });

    // 2. Backend comes online -> sync succeeds & enables Public Link
    syncSpy.mockResolvedValue({
      schemaVersion: 1,
      updatedAt: "2026-11-28T10:00:00Z",
      categories: seed.categories,
      playlists: [
        {
          ...seed.playlists[0],
          serverId: "srv-owner-pl-1",
          isShared: false,
          shareToken: null,
        },
      ],
      preferences: seed.preferences as unknown as Record<string, unknown>,
    });
    vi.spyOn(api, "enablePlaylistShare").mockResolvedValue({
      playlistId: "pl-owner-1",
      serverId: "srv-owner-pl-1",
      isShared: true,
      shareToken: "tok_first_12345678901234567890",
      sharedAt: "2026-11-28T10:05:00Z",
    });

    fireEvent.click(screen.getByTestId("enable-sharing-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("share-status-pill")).toHaveTextContent("Public Link");
      expect(screen.getByTestId("public-share-url-input")).toHaveValue(
        `${window.location.origin}/shared/playlist/tok_first_12345678901234567890`,
      );
    });

    // 3. Copy Link
    fireEvent.click(screen.getByTestId("copy-share-link-btn"));
    expect(writeTextSpy).toHaveBeenCalledWith(
      `${window.location.origin}/shared/playlist/tok_first_12345678901234567890`,
    );

    // 4. Regenerate Link
    vi.spyOn(api, "regeneratePlaylistShare").mockResolvedValue({
      playlistId: "pl-owner-1",
      serverId: "srv-owner-pl-1",
      isShared: true,
      shareToken: "tok_regen_99999999999999999999",
      sharedAt: "2026-11-28T10:06:00Z",
    });
    fireEvent.click(screen.getByTestId("regenerate-share-link-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("public-share-url-input")).toHaveValue(
        `${window.location.origin}/shared/playlist/tok_regen_99999999999999999999`,
      );
    });

    // 5. Disable Sharing -> reverts cleanly to Private
    vi.spyOn(api, "disablePlaylistShare").mockResolvedValue({
      playlistId: "pl-owner-1",
      serverId: "srv-owner-pl-1",
      isShared: false,
      shareToken: null,
      sharedAt: null,
    });
    fireEvent.click(screen.getByTestId("disable-sharing-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("share-status-pill")).toHaveTextContent("Private");
      expect(screen.queryByTestId("public-share-url-input")).not.toBeInTheDocument();
      expect(screen.getByTestId("playlist-privacy-badge-pl-owner-1")).toHaveTextContent("Private");
    });
  });
});
