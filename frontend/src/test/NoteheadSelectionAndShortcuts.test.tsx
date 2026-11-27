import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";
import {
  DURATION_ORDER,
  TUPLET_RATIOS,
  stepNoteDurationType,
  getXmlNoteInfo,
  setXmlNoteDuration,
  toggleXmlNoteDot,
  toggleXmlNoteTie,
  toggleXmlNoteTuplet,
  convertXmlNoteToRest,
  deleteXmlNote,
  musicXmlToScoreNotes,
  type XmlNoteTarget,
} from "@/features/editor/musicXmlEditor";

// ---------------------------------------------------------------------------
// OSMD Mock with realistic multi-notehead chord & hollow bounding-box DOM
// Plain factory function with zero `vi` or outer-scope references inside vi.mock
// ---------------------------------------------------------------------------
vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: function MockOSMD(container: HTMLElement) {
    let loadedXml = "";
    const instance = {
      Zoom: 1,
      GraphicSheet: null as unknown,
      cursor: {
        show: () => {},
        hide: () => {},
        reset: () => {},
        next: () => {},
        update: () => {},
        CursorOptions: {},
        cursorElement: document.createElement("img"),
      },
      setOptions: () => {},
      clear: () => {
        container.innerHTML = "";
      },
      load: async (xml: string) => {
        loadedXml = xml;
      },
      render: () => {
        container.innerHTML = "";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("data-testid", "mock-osmd-svg");
        svg.setAttribute("width", "800");
        svg.setAttribute("height", "240");
        Object.defineProperty(svg, "getBoundingClientRect", {
          value: () => ({
            left: 0,
            top: 0,
            right: 800,
            bottom: 240,
            width: 800,
            height: 240,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          }),
        });

        const parser = new DOMParser();
        const doc = parser.parseFromString(loadedXml, "application/xml");
        const measures = Array.from(doc.querySelectorAll("part > measure"));

        const STEP_TO_SEMI: Record<string, number> = {
          C: 0,
          D: 2,
          E: 4,
          F: 5,
          G: 7,
          A: 9,
          B: 11,
        };

        let divisions = 480;
        let runningWhole = 0;

        const measureList: Array<{
          MeasureNumber: number;
          parentSourceMeasure: {
            MeasureNumber: number;
            AbsoluteTimestamp: { RealValue: number };
          };
          PositionAndShape: {
            AbsolutePosition: { x: number; y: number };
            Size: { width: number; height: number };
          };
          staffEntries: Array<{
            getAbsoluteTimestamp: () => { RealValue: number };
            graphicalVoiceEntries: Array<{
              notes: Array<{
                vfnoteIndex: number;
                sourceNote: {
                  isRest: () => boolean;
                  Pitch?: { halfTone: number };
                  ParentStaffEntry?: { ParentStaff?: { idInMusicSheet?: number } };
                };
                getSVGGElement: () => SVGGElement;
                getNoteheadSVGs: () => SVGGElement[];
              }>;
            }>;
          }>;
        }> = [];

        measures.forEach((mEl, mIdx) => {
          const divEl = mEl.querySelector("attributes > divisions");
          if (divEl?.textContent) {
            const parsedDiv = Number(divEl.textContent.trim());
            if (parsedDiv > 0) divisions = parsedDiv;
          }

          const mNum = Number(mEl.getAttribute("number") || String(mIdx + 1));
          const mLeft = 2 + mIdx * 36;
          const measureStartWhole = runningWhole;
          let measureCursorWhole = 0;
          let lastNonChordWhole = measureStartWhole;

          const staffEntries: (typeof measureList)[number]["staffEntries"] = [];
          const noteEls = Array.from(mEl.children).filter((c) => c.tagName === "note");
          let currentStaveNote: SVGGElement | null = null;
          let chordIdx = 0;
          let maxEndWholeInMeasure = measureStartWhole;

          noteEls.forEach((nEl, nIdx) => {
            const isChord = Boolean(nEl.querySelector(":scope > chord"));
            const isRest = Boolean(nEl.querySelector(":scope > rest"));
            const step = nEl.querySelector("pitch > step")?.textContent?.trim() || "C";
            const octave = Number(nEl.querySelector("pitch > octave")?.textContent || "4");
            const alter = Number(nEl.querySelector("pitch > alter")?.textContent || "0");
            const staff = Number(nEl.querySelector("staff")?.textContent || "1");
            const durDivs = Number(nEl.querySelector("duration")?.textContent || String(divisions));
            const durWhole = durDivs / (4 * divisions);

            const entryAbsWhole = isChord
              ? lastNonChordWhole
              : measureStartWhole + measureCursorWhole;

            if (!isChord) {
              lastNonChordWhole = entryAbsWhole;
              measureCursorWhole += durWhole;
              if (entryAbsWhole + durWhole > maxEndWholeInMeasure) {
                maxEndWholeInMeasure = entryAbsWhole + durWhole;
              }
            }

            if (!isChord || !currentStaveNote) {
              currentStaveNote = document.createElementNS("http://www.w3.org/2000/svg", "g");
              currentStaveNote.setAttribute("class", "vf-stavenote");
              currentStaveNote.setAttribute("data-measure", String(mNum));
              svg.appendChild(currentStaveNote);
              chordIdx = 0;
            } else {
              chordIdx += 1;
            }

            const nh = document.createElementNS("http://www.w3.org/2000/svg", "g");
            nh.setAttribute("class", "vf-notehead");
            nh.setAttribute("data-testid", `osmd-note-m${mNum}-n${nIdx}`);
            nh.setAttribute("data-pitch", isRest ? "rest" : `${step}${octave}`);
            const cx = 60 + mIdx * 360 + nIdx * 48;
            const cy = 110 - chordIdx * 16;
            Object.defineProperty(nh, "getBoundingClientRect", {
              value: () => ({
                left: cx - 7,
                top: cy - 5,
                right: cx + 7,
                bottom: cy + 5,
                width: 14,
                height: 10,
                x: cx - 7,
                y: cy - 5,
                toJSON: () => ({}),
              }),
            });
            currentStaveNote.appendChild(nh);

            const staveGroupRef = currentStaveNote;
            const myChordIdx = chordIdx;
            const midi = (octave + 1) * 12 + (STEP_TO_SEMI[step] ?? 0) + alter;

            const gn = {
              vfnoteIndex: myChordIdx,
              sourceNote: {
                isRest: () => isRest,
                Pitch: isRest ? undefined : { halfTone: midi - 12 },
                ParentStaffEntry: { ParentStaff: { idInMusicSheet: staff - 1 } },
              },
              getSVGGElement: () => staveGroupRef,
              getNoteheadSVGs: () => [nh],
            };

            if (isChord && staffEntries.length > 0) {
              const lastEntry = staffEntries[staffEntries.length - 1];
              lastEntry.graphicalVoiceEntries[0].notes.push(gn);
            } else {
              const absVal = entryAbsWhole;
              staffEntries.push({
                getAbsoluteTimestamp: () => ({ RealValue: absVal }),
                graphicalVoiceEntries: [{ notes: [gn] }],
              });
            }
          });

          runningWhole = Math.max(measureStartWhole + 1, maxEndWholeInMeasure);

          measureList.push({
            MeasureNumber: mNum,
            parentSourceMeasure: {
              MeasureNumber: mNum,
              AbsoluteTimestamp: { RealValue: measureStartWhole },
            },
            PositionAndShape: {
              AbsolutePosition: { x: mLeft, y: 2 },
              Size: { width: 34, height: 18 },
            },
            staffEntries,
          });
        });

        instance.GraphicSheet = {
          MeasureList: measureList.map((m) => [m]),
        };

        container.appendChild(svg);
      },
    };
    return instance;
  },
}));

