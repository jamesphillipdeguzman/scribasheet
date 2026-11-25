import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptionConfigPanel } from "@/features/transcription/TranscriptionConfigPanel";

describe("Lead Melody Vocal Isolation & Settings UI", () => {
  it("auto-enables Demucs, shows vocal isolation notice, hides Playability Smoothing, and defaults to 1/16 quantization for Lead Melody", () => {
    const onStart = vi.fn();

    render(
      <TranscriptionConfigPanel
        hasMedia={true}
        hasScore={false}
        activeJob={null}
        workerOnline={true}
        defaultInstrument="piano"
        defaultMode="piano"
        onStart={onStart}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        isStarting={false}
      />,
    );

    const modeSelect = screen.getByLabelText(/output arrangement/i) as HTMLSelectElement;
    const demucsToggle = screen.getByLabelText(/separate audio stems/i) as HTMLInputElement;
    const quantSelect = screen.getByLabelText(/quantization/i) as HTMLSelectElement;

    expect(modeSelect.value).toBe("piano");
    expect(demucsToggle.checked).toBe(false);
    expect(screen.getByLabelText(/playability smoothing/i)).toBeTruthy();
    expect(screen.queryByTestId("lead-melody-vocal-status")).toBeNull();

    // Switch Output Arrangement to Lead Melody
    fireEvent.change(modeSelect, { target: { value: "melody" } });

    expect(modeSelect.value).toBe("melody");
    expect(demucsToggle.checked).toBe(true);
    expect(quantSelect.value).toBe("sixteenth");
    expect(screen.queryByLabelText(/playability smoothing/i)).toBeNull();

    const statusNotice = screen.getByTestId("lead-melody-vocal-status");
    expect(statusNotice.textContent).toContain("Isolating Vocals Stem for Lead Melody");
    expect(statusNotice.className).toContain("bg-violet-50");
    expect(statusNotice.className).toContain("border-violet-300");
    expect(statusNotice.className).toContain("dark:bg-violet-500/10");
    expect(statusNotice.className).toContain("dark:border-violet-500/30");

    const headingEl = screen.getByText("Isolating Vocals Stem for Lead Melody");
    expect(headingEl.className).toContain("text-violet-950");
    expect(headingEl.className).toContain("dark:text-violet-200");

    const subtitleEl = screen.getByText(
      /Uses Demucs vocal isolation \(vocals\.wav\) and monophonic vocal pitch tracking/i,
    );
    expect(subtitleEl.className).toContain("text-violet-900");
    expect(subtitleEl.className).toContain("dark:text-violet-200/90");

    fireEvent.click(screen.getByRole("button", { name: /start ai transcription/i }));
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "melody",
        enable_source_separation: true,
        quantization: "sixteenth",
        audio_source_type: "auto",
      }),
    );

    // Switching back to Piano restores Playability Smoothing and clears vocal isolation banner
    fireEvent.change(modeSelect, { target: { value: "piano" } });
    expect(screen.getByLabelText(/playability smoothing/i)).toBeTruthy();
    expect(screen.queryByTestId("lead-melody-vocal-status")).toBeNull();
  });

  it("respects explicit Solo Piano / Instrumental source and user quantization choices in Lead Melody", () => {
    render(
      <TranscriptionConfigPanel
        hasMedia={true}
        hasScore={false}
        activeJob={null}
        workerOnline={true}
        defaultInstrument="piano"
        defaultMode="piano"
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        isStarting={false}
      />,
    );

    const modeSelect = screen.getByLabelText(/output arrangement/i) as HTMLSelectElement;
    const sourceSelect = screen.getByLabelText(/audio source/i) as HTMLSelectElement;
    const demucsToggle = screen.getByLabelText(/separate audio stems/i) as HTMLInputElement;
    const quantSelect = screen.getByLabelText(/quantization/i) as HTMLSelectElement;

    // User manually picks eighth quantization first
    fireEvent.change(quantSelect, { target: { value: "eighth" } });
    fireEvent.change(modeSelect, { target: { value: "melody" } });
    expect(quantSelect.value).toBe("eighth");
    expect(demucsToggle.checked).toBe(true);

    // Explicitly switch to Solo Piano / Instrumental and turn Demucs off
    fireEvent.change(sourceSelect, { target: { value: "solo_piano" } });
    fireEvent.click(demucsToggle);
    expect(demucsToggle.checked).toBe(false);
    expect(screen.getByTestId("lead-melody-vocal-status").textContent).toContain(
      "Direct Solo / Instrumental Lead Melody",
    );

    // Re-selecting Lead Melody with solo_piano must not clobber explicit solo_piano choice
    fireEvent.change(modeSelect, { target: { value: "melody" } });
    expect(demucsToggle.checked).toBe(false);

    // Switching source back to Automatic re-enables Demucs separation
    fireEvent.change(sourceSelect, { target: { value: "auto" } });
    expect(demucsToggle.checked).toBe(true);
    expect(screen.getByTestId("lead-melody-vocal-status").textContent).toContain(
      "Isolating Vocals Stem for Lead Melody",
    );
  });
});
