import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportCenter } from "@/features/editor/ExportCenter";
import { LyricsPanel } from "@/features/editor/LyricsPanel";
import { prepareDisplayMusicXml } from "@/features/editor/musicXmlNormalization";
import { SATBMixerPanel } from "@/features/editor/SATBMixerPanel";
import { MediaUploader } from "@/features/uploads/MediaUploader";
import { printScorePdf } from "@/lib/pdfPrint";
import { api } from "@/services/api";
import type { MediaAsset, ScoreData } from "@/types/api";

vi.mock("@/features/auth/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    user: { id: "u1", email: "user@example.com", display_name: "Ada Lovelace", is_unlimited: false },
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

describe("Combined UI, OMR Normalization, Print Title, Arranger Credit & Format Badge", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders high-contrast Light Mode Recognition Notes box in SATBMixerPanel", () => {
    const scoreData: ScoreData = {
      title: "SATB Hymn",
      tempo_bpm: 100,
      tempo_estimated: false,
      key_signature: "F major",
      key_signature_estimated: false,
      time_signature: "4/4",
      time_signature_estimated: false,
      duration_seconds: 8,
      tracks: [
        { index: 0, name: "Soprano", instrument: "piano", clef: "treble", program: 0, muted: false },
        { index: 1, name: "Alto", instrument: "piano", clef: "treble", program: 0, muted: false },
        { index: 2, name: "Tenor", instrument: "piano", clef: "bass", program: 0, muted: false },
        { index: 3, name: "Bass", instrument: "piano", clef: "bass", program: 0, muted: false },
      ],
      notes: [],
      chords: [],
      analysis: {
        mode: "satb_pdf",
        satb: {
          warnings: ["Cue notes were preserved without distorting rhythm."],
          needs_review: false,
          voice_assignments: { Soprano: "soprano", Alto: "alto", Tenor: "tenor", Bass: "bass" },
        },
      },
    };

    render(
      <SATBMixerPanel
        projectId="proj-1"
        projectTitle="SATB Hymn"
        scoreData={scoreData}
        soloVoice={null}
        onSoloVoiceChange={vi.fn()}
        mutedVoices={{}}
        onMutedVoicesChange={vi.fn()}
        onScoreUpdated={vi.fn()}
      />,
    );

    const callout = screen.getByTestId("recognition-notes-callout");
    expect(callout.className).toContain("bg-amber-50");
    expect(callout.className).toContain("border-amber-300");
    expect(callout.className).toContain("dark:bg-amber-500/10");
    expect(callout.className).toContain("dark:border-amber-500/30");

    const title = screen.getByText("Recognition Notes");
    expect(title.className).toContain("text-amber-950");
    expect(title.className).toContain("font-semibold");
    expect(title.className).toContain("dark:text-amber-200");

    const list = callout.querySelector("ul");
    expect(list?.className).toContain("text-amber-900");
    expect(list?.className).toContain("font-medium");
    expect(list?.className).toContain("dark:text-amber-200/90");
  });

  it("renders high-contrast Light Mode Lyrics badges and segment action hover states", async () => {
    vi.spyOn(api, "getLyrics").mockResolvedValue({
      text: "Amazing grace",
      language: "en",
      model_name: "medium",
      device: "cpu",
      source_used: "vocals_stem",
      demucs_requested: true,
      demucs_fallback_used: false,
      has_word_timestamps: false,
      uncertain_segments: [],
      manually_edited: false,
      updated_at: new Date().toISOString(),
      segments: [
        { id: "seg-1", start_sec: 0, end_sec: 2, text: "Amazing", needs_review: true, reviewed: false, edited: false, confidence: 0.6, words: [] },
        { id: "seg-2", start_sec: 2, end_sec: 4, text: "grace", needs_review: false, reviewed: true, edited: false, confidence: 0.95, words: [] },
      ],
    });

    render(
      <LyricsPanel
        projectId="proj-1"
        projectTitle="Amazing Grace"
        hasMedia={true}
        activeJob={null}
        onJobStarted={vi.fn()}
      />,
    );

    const needsReviewBadge = await screen.findByText("Needs Review");
    expect(needsReviewBadge.className).toContain("bg-amber-100");
    expect(needsReviewBadge.className).toContain("text-amber-950");
    expect(needsReviewBadge.className).toContain("border-amber-300");
    expect(needsReviewBadge.className).toContain("font-semibold");

    const reviewedBadge = screen.getByText("Reviewed");
    expect(reviewedBadge.className).toContain("bg-emerald-100");
    expect(reviewedBadge.className).toContain("text-emerald-950");
    expect(reviewedBadge.className).toContain("border-emerald-300");

    const markReviewedBtn = screen.getByRole("button", { name: "Mark Reviewed" });
    expect(markReviewedBtn.className).toContain("text-stone-700");
    expect(markReviewedBtn.className).toContain("hover:bg-stone-100");
    expect(markReviewedBtn.className).toContain("hover:text-stone-950");

    const editBtn = screen.getByRole("button", { name: "Edit segment seg-1" });
    expect(editBtn.className).toContain("text-violet-700");
    expect(editBtn.className).toContain("hover:bg-violet-100");
    expect(editBtn.className).toContain("hover:text-violet-900");
  });

  it("normalizes NFKC lyric ligatures, preserves/restores key fifths, and upserts arranger credit without duplicates", () => {
    const omrXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <identification>
    <creator type="composer">John Newton</creator>
    <creator type="lyricist">Traditional</creator>
  </identification>
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <note>
        <pitch><step>F</step><octave>4</octave></pitch>
        <duration>4</duration><type>whole</type>
        <lyric number="1"><text>ﬁrst ﬂight</text></lyric>
      </note>
    </measure>
  </part>
</score-partwise>`;

    const out = prepareDisplayMusicXml(omrXml, true, {
      fallbackKeySignature: "F major",
      transcribedBy: "Ada Lovelace",
    });

    expect(out).toContain("<text>first flight</text>");
    expect(out).toContain("<fifths>-1</fifths>");
    expect(out).toContain('<creator type="composer">John Newton</creator>');
    expect(out).toContain('<creator type="lyricist">Traditional</creator>');
    expect(out).toContain('<creator type="arranger">Ada Lovelace</creator>');
    expect(out).toContain("Transcribed by: Ada Lovelace");

    // Repeated normalization must not duplicate arranger credit
    const out2 = prepareDisplayMusicXml(out, true, {
      fallbackKeySignature: "C major", // must NOT overwrite existing -1
      transcribedBy: "Ada Lovelace",
    });
    expect(out2).toContain("<fifths>-1</fifths>");
    expect((out2.match(/Transcribed by: Ada Lovelace/g) || []).length).toBe(1);
  });

  it("temporarily sets and restores document.title and iframe.title during printScorePdf", async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock-title-pdf");
    URL.revokeObjectURL = vi.fn();
    document.title = "ScribaSheet Studio";

    const afterPrintCbs: Array<() => void> = [];
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const el = origCreateElement(tagName);
      if (tagName.toLowerCase() === "iframe") {
        Object.defineProperty(el, "contentWindow", {
          configurable: true,
          value: {
            focus: vi.fn(),
            print: () => {
              expect(document.title).toBe("Closer Piano Cover");
            },
            addEventListener: (_evt: string, cb: () => void) => afterPrintCbs.push(cb),
          },
        });
      }
      return el;
    });

    const p = printScorePdf(new Blob(["%PDF-1.4"], { type: "application/pdf" }), {
      title: "Closer: Piano Cover?",
      settleDelayMs: 5,
    });
    const iframe = document.querySelector('[data-testid="pdf-print-iframe"]') as HTMLIFrameElement;
    expect(iframe.title).toBe("Closer Piano Cover");
    iframe.onload?.(new Event("load"));
    await p;

    afterPrintCbs.forEach((cb) => cb());
    expect(document.title).toBe("ScribaSheet Studio");

    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it("initializes Transcribed by from authenticated user and preserves value when toggled off", async () => {
    vi.spyOn(api, "listExports").mockResolvedValue([]);
    const createSpy = vi.spyOn(api, "createExport").mockResolvedValue({
      id: "e1",
      project_id: "proj-1",
      format: "pdf",
      status: "completed",
      error_message: null,
      download_url: null,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ExportCenter projectId="proj-1" projectTitle="Test Score" hasScore={true} />
      </QueryClientProvider>,
    );

    const input = screen.getByLabelText("Transcribed by / Arranger Credit") as HTMLInputElement;
    expect(input.value).toBe("Ada Lovelace");

    const toggle = screen.getByRole("switch", { name: "Include Transcribed by credit" });
    fireEvent.click(toggle);
    expect(input).toBeDisabled();
    expect(input.value).toBe("Ada Lovelace");

    fireEvent.click(screen.getByRole("button", { name: /Export PDF/i }));
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        "proj-1",
        "pdf",
        expect.objectContaining({ include_transcribed_by: false, transcribed_by: "Ada Lovelace" }),
      );
    });
  });

  it("renders uppercase format badges for audio, score, and mic recordings in MediaUploader", () => {
    const baseAsset: MediaAsset = {
      id: "a1",
      project_id: "proj-1",
      asset_type: "original",
      original_filename: "song.mp3",
      mime_type: "audio/mpeg",
      size_bytes: 1024,
      duration_seconds: 10,
      sample_rate: 44100,
      channels: 2,
      created_at: new Date().toISOString(),
    };

    const { rerender } = render(
      <MediaUploader projectId="proj-1" existingAssets={[baseAsset]} onUploadComplete={vi.fn()} />,
    );
    let badge = screen.getByTestId("uploaded-format-badge");
    expect(badge.textContent).toBe("MP3");
    expect(badge.className).toContain("bg-violet-100");
    expect(badge.className).toContain("text-violet-900");

    rerender(
      <MediaUploader
        projectId="proj-1"
        existingAssets={[{ ...baseAsset, original_filename: "hymn.pdf", mime_type: "application/pdf" }]}
        onUploadComplete={vi.fn()}
      />,
    );
    badge = screen.getByTestId("uploaded-format-badge");
    expect(badge.textContent).toBe("PDF");
    expect(badge.className).toContain("bg-sky-100");
    expect(badge.className).toContain("text-sky-900");

    rerender(
      <MediaUploader
        projectId="proj-1"
        existingAssets={[{ ...baseAsset, original_filename: "mic-recording-12345.webm", mime_type: "audio/webm" }]}
        onUploadComplete={vi.fn()}
      />,
    );
    badge = screen.getByTestId("uploaded-format-badge");
    expect(badge.textContent).toBe("MIC RECORDING");
    expect(badge.className).toContain("bg-violet-100");
  });
});
