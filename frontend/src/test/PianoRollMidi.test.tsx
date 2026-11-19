import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PianoRollEditor } from "@/features/editor/PianoRollEditor";
import { midiSynth } from "@/features/editor/midiSynth";
import {
  buildQuantizedRecordedNotes,
  mergeOrReplaceRecordedNotes,
  rePitchSelectedNotes,
} from "@/features/editor/midiRecordingUtils";
import type { ScoreNote, ScoreTrack } from "@/types/api";

const sampleTracks: ScoreTrack[] = [
  { index: 0, name: "Vocal Melody", instrument: "vocals", clef: "treble", program: 0, muted: false },
  { index: 1, name: "Piano Accompaniment", instrument: "piano", clef: "grand", program: 0, muted: false },
];

const sampleNotes: ScoreNote[] = [
  { id: "v1", pitch_midi: 64, onset_sec: 0.0, offset_sec: 0.5, velocity: 90, track_index: 0 },
  { id: "p1", pitch_midi: 48, onset_sec: 0.0, offset_sec: 1.0, velocity: 80, track_index: 1 },
  { id: "p2", pitch_midi: 52, onset_sec: 0.0, offset_sec: 1.0, velocity: 80, track_index: 1 },
];

function createMockMidiEnvironment() {
  const port1 = {
    id: "midi-1",
    name: "Yamaha Digital Piano",
    manufacturer: "Yamaha",
    state: "connected" as "connected" | "disconnected",
    onmidimessage: null as ((ev: { data: Uint8Array; timeStamp?: number }) => void) | null,
  };
  const port2 = {
    id: "midi-2",
    name: "Roland FP-30X",
    manufacturer: "Roland",
    state: "connected" as "connected" | "disconnected",
    onmidimessage: null as ((ev: { data: Uint8Array; timeStamp?: number }) => void) | null,
  };
  const inputs = new Map([
    [port1.id, port1],
    [port2.id, port2],
  ]);
  const access = {
    inputs,
    onstatechange: null as ((ev: { port?: typeof port1 }) => void) | null,
  };
  const requestMIDIAccess = vi.fn().mockResolvedValue(access);
  Object.defineProperty(navigator, "requestMIDIAccess", {
    configurable: true,
    writable: true,
    value: requestMIDIAccess,
  });
  return { port1, port2, inputs, access, requestMIDIAccess };
}

