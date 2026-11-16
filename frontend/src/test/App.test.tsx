import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "@/App";
import { midiToNoteName, formatDuration, formatBytes } from "@/lib/utils";

describe("ScribaSheet Frontend", () => {
  it("renders landing page headline and primary CTA", () => {
    render(<App />);
    expect(screen.getByText(/Turn Any Performance Into Sheet Music/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Transcribing/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /See How It Works/i })).toBeInTheDocument();
  });

  it("formats musical pitch and media helpers accurately", () => {
    expect(midiToNoteName(60)).toBe("C4");
    expect(midiToNoteName(69)).toBe("A4");
    expect(formatDuration(125)).toBe("2:05");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });
});
