import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportCenter } from "@/features/editor/ExportCenter";
import { MediaUploader } from "@/features/uploads/MediaUploader";
import {
  NO_AUDIO_TRACK_GUIDANCE,
  resolveAudioFormatFromMime,
} from "@/features/uploads/tabAudioRecorder";
import { api, ApiError } from "@/services/api";
import type { MediaAsset } from "@/types/api";

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: "asset-1",
    project_id: "proj-1",
    asset_type: "original",
    original_filename: "song.mp4",
    mime_type: "video/mp4",
    size_bytes: 512000,
    duration_seconds: 32.5,
    sample_rate: 44100,
    channels: 2,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

class MockTrack {
  kind: "audio" | "video";
  stop = vi.fn();
  private listeners: Record<string, Array<() => void>> = {};

  constructor(kind: "audio" | "video") {
    this.kind = kind;
  }

  addEventListener(event: string, cb: () => void) {
    this.listeners[event] = this.listeners[event] || [];
    this.listeners[event].push(cb);
  }

  removeEventListener(event: string, cb: () => void) {
    this.listeners[event] = (this.listeners[event] || []).filter((fn) => fn !== cb);
  }

  triggerEnded() {
    (this.listeners["ended"] || []).forEach((cb) => cb());
  }
}

class MockMediaStream {
  private tracks: MockTrack[];
  constructor(tracks: MediaStreamTrack[] | MockTrack[]) {
    this.tracks = tracks as MockTrack[];
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
}

class MockMediaRecorder {
  static supportedMimeTypes: string[] = ["audio/webm;codecs=opus", "audio/webm"];
  static isTypeSupported = vi.fn((mime: string) => MockMediaRecorder.supportedMimeTypes.includes(mime));
  static instances: MockMediaRecorder[] = [];

  stream: MockMediaStream;
  mimeType: string;
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  nextChunks: Blob[] = [new Blob(["opus-audio-bytes"], { type: "audio/webm;codecs=opus" })];
  failWithError = false;

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream as unknown as MockMediaStream;
    this.mimeType = options?.mimeType || "audio/webm;codecs=opus";
    MockMediaRecorder.instances.push(this);
  }

  start = vi.fn(() => {
    this.state = "recording";
  });

  stop = vi.fn(() => {
    if (this.state === "inactive") return;
    this.state = "inactive";
    if (this.failWithError) {
      this.onerror?.(new Event("error"));
      return;
    }
    for (const chunk of this.nextChunks) {
      this.ondataavailable?.({ data: chunk });
    }
    this.onstop?.();
  });
}

