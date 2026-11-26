import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerControlPanel } from "@/components/WorkerControlPanel";
import { PNA_BLOCKED_MESSAGE, workerController } from "@/services/workerController";

vi.mock("@/services/api", () => ({
  api: {
    getWorkerStatus: vi.fn().mockResolvedValue({
      worker_online: false,
      status: "offline",
      active_job_count: 0,
      queue_depth: 0,
      last_seen_seconds_ago: null,
      worker_version: null,
      worker_host: null,
      worker_pid: null,
    }),
  },
  isAuthError: () => false,
}));

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WorkerControlPanel />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Worker controller PNA / Local Network Access handling", () => {
  it("uses clean CORS fetch options and classifies denied Local Network Access as pna_blocked", async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      new TypeError("Permission was denied for this request to access the 'loopback' address space."),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(workerController.checkHealth()).rejects.toMatchObject({
      status: 0,
      code: "pna_blocked",
      message: PNA_BLOCKED_MESSAGE,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/health$/);
    expect(init.mode).toBe("cors");
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    expect("targetAddressSpace" in init).toBe(false);
  });

  it("shows actionable Chrome/Edge and Brave PNA permission UI and supports retry when blocked", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ controller_online: true, requires_pairing: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    );
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: vi.fn().mockResolvedValue({ state: "denied" }),
      },
    });
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 Chrome/134.0.0.0 Safari/537.36",
    });

    renderPanel();

    const blockedNotice = await screen.findByTestId("local-controller-blocked-notice");
    expect(blockedNotice.textContent).toContain(PNA_BLOCKED_MESSAGE);
    expect(blockedNotice.textContent).toMatch(/Chrome \/ Edge/i);
    expect(blockedNotice.textContent).toMatch(/Local network access/i);
    expect(blockedNotice.textContent).toMatch(/Brave/i);

    fireEvent.click(screen.getByRole("button", { name: /Retry Connection/i }));
    await waitFor(() => {
      expect(screen.getByText(/Pair Local Controller/i)).toBeTruthy();
    });
  });

  it("renders Brave-specific heading first when Brave is detected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: vi.fn().mockResolvedValue({ state: "denied" }),
      },
    });
    Object.defineProperty(navigator, "brave", {
      configurable: true,
      value: { isBrave: async () => true },
    });

    renderPanel();

    const blockedNotice = await screen.findByTestId("local-controller-blocked-notice");
    expect(blockedNotice.textContent).toContain("How to allow in Brave:");
  });

  it("classifies genuine localhost connection failure as network_offline without showing a false PNA warning", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: vi.fn().mockResolvedValue({ state: "granted" }),
      },
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(/Local Controller Not Connected/i)).toBeTruthy();
    });
    expect(screen.queryByTestId("local-controller-blocked-notice")).toBeNull();
  });

  it("shows LNA hint alongside install instructions when HTTPS remote origin gets generic fetch failure", async () => {
    const origLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...origLocation,
        hostname: "scribasheet.vercel.app",
        protocol: "https:",
      },
    });
    try {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
      Object.defineProperty(navigator, "permissions", {
        configurable: true,
        value: {
          query: vi.fn().mockResolvedValue({ state: "prompt" }),
        },
      });

      renderPanel();

      await waitFor(() => {
        expect(screen.getByText(/Local Controller Not Connected/i)).toBeTruthy();
      });
      expect(screen.getByTestId("local-network-access-hint")).toBeTruthy();
      expect(screen.queryByTestId("local-controller-blocked-notice")).toBeNull();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: origLocation,
      });
    }
  });
});
