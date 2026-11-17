import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportCenter } from "@/features/editor/ExportCenter";
import { api } from "@/services/api";

describe("ExportCenter Show Chord Symbols toggle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "listExports").mockResolvedValue([]);
    vi.spyOn(api, "downloadExportBlob").mockResolvedValue(undefined);
  });

  function renderExportCenter() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={qc}>
        <ExportCenter projectId="proj-1" projectTitle="Closer" hasScore={true} />
      </QueryClientProvider>,
    );
  }

  it("defaults to ON, toggles OFF/ON without re-transcribing, and sends include_chords on export", async () => {
    const createExportSpy = vi.spyOn(api, "createExport").mockResolvedValue({
      id: "exp-1",
      project_id: "proj-1",
      format: "pdf",
      status: "completed",
      error_message: null,
      download_url: "/api/v1/exports/exp-1/download",
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
    const startTranscriptionSpy = vi.spyOn(api, "startTranscription");

    renderExportCenter();

    const toggle = screen.getByRole("switch", { name: /show chord symbols/i });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    // Switch OFF -> must not trigger transcription
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(startTranscriptionSpy).not.toHaveBeenCalled();

    // Export PDF with toggle OFF
    fireEvent.click(screen.getByRole("button", { name: /export pdf/i }));
    await waitFor(() => {
      expect(createExportSpy).toHaveBeenCalledWith("proj-1", "pdf", { include_chords: false });
    });

    // Switch back ON and regenerate PDF
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: /export pdf/i }));
    await waitFor(() => {
      expect(createExportSpy).toHaveBeenCalledWith("proj-1", "pdf", { include_chords: true });
    });
    expect(startTranscriptionSpy).not.toHaveBeenCalled();
  });
});
