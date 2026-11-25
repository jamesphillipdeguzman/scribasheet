import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import {
  ApiError,
  api,
  clearStoredTokens,
  getStoredTokens,
  resetAuthRefreshStateForTests,
  setStoredTokens,
} from "@/services/api";

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: function MockOSMD() {
    return {
      load: async () => undefined,
      render: () => undefined,
      Dispose: () => undefined,
      Zoom: 1,
      EngravingRules: { RenderChordSymbols: true },
      cursor: {
        cursorElement: document.createElement("img"),
        show: () => undefined,
        hide: () => undefined,
        reset: () => undefined,
        next: () => undefined,
        update: () => undefined,
        GNotesUnderCursor: () => [],
        iterator: { EndReached: true, currentTimeStamp: { RealValue: 0 } },
      },
      GraphicSheet: { MeasureList: [] },
    };
  },
}));

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
  vi.stubGlobal("localStorage", memoryStorage);
  return store;
}

function makeFakeJwt(expOffsetSec: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const payload = btoa(JSON.stringify({ sub: "u1", exp: Math.floor(Date.now() / 1000) + expOffsetSec }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${payload}.sig`;
}

describe("Authentication Refresh & Expiration Handling During Long-Running Polling", () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    resetAuthRefreshStateForTests();
  });

  afterEach(() => {
    resetAuthRefreshStateForTests();
    clearStoredTokens();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("deduplicates concurrent 401 polling requests into a single /auth/refresh and retries each once with fresh token", async () => {
    setStoredTokens("stale-access-token", "valid-refresh-token");

    let refreshCount = 0;
    const authHeadersSeen: Array<{ path: string; auth: string | null }> = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const auth = headers.get("Authorization");
      authHeadersSeen.push({ path: url, auth });

      if (url.endsWith("/auth/refresh")) {
        refreshCount += 1;
        // Simulate async flight so concurrent 401s overlap
        await new Promise((r) => setTimeout(r, 15));
        return new Response(
          JSON.stringify({
            access_token: "fresh-access-token",
            refresh_token: "fresh-refresh-token",
            token_type: "bearer",
            user: { id: "u1", email: "u@example.com", display_name: "U", plan_tier: "unlimited" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (auth !== "Bearer fresh-access-token") {
        return new Response(JSON.stringify({ detail: "Token expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/transcriptions/job-1")) {
        return new Response(
          JSON.stringify({ id: "job-1", project_id: "proj-1", status: "transcribing", progress: 72 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/projects/proj-1")) {
        return new Response(
          JSON.stringify({ id: "proj-1", title: "Test Song", status: "processing", media_assets: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/worker/status")) {
        return new Response(
          JSON.stringify({
            worker_online: true,
            status: "busy",
            last_seen_seconds: 4,
            worker_id: "win-1",
            active_job_count: 1,
            queue_depth: 0,
            freshness_threshold_seconds: 45,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [jobRes, projRes, workerRes] = await Promise.all([
      api.getJob("job-1"),
      api.getProject("proj-1"),
      api.getWorkerStatus(),
    ]);

    expect(refreshCount).toBe(1);
    expect(jobRes.progress).toBe(72);
    expect(projRes.title).toBe("Test Song");
    expect(workerRes.status).toBe("busy");
    expect(getStoredTokens()).toEqual({
      accessToken: "fresh-access-token",
      refreshToken: "fresh-refresh-token",
    });

    // Subsequent call uses dynamically updated token with zero extra refresh calls
    await api.getJob("job-1");
    expect(refreshCount).toBe(1);
    const lastCall = authHeadersSeen[authHeadersSeen.length - 1];
    expect(lastCall.auth).toBe("Bearer fresh-access-token");
  });

  it("preserves stored refresh token when /auth/refresh hits a transient 503 outage", async () => {
    setStoredTokens("stale-access-token", "valid-refresh-token");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        return new Response("Service Unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({ detail: "Token expired" }), { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getJob("job-1")).rejects.toMatchObject({ status: 503 });
    expect(getStoredTokens().refreshToken).toBe("valid-refresh-token");
  });

  it("recovers seamlessly in ProjectStudioPage after token expiration mid-transcription and loads final score", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const token1 = makeFakeJwt(3600);
    const token2 = makeFakeJwt(7200);
    setStoredTokens(token1, "refresh-1");

    let jobPollCount = 0;
    let refreshCount = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("Authorization");

      if (url.endsWith("/auth/refresh")) {
        refreshCount += 1;
        return new Response(
          JSON.stringify({
            access_token: token2,
            refresh_token: "refresh-2",
            token_type: "bearer",
            user: { id: "u1", email: "u@example.com", display_name: "U", plan_tier: "unlimited" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // After first poll begins, simulate token1 expiry on server
      if (url.endsWith("/transcriptions/job-long-1")) {
        jobPollCount += 1;
        if (auth === `Bearer ${token1}` && jobPollCount === 1) {
          return new Response(JSON.stringify({ detail: "Access token expired" }), { status: 401 });
        }
        if (auth !== `Bearer ${token2}`) {
          return new Response(JSON.stringify({ detail: "Unauthorized" }), { status: 401 });
        }
        return new Response(
          JSON.stringify({
            id: "job-long-1",
            project_id: "proj-long",
            user_id: "u1",
            source_asset_id: null,
            status: jobPollCount >= 3 ? "completed" : "transcribing",
            progress: jobPollCount >= 3 ? 100 : 80,
            current_stage: jobPollCount >= 3 ? "Completed" : "Generating Notation",
            engine: "vocal_pyin",
            settings_json: { mode: "melody" },
            error_code: null,
            error_message: null,
            started_at: new Date().toISOString(),
            completed_at: null,
            created_at: new Date().toISOString(),
            worker_online: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/users/me")) {
        return new Response(
          JSON.stringify({ id: "u1", email: "u@example.com", display_name: "U", plan_tier: "unlimited" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/users/me/usage")) {
        return new Response(
          JSON.stringify({
            plan_tier: "unlimited",
            monthly_minutes_used: 0,
            monthly_minutes_limit: 999,
            project_count: 1,
            project_limit: 999,
            storage_used_mb: 1,
            storage_limit_mb: 999,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/projects/proj-long")) {
        return new Response(
          JSON.stringify({
            id: "proj-long",
            user_id: "u1",
            title: "Na Para Bang",
            description: "",
            status: "processing",
            instrument: "piano",
            transcription_mode: "melody",
            duration_seconds: 12,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            media_assets: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/projects/proj-long/transcriptions")) {
        return new Response(
          JSON.stringify([
            {
              id: "job-long-1",
              project_id: "proj-long",
              user_id: "u1",
              source_asset_id: null,
              status: "transcribing",
              progress: 60,
              current_stage: "Transcribing Melody",
              engine: "vocal_pyin",
              settings_json: { mode: "melody" },
              error_code: null,
              error_message: null,
              started_at: new Date().toISOString(),
              completed_at: null,
              created_at: new Date().toISOString(),
              worker_online: true,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/worker/status")) {
        return new Response(
          JSON.stringify({
            worker_online: true,
            status: "busy",
            last_seen_seconds: 6,
            worker_id: "win-1",
            active_job_count: 1,
            queue_depth: 0,
            freshness_threshold_seconds: 45,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/projects/proj-long/lyrics")) {
        return new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });
      }
      if (url.endsWith("/projects/proj-long/score")) {
        expect(auth).toBe(`Bearer ${token2}`);
        return new Response(
          JSON.stringify({
            id: "score-long-1",
            project_id: "proj-long",
            version: 1,
            updated_at: new Date().toISOString(),
            score_json: {
              title: "Na Para Bang",
              tempo_bpm: 91,
              tempo_estimated: true,
              time_signature: "4/4",
              time_signature_estimated: false,
              key_signature: "F major",
              key_signature_estimated: true,
              duration_seconds: 12,
              tracks: [{ index: 0, name: "Lead Melody", instrument: "piano", clef: "treble", program: 0, muted: false }],
              notes: [{ id: "n1", pitch_midi: 69, onset_sec: 0, offset_sec: 0.5, velocity: 90, track_index: 0 }],
              chords: [],
              analysis: { mode: "melody", job_id: "job-long-1" },
            },
            musicxml: "<score-partwise/>",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/projects/proj-long"]}>
            <Routes>
              <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("notation-processing-state")).toBeInTheDocument();
    });

    // Poll 1 hits 401 -> refreshes transparently to token2 -> gets progress 80%
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(refreshCount).toBe(1);
    expect(screen.queryByTestId("auth-session-expired-banner")).toBeNull();
    expect(screen.queryByText(/Desktop Worker Offline/i)).toBeNull();

    // Poll 2 uses token2 -> gets 100% Completed -> loads F major score
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    await waitFor(() => {
      expect(screen.getByText(/Key: F major/i)).toBeInTheDocument();
    });
    expect(refreshCount).toBe(1);
  });

  it("handles unrecoverable session expiration explicitly without infinite retries or false Desktop Worker Offline badge", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiredAccess = makeFakeJwt(3600);
    setStoredTokens(expiredAccess, "revoked-refresh");

    let jobPollCalls = 0;
    let refreshCalls = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        return new Response(JSON.stringify({ detail: "Invalid or expired refresh token." }), { status: 401 });
      }
      if (url.endsWith("/transcriptions/job-exp-1")) {
        jobPollCalls += 1;
        return new Response(JSON.stringify({ detail: "Signature has expired" }), { status: 401 });
      }
      if (url.endsWith("/worker/status")) {
        return new Response(JSON.stringify({ detail: "Signature has expired" }), { status: 401 });
      }
      if (url.endsWith("/users/me")) {
        return new Response(
          JSON.stringify({ id: "u1", email: "u@example.com", display_name: "U", plan_tier: "unlimited" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/users/me/usage")) {
        return new Response(
          JSON.stringify({
            plan_tier: "unlimited",
            monthly_minutes_used: 0,
            monthly_minutes_limit: 999,
            project_count: 1,
            project_limit: 999,
            storage_used_mb: 1,
            storage_limit_mb: 999,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/projects/proj-exp")) {
        return new Response(
          JSON.stringify({
            id: "proj-exp",
            user_id: "u1",
            title: "Long Song",
            description: "",
            status: "processing",
            instrument: "piano",
            transcription_mode: "melody",
            duration_seconds: 120,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            media_assets: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/projects/proj-exp/transcriptions")) {
        return new Response(
          JSON.stringify([
            {
              id: "job-exp-1",
              project_id: "proj-exp",
              user_id: "u1",
              source_asset_id: null,
              status: "transcribing",
              progress: 60,
              current_stage: "Transcribing Melody",
              engine: "vocal_pyin",
              settings_json: { mode: "melody" },
              error_code: null,
              error_message: null,
              started_at: new Date().toISOString(),
              completed_at: null,
              created_at: new Date().toISOString(),
              worker_online: true,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/projects/proj-exp/lyrics")) {
        return new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/projects/proj-exp"]}>
            <Routes>
              <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("notation-processing-state")).toBeInTheDocument();
    });

    // Advance one poll cycle -> fails 401 + refresh 401 -> stops polling & shows clear auth banner
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    await waitFor(() => {
      expect(screen.getByTestId("auth-session-expired-banner")).toBeInTheDocument();
    });
    expect(screen.getByTestId("auth-session-expired-banner").textContent).toContain("session has expired");
    expect(screen.getByRole("link", { name: /Sign In Again/i })).toBeInTheDocument();

    // Active job status box is preserved rather than discarded
    expect(screen.getByTestId("notation-processing-state")).toBeInTheDocument();

    // WorkerStatusBadge separates auth expiration from Desktop Worker Offline state
    const badge = screen.getByText(/Worker status unavailable/i);
    expect(badge).toHaveAttribute("data-status", "unavailable");
    expect(badge).toHaveAttribute("title", expect.stringMatching(/HTTP 401/i));
    expect(screen.queryByText(/Desktop Worker Offline/i)).toBeNull();

    const pollsAtExpiry = jobPollCalls;
    const refreshesAtExpiry = refreshCalls;
    // Advance multiple cycles -> NO infinite 401 or refresh retries
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(jobPollCalls).toBe(pollsAtExpiry);
    expect(refreshCalls).toBe(refreshesAtExpiry);
    // ApiError import verified cleanly
    expect(new ApiError(401, "x").status).toBe(401);
  });
});
