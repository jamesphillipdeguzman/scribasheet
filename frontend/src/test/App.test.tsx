import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { AppShell } from "@/components/AppShell";
import * as AuthCtx from "@/features/auth/AuthContext";
import { AuthProvider } from "@/features/auth/AuthContext";
import { LoginPage } from "@/features/auth/AuthPages";
import { WorkerStatusBadge } from "@/components/WorkerStatusBadge";
import { WorkerControlPanel } from "@/components/WorkerControlPanel";
import * as controllerSvc from "@/services/workerController";
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

  it("renders WorkerStatusBadge loading, online, offline, unavailable (401/404/500), and refresh states", async () => {
    const statusSpy = vi.spyOn(api, "getWorkerStatus");

    // 1. Loading state
    let resolvePending!: (val: any) => void;
    statusSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        })
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <WorkerStatusBadge />
      </QueryClientProvider>
    );
    expect(screen.getByText(/Checking worker\.\.\./i)).toBeInTheDocument();

    // 2. Online state
    resolvePending({
      worker_online: true,
      status: "online",
      last_seen_seconds: 5,
      worker_id: "win-pc",
      active_job_count: 1,
      queue_depth: 0,
      freshness_threshold_seconds: 45,
    });
    await waitFor(() => {
      const badge = screen.getByTestId("worker-status-badge");
      expect(badge).toHaveAttribute("data-status", "online");
      expect(badge).toHaveTextContent(/Desktop Worker Online/i);
    });

    // 3. Refresh to Offline state
    statusSpy.mockResolvedValueOnce({
      worker_online: false,
      status: "offline",
      last_seen_seconds: 180,
      worker_id: "win-pc",
      active_job_count: 0,
      queue_depth: 2,
      freshness_threshold_seconds: 45,
    });
    await qc.invalidateQueries({ queryKey: ["worker-status"] });
    await waitFor(() => {
      const badge = screen.getByTestId("worker-status-badge");
      expect(badge).toHaveAttribute("data-status", "offline");
      expect(badge).toHaveTextContent(/Desktop Worker Offline/i);
      expect(badge).toHaveTextContent(/2 queued/i);
    });

    // 4. HTTP 401 -> Worker status unavailable (NOT offline)
    statusSpy.mockRejectedValue(new ApiError(401, "Authentication required."));
    await qc.invalidateQueries({ queryKey: ["worker-status"] });
    await waitFor(
      () => {
        const el = screen.getByText(/Worker status unavailable/i);
        expect(el).toHaveAttribute("data-status", "unavailable");
        expect(el).toHaveAttribute("title", expect.stringMatching(/HTTP 401/i));
      },
      { timeout: 3000 }
    );

    // 5. HTTP 404 -> Worker status unavailable
    statusSpy.mockRejectedValue(new ApiError(404, "Not found"));
    await qc.invalidateQueries({ queryKey: ["worker-status"] });
    await waitFor(
      () => {
        const el = screen.getByText(/Worker status unavailable/i);
        expect(el).toHaveAttribute("title", expect.stringMatching(/HTTP 404/i));
      },
      { timeout: 3000 }
    );

    // 6. HTTP 500 -> Worker status unavailable
    statusSpy.mockRejectedValue(new ApiError(500, "Server error"));
    await qc.invalidateQueries({ queryKey: ["worker-status"] });
    await waitFor(
      () => {
        const el = screen.getByText(/Worker status unavailable/i);
        expect(el).toHaveAttribute("title", expect.stringMatching(/HTTP 500/i));
      },
      { timeout: 3000 }
    );
  });

  it("renders WorkerControlPanel unavailable, start/stop/restart, and mobile states", async () => {
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: false,
      status: "offline",
      last_seen_seconds: null,
      worker_id: null,
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 45,
    });
    vi.spyOn(controllerSvc, "isMobileDevice").mockReturnValue(false);
    vi.spyOn(controllerSvc, "getControllerToken").mockReturnValue("pair-tok");

    // 1. Controller unreachable -> Local Controller Not Connected
    const healthSpy = vi
      .spyOn(controllerSvc.workerController, "checkHealth")
      .mockRejectedValueOnce(new Error("Connection refused"));

    const qc1 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={qc1}>
        <WorkerControlPanel />
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByText(/Local Controller Not Connected/i)).toBeInTheDocument();
    });
    unmount();

    // 2. Controller connected & stopped -> Start Worker -> Running -> Stop Worker
    healthSpy.mockResolvedValue({ controller_online: true, requires_pairing: true });
    const statusCtrlSpy = vi
      .spyOn(controllerSvc.workerController, "getStatus")
      .mockResolvedValueOnce({
        controller_online: true,
        worker_running: false,
        managed_by_controller: false,
        external_worker_detected: false,
        pid: null,
        started_at: null,
        last_exit_code: null,
        last_error: null,
        log_path: "logs/worker.log",
        log_tail: [],
      })
      .mockResolvedValueOnce({
        controller_online: true,
        worker_running: true,
        managed_by_controller: true,
        external_worker_detected: false,
        pid: 4321,
        started_at: new Date().toISOString(),
        last_exit_code: null,
        last_error: null,
        log_path: "logs/worker.log",
        log_tail: [],
      });
    const startSpy = vi.spyOn(controllerSvc.workerController, "startWorker").mockResolvedValueOnce({
      controller_online: true,
      worker_running: true,
      managed_by_controller: true,
      external_worker_detected: false,
      pid: 4321,
      started_at: new Date().toISOString(),
      last_exit_code: null,
      last_error: null,
      log_path: "logs/worker.log",
      log_tail: [],
      ok: true,
      message: "Worker started.",
    });

    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount: unmount2 } = render(
      <QueryClientProvider client={qc2}>
        <WorkerControlPanel />
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /Start Worker/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Start Worker/i }));
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: /Stop Worker/i })).toBeInTheDocument());
    expect(statusCtrlSpy).toHaveBeenCalled();
    unmount2();

    // 3. Mobile explanation
    vi.spyOn(controllerSvc, "isMobileDevice").mockReturnValue(true);
    const qc3 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc3}>
        <WorkerControlPanel />
      </QueryClientProvider>
    );
    expect(screen.getByText(/cannot start or stop a worker on another device/i)).toBeInTheDocument();
  });

  it("enables Stop/Restart for external workers and displays pairing token instructions with Copy Command", async () => {
    vi.restoreAllMocks();
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 2,
      worker_id: "win-1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 45,
    });
    vi.spyOn(controllerSvc, "isMobileDevice").mockReturnValue(false);

    // 1. Pairing state (401) shows PowerShell command, missing-token guidance, and Copy Command
    vi.spyOn(controllerSvc, "getControllerToken").mockReturnValue("");
    const healthSpy = vi
      .spyOn(controllerSvc.workerController, "checkHealth")
      .mockResolvedValue({ controller_online: true, requires_pairing: true });
    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextSpy },
      configurable: true,
    });

    const qcPair = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={qcPair}>
        <WorkerControlPanel />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Where do I get my pairing token\?/i)).toBeInTheDocument());
    expect(screen.getByText(/type logs\\worker_controller\.token \| clip & type logs\\worker_controller\.token/i)).toBeInTheDocument();
    expect(screen.getByText(/install or start the local worker controller first/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Copy Command/i }));
    expect(writeTextSpy).toHaveBeenCalledWith("type logs\\worker_controller.token | clip & type logs\\worker_controller.token");
    unmount();

    // 2. External worker running -> Stop Worker & Restart Worker enabled and functional
    vi.spyOn(controllerSvc, "getControllerToken").mockReturnValue("pair-tok");
    healthSpy.mockResolvedValue({ controller_online: true, requires_pairing: true });
    vi.spyOn(controllerSvc.workerController, "getStatus").mockResolvedValue({
      controller_online: true,
      worker_running: true,
      managed_by_controller: false,
      external_worker_detected: true,
      external_manageable: true,
      pid: 9876,
      started_at: null,
      last_exit_code: null,
      last_error: null,
      log_path: "logs/worker.log",
      log_tail: [],
    });
    const stopSpy = vi.spyOn(controllerSvc.workerController, "stopWorker").mockResolvedValue({
      controller_online: true,
      worker_running: false,
      managed_by_controller: false,
      external_worker_detected: false,
      pid: null,
      started_at: null,
      last_exit_code: null,
      last_error: null,
      log_path: "logs/worker.log",
      log_tail: [],
      ok: true,
      message: "Stopped external worker (PID 9876).",
    });

    const qcExt = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qcExt}>
        <WorkerControlPanel />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Running \(external, PID: 9876/i)).toBeInTheDocument());
    const stopBtn = screen.getByRole("button", { name: /Stop Worker/i }) as HTMLButtonElement;
    const restartBtn = screen.getByRole("button", { name: /Restart Worker/i }) as HTMLButtonElement;
    expect(stopBtn.disabled).toBe(false);
    expect(restartBtn.disabled).toBe(false);

    fireEvent.click(stopBtn);
    await waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1));
  });

  it("retries transient 502/503 and network errors up to 3 times without retrying 401", async () => {
    vi.restoreAllMocks();
    let planCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/billing/plans")) {
        planCalls += 1;
        if (planCalls === 1) return new Response("Bad Gateway", { status: 502 });
        if (planCalls === 2) return new Response("Unavailable", { status: 503 });
        if (planCalls === 3) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        if (planCalls === 4) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ ok: "recovered" }), { status: 200 });
      }
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({ detail: "Invalid email or password." }), { status: 401 });
      }
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      // 1. 502 -> 503 -> 200 succeeds
      const res1 = await api.getPlans();
      expect(res1).toEqual({ ok: true });
      expect(planCalls).toBe(3);

      // 2. TypeError: Failed to fetch -> 200 succeeds
      const res2 = await api.getPlans();
      expect(res2).toEqual({ ok: "recovered" });
      expect(planCalls).toBe(5);

      // 3. 401 does NOT retry (no refresh token stored)
      const beforeLogin = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/auth/login")).length;
      await expect(api.login({ email: "a@b.com", password: "bad" })).rejects.toThrow("Invalid email or password.");
      const afterLogin = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/auth/login")).length;
      expect(afterLogin - beforeLogin).toBe(1);

      // 4. wakeUpBackend hits /health
      const awake = await api.wakeUpBackend();
      expect(awake).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/health$/), expect.objectContaining({ method: "GET" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders UNLIMITED, FREE, PRO, and legacy usage indicators in AppShell navbar", () => {
    const baseUser = {
      id: "u1",
      email: "test@example.com",
      display_name: "Tester",
      email_verified: true,
      plan_tier: "free",
      created_at: "",
      updated_at: "",
    };

    // 1. Unlimited user -> shows UNLIMITED and consumed minutes without / 30 min cap
    const authSpy = vi.spyOn(AuthCtx, "useAuth").mockReturnValue({
      user: { ...baseUser, is_unlimited: true, plan_label: "UNLIMITED" },
      usage: {
        plan_tier: "free",
        plan_label: "UNLIMITED",
        is_unlimited: true,
        monthly_minutes_used: 42.5,
        monthly_minutes_limit: 30,
        project_count: 20,
        project_limit: 15,
        storage_used_mb: 310,
        storage_limit_mb: 250,
      },
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      refreshUser: vi.fn(),
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AppShell>
            <div>Body</div>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const navUsage = screen.getByTestId("navbar-usage-indicator");
    expect(navUsage).toHaveTextContent("42.5 min used");
    expect(navUsage).toHaveTextContent("UNLIMITED");
    expect(navUsage).not.toHaveTextContent("/ 30 min");

    // 2. PRO user -> preserves PRO limit display
    authSpy.mockReturnValue({
      user: { ...baseUser, plan_tier: "pro", is_unlimited: false, plan_label: "PRO" },
      usage: {
        plan_tier: "pro",
        plan_label: "PRO",
        is_unlimited: false,
        monthly_minutes_used: 12,
        monthly_minutes_limit: 300,
        project_count: 5,
        project_limit: 200,
        storage_used_mb: 20,
        storage_limit_mb: 5120,
      },
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      refreshUser: vi.fn(),
    });
    rerender(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AppShell>
            <div>Body</div>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.getByTestId("navbar-usage-indicator")).toHaveTextContent("12 / 300 min");
    expect(screen.getByTestId("navbar-usage-indicator")).toHaveTextContent("PRO");

    // 3. Legacy FREE payload missing is_unlimited / plan_label -> falls back safely to FREE
    authSpy.mockReturnValue({
      user: baseUser,
      usage: {
        plan_tier: "free",
        monthly_minutes_used: 19.34,
        monthly_minutes_limit: 30,
        project_count: 2,
        project_limit: 15,
        storage_used_mb: 10,
        storage_limit_mb: 250,
      },
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      refreshUser: vi.fn(),
    });
    rerender(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AppShell>
            <div>Body</div>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.getByTestId("navbar-usage-indicator")).toHaveTextContent("19.34 / 30 min");
    expect(screen.getByTestId("navbar-usage-indicator")).toHaveTextContent("free");
    authSpy.mockRestore();
  });
});
