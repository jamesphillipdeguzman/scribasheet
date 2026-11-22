import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportCenter } from "@/features/editor/ExportCenter";
import { TranscriptionConfigPanel } from "@/features/transcription/TranscriptionConfigPanel";
import { api } from "@/services/api";

describe("SATB Score Import Config & Individual MP3 Exports", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("hides Demucs audio settings and shows Score Processing Mode for PDF/MXL/MusicXML files", () => {
    render(
      <TranscriptionConfigPanel
        hasMedia={true}
        isScoreFile={true}
        activeJob={null}
        defaultInstrument="vocals"
        defaultMode="satb_pdf"
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        isStarting={false}
      />,
    );

    expect(screen.getByLabelText("Score Processing Mode")).toBeInTheDocument();
    expect(screen.queryByLabelText("Separate Audio Stems (Demucs)")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Auto-Detect SATB/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Keep Original Staves/i })).toBeInTheDocument();
  });

  it("renders Soprano.mp3, Alto.mp3, Tenor.mp3, Bass.mp3 in ExportCenter for SATB scores", async () => {
    vi.spyOn(api, "listExports").mockResolvedValue([]);
    const createSpy = vi.spyOn(api, "createExport").mockResolvedValue({
      id: "exp-sop",
      project_id: "proj-satb",
      format: "soprano_mp3",
      status: "completed",
      error_message: null,
      download_url: "/api/v1/exports/exp-sop/download",
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
    const downloadSpy = vi.spyOn(api, "downloadExportBlob").mockResolvedValue();

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ExportCenter
          projectId="proj-satb"
          projectTitle="Choir Hymn"
          hasScore={true}
          isSatbScore={true}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Soprano.mp3")).toBeInTheDocument();
    expect(screen.getByText("Alto.mp3")).toBeInTheDocument();
    expect(screen.getByText("Tenor.mp3")).toBeInTheDocument();
    expect(screen.getByText("Bass.mp3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export Soprano" }));
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith("proj-satb", "soprano_mp3", { include_chords: true });
      expect(downloadSpy).toHaveBeenCalledWith("/api/v1/exports/exp-sop/download", "Soprano.mp3");
    });
  });
});
