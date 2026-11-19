import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LyricsPanel } from "@/features/editor/LyricsPanel";
import { api } from "@/services/api";

describe("LyricsPanel", () => {
  it("loads recognized lyrics, edits and saves corrections, triggers re-transcription, and exports", async () => {
    vi.spyOn(api, "getLyrics").mockResolvedValue({
      text: "Hello world",
      segments: [
        {
          id: "seg_1",
          text: "Hello world",
          start_sec: 1.0,
          end_sec: 3.0,
          confidence: 0.4,
          needs_review: true,
          words: [],
        },
      ],
      language: "en",
      language_probability: 0.95,
      source_used: "vocals_stem",
      demucs_requested: true,
      demucs_fallback_used: false,
      model_name: "small",
      device: "cpu",
      has_word_timestamps: false,
      uncertain_segments: [{ segment_id: "seg_1" }],
      manually_edited: false,
      updated_at: null,
    });

    const updateSpy = vi.spyOn(api, "updateLyrics").mockResolvedValue({
      text: "Hello brave world",
      segments: [],
      language: "en",
      source_used: "vocals_stem",
      demucs_requested: true,
      demucs_fallback_used: false,
      model_name: "small",
      device: "cpu",
      has_word_timestamps: false,
      uncertain_segments: [],
      manually_edited: true,
      updated_at: null,
    });

    const exportSpy = vi.spyOn(api, "exportLyrics").mockResolvedValue();
    const transcribeSpy = vi.spyOn(api, "transcribeLyrics").mockResolvedValue({
      id: "job-1",
      project_id: "proj-1",
      user_id: "user-1",
      source_asset_id: "asset-1",
      status: "queued",
      progress: 0,
      current_stage: "Queued",
      engine: "faster_whisper",
      settings_json: {} as never,
      error_code: null,
      error_message: null,
      started_at: null,
      completed_at: null,
      created_at: new Date().toISOString(),
    });

    render(
      <LyricsPanel
        projectId="proj-1"
        projectTitle="Demo Song"
        hasMedia={true}
        activeJob={null}
      />,
    );

    const textarea = (await screen.findByLabelText(/editable lyrics text/i)) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Hello world");
    expect(screen.getByText("Needs Review")).toBeTruthy();
    expect(screen.getByText("Vocals Stem (Demucs)")).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "Hello brave world" } });
    fireEvent.click(screen.getByRole("button", { name: /save edits/i }));
    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          text: "Hello brave world",
          language: "en",
          segments: expect.arrayContaining([expect.objectContaining({ id: "seg_1", text: "Hello brave world" })]),
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /\.srt/i }));
    await waitFor(() => expect(exportSpy).toHaveBeenCalledWith("proj-1", "srt", "Demo Song.srt"));

    fireEvent.click(screen.getByRole("button", { name: /re-transcribe lyrics/i }));
    await waitFor(() => expect(transcribeSpy).toHaveBeenCalled());
  });

  it("supports Tagalog language selection, model selection, and original Whisper comparison", async () => {
    vi.restoreAllMocks();
    vi.spyOn(api, "getLyrics").mockResolvedValue({
      text: "Na para bang",
      original_text: "Na pa rang",
      segments: [],
      language: "tl",
      source_used: "vocals_stem",
      demucs_requested: true,
      demucs_fallback_used: false,
      model_name: "medium",
      device: "cpu",
      has_word_timestamps: false,
      uncertain_segments: [],
      alignment_uncertain_segments: [{ text: "bang", target_sec: 2.1 }],
      manually_edited: true,
      updated_at: null,
    });
    const transcribeSpy = vi.spyOn(api, "transcribeLyrics").mockResolvedValue({} as never);

    render(<LyricsPanel projectId="proj-tl" projectTitle="Na Para Bang" hasMedia={true} activeJob={null} />);

    await waitFor(() => expect(screen.getByText(/compare original whisper transcript/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/compare original whisper transcript/i));
    expect(screen.getByText("Na pa rang")).toBeInTheDocument();
    expect(screen.getByText(/1 lyric syllable\(s\) could not be matched/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Whisper Model"), { target: { value: "medium" } });
    fireEvent.click(screen.getByRole("button", { name: /re-transcribe lyrics/i }));
    await waitFor(() =>
      expect(transcribeSpy).toHaveBeenCalledWith(
        "proj-tl",
        expect.objectContaining({ language: "tl", whisper_model: "medium" }),
      ),
    );
  });

  it("supports review filters, inline editing (apply/cancel), manual flagging, timestamp seek, and synchronized full-text save", async () => {
    vi.restoreAllMocks();
    const initialData = {
      text: "Na pa rang\nMay kulang",
      original_text: "Na pa rang\nMay kulang",
      segments: [
        {
          id: "seg_1",
          text: "Na pa rang",
          start_sec: 1.5,
          end_sec: 3.2,
          confidence: 0.35,
          needs_review: true,
          reviewed: false,
          edited: false,
          words: [],
        },
        {
          id: "seg_2",
          text: "May kulang",
          start_sec: 3.5,
          end_sec: 5.0,
          confidence: 0.92,
          needs_review: false,
          reviewed: false,
          edited: false,
          words: [],
        },
      ],
      language: "tl",
      source_used: "vocals_stem" as const,
      demucs_requested: true,
      demucs_fallback_used: false,
      model_name: "medium",
      device: "cpu",
      has_word_timestamps: false,
      uncertain_segments: [{ segment_id: "seg_1" }],
      manually_edited: false,
      updated_at: null,
    };

    vi.spyOn(api, "getLyrics").mockResolvedValue(initialData);
    const updateSpy = vi.spyOn(api, "updateLyrics").mockImplementation(async (_id, payload) => ({
      ...initialData,
      text: payload.text,
      segments: payload.segments || [],
      manually_edited: true,
    }));
    const onSeek = vi.fn();
    const onLyricsSaved = vi.fn();

    render(
      <LyricsPanel
        projectId="proj-rev"
        projectTitle="Na Para Bang"
        hasMedia={true}
        activeJob={null}
        onSeek={onSeek}
        onLyricsSaved={onLyricsSaved}
      />,
    );

    // 1. Filter counts: All (2), Needs Review (1)
    await waitFor(() => expect(screen.getByRole("button", { name: "All (2)" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Needs Review (1)" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Needs Review (1)" }));
    expect(screen.getByText("Na pa rang")).toBeInTheDocument();
    expect(screen.queryByText("May kulang")).not.toBeInTheDocument();

    // 2. Timestamp click-to-play seeks to segment.start_sec
    fireEvent.click(screen.getByRole("button", { name: /play from 00:01\.50/i }));
    expect(onSeek).toHaveBeenCalledWith(1.5);

    // 3. Cancel inline edit restores original text without clearing needs_review
    fireEvent.click(screen.getByRole("button", { name: "Edit segment seg_1" }));
    const inlineInput = screen.getByLabelText("Inline edit seg_1") as HTMLInputElement;
    fireEvent.change(inlineInput, { target: { value: "Temporary typo" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.getByText("Na pa rang")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Needs Review (1)" })).toBeInTheDocument();

    // 4. Inline edit + Apply updates full lyrics editor and clears needs_review
    fireEvent.click(screen.getByRole("button", { name: "Edit segment seg_1" }));
    fireEvent.change(screen.getByLabelText("Inline edit seg_1"), { target: { value: "Na para bang" } });
    fireEvent.keyDown(screen.getByLabelText("Inline edit seg_1"), { key: "Enter" });

    expect(screen.getByRole("button", { name: "Needs Review (0)" })).toBeInTheDocument();
    expect(screen.getByText(/no segments need review/i)).toBeInTheDocument();
    const textarea = screen.getByLabelText(/editable lyrics text/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Na para bang\nMay kulang");

    // 5. Switch to All, manually flag seg_2 for review, and verify count updates
    fireEvent.click(screen.getByRole("button", { name: "All (2)" }));
    const flagButtons = screen.getAllByRole("button", { name: /flag review/i });
    fireEvent.click(flagButtons[1]);
    expect(screen.getByRole("button", { name: "Needs Review (1)" })).toBeInTheDocument();

    // 6. Full-text edit preserves timestamps when line count matches, then Save Edits persists
    fireEvent.change(textarea, { target: { value: "Na para bang\nMay kulang pa" } });
    fireEvent.click(screen.getByRole("button", { name: /save edits/i }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(updateSpy).toHaveBeenCalledWith(
      "proj-rev",
      expect.objectContaining({
        text: "Na para bang\nMay kulang pa",
        segments: expect.arrayContaining([
          expect.objectContaining({ id: "seg_1", text: "Na para bang", start_sec: 1.5, needs_review: false, edited: true }),
          expect.objectContaining({ id: "seg_2", text: "May kulang pa", start_sec: 3.5, edited: true }),
        ]),
      }),
    );
    expect(onLyricsSaved).toHaveBeenCalledTimes(1);
  });
});
