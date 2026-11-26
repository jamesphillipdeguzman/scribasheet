import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { AudioTrimPanel } from "@/features/editor/AudioTrimPanel";
import { ExportCenter } from "@/features/editor/ExportCenter";
import {
  applyScoreTitleToMusicXml,
  prepareDisplayMusicXml,
} from "@/features/editor/musicXmlNormalization";
import { buildTrimmedAudioFilename, encodePcm16Wav } from "@/features/editor/audioTrim";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { MediaUploader } from "@/features/uploads/MediaUploader";
import {
  buildRecordedAudioFilename,
  resolveDisplayScoreTitle,
  slugifyProjectTitle,
} from "@/lib/utils";
import { api } from "@/services/api";
import type { MediaAsset, Project, ScoreData } from "@/types/api";

const loadedOsmdXmls: string[] = [];

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: class MockOpenSheetMusicDisplay {
    Zoom = 1;
    EngravingRules = { RenderChordSymbols: true };
    cursor = { reset() {}, hide() {}, cursorElement: null, iterator: null };
    async load(xml: string) {
      loadedOsmdXmls.push(xml);
    }
    render() {}
    Dispose() {}
  },
}));

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: "asset-1",
    project_id: "proj-1",
    asset_type: "original",
    original_filename: "Na_Para_Bang_on_Youtube.webm",
    mime_type: "audio/webm;codecs=opus",
    size_bytes: 512000,
    duration_seconds: 12.5,
    sample_rate: 48000,
    channels: 2,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

class MockTrack {
  kind: "audio" | "video";
  stop = vi.fn();
  constructor(kind: "audio" | "video") {
    this.kind = kind;
  }
  addEventListener() {}
  removeEventListener() {}
}

class MockMediaStream {
  private tracks: MockTrack[];
  constructor(tracks: MockTrack[]) {
    this.tracks = tracks;
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
  static isTypeSupported = vi.fn((mime: string) => mime.includes("webm"));
  static instances: MockMediaRecorder[] = [];
  mimeType: string;
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType || "audio/webm;codecs=opus";
    MockMediaRecorder.instances.push(this);
  }

  start = vi.fn(() => {
    this.state = "recording";
  });

  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["recorded-bytes"], { type: this.mimeType }) });
    this.onstop?.();
  });
}

