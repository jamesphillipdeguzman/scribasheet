import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportCenter } from "@/features/editor/ExportCenter";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import * as pdfPrintModule from "@/lib/pdfPrint";
import { printScorePdf } from "@/lib/pdfPrint";
import { api } from "@/services/api";
import type { Project, ProjectScoreResponse } from "@/types/api";

vi.mock("@/features/auth/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    user: { id: "u1", email: "user@example.com", display_name: "James", is_unlimited: false },
    usage: {
      plan_tier: "pro",
      monthly_minutes_used: 10,
      monthly_minutes_limit: 120,
      project_count: 1,
      project_limit: 20,
      storage_used_mb: 5,
      storage_limit_mb: 500,
    },
    isLoading: false,
    logout: vi.fn(),
  }),
}));

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: function MockOSMD() {
    return {
      load: async () => undefined,
      render: () => undefined,
      Dispose: () => undefined,
      Zoom: 1,
      EngravingRules: { RenderChordSymbols: true },
      cursor: {
        cursorElement: document.createElement("img"),
        show: () => undefined,
        hide: () => undefined,
        reset: () => undefined,
        next: () => undefined,
        update: () => undefined,
        GNotesUnderCursor: () => [],
        iterator: { EndReached: true, currentTimeStamp: { RealValue: 0 } },
      },
      GraphicSheet: { MeasureList: [] },
    };
  },
}));

describe("printScorePdf utility", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:mock-pdf-url");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
    document.querySelectorAll('[data-testid="pdf-print-iframe"]').forEach((el) => el.remove());
  });

  it("rejects empty or non-PDF blobs", async () => {
    await expect(printScorePdf(new Blob([], { type: "application/pdf" }))).rejects.toThrow(
      /empty or invalid/i,
    );
    await expect(printScorePdf(new Blob(["hello"], { type: "text/plain" }))).rejects.toThrow(
      /Expected a PDF document/i,
    );
  });

  it("loads PDF blob into hidden iframe, calls contentWindow.print(), and cleans up on afterprint", async () => {
    const pdfBlob = new Blob(["%PDF-1.4 mock"], { type: "application/pdf" });
    const printSpy = vi.fn();
    const focusSpy = vi.fn();
    const afterPrintListeners: Array<() => void> = [];

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const el = origCreateElement(tagName);
      if (tagName.toLowerCase() === "iframe") {
        Object.defineProperty(el, "contentWindow", {
          configurable: true,
          value: {
            focus: focusSpy,
            print: printSpy,
            addEventListener: (_evt: string, cb: () => void) => {
              afterPrintListeners.push(cb);
            },
          },
        });
      }
      return el;
    });

    const promise = printScorePdf(pdfBlob, { settleDelayMs: 5, cleanupTimeoutMs: 10000 });
    const iframe = document.querySelector('[data-testid="pdf-print-iframe"]') as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.src).toBe("blob:mock-pdf-url");

    iframe.onload?.(new Event("load"));
    await promise;

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(printSpy).toHaveBeenCalledTimes(1);

    // Simulate afterprint cleanup
    afterPrintListeners.forEach((cb) => cb());
    expect(document.querySelector('[data-testid="pdf-print-iframe"]')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-pdf-url");
  });

  it("falls back to opening PDF in a new tab if iframe printing throws, without calling window.print()", async () => {
    const pdfBlob = new Blob(["%PDF-1.4 mock"], { type: "application/pdf" });
    const windowPrintSpy = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const windowOpenSpy = vi.spyOn(window, "open").mockReturnValue({} as Window);

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const el = origCreateElement(tagName);
      if (tagName.toLowerCase() === "iframe") {
        Object.defineProperty(el, "contentWindow", {
          configurable: true,
          value: {
            focus: vi.fn(),
            print: () => {
              throw new Error("Blocked");
            },
            addEventListener: vi.fn(),
          },
        });
      }
      return el;
    });

    const promise = printScorePdf(pdfBlob, { settleDelayMs: 5, cleanupTimeoutMs: 10000 });
    const iframe = document.querySelector('[data-testid="pdf-print-iframe"]') as HTMLIFrameElement;
    iframe.onload?.(new Event("load"));
    await promise;

    expect(windowOpenSpy).toHaveBeenCalledWith("blob:mock-pdf-url", "_blank", "noopener,noreferrer");
    expect(windowPrintSpy).not.toHaveBeenCalled();
  });
});

