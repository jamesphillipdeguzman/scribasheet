import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCursorEl, mockSvgGroup, mockOsmdInstance } = vi.hoisted(() => {
  const cursorEl = document.createElement("img");
  Object.defineProperty(cursorEl, "offsetLeft", { value: 120, configurable: true });
  Object.defineProperty(cursorEl, "offsetTop", { value: 40, configurable: true });
  Object.defineProperty(cursorEl, "offsetHeight", { value: 180, configurable: true });

  const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
  pathEl.setAttribute("fill", "#000000");
  const svgGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svgGroup.appendChild(pathEl);

  const inst = {
    load: async (_xml?: string) => undefined,
    render: () => undefined,
    Dispose: () => undefined,
    Zoom: 1,
    EngravingRules: { RenderChordSymbols: true },
    cursor: {
      cursorElement: cursorEl,
      show: () => undefined,
      hide: () => undefined,
      reset: () => undefined,
      next: () => undefined,
      update: () => undefined,
      GNotesUnderCursor: () => [
        {
          getSVGGElement: () => svgGroup,
          sourceNote: { ParentStaffEntry: { ParentStaff: { idInMusicSheet: 0 } } },
        },
      ],
      iterator: { EndReached: false, CurrentMeasureIndex: 0, currentTimeStamp: { RealValue: 0 } },
    },
    GraphicSheet: {
      MeasureList: [
        [
          {
            ParentMusicSystem: {
              Id: 2,
              PositionAndShape: { AbsolutePosition: { y: 10 }, Size: { height: 22 } },
            },
          },
        ],
      ],
    },
  };
  return { mockCursorEl: cursorEl, mockSvgGroup: svgGroup, mockOsmdInstance: inst };
});

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: function MockOpenSheetMusicDisplay() {
    return mockOsmdInstance;
  },
}));

