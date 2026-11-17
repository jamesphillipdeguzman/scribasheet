import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { stripHarmonyFromMusicXml } from "@/features/editor/SheetMusicViewer";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { formatLocalDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import type { Project, ScoreData } from "@/types/api";

const sampleXml = `<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <harmony placement="above"><root><root-step>C</root-step></root><kind>major</kind></harmony>
      <direction><direction-type><words>legato</words></direction-type></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

const sampleScore: ScoreData = {
  title: "Test Score",
  tempo_bpm: 120,
  tempo_estimated: false,
  time_signature: "4/4",
  time_signature_estimated: false,
  key_signature: "C major",
  key_signature_estimated: false,
  duration_seconds: 2.0,
  tracks: [{ index: 0, name: "Piano", instrument: "piano", clef: "grand", program: 0, muted: false }],
  notes: [{ id: "n1", pitch_midi: 60, onset_sec: 0, offset_sec: 1, velocity: 80, track_index: 0 }],
  chords: [{ id: "c1", measure: 1, beat: 1, onset_sec: 0, symbol: "C", root: "C", quality: "major" }],
  analysis: {},
};

const baseProject: Project = {
  id: "proj-sync",
  user_id: "user-1",
  title: "Test Score",
  description: "",
  status: "ready",
  instrument: "piano",
  transcription_mode: "single_instrument",
  duration_seconds: 2,
  created_at: "2026-11-17T13:11:46Z",
  updated_at: "2026-11-17T13:11:46Z",
  media_assets: [],
};

describe("formatLocalDateTime & stripHarmonyFromMusicXml", () => {
  it("normalizes naive UTC, explicit Z, and explicit offsets consistently and handles invalid values", () => {
    const naive = formatLocalDateTime("2026-11-17T13:11:46");
    const explicitZ = formatLocalDateTime("2026-11-17T13:11:46Z");
    const explicitOffset = formatLocalDateTime("2026-11-17T21:11:46+08:00");

    expect(naive).not.toBe("—");
    expect(naive).toBe(explicitZ);
    expect(explicitOffset).toBe(explicitZ);

    expect(formatLocalDateTime(null)).toBe("—");
    expect(formatLocalDateTime(undefined)).toBe("—");
    expect(formatLocalDateTime("")).toBe("—");
    expect(formatLocalDateTime("not-a-date")).toBe("—");
  });

  it("strips only <harmony> elements while keeping notes and direction words", () => {
    const stripped = stripHarmonyFromMusicXml(sampleXml);
    expect(stripped).not.toContain("<harmony");
    expect(stripped).toContain("<words>legato</words>");
    expect(stripped).toContain("<note>");
  });
});

describe("Shared Studio showChordSymbols state across SheetMusicViewer and ExportCenter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(OpenSheetMusicDisplay.prototype, "render").mockImplementation(() => {});
    vi.spyOn(api, "getProject").mockResolvedValue({ ...baseProject });
    vi.spyOn(api, "getScore").mockResolvedValue({
      id: "score-1",
      project_id: "proj-sync",
      version: 1,
      score_json: sampleScore,
      musicxml: sampleXml,
      updated_at: "2026-11-17T13:11:46Z",
    });
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 1,
      worker_id: "win-local",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 60,
    });
    vi.spyOn(api, "listExports").mockResolvedValue([]);
    vi.spyOn(api, "downloadExportBlob").mockResolvedValue(undefined);
  });

  function renderStudio() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/projects/proj-sync"]}>
            <Routes>
              <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
  }

  it("synchronizes Chords toolbar toggle with ExportCenter and passes include_chords to PDF/MusicXML without re-transcription", async () => {
    const osmdLoadSpy = vi.spyOn(OpenSheetMusicDisplay.prototype, "load").mockResolvedValue({} as never);
    const createExportSpy = vi.spyOn(api, "createExport").mockResolvedValue({
      id: "exp-1",
      project_id: "proj-sync",
      format: "pdf",
      status: "completed",
      error_message: null,
      download_url: "/api/v1/exports/exp-1/download",
      created_at: "2026-11-17T13:11:46Z",
      completed_at: "2026-11-17T13:11:47Z",
    });
    const startTranscriptionSpy = vi.spyOn(api, "startTranscription");

    renderStudio();

    const chordsBtn = await screen.findByRole("button", { name: /show chord symbols/i });
    expect(chordsBtn).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(osmdLoadSpy).toHaveBeenCalled());

    // Disable Chords in viewer toolbar -> OSMD reloads without <harmony>
    fireEvent.click(chordsBtn);
    expect(chordsBtn).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => {
      const lastXml = osmdLoadSpy.mock.calls[osmdLoadSpy.mock.calls.length - 1][0] as string;
      expect(lastXml).not.toContain("<harmony");
    });

    // Switch to Exports tab -> Show Chord Symbols switch is also OFF
    fireEvent.click(screen.getByRole("tab", { name: /export center/i }));
    const exportSwitch = screen.getByRole("switch", { name: /show chord symbols/i });
    expect(exportSwitch).toHaveAttribute("aria-checked", "false");

    // Export PDF & MusicXML with chords OFF
    fireEvent.click(screen.getByRole("button", { name: /export pdf/i }));
    await waitFor(() =>
      expect(createExportSpy).toHaveBeenCalledWith("proj-sync", "pdf", { include_chords: false }),
    );
    fireEvent.click(screen.getByRole("button", { name: /export musicxml/i }));
    await waitFor(() =>
      expect(createExportSpy).toHaveBeenCalledWith("proj-sync", "musicxml", { include_chords: false }),
    );

    // Re-enable in ExportCenter -> viewer Chords button syncs back to ON
    fireEvent.click(exportSwitch);
    expect(exportSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("tab", { name: /sheet music/i }));
    expect(screen.getByRole("button", { name: /show chord symbols/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(startTranscriptionSpy).not.toHaveBeenCalled();
  });
});