const SAMPLE_TWO_MEASURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>480</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>F</step><octave>4</octave></pitch>
        <duration>480</duration>
        <voice>1</voice>
        <type>quarter</type>
        <staff>1</staff>
      </note>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>480</duration>
        <voice>1</voice>
        <type>quarter</type>
        <staff>1</staff>
      </note>
      <note>
        <chord/>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>480</duration>
        <voice>1</voice>
        <type>quarter</type>
        <staff>1</staff>
      </note>
      <note>
        <pitch><step>G</step><octave>4</octave></pitch>
        <duration>1440</duration>
        <voice>1</voice>
        <type>half</type>
        <dot/>
        <staff>1</staff>
      </note>
    </measure>
    <measure number="2">
      <note>
        <rest/>
        <duration>1920</duration>
        <voice>1</voice>
        <type>whole</type>
        <staff>1</staff>
      </note>
    </measure>
  </part>
</score-partwise>`;

const MULTI_BEAT_REBALANCE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>480</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>960</duration>
        <voice>1</voice>
        <type>half</type>
        <staff>1</staff>
      </note>
      <note>
        <rest/>
        <duration>480</duration>
        <voice>1</voice>
        <type>quarter</type>
        <staff>1</staff>
      </note>
      <note>
        <pitch><step>D</step><octave>4</octave></pitch>
        <duration>480</duration>
        <voice>1</voice>
        <type>quarter</type>
        <staff>1</staff>
      </note>
    </measure>
    <measure number="2">
      <note>
        <rest/>
        <duration>960</duration>
        <voice>1</voice>
        <type>half</type>
        <staff>1</staff>
      </note>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>960</duration>
        <voice>1</voice>
        <type>half</type>
        <staff>1</staff>
      </note>
    </measure>
  </part>
</score-partwise>`;

