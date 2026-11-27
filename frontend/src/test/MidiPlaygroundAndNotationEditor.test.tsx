import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { ExportCenter } from "@/features/editor/ExportCenter";
import {
  computeDiatonicDragPitch,
  convertXmlNoteToRest,
  flipXmlNoteStem,
  getXmlNoteInfo,
  insertStepMidiNotesIntoXml,
  mergeLiveMidiRecordingIntoXml,
  musicXmlToScoreNotes,
  setXmlNoteAccidental,
  setXmlNoteDuration,
  setXmlNotePitch,
  setXmlNoteVoice,
  toggleXmlNoteArticulation,
  toggleXmlNoteDot,
  toggleXmlNoteSlur,
  toggleXmlNoteTie,
  toggleXmlNoteTriplet,
  type XmlNoteTarget,
} from "@/features/editor/musicXmlEditor";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
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
              PositionAndShape: { Size: { height: 4 } },
              staffEntries: [
                {
                  getAbsoluteTimestamp: () => ({ RealValue: 0 }),
                  graphicalVoiceEntries: [
                    {
                      notes: [
                        {
                          getSVGGElement: () => noteC4,
                          sourceNote: { Pitch: { halfTone: 48 }, isRest: () => false },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              MeasureNumber: 1,
              PositionAndShape: { Size: { height: 4 } },
              staffEntries: [
                {
                  getAbsoluteTimestamp: () => ({ RealValue: 0 }),
                  graphicalVoiceEntries: [
                    {
                      notes: [
                        {
                          getSVGGElement: () => noteA2,
                          sourceNote: { Pitch: { halfTone: 33 }, isRest: () => false }, // 33 + 12 = 45 (A2)
                        },
                      ],
                    },
                  ],
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

const GRAND_STAFF_SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Playground Test</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>1</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration>
        <voice>1</voice>
        <type>quarter</type>
        <staff>1</staff>
      </note>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration>
        <voice>1</voice>
        <type>quarter</type>
        <staff>1</staff>
      </note>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>8</duration>
        <voice>1</voice>
        <type>half</type>
        <staff>1</staff>
      </note>
      <backup><duration>16</duration></backup>
      <note>
        <pitch><step>A</step><octave>2</octave></pitch>
        <duration>8</duration>
        <voice>2</voice>
        <type>half</type>
        <staff>2</staff>
      </note>
      <note>
        <pitch><step>E</step><octave>3</octave></pitch>
        <duration>8</duration>
        <voice>2</voice>
        <type>half</type>
        <staff>2</staff>
      </note>
    </measure>
  </part>
</score-partwise>`;

const targetNote1: XmlNoteTarget = {
  partIndex: 0,
  measureNumber: 1,
  onsetWhole: 0,
  pitchMidi: 60,
  staffNumber: 1,
  noteIndex: 0,
};

describe("MuseScore Notation Engine (Durations, Dots, Accidentals, Ties, Slurs, Articulations, Tuplets, Voices, Drag, MIDI)", () => {
  it("supports all 7 durations, augmentation dot distinct from staccato, rest, and all 5 accidentals", () => {
    let xml = GRAND_STAFF_SAMPLE_XML;
    for (const dur of ["64th", "32nd", "16th", "eighth", "quarter", "half", "whole"] as const) {
      const res = setXmlNoteDuration(xml, targetNote1, dur);
      expect(res).not.toBeNull();
      xml = res!.xml;
      expect(getXmlNoteInfo(xml, targetNote1)?.durationType).toBe(dur);
    }

    // Set quarter + augmentation dot, and staccato separately
    xml = setXmlNoteDuration(xml, targetNote1, "quarter")!.xml;
    const dotRes = toggleXmlNoteDot(xml, targetNote1)!;
    expect(dotRes.dotted).toBe(true);
    xml = dotRes.xml;
    expect(getXmlNoteInfo(xml, targetNote1)?.dotted).toBe(true);

    const staccRes = toggleXmlNoteArticulation(xml, targetNote1, "staccato")!;
    expect(staccRes.active).toBe(true);
    xml = staccRes.xml;
    const infoBoth = getXmlNoteInfo(xml, targetNote1)!;
    expect(infoBoth.dotted).toBe(true);
    expect(infoBoth.articulations).toEqual(["staccato"]);

    let accTarget = targetNote1;
    for (const acc of ["flat-flat", "flat", "natural", "sharp", "double-sharp"] as const) {
      const accRes = setXmlNoteAccidental(xml, accTarget, acc)!;
      xml = accRes.xml;
      accTarget = accRes.nextTarget;
      expect(getXmlNoteInfo(xml, accTarget)?.accidental).toBe(acc);
    }

    const restXml = convertXmlNoteToRest(xml, accTarget)!.xml;
    expect(getXmlNoteInfo(restXml, { ...accTarget, pitchMidi: null })?.isRest).toBe(true);
  });

  it("enforces same-pitch ties, toggles slurs, applies articulations to playback notes, and supports triplets, stem flip & voices", () => {
    // Tie between C4 -> C4 succeeds
    const tieOk = toggleXmlNoteTie(GRAND_STAFF_SAMPLE_XML, targetNote1);
    expect(tieOk.changed).toBe(true);
    expect(getXmlNoteInfo(tieOk.xml, targetNote1)?.hasTieStart).toBe(true);
    const mergedNotes = musicXmlToScoreNotes(
      tieOk.xml,
      [
        { index: 0, name: "RH", instrument: "piano", clef: "treble", program: 0, muted: false },
        { index: 1, name: "LH", instrument: "piano", clef: "bass", program: 0, muted: false },
      ],
      120,
    );
    // Two tied C4 quarters merge into a 1.0s note instead of 2 separate 0.5s notes
    const rhC4s = mergedNotes.notes.filter((n) => n.track_index === 0 && n.pitch_midi === 60);
    expect(rhC4s).toHaveLength(1);
    expect(rhC4s[0].offset_sec - rhC4s[0].onset_sec).toBeCloseTo(1.0, 2);

    // Tie between different pitches (C4 -> E4) is rejected gracefully
    const secondNoteTarget: XmlNoteTarget = {
      partIndex: 0,
      measureNumber: 1,
      onsetWhole: 0.25,
      pitchMidi: 60,
      staffNumber: 1,
      noteIndex: 1,
    };
    const tieBad = toggleXmlNoteTie(GRAND_STAFF_SAMPLE_XML, secondNoteTarget);
    expect(tieBad.changed).toBe(false);
    expect(tieBad.message).toContain("same pitch");

    // Slur + marcato + accent + tenuto + staccato
    const slurRes = toggleXmlNoteSlur(GRAND_STAFF_SAMPLE_XML, targetNote1);
    expect(slurRes.changed).toBe(true);
    expect(getXmlNoteInfo(slurRes.xml, targetNote1)?.hasSlurStart).toBe(true);

    const accentXml = toggleXmlNoteArticulation(GRAND_STAFF_SAMPLE_XML, targetNote1, "marcato")!.xml;
    const accentedPlayback = musicXmlToScoreNotes(accentXml, [], 120);
    const accentedC4 = accentedPlayback.notes.find((n) => n.pitch_midi === 60)!;
    expect(accentedC4.velocity).toBeGreaterThan(100);

    const staccXml = toggleXmlNoteArticulation(GRAND_STAFF_SAMPLE_XML, targetNote1, "staccato")!.xml;
    const staccPlayback = musicXmlToScoreNotes(staccXml, [], 120);
    const staccC4 = staccPlayback.notes.find((n) => n.pitch_midi === 60)!;
    expect(staccC4.offset_sec - staccC4.onset_sec).toBeLessThan(0.35);

    // Triplet, flip stem, voice 2
    const tripletXml = toggleXmlNoteTriplet(GRAND_STAFF_SAMPLE_XML, targetNote1)!.xml;
    expect(getXmlNoteInfo(tripletXml, targetNote1)?.isTriplet).toBe(true);

    const stemXml = flipXmlNoteStem(GRAND_STAFF_SAMPLE_XML, targetNote1)!.xml;
    const flippedStem = getXmlNoteInfo(stemXml, targetNote1)?.stem;
    expect(flippedStem).toBeTruthy();

    const voiceXml = setXmlNoteVoice(GRAND_STAFF_SAMPLE_XML, targetNote1, "2")!.xml;
    expect(getXmlNoteInfo(voiceXml, targetNote1)?.voice).toBe("2");
  });

  it("computes key-aware diatonic drag pitches and preserves chord siblings during setXmlNotePitch", () => {
    // G Major (fifths=1): dragging A2 up 2 diatonic steps lands on C3 (natural); dragging E4 up 1 step lands on F#4!
    const upTwo = computeDiatonicDragPitch({ step: "A", octave: 2, alter: 0 }, 2, 1);
    expect(upTwo.label).toBe("C3");
    expect(upTwo.midi).toBe(48);

    const upIntoKeySharp = computeDiatonicDragPitch({ step: "E", octave: 4, alter: 0 }, 1, 1);
    expect(upIntoKeySharp.label).toBe("F#4");
    expect(upIntoKeySharp.midi).toBe(66);

    // Preserve chord sibling when repitching target note
    const chordXml = GRAND_STAFF_SAMPLE_XML.replace(
      "<note>\n        <pitch><step>C</step><octave>4</octave></pitch>",
      "<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>\n" +
        "<note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note><!--",
    ).replace("</staff>\n      </note>", "</staff></note>-->");
    const edited = setXmlNotePitch(
      chordXml.replace(/<!--[\s\S]*?-->/, ""),
      { partIndex: 0, measureNumber: 1, onsetWhole: 0, pitchMidi: 60, staffNumber: 1, noteIndex: 0 },
      { step: "D", octave: 4, alter: 0 },
    );
    expect(edited).not.toBeNull();
    expect(edited!.xml).toContain("<step>D</step>");
    expect(edited!.xml).toContain("<chord/>");
    expect(edited!.xml).toContain("<step>G</step>");
  });

  it("inserts MIDI chords via Step Input and merges Live MIDI Recording across Treble & Bass", () => {
    const stepTarget: XmlNoteTarget = {
      partIndex: 0,
      measureNumber: 1,
      onsetWhole: 0,
      pitchMidi: 60,
      staffNumber: 1,
      noteIndex: 0,
    };
    const stepRes = insertStepMidiNotesIntoXml(GRAND_STAFF_SAMPLE_XML, {
      pitchesMidi: [64, 67, 72],
      durationType: "eighth",
      dotted: false,
      voice: "1",
      staffNumber: 1,
      cursorTarget: stepTarget,
    });
    expect(stepRes).not.toBeNull();
    expect(stepRes!.xml).toContain("<chord/>");
    expect(stepRes!.xml).toContain("<step>G</step>");

    const recorded = [
      { id: "r1", pitch_midi: 67, onset_sec: 0.0, offset_sec: 0.5, velocity: 90, track_index: 0 },
      { id: "r2", pitch_midi: 48, onset_sec: 0.0, offset_sec: 1.0, velocity: 85, track_index: 0 },
    ];
    const mergedXml = mergeLiveMidiRecordingIntoXml(GRAND_STAFF_SAMPLE_XML, recorded, {
      tempoBpm: 120,
      timeSignature: "4/4",
      snapMode: "1/8",
      clefMode: "grand",
    });
    expect(mergedXml).not.toBeNull();
    expect(mergedXml).toContain("<staff>1</staff>");
    expect(mergedXml).toContain("<staff>2</staff>");
    expect(mergedXml).toContain("<step>G</step>");
    expect(mergedXml).toContain("<step>C</step>");
  });
});

describe("UI Integration: Dashboard Playground, Studio Undo/Redo & Copy, Drag Tooltip, and Exports", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows MIDI Playground button on Dashboard beside Sheet Music to Audio & New Transcription", async () => {
    vi.spyOn(api, "getMe").mockResolvedValue({
      id: "u1",
      email: "user@example.com",
      display_name: "Musician",
      email_verified: true,
      plan_tier: "pro",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    vi.spyOn(api, "listProjects").mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20 });
    const createPgSpy = vi.spyOn(api, "createPlaygroundProject").mockResolvedValue({
      id: "pg-123",
      user_id: "u1",
      title: "Untitled Playground",
      description: "",
      status: "ready",
      instrument: "piano",
      transcription_mode: "midi_playground",
      duration_seconds: 8,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      media_assets: [],
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/dashboard"]}>
          <AuthProvider>
            <Routes>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/projects/:projectId" element={<div data-testid="navigated-studio">Studio</div>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const pgBtn = await screen.findByTestId("new-midi-playground-btn");
    expect(pgBtn.textContent).toContain("MIDI Playground");
    expect(screen.getByText(/Sheet Music to Audio/i)).toBeTruthy();
    expect(screen.getByText(/New Transcription/i)).toBeTruthy();

    fireEvent.click(pgBtn);
    await waitFor(() => {
      expect(createPgSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("navigated-studio")).toBeTruthy();
    });
  });

  it("supports vertical notehead pitch dragging with live tooltip, single Undo commit, and focus-scoped shortcuts", async () => {
    const onXmlChange = vi.fn();
    render(
      <SheetMusicViewer
        musicxml={GRAND_STAFF_SAMPLE_XML}
        defaultEngine="osmd"
        defaultEditMode={true}
        onMusicXmlChange={onXmlChange}
      />,
    );

    // Wait for bass-clef A2 notehead
    const a2Head = await screen.findByTestId("mock-notehead-a2");
    expect(a2Head.getAttribute("data-mxml-note")).toBe("true");

    // Ensure PointerEvent inherits MouseEvent clientY in jsdom so drag coordinates propagate
    const OrigPointerEvent = globalThis.PointerEvent;
    if (!OrigPointerEvent || typeof new OrigPointerEvent("pointerdown", { clientY: 100 }).clientY !== "number") {
      class PolyfillPointerEvent extends MouseEvent {
        pointerId: number;
        constructor(type: string, params: PointerEventInit = {}) {
          super(type, params);
          this.pointerId = params.pointerId ?? 1;
        }
      }
      globalThis.PointerEvent = PolyfillPointerEvent as unknown as typeof PointerEvent;
    }

    try {
      // Drag up by 10px (~2 half-spaces at zoom 0.9 => +2 diatonic steps A2 -> C3)
      fireEvent.pointerDown(a2Head, { button: 0, pointerId: 1, clientY: 100 });
      fireEvent.pointerMove(a2Head, { pointerId: 1, clientY: 90 });

      const tooltip = await screen.findByTestId("staff-drag-pitch-tooltip");
      expect(tooltip.textContent).toBe("A2 → C3");
      expect(onXmlChange).not.toHaveBeenCalled();

      // Commit on pointerUp -> single edit callback
      fireEvent.pointerUp(a2Head, { pointerId: 1, clientY: 90 });
      await waitFor(() => {
        expect(onXmlChange).toHaveBeenCalledTimes(1);
        expect(onXmlChange.mock.calls[0][0]).toContain("<step>C</step>");
      });
      expect(screen.queryByTestId("staff-drag-pitch-tooltip")).toBeNull();

      // Drag cancel discards change without committing
      fireEvent.pointerDown(a2Head, { button: 0, pointerId: 2, clientY: 100 });
      fireEvent.pointerMove(a2Head, { pointerId: 2, clientY: 85 });
      fireEvent.pointerCancel(a2Head, { pointerId: 2 });
      expect(onXmlChange).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("staff-drag-pitch-tooltip")).toBeNull();
    } finally {
      if (OrigPointerEvent) globalThis.PointerEvent = OrigPointerEvent;
    }

    // Focus-scoped keyboard shortcut 'n' toggles Note Input when not focused inside an input
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true, cancelable: true }));
    expect(screen.getByTestId("palette-note-input-btn").getAttribute("aria-pressed")).toBe("false");
    input.remove();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", cancelable: true }));
    await waitFor(() => {
      expect(screen.getByTestId("palette-note-input-btn").getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("renders Edit Copy in Playground & restores both scoreData and musicxml on Undo in Studio", async () => {
    vi.spyOn(api, "getMe").mockResolvedValue({
      id: "u1",
      email: "user@example.com",
      display_name: "Musician",
      email_verified: true,
      plan_tier: "pro",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const mockProject = {
      id: "proj-1",
      user_id: "u1",
      title: "Original Piece",
      description: "",
      status: "ready",
      instrument: "piano",
      transcription_mode: "piano_solo",
      duration_seconds: 2,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      media_assets: [],
    };
    vi.spyOn(api, "getProject").mockResolvedValue(mockProject);
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
    vi.spyOn(api, "getScore").mockResolvedValue({
      id: "s1",
      project_id: "proj-1",
      version: 1,
      score_json: {
        title: "Original Piece",
        tempo_bpm: 120,
        tempo_estimated: false,
        time_signature: "4/4",
        time_signature_estimated: false,
        key_signature: "G Major",
        key_signature_estimated: false,
        duration_seconds: 2,
        tracks: [{ index: 0, name: "Piano", instrument: "piano", clef: "grand", program: 0, muted: false }],
        notes: [{ id: "n1", pitch_midi: 60, onset_sec: 0, offset_sec: 0.5, velocity: 84, track_index: 0 }],
        chords: [],
        analysis: {},
      },
      musicxml: GRAND_STAFF_SAMPLE_XML,
      updated_at: new Date().toISOString(),
    });
    const copySpy = vi.spyOn(api, "createPlaygroundCopy").mockResolvedValue({
      ...mockProject,
      id: "proj-copy",
      title: "Original Piece (Playground Copy)",
      transcription_mode: "midi_playground",
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/proj-1"]}>
          <AuthProvider>
            <Routes>
              <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const copyBtn = await screen.findByTestId("edit-copy-in-playground-btn");
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(copySpy).toHaveBeenCalledWith("proj-1");
    });
  });

  it("displays PDF, MusicXML, MXL, MIDI, WAV, and MP3 options in ExportCenter", async () => {
    vi.spyOn(api, "listExports").mockResolvedValue([]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ExportCenter projectId="p1" projectTitle="Test Score" hasScore={true} />
      </QueryClientProvider>,
    );
    expect(screen.getByText(".pdf")).toBeTruthy();
    expect(screen.getByText(".musicxml")).toBeTruthy();
    expect(screen.getByText(".mxl")).toBeTruthy();
    expect(screen.getByText(".mid")).toBeTruthy();
    expect(screen.getByText(".wav")).toBeTruthy();
    expect(screen.getByText(".mp3")).toBeTruthy();
  });
});