import {
  buildMusicXmlTimeline,
  findCursorSnapshotIndex,
  timeSecToWholeNotes,
  wholeNotesToTimeSec,
} from "@/features/editor/musicXmlTimeline";
import {
  addMeasureToAllParts,
  convertXmlNoteToRest,
  deleteMeasureFromAllParts,
  musicXmlToScoreNotes,
  setXmlNoteAccidental,
  setXmlNoteDuration,
  transposeXmlNote,
} from "@/features/editor/musicXmlEditor";
import { midiSynth } from "@/features/editor/midiSynth";
import { PianoRollEditor } from "@/features/editor/PianoRollEditor";
import {
  cleanDisplayScoreTitle,
  prepareDisplayMusicXml,
  SheetMusicViewer,
} from "@/features/editor/SheetMusicViewer";
import { normalizeScorePayload } from "@/features/editor/musicXmlNormalization";
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
    vi.spyOn(midiSynth, "startSustainedNote").mockImplementation(() => { });
    vi.spyOn(midiSynth, "stopSustainedNote").mockImplementation(() => { });
    vi.spyOn(midiSynth, "stopAllSustainedNotes").mockImplementation(() => { });
    vi.spyOn(midiSynth, "triggerNote").mockImplementation(() => { });
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

  it("renders vertical blue playhead spanning SATB system, highlights noteheads, strips title extensions, and pauses auto-scroll on manual wheel", async () => {
    expect(cleanDisplayScoreTitle("Go Tell It On The Mountain.Pdf")).toBe("Go Tell It On The Mountain");
    expect(cleanDisplayScoreTitle("Hymn.mxl")).toBe("Hymn");
    expect(cleanDisplayScoreTitle("Choir.musicxml")).toBe("Choir");
    expect(cleanDisplayScoreTitle("Demo.mid")).toBe("Demo");
    expect(cleanDisplayScoreTitle("Track.mp3")).toBe("Track");

    const brandedXml = prepareDisplayMusicXml(
      `<score-partwise version="3.1"><work><work-title>Go Tell It.Pdf</work-title></work><part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list><part id="P1"><measure number="1"/></part></score-partwise>`,
      true,
    );
    expect(brandedXml).toContain("<work-title>Go Tell It</work-title>");

    const { rerender } = render(
      <SheetMusicViewer
        musicxml={sampleXml}
        playheadSec={0.25}
        isPlaying={true}
        tempoBpm={120}
        tracks={tracks}
      />,
    );

    const playhead = await screen.findByTestId("sheet-music-playhead");
    expect(playhead.style.width).toBe("3px");
    expect(playhead.style.backgroundColor).toBe("rgb(59, 130, 246)");
    expect(playhead.style.pointerEvents).toBe("none");
    // System height: 22 * 10 * 0.9 = 198px
    expect(playhead.style.height).toBe("198px");
    expect(mockCursorEl.style.opacity).toBe("0");

    // Soprano notehead highlighted in blue (#3b82f6)
    const pathEl = mockSvgGroup.querySelector("path")!;
    expect(pathEl.getAttribute("fill")).toBe("#3b82f6");

    // Manual wheel event pauses auto-scroll without throwing
    const scroller = screen.getByTestId("sheet-music-scroll-container");
    const scrollToSpy = vi.fn();
    scroller.scrollTo = scrollToSpy;
    fireEvent.wheel(scroller, { deltaY: 120 });
    expect(scrollToSpy).not.toHaveBeenCalled();

    // Stop at 0 restores original notehead fill
    rerender(
      <SheetMusicViewer
        musicxml={sampleXml}
        playheadSec={0}
        isPlaying={false}
        tempoBpm={120}
        tracks={tracks}
      />,
    );
    expect(pathEl.getAttribute("fill")).toBe("#000000");
  });

  it("normalizes missing XML declarations, BOM/whitespace, score-timewise, URLs, compressed MXL, and legacy/empty payloads safely", async () => {
    // 1. Valid MusicXML without <?xml declaration + leading BOM & whitespace
    const noDecl = `\uFEFF   <score-partwise version="3.1"><work><work-title>Song.Pdf</work-title></work><identification><creator type="composer">Music21</creator><creator type="lyricist">J. Doe</creator></identification><part-list><score-part id="P1"><part-name>P1</part-name></score-part></part-list><part id="P1"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type><lyric><text>Grace</text></lyric></note></measure></part></score-partwise>`;
    const normNoDecl = normalizeScorePayload(noDecl, true);
    expect(normNoDecl.kind).toBe("xml");
    if (normNoDecl.kind === "xml") {
      expect(normNoDecl.xml.startsWith("<?xml")).toBe(true);
      expect(normNoDecl.xml).toContain("<work-title>Song</work-title>");
      expect(normNoDecl.xml).toContain("ScribaSheet");
      expect(normNoDecl.xml).toContain("J. Doe");
      expect(normNoDecl.xml).toContain("<text>Grace</text>");
      expect(normNoDecl.xml).not.toContain(">Music21<");
    }

    // 2. Existing XML declaration is preserved without duplication
    const withDecl = normalizeScorePayload(sampleXml, true);
    expect(withDecl.kind).toBe("xml");
    if (withDecl.kind === "xml") {
      expect(withDecl.xml.match(/<\?xml\b/g)?.length).toBe(1);
    }

    // 3. Valid score-timewise document
    const timewise = `<score-timewise version="3.1"><part-list><score-part id="P1"><part-name>P1</part-name></score-part></part-list><measure number="1"><part id="P1"/></measure></score-timewise>`;
    const normTimewise = normalizeScorePayload(timewise, true);
    expect(normTimewise.kind).toBe("xml");
    if (normTimewise.kind === "xml") {
      expect(normTimewise.xml.startsWith("<?xml")).toBe(true);
    }

    // 4. Compressed MXL binary, JSON legacy, non-XML, and empty/null
    expect(normalizeScorePayload("PK\x03\x04binary-mxl").kind).toBe("compressed_mxl");
    expect(normalizeScorePayload('{"notes": []}').kind).toBe("invalid");
    expect(normalizeScorePayload("not xml at all").kind).toBe("invalid");
    expect(normalizeScorePayload("").kind).toBe("empty");
    expect(normalizeScorePayload(null).kind).toBe("empty");

    // 5. Empty state renders clean user message
    const { rerender } = render(<SheetMusicViewer musicxml={null} />);
    expect(screen.getByTestId("sheet-music-empty")).toHaveTextContent(
      /No sheet music XML available for this project/i,
    );

    // 6. Invalid JSON payload shows error without calling osmd.load
    const loadSpy = vi.spyOn(mockOsmdInstance, "load");
    rerender(<SheetMusicViewer musicxml='{"legacy": true}' />);
    expect(await screen.findByText(/Unsupported legacy JSON score payload/i)).toBeInTheDocument();
    expect(loadSpy).not.toHaveBeenCalled();

    // 7. URL-based score payload fetches and normalizes XML; failed URL shows error
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "application/xml" }),
      text: async () => noDecl,
    });
    vi.stubGlobal("fetch", fetchMock);
    rerender(<SheetMusicViewer musicxml="https://example.com/score.musicxml" />);
    await screen.findByTestId("sheet-music-playhead");
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/score.musicxml", expect.any(Object));
    expect(loadSpy).toHaveBeenCalled();
    const loadedArg = loadSpy.mock.calls[0]?.[0] as string;
    expect(loadedArg.startsWith("<?xml")).toBe(true);

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => "Not Found",
    });
    rerender(<SheetMusicViewer musicxml="https://example.com/missing.musicxml" />);
    expect(await screen.findByText(/Failed to retrieve sheet music \(404\)/i)).toBeInTheDocument();
  });

  it("supports direct MusicXML note/measure editing, keyboard shortcuts, and ScoreData synchronization", async () => {
    const satbXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Alto</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>quarter</type><lyric><text>Sing</text></lyric></note>
      <direction><sound tempo="60"/></direction>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>6</duration><type>half</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>8</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

    // Mid-measure tempo change: beat 1 at 120 BPM (0.5s), beats 2-4 at 60 BPM (3.0s) -> total 3.5s
    const midTimeline = buildMusicXmlTimeline(satbXml, 120);
    expect(midTimeline.segments).toHaveLength(2);
    expect(midTimeline.segments[0].secEnd).toBeCloseTo(0.5, 3);
    expect(midTimeline.segments[1].secEnd).toBeCloseTo(3.5, 3);

    // Binary search snapshot lookup
    const snaps = [
      { wholeNote: 0, sec: 0, stepIndex: 0 },
      { wholeNote: 0.25, sec: 0.5, stepIndex: 1 },
      { wholeNote: 1.0, sec: 3.5, stepIndex: 2 },
    ];
    expect(findCursorSnapshotIndex(snaps, 0.4)).toBe(0);
    expect(findCursorSnapshotIndex(snaps, 0.55)).toBe(1);
    expect(findCursorSnapshotIndex(snaps, 3.6)).toBe(2);

    // Structured MusicXML edits preserve lyrics and sync ScoreData
    const target = { partIndex: 0, measureNumber: 1, onsetWhole: 0, pitchMidi: 72 };
    const up = transposeXmlNote(satbXml, target, 1)!;
    expect(up.nextTarget.pitchMidi).toBe(73);
    expect(up.xml).toContain("<text>Sing</text>");

    const oct = transposeXmlNote(up.xml, up.nextTarget, 12)!;
    expect(oct.nextTarget.pitchMidi).toBe(85);

    const flat = setXmlNoteAccidental(oct.xml, oct.nextTarget, "flat")!;
    expect(flat.xml).toContain("<accidental>flat</accidental>");

    const eighth = setXmlNoteDuration(flat.xml, flat.nextTarget, "eighth")!;
    expect(eighth.xml).toContain("<type>eighth</type>");

    const restRes = convertXmlNoteToRest(eighth.xml, eighth.nextTarget)!;
    expect(restRes.xml).toContain("<rest");

    // Add & Delete measure across ALL SATB parts
    const addedXml = addMeasureToAllParts(satbXml, 1)!;
    const addedDoc = new DOMParser().parseFromString(addedXml, "application/xml");
    expect(addedDoc.getElementsByTagName("part")[0].getElementsByTagName("measure")).toHaveLength(2);
    expect(addedDoc.getElementsByTagName("part")[1].getElementsByTagName("measure")).toHaveLength(2);

    const synced = musicXmlToScoreNotes(
      up.xml,
      [
        { index: 0, name: "Soprano", instrument: "piano", clef: "treble", program: 0, muted: false },
        { index: 1, name: "Alto", instrument: "piano", clef: "treble", program: 0, muted: false },
      ],
      120,
    );
    expect(synced.notes.some((n) => n.pitch_midi === 73 && n.track_index === 0)).toBe(true);

    const deletedXml = deleteMeasureFromAllParts(addedXml, 2)!;
    const delDoc = new DOMParser().parseFromString(deletedXml, "application/xml");
    expect(delDoc.getElementsByTagName("part")[0].getElementsByTagName("measure")).toHaveLength(1);

    // UI Edit Notation toggle pauses playback if playing and exposes editing toolbar
    const onMusicXmlChange = vi.fn();
    const onTogglePlay = vi.fn();
    render(
      <SheetMusicViewer
        musicxml={satbXml}
        isPlaying={true}
        onTogglePlay={onTogglePlay}
        onMusicXmlChange={onMusicXmlChange}
      />,
    );
    expect(screen.queryByTestId("notation-edit-toolbar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit notation" }));
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("notation-edit-toolbar")).toBeInTheDocument();
  });
});
