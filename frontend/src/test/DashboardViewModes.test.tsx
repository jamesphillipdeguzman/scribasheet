import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as AuthCtx from "@/features/auth/AuthContext";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { DASHBOARD_VIEW_STORAGE_KEY } from "@/features/dashboard/ProjectViews";
import { api } from "@/services/api";
import type { Project } from "@/types/api";

function makeProject(id: string, title: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    user_id: "u1",
    title,
    description: "",
    status: "ready",
    instrument: "piano",
    transcription_mode: "piano",
    duration_seconds: 125,
    created_at: "2026-11-26T10:00:00Z",
    updated_at: "2026-11-27T12:00:00Z",
    media_assets: [],
    ...overrides,
  };
}

const sampleProjects: Project[] = [
  makeProject("p1", "Prelude in C Major", { status: "ready", instrument: "piano", duration_seconds: 95 }),
  makeProject("p2", "Choir Hymn SATB", {
    status: "draft",
    instrument: "vocals",
    transcription_mode: "satb_pdf",
    duration_seconds: null,
  }),
  makeProject("p3", "Jazz Sketch", {
    status: "failed",
    instrument: "acoustic_guitar",
    transcription_mode: "midi_playground",
    duration_seconds: 184,
  }),
];

const mockUser = {
  id: "u1",
  email: "pianist@example.com",
  display_name: "Clara Schumann",
  email_verified: true,
  plan_tier: "free",
  is_unlimited: false,
  plan_label: "FREE",
  created_at: "",
  updated_at: "",
};

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/projects/:projectId" element={<div data-testid="studio-route">Studio Opened</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}