function noteTarget(overrides: Partial<XmlNoteTarget> = {}): XmlNoteTarget {
  return {
    partIndex: 0,
    measureNumber: 1,
    onsetWhole: 0,
    staffNumber: 1,
    voice: "1",
    pitchMidi: 65,
    noteIndex: 0,
    ...overrides,
  };
}

describe("musicXmlEditor: Duration Map, Tuple Ratios, Rests, Ties & Beat Auto-Rebalance", () => {
  it("supports all 9 MuseScore duration steps (1-9) and stepNoteDurationType W/Q scaling", () => {
    expect(DURATION_ORDER).toEqual([
      "64th",
      "32nd",
      "16th",
      "eighth",
      "quarter",
      "half",
      "whole",
      "breve",
      "long",
    ]);
    expect(stepNoteDurationType("quarter", "double")).toBe("half");
    expect(stepNoteDurationType("quarter", "halve")).toBe("eighth");
    expect(stepNoteDurationType("whole", "double")).toBe("breve");
    expect(stepNoteDurationType("breve", "double")).toBe("long");
    expect(stepNoteDurationType("long", "double")).toBe("long");
    expect(stepNoteDurationType("64th", "halve")).toBe("64th");

    for (let k = 2; k <= 9; k += 1) {
      expect(TUPLET_RATIOS[k]).toBeDefined();
      expect(TUPLET_RATIOS[k].actual).toBe(k);
    }
  });

  it("converts standalone note to equal-duration dotted rest and keeps it selected", () => {
    const target = noteTarget({ onsetWhole: 0.5, pitchMidi: 67, noteIndex: 3 });
    const res = convertXmlNoteToRest(SAMPLE_TWO_MEASURE_XML, target);
    expect(res).not.toBeNull();
    expect(res!.nextTarget.pitchMidi).toBeNull();

    const info = getXmlNoteInfo(res!.xml, res!.nextTarget);
    expect(info?.isRest).toBe(true);
    expect(info?.durationType).toBe("half");
    expect(info?.dotted).toBe(true);

    const halved = setXmlNoteDuration(res!.xml, res!.nextTarget, "quarter", {
      dotted: info?.dotted,
      rebalanceMeasure: true,
    });
    expect(halved?.changed).toBe(true);
    expect(getXmlNoteInfo(halved!.xml, halved!.nextTarget)?.durationType).toBe("quarter");
    expect(getXmlNoteInfo(halved!.xml, halved!.nextTarget)?.dotted).toBe(true);

    const parsed = musicXmlToScoreNotes(halved!.xml, [], 120);
    // Remaining pitched notes in m.1 are F4, C4, E4 (G4 was converted to a rest)
    expect(parsed.notes.map((n) => n.pitch_midi)).toEqual([65, 60, 64]);
  });

  it("deleteXmlNote removes only the clicked chord tone while converting standalone notes to rests", () => {
    const chordRes = deleteXmlNote(
      SAMPLE_TWO_MEASURE_XML,
      noteTarget({ onsetWhole: 0.25, pitchMidi: 64, noteIndex: 2 }),
    );
    expect(chordRes).not.toBeNull();
    expect(chordRes!.deletedChordTone).toBe(true);

    const doc = new DOMParser().parseFromString(chordRes!.xml, "application/xml");
    const m1Notes = Array.from(doc.querySelectorAll('measure[number="1"] > note'));
    const pitches = m1Notes.map((n) => n.querySelector("pitch > step")?.textContent || "rest");
    expect(pitches).toEqual(["F", "C", "G"]);
    expect(m1Notes[1].querySelector("chord")).toBeNull();

    const soloRes = deleteXmlNote(
      chordRes!.xml,
      noteTarget({ onsetWhole: 0.5, pitchMidi: 67, noteIndex: 2 }),
    );
    expect(soloRes).not.toBeNull();
    expect(soloRes!.deletedChordTone).toBe(false);
    expect(soloRes!.nextTarget.pitchMidi).toBeNull();
    const restInfo = getXmlNoteInfo(soloRes!.xml, soloRes!.nextTarget);
    expect(restInfo?.durationType).toBe("half");
    expect(restInfo?.dotted).toBe(true);
  });

  it("rebalanceMeasure inserts trailing rests on shorten without duplicating and absorbs adjacent rests on lengthen", () => {
    const shortened = setXmlNoteDuration(
      MULTI_BEAT_REBALANCE_XML,
      noteTarget({ onsetWhole: 0, pitchMidi: 60, noteIndex: 0 }),
      "quarter",
      { rebalanceMeasure: true },
    );
    expect(shortened?.changed).toBe(true);

    const doc1 = new DOMParser().parseFromString(shortened!.xml, "application/xml");
    const m1Durs1 = Array.from(doc1.querySelectorAll('measure[number="1"] > note')).map((n) => ({
      rest: Boolean(n.querySelector("rest")),
      dur: Number(n.querySelector("duration")?.textContent),
    }));
    expect(m1Durs1.reduce((s, n) => s + n.dur, 0)).toBe(1920);
    expect(m1Durs1[0]).toEqual({ rest: false, dur: 480 });
    expect(m1Durs1[1]).toEqual({ rest: true, dur: 480 });

    const shortenedAgain = setXmlNoteDuration(
      shortened!.xml,
      shortened!.nextTarget,
      "eighth",
      { rebalanceMeasure: true },
    );
    expect(shortenedAgain?.changed).toBe(true);
    const doc2 = new DOMParser().parseFromString(shortenedAgain!.xml, "application/xml");
    const sum2 = Array.from(doc2.querySelectorAll('measure[number="1"] > note')).reduce(
      (s, n) => s + Number(n.querySelector("duration")?.textContent),
      0,
    );
    expect(sum2).toBe(1920);

    const lengthened = setXmlNoteDuration(
      shortenedAgain!.xml,
      shortenedAgain!.nextTarget,
      "half",
      { rebalanceMeasure: true },
    );
    expect(lengthened?.changed).toBe(true);
    const doc3 = new DOMParser().parseFromString(lengthened!.xml, "application/xml");
    const m1Notes3 = Array.from(doc3.querySelectorAll('measure[number="1"] > note'));
    expect(m1Notes3.reduce((s, n) => s + Number(n.querySelector("duration")?.textContent), 0)).toBe(1920);
    expect(m1Notes3[0].querySelector("type")?.textContent).toBe("half");
  });

  it("warns without overwriting a following pitched note and splits across barline with tie when next bar begins with rest", () => {
    const blocked = setXmlNoteDuration(
      MULTI_BEAT_REBALANCE_XML,
      noteTarget({ onsetWhole: 0, pitchMidi: 60, noteIndex: 0 }),
      "whole",
      { rebalanceMeasure: true },
    );
    expect(blocked?.changed).toBe(false);
    expect(blocked?.warning).toMatch(/overlap the next note/i);

    const crossBar = setXmlNoteDuration(
      MULTI_BEAT_REBALANCE_XML,
      noteTarget({ onsetWhole: 0.75, pitchMidi: 62, noteIndex: 2 }),
      "half",
      { rebalanceMeasure: true },
    );
    expect(crossBar?.changed).toBe(true);

    const doc = new DOMParser().parseFromString(crossBar!.xml, "application/xml");
    const m1Last = Array.from(doc.querySelectorAll('measure[number="1"] > note')).pop()!;
    const m2First = doc.querySelector('measure[number="2"] > note')!;
    expect(m1Last.querySelector('tie[type="start"]')).not.toBeNull();
    expect(m2First.querySelector('tie[type="stop"]')).not.toBeNull();
    expect(m2First.querySelector("pitch > step")?.textContent).toBe("D");

    const parsed = musicXmlToScoreNotes(crossBar!.xml, [], 120);
    // D4 ties across the barline so ScoreNote duration reflects 1.0s at 120 BPM (half note)
    const d4Note = parsed.notes.find((n) => n.pitch_midi === 62);
    expect(d4Note).toBeDefined();
    expect(d4Note!.offset_sec - d4Note!.onset_sec).toBeCloseTo(1.0, 2);
  });

  it("supports T/+ tie toggling into same-pitch next note or converting following rest into tied continuation", () => {
    const tiedIntoRest = toggleXmlNoteTie(
      MULTI_BEAT_REBALANCE_XML,
      noteTarget({ onsetWhole: 0, pitchMidi: 60, noteIndex: 0 }),
    );
    expect(tiedIntoRest.changed).toBe(true);

    const doc = new DOMParser().parseFromString(tiedIntoRest.xml, "application/xml");
    const m1Notes = Array.from(doc.querySelectorAll('measure[number="1"] > note'));
    expect(m1Notes[0].querySelector('tie[type="start"]')).not.toBeNull();
    expect(m1Notes[1].querySelector("rest")).toBeNull();
    expect(m1Notes[1].querySelector("pitch > step")?.textContent).toBe("C");
    expect(m1Notes[1].querySelector('tie[type="stop"]')).not.toBeNull();

    const untied = toggleXmlNoteTie(
      tiedIntoRest.xml,
      noteTarget({ onsetWhole: 0, pitchMidi: 60, noteIndex: 0 }),
    );
    expect(untied.changed).toBe(true);
    const doc2 = new DOMParser().parseFromString(untied.xml, "application/xml");
    expect(doc2.querySelector('measure[number="1"] > note tie[type="start"]')).toBeNull();
  });

  it("supports dot toggling (.) and tuplets (Ctrl+2..9)", () => {
    // In MULTI_BEAT_REBALANCE_XML, C4 half (960) precedes a quarter rest (480) so dotting absorbs the rest
    const dotOn = toggleXmlNoteDot(
      MULTI_BEAT_REBALANCE_XML,
      noteTarget({ onsetWhole: 0, pitchMidi: 60, noteIndex: 0 }),
      { rebalanceMeasure: true },
    );
    expect(dotOn?.changed).toBe(true);
    expect(dotOn?.dotted).toBe(true);
    expect(getXmlNoteInfo(dotOn!.xml, dotOn!.nextTarget)?.durationType).toBe("half");
    expect(getXmlNoteInfo(dotOn!.xml, dotOn!.nextTarget)?.dotted).toBe(true);

    const dotOff = toggleXmlNoteDot(
      dotOn!.xml,
      dotOn!.nextTarget,
      { rebalanceMeasure: true },
    );
    expect(dotOff?.changed).toBe(true);
    expect(dotOff?.dotted).toBe(false);
    expect(getXmlNoteInfo(dotOff!.xml, dotOff!.nextTarget)?.durationType).toBe("half");
    expect(getXmlNoteInfo(dotOff!.xml, dotOff!.nextTarget)?.dotted).toBe(false);

    for (const actual of [2, 3, 4, 5, 6, 7, 8, 9]) {
      const tup = toggleXmlNoteTuplet(
        SAMPLE_TWO_MEASURE_XML,
        noteTarget({ onsetWhole: 0, pitchMidi: 65, noteIndex: 0 }),
        actual,
        { rebalanceMeasure: false },
      );
      expect(tup?.isTuplet).toBe(true);
      expect(tup?.actualNotes).toBe(actual);
      const info = getXmlNoteInfo(tup!.xml, tup!.nextTarget);
      expect(info?.tupletActual).toBe(actual);
      expect(info?.tupletNormal).toBe(TUPLET_RATIOS[actual].normal);
    }
  });
});

