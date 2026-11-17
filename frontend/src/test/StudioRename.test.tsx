import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { api } from "@/services/api";
import type { Project } from "@/types/api";

const baseProject: Project = {
  id: "proj-1",
  user_id: "user-1",
  title: "With Him I'll Know to Testify and Live",
  description: "",
  status: "draft",
  instrument: "piano",
  transcription_mode: "single_instrument",
  duration_seconds: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  media_assets: [],
};

describe("Studio Header inline project renaming", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "getProject").mockResolvedValue({ ...baseProject });
    vi.spyOn(api, "getScore").mockRejectedValue(new Error("No score"));
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 1,
      worker_id: "win-local",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 60,
    });
    vi.spyOn(api, "listExports").mockResolvedValue([]);
  });

  function renderStudio() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
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
  }

  it("enters edit mode via title click or pencil button, selects text, saves once on Enter+Blur, and shows Renamed", async () => {
    const updateSpy = vi.spyOn(api, "updateProject").mockResolvedValue({
      ...baseProject,
      title: "Christmas Medley - O Come All Ye Faithful",
    });

    renderStudio();

    const heading = await screen.findByRole("heading", { level: 1, name: baseProject.title });
    const header = screen.getByTestId("studio-header");
    expect(header.className).toContain("min-w-0");

    // Click heading to enter edit mode
    fireEvent.click(heading);
    const input = screen.getByRole("textbox", { name: /project title/i }) as HTMLInputElement;
    expect(input.value).toBe(baseProject.title);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(baseProject.title.length);

    // Change value and press Enter followed by Blur -> only 1 API call
    fireEvent.change(input, { target: { value: "  Christmas Medley - O Come All Ye Faithful  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy).toHaveBeenCalledWith("proj-1", {
        title: "Christmas Medley - O Come All Ye Faithful",
      });
    });

    expect(await screen.findByText(/renamed/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Christmas Medley - O Come All Ye Faithful" })).toBeInTheDocument();

    // Pencil button also opens edit mode
    fireEvent.click(screen.getByRole("button", { name: /rename project/i }));
    expect(screen.getByRole("textbox", { name: /project title/i })).toBeInTheDocument();
  });

  it("saves on Blur, cancels on Escape, ignores empty/unchanged titles, and restores on API failure", async () => {
    const updateSpy = vi
      .spyOn(api, "updateProject")
      .mockResolvedValueOnce({ ...baseProject, title: "Updated via Blur" })
      .mockRejectedValueOnce(new Error("Network error"));
    const startTranscriptionSpy = vi.spyOn(api, "startTranscription");

    renderStudio();
    await screen.findByRole("heading", { level: 1, name: baseProject.title });

    // Escape cancels without API call
    fireEvent.click(screen.getByRole("button", { name: /rename project/i }));
    let input = screen.getByRole("textbox", { name: /project title/i });
    fireEvent.change(input, { target: { value: "Temp Title" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: baseProject.title })).toBeInTheDocument();

    // Empty title rejected without API call
    fireEvent.click(screen.getByRole("button", { name: /rename project/i }));
    input = screen.getByRole("textbox", { name: /project title/i });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(updateSpy).not.toHaveBeenCalled();

    // Unchanged title ignored without API call
    fireEvent.click(screen.getByRole("button", { name: /rename project/i }));
    input = screen.getByRole("textbox", { name: /project title/i });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(updateSpy).not.toHaveBeenCalled();

    // Blur saves valid title
    fireEvent.click(screen.getByRole("button", { name: /rename project/i }));
    input = screen.getByRole("textbox", { name: /project title/i });
    fireEvent.change(input, { target: { value: "Updated via Blur" } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Updated via Blur" })).toBeInTheDocument();

    // API failure restores previous title and shows error alert
    fireEvent.click(screen.getByRole("button", { name: /rename project/i }));
    input = screen.getByRole("textbox", { name: /project title/i });
    fireEvent.change(input, { target: { value: "Will Fail" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent(/failed to rename project/i);
    expect(screen.getByRole("heading", { level: 1, name: "Updated via Blur" })).toBeInTheDocument();
    expect(startTranscriptionSpy).not.toHaveBeenCalled();
  });
});
