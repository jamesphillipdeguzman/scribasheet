import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import {
  addMeasureToAllParts,
  deleteMeasureFromAllParts,
  mergeLiveMidiRecordingIntoXml,
  setMeasureBeatsOrMeter,
  setMeasureRepeatCount,
  setMeasureVoltaEnding,
  setScorePickupMeasure,
  toggleMeasureNavigationMarker,
  toggleMeasureRepeatBarline,
} from "@/features/editor/musicXmlEditor";
import { prepareDisplayMusicXml } from "@/features/editor/musicXmlNormalization";
import { extractScoreStructure, validateNavigationMarkers, validateVoltaEndings } from "@/features/editor/musicXmlStructure";
import {
  buildPlaybackSequence,
  mapPhysicalSecToPlaybackSec,
  mapPlaybackSecToPhysicalSec,
} from "@/features/editor/playbackSequence";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { api } from "@/services/api";
import type { ScoreNote } from "@/types/api";

let mockMeasureList: unknown[][] = [];

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: function MockOSMD(container: HTMLElement) {
    return {
      load: async () => undefined,
      render: () => {
        container.innerHTML = "";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("class", "vf-stavenote");
        const head = document.createElementNS("http://www.w3.org/2000/svg", "g");
        head.setAttribute("class", "vf-notehead");
        head.setAttribute("data-testid", "mock-notehead-m1");
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", "M0 0 L10 0");
        p.setAttribute("fill", "#000000");
        head.appendChild(p);
        g.appendChild(head);
        svg.appendChild(g);
        container.appendChild(svg);
        mockMeasureList = [
          [
            {
              MeasureNumber: 1,
              PositionAndShape: { AbsolutePosition: { x: 1, y: 1 }, Size: { width: 10, height: 6 } },
              staffEntries: [
                {
                  getAbsoluteTimestamp: () => ({ RealValue: 0 }),
                  graphicalVoiceEntries: [
                    {
                      notes: [
                        {
                          getSVGGElement: () => g,
                          sourceNote: { Pitch: { halfTone: 48 }, isRest: () => false },
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

const BASE_4_4_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Pickup &amp; Repeat Piece</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>48</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction placement="above">
        <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type>
        <sound tempo="120"/>
      </direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>48</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>48</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>48</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>48</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>192</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="3">
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>192</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="4">
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>192</duration><voice>1</voice><type>whole</type></note>
      <barline location="right"><bar-style>light-heavy</bar-style></barline>
    </measure>
  </part>
</score-partwise>`;

const BASE_6_8_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>48</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>6</beats><beat-type>8</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><rest measure="yes"/><duration>144</duration><voice>1</voice><type>quarter</type><dot/></note>
    </measure>
    <measure number="2">
      <note><rest measure="yes"/><duration>144</duration><voice>1</voice><type>quarter</type><dot/></note>
    </measure>
  </part>
</score-partwise>`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Pickup Measure, Per-Measure Meter, Repeats, Volta Endings, and Playback", () => {
  it("creates, fractional-sizes, normalizes, and removes pickup measures across meters cleanly", () => {
    // 2-beat pickup in 4/4 -> Measure 0 (implicit="yes") with 96 divs (2 quarters), full bar = number="1"
    const res44 = setScorePickupMeasure(BASE_4_4_XML, 2);
    expect(res44?.requiresOverflowConfirmation).toBeFalsy();
    const doc44 = new DOMParser().parseFromString(res44!.xml, "application/xml");
    const m44 = Array.from(doc44.querySelectorAll("part > measure"));
    expect(m44).toHaveLength(5);
    expect(m44[0].getAttribute("number")).toBe("0");
    expect(m44[0].getAttribute("implicit")).toBe("yes");
    expect(m44[0].querySelector("attributes > time > beats")?.textContent).toBe("4");
    expect(m44[0].querySelector("attributes > time > beat-type")?.textContent).toBe("4");
    expect(m44[0].querySelector("note > duration")?.textContent).toBe("96");
    expect(m44[0].querySelector("note > rest")?.getAttribute("measure")).toBeNull();
    expect(m44[1].getAttribute("number")).toBe("1");

    // Fractional custom pickup (1.5 beats in 4/4 -> 72 divs = dotted quarter) & normalization preserves it
    const resFrac = setScorePickupMeasure(res44!.xml, 1.5);
    const normalizedFrac = prepareDisplayMusicXml(resFrac!.xml, true);
    const structFrac = extractScoreStructure(normalizedFrac);
    expect(structFrac.hasPickup).toBe(true);
    expect(structFrac.pickupBeatsInUnit).toBeCloseTo(1.5, 3);
    expect(structFrac.pickupQuarterBeats).toBeCloseTo(1.5, 3);
    expect(structFrac.measures[0].measureNumber).toBe(0);
    expect(structFrac.measures[1].measureNumber).toBe(1);

    // 2-beat pickup in 6/8 interprets beats using eighth-note unit -> 48 divs = 1.0 quarter, NOT 2 quarters!
    const res68 = setScorePickupMeasure(BASE_6_8_XML, 2);
    const struct68 = extractScoreStructure(res68!.xml);
    expect(struct68.hasPickup).toBe(true);
    expect(struct68.pickupBeatsInUnit).toBeCloseTo(2, 3);
    expect(struct68.pickupQuarterBeats).toBeCloseTo(1.0, 3);

    // Adding/deleting later measures keeps Measure 0 numbering intact
    const withAdded = addMeasureToAllParts(resFrac!.xml, 1);
    expect(extractScoreStructure(withAdded!).measures.map((m) => m.measureNumber)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    const withDeleted = deleteMeasureFromAllParts(withAdded!, 2);
    expect(extractScoreStructure(withDeleted!).measures.map((m) => m.measureNumber)).toEqual([
      0, 1, 2, 3, 4,
    ]);

    // Removing empty pickup moves <attributes> back to Measure 1 cleanly
    const removed = setScorePickupMeasure(resFrac!.xml, null);
    const structRemoved = extractScoreStructure(removed!.xml);
    expect(structRemoved.hasPickup).toBe(false);
    expect(structRemoved.measures[0].measureNumber).toBe(1);
    expect(structRemoved.measures[0].timeBeats).toBe(4);
  });

  it("handles per-measure beat count, local meter restoration, ongoing meter change, and overflow warning", () => {
    // 1. Shortening populated Measure 1 triggers explicit overflow warning without silent mutation
    const warnShort = setMeasureBeatsOrMeter(BASE_4_4_XML, {
      measureNumber: 1,
      mode: "this_measure_only",
      beats: 2,
      beatType: 4,
      showMeterChange: true,
    });
    expect(warnShort?.requiresOverflowConfirmation).toBe(true);
    expect(warnShort?.overflowNoteCount).toBe(2);
    expect(warnShort?.xml).toBe(BASE_4_4_XML);

    // 2. Confirmed local 2/4 on Measure 2 restores 4/4 on Measure 3 automatically
    const local24 = setMeasureBeatsOrMeter(BASE_4_4_XML, {
      measureNumber: 2,
      mode: "this_measure_only",
      beats: 2,
      beatType: 4,
      showMeterChange: true,
      forceTruncate: true,
    });
    const stLocal = extractScoreStructure(local24!.xml);
    expect(stLocal.measures[1].timeBeats).toBe(2);
    expect(stLocal.measures[1].hasExplicitTimeChange).toBe(true);
    expect(stLocal.measures[1].actualQuarters).toBeCloseTo(2, 3);
    expect(stLocal.measures[2].timeBeats).toBe(4);
    expect(stLocal.measures[2].hasExplicitTimeChange).toBe(true);
    expect(stLocal.measures[3].timeBeats).toBe(4);

    // 3. Hidden irregular measure change preserves global 4/4 display while resizing only target bar
    const hiddenIrr = setMeasureBeatsOrMeter(BASE_4_4_XML, {
      measureNumber: 3,
      mode: "this_measure_only",
      beats: 3,
      beatType: 4,
      showMeterChange: false,
      forceTruncate: true,
    });
    const stIrr = extractScoreStructure(hiddenIrr!.xml);
    expect(stIrr.measures[2].isIrregular).toBe(true);
    expect(stIrr.measures[2].hasExplicitTimeChange).toBe(false);
    expect(stIrr.measures[2].actualQuarters).toBeCloseTo(3, 3);
    expect(stIrr.measures[3].actualQuarters).toBeCloseTo(4, 3);

    // 4. Ongoing 6/8 from Measure 2 onward updates Measures 2..4 (and respects explicit later meters)
    const ongoing68 = setMeasureBeatsOrMeter(BASE_4_4_XML, {
      measureNumber: 2,
      mode: "from_this_measure_onward",
      beats: 6,
      beatType: 8,
      showMeterChange: true,
      forceTruncate: true,
    });
    const st68 = extractScoreStructure(ongoing68!.xml);
    expect(st68.measures[0].timeBeats).toBe(4);
    expect(st68.measures[1].timeBeats).toBe(6);
    expect(st68.measures[1].timeBeatType).toBe(8);
    expect(st68.measures[2].timeBeats).toBe(6);
    expect(st68.measures[3].actualQuarters).toBeCloseTo(3, 3);

    // 5. Lengthening Measure 1 to 5/4 keeps all 4 original quarter notes intact and appends 1 quarter rest
    const long54 = setMeasureBeatsOrMeter(BASE_4_4_XML, {
      measureNumber: 1,
      mode: "this_measure_only",
      beats: 5,
      beatType: 4,
      showMeterChange: true,
    });
    const longDoc = new DOMParser().parseFromString(long54!.xml, "application/xml");
    const m1Pitches = Array.from(longDoc.querySelectorAll('measure[number="1"] > note > pitch > step')).map(
      (s) => s.textContent,
    );
    const m1Rests = Array.from(longDoc.querySelectorAll('measure[number="1"] > note > rest'));
    expect(m1Pitches).toEqual(["C", "D", "E", "F"]);
    expect(m1Rests).toHaveLength(1);
    expect(m1Rests[0].parentElement?.querySelector("duration")?.textContent).toBe("48");
  });

  it("aligns live MIDI recording across pickup measure and variable-meter measures", () => {
    const withPickup = setScorePickupMeasure(BASE_4_4_XML, 1)!.xml; // Measure 0 = 1 beat = 0.5s at 120 BPM
    const recorded: ScoreNote[] = [
      { id: "r1", pitch_midi: 60, onset_sec: 0.0, offset_sec: 0.5, velocity: 88, track_index: 0 }, // pickup beat (m.0)
      { id: "r2", pitch_midi: 64, onset_sec: 0.5, offset_sec: 1.5, velocity: 88, track_index: 0 }, // Beat 1 of m.1
    ];
    const merged = mergeLiveMidiRecordingIntoXml(withPickup, recorded, {
      tempoBpm: 120,
      timeSignature: "4/4",
      snapMode: "1/8",
      clefMode: "treble",
    });
    const doc = new DOMParser().parseFromString(merged!, "application/xml");
    const m0Step = doc.querySelector('measure[number="0"] > note > pitch > step')?.textContent;
    const m1Step = doc.querySelector('measure[number="1"] > note > pitch > step')?.textContent;
    expect(m0Step).toBe("C");
    expect(m1Step).toBe("E");
  });

  it("serializes repeat barlines, multi-measure volta endings, and navigation markers without duplication", () => {
    let xml = BASE_4_4_XML;
    // Toggle forward repeat on Measure 1 twice -> idempotent add then remove, then re-add
    xml = toggleMeasureRepeatBarline(xml, 1, "forward")!.xml;
    expect(extractScoreStructure(xml).measures[0].forwardRepeat).toBe(true);
    xml = toggleMeasureRepeatBarline(xml, 1, "forward")!.xml;
    expect(extractScoreStructure(xml).measures[0].forwardRepeat).toBe(false);
    xml = toggleMeasureRepeatBarline(xml, 1, "forward")!.xml;

    // Backward repeat on Measure 2 with count 3, plus multi-measure Ending 1 spanning Measures 2..3
    xml = setMeasureVoltaEnding(xml, 2, "start_1")!.xml;
    xml = setMeasureVoltaEnding(xml, 3, "end_ending")!.xml;
    expect(validateVoltaEndings(xml)).toEqual([]);
    xml = toggleMeasureRepeatBarline(xml, 3, "backward", 3)!.xml;
    xml = setMeasureRepeatCount(xml, 3, 3) ?? xml;
    xml = setMeasureVoltaEnding(xml, 4, "start_2")!.xml;

    // Navigation markers: Segno on M1, To Coda + Fine on M2, Coda on M4, D.S. al Coda on M3
    xml = toggleMeasureNavigationMarker(xml, 1, "segno")!.xml;
    xml = toggleMeasureNavigationMarker(xml, 2, "to_coda")!.xml;
    xml = toggleMeasureNavigationMarker(xml, 3, "ds_al_coda")!.xml;
    xml = toggleMeasureNavigationMarker(xml, 4, "coda")!.xml;
    expect(validateNavigationMarkers(xml)).toEqual([]);

    const struct = extractScoreStructure(xml);
    expect(struct.measures[0].forwardRepeat).toBe(true);
    expect(struct.measures[0].navigationMarkers).toContain("segno");
    expect(struct.measures[1].endingStart).toEqual([1]);
    expect(struct.measures[2].endingStop).toEqual([1]);
    expect(struct.measures[2].backwardRepeat).toBe(true);
    expect(struct.measures[2].repeatCount).toBe(3);
    expect(struct.measures[2].navigationMarkers).toContain("ds_al_coda");
    expect(struct.measures[3].endingStart).toEqual([2]);
    expect(struct.measures[3].endingDiscontinue).toEqual([2]);
    expect(struct.measures[3].navigationMarkers).toContain("coda");

    // Repeated barline/direction serialization check (no duplicate <repeat> or <barline>)
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.querySelectorAll('measure[number="1"] > barline[location="left"]')).toHaveLength(1);
    expect(doc.querySelectorAll('measure[number="3"] > barline[location="right"] repeat[direction="backward"]')).toHaveLength(1);
    expect(doc.querySelector('measure[number="3"] sound')?.getAttribute("dalsegno")).toBe("segno");
    expect(doc.querySelector('measure[number="4"] sound')?.getAttribute("coda")).toBe("coda");
  });

  it("unrolls repeats, repeat counts, volta endings, D.C./D.S. navigation, and metronome beats safely", () => {
    const timedXml = BASE_4_4_XML; // At 120 BPM: each 4/4 bar = 2.0s (M1:0..2, M2:2..4, M3:4..6, M4:6..8)
    const notes: ScoreNote[] = [
      { id: "n1", pitch_midi: 60, onset_sec: 0, offset_sec: 0.5, velocity: 85, track_index: 0 },
      { id: "n2", pitch_midi: 62, onset_sec: 2, offset_sec: 2.5, velocity: 85, track_index: 0 },
      { id: "n3", pitch_midi: 64, onset_sec: 4, offset_sec: 4.5, velocity: 85, track_index: 0 },
      { id: "n4", pitch_midi: 65, onset_sec: 6, offset_sec: 6.5, velocity: 85, track_index: 0 },
    ];

    // Case A: |: M1 | [1. M2 M3 :| | [2. M4 (with 1st ending spanning M2..M3 and backward repeat times=2)
    let xmlVolta = toggleMeasureRepeatBarline(timedXml, 1, "forward")!.xml;
    xmlVolta = setMeasureVoltaEnding(xmlVolta, 2, "start_1")!.xml;
    xmlVolta = setMeasureVoltaEnding(xmlVolta, 3, "end_ending")!.xml;
    xmlVolta = toggleMeasureRepeatBarline(xmlVolta, 3, "backward", 2)!.xml;
    xmlVolta = setMeasureVoltaEnding(xmlVolta, 4, "start_2")!.xml;

    const seqVolta = buildPlaybackSequence(xmlVolta, notes, 120);
    // Expected order: M1 -> M2 -> M3 -> (repeat) M1 -> (skip 1st ending M2..M3) -> M4
    expect(seqVolta.visits.map((v) => v.measureNumber)).toEqual([1, 2, 3, 1, 4]);
    expect(seqVolta.totalPlaybackSec).toBeCloseTo(10.0, 2);
    expect(seqVolta.playbackNotes.map((n) => n.pitch_midi)).toEqual([60, 62, 64, 60, 65]);
    // Playback 6.0s is start of second visit to M1 -> physical 0.0s
    expect(mapPlaybackSecToPhysicalSec(seqVolta, 6.2).measureNumber).toBe(1);
    expect(mapPlaybackSecToPhysicalSec(seqVolta, 6.2).physicalSec).toBeCloseTo(0.2, 3);
    expect(mapPhysicalSecToPlaybackSec(seqVolta, 6.5)).toBeCloseTo(8.5, 3);

    // Case B: Backward repeat times=3 plays repeated bar 3 times
    const xmlTimes3 = toggleMeasureRepeatBarline(timedXml, 1, "backward", 3)!.xml;
    const seqTimes3 = buildPlaybackSequence(xmlTimes3, notes, 120);
    expect(seqTimes3.visits.map((v) => v.measureNumber)).toEqual([1, 1, 1, 2, 3, 4]);

    // Case C: D.S. al Coda -> M1 -> M2 (Segno) -> M3 (To Coda + D.S.) -> M2 -> M3 (jumps to Coda M4)
    let xmlDsCoda = toggleMeasureNavigationMarker(timedXml, 2, "segno")!.xml;
    xmlDsCoda = toggleMeasureNavigationMarker(xmlDsCoda, 3, "to_coda")!.xml;
    xmlDsCoda = toggleMeasureNavigationMarker(xmlDsCoda, 3, "ds_al_coda")!.xml;
    xmlDsCoda = toggleMeasureNavigationMarker(xmlDsCoda, 4, "coda")!.xml;
    const seqDsCoda = buildPlaybackSequence(xmlDsCoda, notes, 120);
    expect(seqDsCoda.visits.map((v) => v.measureNumber)).toEqual([1, 2, 3, 2, 3, 4]);

    // Case D: D.C. al Fine -> M1 -> M2 (Fine) -> M3 (D.C. al Fine) -> M1 -> M2 (stops!)
    let xmlDcFine = toggleMeasureNavigationMarker(timedXml, 2, "fine")!.xml;
    xmlDcFine = toggleMeasureNavigationMarker(xmlDcFine, 3, "dc_al_fine")!.xml;
    const seqDcFine = buildPlaybackSequence(xmlDcFine, notes, 120);
    expect(seqDcFine.visits.map((v) => v.measureNumber)).toEqual([1, 2, 3, 1, 2]);

    // Case E: Pickup (2 beats in 4/4 = 1.0s) aligns Beat 1 of Measure 1 right at 1.0s (downbeat!)
    const xmlPickup = setScorePickupMeasure(timedXml, 2)!.xml;
    const seqPickup = buildPlaybackSequence(xmlPickup, [], 120);
    const downbeatM1 = seqPickup.metronomeBeats.find(
      (b) => !b.isSubdivision && b.measureNumber === 1 && b.isDownbeat,
    );
    expect(downbeatM1?.sec).toBeCloseTo(1.0, 3);
    const pickupBeats = seqPickup.metronomeBeats.filter(
      (b) => !b.isSubdivision && b.measureNumber === 0,
    );
    expect(pickupBeats.map((b) => ({ beatInBar: b.beatInBar, isDownbeat: b.isDownbeat }))).toEqual([
      { beatInBar: 3, isDownbeat: false },
      { beatInBar: 4, isDownbeat: false },
    ]);
  });

  it("integrates Playground Pickup, Edit Notation Meter/Repeats, Persistence, and Undo/Redo in Studio", async () => {
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
    const saveSpy = vi.spyOn(api, "saveScore").mockImplementation(async (pid, score, ver, xml) => ({
      id: "s1",
      project_id: pid,
      version: (ver ?? 1) + 1,
      score_json: score,
      musicxml: xml ?? "",
      updated_at: new Date().toISOString(),
    }));
    vi.spyOn(api, "getProject").mockResolvedValue({
      id: "pg-pickup",
      user_id: "u1",
      title: "Anacrusis Etude",
      description: "",
      status: "ready",
      instrument: "piano",
      transcription_mode: "midi_playground",
      duration_seconds: 8,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      media_assets: [],
    });
    vi.spyOn(api, "getScore").mockResolvedValue({
      id: "s1",
      project_id: "pg-pickup",
      version: 1,
      score_json: {
        title: "Anacrusis Etude",
        tempo_bpm: 120,
        tempo_estimated: false,
        time_signature: "4/4",
        time_signature_estimated: false,
        key_signature: "C Major",
        key_signature_estimated: false,
        duration_seconds: 8,
        tracks: [{ index: 0, name: "Piano", instrument: "piano", clef: "treble", program: 0, muted: false }],
        notes: [{ id: "n1", pitch_midi: 60, onset_sec: 0, offset_sec: 0.5, velocity: 85, track_index: 0 }],
        chords: [],
        analysis: { source_type: "midi_playground" },
      },
      musicxml: BASE_4_4_XML,
      updated_at: new Date().toISOString(),
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/pg-pickup"]}>
          <AuthProvider>
            <Routes>
              <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const pickupSelect = (await screen.findByLabelText("Playground pickup measure")) as HTMLSelectElement;
    expect(pickupSelect.value).toBe("none");

    // 1. Choose 2-beat pickup -> adds Measure 0 implicit="yes" & stays selected cleanly
    fireEvent.change(pickupSelect, { target: { value: "2" } });
    await waitFor(() => {
      expect(pickupSelect.value).toBe("2");
    });

    // 2. Select notehead in Measure 1 & open Measure Beats / Meter popover + Repeats popover
    const noteEl = await screen.findByTestId("mock-notehead-m1");
    fireEvent.click(noteEl);
    const meterBtn = await screen.findByTestId("palette-measure-meter-btn");
    fireEvent.click(meterBtn);
    expect(await screen.findByTestId("measure-meter-popover")).toBeTruthy();

    // Trying to shorten populated Measure 1 to 2 beats pops explicit overflow dialog
    fireEvent.click(screen.getByTestId("measure-beat-preset-2"));
    expect(await screen.findByTestId("measure-overflow-dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("measure-overflow-cancel-btn"));
    expect(screen.queryByTestId("measure-overflow-dialog")).toBeNull();

    // Open Repeats popover & add a D.S. al Fine marker
    fireEvent.click(screen.getByTestId("palette-repeats-btn"));
    fireEvent.click(await screen.findByTestId("nav-marker-ds_al_fine"));
    expect(await screen.findByTestId("palette-status-message")).toBeTruthy();

    // 3. Undo removes D.S. marker (clearing popover/status), Undo again removes Pickup -> Redo restores Pickup
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true }));
    await waitFor(() => {
      expect(screen.queryByTestId("palette-status-message")).toBeNull();
      expect(screen.queryByTestId("repeat-palette-popover")).toBeNull();
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true }));
    await waitFor(() => {
      expect(pickupSelect.value).toBe("none");
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, cancelable: true }));
    await waitFor(() => {
      expect(pickupSelect.value).toBe("2");
    });

    // Trigger manual save button to verify persisted score_json.analysis.structure + musicxml
    fireEvent.click(within(screen.getByTestId("studio-header")).getByRole("button", { name: /Save Score/i }));
    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalled();
    });
    const lastCall = saveSpy.mock.calls[saveSpy.mock.calls.length - 1];
    expect((lastCall[1].analysis?.structure as { hasPickup?: boolean } | undefined)?.hasPickup).toBe(true);
    expect(lastCall[3]).toContain('number="0" implicit="yes"');
  });
});
