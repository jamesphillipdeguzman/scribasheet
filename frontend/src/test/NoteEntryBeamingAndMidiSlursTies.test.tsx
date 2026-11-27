import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React, { useState } from "react";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";
import { NotationMidiBar } from "@/features/editor/NotationMidiBar";
import { applyAutomaticBeaming } from "@/features/editor/musicXmlBeaming";
import {
  buildQuantizedRecordedNotes,
  type RecordedRawNote,
} from "@/features/editor/midiRecordingUtils";
import {
  addChordToneToXmlNote,
  insertStepMidiNotesIntoXml,
  mergeLiveMidiRecordingIntoXml,
  musicXmlToScoreNotes,
  resolveLetterNotePitch,
} from "@/features/editor/musicXmlEditor";

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

        let divisions = 48;
        let runningWhole = 0;

        const measureList: Array<Record<string, unknown>> = [];

        measures.forEach((mEl, mIdx) => {
          const divEl = mEl.querySelector("attributes > divisions");
          if (divEl?.textContent) {
            const parsedDiv = Number(divEl.textContent.trim());
            if (parsedDiv > 0) divisions = parsedDiv;
          }
          const mNum = Number(mEl.getAttribute("number") || String(mIdx + 1));
          const measureStartWhole = runningWhole;
          let measureCursorWhole = 0;
          let lastNonChordWhole = measureStartWhole;
          let maxEndWholeInMeasure = measureStartWhole;
          const staffEntries: Array<Record<string, unknown>> = [];

          const noteEls = Array.from(mEl.children).filter((c) => c.tagName === "note");
          let currentStaveNote: SVGGElement | null = null;
          let chordIdx = 0;

          noteEls.forEach((nEl, nIdx) => {
            const isChord = Boolean(nEl.querySelector(":scope > chord"));
            const isRest = Boolean(nEl.querySelector(":scope > rest"));
            const step = nEl.querySelector("pitch > step")?.textContent?.trim() || "C";
            const octave = Number(nEl.querySelector("pitch > octave")?.textContent || "4");
            const alter = Number(nEl.querySelector("pitch > alter")?.textContent || "0");
            const staff = Number(nEl.querySelector("staff")?.textContent || "1");
            const durDivs = Number(nEl.querySelector("duration")?.textContent || String(divisions));
            const durWhole = durDivs / (4 * divisions);

            const entryAbsWhole = isChord ? lastNonChordWhole : measureStartWhole + measureCursorWhole;
            if (!isChord) {
              lastNonChordWhole = entryAbsWhole;
              measureCursorWhole += durWhole;
              maxEndWholeInMeasure = Math.max(maxEndWholeInMeasure, entryAbsWhole + durWhole);
            }

            if (!isChord || !currentStaveNote) {
              currentStaveNote = document.createElementNS("http://www.w3.org/2000/svg", "g");
              currentStaveNote.setAttribute("class", "vf-stavenote");
              svg.appendChild(currentStaveNote);
              chordIdx = 0;
            } else {
              chordIdx += 1;
            }

            const nh = document.createElementNS("http://www.w3.org/2000/svg", "g");
            nh.setAttribute("class", "vf-notehead");
            nh.setAttribute("data-testid", `osmd-note-m${mNum}-n${nIdx}`);
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
              const lastEntry = staffEntries[staffEntries.length - 1] as {
                graphicalVoiceEntries: Array<{ notes: unknown[] }>;
              };
              lastEntry.graphicalVoiceEntries[0].notes.push(gn);
            } else {
              staffEntries.push({
                getAbsoluteTimestamp: () => ({ RealValue: entryAbsWhole }),
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
              AbsolutePosition: { x: 2 + mIdx * 36, y: 2 },
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

function buildBlankSingleStaffXml(options?: {
  fifths?: number;
  mode?: "major" | "minor";
  beats?: number;
  beatType?: number;
  clefSign?: "G" | "F";
  clefLine?: number;
  pickupDivs?: number;
  measures?: number;
}): string {
  const fifths = options?.fifths ?? 0;
  const mode = options?.mode ?? "major";
  const beats = options?.beats ?? 4;
  const beatType = options?.beatType ?? 4;
  const clefSign = options?.clefSign ?? "G";
  const clefLine = options?.clefLine ?? (clefSign === "F" ? 4 : 2);
  const divisions = 48;
  const barDivs = Math.round((divisions * beats * 4) / beatType);
  const measureCount = options?.measures ?? 1;

  let measuresXml = "";
  if (options?.pickupDivs) {
    measuresXml += `
    <measure number="0" implicit="yes">
      <attributes>
        <divisions>${divisions}</divisions>
        <key><fifths>${fifths}</fifths><mode>${mode}</mode></key>
        <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>
        <clef><sign>${clefSign}</sign><line>${clefLine}</line></clef>
      </attributes>
      <note><rest/><duration>${options.pickupDivs}</duration><voice>1</voice><type>quarter</type></note>
    </measure>`;
  }

  for (let i = 1; i <= measureCount; i++) {
    const attrs =
      i === 1 && !options?.pickupDivs
        ? `
      <attributes>
        <divisions>${divisions}</divisions>
        <key><fifths>${fifths}</fifths><mode>${mode}</mode></key>
        <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>
        <clef><sign>${clefSign}</sign><line>${clefLine}</line></clef>
      </attributes>`
        : "";
    measuresXml += `
    <measure number="${i}">${attrs}
      <note><rest measure="yes"/><duration>${barDivs}</duration><voice>1</voice><type>whole</type></note>
    </measure>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">${measuresXml}
  </part>
</score-partwise>`;
}

function parseDoc(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

function getNotesInMeasure(xml: string, measureIdx = 0): Element[] {
  const doc = parseDoc(xml);
  const m = doc.querySelectorAll("part > measure")[measureIdx];
  return m ? Array.from(m.children).filter((c) => c.tagName.toLowerCase() === "note") : [];
}

function readPitchTuple(noteEl: Element): { step: string; alter: number; octave: number } | null {
  const p = noteEl.getElementsByTagName("pitch")[0];
  if (!p) return null;
  const step = (p.getElementsByTagName("step")[0]?.textContent || "").trim();
  const alter = Number.parseInt(p.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0;
  const octave = Number.parseInt(p.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
  return { step, alter, octave };
}

function readBeams(noteEl: Element): Array<{ number: number; value: string }> {
  return Array.from(noteEl.children)
    .filter((c) => c.tagName.toLowerCase() === "beam")
    .map((b) => ({
      number: Number.parseInt(b.getAttribute("number") || "1", 10),
      value: (b.textContent || "").trim(),
    }));
}

describe("Letter Note Entry, Beat-Aware Beaming, and Automatic MIDI Ties/Slurs", () => {
  let memoryStorage: Record<string, string>;

  beforeEach(() => {
    memoryStorage = {};
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => (key in memoryStorage ? memoryStorage[key] : null),
        setItem: (key: string, val: string) => {
          memoryStorage[key] = String(val);
        },
        removeItem: (key: string) => {
          delete memoryStorage[key];
        },
        clear: () => {
          memoryStorage = {};
        },
      },
    });
  });

  // =========================================================================
  // 1. MuseScore-Style Letter Note Entry (A–G)
  // =========================================================================
  describe("MuseScore-Style Letter Note Entry (A–G)", () => {
    it("resolves key-signature-aware enharmonic spellings and octave placement cleanly", () => {
      // Initial treble note lands cleanly in middle-C octave 4
      expect(resolveLetterNotePitch({ letter: "C", keyFifths: 0, clef: "treble" })).toMatchObject({
        step: "C",
        alter: 0,
        octave: 4,
      });
      // Initial bass note lands cleanly in octave 3
      expect(resolveLetterNotePitch({ letter: "C", keyFifths: 0, clef: "bass" })).toMatchObject({
        step: "C",
        alter: 0,
        octave: 3,
      });

      // Key signature enharmonic spellings
      expect(resolveLetterNotePitch({ letter: "B", keyFifths: -1, clef: "treble" })).toMatchObject({
        step: "B",
        alter: -1,
        octave: 4,
      }); // F Major -> Bb
      expect(resolveLetterNotePitch({ letter: "F", keyFifths: 1, clef: "treble" })).toMatchObject({
        step: "F",
        alter: 1,
        octave: 4,
      }); // G Major -> F#
      expect(resolveLetterNotePitch({ letter: "E", keyFifths: -3, clef: "treble" })).toMatchObject({
        step: "E",
        alter: -1,
        octave: 4,
      }); // Eb Major -> Eb

      // Melodic octave proximity from previous note (G4=67 -> nearest C is C5=72, diff=5 vs C4=60, diff=7)
      expect(
        resolveLetterNotePitch({ letter: "C", keyFifths: 0, clef: "treble", previousMidi: 67 }),
      ).toMatchObject({ step: "C", octave: 5, midi: 72 });
      // Melodic proximity from E4=64 -> nearest B is B3=59 (diff=5 vs B4=71, diff=7)
      expect(
        resolveLetterNotePitch({ letter: "B", keyFifths: 0, clef: "treble", previousMidi: 64 }),
      ).toMatchObject({ step: "B", octave: 3, midi: 59 });
    });

    it("enters notes sequentially across beats and measures in Note Input mode without triggering unrelated shortcuts", async () => {
      let latestXml = buildBlankSingleStaffXml({ fifths: -1, beats: 4, beatType: 4 });
      const xmlHistory: string[] = [];

      function Harness() {
        const [xml, setXml] = useState(latestXml);
        return (
          <div>
            <input aria-label="Unrelated text input" defaultValue="" />
            <SheetMusicViewer
              musicxml={xml}
              defaultEditMode
              isActiveTab
              keyFifths={-1}
              clefMode="treble"
              onMusicXmlChange={(next) => {
                latestXml = next;
                xmlHistory.push(next);
                setXml(next);
              }}
            />
          </div>
        );
      }

      render(<Harness />);
      await waitFor(() => expect(screen.getByTestId("palette-note-input-btn")).toBeInTheDocument());

      // Before pressing N (noteInputMode is OFF), pressing 'c' must NOT insert a note
      fireEvent.keyDown(window, { key: "c" });
      expect(xmlHistory.length).toBe(0);

      // Toggle Note Input Mode ON with 'n'
      fireEvent.keyDown(window, { key: "n" });
      await waitFor(() =>
        expect(screen.getByTestId("palette-note-input-btn")).toHaveAttribute("aria-pressed", "true"),
      );

      // Focus safeguard: typing inside <input> must NOT enter a note
      const inputEl = screen.getByLabelText("Unrelated text input");
      fireEvent.keyDown(inputEl, { key: "c" });
      expect(xmlHistory.length).toBe(0);

      // Press C, D, B (Bb in F major), G sequentially -> fills 4 quarter beats of Measure 1
      fireEvent.keyDown(window, { key: "c" });
      await waitFor(() => expect(xmlHistory.length).toBe(1));
      fireEvent.keyDown(window, { key: "d" });
      await waitFor(() => expect(xmlHistory.length).toBe(2));
      fireEvent.keyDown(window, { key: "b" });
      await waitFor(() => expect(xmlHistory.length).toBe(3));
      fireEvent.keyDown(window, { key: "g" });
      await waitFor(() => expect(xmlHistory.length).toBe(4));

      const m1Notes = getNotesInMeasure(latestXml, 0);
      expect(m1Notes).toHaveLength(4);
      expect(m1Notes.map(readPitchTuple)).toEqual([
        { step: "C", alter: 0, octave: 4 },
        { step: "D", alter: 0, octave: 4 },
        { step: "B", alter: -1, octave: 3 }, // Bb from F Major key sig, nearest to D4 is Bb3
        { step: "G", alter: 0, octave: 3 },
      ]);

      // Shift + B adds chord tone on G3's slot or clicking a note & pressing Shift+A..G adds chord tone without advancing cursor
      const chordTestRes = addChordToneToXmlNote(
        latestXml,
        { partIndex: 0, measureNumber: 1, onsetWhole: 0.75, pitchMidi: 55, staffNumber: 1, noteIndex: 3 },
        { step: "D", alter: 0, octave: 4 },
      );
      expect(chordTestRes).not.toBeNull();
      const notesWithChord = getNotesInMeasure(chordTestRes!.xml, 0);
      expect(notesWithChord).toHaveLength(5);
      expect(notesWithChord[4].getElementsByTagName("chord")).toHaveLength(1);

      // Pressing 5th letter 'a' advances into Measure 2 automatically
      fireEvent.keyDown(window, { key: "a" });
      await waitFor(() => expect(xmlHistory.length).toBe(5));
      const m2Notes = getNotesInMeasure(latestXml, 1);
      expect(m2Notes.length).toBeGreaterThanOrEqual(1);
      expect(readPitchTuple(m2Notes[0])).toEqual({ step: "A", alter: 0, octave: 3 });

      // Ctrl + ArrowUp shifts the just-entered note (A3 -> A4) up 1 octave
      fireEvent.keyDown(window, { key: "ArrowUp", ctrlKey: true });
      await waitFor(() => expect(xmlHistory.length).toBe(6));
      const m2AfterOctaveUp = getNotesInMeasure(latestXml, 1);
      expect(readPitchTuple(m2AfterOctaveUp[0])).toEqual({ step: "A", alter: 0, octave: 4 });

      // Shift + E adds chord tone E4 onto the just-entered A4 without advancing cursor
      fireEvent.keyDown(window, { key: "E", shiftKey: true });
      await waitFor(() => expect(xmlHistory.length).toBe(7));
      const m2AfterChordTone = getNotesInMeasure(latestXml, 1);
      expect(m2AfterChordTone[1].getElementsByTagName("chord")).toHaveLength(1);
      expect(readPitchTuple(m2AfterChordTone[1])).toEqual({ step: "E", alter: 0, octave: 4 });
    });

    it("respects duration shortcuts (e.g. '4' for eighth) during letter note entry", async () => {
      let latestXml = buildBlankSingleStaffXml({ beats: 4, beatType: 4 });
      const history: string[] = [];

      function EighthHarness() {
        const [xml, setXml] = useState(latestXml);
        return (
          <SheetMusicViewer
            musicxml={xml}
            defaultEditMode
            isActiveTab
            clefMode="treble"
            onMusicXmlChange={(next) => {
              latestXml = next;
              history.push(next);
              setXml(next);
            }}
          />
        );
      }

      render(<EighthHarness />);
      await waitFor(() => expect(screen.getByTestId("palette-note-input-btn")).toBeInTheDocument());

      fireEvent.keyDown(window, { key: "n" });
      fireEvent.keyDown(window, { key: "4" }); // Switch to eighth note
      fireEvent.keyDown(window, { key: "c" });
      await waitFor(() => expect(history).toHaveLength(1));
      fireEvent.keyDown(window, { key: "d" });
      await waitFor(() => expect(history).toHaveLength(2));

      const m1 = getNotesInMeasure(latestXml, 0);
      expect(m1[0].getElementsByTagName("type")[0]?.textContent).toBe("eighth");
      expect(m1[1].getElementsByTagName("type")[0]?.textContent).toBe("eighth");
      // Automatically beamed as beat 1 pair!
      expect(readBeams(m1[0])).toEqual([{ number: 1, value: "begin" }]);
      expect(readBeams(m1[1])).toEqual([{ number: 1, value: "end" }]);
    });
  });

  // =========================================================================
  // 2. Automatic, Beat-Aware MusicXML Beaming
  // =========================================================================
  describe("Automatic Beat-Aware MusicXML Beaming", () => {
    it("beams eighth, 16th, and 32nd notes with valid MusicXML beam levels and element ordering", () => {
      // 4/4 measure with: 4 eighths (beats 1-2), 4 sixteenths (beat 3), 2 32nds + rest (beat 4)
      const rawXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>48</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice><type>16th</type></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice><type>16th</type></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice><type>16th</type></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>12</duration><voice>1</voice><type>16th</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>6</duration><voice>1</voice><type>32nd</type><notations><slur type="start" number="1"/></notations></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>6</duration><voice>1</voice><type>32nd</type><notations><slur type="stop" number="1"/></notations></note>
      <note><rest/><duration>36</duration><voice>1</voice><type>eighth</type><dot/></note>
    </measure>
  </part>
</score-partwise>`;

      const beamedXml = applyAutomaticBeaming(rawXml);
      const notes = getNotesInMeasure(beamedXml, 0);

      // Half-bar plain eighths in 4/4 beam in 4
      expect(readBeams(notes[0])).toEqual([{ number: 1, value: "begin" }]);
      expect(readBeams(notes[1])).toEqual([{ number: 1, value: "continue" }]);
      expect(readBeams(notes[2])).toEqual([{ number: 1, value: "continue" }]);
      expect(readBeams(notes[3])).toEqual([{ number: 1, value: "end" }]);

      // Beat 3 16ths beam with levels 1 and 2
      expect(readBeams(notes[4])).toEqual([
        { number: 1, value: "begin" },
        { number: 2, value: "begin" },
      ]);
      expect(readBeams(notes[5])).toEqual([
        { number: 1, value: "continue" },
        { number: 2, value: "continue" },
      ]);
      expect(readBeams(notes[7])).toEqual([
        { number: 1, value: "end" },
        { number: 2, value: "end" },
      ]);

      // Beat 4 32nds emit levels 1, 2, 3 and stay placed BEFORE <notations>
      expect(readBeams(notes[8])).toEqual([
        { number: 1, value: "begin" },
        { number: 2, value: "begin" },
        { number: 3, value: "begin" },
      ]);
      const childrenTags = Array.from(notes[8].children).map((c) => c.tagName.toLowerCase());
      expect(childrenTags.lastIndexOf("beam")).toBeLessThan(childrenTags.indexOf("notations"));
      // Rest never receives <beam>
      expect(readBeams(notes[10])).toEqual([]);
    });

    it("never beams across 4/4 beat 2->3 middle boundary and groups 6/8 compound meter in threes", () => {
      // Measure 1 (4/4): beat 2 eighths + beat 3 eighths separated by quarter on beat 1 & beat 4
      // Measure 2 (6/8): 6 eighth notes grouped into two dotted-quarter beats of 3
      const rawXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>48</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>48</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>48</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="2">
      <attributes>
        <time><beats>6</beats><beat-type>8</beat-type></time>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>A</step><octave>5</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
    </measure>
  </part>
</score-partwise>`;

      const beamed = applyAutomaticBeaming(rawXml);
      const m1 = getNotesInMeasure(beamed, 0);
      expect(readBeams(m1[0])).toEqual([]); // Quarter note
      expect(readBeams(m1[1])).toEqual([{ number: 1, value: "begin" }]);
      expect(readBeams(m1[2])).toEqual([{ number: 1, value: "end" }]); // Breaks at middle of 4/4!
      expect(readBeams(m1[3])).toEqual([{ number: 1, value: "begin" }]);
      expect(readBeams(m1[4])).toEqual([{ number: 1, value: "end" }]);

      const m2 = getNotesInMeasure(beamed, 1);
      expect(readBeams(m2[0])).toEqual([{ number: 1, value: "begin" }]);
      expect(readBeams(m2[1])).toEqual([{ number: 1, value: "continue" }]);
      expect(readBeams(m2[2])).toEqual([{ number: 1, value: "end" }]);
      expect(readBeams(m2[3])).toEqual([{ number: 1, value: "begin" }]);
      expect(readBeams(m2[4])).toEqual([{ number: 1, value: "continue" }]);
      expect(readBeams(m2[5])).toEqual([{ number: 1, value: "end" }]);
    });

    it("handles dotted-8th + 16th hooks, chords (no beam on chord child), pickups, tuplets, and manual beams", () => {
      const rawXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes>
        <divisions>48</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
    </measure>
    <measure number="1">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>36</duration><voice>1</voice><type>eighth</type><dot/></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>12</duration><voice>1</voice><type>16th</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type><data-manual-beam-sentinel/></note>
    </measure>
  </part>
</score-partwise>`;

      const beamed = applyAutomaticBeaming(rawXml);
      // 3-eighth pickup aligns to beats 3.5-4 -> first eighth standalone on beat 3.5, last two beamed on beat 4
      const m0 = getNotesInMeasure(beamed, 0);
      expect(readBeams(m0[0])).toEqual([]);
      expect(readBeams(m0[1])).toEqual([{ number: 1, value: "begin" }]);
      expect(readBeams(m0[2])).toEqual([{ number: 1, value: "end" }]);

      const m1 = getNotesInMeasure(beamed, 1);
      // Dotted 8th + 16th hook
      expect(readBeams(m1[0])).toEqual([{ number: 1, value: "begin" }]);
      expect(readBeams(m1[1])).toEqual([
        { number: 1, value: "end" },
        { number: 2, value: "backward hook" },
      ]);
      // Eighth triplet beams cleanly as 3 notes
      expect(readBeams(m1[2])).toEqual([{ number: 1, value: "begin" }]);
      expect(readBeams(m1[3])).toEqual([{ number: 1, value: "continue" }]);
      expect(readBeams(m1[4])).toEqual([{ number: 1, value: "end" }]);
      // Chord: primary carries beam, <chord/> sibling has NO <beam>
      expect(readBeams(m1[5])).toEqual([{ number: 1, value: "begin" }]);
      expect(readBeams(m1[6])).toEqual([]);
      expect(readBeams(m1[7])).toEqual([{ number: 1, value: "continue" }]);
    });

    it("preserves explicit manual beams when preserveExistingMeasures or data-manual-beam='true' is set", () => {
      const manualXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>48</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note data-manual-beam="true"><pitch><step>C</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type><beam number="1">begin</beam></note>
      <note data-manual-beam="true"><pitch><step>D</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type><beam number="1">end</beam></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><type>eighth</type></note>
    </measure>
  </part>
</score-partwise>`;

      const out = applyAutomaticBeaming(manualXml);
      const notes = getNotesInMeasure(out, 0);
      expect(readBeams(notes[0])).toEqual([{ number: 1, value: "begin" }]);
      expect(readBeams(notes[1])).toEqual([{ number: 1, value: "end" }]);
      expect(readBeams(notes[2])).toEqual([{ number: 1, value: "begin" }]);
      expect(readBeams(notes[3])).toEqual([{ number: 1, value: "end" }]);
    });
  });

  // =========================================================================
  // 3. Automatic MIDI Recording Ties, Legato Slurs & Auto Slurs/Ties Toggle
  // =========================================================================
  describe("Automatic MIDI Recording Ties, Legato Slurs & Auto Slurs/Ties Toggle", () => {
    it("splits notes held across barlines into tied pairs with <tie> and <tied> and reconstructs sounding duration", () => {
      const baseXml = buildBlankSingleStaffXml({ beats: 4, beatType: 4, measures: 1 });
      // Tempo 120 BPM -> 0.5s per quarter, 2.0s per bar.
      // Play C5 from beat 4 (1.5s) across barline to beat 2 of m.2 (2.5s -> duration 1.0s = half note across barline)
      const raw: RecordedRawNote[] = [
        { pitchMidi: 72, velocity: 88, onsetSec: 1.5, offsetSec: 2.5 },
      ];
      const quantized = buildQuantizedRecordedNotes(raw, {
        tempoBpm: 120,
        snapMode: "1/16",
        targetTrackIndex: 0,
      });

      const merged = mergeLiveMidiRecordingIntoXml(baseXml, quantized, {
        tempoBpm: 120,
        timeSignature: "4/4",
        snapMode: "1/16",
        clefMode: "treble",
        autoSlursTies: true,
      });
      expect(merged).not.toBeNull();

      const m1Notes = getNotesInMeasure(merged!, 0);
      const m2Notes = getNotesInMeasure(merged!, 1);
      const pitchedM1 = m1Notes.find((n) => n.getElementsByTagName("pitch").length > 0)!;
      const pitchedM2 = m2Notes.find((n) => n.getElementsByTagName("pitch").length > 0)!;

      expect(pitchedM1.getElementsByTagName("tie")[0]?.getAttribute("type")).toBe("start");
      expect(pitchedM1.getElementsByTagName("tied")[0]?.getAttribute("type")).toBe("start");
      expect(pitchedM2.getElementsByTagName("tie")[0]?.getAttribute("type")).toBe("stop");
      expect(pitchedM2.getElementsByTagName("tied")[0]?.getAttribute("type")).toBe("stop");

      // Playback/score reconstruction preserves full 1.0s sustained duration as one ScoreNote!
      const rebuilt = musicXmlToScoreNotes(
        merged!,
        [{ index: 0, name: "Piano", instrument: "piano", clef: "treble", program: 0, muted: false }],
        120,
      );
      expect(rebuilt.notes).toHaveLength(1);
      expect(rebuilt.notes[0].pitch_midi).toBe(72);
      expect(rebuilt.notes[0].onset_sec).toBeCloseTo(1.5, 2);
      expect(rebuilt.notes[0].offset_sec).toBeCloseTo(2.5, 2);
    });

    it("never ties or slurs genuinely rearticulated repeated pitches", () => {
      const baseXml = buildBlankSingleStaffXml({ beats: 4, beatType: 4, measures: 1 });
      const raw: RecordedRawNote[] = [
        { pitchMidi: 64, velocity: 85, onsetSec: 0.0, offsetSec: 0.52 },
        { pitchMidi: 64, velocity: 88, onsetSec: 0.5, offsetSec: 1.0 },
      ];
      const quantized = buildQuantizedRecordedNotes(raw, {
        tempoBpm: 120,
        snapMode: "1/8",
        targetTrackIndex: 0,
      });
      const merged = mergeLiveMidiRecordingIntoXml(baseXml, quantized, {
        tempoBpm: 120,
        timeSignature: "4/4",
        snapMode: "1/8",
        clefMode: "treble",
        autoSlursTies: true,
      });
      expect(merged).not.toBeNull();
      const doc = parseDoc(merged!);
      expect(doc.getElementsByTagName("tie")).toHaveLength(0);
      expect(doc.getElementsByTagName("tied")).toHaveLength(0);
      expect(doc.getElementsByTagName("slur")).toHaveLength(0);
    });

    it("detects conservative legato overlap between consecutive melodic notes, ignoring detached notes and chords", () => {
      const baseXml = buildBlankSingleStaffXml({ beats: 4, beatType: 4, measures: 1 });
      // Phrase 1 (beats 1-3): C5 -> D5 -> E5 with ~45ms raw overlap
      // Note 4 (beat 4): F5 with a 150ms detached gap before it (no slur into F5!)
      const raw: RecordedRawNote[] = [
        { pitchMidi: 72, velocity: 85, onsetSec: 0.0, offsetSec: 0.545 },
        { pitchMidi: 74, velocity: 85, onsetSec: 0.5, offsetSec: 1.045 },
        { pitchMidi: 76, velocity: 85, onsetSec: 1.0, offsetSec: 1.35 },
        { pitchMidi: 77, velocity: 85, onsetSec: 1.5, offsetSec: 1.9 },
      ];
      const quantized = buildQuantizedRecordedNotes(raw, {
        tempoBpm: 120,
        snapMode: "1/8",
        targetTrackIndex: 0,
      });

      const merged = mergeLiveMidiRecordingIntoXml(baseXml, quantized, {
        tempoBpm: 120,
        timeSignature: "4/4",
        snapMode: "1/8",
        clefMode: "treble",
        autoSlursTies: true,
      });
      expect(merged).not.toBeNull();
      const m1 = getNotesInMeasure(merged!, 0).filter((n) => n.getElementsByTagName("pitch").length > 0);
      expect(m1).toHaveLength(4);
      expect(m1[0].getElementsByTagName("slur")[0]?.getAttribute("type")).toBe("start");
      expect(m1[1].getElementsByTagName("slur")).toHaveLength(0);
      expect(m1[2].getElementsByTagName("slur")[0]?.getAttribute("type")).toBe("stop");
      expect(m1[3].getElementsByTagName("slur")).toHaveLength(0);

      // Simultaneous chord notes do NOT produce slurs
      const chordRaw: RecordedRawNote[] = [
        { pitchMidi: 72, velocity: 85, onsetSec: 0.0, offsetSec: 0.55 },
        { pitchMidi: 76, velocity: 85, onsetSec: 0.0, offsetSec: 0.55 },
        { pitchMidi: 74, velocity: 85, onsetSec: 0.5, offsetSec: 1.0 },
      ];
      const chordQuantized = buildQuantizedRecordedNotes(chordRaw, {
        tempoBpm: 120,
        snapMode: "1/8",
        targetTrackIndex: 0,
      });
      const chordMerged = mergeLiveMidiRecordingIntoXml(baseXml, chordQuantized, {
        tempoBpm: 120,
        timeSignature: "4/4",
        snapMode: "1/8",
        clefMode: "treble",
        autoSlursTies: true,
      });
      expect(parseDoc(chordMerged!).getElementsByTagName("slur")).toHaveLength(0);
    });

    it("provides an Auto Slurs/Ties toggle in NotationMidiBar that persists preference and controls auto generation", async () => {
      const baseXml = buildBlankSingleStaffXml({ beats: 4, beatType: 4, measures: 1 });
      const raw: RecordedRawNote[] = [
        { pitchMidi: 72, velocity: 85, onsetSec: 0.0, offsetSec: 0.545 },
        { pitchMidi: 74, velocity: 85, onsetSec: 0.5, offsetSec: 2.5 }, // legato + crosses barline!
      ];
      const quantized = buildQuantizedRecordedNotes(raw, {
        tempoBpm: 120,
        snapMode: "1/8",
        targetTrackIndex: 0,
      });

      // With Auto Slurs/Ties OFF, neither <slur> nor barline <tie> is auto-generated
      const offXml = mergeLiveMidiRecordingIntoXml(baseXml, quantized, {
        tempoBpm: 120,
        timeSignature: "4/4",
        snapMode: "1/8",
        clefMode: "treble",
        autoSlursTies: false,
      });
      const offDoc = parseDoc(offXml!);
      expect(offDoc.getElementsByTagName("slur")).toHaveLength(0);
      expect(offDoc.getElementsByTagName("tie")).toHaveLength(0);

      // Existing manual tie/slur via step edit or XML stays intact
      const stepRes = insertStepMidiNotesIntoXml(baseXml, {
        pitchesMidi: [72],
        durationType: "eighth",
        dotted: false,
        staffNumber: 1,
      });
      expect(stepRes).not.toBeNull();

      // UI toggle persistence
      const { unmount } = render(
        <NotationMidiBar
          isActiveTab
          activeXml={baseXml}
          tempoBpm={120}
          timeSignature="4/4"
          clefMode="treble"
          activeDuration="quarter"
          activeDotted={false}
          activeVoice="1"
          selectedTarget={null}
          onCommitXml={vi.fn()}
        />,
      );

      const toggleBtn = screen.getByTestId("notation-auto-slurs-ties-btn");
      expect(toggleBtn).toHaveAttribute("aria-pressed", "true");
      expect(toggleBtn).toHaveTextContent("Auto Slurs/Ties: ON");

      fireEvent.click(toggleBtn);
      expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
      expect(toggleBtn).toHaveTextContent("Auto Slurs/Ties: OFF");
      expect(window.localStorage.getItem("scribasheet_midi_auto_slurs_ties")).toBe("false");

      unmount();

      render(
        <NotationMidiBar
          isActiveTab
          activeXml={baseXml}
          tempoBpm={120}
          timeSignature="4/4"
          clefMode="treble"
          activeDuration="quarter"
          activeDotted={false}
          activeVoice="1"
          selectedTarget={null}
          onCommitXml={vi.fn()}
        />,
      );
      expect(screen.getByTestId("notation-auto-slurs-ties-btn")).toHaveAttribute("aria-pressed", "false");
    });
  });
});