describe("Virtual Piano, Web MIDI, Re-pitch, and Recording", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(midiSynth, "startSustainedNote").mockImplementation(() => {});
    vi.spyOn(midiSynth, "stopSustainedNote").mockImplementation(() => {});
    vi.spyOn(midiSynth, "stopAllSustainedNotes").mockImplementation(() => {});
    vi.spyOn(midiSynth, "triggerNote").mockImplementation(() => {});
    vi.spyOn(midiSynth, "playMetronomeClick").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders 88-key virtual piano with octave labels and auditions on click", () => {
    const onChangeNotes = vi.fn();
    render(
      <PianoRollEditor
        notes={sampleNotes}
        tracks={sampleTracks}
        durationSeconds={4}
        tempoBpm={120}
        playheadSec={0}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={onChangeNotes}
      />,
    );

    const keyboard = screen.getByTestId("virtual-piano-keyboard");
    expect(keyboard).toBeInTheDocument();
    expect(within(keyboard).getByText("C4")).toBeInTheDocument();
    expect(within(keyboard).getByText("C2")).toBeInTheDocument();
    expect(within(keyboard).getByText("C7")).toBeInTheDocument();

    const c4Key = screen.getByRole("button", { name: "Piano key C4" });
    fireEvent.mouseDown(c4Key);
    expect(midiSynth.startSustainedNote).toHaveBeenCalledWith(60, 90, 0.7);
    expect(c4Key.className).toContain("bg-[#A78BFA]");

    fireEvent.mouseUp(c4Key);
    expect(midiSynth.stopSustainedNote).toHaveBeenCalledWith(60);
    // Audition without selection does not mutate notes
    expect(onChangeNotes).not.toHaveBeenCalled();
  });

  it("requests MIDI access only on Connect click, lists devices, highlights note-on/note-off, and handles disconnect", async () => {
    const { port1, access, requestMIDIAccess } = createMockMidiEnvironment();

    render(
      <PianoRollEditor
        notes={sampleNotes}
        tracks={sampleTracks}
        durationSeconds={4}
        tempoBpm={120}
        playheadSec={0}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={vi.fn()}
      />,
    );

    expect(requestMIDIAccess).not.toHaveBeenCalled();
    expect(screen.getByTestId("midi-connection-status")).toHaveTextContent("Not Connected");

    fireEvent.click(screen.getByRole("button", { name: /Connect MIDI Device/i }));
    await waitFor(() => {
      expect(requestMIDIAccess).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByTestId("midi-connection-status")).toHaveTextContent(
      "Connected: Yamaha Digital Piano",
    );
    const deviceSelect = screen.getByLabelText("MIDI Input Device") as HTMLSelectElement;
    expect(deviceSelect.options).toHaveLength(2);
    expect(deviceSelect.options[1].text).toBe("Roland FP-30X");

    // MIDI note-on (C4 = 60, vel = 100) highlights virtual key & plays audio
    act(() => {
      port1.onmidimessage?.({ data: new Uint8Array([0x90, 60, 100]), timeStamp: 100 });
    });
    const c4Key = screen.getByRole("button", { name: "Piano key C4" });
    expect(c4Key.className).toContain("bg-[#A78BFA]");
    expect(midiSynth.startSustainedNote).toHaveBeenCalledWith(60, 100, 0.7);

    // MIDI note-off releases virtual key
    act(() => {
      port1.onmidimessage?.({ data: new Uint8Array([0x80, 60, 0]), timeStamp: 250 });
    });
    expect(c4Key.className).not.toContain("bg-[#A78BFA]");
    expect(midiSynth.stopSustainedNote).toHaveBeenCalledWith(60);

    // Device disconnection handled gracefully without crashing
    act(() => {
      for (const p of access.inputs.values()) {
        p.state = "disconnected";
      }
      access.onstatechange?.({ port: port1 });
    });
    expect(screen.getByTestId("midi-connection-status")).toHaveTextContent("Device Disconnected");
  });

  it("re-pitches a selected note preserving timing/velocity and transposes multi-selection preserving intervals", () => {
    const onChangeNotes = vi.fn();
    render(
      <PianoRollEditor
        notes={sampleNotes}
        tracks={sampleTracks}
        durationSeconds={4}
        tempoBpm={120}
        playheadSec={0}
        selectedNoteId="v1"
        onSelectNote={vi.fn()}
        onChangeNotes={onChangeNotes}
      />,
    );

    expect(screen.getByText(/Re-pitch armed \(1 selected\)/i)).toBeInTheDocument();

    // Press G4 (67) -> v1 pitch changes from 64 to 67, timing/velocity/track preserved
    fireEvent.mouseDown(screen.getByRole("button", { name: "Piano key G4" }));
    expect(onChangeNotes).toHaveBeenCalledTimes(1);
    const updated = onChangeNotes.mock.calls[0][0] as ScoreNote[];
    const v1 = updated.find((n) => n.id === "v1")!;
    expect(v1.pitch_midi).toBe(67);
    expect(v1.onset_sec).toBe(0.0);
    expect(v1.offset_sec).toBe(0.5);
    expect(v1.velocity).toBe(90);
    expect(v1.track_index).toBe(0);

    // Multi-note interval preservation: p1 (48) + p2 (52) transposed to anchor 55 (G3) -> 55 and 59
    const transposed = rePitchSelectedNotes(sampleNotes, new Set(["p1", "p2"]), 55);
    expect(transposed.find((n) => n.id === "p1")?.pitch_midi).toBe(55);
    expect(transposed.find((n) => n.id === "p2")?.pitch_midi).toBe(59);
    expect(transposed.find((n) => n.id === "v1")?.pitch_midi).toBe(64);
  });

  it("records MIDI with count-in exclusion, snap quantization, merge/replace target-part isolation", async () => {
    vi.useFakeTimers();
    const { port1 } = createMockMidiEnvironment();
    const onChangeNotes = vi.fn();

    render(
      <PianoRollEditor
        notes={sampleNotes}
        tracks={sampleTracks}
        durationSeconds={4}
        tempoBpm={120}
        timeSignature="4/4"
        playheadSec={1.0}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={onChangeNotes}
      />,
    );

    // Connect MIDI
    fireEvent.click(screen.getByRole("button", { name: /Connect MIDI Device/i }));
    await act(async () => {
      await Promise.resolve();
    });

    // Switch to Record MIDI mode, select 1/8 snap and Replace Part (Piano Accompaniment = track 1)
    fireEvent.click(screen.getByRole("button", { name: "Record MIDI" }));
    fireEvent.change(screen.getByLabelText("Snap quantization"), { target: { value: "1/8" } });
    fireEvent.change(screen.getByLabelText("Recording Mode"), { target: { value: "replace" } });

    // Start recording (4 beats count-in at 120 BPM = 2000ms)
    fireEvent.click(screen.getByRole("button", { name: /^Record$/i }));
    expect(screen.getByText("Count-in...")).toBeInTheDocument();

    // Notes played during count-in MUST be ignored
    act(() => {
      port1.onmidimessage?.({ data: new Uint8Array([0x90, 60, 90]) });
      port1.onmidimessage?.({ data: new Uint8Array([0x80, 60, 0]) });
    });

    // Advance past 2000ms count-in
    act(() => {
      vi.advanceTimersByTime(2050);
    });
    expect(screen.getByText(/REC 00:00/i)).toBeInTheDocument();

    // Play C4 (60) for 300ms during actual recording
    act(() => {
      port1.onmidimessage?.({ data: new Uint8Array([0x90, 60, 96]) });
      vi.advanceTimersByTime(300);
      port1.onmidimessage?.({ data: new Uint8Array([0x80, 60, 0]) });
    });

    // Stop recording
    fireEvent.click(screen.getByRole("button", { name: /Stop/i }));
    expect(onChangeNotes).toHaveBeenCalledTimes(1);
    const resultNotes = onChangeNotes.mock.calls[0][0] as ScoreNote[];

    // Vocal Melody (v1, track 0) is preserved even in Replace Part mode; old piano (track 1) replaced
    expect(resultNotes.some((n) => n.id === "v1")).toBe(true);
    expect(resultNotes.some((n) => n.id === "p1")).toBe(false);
    const recorded = resultNotes.filter((n) => n.track_index === 1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].pitch_midi).toBe(60);
    expect(recorded[0].onset_sec).toBeGreaterThanOrEqual(1.0);
    expect(recorded[0].offset_sec - recorded[0].onset_sec).toBeGreaterThanOrEqual(0.125);
  });

  it("quantizes recorded notes to 1/16 and 1/8 and merges without overwriting existing notes", () => {
    const q16 = buildQuantizedRecordedNotes(
      [{ pitchMidi: 64, velocity: 88, onsetSec: 0.13, offsetSec: 0.37 }],
      { tempoBpm: 120, snapMode: "1/16", targetTrackIndex: 1 },
    );
    expect(q16[0].onset_sec).toBe(0.125);
    expect(q16[0].offset_sec).toBe(0.375);

    const q8 = buildQuantizedRecordedNotes(
      [{ pitchMidi: 64, velocity: 88, onsetSec: 0.22, offsetSec: 0.23 }],
      { tempoBpm: 120, snapMode: "1/8", targetTrackIndex: 1 },
    );
    expect(q8[0].onset_sec).toBe(0.25);
    expect(q8[0].offset_sec - q8[0].onset_sec).toBeGreaterThanOrEqual(0.125);

    const merged = mergeOrReplaceRecordedNotes(sampleNotes, q16, {
      mode: "merge",
      targetTrackIndex: 1,
    });
    expect(merged).toHaveLength(sampleNotes.length + 1);
  });
});
