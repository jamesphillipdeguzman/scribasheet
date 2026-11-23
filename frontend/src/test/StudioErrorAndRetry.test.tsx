import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { ApiError, api } from "@/services/api";
import type { Project, ProjectScoreResponse, TranscriptionJob } from "@/types/api";

vi.mock("@/features/auth/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    user: { id: "u1", email: "user@example.com", display_name: "James", is_unlimited: false },
    usage: {
      plan_tier: "pro",
      monthly_minutes_used: 10,
      monthly_minutes_limit: 120,
      project_count: 1,
      project_limit: 20,
      storage_used_mb: 5,
      storage_limit_mb: 500,
    },
    isLoading: false,
    logout: vi.fn(),
  }),
}));

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

const baseProject: Project = {
  id: "proj-1",
  user_id: "u1",
  title: "Amazing Grace",
  description: "",
  status: "failed",
  instrument: "piano",
  transcription_mode: "single_instrument",
  duration_seconds: 12,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  media_assets: [
    {
      id: "asset-orig-1",
      project_id: "proj-1",
      asset_type: "original",
      original_filename: "amazing_grace.wav",
      mime_type: "audio/wav",
      size_bytes: 1024,
      duration_seconds: 12,
      sample_rate: 44100,
      channels: 1,
      created_at: new Date().toISOString(),
    },
  ],
};

const failedJob: TranscriptionJob = {
  id: "job-failed-1",
  project_id: "proj-1",
  user_id: "u1",
  source_asset_id: "asset-orig-1",
  status: "failed",
  progress: 25,
  current_stage: "Failed",
  engine: "basic_pitch",
  settings_json: {
    instrument: "piano",
    mode: "single_instrument",
    arrangement_detail: "balanced",
    quantization: "sixteenth",
  } as TranscriptionJob["settings_json"],
  error_code: "MISSING_SOURCE_AUDIO",
  error_message: "Job has no source_download_url.",
  started_at: null,
  completed_at: null,
  created_at: new Date().toISOString(),
};

function renderStudio() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/projects/proj-1"]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ProjectStudioPage error contrast, fullscreen toggle, and Retry Job recovery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "getProject").mockResolvedValue(baseProject);
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([failedJob]);
  });

  it("renders Light Mode error contrast on workspace Retry Loading Score card and removes duplicate tab-bar Maximize button", async () => {
    vi.spyOn(api, "getScore").mockRejectedValueOnce(new ApiError(500, "Failed to fetch score"));

    renderStudio();

    const errorCard = await screen.findByTestId("workspace-score-error-card");
    expect(errorCard.className).toContain("bg-red-50");
    expect(errorCard.className).toContain("border-red-300");
    expect(errorCard.className).toContain("dark:bg-red-500/10");
    expect(errorCard.className).toContain("dark:border-red-500/30");

    const errorMsg = screen.getByText("Failed to fetch score");
    expect(errorMsg.className).toContain("text-red-900");
    expect(errorMsg.className).toContain("font-medium");
    expect(errorMsg.className).toContain("break-words");
    expect(errorMsg.className).toContain("dark:text-red-200");

    const retryLoadBtn = screen.getByRole("button", { name: "Retry Loading Score" });
    expect(retryLoadBtn.className).toContain("bg-white");
    expect(retryLoadBtn.className).toContain("text-red-900");
    expect(retryLoadBtn.className).toContain("border-red-300");
    expect(retryLoadBtn.className).toContain("font-semibold");
    expect(retryLoadBtn.className).toContain("dark:bg-white/10");
    expect(retryLoadBtn.className).toContain("dark:text-white");

    // Duplicate tab-bar Maximize button must not exist
    expect(screen.queryByTestId("workspace-focus-toggle")).toBeNull();
  });

  it("keeps single viewer fullscreen control when score is loaded", async () => {
    const scoreResp: ProjectScoreResponse = {
      id: "score-1",
      project_id: "proj-1",
      version: 1,
      updated_at: new Date().toISOString(),
      score_json: {
        title: "Amazing Grace",
        tempo_bpm: 100,
        tempo_estimated: false,
        key_signature: "C",
        key_signature_estimated: false,
        time_signature: "4/4",
        time_signature_estimated: false,
        duration_seconds: 4,
        tracks: [{ index: 0, name: "Piano", instrument: "piano", clef: "treble", program: 0, muted: false }],
        notes: [{ id: "n1", pitch_midi: 60, onset_sec: 0, offset_sec: 1, velocity: 80, track_index: 0 }],
        chords: [],
        analysis: { mode: "single_instrument" },
      },
      musicxml: "<score-partwise/>",
    };
    vi.spyOn(api, "getScore").mockResolvedValue(scoreResp);

    renderStudio();

    const maximizeButtons = await screen.findAllByRole("button", { name: "Maximize" });
    expect(maximizeButtons).toHaveLength(1);
    expect(screen.queryByTestId("workspace-focus-toggle")).toBeNull();

    fireEvent.click(maximizeButtons[0]);
    expect(screen.getByTestId("sheet-music-viewer").getAttribute("data-focus-mode")).toBe("true");
  });

  it("prevents duplicate Retry Job submissions and falls back to startTranscription if retryJob cannot recover source", async () => {
    vi.spyOn(api, "getScore").mockRejectedValue(new ApiError(404, "No score yet"));

    let resolveRetry!: (val: TranscriptionJob) => void;
    const retryPromise = new Promise<TranscriptionJob>((resolve) => {
      resolveRetry = resolve;
    });
    const retrySpy = vi.spyOn(api, "retryJob").mockReturnValueOnce(retryPromise);

    renderStudio();

    const retryBtn = await screen.findByRole("button", { name: /Retry Job/i });
    fireEvent.click(retryBtn);
    fireEvent.click(retryBtn);

    expect(retrySpy).toHaveBeenCalledTimes(1);

    resolveRetry({
      ...failedJob,
      id: "job-retried-1",
      status: "queued",
      progress: 0,
      current_stage: "Queued",
      error_message: null,
    });

    await waitFor(() => {
      expect(screen.getByText(/Transcription in progress/i)).toBeTruthy();
    });

    // Fallback test when retryJob fails with 400 missing source_download_url
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([failedJob]);
    const retryFallbackSpy = vi
      .spyOn(api, "retryJob")
      .mockRejectedValueOnce(new ApiError(400, "Job has no source_download_url."));
    const startSpy = vi.spyOn(api, "startTranscription").mockResolvedValueOnce({
      ...failedJob,
      id: "job-started-fallback",
      status: "queued",
      progress: 0,
      current_stage: "Queued",
      error_message: null,
    });

    renderStudio();
    const retryButtons = await screen.findAllByRole("button", { name: /Retry Job/i });
    fireEvent.click(retryButtons[retryButtons.length - 1]);

    await waitFor(() => {
      expect(retryFallbackSpy).toHaveBeenCalledWith("job-failed-1");
      expect(startSpy).toHaveBeenCalledWith(
        "proj-1",
        "asset-orig-1",
        expect.objectContaining({ instrument: "piano", mode: "single_instrument" }),
      );
    });
  });
});
