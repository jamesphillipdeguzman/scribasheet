import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeCascadeNotePositions,
  computeKeyLayoutMap,
  getCascadeTrackPalette,
  SATB_CASCADE_COLORS,
} from "@/features/editor/cascadeUtils";
import { midiSynth } from "@/features/editor/midiSynth";
import { PianoRollEditor } from "@/features/editor/PianoRollEditor";
import type { ScoreNote, ScoreTrack } from "@/types/api";

const satbTracks: ScoreTrack[] = [
  { index: 0, name: "Soprano", instrument: "piano", clef: "treble", program: 0, muted: false },
  { index: 1, name: "Alto", instrument: "piano", clef: "treble", program: 0, muted: false },
  { index: 2, name: "Tenor", instrument: "piano", clef: "treble", program: 0, muted: false },
  { index: 3, name: "Bass", instrument: "piano", clef: "bass", program: 0, muted: false },
];

const satbNotes: ScoreNote[] = [
  { id: "s1", pitch_midi: 72, onset_sec: 1.0, offset_sec: 2.0, velocity: 90, track_index: 0 },
  { id: "a1", pitch_midi: 67, onset_sec: 1.0, offset_sec: 2.0, velocity: 85, track_index: 1 },
  { id: "t1", pitch_midi: 64, onset_sec: 1.0, offset_sec: 2.0, velocity: 85, track_index: 2 },
  { id: "b1", pitch_midi: 48, onset_sec: 1.0, offset_sec: 2.0, velocity: 85, track_index: 3 },
];

