import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerControlPanel } from "@/components/WorkerControlPanel";
import { WorkerStatusBadge } from "@/components/WorkerStatusBadge";
import { resetWorkerConnectionState } from "@/features/worker/useWorkerConnection";
import { api } from "@/services/api";
import { setControllerToken, workerController } from "@/services/workerController";

function ensureLocalStorage() {
  if (!window.localStorage) {
    const store: Record<string, string> = {};
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
        removeItem: (k: string) => {
          delete store[k];
        },
      },
    });
  }
}

describe("Desktop Worker Startup Feedback & Heartbeat Detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ensureLocalStorage();
    setControllerToken("test-token");
    resetWorkerConnectionState();
  });

  afterEach(() => {
    resetWorkerConnectionState();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("transitions Offline -> Connecting Desktop Worker... (1500ms polling + progress bar) -> Online on heartbeat", async () => {
    let railwayOnline = false;
    let localRunning = false;

    const getStatusSpy = vi.spyOn(api, "getWorkerStatus").mockImplementation(async () => ({
      worker_online: railwayOnline,
      status: railwayOnline ? "online" : "offline",
      last_seen_seconds: railwayOnline ? 1 : 120,
      worker_id: "win-1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 45,
    }));

    vi.spyOn(workerController, "checkHealth").mockResolvedValue({ status: "ok" } as any);
    vi.spyOn(workerController, "getStatus").mockImplementation(async () => ({
      worker_running: localRunning,
      managed_by_controller: true,
      external_worker_detected: false,
      external_manageable: true,
      pid: localRunning ? 1234 : null,
      last_error: null,
    } as any));
    vi.spyOn(workerController, "startWorker").mockImplementation(async () => {
      localRunning = true;
      return { message: "Worker started." } as any;
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <WorkerStatusBadge />
        <WorkerControlPanel />
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(screen.getByTestId("worker-status-badge")).toHaveAttribute("data-status", "offline");
    expect(screen.getByText("Desktop Worker Offline")).toBeInTheDocument();

    // Click Start Worker
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start Worker/i }));
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(screen.getByText("Worker started.")).toBeInTheDocument();
    expect(screen.getByTestId("worker-status-badge")).toHaveAttribute("data-status", "connecting");
    expect(screen.getByText("Connecting Desktop Worker...")).toBeInTheDocument();
    expect(screen.getByText("Connecting...")).toBeInTheDocument();
    expect(
      screen.getByText("Initializing Python worker & syncing heartbeat with Railway..."),
    ).toBeInTheDocument();

    const progressEl = screen.getByTestId("worker-connecting-progress");
    const bar = screen.getByRole("progressbar");
    expect(bar.className).toContain("bg-violet-100");
    expect(bar.className).toContain("dark:bg-violet-500/20");
    expect(bar.firstElementChild?.className).toContain("bg-violet-600");
    expect(bar.firstElementChild?.className).toContain("dark:bg-violet-400");
    expect(progressEl.textContent).toContain("%");

    const callsBeforePoll = getStatusSpy.mock.calls.length;
    // Advance 1,500ms -> accelerated polling triggers while still offline
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1550);
    });
    expect(getStatusSpy.mock.calls.length).toBeGreaterThan(callsBeforePoll);
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThan(10);

    // Heartbeat arrives on next 1,500ms poll
    railwayOnline = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1550);
    });

    expect(screen.getByTestId("worker-status-badge")).toHaveAttribute("data-status", "online");
    expect(screen.getByText("Desktop Worker Online")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Desktop worker connected!")).toBeInTheDocument();

    // After completion hold (~900ms), connecting indicator is removed
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByTestId("worker-connecting-progress")).not.toBeInTheDocument();
  });

  it("handles Restart Worker and 20-second heartbeat timeout cleanly without leaving connecting stuck", async () => {
    let railwayOnline = true;
    vi.spyOn(api, "getWorkerStatus").mockImplementation(async () => ({
      worker_online: railwayOnline,
      status: railwayOnline ? "online" : "offline",
      last_seen_seconds: 5,
      worker_id: "win-1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 45,
    }));
    vi.spyOn(workerController, "checkHealth").mockResolvedValue({ status: "ok" } as any);
    vi.spyOn(workerController, "getStatus").mockResolvedValue({
      worker_running: true,
      managed_by_controller: true,
      external_worker_detected: false,
      external_manageable: true,
      pid: 2222,
      last_error: null,
    } as any);
    vi.spyOn(workerController, "restartWorker").mockImplementation(async () => {
      railwayOnline = false;
      return { message: "Worker restarted." } as any;
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <WorkerStatusBadge />
        <WorkerControlPanel />
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Restart Worker/i }));
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(screen.getByText("Worker restarted.")).toBeInTheDocument();
    expect(screen.getByTestId("worker-status-badge")).toHaveAttribute("data-status", "connecting");

    // Advance past 20s timeout without heartbeat returning online
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_200);
    });

    expect(screen.getByTestId("worker-status-badge")).toHaveAttribute("data-status", "offline");
    expect(screen.getByText(/did not arrive within 20s/i)).toBeInTheDocument();
    expect(screen.queryByTestId("worker-connecting-progress")).not.toBeInTheDocument();
  });

  it("exits connecting state if the local worker process stops during initialization", async () => {
    let localRunning = false;
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: false,
      status: "offline",
      last_seen_seconds: 120,
      worker_id: "win-1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 45,
    });
    vi.spyOn(workerController, "checkHealth").mockResolvedValue({ status: "ok" } as any);
    vi.spyOn(workerController, "getStatus").mockImplementation(async () => ({
      worker_running: localRunning,
      managed_by_controller: true,
      external_worker_detected: false,
      external_manageable: true,
      pid: localRunning ? 3333 : null,
      last_error: null,
    } as any));
    vi.spyOn(workerController, "startWorker").mockImplementation(async () => {
      localRunning = true;
      return { message: "Worker started." } as any;
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <WorkerStatusBadge />
        <WorkerControlPanel />
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start Worker/i }));
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(screen.getByTestId("worker-status-badge")).toHaveAttribute("data-status", "connecting");

    // Simulate process crashing after 1.6s
    localRunning = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200);
    });

    expect(screen.getByTestId("worker-status-badge")).toHaveAttribute("data-status", "offline");
    expect(screen.getByText(/Worker process stopped during initialization/i)).toBeInTheDocument();
  });
});
