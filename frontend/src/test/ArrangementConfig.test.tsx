import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptionConfigPanel } from "@/features/transcription/TranscriptionConfigPanel";

describe("TranscriptionConfigPanel Arrangement Detail & Quantization", () => {
  it("defaults to Balanced, exposes Simple/Balanced/Detailed, updates quantization predictably, and transmits payload", () => {
    const onStart = vi.fn();
    const onRegenerate = vi.fn();

    render(
      <TranscriptionConfigPanel
        hasMedia={true}
        hasScore={true}
        activeJob={null}
        workerOnline={true}
        defaultInstrument="piano"
        defaultMode="single_instrument"
        onStart={onStart}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onRegenerateArrangement={onRegenerate}
        isStarting={false}
      />,
    );

    const arrSelect = screen.getByLabelText(/arrangement detail/i) as HTMLSelectElement;
    const quantSelect = screen.getByLabelText(/quantization/i) as HTMLSelectElement;

    expect(arrSelect.value).toBe("balanced");
    expect(quantSelect.value).toBe("sixteenth");

    // Selecting Simple automatically switches Quantization to 1/8 when not manually set
    fireEvent.change(arrSelect, { target: { value: "simple" } });
    expect(arrSelect.value).toBe("simple");
    expect(quantSelect.value).toBe("eighth");

    // Manual quantization selection (1/8 Triplet) is preserved when changing arrangement
    fireEvent.change(quantSelect, { target: { value: "eighth_triplet" } });
    expect(quantSelect.value).toBe("eighth_triplet");
    fireEvent.change(arrSelect, { target: { value: "detailed" } });
    expect(arrSelect.value).toBe("detailed");
    expect(quantSelect.value).toBe("eighth_triplet");

    // Apply Arrangement regenerates without triggering ML transcription
    fireEvent.click(screen.getByRole("button", { name: /apply arrangement/i }));
    expect(onRegenerate).toHaveBeenCalledWith("detailed", "eighth_triplet");
    expect(onStart).not.toHaveBeenCalled();

    // Start Transcription sends arrangement_detail & quantization in payload
    fireEvent.click(screen.getByRole("button", { name: /start ai transcription/i }));
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        arrangement_detail: "detailed",
        quantization: "eighth_triplet",
      }),
    );
  });

  it("restores existing project arrangement_detail setting", () => {
    render(
      <TranscriptionConfigPanel
        hasMedia={true}
        hasScore={true}
        activeJob={null}
        workerOnline={true}
        defaultInstrument="piano"
        defaultMode="single_instrument"
        initialArrangementDetail="simple"
        initialQuantization="eighth"
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        isStarting={false}
      />,
    );

    expect((screen.getByLabelText(/arrangement detail/i) as HTMLSelectElement).value).toBe("simple");
    expect((screen.getByLabelText(/quantization/i) as HTMLSelectElement).value).toBe("eighth");
  });
});
