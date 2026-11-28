import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { api, ApiError } from "@/services/api";
import type { Project, ProjectScoreResponse, ScoreData, ScoreRecoverResponse } from "@/types/api";

vi.mock("@/features/editor/SheetMusicViewer", async () => {
  const actual = await vi.importActual<typeof import("@/features/editor/SheetMusicViewer")>(
    "@/features/editor/SheetMusicViewer",
  );
  return {
    ...actual,
    SheetMusicViewer: ({ musicxml, scoreTitle }: { musicxml: string | null; scoreTitle?: string }) => (
      <div data-testid="mock-sheet-viewer" data-title={scoreTitle || ""}>
        {musicxml || "no-xml"}
      </div>
    ),
  };
});

const RECOVERED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Recovered Waltz</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>1</fifths><mode>major</mode></key>
        <time><beats>3</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

function makeScoreData(withNotes = true): ScoreData {
  return {
    title: "Recovered Waltz",
    tempo_bpm: 108,
    tempo_estimated: false,
    time_signature: "3/4",
    time_signature_estimated: false,
    key_signature: "G major",
    key_signature_estimated: false,
    duration_seconds: withNotes ? 2.5 : 0,
    tracks: [{ index: 0, name: "Piano", instrument: "piano", clef: "treble", program: 0, muted: false }],
    notes: withNotes
      ? [{ id: "n1", pitch_midi: 67, onset_sec: 0, offset_sec: 0.5, velocity: 85, track_index: 0 }]
      : [],
    chords: [],
    analysis: { source_type: "audio_transcription" },
  };
}

function makeProject(): Project {
  return {
    id: "proj-recover-1",
    user_id: "u1",
    title: "Recovered Waltz",
    description: "",
    instrument: "piano",
    transcription_mode: "single_instrument",
    status: "ready",
    duration_seconds: 2.5,
    created_at: "2026-11-28T00:00:00Z",
    updated_at: "2026-11-28T00:00:00Z",
    media_assets: [],
  };
}

function renderStudio(projectId = "proj-recover-1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[`/projects/${projectId}`]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("Studio Missing Score File One-Click Recovery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    try {
      window.localStorage.clear();
    } catch {
      // Ignore restricted storage in tests
    }

    vi.spyOn(api, "getLyrics").mockResolvedValue({ text: "", segments: [] } as never);
    vi.spyOn(api, "listExports").mockResolvedValue([]);
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 1,
      worker_id: "w-1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 30,
    });
    vi.spyOn(api, "getProject").mockResolvedValue(makeProject());
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows Rebuild & Save to Storage when MusicXML is missing, prevents duplicate clicks, and reloads SheetMusicViewer live", async () => {
    const missingRes: ProjectScoreResponse = {
      id: "score-1",
      project_id: "proj-recover-1",
      version: 3,
      score_json: makeScoreData(true),
      musicxml: null,
      updated_at: "2026-11-28T00:00:00Z",
    };
    vi.spyOn(api, "getScore").mockResolvedValue(missingRes);

    let resolveRecover!: (value: ScoreRecoverResponse) => void;
    const recoverSpy = vi.spyOn(api, "recoverScore").mockImplementation(
      () =>
        new Promise<ScoreRecoverResponse>((resolve) => {
          resolveRecover = resolve;
        }),
    );

    renderStudio();

    await waitFor(() => {
      expect(screen.getByText("Score File Missing from Storage")).toBeInTheDocument();
      expect(screen.getByTestId("rebuild-save-storage-btn")).toBeInTheDocument();
    });

    const rebuildBtn = screen.getByTestId("rebuild-save-storage-btn");
    fireEvent.click(rebuildBtn);
    fireEvent.click(rebuildBtn);

    expect(recoverSpy).toHaveBeenCalledTimes(1);
    expect(recoverSpy).toHaveBeenCalledWith("proj-recover-1", {
      create_blank_if_empty: false,
      expected_version: 3,
    });
    expect(screen.getByTestId("rebuild-save-storage-btn")).toBeDisabled();

    resolveRecover({
      status: "rebuilt_from_notes",
      message: "Rebuilt MusicXML from 1 saved note events and saved to storage.",
      note_count: 1,
      score: {
        id: "score-1",
        project_id: "proj-recover-1",
        version: 4,
        score_json: makeScoreData(true),
        musicxml: RECOVERED_XML,
        updated_at: "2026-11-28T00:05:00Z",
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("mock-sheet-viewer")).toBeInTheDocument();
      expect(screen.getByTestId("score-recovery-success")).toHaveTextContent(
        "Rebuilt MusicXML from 1 saved note events and saved to storage.",
      );
    });
    expect(screen.getByTestId("mock-sheet-viewer")).toHaveTextContent("<step>G</step>");
  });

  it("explains when no recoverable notes exist and offers explicit Create Blank Score recovery", async () => {
    vi.spyOn(api, "getScore").mockResolvedValue({
      id: "score-empty-1",
      project_id: "proj-recover-1",
      version: 1,
      score_json: makeScoreData(false),
      musicxml: null,
      updated_at: "2026-11-28T00:00:00Z",
    });

    const recoverSpy = vi
      .spyOn(api, "recoverScore")
      .mockResolvedValueOnce({
        status: "no_recoverable_notes",
        message: "No recoverable note events were found in this project's score record.",
        note_count: 0,
        score: null,
      })
      .mockResolvedValueOnce({
        status: "created_blank",
        message: "Created a blank MusicXML score matching this project's key, meter, and tempo, and saved it to storage.",
        note_count: 0,
        score: {
          id: "score-empty-1",
          project_id: "proj-recover-1",
          version: 2,
          score_json: makeScoreData(false),
          musicxml: RECOVERED_XML,
          updated_at: "2026-11-28T00:05:00Z",
        },
      });

    renderStudio();

    await waitFor(() => {
      expect(screen.getByTestId("rebuild-save-storage-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("rebuild-save-storage-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("score-recovery-empty-notice")).toHaveTextContent(
        "No recoverable note events were found",
      );
      expect(screen.getByTestId("create-blank-score-btn")).toBeInTheDocument();
    });

    // Must not switch away to SheetMusicViewer until user explicitly clicks Create Blank Score
    expect(screen.queryByTestId("mock-sheet-viewer")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("create-blank-score-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("mock-sheet-viewer")).toBeInTheDocument();
    });
    expect(recoverSpy).toHaveBeenNthCalledWith(1, "proj-recover-1", {
      create_blank_if_empty: false,
      expected_version: 1,
    });
    expect(recoverSpy).toHaveBeenNthCalledWith(2, "proj-recover-1", {
      create_blank_if_empty: true,
      expected_version: 1,
    });
  });

  it("preserves missing-file warning and shows clear error feedback when R2 upload fails", async () => {
    vi.spyOn(api, "getScore").mockResolvedValue({
      id: "score-err-1",
      project_id: "proj-recover-1",
      version: 2,
      score_json: makeScoreData(true),
      musicxml: null,
      updated_at: "2026-11-28T00:00:00Z",
    });

    vi.spyOn(api, "recoverScore").mockRejectedValueOnce(
      new ApiError(503, "Failed to store object in S3.", true),
    );

    renderStudio();

    await waitFor(() => {
      expect(screen.getByTestId("rebuild-save-storage-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("rebuild-save-storage-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("score-recovery-error")).toHaveTextContent(
        "Failed to store object in S3.",
      );
    });
    expect(screen.getByText("Score File Missing from Storage")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-sheet-viewer")).not.toBeInTheDocument();
  });
});
