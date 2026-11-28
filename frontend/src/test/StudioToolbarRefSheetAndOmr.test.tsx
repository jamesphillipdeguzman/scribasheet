import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { ReferenceSheetViewer } from "@/features/editor/ReferenceSheetViewer";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { api } from "@/services/api";
import type {
  OmrApplyFixesResponse,
  OmrVerificationReport,
  OmrVerificationStatusResponse,
  Project,
  ProjectScoreResponse,
  ScoreData,
  TranscriptionJob,
} from "@/types/api";

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

const MINIMAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

function makeScore(overrides?: Partial<ScoreData>): ScoreData {
  return {
    title: "Test Score",
    tempo_bpm: 120,
    tempo_estimated: false,
    time_signature: "4/4",
    time_signature_estimated: false,
    key_signature: "C major",
    key_signature_estimated: false,
    duration_seconds: 2,
    tracks: [{ index: 0, name: "Piano", instrument: "piano", clef: "treble", program: 0, muted: false }],
    notes: [
      { id: "n1", pitch_midi: 60, onset_sec: 0, offset_sec: 0.5, velocity: 85, track_index: 0 },
      { id: "n2", pitch_midi: 62, onset_sec: 0.5, offset_sec: 1.0, velocity: 85, track_index: 0 },
    ],
    chords: [],
    analysis: {},
    ...overrides,
  };
}

function makeProject(mode: string, withPdfAsset = false): Project {
  return {
    id: `proj-${mode}`,
    user_id: "u1",
    title: mode === "midi_playground" ? "My Playground" : "Scanned Anthem",
    description: "",
    instrument: "piano",
    transcription_mode: mode,
    status: "ready",
    duration_seconds: 2,
    created_at: "2026-11-28T00:00:00Z",
    updated_at: "2026-11-28T00:00:00Z",
    media_assets: withPdfAsset
      ? [
          {
            id: "asset-pdf-1",
            project_id: `proj-${mode}`,
            asset_type: "original",
            original_filename: "score.pdf",
            mime_type: "application/pdf",
            size_bytes: 2048,
            duration_seconds: null,
            sample_rate: null,
            channels: null,
            created_at: "2026-11-28T00:00:00Z",
          },
        ]
      : [],
  };
}

