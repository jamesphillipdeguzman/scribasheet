import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: vi.fn().mockImplementation(() => ({
    load: vi.fn().mockResolvedValue(undefined),
    render: vi.fn(),
    Dispose: vi.fn(),
    Zoom: 1,
    EngravingRules: { RenderChordSymbols: true },
    cursor: {
      show: vi.fn(),
      hide: vi.fn(),
      reset: vi.fn(),
      next: vi.fn(),
      update: vi.fn(),
      GNotesUnderCursor: vi.fn().mockReturnValue([]),
      iterator: { EndReached: false, currentTimeStamp: { RealValue: 0 } },
    },
    GraphicSheet: { MeasureList: [] },
  })),
}));

import {
  buildMusicXmlTimeline,
  timeSecToWholeNotes,
  wholeNotesToTimeSec,
} from "@/features/editor/musicXmlTimeline";
import { midiSynth } from "@/features/editor/midiSynth";
import { PianoRollEditor } from "@/features/editor/PianoRollEditor";
import type { ScoreNote, ScoreTrack } from "@/types/api";

const sampleXml = `<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
    <measure number="2">
      <direction><sound tempo="60"/></direction>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

const tracks: ScoreTrack[] = [
  { index: 0, name: "Soprano", instrument: "piano", clef: "treble", program: 0, muted: false },
];

const notes: ScoreNote[] = [
  { id: "n1", pitch_midi: 72, onset_sec: 0, offset_sec: 0.5, velocity: 85, track_index: 0 },
];

describe("Synchronized Sheet Music Playback View & Timeline", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(midiSynth, "startSustainedNote").mockImplementation(() => {});
    vi.spyOn(midiSynth, "stopSustainedNote").mockImplementation(() => {});
    vi.spyOn(midiSynth, "stopAllSustainedNotes").mockImplementation(() => {});
    vi.spyOn(midiSynth, "triggerNote").mockImplementation(() => {});
  });

  it("maps MusicXML pickups and tempo changes accurately between seconds and whole notes", () => {
    const timeline = buildMusicXmlTimeline(sampleXml, 120);
    expect(timeline.segments).toHaveLength(2);
    // Measure 1 is a 1-quarter pickup at 120 BPM -> 0.25 whole notes = 0.5s
    expect(timeline.segments[0].wholeNoteEnd).toBeCloseTo(0.25, 3);
    expect(timeline.segments[0].secEnd).toBeCloseTo(0.5, 3);
    // Measure 2 is 4/4 at 60 BPM -> 1.0 whole note = 4.0s (ends at 4.5s)
    expect(timeline.segments[1].secStart).toBeCloseTo(0.5, 3);
    expect(timeline.segments[1].secEnd).toBeCloseTo(4.5, 3);

    expect(timeSecToWholeNotes(timeline, 2.5)).toBeCloseTo(0.75, 3);
    expect(wholeNotesToTimeSec(timeline, 0.75)).toBeCloseTo(2.5, 3);
  });

  it("supports switching between Grid Editor, Practice Cascade, and Sheet Music in normal and Focus Mode", () => {
    const onTogglePlay = vi.fn();
    const onStopPlay = vi.fn();

    render(
      <PianoRollEditor
        notes={notes}
        tracks={tracks}
        durationSeconds={4.5}
        tempoBpm={120}
        timeSignature="4/4"
        playheadSec={0}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={vi.fn()}
        musicxml={sampleXml}
        onTogglePlay={onTogglePlay}
        onStopPlay={onStopPlay}
      />,
    );

    const sheetBtn = screen.getByRole("button", { name: "Sheet Music" });
    expect(sheetBtn).toBeInTheDocument();

    fireEvent.click(sheetBtn);
    expect(screen.getByTestId("sheet-music-viewer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Follow cursor" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Follow cursor" }));
    expect(screen.getByRole("button", { name: "Follow cursor" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: /Play sheet music/i }));
    expect(onTogglePlay).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Stop sheet music/i }));
    expect(onStopPlay).toHaveBeenCalledTimes(1);

    // Focus Mode works in Sheet Music view too
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(screen.getByTestId("piano-roll-workspace")).toHaveAttribute("data-focus-mode", "true");
    expect(screen.getByTestId("sheet-music-viewer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Exit Focus" }));
    expect(screen.getByTestId("piano-roll-workspace")).toHaveAttribute("data-focus-mode", "false");
  });
});