describe("Video Audio Extraction UI & ExportCenter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["clip.mp4", "video/mp4"],
    ["clip.mov", "video/quicktime"],
    ["clip.webm", "video/webm"],
    ["clip.mkv", "video/x-matroska"],
  ])("shows Extract Audio for supported video %s", (filename, mime) => {
    render(
      <MediaUploader
        projectId="proj-1"
        projectTitle="My Song"
        existingAssets={[makeAsset({ original_filename: filename, mime_type: mime })]}
        onUploadComplete={vi.fn()}
      />,
    );

    expect(screen.getByTestId("video-audio-extraction-card")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Extract Audio/i })).toBeInTheDocument();
  });

  it.each([
    ["song.mp3", "audio/mpeg"],
    ["song.wav", "audio/wav"],
    ["hymn.pdf", "application/pdf"],
    ["hymn.musicxml", "application/vnd.recordare.musicxml+xml"],
    ["mic-recording-123.webm", "audio/webm"],
    ["tab-audio-123.webm", "audio/webm;codecs=opus"],
  ])("hides Extract Audio for non-video upload %s", (filename, mime) => {
    render(
      <MediaUploader
        projectId="proj-1"
        projectTitle="My Song"
        existingAssets={[makeAsset({ original_filename: filename, mime_type: mime })]}
        onUploadComplete={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("video-audio-extraction-card")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Extract Audio/i })).not.toBeInTheDocument();
  });

  it("prevents duplicate extraction requests, shows MP3/WAV downloads, and selects extracted audio for transcription", async () => {
    let resolveExtract!: (val: Awaited<ReturnType<typeof api.extractVideoAudio>>) => void;
    const extractSpy = vi.spyOn(api, "extractVideoAudio").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExtract = resolve;
        }),
    );
    const downloadSpy = vi.spyOn(api, "downloadMediaAsset").mockResolvedValue(undefined);
    const onSelectSourceAsset = vi.fn();
    const onAudioExtracted = vi.fn();
    const startTranscriptionSpy = vi.spyOn(api, "startTranscription");

    render(
      <MediaUploader
        projectId="proj-1"
        projectTitle="My Song"
        existingAssets={[makeAsset({ id: "vid-1", original_filename: "clip.mp4", mime_type: "video/mp4" })]}
        selectedSourceAssetId="vid-1"
        onSelectSourceAsset={onSelectSourceAsset}
        onAudioExtracted={onAudioExtracted}
        onUploadComplete={vi.fn()}
      />,
    );

    const extractBtn = screen.getByRole("button", { name: /Extract Audio/i });
    fireEvent.click(extractBtn);
    fireEvent.click(extractBtn);

    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Extracting MP3 and 16-bit PCM WAV via FFmpeg/i)).toBeInTheDocument();

    await act(async () => {
      resolveExtract({
        source_asset_id: "vid-1",
        mp3: {
          id: "ext-mp3",
          format: "mp3",
          filename: "My Song.mp3",
          mime_type: "audio/mpeg",
          size_bytes: 120000,
          duration_seconds: 32.5,
          sample_rate: 44100,
          channels: 2,
          download_url: "/api/v1/uploads/ext-mp3/download",
        },
        wav: {
          id: "ext-wav",
          format: "wav",
          filename: "My Song.wav",
          mime_type: "audio/wav",
          size_bytes: 540000,
          duration_seconds: 32.5,
          sample_rate: 44100,
          channels: 2,
          download_url: "/api/v1/uploads/ext-wav/download",
        },
        assets: [],
      });
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Download MP3/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Download WAV/i })).toBeInTheDocument();
    });
    expect(onSelectSourceAsset).toHaveBeenCalledWith("ext-wav");
    expect(onAudioExtracted).toHaveBeenCalledTimes(1);
    expect(startTranscriptionSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Download MP3/i }));
    await waitFor(() => {
      expect(downloadSpy).toHaveBeenCalledWith("ext-mp3", "My Song.mp3");
    });

    fireEvent.click(screen.getByRole("button", { name: /Download WAV/i }));
    await waitFor(() => {
      expect(downloadSpy).toHaveBeenCalledWith("ext-wav", "My Song.wav");
    });
  });

  it("displays clear extraction error when video has no audio stream or FFmpeg fails", async () => {
    vi.spyOn(api, "extractVideoAudio").mockRejectedValueOnce(
      new ApiError(400, "This video file contains no audio stream to extract."),
    );

    render(
      <MediaUploader
        projectId="proj-1"
        projectTitle="Silent Clip"
        existingAssets={[makeAsset({ id: "vid-silent" })]}
        onUploadComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Extract Audio/i }));
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(/contains no audio stream to extract/i);
      expect(alert.className).toContain("text-red-900");
      expect(alert.className).toContain("dark:text-red-300");
    });
  });

  it("renders Extracted Video Audio options in ExportCenter only for video projects and enables before score exists", async () => {
    vi.spyOn(api, "listExports").mockResolvedValue([]);
    const createExportSpy = vi.spyOn(api, "createExport").mockResolvedValue({
      id: "exp-mp3",
      project_id: "proj-1",
      format: "extracted_mp3",
      status: "completed",
      error_message: null,
      download_url: "/api/v1/exports/exp-mp3/download",
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
    const downloadSpy = vi.spyOn(api, "downloadExportBlob").mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <ExportCenter
          projectId="proj-1"
          projectTitle="My Song"
          hasScore={false}
          uploadedVideoAsset={makeAsset({ original_filename: "live.mov", mime_type: "video/quicktime" })}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("export-center-extracted-audio")).toBeInTheDocument();
    const mp3Btn = screen.getByRole("button", { name: /Extract & Download MP3/i });
    expect(mp3Btn).not.toBeDisabled();
    fireEvent.click(mp3Btn);

    await waitFor(() => {
      expect(createExportSpy).toHaveBeenCalledWith("proj-1", "extracted_mp3", expect.any(Object));
      expect(downloadSpy).toHaveBeenCalledWith("/api/v1/exports/exp-mp3/download", "My Song.mp3");
    });

    // Hidden for non-video audio upload
    rerender(
      <QueryClientProvider client={qc}>
        <ExportCenter projectId="proj-1" projectTitle="My Song" hasScore={true} uploadedVideoAsset={null} />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("export-center-extracted-audio")).not.toBeInTheDocument();
  });
});