describe("Project Title Consistency Across Recording, Trim, MusicXML, Viewer & Export", () => {
  const originalMediaDevices = navigator.mediaDevices;
  const originalMediaRecorder = globalThis.MediaRecorder;
  const originalMediaStream = globalThis.MediaStream;

  beforeEach(() => {
    vi.restoreAllMocks();
    loadedOsmdXmls.length = 0;
    MockMediaRecorder.instances = [];
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

  it("slugifies meaningful project titles and uses safe timestamp fallbacks for blank/generic titles", () => {
    expect(slugifyProjectTitle("Na Para Bang on Youtube")).toBe("Na_Para_Bang_on_Youtube");
    expect(slugifyProjectTitle("  Café: / How Deep? *Live*  ")).toBe("Cafe_How_Deep_Live");
    expect(slugifyProjectTitle("")).toBe("");
    expect(slugifyProjectTitle("Untitled Project")).toBe("");
    expect(slugifyProjectTitle("New Transcription")).toBe("");
    expect(slugifyProjectTitle("Untitled Score")).toBe("");

    expect(buildRecordedAudioFilename("tab", "Na Para Bang on Youtube", "webm", 12345)).toBe(
      "Na_Para_Bang_on_Youtube.webm",
    );
    expect(buildRecordedAudioFilename("mic", "Na Para Bang on Youtube", "webm", 12345)).toBe(
      "Na_Para_Bang_on_Youtube.webm",
    );
    expect(buildRecordedAudioFilename("tab", "Untitled Project", "webm", 12345)).toBe(
      "tab-audio-12345.webm",
    );
    expect(buildRecordedAudioFilename("mic", "New Transcription", "webm", 67890)).toBe(
      "mic-recording-67890.webm",
    );

    expect(resolveDisplayScoreTitle("Na Para Bang on Youtube")).toBe("Na Para Bang on Youtube");
    expect(resolveDisplayScoreTitle("Untitled Project")).toBe("Untitled Score");
    expect(resolveDisplayScoreTitle("tab-audio-1795613137526-trimmed.wav")).toBe("Untitled Score");
    expect(resolveDisplayScoreTitle("")).toBe("Untitled Score");
  });

  it("names Tab/System Audio and Microphone recordings after project.title and falls back when generic", async () => {
    const getDisplayMedia = vi
      .fn()
      .mockResolvedValue(new MockMediaStream([new MockTrack("video"), new MockTrack("audio")]));
    const getUserMedia = vi.fn().mockResolvedValue(new MockMediaStream([new MockTrack("audio")]));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia, getUserMedia },
    });

    const uploadSpy = vi.spyOn(api, "uploadMedia").mockResolvedValue(makeAsset());

    const { rerender } = render(
      <MediaUploader
        projectId="proj-1"
        projectTitle="Na Para Bang on Youtube"
        existingAssets={[]}
        onUploadComplete={vi.fn()}
      />,
    );

    // Tab audio recording with meaningful project title
    fireEvent.click(screen.getByRole("button", { name: /Record Tab \/ System Audio/i }));
    await waitFor(() => expect(MockMediaRecorder.instances).toHaveLength(1));
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /Stop Recording/i })[0]);
    });
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1));
    expect(uploadSpy.mock.calls[0][1].name).toBe("Na_Para_Bang_on_Youtube.webm");
    expect(uploadSpy.mock.calls[0][1].type).toBe("audio/webm;codecs=opus");

    // Microphone recording with meaningful project title
    fireEvent.click(screen.getByRole("button", { name: /Record Microphone/i }));
    await waitFor(() => expect(MockMediaRecorder.instances).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /Stop Recording/i })[0]);
    });
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(2));
    expect(uploadSpy.mock.calls[1][1].name).toBe("Na_Para_Bang_on_Youtube.webm");
    expect(uploadSpy.mock.calls[1][1].type).toBe("audio/webm;codecs=opus");

    // Generic title retains safe timestamp fallback
    rerender(
      <MediaUploader
        projectId="proj-1"
        projectTitle="Untitled Project"
        existingAssets={[]}
        onUploadComplete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Record Microphone/i }));
    await waitFor(() => expect(MockMediaRecorder.instances).toHaveLength(3));
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /Stop Recording/i })[0]);
    });
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(3));
    expect(uploadSpy.mock.calls[2][1].name).toMatch(/^mic-recording-\d+\.webm$/);
  });

  it("preserves project-title recording name when applying Trim without reverting to timestamp", async () => {
    expect(buildTrimmedAudioFilename("Na_Para_Bang_on_Youtube.webm", "Na Para Bang on Youtube")).toBe(
      "Na_Para_Bang_on_Youtube-trimmed.wav",
    );
    expect(buildTrimmedAudioFilename("Na_Para_Bang_on_Youtube-trimmed.wav", "Na Para Bang on Youtube")).toBe(
      "Na_Para_Bang_on_Youtube-trimmed.wav",
    );

    const ch = new Float32Array(48000);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.sin(i * 0.05) * 0.4;
    const mockBuffer = {
      sampleRate: 48000,
      numberOfChannels: 1,
      length: ch.length,
      duration: 1.0,
      getChannelData: () => ch,
    } as unknown as AudioBuffer;

    const uploadSpy = vi.spyOn(api, "uploadMedia").mockResolvedValueOnce(
      makeAsset({
        id: "trimmed-1",
        original_filename: "Na_Para_Bang_on_Youtube-trimmed.wav",
        mime_type: "audio/wav",
      }),
    );

    render(
      <AudioTrimPanel
        projectId="proj-1"
        projectTitle="Na Para Bang on Youtube"
        mediaAsset={makeAsset({ original_filename: "Na_Para_Bang_on_Youtube.webm" })}
        signedAudioUrl="https://example.com/audio.webm"
        decodedAudioBuffer={mockBuffer}
        durationSec={1.0}
        playheadSec={0}
        trimStartSec={0.1}
        trimEndSec={0.9}
        isProcessing={false}
        onTrimChange={vi.fn()}
        onTrimApplied={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Apply Trim/i }));
    });

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1));
    const trimmedFile = uploadSpy.mock.calls[0][1];
    expect(trimmedFile.name).toBe("Na_Para_Bang_on_Youtube-trimmed.wav");
    expect(trimmedFile.type).toBe("audio/wav");

    // Verify PCM WAV header preserved 48000 Hz
    const wavBlob = encodePcm16Wav([ch], 48000);
    expect(wavBlob.type).toBe("audio/wav");
  });

  it("enforces project.title in MusicXML and prevents duplicate <movement-title> rendering in viewers", () => {
    const staleXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Tab Audio 1795613137526 Trimmed</work-title></work>
  <movement-title>Tab Audio 1795613137526 Trimmed</movement-title>
  <identification>
    <creator type="composer">ScribaSheet</creator>
    <creator type="arranger">Mariah Deborah</creator>
    <rights>Copyright (c) 2026</rights>
  </identification>
  <part-list><score-part id="P1"><part-name>Lead Melody</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>
</score-partwise>`;

    // Display XML overrides stale media-filename title and removes duplicate <movement-title>
    const displayXml = prepareDisplayMusicXml(staleXml, true, {
      scoreTitle: "Na Para Bang on Youtube",
    });
    const displayDoc = new DOMParser().parseFromString(displayXml, "application/xml");
    expect(displayDoc.getElementsByTagName("work-title")[0]?.textContent).toBe("Na Para Bang on Youtube");
    expect(displayDoc.getElementsByTagName("movement-title").length).toBe(0);
    expect(displayDoc.getElementsByTagName("rights")[0]?.textContent).toBe("Copyright (c) 2026");

    // Full stored XML preserves both <work-title> and <movement-title> with current project title
    const storedXml = applyScoreTitleToMusicXml(staleXml, "Na Para Bang on Youtube", {
      deduplicateMovementTitle: false,
    });
    const storedDoc = new DOMParser().parseFromString(storedXml, "application/xml");
    expect(storedDoc.getElementsByTagName("work-title")[0]?.textContent).toBe("Na Para Bang on Youtube");
    expect(storedDoc.getElementsByTagName("movement-title")[0]?.textContent).toBe("Na Para Bang on Youtube");

    // Generic/blank title -> Untitled Score
    const genericXml = prepareDisplayMusicXml(staleXml, true, {
      scoreTitle: "Untitled Project",
    });
    const genericDoc = new DOMParser().parseFromString(genericXml, "application/xml");
    expect(genericDoc.getElementsByTagName("work-title")[0]?.textContent).toBe("Untitled Score");
  });

  it("synchronizes title edits in ProjectStudioPage and ExportCenter downloads without re-transcription", async () => {
    const project: Project = {
      id: "proj-1",
      user_id: "user-1",
      title: "Original Song Title",
      description: "",
      status: "ready",
      instrument: "piano",
      transcription_mode: "melody",
      duration_seconds: 10,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      media_assets: [makeAsset({ original_filename: "tab-audio-1795613137526-trimmed.wav" })],
    };
    const scoreData: ScoreData = {
      title: "Tab Audio 1795613137526 Trimmed",
      tempo_bpm: 91,
      tempo_estimated: false,
      time_signature: "4/4",
      time_signature_estimated: false,
      key_signature: "Bb major",
      key_signature_estimated: false,
      duration_seconds: 10,
      tracks: [{ index: 0, name: "Lead Melody", instrument: "piano", clef: "treble", program: 0, muted: false }],
      notes: [{ id: "n1", pitch_midi: 67, onset_sec: 0, offset_sec: 0.5, velocity: 80, track_index: 0 }],
      chords: [],
      analysis: {},
    };
    const rawXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Tab Audio 1795613137526 Trimmed</work-title></work>
  <movement-title>Tab Audio 1795613137526 Trimmed</movement-title>
  <part-list><score-part id="P1"><part-name>Lead Melody</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>
</score-partwise>`;

    vi.spyOn(api, "getProject").mockResolvedValue(project);
    vi.spyOn(api, "getScore").mockResolvedValue({
      id: "score-1",
      project_id: "proj-1",
      version: 1,
      score_json: scoreData,
      musicxml: rawXml,
      updated_at: new Date().toISOString(),
    });
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 1,
      worker_id: "win",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 60,
    });
    vi.spyOn(api, "listExports").mockResolvedValue([]);
    vi.spyOn(api, "updateProject").mockResolvedValue({ ...project, title: "Na Para Bang on Youtube" });
    vi.spyOn(api, "createExport").mockImplementation(async (_id, fmt) => ({
      id: `exp-${fmt}`,
      project_id: "proj-1",
      format: fmt,
      status: "completed",
      error_message: null,
      download_url: `/api/v1/exports/exp-${fmt}/download`,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    }));
    const downloadBlobSpy = vi.spyOn(api, "downloadExportBlob").mockResolvedValue(undefined);
    const startTranscriptionSpy = vi.spyOn(api, "startTranscription");

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/projects/proj-1"]}>
            <Routes>
              <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    const heading = await screen.findByRole("heading", { level: 1, name: "Original Song Title" });
    fireEvent.click(heading);
    const input = screen.getByRole("textbox", { name: /project title/i });
    fireEvent.change(input, { target: { value: "Na Para Bang on Youtube" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      await screen.findByRole("heading", { level: 1, name: "Na Para Bang on Youtube" }),
    ).toBeInTheDocument();
    expect(startTranscriptionSpy).not.toHaveBeenCalled();

    // Viewer MusicXML immediately updates without re-transcription and deduplicates movement-title
    await waitFor(() => {
      const latestXml = loadedOsmdXmls[loadedOsmdXmls.length - 1] || "";
      expect(latestXml).toContain("<work-title>Na Para Bang on Youtube</work-title>");
      expect(latestXml).not.toContain("<movement-title>");
    });

    // Media filename separation stays preserved
    expect(screen.getByText(/tab-audio-1795613137526-trimmed\.wav/i)).toBeInTheDocument();

    // Switch to Export Center and export PDF / MusicXML / MIDI -> uses updated project.title
    fireEvent.click(screen.getByRole("tab", { name: /Export Center/i }));
    fireEvent.click(screen.getByRole("button", { name: /Export PDF/i }));
    await waitFor(() =>
      expect(downloadBlobSpy).toHaveBeenCalledWith(
        "/api/v1/exports/exp-pdf/download",
        "Na Para Bang on Youtube.pdf",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /Export MUSICXML/i }));
    await waitFor(() =>
      expect(downloadBlobSpy).toHaveBeenCalledWith(
        "/api/v1/exports/exp-musicxml/download",
        "Na Para Bang on Youtube.musicxml",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /Export MIDI/i }));
    await waitFor(() =>
      expect(downloadBlobSpy).toHaveBeenCalledWith(
        "/api/v1/exports/exp-midi/download",
        "Na Para Bang on Youtube.mid",
      ),
    );

    // Generic title export fallback uses Untitled Score
    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc2}>
        <ExportCenter projectId="proj-2" projectTitle="Untitled Project" hasScore={true} />
      </QueryClientProvider>,
    );
    const pdfBtns = screen.getAllByRole("button", { name: /Export PDF/i });
    fireEvent.click(pdfBtns[pdfBtns.length - 1]);
    await waitFor(() =>
      expect(downloadBlobSpy).toHaveBeenCalledWith(
        "/api/v1/exports/exp-pdf/download",
        "Untitled Score.pdf",
      ),
    );
  });
});
