import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTrimmedAudioFilename,
  decodeAudioBufferFromUrl,
  detectSilenceTrimBounds,
  encodePcm16Wav,
  formatTrimTime,
  parseTrimTimeInput,
  sliceAudioBuffer,
  validateTrimBounds,
} from "@/features/editor/audioTrim";
import { AudioTrimPanel } from "@/features/editor/AudioTrimPanel";
import { WaveformPlayer } from "@/features/editor/WaveformPlayer";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { AuthProvider } from "@/features/auth/AuthContext";
import { api } from "@/services/api";
import type { MediaAsset, Project } from "@/types/api";

function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error || new Error("Failed to read blob"));
    reader.readAsArrayBuffer(blob);
  });
}
function makeAudioBuffer(channelsData: Float32Array[], sampleRate = 1000): AudioBuffer {
  const length = channelsData[0].length;
  return {
    sampleRate,
    length,
    duration: length / sampleRate,
    numberOfChannels: channelsData.length,
    getChannelData: (ch: number) => channelsData[ch],
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer;
}

function fillTone(arr: Float32Array, startSec: number, endSec: number, sr: number, amp = 0.25, freq = 220) {
  const i0 = Math.max(0, Math.floor(startSec * sr));
  const i1 = Math.min(arr.length, Math.floor(endSec * sr));
  for (let i = i0; i < i1; i++) {
    arr[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  }
}

describe("Web Audio Trimming & Silence Detection Utilities", () => {
  it("parses seconds and mm:ss inputs accurately and rejects invalid bounds", () => {
    expect(parseTrimTimeInput("8.5")).toBe(8.5);
    expect(parseTrimTimeInput("8.5s")).toBe(8.5);
    expect(parseTrimTimeInput("01:08.5")).toBe(68.5);
    expect(parseTrimTimeInput("-2")).toBeNull();
    expect(parseTrimTimeInput("01:75")).toBeNull();
    expect(parseTrimTimeInput("abc")).toBeNull();
    expect(formatTrimTime(68.5)).toBe("01:08.5");

    expect(validateTrimBounds(8.5, 5.0, 20.0).valid).toBe(false);
    expect(validateTrimBounds(-1, 5.0, 20.0).valid).toBe(false);
    expect(validateTrimBounds(10.0, 10.1, 20.0).valid).toBe(false);
    expect(validateTrimBounds(8.5, 19.2, 20.0).valid).toBe(true);
  });

  it("removes leading & trailing silence while preserving 150-250ms pre-roll, 300-500ms tail, clicks, and internal rests", () => {
    const sr = 1000;
    const data = new Float32Array(12 * sr); // 12s total
    // Isolated 10ms click at 1.0s (must NOT trigger musical onset)
    for (let i = Math.floor(1.0 * sr); i < Math.floor(1.01 * sr); i++) {
      data[i] = 0.35;
    }
    // Real music: 3.0s..5.0s, internal 1.5s rest, then 6.5s..9.0s
    fillTone(data, 3.0, 5.0, sr, 0.25);
    fillTone(data, 6.5, 9.0, sr, 0.25);

    const res = detectSilenceTrimBounds(makeAudioBuffer([data], sr));
    expect(res.changed).toBe(true);
    // 150-250ms preserved before 3.0s -> [2.75, 2.85]
    expect(res.startSec).toBeGreaterThanOrEqual(2.74);
    expect(res.startSec).toBeLessThanOrEqual(2.86);
    // 300-500ms preserved after 9.0s -> [9.29, 9.51], internal pause 5.0..6.5s untouched
    expect(res.endSec).toBeGreaterThanOrEqual(9.28);
    expect(res.endSec).toBeLessThanOrEqual(9.52);
  });

  it("preserves quiet soft openings and declines to cut recordings with no silence or pure silence", () => {
    const sr = 1000;
    // Quiet piano piece (-38 dBFS opening, -34 dBFS body) after 2s silence
    const quiet = new Float32Array(8 * sr);
    fillTone(quiet, 2.0, 6.0, sr, 0.018); // ~ -38 dBFS RMS
    const quietRes = detectSilenceTrimBounds(makeAudioBuffer([quiet], sr));
    expect(quietRes.changed).toBe(true);
    expect(quietRes.startSec).toBeGreaterThanOrEqual(1.7);
    expect(quietRes.startSec).toBeLessThanOrEqual(1.9);
    expect(quietRes.endSec).toBeGreaterThanOrEqual(6.28);

    // No silence at all (music fills 0..5s)
    const continuous = new Float32Array(5 * sr);
    fillTone(continuous, 0, 5.0, sr, 0.25);
    const noSilRes = detectSilenceTrimBounds(makeAudioBuffer([continuous], sr));
    expect(noSilRes.changed).toBe(false);
    expect(noSilRes.startSec).toBe(0);
    expect(noSilRes.reason.toLowerCase()).toContain("no significant leading or trailing silence");

    // Pure silence recording
    const allSilent = new Float32Array(4 * sr);
    const silRes = detectSilenceTrimBounds(makeAudioBuffer([allSilent], sr));
    expect(silRes.changed).toBe(false);
    expect(silRes.reason.toLowerCase()).toContain("too quiet or silent");
  });

  it("slices multi-channel audio, rejects completely silent regions, and writes valid 16-bit PCM WAV headers", async () => {
    const sr = 44100;
    const ch0 = new Float32Array(sr * 2);
    const ch1 = new Float32Array(sr * 2);
    fillTone(ch0, 0.5, 1.5, sr, 0.5, 440);
    fillTone(ch1, 0.5, 1.5, sr, 0.4, 554.37);
    const buf = makeAudioBuffer([ch0, ch1], sr);

    // Pure silent slice 0.0..0.4s throws
    expect(() => sliceAudioBuffer(buf, 0.0, 0.4)).toThrow(/silent/i);

    const sliced = sliceAudioBuffer(buf, 0.5, 1.5);
    expect(sliced.sampleRate).toBe(44100);
    expect(sliced.channels.length).toBe(2);
    const wavBlob = encodePcm16Wav(sliced.channels, sliced.sampleRate);
    expect(wavBlob.type).toBe("audio/wav");

    const bytes = await readBlobArrayBuffer(wavBlob);
    const view = new DataView(bytes);
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    expect(riff).toBe("RIFF");
    expect(wave).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // Stereo
    expect(view.getUint32(24, true)).toBe(44100); // Sample rate
    expect(view.getUint16(34, true)).toBe(16); // 16-bit PCM

    expect(buildTrimmedAudioFilename("tab-audio-123.webm", "Song")).toBe("tab-audio-123-trimmed.wav");
    expect(buildTrimmedAudioFilename("recital.wav", "Song")).toBe("recital-trimmed.wav");
  });

  it("throws user-friendly errors for corrupt/undecodable audio", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
    );
    const origCtx = window.AudioContext;
    window.AudioContext = vi.fn().mockImplementation(() => ({
      decodeAudioData: vi.fn().mockRejectedValue(new Error("EncodingError")),
      close: vi.fn().mockResolvedValue(undefined),
    })) as unknown as typeof AudioContext;

    await expect(decodeAudioBufferFromUrl("https://example.com/corrupt.wav")).rejects.toThrow(
      /Original recording is preserved/i,
    );

    window.AudioContext = origCtx;
    fetchSpy.mockRestore();
  });
});

