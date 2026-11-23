import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBadge } from "@/components/ui/Badge";
import { WorkerControlPanel } from "@/components/WorkerControlPanel";
import { WorkerStatusBadge } from "@/components/WorkerStatusBadge";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { api } from "@/services/api";

vi.mock("@/features/auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "user@example.com", display_name: "James De Guzman", is_unlimited: false },
    usage: {
      plan_tier: "pro",
      monthly_minutes_used: 12,
      monthly_minutes_limit: 120,
      project_count: 2,
      project_limit: 20,
      storage_used_mb: 10,
      storage_limit_mb: 500,
    },
    logout: vi.fn(),
  }),
}));

describe("Dashboard Light Mode Status Badges & Header Spacing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders high-contrast Light Mode and preserved Dark Mode classes for Ready, Processing, Queued, and Failed badges", () => {
    render(
      <div>
        <StatusBadge status="ready" />
        <StatusBadge status="processing" />
        <StatusBadge status="queued" />
        <StatusBadge status="failed" />
      </div>,
    );

    const ready = screen.getByText("ready");
    expect(ready.className).toContain("bg-emerald-50");
    expect(ready.className).toContain("text-emerald-800");
    expect(ready.className).toContain("border-emerald-300");
    expect(ready.className).toContain("font-semibold");
    expect(ready.className).toContain("dark:bg-emerald-500/15");
    expect(ready.className).toContain("dark:text-emerald-300");

    const processing = screen.getByText("processing");
    expect(processing.className).toContain("bg-amber-50");
    expect(processing.className).toContain("text-amber-800");
    expect(processing.className).toContain("border-amber-300");

    const queued = screen.getByText("queued");
    expect(queued.className).toContain("bg-amber-50");
    expect(queued.className).toContain("text-amber-800");
    expect(queued.className).toContain("border-amber-300");

    const failed = screen.getByText("failed");
    expect(failed.className).toContain("bg-red-50");
    expect(failed.className).toContain("text-red-800");
    expect(failed.className).toContain("border-red-300");
  });

  it("renders Desktop Worker Online badge and Railway Heartbeat Online with accessible Light Mode emerald contrast", async () => {
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 5,
      worker_id: "win-1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 45,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <WorkerStatusBadge />
        <WorkerControlPanel />
      </QueryClientProvider>,
    );

    const badge = await screen.findByTestId("worker-status-badge");
    expect(badge.className).toContain("bg-emerald-50");
    expect(badge.className).toContain("text-emerald-800");
    expect(badge.className).toContain("border-emerald-300");
    expect(badge.className).toContain("font-semibold");
    expect(badge.className).toContain("dark:bg-emerald-500/15");
    expect(badge.className).toContain("dark:text-emerald-300");

    const dot = badge.querySelector("span");
    expect(dot?.className).toContain("bg-emerald-600");
    expect(dot?.className).toContain("dark:bg-emerald-400");

    const onlineText = await screen.findByText("Online");
    expect(onlineText.className).toContain("text-emerald-700");
    expect(onlineText.className).toContain("font-semibold");
    expect(onlineText.className).toContain("dark:text-emerald-400");
  });

  it("provides top clearance below the sticky navbar for the Dashboard heading and CTA buttons", async () => {
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 5,
      worker_id: "win-1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 45,
    });
    vi.spyOn(api, "listProjects").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 20,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <DashboardPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const heading = await screen.findByText(/Welcome back, James De Guzman/i);
    expect(heading).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sheet Music to Audio/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New Transcription/i })).toBeInTheDocument();

    const dashboardWrapper = container.querySelector(".max-w-7xl.pt-10");
    expect(dashboardWrapper).not.toBeNull();
    expect(dashboardWrapper?.className).toContain("sm:pt-12");
  });

  it("renders crisp Light Mode hover classes on Rename, Duplicate, and Delete project card icon buttons", async () => {
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 5,
      worker_id: "win-1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 45,
    });
    vi.spyOn(api, "listProjects").mockResolvedValue({
      items: [
        {
          id: "proj-card-1",
          user_id: "u1",
          title: "Closer Piano Cover",
          description: "",
          status: "ready",
          instrument: "piano",
          transcription_mode: "single_instrument",
          duration_seconds: 120,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          media_assets: [],
        },
      ],
      total: 1,
      page: 1,
      page_size: 20,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <DashboardPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const renameBtn = await screen.findByRole("button", { name: "Rename project" });
    const duplicateBtn = screen.getByRole("button", { name: "Duplicate project" });
    const deleteBtn = screen.getByRole("button", { name: "Delete project" });

    for (const btn of [renameBtn, duplicateBtn]) {
      expect(btn.className).toContain("text-stone-600");
      expect(btn.className).toContain("hover:bg-violet-50");
      expect(btn.className).toContain("hover:text-violet-700");
      expect(btn.className).toContain("hover:border-violet-200");
      expect(btn.className).toContain("dark:text-slate-400");
      expect(btn.className).toContain("dark:hover:bg-white/10");
      expect(btn.className).toContain("dark:hover:text-white");
    }

    expect(deleteBtn.className).toContain("text-stone-600");
    expect(deleteBtn.className).toContain("hover:bg-rose-50");
    expect(deleteBtn.className).toContain("hover:text-rose-700");
    expect(deleteBtn.className).toContain("hover:border-rose-200");
    expect(deleteBtn.className).toContain("dark:hover:bg-rose-500/15");
    expect(deleteBtn.className).toContain("dark:hover:text-rose-300");
  });
});