describe("Sheet Music Print buttons and Ctrl+P / Cmd+P shortcut", () => {
  const project: Project = {
    id: "proj-print",
    user_id: "u1",
    title: "Graceful Waltz",
    description: "",
    status: "ready",
    instrument: "piano",
    transcription_mode: "single_instrument",
    duration_seconds: 8,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    media_assets: [],
  };

  const scoreResp: ProjectScoreResponse = {
    id: "score-print",
    project_id: "proj-print",
    version: 1,
    updated_at: new Date().toISOString(),
    score_json: {
      title: "Graceful Waltz",
      tempo_bpm: 96,
      tempo_estimated: false,
      key_signature: "C",
      key_signature_estimated: false,
      time_signature: "3/4",
      time_signature_estimated: false,
      duration_seconds: 8,
      tracks: [{ index: 0, name: "Piano", instrument: "piano", clef: "treble", program: 0, muted: false }],
      notes: [{ id: "n1", pitch_midi: 60, onset_sec: 0, offset_sec: 1, velocity: 80, track_index: 0 }],
      chords: [],
      analysis: { mode: "single_instrument" },
    },
    musicxml: "<score-partwise/>",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prints from ExportCenter using the same PDF generator and preserves Download PDF", async () => {
    vi.spyOn(api, "listExports").mockResolvedValue([]);
    const pdfBlob = new Blob(["%PDF-1.4 test"], { type: "application/pdf" });
    const genSpy = vi.spyOn(api, "generateScorePdfBlob").mockResolvedValue({
      record: {
        id: "exp-1",
        project_id: "proj-print",
        format: "pdf",
        status: "completed",
        error_message: null,
        download_url: "/api/v1/exports/exp-1/download",
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
      blob: pdfBlob,
    });
    const printMock = vi.spyOn(pdfPrintModule, "printScorePdf").mockResolvedValue(undefined);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ExportCenter projectId="proj-print" projectTitle="Graceful Waltz" hasScore={true} />
      </QueryClientProvider>,
    );

    const printBtn = screen.getByRole("button", { name: /Print Sheet Music/i });
    fireEvent.click(printBtn);

    await waitFor(() => {
      expect(genSpy).toHaveBeenCalledWith("proj-print", { include_chords: true });
      expect(printMock).toHaveBeenCalledWith(pdfBlob);
    });
  });

  it("triggers PDF print from Sheet Music toolbar button and Ctrl+P / Cmd+P only in notation workspace", async () => {
    vi.spyOn(api, "getProject").mockResolvedValue(project);
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
    vi.spyOn(api, "getScore").mockResolvedValue(scoreResp);

    const pdfBlob = new Blob(["%PDF-1.4 studio"], { type: "application/pdf" });
    const genSpy = vi.spyOn(api, "generateScorePdfBlob").mockResolvedValue({
      record: {
        id: "exp-2",
        project_id: "proj-print",
        format: "pdf",
        status: "completed",
        error_message: null,
        download_url: "/api/v1/exports/exp-2/download",
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
      blob: pdfBlob,
    });
    const printMock = vi.spyOn(pdfPrintModule, "printScorePdf").mockResolvedValue(undefined);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/proj-print"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const toolbarPrintBtn = await screen.findByTestId("sheet-print-button");
    fireEvent.click(toolbarPrintBtn);

    await waitFor(() => {
      expect(genSpy).toHaveBeenCalledTimes(1);
      expect(printMock).toHaveBeenCalledTimes(1);
    });

    // Ctrl+P in Sheet Music tab triggers print and prevents default
    const ctrlP = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true });
    window.dispatchEvent(ctrlP);
    expect(ctrlP.defaultPrevented).toBe(true);

    await waitFor(() => {
      expect(genSpy).toHaveBeenCalledTimes(2);
      expect(printMock).toHaveBeenCalledTimes(2);
    });

    // Cmd+P inside an input must NOT be intercepted
    const input = document.createElement("input");
    document.body.appendChild(input);
    const inputCmdP = new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(inputCmdP);
    expect(inputCmdP.defaultPrevented).toBe(false);
    input.remove();

    // Switching away from Sheet Music tab disables the shortcut
    fireEvent.click(screen.getByRole("tab", { name: /Export Center/i }));
    const otherTabCtrlP = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true });
    window.dispatchEvent(otherTabCtrlP);
    expect(otherTabCtrlP.defaultPrevented).toBe(false);
    expect(genSpy).toHaveBeenCalledTimes(2);
  });
});
