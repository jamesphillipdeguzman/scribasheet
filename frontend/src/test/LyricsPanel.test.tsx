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
    expect(screen.getByText(/needs review/i)).toBeTruthy();
    expect(screen.getByText("Vocals Stem (Demucs)")).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "Hello brave world" } });
    fireEvent.click(screen.getByRole("button", { name: /save edits/i }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith("proj-1", { text: "Hello brave world", language: "en" }));

    fireEvent.click(screen.getByRole("button", { name: /\.srt/i }));
    await waitFor(() => expect(exportSpy).toHaveBeenCalledWith("proj-1", "srt", "Demo Song.srt"));

    fireEvent.click(screen.getByRole("button", { name: /re-transcribe lyrics/i }));
    await waitFor(() => expect(transcribeSpy).toHaveBeenCalled());
  });
});