describe("Dashboard Project View Modes (Grid, List, Carousel)", () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    vi.spyOn(AuthCtx, "useAuth").mockReturnValue({
      user: mockUser,
      usage: null,
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      refreshUser: vi.fn(),
    });
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 2,
      worker_id: "w-1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 45,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("defaults to Grid, persists selection to localStorage, and falls back to Grid on invalid values", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue({
      items: sampleProjects,
      total: sampleProjects.length,
      page: 1,
      page_size: 20,
    });

    const firstRender = renderDashboard();
    const gridContainer = await screen.findByTestId("projects-grid-view");
    expect(gridContainer).toHaveClass("grid", "grid-cols-1", "md:grid-cols-2", "lg:grid-cols-3", "gap-4");

    const gridBtn = screen.getByTestId("view-mode-grid");
    const listBtn = screen.getByTestId("view-mode-list");
    const carouselBtn = screen.getByTestId("view-mode-carousel");
    expect(gridBtn).toHaveAttribute("aria-pressed", "true");
    expect(gridBtn).toHaveAttribute("aria-label", "Grid view");
    expect(listBtn).toHaveAttribute("title", "List view");
    expect(carouselBtn).toHaveAttribute("aria-label", "Carousel view");
    expect(gridBtn.className).toContain("dark:bg-[#8B5CF6]");

    // Switch to List -> persisted to localStorage
    fireEvent.click(listBtn);
    expect(screen.getByTestId("projects-list-view")).toBeInTheDocument();
    expect(window.localStorage.getItem(DASHBOARD_VIEW_STORAGE_KEY)).toBe("list");
    firstRender.unmount();

    // Re-mount restores List mode
    const secondRender = renderDashboard();
    await waitFor(() => expect(screen.getByTestId("projects-list-view")).toBeInTheDocument());
    expect(screen.getByTestId("view-mode-list")).toHaveAttribute("aria-pressed", "true");
    secondRender.unmount();

    // Invalid stored value falls back cleanly to Grid
    window.localStorage.setItem(DASHBOARD_VIEW_STORAGE_KEY, "invalid_mode");
    renderDashboard();
    await waitFor(() => expect(screen.getByTestId("projects-grid-view")).toBeInTheDocument());
    expect(screen.getByTestId("view-mode-grid")).toHaveAttribute("aria-pressed", "true");
  });

  it("preserves search, status, and sort filters while switching views and renders List metadata & Carousel controls cleanly", async () => {
    let currentItems = [...sampleProjects];
    const listSpy = vi.spyOn(api, "listProjects").mockImplementation(async (params) => {
      let filtered = [...currentItems];
      if (params?.search) {
        const q = String(params.search).toLowerCase();
        filtered = filtered.filter((p) => p.title.toLowerCase().includes(q));
      }
      if (params?.status) {
        filtered = filtered.filter((p) => p.status === params.status);
      }
      if (params?.sort_by === "title") {
        filtered.sort((a, b) => a.title.localeCompare(b.title));
      }
      return { items: filtered, total: filtered.length, page: 1, page_size: 20 };
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/dashboard"]}>
          <Routes>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/projects/:projectId" element={<div data-testid="studio-route">Studio Opened</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByTestId("projects-grid-view");

    // Set Sort = Title (A-Z) & verify switcher sits cleanly in List mode with all metadata
    fireEvent.change(screen.getByLabelText("Sort projects"), { target: { value: "title" } });
    fireEvent.click(screen.getByTestId("view-mode-list"));
    const listView = await screen.findByTestId("projects-list-view");
    expect(within(listView).getByText("Choir Hymn SATB")).toBeInTheDocument();
    expect(within(listView).getByText("1:35")).toBeInTheDocument();
    expect(within(listView).getByText("acoustic guitar", { exact: false })).toBeInTheDocument();
    expect(listSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort_by: "title", sort_dir: "asc" }),
    );

    // Switch to Carousel -> filter/sort remain intact
    fireEvent.click(screen.getByTestId("view-mode-carousel"));
    expect((screen.getByLabelText("Sort projects") as HTMLSelectElement).value).toBe("title");
    const track = screen.getByTestId("projects-carousel-track");
    expect(track).toHaveClass("flex", "overflow-x-auto", "snap-x", "snap-mandatory", "gap-4", "scroll-smooth");
    expect(screen.getByTestId("carousel-position")).toHaveTextContent("1 / 3");
    expect(screen.getByTestId("carousel-prev-btn")).toBeDisabled();
    expect(screen.getByTestId("carousel-next-btn")).toBeEnabled();

    // Button + keyboard navigation update active position cleanly
    fireEvent.click(screen.getByTestId("carousel-next-btn"));
    expect(screen.getByTestId("carousel-position")).toHaveTextContent("2 / 3");
    expect(screen.getByTestId("carousel-prev-btn")).toBeEnabled();

    fireEvent.keyDown(track, { key: "ArrowRight" });
    expect(screen.getByTestId("carousel-position")).toHaveTextContent("3 / 3");
    expect(screen.getByTestId("carousel-next-btn")).toBeDisabled();

    fireEvent.keyDown(track, { key: "ArrowLeft" });
    expect(screen.getByTestId("carousel-position")).toHaveTextContent("2 / 3");

    // Narrow filter to 1 item -> active carousel position clamps cleanly to 1 / 1
    currentItems = [sampleProjects[0]];
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "ready" } });
    await waitFor(() => expect(screen.getByTestId("carousel-position")).toHaveTextContent("1 / 1"));
    expect(screen.getByTestId("carousel-prev-btn")).toBeDisabled();
    expect(screen.getByTestId("carousel-next-btn")).toBeDisabled();

    // Empty search result renders existing empty state regardless of selected view
    fireEvent.change(screen.getByPlaceholderText("Search projects by title..."), {
      target: { value: "Nonexistent Sonata" },
    });
    await waitFor(() => expect(screen.getByText("No transcription projects yet")).toBeInTheDocument());
  });

  it("supports all five project actions consistently across List and Carousel views", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue({
      items: sampleProjects,
      total: sampleProjects.length,
      page: 1,
      page_size: 20,
    });
    const renameSpy = vi.spyOn(api, "updateProject").mockResolvedValue(sampleProjects[0]);
    const duplicateSpy = vi.spyOn(api, "duplicateProject").mockResolvedValue(sampleProjects[0]);
    const deleteSpy = vi.spyOn(api, "deleteProject").mockResolvedValue(undefined);

    for (const mode of ["list", "carousel"] as const) {
      window.localStorage.setItem(DASHBOARD_VIEW_STORAGE_KEY, mode);
      const { unmount } = renderDashboard();
      const firstContainer =
        mode === "list"
          ? await screen.findByTestId("project-list-row-p1")
          : await screen.findByTestId("carousel-card-p1");

      // Rename
      fireEvent.click(within(firstContainer).getByRole("button", { name: "Rename project" }));
      const renameInput = within(firstContainer).getByDisplayValue("Prelude in C Major");
      fireEvent.change(renameInput, { target: { value: "Prelude Revised" } });
      fireEvent.click(within(firstContainer).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(renameSpy).toHaveBeenCalledWith("p1", { title: "Prelude Revised" }));

      // Archive (.scribasheet) modal opens
      fireEvent.click(within(firstContainer).getByTestId("archive-project-p1"));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape" });

      // Duplicate & Delete
      fireEvent.click(within(firstContainer).getByRole("button", { name: "Duplicate project" }));
      await waitFor(() => expect(duplicateSpy).toHaveBeenCalledWith("p1"));

      fireEvent.click(within(firstContainer).getByRole("button", { name: "Delete project" }));
      await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith("p1"));

      // Open Studio
      fireEvent.click(within(firstContainer).getByRole("button", { name: "Open Studio" }));
      expect(await screen.findByTestId("studio-route")).toBeInTheDocument();
      unmount();
    }
  });
});
