import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as AuthCtx from "@/features/auth/AuthContext";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { ExportCenter } from "@/features/editor/ExportCenter";
import { MediaUploader } from "@/features/uploads/MediaUploader";
import { api } from "@/services/api";
import type { Project } from "@/types/api";

const baseUser = {
  id: "u1",
  email: "musician@example.com",
  display_name: "Ada Pianist",
  email_verified: true,
  plan_tier: "free",
  is_unlimited: false,
  plan_label: "FREE",
  created_at: "",
  updated_at: "",
};

const baseUsage = {
  plan_tier: "free",
  plan_label: "FREE",
  is_unlimited: false,
  monthly_minutes_used: 5,
  monthly_minutes_limit: 30,
  project_count: 1,
  project_limit: null,
  file_count: 3,
  storage_used_bytes: 1024 * 1024,
  storage_used_mb: 1,
  storage_limit_mb: null,
  storage_quota_enforced: false,
  storage_status: "available",
};

const sampleProject: Project = {
  id: "proj-orig",
  user_id: "u1",
  title: "River Flows Archive",
  description: "",
  status: "ready",
  instrument: "piano",
  transcription_mode: "polyphonic",
  duration_seconds: 60,
  created_at: "2026-11-27T00:00:00Z",
  updated_at: "2026-11-27T00:00:00Z",
  media_assets: [],
};

function renderWithRouter(ui: React.ReactElement, initialPath = "/dashboard") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/dashboard" element={ui} />
          <Route path="/projects/:projectId" element={<div data-testid="studio-route">Restored Studio View</div>} />
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Portable .scribasheet Project Archive & Restore UI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ExportCenter provides Archive Session (.scribasheet), Include Original Audio toggle, warning when disabled, and non-destructive reminder", async () => {
    vi.spyOn(AuthCtx, "useAuth").mockReturnValue({
      user: baseUser,
      usage: baseUsage,
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      refreshUser: vi.fn(),
    });
    vi.spyOn(api, "listExports").mockResolvedValue([]);
    vi.spyOn(api, "getProjectArchiveSummary").mockImplementation(async (_pid, incAudio = true) => ({
      project_id: "proj-orig",
      title: "River Flows Archive",
      source_type: "audio_transcription",
      has_score: true,
      include_audio: incAudio,
      available_media_count: 1,
      included_media_count: incAudio ? 1 : 0,
      available_media_bytes: 2 * 1024 * 1024,
      included_media_bytes: incAudio ? 2 * 1024 * 1024 : 0,
      media_files: incAudio
        ? [{ filename: "take.wav", asset_type: "original", mime_type: "audio/wav", size_bytes: 2 * 1024 * 1024 }]
        : [],
    }));
    const dlSpy = vi.spyOn(api, "downloadProjectArchive").mockResolvedValue({
      filename: "River-Flows-Archive.scribasheet",
      sizeBytes: 2048000,
      includedMedia: false,
    });
    const delSpy = vi.spyOn(api, "deleteProject");

    renderWithRouter(
      <ExportCenter
        projectId="proj-orig"
        projectTitle="River Flows Archive"
        hasScore={true}
      />,
      "/studio",
    );

    const toggle = await screen.findByTestId("export-archive-include-audio-toggle");
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("export-archive-audio-warning")).toHaveTextContent(
      /original recording cannot be recovered/i,
    );

    fireEvent.click(screen.getByTestId("export-center-archive-btn"));
    await waitFor(() => {
      expect(dlSpy).toHaveBeenCalledWith("proj-orig", "River Flows Archive", false);
      expect(screen.getByTestId("export-archive-success-notice")).toHaveTextContent(
        /Delete the cloud project separately/i,
      );
    });
    expect(delSpy).not.toHaveBeenCalled();
  });

  it("Dashboard allows importing a .scribasheet archive with preview & validation and navigates to the restored studio", async () => {
    const refreshMock = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(AuthCtx, "useAuth").mockReturnValue({
      user: baseUser,
      usage: baseUsage,
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      refreshUser: refreshMock,
    });
    vi.spyOn(api, "listProjects").mockResolvedValue({
      items: [sampleProject],
      total: 1,
      page: 1,
      page_size: 20,
    });
    vi.spyOn(api, "getProjectArchiveSummary").mockResolvedValue({
      project_id: "proj-orig",
      title: "River Flows Archive",
      source_type: "audio_transcription",
      has_score: true,
      include_audio: true,
      available_media_count: 1,
      included_media_count: 1,
      available_media_bytes: 1024,
      included_media_bytes: 1024,
      media_files: [],
    });
    vi.spyOn(api, "validateArchive").mockResolvedValue({
      valid: true,
      schema_version: 1,
      archive_format_version: "1.0",
      exported_at: "2026-11-27T00:00:00Z",
      original_project_id: "proj-orig",
      title: "Restored Nocturne",
      source_type: "midi_playground",
      has_score: true,
      included_media: true,
      original_audio_omitted: false,
      media_count: 1,
      total_media_bytes: 2048,
      included_files: ["manifest.json", "project.json", "score.musicxml", "score.mid", "media/01_take.wav"],
      tempo_bpm: 112,
      time_signature: "3/4",
      key_signature: "Bb Major",
      note_count: 48,
      chord_count: 6,
      has_lyrics: true,
      checksums_verified: true,
    });
    vi.spyOn(api, "importArchive").mockResolvedValue({
      ...sampleProject,
      id: "proj-restored-99",
      title: "Restored Nocturne",
    });

    renderWithRouter(<DashboardPage />);

    // Card exposes Archive Session action
    expect(await screen.findByTestId("archive-project-proj-orig")).toBeInTheDocument();

    // Open Import Archive modal from Dashboard
    fireEvent.click(screen.getByTestId("import-archive-btn"));
    expect(screen.getByTestId("archive-import-modal")).toBeInTheDocument();

    const fileInput = screen.getByTestId("archive-file-input") as HTMLInputElement;
    const archiveFile = new File([new Uint8Array([80, 75, 3, 4])], "Restored.scribasheet", {
      type: "application/zip",
    });
    fireEvent.change(fileInput, { target: { files: [archiveFile] } });

    await waitFor(() => {
      expect(screen.getByTestId("archive-import-preview")).toHaveTextContent("Restored Nocturne");
      expect(screen.getByTestId("archive-import-preview")).toHaveTextContent("Verified • SHA-256 Valid");
    });

    fireEvent.click(screen.getByTestId("confirm-import-archive-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("studio-route")).toBeInTheDocument();
      expect(refreshMock).toHaveBeenCalled();
    });
  });

  it("MediaUploader routes dropped .scribasheet files to onArchiveFileDrop without blocking normal media uploads", () => {
    const onArchiveDrop = vi.fn();
    render(
      <MediaUploader
        projectId="proj-1"
        existingAssets={[]}
        onUploadComplete={vi.fn()}
        onArchiveFileDrop={onArchiveDrop}
      />,
    );

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const archFile = new File([new Uint8Array([80, 75, 3, 4])], "Session.scribasheet", {
      type: "application/zip",
    });
    fireEvent.change(fileInput, { target: { files: [archFile] } });
    expect(onArchiveDrop).toHaveBeenCalledWith(archFile);
  });
});
