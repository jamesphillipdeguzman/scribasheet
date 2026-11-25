import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptionConfigPanel } from "@/features/transcription/TranscriptionConfigPanel";

describe("Piano Playability Smoothing & Default Arrangement Settings", () => {
  it("renders Playability Smoothing options and sends selected smoothing in job and regenerate payloads", () => {
    const onStart = vi.fn();
    const onRegenerate = vi.fn();

    render(
      <TranscriptionConfigPanel
        hasMedia={true}
        hasScore={true}
        activeJob={null}
        workerOnline={true}
        defaultInstrument="piano"
        defaultMode="piano"
        onStart={onStart}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onRegenerateArrangement={onRegenerate}
        isStarting={false}
      />,
    );

    const modeSelect = screen.getByLabelText(/output arrangement/i) as HTMLSelectElement;
    const smoothSelect = screen.getByLabelText(/playability smoothing/i) as HTMLSelectElement;

    expect(modeSelect.value).toBe("piano");
    expect(smoothSelect.value).toBe("standard");
    expect(screen.getByRole("option", { name: "Original Performance" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Standard (Recommended)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Simplified Playable Piano" })).toBeTruthy();

    fireEvent.change(smoothSelect, { target: { value: "simplified" } });
    expect(smoothSelect.value).toBe("simplified");

    fireEvent.click(screen.getByRole("button", { name: /apply arrangement/i }));
    expect(onRegenerate).toHaveBeenCalledWith("balanced", "sixteenth", "piano", "simplified");

    fireEvent.click(screen.getByRole("button", { name: /start ai transcription/i }));
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "piano",
        playability_smoothing: "simplified",
      }),
    );
  });

  it("preserves saved project mode and explicit user mode selections while preferring Piano (Grand Staff) when switching to Piano", () => {
    // 1. Saved project in Single Instrument stays Single Instrument
    const { rerender } = render(
      <TranscriptionConfigPanel
        hasMedia={true}
        hasScore={false}
        activeJob={null}
        workerOnline={true}
        defaultInstrument="acoustic_guitar"
        defaultMode="single_instrument"
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        isStarting={false}
      />,
    );

    const modeSelect = screen.getByLabelText(/output arrangement/i) as HTMLSelectElement;
    const instSelect = screen.getByLabelText(/instrument/i) as HTMLSelectElement;
    expect(modeSelect.value).toBe("single_instrument");

    // Switching instrument interactively to Piano prefers Piano (Grand Staff)
    fireEvent.change(instSelect, { target: { value: "piano" } });
    expect(modeSelect.value).toBe("piano");

    // Explicit user choice (Lead Melody) is never overwritten when changing instruments
    fireEvent.change(modeSelect, { target: { value: "melody" } });
    fireEvent.change(instSelect, { target: { value: "violin" } });
    expect(modeSelect.value).toBe("melody");
    fireEvent.change(instSelect, { target: { value: "piano" } });
    expect(modeSelect.value).toBe("melody");

    // Existing saved project playability_smoothing restores cleanly
    rerender(
      <TranscriptionConfigPanel
        hasMedia={true}
        hasScore={true}
        activeJob={null}
        workerOnline={true}
        defaultInstrument="piano"
        defaultMode="piano"
        initialPlayabilitySmoothing="original"
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        isStarting={false}
      />,
    );
    expect((screen.getByLabelText(/playability smoothing/i) as HTMLSelectElement).value).toBe("original");
  });
});