describe("Practice Cascade – Falling-Notes MIDI Visualization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(midiSynth, "startSustainedNote").mockImplementation(() => {});
    vi.spyOn(midiSynth, "stopSustainedNote").mockImplementation(() => {});
    vi.spyOn(midiSynth, "stopAllSustainedNotes").mockImplementation(() => {});
    vi.spyOn(midiSynth, "triggerNote").mockImplementation(() => {});
    vi.spyOn(midiSynth, "start").mockImplementation(() => {});
    vi.spyOn(midiSynth, "stop").mockImplementation(() => {});
  });

  it("defaults to Grid Editor, switches to Practice Cascade without mutating notes, and supports auto-switch on Play", () => {
    const onChangeNotes = vi.fn();
    const { rerender } = render(
      <PianoRollEditor
        notes={satbNotes}
        tracks={satbTracks}
        durationSeconds={8}
        tempoBpm={120}
        playheadSec={0.5}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={onChangeNotes}
        isPlaying={false}
      />,
    );

    // Grid Editor is default
    expect(screen.getByRole("button", { name: "Grid Editor" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Add Note/i })).toBeInTheDocument();
    expect(screen.queryByTestId("practice-cascade-view")).not.toBeInTheDocument();

    // Auto-switch checkbox is disabled by default
    const autoSwitch = screen.getByLabelText(/Auto-switch to Practice Cascade on Play/i) as HTMLInputElement;
    expect(autoSwitch.checked).toBe(false);

    // Manual switch to Practice Cascade
    fireEvent.click(screen.getByRole("button", { name: "Practice Cascade" }));
    expect(screen.getByTestId("practice-cascade-view")).toBeInTheDocument();
    expect(screen.getByTestId("practice-cascade-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("virtual-piano-keyboard")).toBeInTheDocument();
    expect(screen.getByLabelText("Look-ahead window")).toHaveValue("3");

    // Switch back to Grid Editor -> zero note mutations
    fireEvent.click(screen.getByRole("button", { name: "Grid Editor" }));
    expect(screen.getByRole("button", { name: /Add Note/i })).toBeInTheDocument();
    expect(onChangeNotes).not.toHaveBeenCalled();

    // Enable Auto-switch and simulate playback starting
    fireEvent.click(autoSwitch);
    expect(autoSwitch.checked).toBe(true);
    rerender(
      <PianoRollEditor
        notes={satbNotes}
        tracks={satbTracks}
        durationSeconds={8}
        tempoBpm={120}
        playheadSec={0.5}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={onChangeNotes}
        isPlaying={true}
      />,
    );
    expect(screen.getByTestId("practice-cascade-view")).toBeInTheDocument();
  });

  it("aligns white and black piano keys accurately and scales on resize", () => {
    const layout780 = computeKeyLayoutMap(21, 108, 780);
    const layout1560 = computeKeyLayoutMap(21, 108, 1560);

    const c4Small = layout780.get(60)!;
    const cs4Small = layout780.get(61)!;
    const d4Small = layout780.get(62)!;

    expect(c4Small.isBlack).toBe(false);
    expect(cs4Small.isBlack).toBe(true);
    expect(cs4Small.x).toBeGreaterThan(c4Small.x);
    expect(cs4Small.x).toBeLessThan(d4Small.x);
    expect(cs4Small.width).toBeCloseTo(c4Small.width * 0.66, 2);

    // Resize doubles x and width proportionally
    const c4Large = layout1560.get(60)!;
    expect(c4Large.x).toBeCloseTo(c4Small.x * 2, 2);
    expect(c4Large.width).toBeCloseTo(c4Small.width * 2, 2);

    // DOM measured rects override fallback when provided
    const measured = new Map<number, { x: number; width: number }>([[60, { x: 412, width: 22 }]]);
    const layoutMeasured = computeKeyLayoutMap(21, 108, 1000, measured);
    expect(layoutMeasured.get(60)).toEqual({ pitch: 60, x: 412, width: 22, isBlack: false });
  });

  it("synchronizes falling note coordinates with playback clock, seek, and large MIDI windowing", () => {
    const hitLineY = 262;
    const lookAheadSec = 3.0;

    // At currentSec = 1.0, note onset=1.0 sits right at the hit line
    const atOnset = computeCascadeNotePositions(satbNotes, 1.0, lookAheadSec, hitLineY, new Set());
    expect(atOnset).toHaveLength(4);
    expect(atOnset[0].bottomY).toBeCloseTo(hitLineY, 2);
    expect(atOnset[0].isAtHitLine).toBe(true);

    // Seek to 0.0 -> note onset=1.0 is 1/3 up from hit line
    const atSeek0 = computeCascadeNotePositions(satbNotes, 0.0, lookAheadSec, hitLineY, new Set());
    expect(atSeek0[0].bottomY).toBeCloseTo(hitLineY * (2 / 3), 2);
    expect(atSeek0[0].isAtHitLine).toBe(false);

    // Large MIDI arrangement (2,500 notes): only notes inside the look-ahead window are returned
    const largeNotes: ScoreNote[] = Array.from({ length: 2500 }, (_, i) => ({
      id: `ln_${i}`,
      pitch_midi: 48 + (i % 24),
      onset_sec: i * 0.2,
      offset_sec: i * 0.2 + 0.15,
      velocity: 80,
      track_index: i % 4,
    }));
    const visible = computeCascadeNotePositions(largeNotes, 50.0, 3.0, hitLineY, new Set());
    expect(visible.length).toBeLessThan(30);
    expect(visible.length).toBeGreaterThan(10);
  });

  it("uses SATB color palette and responds to connected Alesis Concert live MIDI input", async () => {
    expect(getCascadeTrackPalette(satbTracks[0], 0).fill).toBe(SATB_CASCADE_COLORS.soprano.fill);
    expect(getCascadeTrackPalette(satbTracks[1], 1).fill).toBe(SATB_CASCADE_COLORS.alto.fill);
    expect(getCascadeTrackPalette(satbTracks[2], 2).fill).toBe(SATB_CASCADE_COLORS.tenor.fill);
    expect(getCascadeTrackPalette(satbTracks[3], 3).fill).toBe(SATB_CASCADE_COLORS.bass.fill);

    // Verify live MIDI matching within timing tolerance
    const matched = computeCascadeNotePositions(satbNotes, 0.95, 3.0, 262, new Set([72]));
    const sopMatch = matched.find((m) => m.note.id === "s1");
    expect(sopMatch?.isMatchedLive).toBe(true);

    // Connect Alesis Concert MIDI device through PianoRollEditor
    const alesisPort = {
      id: "alesis-1",
      name: "Alesis Concert",
      manufacturer: "Alesis",
      state: "connected" as const,
      onmidimessage: null as ((ev: { data: Uint8Array }) => void) | null,
    };
    Object.defineProperty(navigator, "requestMIDIAccess", {
      configurable: true,
      writable: true,
      value: vi.fn().mockResolvedValue({
        inputs: new Map([[alesisPort.id, alesisPort]]),
        onstatechange: null,
      }),
    });

    render(
      <PianoRollEditor
        notes={satbNotes}
        tracks={satbTracks}
        durationSeconds={8}
        tempoBpm={120}
        playheadSec={1.0}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Practice Cascade" }));
    fireEvent.click(screen.getByRole("button", { name: /Connect MIDI Device/i }));

    await waitFor(() => {
      expect(screen.getByTestId("midi-connection-status")).toHaveTextContent("Connected: Alesis Concert");
    });

    // Note On C5 (72) -> C5 key illuminates; Note Off -> key clears
    act(() => {
      alesisPort.onmidimessage?.({ data: new Uint8Array([0x90, 72, 100]) });
    });
    const c5Key = screen.getByRole("button", { name: "Piano key C5" });
    expect(c5Key.className).toContain("bg-[#A78BFA]");

    act(() => {
      alesisPort.onmidimessage?.({ data: new Uint8Array([0x80, 72, 0]) });
    });
    expect(c5Key.className).not.toContain("bg-[#A78BFA]");
  });

  it("supports Fullscreen Focus Mode for both Practice Cascade and Grid Editor, locks body scroll, exits on Escape/Exit Focus, and preserves MIDI connection", async () => {
    const alesisPort = {
      id: "alesis-1",
      name: "Alesis Concert",
      manufacturer: "Alesis",
      state: "connected" as const,
      onmidimessage: null as ((ev: { data: Uint8Array }) => void) | null,
    };
    const requestMIDIAccess = vi.fn().mockResolvedValue({
      inputs: new Map([[alesisPort.id, alesisPort]]),
      onstatechange: null,
    });
    Object.defineProperty(navigator, "requestMIDIAccess", {
      configurable: true,
      writable: true,
      value: requestMIDIAccess,
    });

    document.body.style.overflow = "auto";
    const onChangeNotes = vi.fn();

    const { unmount } = render(
      <PianoRollEditor
        notes={satbNotes}
        tracks={satbTracks}
        durationSeconds={8}
        tempoBpm={120}
        playheadSec={1.0}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={onChangeNotes}
      />,
    );

    // Connect Alesis Concert before entering Focus Mode
    fireEvent.click(screen.getByRole("button", { name: /Connect MIDI Device/i }));
    await waitFor(() => {
      expect(screen.getByTestId("midi-connection-status")).toHaveTextContent("Connected: Alesis Concert");
    });
    expect(requestMIDIAccess).toHaveBeenCalledTimes(1);

    const workspace = screen.getByTestId("piano-roll-workspace");
    expect(workspace).toHaveAttribute("data-focus-mode", "false");
    expect(document.body.style.overflow).toBe("auto");

    // Enter Focus Mode in Grid Editor
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(workspace).toHaveAttribute("data-focus-mode", "true");
    expect(workspace.className).toContain("fixed");
    expect(workspace.className).toContain("inset-0");
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getByRole("button", { name: /Add Note/i })).toBeInTheDocument();

    // Switch to Practice Cascade inside Focus Mode -> MIDI connection preserved without duplicate requestMIDIAccess
    fireEvent.click(screen.getByRole("button", { name: "Practice Cascade" }));
    expect(screen.getByTestId("practice-cascade-view")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Loop cascade" })).toBeInTheDocument();
    expect(screen.getByTestId("midi-connection-status")).toHaveTextContent("Connected: Alesis Concert");
    expect(requestMIDIAccess).toHaveBeenCalledTimes(1);

    // Live MIDI note still highlights in Focus Mode
    act(() => {
      alesisPort.onmidimessage?.({ data: new Uint8Array([0x90, 60, 100]) });
    });
    expect(screen.getByRole("button", { name: "Piano key C4" }).className).toContain("bg-[#A78BFA]");

    // Escape exits Focus Mode and restores body scroll
    fireEvent.keyDown(window, { key: "Escape" });
    expect(workspace).toHaveAttribute("data-focus-mode", "false");
    expect(document.body.style.overflow).toBe("auto");

    // Re-enter Focus Mode and exit via Exit Focus button
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(workspace).toHaveAttribute("data-focus-mode", "true");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Exit Focus" }));
    expect(workspace).toHaveAttribute("data-focus-mode", "false");
    expect(document.body.style.overflow).toBe("auto");

    // Enter Focus Mode and unmount -> cleanup restores body scroll
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });
});
