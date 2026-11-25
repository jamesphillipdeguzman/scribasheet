import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WaveSurfer from "wavesurfer.js";
import { WorkerControlPanel } from "@/components/WorkerControlPanel";
import { WorkerStatusBadge } from "@/components/WorkerStatusBadge";
import { AuthProvider } from "@/features/auth/AuthContext";
import {
  decodeAudioBufferFromUrl,
  encodePcm16Wav,
  parseWavHeader,
  sliceAudioBuffer,
} from "@/features/editor/audioTrim";
import { WaveformPlayer } from "@/features/editor/WaveformPlayer";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { resetWorkerConnectionState } from "@/features/worker/useWorkerConnection";
import { api, ApiError } from "@/services/api";
import { workerController } from "@/services/workerController";
import type { Project, ProjectScoreResponse, TranscriptionJob, WorkerStatus } from "@/types/api";

vi.mock("wavesurfer.js", () => ({
  default: {
    create: vi.fn(),
  },
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

function buildFakeWavePcm16Buffer(sr: number, channels: number, durationSec: number): ArrayBuffer {
  const frames = Math.round(sr * durationSec);
  const chanArrays: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    const arr = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      arr[i] = 0.4 * Math.sin((2 * Math.PI * (440 + ch * 110) * i) / sr);
    }
    chanArrays.push(arr);
  }
  const blob = encodePcm16Wav(chanArrays, sr);
  // Read synchronously from Uint8Array via Blob/Response isn't sync, so encode directly into ArrayBuffer for test:
  const blockAlign = channels * 2;
  const dataSize = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeAscii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const sample = Math.max(-1, Math.min(1, chanArrays[ch][i]));
      view.setInt16(off, Math.round(sample * 32767), true);
      off += 2;
    }
  }
  void blob;
  return buf;
}

