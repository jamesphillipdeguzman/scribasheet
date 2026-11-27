import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { injectChordsIntoMusicXml } from "@/features/editor/musicXmlChords";
import {
  deleteMeasureFromAllParts,
  deleteXmlNote,
  insertStepMidiNotesIntoXml,
} from "@/features/editor/musicXmlEditor";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";
import { VirtualPianoKeyboard } from "@/features/editor/VirtualPianoKeyboard";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { CIRCLE_OF_FIFTHS_KEYS, respellChordSymbol } from "@/lib/keySignature";
import { midiToNoteName } from "@/lib/utils";
import { api } from "@/services/api";

let mockMeasureList: unknown[][] = [];

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: function MockOSMD(container: HTMLElement) {
    return {
      load: async () => undefined,
      render: () => {
        container.innerHTML = "";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");

        const makeNote = (testId: string) => {
          const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
          g.setAttribute("class", "vf-stavenote");
          const head = document.createElementNS("http://www.w3.org/2000/svg", "g");
          head.setAttribute("class", "vf-notehead");
          head.setAttribute("data-testid", testId);
          const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
          p.setAttribute("d", "M0 0 L10 0");
          p.setAttribute("fill", "#000000");
          head.appendChild(p);
          g.appendChild(head);
          svg.appendChild(g);
          return g;
        };

        const noteA2 = makeNote("mock-notehead-a2");
        const noteC4 = makeNote("mock-notehead-c4");
        container.appendChild(svg);

        mockMeasureList = [
          [
            {
              MeasureNumber: 1,
              PositionAndShape: {
                AbsolutePosition: { x: 1, y: 1 },
                Size: { width: 12, height: 6 },
              },
              staffEntries: [
                {
                  getAbsoluteTimestamp: () => ({ RealValue: 0 }),
                  graphicalVoiceEntries: [
                    {
                      notes: [
                        {
                          getSVGGElement: () => noteC4,
                          sourceNote: { Pitch: { halfTone: 48 }, isRest: () => false }, // C4 (60)
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              MeasureNumber: 1,
              PositionAndShape: {
                AbsolutePosition: { x: 1, y: 8 },
                Size: { width: 12, height: 6 },
              },
              staffEntries: [
                {
                  getAbsoluteTimestamp: () => ({ RealValue: 0 }),
                  graphicalVoiceEntries: [
                    {
                      notes: [
                        {
                          getSVGGElement: () => noteA2,
                          sourceNote: { Pitch: { halfTone: 33 }, isRest: () => false }, // A2 (45)
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
          [
            {
              MeasureNumber: 2,
              PositionAndShape: {
                AbsolutePosition: { x: 14, y: 1 },
                Size: { width: 12, height: 6 },
              },
              staffEntries: [
                {
                  getAbsoluteTimestamp: () => ({ RealValue: 1 }),
                  graphicalVoiceEntries: [],
                },
              ],
            },
          ],
        ];
      },
      Dispose: () => undefined,
      Zoom: 1,
      EngravingRules: { RenderChordSymbols: true },
      cursor: {
        cursorElement: document.createElement("img"),
        show: () => undefined,
        hide: () => undefined,
        reset: () => undefined,
        next: () => undefined,
        update: () => undefined,
        GNotesUnderCursor: () => [],
        iterator: { EndReached: true, currentTimeStamp: { RealValue: 0 } },
      },
      get GraphicSheet() {
        return { MeasureList: mockMeasureList };
      },
    };
  },
}));

const TWO_MEASURE_CHORD_AND_TIE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Key &amp; Delete Test</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction placement="above">
        <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type>
        <sound tempo="120"/>
      </direction>
      <harmony>
        <root><root-step>A</root-step><root-alter>1</root-alter></root>
        <kind text="">major</kind>
      </harmony>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration>
        <voice>1</voice>
        <type>quarter</type>
        <staff>1</staff>
      </note>
      <note>
        <chord/>
        <pitch><step>A</step><alter>1</alter><octave>4</octave></pitch>
        <duration>4</duration>
        <voice>1</voice>
        <type>quarter</type>
        <staff>1</staff>
      </note>
      <note>
        <chord/>
        <pitch><step>G</step><octave>4</octave></pitch>
        <duration>4</duration>
        <voice>1</voice>
        <type>quarter</type>
        <staff>1</staff>
      </note>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>12</duration>
        <tie type="start"/>
        <voice>1</voice>
        <type>half</type>
        <dot/>
        <staff>1</staff>
        <notations><tied type="start"/></notations>
      </note>
      <backup><duration>16</duration></backup>
      <note>
        <pitch><step>A</step><octave>2</octave></pitch>
        <duration>16</duration>
        <voice>2</voice>
        <type>whole</type>
        <staff>2</staff>
      </note>
    </measure>
    <measure number="2">
      <note>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>16</duration>
        <tie type="stop"/>
        <voice>1</voice>
        <type>whole</type>
        <staff>1</staff>
        <notations><tied type="stop"/></notations>
      </note>
      <backup><duration>16</duration></backup>
      <note>
        <rest/>
        <duration>16</duration>
        <voice>2</voice>
        <type>whole</type>
        <staff>2</staff>
      </note>
    </measure>
  </part>
</score-partwise>`;

const F_MAJOR_STEP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>48</divisions>
        <key><fifths>-1</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><rest/><duration>192</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><rest/><duration>192</duration><voice>1</voice><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

const LEGACY_MISSING_KEY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Legacy Score</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>16</duration>
        <voice>1</voice>
        <type>whole</type>
      </note>
    </measure>
  </part>
</score-partwise>`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Key Signatures, Enharmonic Spelling, and Keyboard Deletion", () => {
  it("exposes all 15 Circle-of-Fifths keys and key-aware MIDI pitch spelling", () => {
    expect(CIRCLE_OF_FIFTHS_KEYS).toHaveLength(15);
    expect(CIRCLE_OF_FIFTHS_KEYS.map((k) => k.fifths).sort((a, b) => a - b)).toEqual([
      -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    const cbKey = CIRCLE_OF_FIFTHS_KEYS.find((k) => k.fifths === -7);
    const cSharpKey = CIRCLE_OF_FIFTHS_KEYS.find((k) => k.fifths === 7);
    expect(cbKey?.majorName).toBe("Cb Major");
    expect(cbKey?.minorName).toBe("Ab Minor");
    expect(cSharpKey?.majorName).toBe("C# Major");
    expect(cSharpKey?.minorName).toBe("A# Minor");

    // C Major conventional mixed chromatic spelling
    expect(midiToNoteName(61, 0)).toBe("C#4");
    expect(midiToNoteName(63, 0)).toBe("Eb4");
    expect(midiToNoteName(66, 0)).toBe("F#4");
    expect(midiToNoteName(68, 0)).toBe("G#4");
    expect(midiToNoteName(70, 0)).toBe("Bb4");

    // Flat keys prefer flat spellings (including Cb / Fb in -7)
    expect(midiToNoteName(70, -1)).toBe("Bb4");
    expect(midiToNoteName(63, -2)).toBe("Eb4");
    expect(midiToNoteName(68, -3)).toBe("Ab4");
    expect(midiToNoteName(59, -7)).toBe("Cb4");
    expect(midiToNoteName(64, -7)).toBe("Fb4");

    // Sharp keys prefer sharp spellings (including E# / B# in +7)
    expect(midiToNoteName(66, 1)).toBe("F#4");
    expect(midiToNoteName(61, 2)).toBe("C#4");
    expect(midiToNoteName(65, 7)).toBe("E#4");
    expect(midiToNoteName(72, 7)).toBe("B#4");

    const { rerender } = render(
      <VirtualPianoKeyboard
        minPitch={60}
        maxPitch={72}
        keyFifths={-3}
        activePlaybackNotes={[]}
        onKeyDown={() => {}}
        onKeyUp={() => {}}
      />,
    );
    expect(screen.getByLabelText("Piano key Bb4")).toBeTruthy();
    expect(screen.getByLabelText("Piano key Eb4")).toBeTruthy();
    expect(screen.getByLabelText("Piano key Ab4")).toBeTruthy();
    expect(screen.queryByLabelText("Piano key A#4")).toBeNull();

    rerender(
      <VirtualPianoKeyboard
        minPitch={60}
        maxPitch={72}
        keyFifths={2}
        activePlaybackNotes={[]}
        onKeyDown={() => {}}
        onKeyUp={() => {}}
      />,
    );
    expect(screen.getByLabelText("Piano key C#4")).toBeTruthy();
    expect(screen.getByLabelText("Piano key D#4")).toBeTruthy();
    expect(screen.getByLabelText("Piano key F#4")).toBeTruthy();
    expect(screen.getByLabelText("Piano key G#4")).toBeTruthy();
    expect(screen.getByLabelText("Piano key A#4")).toBeTruthy();
  });

  it("enforces measure-scoped accidentals for F Major step input and key-aware chord spellings", () => {
    // 1. Bb3 (58) in F Major -> no redundant <accidental>
    const s1 = insertStepMidiNotesIntoXml(F_MAJOR_STEP_XML, {
      pitchesMidi: [58],
      durationType: "quarter",
      dotted: false,
    });
    expect(s1).not.toBeNull();
    let doc = new DOMParser().parseFromString(s1!.xml, "application/xml");
    let m1Notes = Array.from(doc.querySelectorAll('measure[number="1"] > note'));
    expect(m1Notes[0].querySelector("pitch > step")?.textContent).toBe("B");
    expect(m1Notes[0].querySelector("pitch > alter")?.textContent).toBe("-1");
    expect(m1Notes[0].querySelector("accidental")).toBeNull();

    // 2. B3 natural (59) later in measure 1 -> emits <accidental>natural</accidental>
    const s2 = insertStepMidiNotesIntoXml(s1!.xml, {
      pitchesMidi: [59],
      durationType: "quarter",
      dotted: false,
    });
    expect(s2).not.toBeNull();
    doc = new DOMParser().parseFromString(s2!.xml, "application/xml");
    m1Notes = Array.from(doc.querySelectorAll('measure[number="1"] > note'));
    expect(m1Notes[1].querySelector("pitch > step")?.textContent).toBe("B");
    expect(m1Notes[1].querySelector("pitch > alter")).toBeNull();
    expect(m1Notes[1].querySelector("accidental")?.textContent).toBe("natural");

    // 3. Bb3 (58) again inside measure 1 -> emits cautionary/re-stated <accidental>flat</accidental>
    const s3 = insertStepMidiNotesIntoXml(s2!.xml, {
      pitchesMidi: [58],
      durationType: "half",
      dotted: false,
    });
    expect(s3).not.toBeNull();
    doc = new DOMParser().parseFromString(s3!.xml, "application/xml");
    m1Notes = Array.from(doc.querySelectorAll('measure[number="1"] > note'));
    expect(m1Notes[2].querySelector("accidental")?.textContent).toBe("flat");

    // 4. Bb3 (58) in measure 2 -> resets per measure, no redundant flat
    const s4 = insertStepMidiNotesIntoXml(s3!.xml, {
      pitchesMidi: [58],
      durationType: "whole",
      dotted: false,
    });
    expect(s4).not.toBeNull();
    doc = new DOMParser().parseFromString(s4!.xml, "application/xml");
    const m2Notes = Array.from(doc.querySelectorAll('measure[number="2"] > note'));
    expect(m2Notes[0].querySelector("pitch > step")?.textContent).toBe("B");
    expect(m2Notes[0].querySelector("pitch > alter")?.textContent).toBe("-1");
    expect(m2Notes[0].querySelector("accidental")).toBeNull();

    // Key-aware chord & slash-bass spellings
    expect(respellChordSymbol("A#", -2)).toEqual({ symbol: "Bb", root: "Bb" });
    expect(respellChordSymbol("D#/G", -2)).toEqual({ symbol: "Eb/G", root: "Eb" });
    expect(respellChordSymbol("Bb", 4)).toEqual({ symbol: "A#", root: "A#" });
    const bbXml = injectChordsIntoMusicXml(s4!.xml, [
      { id: "c1", measure: 1, beat: 1, symbol: "A#", root: "A#", quality: "major", onset_sec: 0 },
      { id: "c2", measure: 1, beat: 3, symbol: "D#/A#", root: "D#", quality: "major", onset_sec: 2 },
    ]);
    const chordDoc = new DOMParser().parseFromString(bbXml, "application/xml");
    const harmonies = Array.from(chordDoc.querySelectorAll("harmony"));
    expect(harmonies[0].querySelector("root > root-step")?.textContent).toBe("B");
    expect(harmonies[0].querySelector("root > root-alter")?.textContent).toBe("-1");
    expect(harmonies[1].querySelector("root > root-step")?.textContent).toBe("E");
    expect(harmonies[1].querySelector("root > root-alter")?.textContent).toBe("-1");
    expect(harmonies[1].querySelector("bass > bass-step")?.textContent).toBe("B");
    expect(harmonies[1].querySelector("bass > bass-alter")?.textContent).toBe("-1");
  });

  it("handles explicit key change choices (Respell vs Transpose), legacy fallback, synced selectors, and Undo/Redo in Studio", async () => {
    vi.spyOn(api, "getMe").mockResolvedValue({
      id: "u1",
      email: "user@example.com",
      display_name: "Musician",
      email_verified: true,
      plan_tier: "pro",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
    vi.spyOn(api, "saveScore").mockImplementation(async (pid, score, ver, xml) => ({
      id: "s1",
      project_id: pid,
      version: (ver ?? 1) + 1,
      score_json: score,
      musicxml: xml ?? "",
      updated_at: new Date().toISOString(),
    }));
    vi.spyOn(api, "getProject").mockResolvedValue({
      id: "pg-1",
      user_id: "u1",
      title: "Playground Piece",
      description: "",
      status: "ready",
      instrument: "piano",
      transcription_mode: "midi_playground",
      duration_seconds: 4,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      media_assets: [],
    });
    // Simulate a legacy/untagged score missing key_signature & <key>
    vi.spyOn(api, "getScore").mockResolvedValue({
      id: "s1",
      project_id: "pg-1",
      version: 1,
      score_json: {
        title: "Playground Piece",
        tempo_bpm: 120,
        tempo_estimated: false,
        time_signature: "4/4",
        time_signature_estimated: false,
        key_signature: "",
        key_signature_estimated: false,
        duration_seconds: 4,
        tracks: [{ index: 0, name: "Piano", instrument: "piano", clef: "grand", program: 0, muted: false }],
        notes: [
          { id: "n1", pitch_midi: 70, onset_sec: 0, offset_sec: 1, velocity: 84, track_index: 0 }, // A#4/Bb4
        ],
        chords: [
          { id: "ch1", measure: 1, beat: 1, symbol: "A#", root: "A#", quality: "major", onset_sec: 0 },
        ],
        analysis: { source_type: "midi_playground" },
      },
      musicxml: TWO_MEASURE_CHORD_AND_TIE_XML,
      updated_at: new Date().toISOString(),
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/pg-1"]}>
          <AuthProvider>
            <Routes>
              <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const playgroundCtrl = await screen.findByTestId("playground-key-signature-control");
    const toolbarCtrl = await screen.findByTestId("toolbar-key-signature-control");
    const playgroundSelect = within(playgroundCtrl).getByLabelText("Key Signature") as HTMLSelectElement;
    const toolbarSelect = within(toolbarCtrl).getByLabelText("Key Signature") as HTMLSelectElement;

    // Missing key metadata defaults safely to C Major (0 fifths)
    expect(playgroundSelect.value).toBe("0");
    expect(toolbarSelect.value).toBe("0");

    // Switching key on populated score opens explicit choice dialog without mutating first
    fireEvent.change(playgroundSelect, { target: { value: "-2" } }); // Bb Major
    const dialog = await screen.findByTestId("key-change-dialog");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(screen.getByTestId("key-change-respell-btn")).toBeTruthy();
    expect(screen.getByTestId("key-change-transpose-btn")).toBeTruthy();

    // 1. Choose Respell (Keep Pitch): A#4 -> Bb4, key updates in both selectors
    fireEvent.click(screen.getByTestId("key-change-respell-btn"));
    await waitFor(() => {
      expect(playgroundSelect.value).toBe("-2");
      expect(toolbarSelect.value).toBe("-2");
    });

    // Chord symbol updates to flat spelling while keeping pitch
    expect(await screen.findByText(/Bb|100%/)).toBeTruthy();

    // 2. Choose Transpose from Toolbar control: Bb Major (-2) -> D Major (+2) (+4 semitones)
    fireEvent.change(toolbarSelect, { target: { value: "2" } });
    await screen.findByTestId("key-change-dialog");
    fireEvent.click(screen.getByTestId("key-change-transpose-btn"));
    await waitFor(() => {
      expect(playgroundSelect.value).toBe("2");
      expect(toolbarSelect.value).toBe("2");
    });

    // 3. Undo & Redo restore key selection cleanly
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true }));
    await waitFor(() => {
      expect(playgroundSelect.value).toBe("-2");
      expect(toolbarSelect.value).toBe("-2");
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, cancelable: true }));
    await waitFor(() => {
      expect(playgroundSelect.value).toBe("2");
      expect(toolbarSelect.value).toBe("2");
    });
  });

  it("applies key changes immediately without dialog when empty, and safely defaults legacy XML", async () => {
    const onApply = vi.fn();
    render(
      <SheetMusicViewer
        musicxml={LEGACY_MISSING_KEY_XML}
        notes={[]}
        defaultEngine="osmd"
        keyFifths={0}
        keyMode="major"
        onApplyKeySignature={onApply}
      />,
    );
    const select = await within(screen.getByTestId("toolbar-key-signature-control")).findByLabelText(
      "Key Signature",
    );
    expect((select as HTMLSelectElement).value).toBe("0");
    // LEGACY_MISSING_KEY_XML contains one <pitch>, so test empty rest-only score separately
    render(
      <SheetMusicViewer
        musicxml={F_MAJOR_STEP_XML}
        notes={[]}
        defaultEngine="osmd"
        keyFifths={-1}
        keyMode="major"
        onApplyKeySignature={onApply}
      />,
    );
    const allSelects = screen.getAllByLabelText("Key Signature") as HTMLSelectElement[];
    fireEvent.change(allSelects[1], { target: { value: "1" } });
    expect(screen.queryByTestId("key-change-dialog")).toBeNull();
    expect(onApply).toHaveBeenCalledWith(1, "major", "respell");
  });

  it("deletes individual chord tones, sole notes as rests, and measures with clean MusicXML edge cases", () => {
    // 1. Delete non-root chord tone (A#4 in C4+A#4+G4 chord) -> removes ONLY A#4
    const nonRootTarget = {
      partIndex: 0,
      measureNumber: 1,
      onsetWhole: 0,
      pitchMidi: 70,
      staffNumber: 1,
    };
    const delNonRoot = deleteXmlNote(TWO_MEASURE_CHORD_AND_TIE_XML, nonRootTarget);
    expect(delNonRoot?.deletedChordTone).toBe(true);
    let doc = new DOMParser().parseFromString(delNonRoot!.xml, "application/xml");
    const m1Pitches = Array.from(doc.querySelectorAll('measure[number="1"] > note > pitch > step')).map(
      (n) => n.textContent,
    );
    expect(m1Pitches).toEqual(["C", "G", "E", "A"]);

    // 2. Delete root chord tone (C4 in C4+A#4+G4 chord) -> promotes A#4 by removing its <chord/>
    const rootTarget = {
      partIndex: 0,
      measureNumber: 1,
      onsetWhole: 0,
      pitchMidi: 60,
      staffNumber: 1,
    };
    const delRoot = deleteXmlNote(TWO_MEASURE_CHORD_AND_TIE_XML, rootTarget);
    expect(delRoot?.deletedChordTone).toBe(true);
    doc = new DOMParser().parseFromString(delRoot!.xml, "application/xml");
    const firstS1Note = doc.querySelector('measure[number="1"] > note')!;
    expect(firstS1Note.querySelector("pitch > step")?.textContent).toBe("A");
    expect(firstS1Note.querySelector("chord")).toBeNull();
    expect(firstS1Note.querySelector("duration")?.textContent).toBe("4");

    // 3. Delete sole note in bass staff (A2) -> converts to <rest/> preserving duration=16 & type=whole
    const soleBassTarget = {
      partIndex: 0,
      measureNumber: 1,
      onsetWhole: 0,
      pitchMidi: 45,
      staffNumber: 2,
    };
    const delSole = deleteXmlNote(TWO_MEASURE_CHORD_AND_TIE_XML, soleBassTarget);
    expect(delSole?.deletedChordTone).toBe(false);
    doc = new DOMParser().parseFromString(delSole!.xml, "application/xml");
    const bassRestNote = doc.querySelector('measure[number="1"] > note:last-of-type')!;
    expect(bassRestNote.querySelector("rest")).not.toBeNull();
    expect(bassRestNote.querySelector("duration")?.textContent).toBe("16");
    expect(bassRestNote.querySelector("type")?.textContent).toBe("whole");

    // 4. Delete Measure 1 -> preserves <attributes> and tempo <direction> on new Measure 1, and removes dangling cross-bar tie stop on E4
    const delM1Xml = deleteMeasureFromAllParts(TWO_MEASURE_CHORD_AND_TIE_XML, 1);
    expect(delM1Xml).not.toBeNull();
    doc = new DOMParser().parseFromString(delM1Xml!, "application/xml");
    const remainingMeasures = Array.from(doc.querySelectorAll("part > measure"));
    expect(remainingMeasures).toHaveLength(1);
    expect(remainingMeasures[0].getAttribute("number")).toBe("1");
    expect(remainingMeasures[0].querySelector("attributes > divisions")?.textContent).toBe("4");
    expect(remainingMeasures[0].querySelector("direction sound")?.getAttribute("tempo")).toBe("120");
    expect(remainingMeasures[0].querySelector('tie[type="stop"]')).toBeNull();
    expect(remainingMeasures[0].querySelector('tied[type="stop"]')).toBeNull();
  });

  it("handles Delete/Backspace for selected notes and measures in SheetMusicViewer while ignoring inputs and modals", async () => {
    const onMusicXmlChange = vi.fn();
    render(
      <SheetMusicViewer
        musicxml={TWO_MEASURE_CHORD_AND_TIE_XML}
        defaultEngine="osmd"
        defaultEditMode={true}
        onMusicXmlChange={onMusicXmlChange}
      />,
    );

    const bassNote = await screen.findByTestId("mock-notehead-a2");

    // No selection -> Delete does nothing
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", cancelable: true }));
    expect(onMusicXmlChange).not.toHaveBeenCalled();

    // Select A2 bass notehead, test focus guards first
    fireEvent.click(bassNote);

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    expect(onMusicXmlChange).not.toHaveBeenCalled();
    input.remove();

    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", cancelable: true }));
    expect(onMusicXmlChange).not.toHaveBeenCalled();
    modal.remove();

    // Pressing Backspace with A2 selected converts it to a rest cleanly
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", cancelable: true }));
    await waitFor(() => {
      expect(onMusicXmlChange).toHaveBeenCalledTimes(1);
    });
    expect(onMusicXmlChange.mock.calls[0][0]).toContain("<rest");

    // Click empty area inside Measure 2 (zoom=0.9 -> scale=9; Measure 2 is at x=[126..234], y=[9..63])
    onMusicXmlChange.mockClear();
    const scrollContainer = screen.getByTestId("sheet-music-scroll-container");
    const svgHost = scrollContainer.querySelector("svg")!.parentElement!;
    vi.spyOn(svgHost, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 600,
      bottom: 400,
      width: 600,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.click(scrollContainer, { clientX: 150, clientY: 25 });
    const measureHighlight = await screen.findByTestId("selected-measure-highlight");
    expect(measureHighlight.getAttribute("aria-label")).toBe("Selected Measure 2");

    // Delete key deletes Measure 2 immediately without confirmation modal
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", cancelable: true }));
    await waitFor(() => {
      expect(onMusicXmlChange).toHaveBeenCalledTimes(1);
    });
    const nextDoc = new DOMParser().parseFromString(onMusicXmlChange.mock.calls[0][0], "application/xml");
    expect(nextDoc.querySelectorAll("part > measure")).toHaveLength(1);
  });
});