describe("SheetMusicViewer: Notehead Click Priority, Rest Deletion & MuseScore Keyboard Shortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function ControlledViewer({
    initialXml = SAMPLE_TWO_MEASURE_XML,
  }: {
    initialXml?: string;
  }) {
    const [xml, setXml] = React.useState(initialXml);
    const [history, setHistory] = React.useState<string[]>([initialXml]);
    const [histIdx, setHistIdx] = React.useState(0);

    const handleXmlChange = (nextXml: string) => {
      setXml(nextXml);
      const sliced = history.slice(0, histIdx + 1);
      setHistory([...sliced, nextXml]);
      setHistIdx(sliced.length);
    };

    const handleUndo = React.useCallback(() => {
      setHistIdx((idx) => {
        if (idx > 0) {
          setXml(history[idx - 1]);
          return idx - 1;
        }
        return idx;
      });
    }, [history]);

    const handleRedo = React.useCallback(() => {
      setHistIdx((idx) => {
        if (idx < history.length - 1) {
          setXml(history[idx + 1]);
          return idx + 1;
        }
        return idx;
      });
    }, [history]);

    React.useEffect(() => {
      const onGlobalUndoRedo = (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          handleUndo();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
          e.preventDefault();
          handleRedo();
        }
      };
      window.addEventListener("keydown", onGlobalUndoRedo);
      return () => window.removeEventListener("keydown", onGlobalUndoRedo);
    }, [handleUndo, handleRedo]);

    return (
      <div>
        <div data-testid="current-xml-snapshot">{xml}</div>
        <SheetMusicViewer
          musicxml={xml}
          defaultEditMode={true}
          onMusicXmlChange={handleXmlChange}
          onUndo={handleUndo}
          onRedo={handleRedo}
          canUndo={histIdx > 0}
          canRedo={histIdx < history.length - 1}
        />
      </div>
    );
  }

  it("selects individual noteheads (and specific chord tones) instead of Measure 1, and deletes chord tones cleanly", async () => {
    render(<ControlledViewer />);

    await waitFor(() => {
      expect(screen.getByTestId("osmd-note-m1-n0")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("osmd-note-m1-n0"), { clientX: 60, clientY: 110 });
    expect(screen.getByTestId("notation-edit-readout")).toHaveTextContent("Selected: F4 (Quarter) • m.1");

    // Click second chord tone inside shared vf-stavenote (E4)
    fireEvent.click(screen.getByTestId("osmd-note-m1-n2"), { clientX: 156, clientY: 94 });
    expect(screen.getByTestId("notation-edit-readout")).toHaveTextContent("Selected: E4 (Quarter) • m.1");

    // Delete removes ONLY E4 while preserving C4
    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => {
      const xml = screen.getByTestId("current-xml-snapshot").textContent || "";
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      const m1Steps = Array.from(doc.querySelectorAll('measure[number="1"] > note pitch > step')).map(
        (el) => el.textContent,
      );
      expect(m1Steps).toEqual(["F", "C", "G"]);
    });

    // Global Ctrl+Z undo & Ctrl+Y redo pass through without being swallowed by SheetMusicViewer
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => {
      const xml = screen.getByTestId("current-xml-snapshot").textContent || "";
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      const m1Steps = Array.from(doc.querySelectorAll('measure[number="1"] > note pitch > step')).map(
        (el) => el.textContent,
      );
      expect(m1Steps).toEqual(["F", "C", "E", "G"]);
    });

    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    await waitFor(() => {
      const xml = screen.getByTestId("current-xml-snapshot").textContent || "";
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      const m1Steps = Array.from(doc.querySelectorAll('measure[number="1"] > note pitch > step')).map(
        (el) => el.textContent,
      );
      expect(m1Steps).toEqual(["F", "C", "G"]);
    });
  });

  it("resolves hollow/center notehead bounding-box clicks to the note rather than empty staff measure", async () => {
    render(<ControlledViewer />);
    await waitFor(() => {
      expect(screen.getByTestId("osmd-note-m1-n3")).toBeInTheDocument();
    });

    // Click inside G4 dotted half bounding box (cx=204, cy=110) directly on parent SVG
    fireEvent.click(screen.getByTestId("mock-osmd-svg"), { clientX: 204, clientY: 110 });
    expect(screen.getByTestId("notation-edit-readout")).toHaveTextContent("Selected: G4 (Half.) • m.1");

    // Backspace converts standalone G4 to equal-duration dotted rest and keeps it selected
    fireEvent.keyDown(window, { key: "Backspace" });
    await waitFor(() => {
      expect(screen.getByTestId("notation-edit-readout")).toHaveTextContent("Selected: Rest (Half.) • m.1");
    });

    fireEvent.keyDown(window, { key: "q" });
    await waitFor(() => {
      expect(screen.getByTestId("notation-edit-readout")).toHaveTextContent("Selected: Rest (Quarter.) • m.1");
    });

    fireEvent.keyDown(window, { key: "w" });
    await waitFor(() => {
      expect(screen.getByTestId("notation-edit-readout")).toHaveTextContent("Selected: Rest (Half.) • m.1");
    });

    fireEvent.keyDown(window, { key: "." });
    await waitFor(() => {
      expect(screen.getByTestId("notation-edit-readout")).toHaveTextContent("Selected: Rest (Half) • m.1");
    });
  });

  it("handles two-stage Escape from Note Input mode, 1-9, 0, T, +, Ctrl+3, focus guards, and shortcut cheat sheet", async () => {
    render(<ControlledViewer initialXml={MULTI_BEAT_REBALANCE_XML} />);
    await waitFor(() => {
      expect(screen.getByTestId("osmd-note-m1-n0")).toBeInTheDocument();
    });

    // Select C4 half note
    fireEvent.click(screen.getByTestId("osmd-note-m1-n0"), { clientX: 60, clientY: 110 });
    expect(screen.getByTestId("notation-edit-readout")).toHaveTextContent("Selected: C4 (Half) • m.1");

    // Toggle Note Input on with N
    fireEvent.keyDown(window, { key: "n" });
    expect(screen.getByTestId("palette-note-input-btn")).toHaveAttribute("aria-pressed", "true");

    // First Esc exits Note Input while preserving active selection
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("palette-note-input-btn")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("notation-edit-readout")).toHaveTextContent("Selected: C4 (Half) • m.1");

    // Second Esc clears selection
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("notation-edit-readout")).toHaveTextContent(/Click a notehead to edit/i);

    // Re-select C4 and test digit 5 (quarter), Ctrl+3 (triplet), + (tie), 0 (rest)
    fireEvent.click(screen.getByTestId("osmd-note-m1-n0"), { clientX: 60, clientY: 110 });
    fireEvent.keyDown(window, { key: "5" });
    await waitFor(() => {
      expect(screen.getByTestId("notation-edit-readout")).toHaveTextContent("Selected: C4 (Quarter) • m.1");
    });

    fireEvent.keyDown(window, { key: "3", ctrlKey: true });
    await waitFor(() => {
      const xml = screen.getByTestId("current-xml-snapshot").textContent || "";
      expect(xml).toContain("<actual-notes>3</actual-notes>");
    });

    fireEvent.keyDown(window, { key: "+" });
    await waitFor(() => {
      const xml = screen.getByTestId("current-xml-snapshot").textContent || "";
      expect(xml).toContain('<tie type="start"/>');
    });

    fireEvent.keyDown(window, { key: "0" });
    await waitFor(() => {
      expect(screen.getByTestId("notation-edit-readout")).toHaveTextContent("Rest");
    });

    // Focus guards: shortcuts ignored inside <input>, <select>, <textarea>, and modal dialogs
    const xmlBeforeGuards = screen.getByTestId("current-xml-snapshot").textContent;
    for (const tag of ["input", "select", "textarea"] as const) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      el.focus();
      fireEvent.keyDown(el, { key: "4", bubbles: true });
      fireEvent.keyDown(el, { key: "Delete", bubbles: true });
      expect(screen.getByTestId("current-xml-snapshot").textContent).toBe(xmlBeforeGuards);
      el.remove();
    }

    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    fireEvent.keyDown(window, { key: "4", bubbles: true });
    expect(screen.getByTestId("current-xml-snapshot").textContent).toBe(xmlBeforeGuards);
    modal.remove();

    // Shortcut cheat sheet opens and lists MuseScore shortcuts
    fireEvent.click(screen.getByLabelText("Toggle keyboard shortcut reference"));
    const popover = screen.getByTestId("notation-shortcuts-popover");
    expect(popover).toHaveTextContent("1–9");
    expect(popover).toHaveTextContent("0");
    expect(popover).toHaveTextContent(".");
    expect(popover).toHaveTextContent("T");
    expect(popover).toHaveTextContent("+");
    expect(popover).toHaveTextContent(/Double Duration/i);
    expect(popover).toHaveTextContent(/Halve Duration/i);
    expect(popover).toHaveTextContent("Ctrl/Cmd+2..9");
    expect(popover).toHaveTextContent("Esc");
  });

  it("selects measure on empty staff click and removes it on Delete when >1 measure exists", async () => {
    render(<ControlledViewer />);
    await waitFor(() => {
      expect(screen.getByTestId("mock-osmd-svg")).toBeInTheDocument();
    });

    // Click empty area far from any notehead bounding box inside Measure 1 (x=20..360, y=20..200)
    fireEvent.click(screen.getByTestId("mock-osmd-svg"), { clientX: 280, clientY: 180 });
    expect(screen.getByTestId("notation-edit-readout")).toHaveTextContent(/Selected: Measure 1/i);

    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => {
      const xml = screen.getByTestId("current-xml-snapshot").textContent || "";
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      expect(doc.querySelectorAll("part > measure").length).toBe(1);
    });
  });
});