describe("Worker Status States (Online/Busy/Stale/Offline), WAV Sample-Rate Preservation & Score Polling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetWorkerConnectionState();
  });

  afterEach(() => {
    resetWorkerConnectionState();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("distinguishes Online, Busy, Stale (with age), and Offline states in WorkerStatusBadge and WorkerControlPanel", async () => {
    let currentStatus: WorkerStatus = {
      worker_online: true,
      status: "online",
      last_seen_seconds: 2,
      worker_id: "win-1",
      active_job_id: null,
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 45,
      busy_stale_threshold_seconds: 90,
    };

    vi.spyOn(api, "getWorkerStatus").mockImplementation(async () => currentStatus);
    vi.spyOn(workerController, "checkHealth").mockRejectedValue(new Error("offline controller"));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <WorkerStatusBadge />
        <WorkerControlPanel />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("worker-status-badge")).toHaveAttribute("data-status", "online");
    });
    expect(screen.getByText("Desktop Worker Online")).toBeInTheDocument();

    // Busy worker during active inference
    currentStatus = {
      ...currentStatus,
      worker_online: true,
      status: "busy",
      last_seen_seconds: 8,
      active_job_id: "job-99",
      active_job_count: 1,
    };
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["worker-status"] });
    });
    await waitFor(() => {
      expect(screen.getByTestId("worker-status-badge")).toHaveAttribute("data-status", "busy");
    });
    expect(screen.getByText("Desktop Worker Busy")).toBeInTheDocument();
    expect(screen.getByText("Busy")).toBeInTheDocument();

    // Delayed busy heartbeat (47s ago) -> Stale with accurate age (not prematurely marked offline)
    currentStatus = {
      ...currentStatus,
      worker_online: true,
      status: "stale",
      last_seen_seconds: 47,
      active_job_id: "job-99",
      active_job_count: 1,
    };
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["worker-status"] });
    });
    await waitFor(() => {
      expect(screen.getByTestId("worker-status-badge")).toHaveAttribute("data-status", "stale");
    });
    expect(screen.getByText("Desktop Worker Stale")).toBeInTheDocument();
    expect(screen.getByText("(47s ago)")).toBeInTheDocument();

    // Disconnected > 90s -> Offline
    currentStatus = {
      ...currentStatus,
      worker_online: false,
      status: "offline",
      last_seen_seconds: 120,
      active_job_id: null,
    };
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["worker-status"] });
    });
    await waitFor(() => {
      expect(screen.getByTestId("worker-status-badge")).toHaveAttribute("data-status", "offline");
    });
    expect(screen.getByText("Desktop Worker Offline")).toBeInTheDocument();
    expect(screen.getByText("(2m ago)")).toBeInTheDocument();
  });

  it("preserves 44.1 kHz, 48 kHz, and genuine 8 kHz WAV sample rates without downsampling to 8000 Hz", async () => {
    for (const { sr, ch } of [
      { sr: 44100, ch: 2 },
      { sr: 48000, ch: 2 },
      { sr: 8000, ch: 1 },
    ]) {
      const rawWav = buildFakeWavePcm16Buffer(sr, ch, 1.0);
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(rawWav, { status: 200, headers: { "Content-Type": "audio/wav" } }),
      );

      const decoded = await decodeAudioBufferFromUrl(`https://example.com/${sr}.wav`, {
        preferredSampleRate: sr,
      });
      expect(decoded.sampleRate).toBe(sr);
      expect(decoded.numberOfChannels).toBe(ch);

      const sliced = sliceAudioBuffer(decoded, 0.25, 0.75);
      expect(sliced.sampleRate).toBe(sr);
      const outBlob = encodePcm16Wav(sliced.channels, sliced.sampleRate);
      const outBuf = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error || new Error("read failed"));
        reader.readAsArrayBuffer(outBlob);
      });

      const hdr = parseWavHeader(outBuf);
      expect(hdr).not.toBeNull();
      expect(hdr!.sampleRate).toBe(sr);
      expect(hdr!.numChannels).toBe(ch);
      expect(hdr!.bitsPerSample).toBe(16);
      expect(hdr!.blockAlign).toBe(ch * 2);
      expect(hdr!.byteRate).toBe(sr * ch * 2);
      expect(hdr!.dataSize).toBe(sliced.frameCount * hdr!.blockAlign);
    }
  });

  it("does not leak WaveSurfer's 8000 Hz preview decoded buffer into WaveformPlayer onDecodedAudioReady", async () => {
    const callbacks: Record<string, (arg?: unknown) => void> = {};
    vi.mocked(WaveSurfer.create).mockReturnValue({
      on: vi.fn((ev: string, cb: (arg?: unknown) => void) => {
        callbacks[ev] = cb;
      }),
      destroy: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      isPlaying: vi.fn(() => false),
      seekTo: vi.fn(),
      getDuration: vi.fn(() => 10),
      getCurrentTime: vi.fn(() => 0),
      setPlaybackRate: vi.fn(),
      setVolume: vi.fn(),
      getDecodedData: vi.fn(() => ({ sampleRate: 8000, duration: 10 })),
    } as never);

    vi.spyOn(api, "getSignedMediaUrl").mockResolvedValue({
      url: "https://example.com/signed-48k.wav",
      expires_in: 300,
    });
    const onDecoded = vi.fn();

    render(
      <WaveformPlayer
        mediaAssetId="asset-48k"
        notes={[]}
        durationSeconds={10}
        tempoBpm={120}
        playheadSec={0}
        onPlayheadChange={vi.fn()}
        onDecodedAudioReady={onDecoded}
      />,
    );

    await waitFor(() => {
      expect(callbacks.ready).toBeTypeOf("function");
    });
    act(() => {
      callbacks.ready(10);
    });

    expect(onDecoded).toHaveBeenLastCalledWith({
      durationSec: 10,
      audioBuffer: null,
      signedUrl: "https://example.com/signed-48k.wav",
    });
  });

  it("suppresses expected score 404 fetches during active processing and loads score once completed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const processingProject: Project = {
      id: "proj-proc",
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
    };
    const runningJob: TranscriptionJob = {
      id: "job-proc-1",
      project_id: "proj-proc",
      user_id: "u1",
      source_asset_id: null,
      status: "transcribing",
      progress: 60,
      current_stage: "Transcribing Melody",
      engine: "vocal_pyin",
      settings_json: { mode: "melody" } as TranscriptionJob["settings_json"],
      error_code: null,
      error_message: null,
      started_at: new Date().toISOString(),
      completed_at: null,
      created_at: new Date().toISOString(),
      worker_online: true,
    };
    const completedScore: ProjectScoreResponse = {
      id: "score-1",
      project_id: "proj-proc",
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
        analysis: { mode: "melody", job_id: "job-proc-1" },
      },
      musicxml: "<score-partwise/>",
    };

    vi.spyOn(api, "getMe").mockResolvedValue({
      id: "u1",
      email: "u@example.com",
      display_name: "U",
      plan_tier: "unlimited",
    } as never);
    vi.spyOn(api, "getProject").mockResolvedValue(processingProject);
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([runningJob]);
    vi.spyOn(api, "getLyrics").mockRejectedValue(new ApiError(404, "Not found"));
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "busy",
      last_seen_seconds: 5,
      worker_id: "win-1",
      active_job_id: "job-proc-1",
      active_job_count: 1,
      queue_depth: 0,
      freshness_threshold_seconds: 45,
      busy_stale_threshold_seconds: 90,
    });

    const getScoreSpy = vi.spyOn(api, "getScore").mockResolvedValue(completedScore);
    let pollStep = 0;
    vi.spyOn(api, "getJob").mockImplementation(async () => {
      pollStep += 1;
      if (pollStep === 1) {
        return { ...runningJob, progress: 80 };
      }
      return { ...runningJob, status: "completed", progress: 100, current_stage: "Completed" };
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/projects/proj-proc"]}>
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
    // Must NOT call GET /projects/:id/score while processing -> zero 404 console spam!
    expect(getScoreSpy).not.toHaveBeenCalled();

    // Advance 2 poll cycles -> job completes -> score loads automatically
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(getScoreSpy).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    await waitFor(() => {
      expect(getScoreSpy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText(/Key: F major/i)).toBeInTheDocument();
    });

    const errorLogs = consoleErrSpy.mock.calls.flat().join(" ");
    expect(errorLogs).not.toContain("404");
  });
});
