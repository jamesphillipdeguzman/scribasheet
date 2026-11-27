import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { MediaUploader } from "@/features/uploads/MediaUploader";
import { deriveProjectTitleFromFilename } from "@/lib/utils";
import { api } from "@/services/api";
import type { MediaAsset, Project } from "@/types/api";

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: function MockOSMD(container: HTMLElement) {
    return {
      Zoom: 1,
      GraphicSheet: { MeasureList: [] },
      cursor: { show: () => {}, hide: () => {}, reset: () => {}, next: () => {}, CursorOptions: {} },
      setOptions: () => {},
      clear: () => {
        container.innerHTML = "";
      },
      load: async () => {},
      render: () => {},
    };
  },
}));

function makeMediaAsset(overrides: Partial<MediaAsset>): MediaAsset {
  return {
    id: `asset-${Math.random().toString(36).slice(2, 8)}`,
    project_id: "proj-img-1",
    asset_type: "original",
    original_filename: "page1.jpg",
    mime_type: "image/jpeg",
    size_bytes: 20480,
    duration_seconds: null,
    sample_rate: null,
    channels: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("Sheet Music Image Upload (JPG, PNG, WebP, Multi-Page, Reorder & Title)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn((blob: File) => `blob:mock/${blob.name || "img"}`),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  it("derives default project titles cleanly from sheet filenames", () => {
    expect(deriveProjectTitleFromFilename("Clair_de_Lune_p1.jpg")).toBe("Clair de Lune p1");
    expect(deriveProjectTitleFromFilename("Ave-Maria-Scan.webp")).toBe("Ave-Maria-Scan");
    expect(deriveProjectTitleFromFilename("score.png")).toBe("Untitled Score");
  });

  it("uploads JPG, PNG, and WebP images via file input and drag-and-drop while rejecting unsupported files", async () => {
    const uploaded: MediaAsset[] = [];
    const uploadSpy = vi.spyOn(api, "uploadMedia").mockImplementation(async (_pid, file) => {
      const a = makeMediaAsset({
        id: `id-${file.name}`,
        original_filename: file.name,
        mime_type: file.type || "image/jpeg",
      });
      uploaded.push(a);
      return a;
    });
    vi.spyOn(api, "getSignedMediaUrl").mockResolvedValue({ url: "/mock/signed.png", expires_in: 300 });

    const { container, rerender } = render(
      <MediaUploader
        projectId="proj-img-1"
        existingAssets={uploaded}
        acceptPdf={true}
        onUploadComplete={() => {
          rerender(
            <MediaUploader
              projectId="proj-img-1"
              existingAssets={[...uploaded]}
              acceptPdf={true}
              onUploadComplete={vi.fn()}
            />,
          );
        }}
      />,
    );

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.multiple).toBe(true);
    expect(input.accept).toContain(".jpg");
    expect(input.accept).toContain(".png");
    expect(input.accept).toContain(".webp");
    expect(input.accept).toContain(".pdf");

    // 1. Single JPG file upload via input
    const jpgFile = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "Nocturne_p1.jpg", {
      type: "image/jpeg",
    });
    fireEvent.change(input, { target: { files: [jpgFile] } });
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1));

    // 2. Drag-and-drop WebP + PNG multi-page batch
    const dropzone = input.parentElement as HTMLElement;
    const pngFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "Nocturne_p2.png", {
      type: "image/png",
    });
    const webpFile = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], "Nocturne_p3.webp", {
      type: "image/webp",
    });
    fireEvent.drop(dropzone, { dataTransfer: { files: [pngFile, webpFile] } });
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(3));

    rerender(
      <MediaUploader
        projectId="proj-img-1"
        existingAssets={[...uploaded]}
        acceptPdf={true}
        onUploadComplete={vi.fn()}
      />,
    );

    expect(screen.getByTestId("sheet-image-page-list")).toBeInTheDocument();
    expect(screen.getByText("Sheet Music Pages (3)")).toBeInTheDocument();
    expect(screen.getByText("Nocturne_p1.jpg")).toBeInTheDocument();
    expect(screen.getByText("Nocturne_p2.png")).toBeInTheDocument();
    expect(screen.getByText("Nocturne_p3.webp")).toBeInTheDocument();
    expect(container.querySelectorAll('img[src^="blob:mock/"]').length).toBe(3);

    // 3. Rejects unsupported file extension without invoking uploadMedia
    const gifFile = new File([new Uint8Array([0x47, 0x49, 0x46])], "bad.gif", { type: "image/gif" });
    fireEvent.change(input, { target: { files: [gifFile] } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Unsupported file type/i));
    expect(uploadSpy).toHaveBeenCalledTimes(3);

    // 4. Existing PDF single-file upload continues working cleanly
    const pdfFile = new File(["%PDF-1.4\n%"], "Score.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [pdfFile] } });
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(4));
  });

  it("supports page reordering, removal, first-filename default project title, and ordered job start in Studio", async () => {
    const asset1 = makeMediaAsset({
      id: "page-id-1",
      original_filename: "Moonlight_Sonata_p1.jpg",
      mime_type: "image/jpeg",
      created_at: "2026-11-27T10:00:00Z",
    });
    const asset2 = makeMediaAsset({
      id: "page-id-2",
      original_filename: "Moonlight_Sonata_p2.webp",
      mime_type: "image/webp",
      created_at: "2026-11-27T10:01:00Z",
    });
    const asset3 = makeMediaAsset({
      id: "page-id-3",
      original_filename: "Moonlight_Sonata_p3.png",
      mime_type: "image/png",
      created_at: "2026-11-27T10:02:00Z",
    });

    const projectState: Project = {
      id: "proj-img-1",
      user_id: "user-1",
      title: "Untitled Transcription",
      description: "",
      status: "draft",
      instrument: "piano",
      transcription_mode: "satb_pdf",
      duration_seconds: null,
      created_at: "2026-11-27T09:59:00Z",
      updated_at: "2026-11-27T09:59:00Z",
      media_assets: [],
    };

    vi.spyOn(api, "getProject").mockImplementation(async () => ({
      ...projectState,
      media_assets: [...projectState.media_assets],
    }));
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
    vi.spyOn(api, "getScore").mockRejectedValue(new Error("No score"));
    vi.spyOn(api, "getLyrics").mockResolvedValue({ text: "", segments: [] } as never);
    vi.spyOn(api, "listExports").mockResolvedValue([]);
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 1,
      worker_id: "local-1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 30,
    });
    vi.spyOn(api, "getSignedMediaUrl").mockResolvedValue({ url: "/signed/mock.png", expires_in: 300 });
    const updateProjectSpy = vi.spyOn(api, "updateProject").mockImplementation(async (_id, data) => {
      if (data.title) projectState.title = data.title;
      return { ...projectState, media_assets: [...projectState.media_assets] };
    });
    vi.spyOn(api, "uploadMedia").mockImplementation(async (_pid, file) => {
      const next = file.name.includes("p1") ? asset1 : file.name.includes("p2") ? asset2 : asset3;
      projectState.media_assets = [...projectState.media_assets, next];
      return next;
    });
    const deleteMediaSpy = vi.spyOn(api, "deleteMediaAsset").mockImplementation(async (_pid, aid) => {
      projectState.media_assets = projectState.media_assets.filter((a) => a.id !== aid);
    });
    const startTransSpy = vi.spyOn(api, "startTranscription").mockResolvedValue({
      id: "job-img-1",
      project_id: "proj-img-1",
      user_id: "user-1",
      source_asset_id: "page-id-2",
      status: "queued",
      progress: 0,
      current_stage: "Queued",
      engine: "basic_pitch",
      settings_json: {
        mode: "satb_pdf",
        instrument: "piano",
        tempo_mode: "auto",
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
        satb_mode: "auto_satb",
        source_asset_ids: ["page-id-2", "page-id-1"],
      },
      error_code: null,
      error_message: null,
      started_at: null,
      completed_at: null,
      created_at: new Date().toISOString(),
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/projects/proj-img-1"]}>
            <Routes>
              <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("Untitled Transcription")).toBeInTheDocument());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const f1 = new File([new Uint8Array([0xff, 0xd8, 0xff])], "Moonlight_Sonata_p1.jpg", { type: "image/jpeg" });
    const f2 = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], "Moonlight_Sonata_p2.webp", {
      type: "image/webp",
    });
    const f3 = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "Moonlight_Sonata_p3.png", {
      type: "image/png",
    });

    fireEvent.change(input, { target: { files: [f1, f2, f3] } });

    // Default title is derived from the first uploaded image filename
    await waitFor(() => expect(updateProjectSpy).toHaveBeenCalledWith("proj-img-1", { title: "Moonlight Sonata p1" }));
    await waitFor(() => expect(screen.getByText("Moonlight_Sonata_p3.png")).toBeInTheDocument());

    // Verify page removal removes the unwanted page from the asset list before starting
    fireEvent.click(screen.getByTestId("remove-page-2"));
    await waitFor(() => expect(deleteMediaSpy).toHaveBeenCalledWith("proj-img-1", "page-id-3"));
    await waitFor(() => expect(screen.queryByText("Moonlight_Sonata_p3.png")).not.toBeInTheDocument());

    // Reorder page 2 above page 1
    fireEvent.click(screen.getByTestId("move-page-up-1"));

    // Start transcription and verify reordered source_asset_ids are sent
    const startBtn = screen.getByRole("button", { name: /Process Score/i });
    fireEvent.click(startBtn);

    await waitFor(() => expect(startTransSpy).toHaveBeenCalledTimes(1));
    const callArgs = startTransSpy.mock.calls[0];
    expect(callArgs[0]).toBe("proj-img-1");
    expect(callArgs[1]).toBe("page-id-2");
    expect(callArgs[2].source_asset_ids).toEqual(["page-id-2", "page-id-1"]);
    expect(callArgs[3]).toEqual(["page-id-2", "page-id-1"]);
  });
});
