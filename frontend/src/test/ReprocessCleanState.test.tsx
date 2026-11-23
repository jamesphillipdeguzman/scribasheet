import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { midiSynth } from "@/features/editor/midiSynth";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { AuthProvider } from "@/features/auth/AuthContext";
import { api } from "@/services/api";
import type { Project, ProjectScoreResponse, ScoreData, TranscriptionJob, TranscriptionSettings } from "@/types/api";

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

const satbScore: ScoreData = {
  title: "Hymn",
  tempo_bpm: 100,
  tempo_estimated: false,
  key_signature: "C",
  key_signature_estimated: false,
  time_signature: "4/4",
  time_signature_estimated: false,
  duration_seconds: 4,
  tracks: [
    { index: 0, name: "Soprano", instrument: "piano", clef: "treble", program: 0, muted: false },
    { index: 1, name: "Alto", instrument: "piano", clef: "treble", program: 0, muted: false },
    { index: 2, name: "Tenor", instrument: "piano", clef: "bass", program: 0, muted: false },
    { index: 3, name: "Bass", instrument: "piano", clef: "bass", program: 0, muted: false },
  ],
  notes: [{ id: "old_n1", pitch_midi: 72, onset_sec: 0, offset_sec: 1, velocity: 85, track_index: 0 }],
  chords: [],
  analysis: { mode: "satb_pdf", job_id: "job-1" },
};

const melodyScore: ScoreData = {
  ...satbScore,
  tracks: [{ index: 0, name: "Melody", instrument: "piano", clef: "treble", program: 0, muted: false }],
  notes: [{ id: "new_n1", pitch_midi: 76, onset_sec: 0, offset_sec: 1, velocity: 90, track_index: 0 }],
  analysis: { mode: "melody_only", job_id: "job-3" },
};

const sampleProject: Project = {
  id: "proj-1",
  user_id: "user-1",
  title: "Hymn",
  description: "",
  instrument: "piano",
  transcription_mode: "satb_pdf",
  status: "completed",
  duration_seconds: 4,
  created_at: "2026-11-23T00:00:00Z",
  updated_at: "2026-11-23T00:00:00Z",
  media_assets: [
    {
      id: "asset-1",
      project_id: "proj-1",
      asset_type: "original",
      original_filename: "hymn.pdf",
      mime_type: "application/pdf",
      size_bytes: 1024,
      duration_seconds: 4,
      sample_rate: null,
      channels: null,
      created_at: "2026-11-23T00:00:00Z",
    },
  ],
};

function makeJob(overrides: Partial<TranscriptionJob>): TranscriptionJob {
  return {
    id: "job-1",
    project_id: "proj-1",
    user_id: "user-1",
    source_asset_id: "asset-1",
    status: "completed",
    progress: 100,
    current_stage: "Completed",
    engine: "omr",
    settings_json: { mode: "satb_pdf" } as unknown as TranscriptionSettings,
    error_code: null,
    error_message: null,
    started_at: null,
    completed_at: null,
    created_at: "2026-11-23T00:00:00Z",
    ...overrides,
  };
}

function renderStudio() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={["/projects/proj-1"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("Re-Processing Clean State & Stale Job Protection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "getProject").mockResolvedValue(sampleProject);
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      active_job_count: 0,
      queue_depth: 0,
      last_seen_seconds: 1,
      worker_id: "w1",
      freshness_threshold_seconds: 30,
    });
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([makeJob({ id: "job-1" })]);
  });

  it("clears previous SATB score, stops playback, ignores stale job-2, and loads only job-3 on completion", async () => {
    const stopSpy = vi.spyOn(midiSynth, "stop").mockImplementation(() => {});
    const getScoreSpy = vi
      .spyOn(api, "getScore")
      .mockResolvedValueOnce({
        id: "score-1",
        project_id: "proj-1",
        version: 1,
        score_json: satbScore,
        musicxml: "<score-partwise><part id='P1'><measure number='1'><note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration></note></measure></part></score-partwise>",
        updated_at: "2026-11-23T00:00:00Z",
      } as ProjectScoreResponse)
      .mockResolvedValueOnce({
        id: "score-1",
        project_id: "proj-1",
        version: 2,
        score_json: melodyScore,
        musicxml: "<score-partwise><part id='P1'><measure number='1'><note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration></note></measure></part></score-partwise>",
        updated_at: "2026-11-23T00:01:00Z",
      } as ProjectScoreResponse);

    const job2 = makeJob({
      id: "job-2",
      status: "separating",
      progress: 10,
      current_stage: "Separating old",
    });
    const job3 = makeJob({
      id: "job-3",
      status: "separating",
      progress: 35,
      current_stage: "Separating new",
      settings_json: { mode: "melody_only" } as unknown as TranscriptionSettings,
    });

    vi.spyOn(api, "startTranscription")
      .mockResolvedValueOnce(job2)
      .mockResolvedValueOnce(job3);

    vi.spyOn(api, "cancelJob").mockResolvedValueOnce(
      makeJob({ id: "job-2", status: "cancelled", progress: 10, current_stage: "Cancelled" }),
    );
    let resolveStaleGetJob!: (j: TranscriptionJob) => void;
    const staleGetJobPromise = new Promise<TranscriptionJob>((res) => {
      resolveStaleGetJob = res;
    });
    vi.spyOn(api, "getJob")
      .mockReturnValueOnce(staleGetJobPromise)
      .mockResolvedValue({ ...job3, status: "completed", progress: 100, current_stage: "Completed" });

    renderStudio();

    await waitFor(() => {
      expect(screen.getByText(/SATB Mixer & Practice Tracks/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Re-Process Score/i }));

    expect(stopSpy).toHaveBeenCalled();
    expect(screen.queryByText(/SATB Mixer & Practice Tracks/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("notation-processing-state")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getAllByText(/Separating old \(10%\)/i).length).toBeGreaterThan(0);
    });

    // Cancel job-2 and immediately start job-3
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Process Score/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Process Score/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/Separating new \(35%\)/i).length).toBeGreaterThan(0);
    });

    // Resolve stale job-2 poll as completed -> MUST be ignored!
    resolveStaleGetJob(makeJob({ id: "job-2", status: "completed", progress: 100, current_stage: "Completed" }));
    expect(getScoreSpy).toHaveBeenCalledTimes(1);
  });

  it("shows error state rather than restoring previous SATB score when a new job fails", async () => {
    vi.spyOn(api, "getScore").mockResolvedValueOnce({
      id: "score-1",
      project_id: "proj-1",
      version: 1,
      score_json: satbScore,
      musicxml: "<score-partwise><part id='P1'><measure number='1'><note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration></note></measure></part></score-partwise>",
      updated_at: "2026-11-23T00:00:00Z",
    } as ProjectScoreResponse);

    vi.spyOn(api, "startTranscription").mockResolvedValueOnce(
      makeJob({
        id: "job-fail",
        status: "failed",
        progress: 15,
        current_stage: "Failed",
        error_message: "OMR worker crashed",
      }),
    );

    renderStudio();

    await waitFor(() => {
      expect(screen.getByText(/SATB Mixer & Practice Tracks/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Re-Process Score/i }));

    await waitFor(() => {
      expect(screen.getByText(/OMR worker crashed/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/SATB Mixer & Practice Tracks/i)).not.toBeInTheDocument();
  });
});
