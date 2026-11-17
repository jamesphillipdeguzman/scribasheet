import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { WorkerStatusBadge } from "@/components/WorkerStatusBadge";
import { TranscriptionConfigPanel } from "@/features/transcription/TranscriptionConfigPanel";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { MediaUploader } from "@/features/uploads/MediaUploader";
import { WaveformPlayer } from "@/features/editor/WaveformPlayer";
import { api, ApiError } from "@/services/api";
import { midiToNoteName, formatDuration, formatBytes } from "@/lib/utils";
import { computePianoEnvelopeParams } from "@/features/editor/midiSynth";

vi.mock("@/features/auth/AuthContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/auth/AuthContext")>();
  return {
    ...actual,
    useAuth: () => ({
      user: { id: "u1", email: "test@example.com", display_name: "Tester", email_verified: true, plan_tier: "free", created_at: "", updated_at: "" },
      usage: null,
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      refreshUser: vi.fn(),
    }),
  };
});

describe("ScribaSheet Frontend", () => {
  it("renders landing page headline and primary CTA", () => {
    render(<App />);
    expect(screen.getByText(/Turn Any Performance Into Sheet Music/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Transcribing/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /See How It Works/i })).toBeInTheDocument();
  });

  it("formats musical pitch and media helpers accurately", () => {
    expect(midiToNoteName(60)).toBe("C4");
    expect(midiToNoteName(69)).toBe("A4");
    expect(formatDuration(125)).toBe("2:05");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("displays clear empty state when score does not exist yet (404)", async () => {
    vi.spyOn(api, "getProject").mockResolvedValueOnce({
      id: "p1",
      user_id: "u1",
      title: "test1",
      description: "",
      status: "draft",
      instrument: "piano",
      transcription_mode: "single_instrument",
      duration_seconds: 13.2,
      created_at: "",
      updated_at: "",
      media_assets: [],
    });
    vi.spyOn(api, "listTranscriptions").mockResolvedValueOnce([]);
    vi.spyOn(api, "getScore").mockRejectedValueOnce(new ApiError(404, "No transcription score exists yet for this project."));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/No Transcription Score Generated Yet/i)).toBeInTheDocument();
    });
  });

  it("renders application NotFoundPage for unknown routes", () => {
    window.history.pushState({}, "", "/non-existent-route-xyz");
    render(<App />);
    expect(screen.getByText(/Page Not Found/i)).toBeInTheDocument();
    window.history.pushState({}, "", "/");
  });

  it("computes velocity-sensitive piano envelope with sustain and damper release", () => {
    const soft = computePianoEnvelopeParams(60, 0.8, 40, 0.7);
    const loud = computePianoEnvelopeParams(60, 0.8, 100, 0.7);
    expect(loud.peakGain).toBeGreaterThan(soft.peakGain);
    expect(loud.filterCutoffHz).toBeGreaterThan(soft.filterCutoffHz);
    expect(soft.holdEndSec).toBeCloseTo(0.8, 3);
    expect(soft.sustainGain).toBeGreaterThan(soft.peakGain * 0.3);
    expect(soft.releaseSec).toBeGreaterThanOrEqual(0.14);
  });

  it("displays desktop worker offline status and waiting-for-worker queue choice", async () => {
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: false,
      status: "offline",
      last_seen_seconds: 120,
      worker_id: "win-desktop",
      active_job_count: 0,
      queue_depth: 1,
      freshness_threshold_seconds: 45,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <WorkerStatusBadge />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Desktop Worker Offline/i)).toBeInTheDocument();
      expect(screen.getByText(/1 queued/i)).toBeInTheDocument();
    });

    const onStart = vi.fn();
    const onCancel = vi.fn();
    render(
      <TranscriptionConfigPanel
        hasMedia={true}
        activeJob={null}
        workerOnline={false}
        defaultInstrument="piano"
        defaultMode="single_instrument"
        onStart={onStart}
        onCancel={onCancel}
        onRetry={vi.fn()}
        isStarting={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Start AI Transcription/i }));
    expect(screen.getByText(/Queue this song to transcribe automatically/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Queue for Later/i }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("renders waiting-for-worker state and cancel action for unclaimed queued jobs", () => {
    const onCancel = vi.fn();
    render(
      <TranscriptionConfigPanel
        hasMedia={true}
        workerOnline={false}
        activeJob={{
          id: "job-1",
          project_id: "p1",
          user_id: "u1",
          source_asset_id: "a1",
          status: "queued",
          progress: 0,
          current_stage: "Waiting for Desktop Worker",
          engine: "basic_pitch",
          settings_json: {
            mode: "single_instrument",
            instrument: "piano",
            tempo_mode: "auto",
            manual_tempo_bpm: null,
            time_signature: "auto",
            key_signature: "auto",
            concert_pitch_hz: 440,
            transpose_semitones: 0,
            quantization: "sixteenth",
            onset_threshold: 0.5,
            frame_threshold: 0.3,
            min_note_length_ms: 58,
            min_midi_pitch: 21,
            max_midi_pitch: 108,
            enable_source_separation: false,
          },
          error_code: null,
          error_message: null,
          started_at: null,
          completed_at: null,
          created_at: new Date().toISOString(),
          worker_online: false,
        }}
        defaultInstrument="piano"
        defaultMode="single_instrument"
        onStart={vi.fn()}
        onCancel={onCancel}
        onRetry={vi.fn()}
        isStarting={false}
      />
    );

    expect(screen.getByText(/Waiting for Desktop Worker/i)).toBeInTheDocument();
    expect(screen.getByText(/desktop transcription worker is currently offline/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledWith("job-1");
  });

  const sampleAsset = {
    id: "asset-1",
    project_id: "p1",
    asset_type: "original",
    original_filename: "piano-demo.wav",
    mime_type: "audio/wav",
    size_bytes: 204800,
    duration_seconds: 13.2,
    sample_rate: 44100,
    channels: 1,
    created_at: new Date().toISOString(),
  };

  it("renders accessible Remove button beside uploaded media and disables it while processing", () => {
    const { rerender } = render(
      <MediaUploader
        projectId="p1"
        existingAssets={[sampleAsset]}
        onUploadComplete={vi.fn()}
        isProcessing={false}
      />
    );
    const removeBtn = screen.getByRole("button", { name: /Remove uploaded media/i });
    expect(removeBtn).toBeInTheDocument();
    expect(removeBtn).toHaveAttribute("title", "Remove file");
    expect(removeBtn).not.toBeDisabled();

    rerender(
      <MediaUploader
        projectId="p1"
        existingAssets={[sampleAsset]}
        onUploadComplete={vi.fn()}
        isProcessing={true}
      />
    );
    expect(screen.getByRole("button", { name: /Remove uploaded media/i })).toBeDisabled();
  });

  it("prompts for confirmation before removing media when a score exists", async () => {
    const deleteSpy = vi.spyOn(api, "deleteMediaAsset").mockResolvedValueOnce(undefined);
    const onRemoved = vi.fn();

    render(
      <MediaUploader
        projectId="p1"
        existingAssets={[sampleAsset]}
        onUploadComplete={vi.fn()}
        onMediaRemoved={onRemoved}
        hasScore={true}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Remove uploaded media/i }));
    expect(
      screen.getByText(/Remove this audio file\? Your existing sheet music and transcription results will remain available\./i)
    ).toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(
      screen.queryByText(/Remove this audio file\? Your existing sheet music and transcription results will remain available\./i)
    ).not.toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Remove uploaded media/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove$/i }));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith("p1", "asset-1");
      expect(onRemoved).toHaveBeenCalledWith("asset-1");
    });
  });

  it("clears uploaded media card on removal and allows uploading a replacement file", async () => {
    vi.spyOn(api, "deleteMediaAsset").mockResolvedValueOnce(undefined);
    const replacementAsset = { ...sampleAsset, id: "asset-2", original_filename: "replacement.wav" };
    const uploadSpy = vi.spyOn(api, "uploadMedia").mockResolvedValueOnce(replacementAsset);
    const onRemoved = vi.fn();
    const onUploadComplete = vi.fn();

    const { rerender } = render(
      <MediaUploader
        projectId="p1"
        existingAssets={[sampleAsset]}
        onUploadComplete={onUploadComplete}
        onMediaRemoved={onRemoved}
        hasScore={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Remove uploaded media/i }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith("asset-1"));

    rerender(
      <MediaUploader
        projectId="p1"
        existingAssets={[]}
        onUploadComplete={onUploadComplete}
        onMediaRemoved={onRemoved}
        hasScore={false}
      />
    );
    expect(screen.queryByText("piano-demo.wav")).not.toBeInTheDocument();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const newFile = new File(["wavdata"], "replacement.wav", { type: "audio/wav" });
    fireEvent.change(fileInput, { target: { files: [newFile] } });

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledWith("p1", newFile, expect.any(Function), expect.any(AbortSignal));
      expect(onUploadComplete).toHaveBeenCalledWith(replacementAsset);
    });
  });

  it("retains uploaded media and shows error message when removal fails with 409", async () => {
    vi.spyOn(api, "deleteMediaAsset").mockRejectedValueOnce(
      new ApiError(409, "Cannot remove audio while a transcription job is queued or actively processing.")
    );
    const onRemoved = vi.fn();

    render(
      <MediaUploader
        projectId="p1"
        existingAssets={[sampleAsset]}
        onUploadComplete={vi.fn()}
        onMediaRemoved={onRemoved}
        hasScore={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Remove uploaded media/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /Cannot remove audio while a transcription job is queued or actively processing\./i
      );
    });
    expect(screen.getByText("piano-demo.wav")).toBeInTheDocument();
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("resets WaveformPlayer audio source and playhead when mediaAssetId becomes null", async () => {
    vi.spyOn(api, "getSignedMediaUrl").mockResolvedValue({ url: "/api/v1/uploads/asset-1/stream?sig=x&exp=999", expires_in: 300 });
    const onPlayheadChange = vi.fn();

    const { rerender } = render(
      <WaveformPlayer
        mediaAssetId="asset-1"
        notes={[]}
        tempoBpm={120}
        durationSeconds={10}
        playheadSec={2.5}
        onPlayheadChange={onPlayheadChange}
      />
    );

    await waitFor(() => {
      expect(api.getSignedMediaUrl).toHaveBeenCalledWith("asset-1");
    });

    rerender(
      <WaveformPlayer
        mediaAssetId={null}
        notes={[]}
        tempoBpm={120}
        durationSeconds={10}
        playheadSec={2.5}
        onPlayheadChange={onPlayheadChange}
      />
    );

    await waitFor(() => {
      expect(onPlayheadChange).toHaveBeenCalledWith(0);
    });
  });
});
