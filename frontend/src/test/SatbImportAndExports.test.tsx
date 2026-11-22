import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportCenter } from "@/features/editor/ExportCenter";
import { WaveformPlayer } from "@/features/editor/WaveformPlayer";
import { TranscriptionConfigPanel } from "@/features/transcription/TranscriptionConfigPanel";
import { MediaUploader } from "@/features/uploads/MediaUploader";
import { api } from "@/services/api";
import type { MediaAsset } from "@/types/api";

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

describe("Dynamic Score vs Audio UI Controls", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const makeAsset = (overrides: Partial<MediaAsset>): MediaAsset => ({
    id: "asset-1",
    project_id: "proj-1",
    asset_type: "original",
    original_filename: "sample.wav",
    mime_type: "audio/wav",
    size_bytes: 2048,
    duration_seconds: 120,
    sample_rate: 44100,
    channels: 2,
    created_at: new Date().toISOString(),
    ...overrides,
  });

  it("Scenario 1: shows score labels and hides audio-only controls for PDF/MXL/MusicXML uploads", () => {
    const pdfAsset = makeAsset({
      original_filename: "choral-hymn.pdf",
      mime_type: "application/pdf",
      duration_seconds: null,
    });

    render(
      <>
        <MediaUploader
          projectId="proj-1"
          existingAssets={[pdfAsset]}
          onUploadComplete={vi.fn()}
        />
        <TranscriptionConfigPanel
          hasMedia={true}
          isScoreFile={true}
          activeJob={null}
          defaultInstrument="vocals"
          defaultMode="single_instrument"
          onStart={vi.fn()}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
          isStarting={false}
        />
        <WaveformPlayer
          mediaAssetId={null}
          isScoreOnly={true}
          notes={[]}
          durationSeconds={10}
          tempoBpm={120}
          playheadSec={0}
          onPlayheadChange={vi.fn()}
        />
      </>,
    );

    expect(screen.getByText("Uploaded Score")).toBeInTheDocument();
    expect(screen.queryByText("Uploaded Media")).not.toBeInTheDocument();
    expect(screen.queryByText(/Record Microphone/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/External Media URL/i)).not.toBeInTheDocument();

    expect(screen.getByLabelText("Score Processing Mode")).toBeInTheDocument();
    expect(screen.queryByLabelText("Output Arrangement")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Instrument")).not.toBeInTheDocument();
    expect(screen.queryByText("Tempo")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Quantization")).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /Original Audio/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Synthesized Score Playback/i })).toBeInTheDocument();
  });

  it("Scenario 2: shows audio controls for audio uploads and restores them when replacing score with audio", () => {
    const wavAsset = makeAsset({
      original_filename: "vocals.wav",
      mime_type: "audio/wav",
    });

    render(
      <MediaUploader
        projectId="proj-1"
        existingAssets={[wavAsset]}
        onUploadComplete={vi.fn()}
      />,
    );

    expect(screen.getByText("Uploaded Media")).toBeInTheDocument();
    expect(screen.getByText(/Record Microphone/i)).toBeInTheDocument();
    expect(screen.getByText(/External Media URL/i)).toBeInTheDocument();

    const { rerender } = render(
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

    expect(screen.queryByLabelText("Output Arrangement")).not.toBeInTheDocument();

    rerender(
      <TranscriptionConfigPanel
        hasMedia={true}
        isScoreFile={false}
        activeJob={null}
        defaultInstrument="vocals"
        defaultMode="satb_pdf"
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        isStarting={false}
      />,
    );

    expect(screen.getByLabelText("Output Arrangement")).toBeInTheDocument();
    expect(screen.getByLabelText("Instrument")).toBeInTheDocument();
    expect(screen.getByText("Tempo")).toBeInTheDocument();
    expect(screen.getByLabelText("Quantization")).toBeInTheDocument();
    expect(screen.getByLabelText("Separate Audio Stems (Demucs)")).toBeInTheDocument();
  });

  it("Scenario 3: retains audio upload options and transcription settings for empty projects", () => {
    render(
      <>
        <MediaUploader
          projectId="proj-1"
          existingAssets={[]}
          onUploadComplete={vi.fn()}
        />
        <TranscriptionConfigPanel
          hasMedia={false}
          isScoreFile={false}
          activeJob={null}
          defaultInstrument="vocals"
          defaultMode="single_instrument"
          onStart={vi.fn()}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
          isStarting={false}
        />
      </>,
    );

    expect(screen.getByText(/Record Microphone/i)).toBeInTheDocument();
    expect(screen.getByText(/External Media URL/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Output Arrangement")).toBeInTheDocument();
    expect(screen.getByLabelText("Instrument")).toBeInTheDocument();
    expect(screen.getByLabelText("Separate Audio Stems (Demucs)")).toBeInTheDocument();
  });
});