vi.mock("wavesurfer.js", () => ({
  default: {
    create: vi.fn(() => ({
      on: vi.fn(),
      destroy: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      isPlaying: vi.fn(() => false),
      seekTo: vi.fn(),
      getDuration: vi.fn(() => 20),
      getCurrentTime: vi.fn(() => 0),
      setPlaybackRate: vi.fn(),
      setVolume: vi.fn(),
      getDecodedData: vi.fn(() => null),
    })),
  },
}));

describe("AudioTrimPanel, WaveformPlayer Overlay & Studio Workflow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders waveform dimmed regions, draggable trim handles, playhead buttons, Auto-Trim, Reset, and error recovery", async () => {
    const sr = 1000;
    const samples = new Float32Array(20 * sr);
    fillTone(samples, 4.0, 16.0, sr, 0.3);
    const buffer = makeAudioBuffer([samples], sr);

    const onTrimChange = vi.fn();
    const onTrimApplied = vi.fn();
    const asset: MediaAsset = {
      id: "asset-1",
      project_id: "proj-1",
      asset_type: "original",
      original_filename: "tab-audio-take1.webm",
      mime_type: "audio/webm",
      size_bytes: 50000,
      duration_seconds: 20,
      sample_rate: 44100,
      channels: 2,
      created_at: "2026-11-25T10:00:00Z",
    };

    const getUrlSpy = vi.spyOn(api, "getSignedMediaUrl").mockResolvedValue({
      url: "https://example.com/audio.webm",
      expires_in: 300,
    });

    const { rerender } = render(
      <>
        <WaveformPlayer
          mediaAssetId="asset-1"
          notes={[]}
          durationSeconds={20}
          tempoBpm={102}
          playheadSec={8.5}
          onPlayheadChange={vi.fn()}
          trimStartSec={2}
          trimEndSec={18}
          onTrimChange={onTrimChange}
        />
        <AudioTrimPanel
          projectId="proj-1"
          projectTitle="Test Song"
          mediaAsset={asset}
          signedAudioUrl="https://example.com/audio.webm"
          decodedAudioBuffer={buffer}
          durationSec={20}
          playheadSec={8.5}
          trimStartSec={2}
          trimEndSec={18}
          onTrimChange={onTrimChange}
          onTrimApplied={onTrimApplied}
        />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("trim-dim-left")).toBeTruthy();
      expect(screen.getByTestId("trim-dim-right")).toBeTruthy();
    });
    expect(screen.getByTestId("trim-dim-left").getAttribute("style")).toContain("width: 10%");
    expect(screen.getByTestId("trim-dim-right").getAttribute("style")).toContain("width: 10%");

    // Keyboard handle nudge updates boundaries
    const startHandle = screen.getByRole("slider", { name: "Trim start handle" });
    fireEvent.keyDown(startHandle, { key: "ArrowRight", shiftKey: true });
    expect(onTrimChange).toHaveBeenCalledWith(3, 18);

    // Selected duration displays live
    expect(screen.getByTestId("trim-selected-duration").textContent).toContain("16s");

    // Set Start to Playhead (8.5s)
    fireEvent.click(screen.getByRole("button", { name: /set start to playhead/i }));
    expect(onTrimChange).toHaveBeenCalledWith(8.5, 18);

    // Auto-Trim Silence detects ~3.8s..16.4s
    fireEvent.click(screen.getByRole("button", { name: /auto-trim silence/i }));
    await waitFor(() => {
      expect(onTrimChange).toHaveBeenLastCalledWith(
        expect.closeTo(3.8, 1),
        expect.closeTo(16.4, 1),
      );
    });

    // Reset Trim restores 0..20
    fireEvent.click(screen.getByRole("button", { name: /reset trim/i }));
    expect(onTrimChange).toHaveBeenLastCalledWith(0, 20);

    // Upload failure preserves original recording and shows clear alert
    const uploadSpy = vi.spyOn(api, "uploadMedia").mockRejectedValueOnce(new Error("Upload timed out"));
    fireEvent.click(screen.getByRole("button", { name: /apply trim/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/original recording was kept intact/i);
    });
    expect(onTrimApplied).not.toHaveBeenCalled();

    // Successful Apply Trim uploads 16-bit PCM WAV with replace_asset_id and calls onTrimApplied
    const trimmedAsset: MediaAsset = {
      ...asset,
      id: "asset-trimmed",
      original_filename: "tab-audio-take1-trimmed.wav",
      mime_type: "audio/wav",
      duration_seconds: 16,
    };
    uploadSpy.mockResolvedValueOnce(trimmedAsset);
    rerender(
      <AudioTrimPanel
        projectId="proj-1"
        projectTitle="Test Song"
        mediaAsset={asset}
        signedAudioUrl="https://example.com/audio.webm"
        decodedAudioBuffer={buffer}
        durationSec={20}
        playheadSec={8.5}
        trimStartSec={2}
        trimEndSec={18}
        onTrimChange={onTrimChange}
        onTrimApplied={onTrimApplied}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /apply trim/i }));
    await waitFor(() => {
      expect(onTrimApplied).toHaveBeenCalledWith(trimmedAsset, "asset-1");
    });
    expect(uploadSpy).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({ name: "tab-audio-take1-trimmed.wav", type: "audio/wav" }),
      expect.any(Function),
      undefined,
      "asset-1",
    );
    expect(screen.getByRole("status").textContent).toContain("Audio trimmed successfully. Ready to transcribe.");
    getUrlSpy.mockRestore();
  });

  it("updates ProjectStudioPage active source so subsequent transcription uses the trimmed WAV without auto-starting", async () => {
    const origAsset: MediaAsset = {
      id: "asset-orig",
      project_id: "proj-trim",
      asset_type: "original",
      original_filename: "tab-audio-song.webm",
      mime_type: "audio/webm",
      size_bytes: 40000,
      duration_seconds: 12,
      sample_rate: 44100,
      channels: 2,
      created_at: "2026-11-25T10:00:00Z",
    };
    const trimmedAsset: MediaAsset = {
      ...origAsset,
      id: "asset-trimmed-2",
      original_filename: "tab-audio-song-trimmed.wav",
      mime_type: "audio/wav",
      duration_seconds: 8,
    };

    const project: Project = {
      id: "proj-trim",
      user_id: "u1",
      title: "Trim Studio",
      description: "",
      instrument: "piano",
      transcription_mode: "piano",
      status: "draft",
      duration_seconds: 12,
      created_at: "2026-11-25T10:00:00Z",
      updated_at: "2026-11-25T10:00:00Z",
      media_assets: [origAsset],
    };

    const trimmedProject: Project = {
      ...project,
      duration_seconds: trimmedAsset.duration_seconds,
      media_assets: [trimmedAsset],
    };

    vi.spyOn(api, "getMe").mockResolvedValue({
      id: "u1",
      email: "t@example.com",
      display_name: "T",
      plan_tier: "free",
    } as never);
    const getProjectSpy = vi.spyOn(api, "getProject").mockResolvedValue(project);
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
    vi.spyOn(api, "getScore").mockRejectedValue({ status: 404, message: "Not found" });
    vi.spyOn(api, "getLyrics").mockRejectedValue({ status: 404, message: "Not found" });
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 1,
      worker_id: "w1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 60,
    });
    vi.spyOn(api, "getSignedMediaUrl").mockResolvedValue({
      url: "https://example.com/song.webm",
      expires_in: 300,
    });

    const sr = 1000;
    const samples = new Float32Array(12 * sr);
    fillTone(samples, 2.0, 10.0, sr, 0.35);
    const decoded = makeAudioBuffer([samples], sr);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
    );
    const origCtx = window.AudioContext;
    window.AudioContext = vi.fn().mockImplementation(() => ({
      decodeAudioData: vi.fn().mockResolvedValue(decoded),
      close: vi.fn().mockResolvedValue(undefined),
    })) as unknown as typeof AudioContext;

    const uploadSpy = vi.spyOn(api, "uploadMedia").mockImplementation(async () => {
      getProjectSpy.mockResolvedValue(trimmedProject);
      return trimmedAsset;
    });
    const startTransSpy = vi.spyOn(api, "startTranscription").mockResolvedValue({
      id: "job-trim",
      project_id: "proj-trim",
      user_id: "u1",
      source_asset_id: "asset-trimmed-2",
      status: "queued",
      progress: 0,
      current_stage: "Queued",
      engine: "transkun",
      settings_json: {} as never,
      error_code: null,
      error_message: null,
      started_at: null,
      completed_at: null,
      created_at: "2026-11-25T10:05:00Z",
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/proj-trim"]}>
          <AuthProvider>
            <Routes>
              <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("audio-trim-panel")).toBeTruthy();
    });

    // Enter manual start boundary 2.5s and apply trim
    const startInput = screen.getByLabelText(/start time/i) as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: "2.5" } });
    fireEvent.blur(startInput);

    fireEvent.click(screen.getByRole("button", { name: /apply trim/i }));
    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledTimes(1);
    });
    // Does not start transcription automatically
    expect(startTransSpy).not.toHaveBeenCalled();

    // User clicks Start AI Transcription -> receives trimmed asset ID
    fireEvent.click(screen.getByRole("button", { name: /start ai transcription/i }));
    await waitFor(() => {
      expect(startTransSpy).toHaveBeenCalledWith("proj-trim", "asset-trimmed-2", expect.any(Object));
    });

    window.AudioContext = origCtx;
    fetchSpy.mockRestore();
  });
});
