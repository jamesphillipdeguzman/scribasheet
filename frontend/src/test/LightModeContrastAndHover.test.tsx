import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/AppShell";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/Button";
import { PianoRollEditor } from "@/features/editor/PianoRollEditor";
import { VirtualPianoKeyboard } from "@/features/editor/VirtualPianoKeyboard";
import type { ScoreNote } from "@/types/api";

vi.mock("@/features/auth/AuthContext", () => ({
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
    logout: vi.fn(),
  }),
}));

vi.mock("@/features/editor/midiSynth", () => ({
  midiSynth: {
    preloadPiano: vi.fn(),
    triggerNote: vi.fn(),
    startSustainedNote: vi.fn(),
    stopSustainedNote: vi.fn(),
    stopAllSustainedNotes: vi.fn(),
    getPlaybackClock: () => ({ isPlaying: false, currentSec: 0 }),
  },
}));

describe("Light Mode Contrast & Hover-State Fixes", () => {
  it("uses Light Mode stone hover/active classes and Dark Mode white/10 classes on AppShell nav, ThemeToggle, and ghost Button", () => {
    const qc = new QueryClient();
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <QueryClientProvider client={qc}>
          <AppShell>
            <Button variant="ghost" aria-label="Undo">
              Undo
            </Button>
            <ThemeToggle />
          </AppShell>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const dashboardLink = screen.getByRole("link", { name: "Dashboard" });
    expect(dashboardLink.className).toContain("bg-stone-200/90");
    expect(dashboardLink.className).toContain("text-stone-950");
    expect(dashboardLink.className).toContain("dark:bg-white/10");
    expect(dashboardLink.className).toContain("dark:text-white");

    const accountLink = screen.getByRole("link", { name: /Account/i });
    expect(accountLink.className).toContain("hover:bg-stone-200/75");
    expect(accountLink.className).toContain("hover:text-stone-950");
    expect(accountLink.className).toContain("dark:hover:bg-white/10");
    expect(accountLink.className).toContain("dark:hover:text-white");

    const undoBtn = screen.getByRole("button", { name: "Undo" });
    expect(undoBtn.className).toContain("hover:bg-stone-200/80");
    expect(undoBtn.className).toContain("hover:text-stone-950");
    expect(undoBtn.className).toContain("dark:hover:bg-white/10");

    const themeToggles = screen.getAllByTestId("theme-toggle");
    expect(themeToggles[0].className).toContain("hover:bg-stone-200/75");
    expect(themeToggles[0].className).toContain("dark:hover:bg-white/10");
  });

  it("renders Light Mode Piano Roll lanes, pitch-axis labels, and default/sounding/selected MIDI note blocks", () => {
    const notes: ScoreNote[] = [
      { id: "n1", pitch_midi: 60, onset_sec: 0.0, offset_sec: 0.5, velocity: 85, track_index: 0 },
      { id: "n2", pitch_midi: 64, onset_sec: 0.6, offset_sec: 1.2, velocity: 85, track_index: 0 },
      { id: "n3", pitch_midi: 67, onset_sec: 1.5, offset_sec: 2.0, velocity: 85, track_index: 0 },
    ];

    const { container } = render(
      <PianoRollEditor
        notes={notes}
        durationSeconds={4}
        tempoBpm={120}
        timeSignature="4/4"
        playheadSec={0.8}
        isPlaying={true}
        selectedNoteId="n1"
        onSelectNote={vi.fn()}
        onChangeNotes={vi.fn()}
        onTogglePlay={vi.fn()}
        onStopPlay={vi.fn()}
        onPlayheadChange={vi.fn()}
        playbackRate={1}
        onPlaybackRateChange={vi.fn()}
        loop={false}
        onToggleLoop={vi.fn()}
      />,
    );

    const naturalLane = container.querySelector('[data-pitch-lane="60"]');
    const sharpLane = container.querySelector('[data-pitch-lane="61"]');
    expect(naturalLane?.className).toContain("bg-white");
    expect(naturalLane?.className).toContain("dark:bg-[#09090F]");
    expect(sharpLane?.className).toContain("bg-[#eceae4]");
    expect(sharpLane?.className).toContain("dark:bg-[#121524]");

    const selectedNote = container.querySelector('[data-note-id="n1"]');
    const soundingNote = container.querySelector('[data-note-id="n2"]');
    const defaultNote = container.querySelector('[data-note-id="n3"]');

    expect(selectedNote?.className).toContain("bg-[#4f46e5]");
    expect(selectedNote?.className).toContain("border-[#1e1b4b]");
    expect(soundingNote?.className).toContain("bg-[#059669]");
    expect(defaultNote?.className).toContain("bg-[#6d28d9]");
    expect(defaultNote?.className).toContain("border-[#4c1d95]");
    expect(defaultNote?.className).toContain("text-white");
  });

  it("renders VirtualPianoKeyboard white keys and solid dark black keys with active highlights", () => {
    render(
      <VirtualPianoKeyboard
        minPitch={60}
        maxPitch={72}
        activePlaybackNotes={[{ pitchMidi: 60, trackIndex: 0 }]}
        activeMidiPitches={new Set([61])}
        onKeyDown={vi.fn()}
        onKeyUp={vi.fn()}
      />,
    );

    const activeWhite = screen.getByRole("button", { name: "Piano key C4" });
    const inactiveWhite = screen.getByRole("button", { name: "Piano key D4" });
    const activeBlack = screen.getByRole("button", { name: "Piano key C#4" });
    const inactiveBlack = screen.getByRole("button", { name: "Piano key D#4" });

    expect(activeWhite.className).toContain("bg-[#7c3aed]");
    expect(activeWhite.className).toContain("text-white");
    expect(inactiveWhite.className).toContain("bg-white");
    expect(inactiveWhite.className).toContain("border-slate-300");

    expect(activeBlack.className).toContain("bg-[#8b5cf6]");
    expect(inactiveBlack.className).toContain("bg-[#1e293b]");
    expect(inactiveBlack.className).toContain("border-[#0f172a]");
  });
});