function renderStudio(projectId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[`/projects/${projectId}`]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("Studio Toolbar Fix, Reference Sheet Split View, & OMR Verification UI", () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // Ignore node localStorage warning
    }
    vi.spyOn(api, "getLyrics").mockResolvedValue({ text: "", segments: [] } as never);
    vi.spyOn(api, "listExports").mockResolvedValue([]);
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 2,
      worker_id: "w-1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 30,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("places single authoritative selection status, Undo, Redo, and ? in the main editor tab bar without duplicating them", async () => {
    const score = makeScore({ analysis: { mode: "midi_playground" } });
    vi.spyOn(api, "getProject").mockResolvedValue(makeProject("midi_playground"));
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
    vi.spyOn(api, "getScore").mockResolvedValue({
      id: "score-1",
      project_id: "proj-midi_playground",
      version: 1,
      score_json: score,
      musicxml: MINIMAL_XML,
      updated_at: "2026-11-28T00:00:00Z",
    });

    renderStudio("proj-midi_playground");

    const tabBar = await screen.findByRole("tablist");
    const cluster = within(tabBar).getByTestId("studio-tabbar-actions");
    expect(cluster.className).toContain("ml-auto");

    // Selection readout pill has constrained max width & tooltip and stays inside tab bar
    const readout = within(cluster).getByTestId("notation-edit-readout");
    expect(readout.className).toContain("truncate");
    expect(readout).toHaveAttribute("title", "Click a notehead to edit");

    // Authoritative single instance of Undo, Redo, Selection Readout, and ? across entire Studio
    expect(screen.getAllByTestId("notation-edit-readout")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Undo$/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Redo$/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /toggle keyboard shortcut reference/i })).toHaveLength(1);

    // OMR Verification badge MUST NOT render on non-OMR / MIDI Playground projects
    expect(screen.queryByTestId("omr-verification-bar")).toBeNull();

    // Toggling ? opens the shortcuts popover beneath tab bar
    fireEvent.click(within(cluster).getByRole("button", { name: /toggle keyboard shortcut reference/i }));
    expect(screen.getByTestId("notation-shortcuts-popover")).toBeInTheDocument();
  });

  it("keeps live Playground mounted when toggling Reference Sheet split view, supports PDF/images locally, and cleans up Object URLs", async () => {
    const urlCalls: string[] = [];
    const revokedUrls: string[] = [];
    let urlCounter = 1;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;

    URL.createObjectURL = vi.fn(() => {
      const next = `blob:local-ref-${urlCounter++}`;
      urlCalls.push(next);
      return next;
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
      revokedUrls.push(url);
    });

    try {
      // Standalone viewer test for PDF multi-page, image, validation errors, replace/clear, and unmount revoke
      const onClose = vi.fn();
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const { unmount } = render(<ReferenceSheetViewer onClose={onClose} />);
      const input = screen.getByTestId("reference-file-input") as HTMLInputElement;

      // 1. Unsupported file rejected with error alert & zero API upload
      const badFile = new File(["not-a-score"], "notes.txt", { type: "text/plain" });
      fireEvent.change(input, { target: { files: [badFile] } });
      await waitFor(() => {
        expect(screen.getByTestId("reference-sheet-error")).toHaveTextContent(/unsupported file format/i);
      });
      expect(urlCalls).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();

      // 2. Valid multi-page PDF loads with page navigation & zoom
      const pdfBytes = new TextEncoder().encode(
        "%PDF-1.4\n1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n2 0 obj<< /Type /Pages /Count 2 >>endobj\n3 0 obj<< /Type /Page >>endobj\n4 0 obj<< /Type /Page >>endobj\n",
      );
      const pdfFile = new File([pdfBytes], "etude.pdf", { type: "application/pdf" });
      fireEvent.change(input, { target: { files: [pdfFile] } });

      await waitFor(() => {
        expect(screen.getByTestId("reference-pdf-frame")).toBeInTheDocument();
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(screen.getByTestId("reference-filename")).toHaveTextContent("etude.pdf");
      expect(screen.getByTestId("reference-page-indicator")).toHaveTextContent("Page 1 / 2");

      fireEvent.click(screen.getByRole("button", { name: "Next PDF page" }));
      expect(screen.getByTestId("reference-page-indicator")).toHaveTextContent("Page 2 / 2");
      expect(screen.getByTestId("reference-pdf-frame")).toHaveAttribute(
        "src",
        expect.stringContaining("#page=2"),
      );

      // 3. Replace with valid PNG revokes old PDF object URL cleanly
      const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      const pngFile = new File([pngHeader], "page1.png", { type: "image/png" });
      fireEvent.change(input, { target: { files: [pngFile] } });

      await waitFor(() => {
        expect(screen.getByTestId("reference-image-preview")).toBeInTheDocument();
      });
      expect(revokedUrls).toContain("blob:local-ref-1");

      fireEvent.click(screen.getByRole("button", { name: "Zoom in reference" }));
      expect(screen.getByTestId("reference-zoom-label")).toHaveTextContent("115%");

      // Clear revokes active object URL
      fireEvent.click(screen.getByTestId("reference-clear-btn"));
      expect(revokedUrls).toContain("blob:local-ref-2");
      unmount();

      // 4. Studio integration: toggling split view & resizing keeps NotationMidiBar mounted
      const score = makeScore({ analysis: { mode: "midi_playground" } });
      vi.spyOn(api, "getProject").mockResolvedValue(makeProject("midi_playground"));
      vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
      vi.spyOn(api, "getScore").mockResolvedValue({
        id: "score-1",
        project_id: "proj-midi_playground",
        version: 1,
        score_json: score,
        musicxml: MINIMAL_XML,
        updated_at: "2026-11-28T00:00:00Z",
      });

      renderStudio("proj-midi_playground");

      const midiBarBefore = await screen.findByTestId("notation-midi-bar");
      const toggleBtn = screen.getByTestId("toggle-reference-sheet-btn");
      expect(screen.queryByTestId("reference-sheet-viewer")).toBeNull();

      // Open 50/50 Reference Sheet split pane
      fireEvent.click(toggleBtn);
      expect(screen.getByTestId("reference-sheet-viewer")).toBeInTheDocument();
      const divider = screen.getByTestId("reference-split-divider");
      expect(divider).toHaveAttribute("aria-valuenow", "50");

      // Resize with keyboard ArrowRight -> 55%
      fireEvent.keyDown(divider, { key: "ArrowRight" });
      expect(divider).toHaveAttribute("aria-valuenow", "55");

      // Live NotationMidiBar DOM node was NOT unmounted across split open or resize
      expect(screen.getByTestId("notation-midi-bar")).toBe(midiBarBefore);

      // Close Reference Sheet restores normal layout without unmounting NotationMidiBar
      fireEvent.click(screen.getByTestId("reference-close-btn"));
      expect(screen.queryByTestId("reference-sheet-viewer")).toBeNull();
      expect(screen.getByTestId("notation-midi-bar")).toBe(midiBarBefore);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it("displays OMR Match badge, runs AI Vision Verify, reviews/applies/reverts fixes, and warns on Re-Transcribe for OMR projects", async () => {
    const prelimReport: OmrVerificationReport = {
      omr_match_score: 88,
      score_status: "preliminary",
      structural_score: 94.0,
      rhythm_validity_score: 100.0,
      structural_consistency_score: 82.9,
      ai_verified: false,
      ai_confidence: null,
      source_available: true,
      source_message: null,
      formula_note: "Preliminary vs Verified formula",
      total_measures: 1,
      valid_rhythm_measures: 1,
      flagged_measures: [],
      findings: [],
      content_hash: "abc123",
      applied_finding_ids: [],
      can_revert: false,
    };

    const verifiedStatus: OmrVerificationStatusResponse = {
      verification: {
        ...prelimReport,
        omr_match_score: 93,
        score_status: "verified",
        ai_verified: true,
        ai_confidence: 95.0,
        flagged_measures: [1],
        findings: [
          {
            id: "ai-p1-acc1",
            source: "ai_vision",
            page: 1,
            measure: 1,
            part_id: "P1",
            category: "accidental",
            severity: "medium",
            description: "Measure 1 note #3 F4 appears as F#4 on page 1.",
            confidence: 96,
            proposed_fix: {
              action: "set_accidental",
              part_id: "P1",
              measure: 1,
              note_index: 3,
              alter: 1,
            },
          },
        ],
      },
      gemini_configured: true,
      source_available: true,
      source_message: null,
      can_revert: false,
      can_restore_previous: false,
    };

    const scoreAfterFix: ProjectScoreResponse = {
      id: "score-omr",
      project_id: "proj-satb_pdf",
      version: 2,
      score_json: makeScore({
        analysis: { mode: "satb_pdf", job_id: "job-omr-1", omr_verification: prelimReport },
      }),
      musicxml: MINIMAL_XML.replace("<step>F</step>", "<step>F</step><alter>1</alter>"),
      updated_at: "2026-11-28T00:05:00Z",
    };

    const applyResp: OmrApplyFixesResponse = {
      score: scoreAfterFix,
      verification: {
        ...verifiedStatus.verification,
        applied_finding_ids: ["ai-p1-acc1"],
        can_revert: true,
      },
      applied_ids: ["ai-p1-acc1"],
      skipped_ids: [],
    };

    const omrJob: TranscriptionJob = {
      id: "job-omr-1",
      project_id: "proj-satb_pdf",
      user_id: "u1",
      source_asset_id: "asset-pdf-1",
      status: "completed",
      progress: 100,
      current_stage: "Completed",
      engine: "omr",
      settings_json: { mode: "satb_pdf", satb_mode: "auto_satb" } as never,
      error_code: null,
      error_message: null,
      created_at: "2026-11-28T00:00:00Z",
      started_at: "2026-11-28T00:00:01Z",
      completed_at: "2026-11-28T00:00:10Z",
    };

    vi.spyOn(api, "getProject").mockResolvedValue(makeProject("satb_pdf", true));
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([omrJob]);
    vi.spyOn(api, "getScore").mockResolvedValue({
      id: "score-omr",
      project_id: "proj-satb_pdf",
      version: 1,
      score_json: makeScore({
        analysis: { mode: "satb_pdf", job_id: "job-omr-1", omr_verification: prelimReport },
      }),
      musicxml: MINIMAL_XML,
      updated_at: "2026-11-28T00:00:00Z",
    });
    vi.spyOn(api, "getOmrVerification").mockResolvedValue({
      verification: prelimReport,
      gemini_configured: true,
      source_available: true,
      source_message: null,
      can_revert: false,
      can_restore_previous: false,
    });
    const verifySpy = vi.spyOn(api, "runOmrVisionVerify").mockResolvedValue(verifiedStatus);
    const applySpy = vi.spyOn(api, "applyOmrFixes").mockResolvedValue(applyResp);
    const revertSpy = vi.spyOn(api, "revertOmrFixes").mockResolvedValue({
      ...scoreAfterFix,
      version: 3,
      musicxml: MINIMAL_XML,
    });

    renderStudio("proj-satb_pdf");

    const badge = await screen.findByTestId("omr-match-badge");
    expect(badge).toHaveTextContent("OMR Match: 88%");
    expect(badge).toHaveTextContent("Structural Check");
    expect(screen.getByTestId("omr-not-verified-label")).toBeInTheDocument();

    // Re-Transcribe shows warning confirmation before replacing notation
    fireEvent.click(screen.getByTestId("omr-retranscribe-btn"));
    expect(screen.getByTestId("omr-retranscribe-warning")).toBeInTheDocument();

    // Run AI Vision Verify -> expands findings & allows reviewing/applying
    fireEvent.click(screen.getByTestId("omr-ai-verify-btn"));
    await waitFor(() => {
      expect(verifySpy).toHaveBeenCalledWith("proj-satb_pdf", false);
      expect(screen.getByTestId("omr-finding-ai-p1-acc1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("omr-match-badge")).toHaveTextContent("OMR Match: 93%");
    expect(screen.getByTestId("omr-match-badge")).toHaveTextContent("AI Verified");

    // Apply selected fix -> updates score & enables Revert
    fireEvent.click(screen.getByTestId("omr-apply-fixes-btn"));
    await waitFor(() => {
      expect(applySpy).toHaveBeenCalledWith("proj-satb_pdf", ["ai-p1-acc1"]);
      expect(screen.getByTestId("omr-revert-btn")).toBeInTheDocument();
    });

    // Revert to original OMR
    fireEvent.click(screen.getByTestId("omr-revert-btn"));
    await waitFor(() => {
      expect(revertSpy).toHaveBeenCalledWith("proj-satb_pdf");
    });
  });
});