describe("Browser Tab / System Audio Recording", () => {
  const originalMediaDevices = navigator.mediaDevices;
  const originalMediaRecorder = globalThis.MediaRecorder;
  const originalMediaStream = globalThis.MediaStream;

  beforeEach(() => {
    vi.restoreAllMocks();
    MockMediaRecorder.instances = [];
    MockMediaRecorder.supportedMimeTypes = ["audio/webm;codecs=opus", "audio/webm"];
    (globalThis as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder =
      MockMediaRecorder as unknown as typeof MediaRecorder;
    (globalThis as unknown as { MediaStream: typeof MediaStream }).MediaStream =
      MockMediaStream as unknown as typeof MediaStream;
  });

  afterEach(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    (globalThis as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder = originalMediaRecorder;
    (globalThis as unknown as { MediaStream: typeof MediaStream }).MediaStream = originalMediaStream;
  });

  it("records browser tab audio-only stream, shows live controls, uploads without auto-transcribing, and renders TAB AUDIO badge", async () => {
    const videoTrack = new MockTrack("video");
    const audioTrack = new MockTrack("audio");
    const getDisplayMedia = vi.fn().mockResolvedValue(new MockMediaStream([videoTrack, audioTrack]));
    const getUserMedia = vi.fn();

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia, getUserMedia },
    });

    const uploadedAsset = makeAsset({
      id: "tab-1",
      original_filename: "tab-audio-1700000000.webm",
      mime_type: "audio/webm;codecs=opus",
    });
    const uploadSpy = vi.spyOn(api, "uploadMedia").mockResolvedValueOnce(uploadedAsset);
    const startTranscriptionSpy = vi.spyOn(api, "startTranscription");
    const onUploadComplete = vi.fn();

    const { rerender } = render(
      <MediaUploader projectId="proj-1" existingAssets={[]} onUploadComplete={onUploadComplete} />,
    );

    const recordTabBtn = screen.getByRole("button", { name: /Record Tab \/ System Audio/i });
    fireEvent.click(recordTabBtn);

    await waitFor(() => {
      expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
      expect(screen.getByTestId("tab-audio-recording-panel")).toBeInTheDocument();
    });

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByTestId("tab-audio-recording-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("tab-audio-elapsed")).toHaveTextContent("0:00");
    expect(MockMediaRecorder.instances).toHaveLength(1);
    const recorder = MockMediaRecorder.instances[0];
    // Video track must NOT be passed into MediaRecorder stream
    expect(recorder.stream.getVideoTracks()).toHaveLength(0);
    expect(recorder.stream.getAudioTracks()).toHaveLength(1);
    expect(recorder.mimeType).toBe("audio/webm;codecs=opus");

    // Stop Recording button
    fireEvent.click(screen.getAllByRole("button", { name: /Stop Recording/i })[0]);

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      expect(onUploadComplete).toHaveBeenCalledWith(uploadedAsset);
    });
    const uploadedFile = uploadSpy.mock.calls[0][1];
    expect(uploadedFile.name).toMatch(/^tab-audio-\d+\.webm$/);
    expect(uploadedFile.type).toBe("audio/webm;codecs=opus");
    expect(videoTrack.stop).toHaveBeenCalled();
    expect(audioTrack.stop).toHaveBeenCalled();
    expect(startTranscriptionSpy).not.toHaveBeenCalled();

    rerender(
      <MediaUploader projectId="proj-1" existingAssets={[uploadedAsset]} onUploadComplete={onUploadComplete} />,
    );
    expect(screen.getByTestId("uploaded-format-badge")).toHaveTextContent("TAB AUDIO");
    expect(screen.queryByTestId("video-audio-extraction-card")).not.toBeInTheDocument();
  });

  it("stops every acquired track and shows exact guidance when no audio track is detected", async () => {
    const videoTrackOnly = new MockTrack("video");
    const getDisplayMedia = vi.fn().mockResolvedValue(new MockMediaStream([videoTrackOnly]));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    });

    const uploadSpy = vi.spyOn(api, "uploadMedia");
    render(<MediaUploader projectId="proj-1" existingAssets={[]} onUploadComplete={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Record Tab \/ System Audio/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(NO_AUDIO_TRACK_GUIDANCE);
    });
    expect(videoTrackOnly.stop).toHaveBeenCalledTimes(1);
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("automatically stops and uploads when user clicks browser native Stop Sharing", async () => {
    const videoTrack = new MockTrack("video");
    const audioTrack = new MockTrack("audio");
    const getDisplayMedia = vi.fn().mockResolvedValue(new MockMediaStream([videoTrack, audioTrack]));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    });

    const uploadedAsset = makeAsset({
      id: "tab-native-stop",
      original_filename: "tab-audio-999.webm",
      mime_type: "audio/webm",
    });
    const uploadSpy = vi.spyOn(api, "uploadMedia").mockResolvedValueOnce(uploadedAsset);

    render(<MediaUploader projectId="proj-1" existingAssets={[]} onUploadComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Record Tab \/ System Audio/i }));

    await waitFor(() => {
      expect(screen.getByTestId("tab-audio-recording-panel")).toBeInTheDocument();
    });

    await act(async () => {
      videoTrack.triggerEnded();
    });

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("tab-audio-recording-panel")).not.toBeInTheDocument();
    });
  });

  it("handles permission denial and unsupported browsers cleanly without falling back to microphone", async () => {
    const getUserMedia = vi.fn();
    const deniedErr = new Error("Permission denied");
    deniedErr.name = "NotAllowedError";
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia: vi.fn().mockRejectedValue(deniedErr), getUserMedia },
    });

    const { unmount } = render(<MediaUploader projectId="proj-1" existingAssets={[]} onUploadComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Record Tab \/ System Audio/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/permission was denied/i);
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    unmount();

    // Unsupported browser (no getDisplayMedia)
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    render(<MediaUploader projectId="proj-1" existingAssets={[]} onUploadComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Record Tab \/ System Audio/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/not supported in this browser/i);
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("handles empty recordings and MediaRecorder encoding errors gracefully", async () => {
    const videoTrack = new MockTrack("video");
    const audioTrack = new MockTrack("audio");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia: vi.fn().mockResolvedValue(new MockMediaStream([videoTrack, audioTrack])) },
    });
    const uploadSpy = vi.spyOn(api, "uploadMedia");

    render(<MediaUploader projectId="proj-1" existingAssets={[]} onUploadComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Record Tab \/ System Audio/i }));
    await waitFor(() => expect(MockMediaRecorder.instances).toHaveLength(1));

    // Empty recording (0 bytes)
    MockMediaRecorder.instances[0].nextChunks = [new Blob([], { type: "audio/webm" })];
    fireEvent.click(screen.getAllByRole("button", { name: /Stop Recording/i })[0]);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/No audio data was captured/i);
    });
    expect(uploadSpy).not.toHaveBeenCalled();

    // MediaRecorder error
    fireEvent.click(screen.getByRole("button", { name: /Record Tab \/ System Audio/i }));
    await waitFor(() => expect(MockMediaRecorder.instances).toHaveLength(2));
    MockMediaRecorder.instances[1].failWithError = true;
    fireEvent.click(screen.getAllByRole("button", { name: /Stop Recording/i })[0]);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/audio encoding error/i);
    });
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("never labels WebM/Opus or Ogg recordings as MP3", () => {
    expect(resolveAudioFormatFromMime("audio/webm;codecs=opus")).toEqual({
      mimeType: "audio/webm;codecs=opus",
      extension: "webm",
    });
    expect(resolveAudioFormatFromMime("video/webm;codecs=opus")).toEqual({
      mimeType: "audio/webm;codecs=opus",
      extension: "webm",
    });
    expect(resolveAudioFormatFromMime("audio/ogg;codecs=opus")).toEqual({
      mimeType: "audio/ogg;codecs=opus",
      extension: "ogg",
    });
  });
});
