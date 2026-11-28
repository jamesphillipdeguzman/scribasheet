import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { midiSynth } from "@/features/editor/midiSynth";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { api } from "@/services/api";
import type { Project, ProjectScoreResponse, ScoreData } from "@/types/api";

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: function MockStudioOSMD(container: HTMLElement) {
    let loadedXml = "";
    const instance = {
      Zoom: 1,
      GraphicSheet: null as unknown,
      cursor: {
        show: () => undefined,
        hide: () => undefined,
        reset: () => undefined,
        next: () => undefined,
        update: () => undefined,
        CursorOptions: {},
        cursorElement: document.createElement("img"),
      },
      setOptions: () => undefined,
      clear: () => {
        container.innerHTML = "";
      },
      load: async (xml: string) => {
        loadedXml = xml;
      },
      render: () => {
        container.innerHTML = "";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "1200");
        svg.setAttribute("height", "240");
        Object.defineProperty(container, "getBoundingClientRect", {
          configurable: true,
          value: () => ({
            left: 0,
            top: 0,
            right: 1200,
            bottom: 240,
            width: 1200,
            height: 240,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          }),
        });

        const doc = new DOMParser().parseFromString(loadedXml, "application/xml");
        const measures = Array.from(doc.querySelectorAll("part > measure"));
        const measureList: unknown[][] = [];
        let divisions = 4;
        let runningWhole = 0;

        measures.forEach((mEl, mIdx) => {
          const divEl = mEl.querySelector("attributes > divisions");
          if (divEl?.textContent) {
            const parsed = Number(divEl.textContent.trim());
            if (parsed > 0) divisions = parsed;
          }
          const mNum = Number(mEl.getAttribute("number") || String(mIdx + 1));
          const mLeftPx = 20 + mIdx * 200;
          const staffEntries: unknown[] = [];
          let curDiv = 0;

          for (const child of Array.from(mEl.children)) {
            if (child.tagName.toLowerCase() !== "note") continue;
            const durDivs = Number(child.querySelector("duration")?.textContent || String(divisions));
            const step = child.querySelector("pitch > step")?.textContent?.trim() || "C";
            const octave = Number(child.querySelector("pitch > octave")?.textContent || "5");
            const onsetWhole = runningWhole + curDiv / (divisions * 4);
            const nx = mLeftPx + 20 + (curDiv / divisions) * 40;
            curDiv += durDivs;

            const staveGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
            staveGroup.setAttribute("class", "vf-stavenote");
            const nh = document.createElementNS("http://www.w3.org/2000/svg", "g");
            nh.setAttribute("class", "vf-notehead");
            nh.setAttribute("data-testid", `studio-note-m${mNum}-o${Math.round(onsetWhole * 1000)}`);
            Object.defineProperty(nh, "getBoundingClientRect", {
              configurable: true,
              value: () => ({
                left: nx,
                top: 84,
                right: nx + 12,
                bottom: 96,
                width: 12,
                height: 12,
                x: nx,
                y: 84,
                toJSON: () => ({}),
              }),
            });
            staveGroup.appendChild(nh);
            svg.appendChild(staveGroup);

            const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
            const midi = (octave + 1) * 12 + (SEMI[step] ?? 0);
            staffEntries.push({
              getAbsoluteTimestamp: () => ({ RealValue: onsetWhole }),
              graphicalVoiceEntries: [
                {
                  notes: [
                    {
                      vfnoteIndex: 0,
                      sourceNote: {
                        isRest: () => false,
                        Pitch: { halfTone: midi - 12 },
                        ParentStaffEntry: { ParentStaff: { idInMusicSheet: 0 } },
                      },
                      getSVGGElement: () => staveGroup,
                      getNoteheadSVGs: () => [nh],
                    },
                  ],
                },
              ],
            });
          }

          runningWhole += Math.max(1, curDiv / (divisions * 4));
          measureList.push([
            {
              MeasureNumber: mNum,
              parentSourceMeasure: {
                MeasureNumber: mNum,
                AbsoluteTimestamp: { RealValue: runningWhole - 1 },
              },
              PositionAndShape: {
                AbsolutePosition: { x: mLeftPx / 9, y: 4 },
                Size: { width: 180 / 9, height: 14 },
              },
              staffEntries,
            },
          ]);
        });

        instance.GraphicSheet = { MeasureList: measureList };
        container.appendChild(svg);
      },
    };
    return instance;
  },
}));

const STUDIO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>8</duration><type>half</type></note>
      <note><pitch><step>A</step><octave>5</octave></pitch><duration>8</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;

function buildStudioFixtures(): { project: Project; scoreResp: ProjectScoreResponse } {
  const project: Project = {
    id: "proj-e2e-1",
    user_id: "user-1",
    title: "Amazing Hymn",
    description: "",
    instrument: "vocals",
    transcription_mode: "satb_pdf",
    status: "ready",
    duration_seconds: 4,
    created_at: "2026-11-28T00:00:00Z",
    updated_at: "2026-11-28T00:00:00Z",
    media_assets: [],
  };

  const scoreData: ScoreData = {
    title: "Amazing Hymn",
    tempo_bpm: 120,
    tempo_estimated: false,
    time_signature: "4/4",
    time_signature_estimated: false,
    key_signature: "C major",
    key_signature_estimated: false,
    duration_seconds: 4,
    tracks: [{ index: 0, name: "Soprano", instrument: "vocals", clef: "treble", program: 0, muted: false }],
    notes: [
      { id: "n1", pitch_midi: 72, onset_sec: 0.0, offset_sec: 0.5, velocity: 85, track_index: 0 },
      { id: "n2", pitch_midi: 74, onset_sec: 0.5, offset_sec: 1.0, velocity: 85, track_index: 0 },
      { id: "n3", pitch_midi: 76, onset_sec: 1.0, offset_sec: 1.5, velocity: 85, track_index: 0 },
      { id: "n4", pitch_midi: 77, onset_sec: 1.5, offset_sec: 2.0, velocity: 85, track_index: 0 },
      { id: "n5", pitch_midi: 79, onset_sec: 2.0, offset_sec: 3.0, velocity: 85, track_index: 0 },
      { id: "n6", pitch_midi: 81, onset_sec: 3.0, offset_sec: 4.0, velocity: 85, track_index: 0 },
    ],
    chords: [],
    analysis: { mode: "satb_pdf" },
  };

  return {
    project,
    scoreResp: {
      id: "score-1",
      project_id: project.id,
      version: 1,
      score_json: scoreData,
      musicxml: STUDIO_XML,
      updated_at: "2026-11-28T00:00:00Z",
    },
  };
}

function renderStudioPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={["/projects/proj-e2e-1"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("ProjectStudioPage End-to-End MuseScore Workflows", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const { project, scoreResp } = buildStudioFixtures();
    vi.spyOn(api, "getProject").mockResolvedValue(project);
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 1,
      worker_id: "w1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 30,
    });
    vi.spyOn(api, "getScore").mockResolvedValue(scoreResp);
    vi.spyOn(api, "getLyrics").mockResolvedValue({
      text: "",
      segments: [],
      language: null,
      source_used: "manual",
      demucs_requested: false,
      demucs_fallback_used: false,
      model_name: "manual",
      device: "browser",
      has_word_timestamps: false,
      uncertain_segments: [],
      manually_edited: false,
      updated_at: null,
    });
    vi.spyOn(midiSynth, "preloadPiano").mockImplementation(() => undefined);
    vi.spyOn(midiSynth, "needsSamplerWait").mockReturnValue(false);
    vi.spyOn(midiSynth, "setPausedPosition").mockImplementation(() => undefined);
    vi.spyOn(midiSynth, "stop").mockImplementation(() => undefined);
  });

  it("synchronizes rapid inline chords, rapid hyphenated lyrics + melisma, Lyrics tab, Chords tab, Undo/Redo, Click-to-Seek, and Save Score", async () => {
    const startSpy = vi.spyOn(midiSynth, "start").mockImplementation(() => undefined);
    const saveSpy = vi.spyOn(api, "saveScore").mockImplementation(async (_id, data, ver, xml) => ({
      id: "score-1",
      project_id: "proj-e2e-1",
      version: (ver ?? 1) + 1,
      score_json: data,
      musicxml: xml ?? null,
      updated_at: new Date().toISOString(),
    }));

    renderStudioPage();

    // Wait for Measure 2 beat 1 note to render
    const m2Beat1 = await screen.findByTestId("studio-note-m2-o1000");

    // 1. Click-to-Seek in Studio: clicking Measure 2 beat 1 note seeks playhead to 2.0s while paused,
    //    and Spacebar starts midiSynth from 2.0s
    fireEvent.click(m2Beat1);
    await waitFor(() => expect(screen.getByText(/0:02/)).toBeInTheDocument());
    expect(startSpy).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { code: "Space", key: " " });
    expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({ fromSec: 2 }));
    // Stop playback so editing shortcuts are active
    fireEvent.keyDown(window, { code: "Space", key: " " });

    // 2. Rapid chord entry via Ctrl+K on Measure 1 beat 1 -> "F#m7" + Tab + "Amaj7/G#" + Enter
    const m1Beat1 = screen.getByTestId("studio-note-m1-o0");
    fireEvent.click(m1Beat1);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    const cInput1 = screen.getByTestId("inline-chord-input") as HTMLInputElement;
    fireEvent.change(cInput1, { target: { value: "F#m7" } });
    fireEvent.keyDown(cInput1, { key: "Tab" });

    const cInput2 = screen.getByTestId("inline-chord-input") as HTMLInputElement;
    fireEvent.change(cInput2, { target: { value: "Amaj7/G#" } });
    fireEvent.keyDown(cInput2, { key: "Enter" });
    expect(screen.queryByTestId("inline-chord-editor")).not.toBeInTheDocument();

    // Switch to Chords & Guitar Tab -> verify canonical scoreData.chords updated immediately
    fireEvent.click(screen.getByRole("tab", { name: /chords & guitar tab/i }));
    expect(screen.getByDisplayValue("F#m7")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Amaj7/G#")).toBeInTheDocument();

    // 3. Switch back to Sheet Music and test rapid inline lyric entry: A-maz-ing + grace_
    fireEvent.click(screen.getByRole("tab", { name: /sheet music/i }));
    const m1Note1 = await screen.findByTestId("studio-note-m1-o0");
    fireEvent.click(m1Note1);
    fireEvent.keyDown(window, { key: "l", ctrlKey: true });

    const l1 = screen.getByTestId("inline-lyric-input") as HTMLInputElement;
    fireEvent.change(l1, { target: { value: "A" } });
    fireEvent.keyDown(l1, { key: "-" });

    const l2 = screen.getByTestId("inline-lyric-input") as HTMLInputElement;
    fireEvent.change(l2, { target: { value: "maz" } });
    fireEvent.keyDown(l2, { key: "-" });

    const l3 = screen.getByTestId("inline-lyric-input") as HTMLInputElement;
    fireEvent.change(l3, { target: { value: "ing" } });
    fireEvent.keyDown(l3, { key: " ", code: "Space" });

    const l4 = screen.getByTestId("inline-lyric-input") as HTMLInputElement;
    fireEvent.change(l4, { target: { value: "grace" } });
    fireEvent.keyDown(l4, { key: "_", shiftKey: true });

    fireEvent.keyDown(screen.getByTestId("inline-lyric-input"), { key: "Escape" });

    // 4. Switch to Lyrics tab immediately (before Save Score) -> "Amazing grace" is live
    fireEvent.click(screen.getByRole("tab", { name: /^lyrics$/i }));
    const lyricsArea = (await screen.findByLabelText(/editable lyrics text/i)) as HTMLTextAreaElement;
    expect(lyricsArea.value).toBe("Amazing grace");

    // 5. Undo removes melisma word "grace", Redo brings it back atomically across Lyrics tab
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(((await screen.findByLabelText(/editable lyrics text/i)) as HTMLTextAreaElement).value).toBe("Amazing");
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(((await screen.findByLabelText(/editable lyrics text/i)) as HTMLTextAreaElement).value).toBe("Amazing grace");

    // 6. Save Score persists canonical chords, lyrics, <harmony>, <lyric>, and <extend> together
    fireEvent.click(screen.getByRole("button", { name: /save score/i }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalled());
    const lastCall = saveSpy.mock.calls[saveSpy.mock.calls.length - 1];
    const savedScore = lastCall[1];
    const savedXml = lastCall[3] || "";
    expect(savedScore.chords.map((c) => c.symbol)).toEqual(["F#m7", "Amaj7/G#"]);
    expect((savedScore.analysis.lyrics as { text: string }).text).toBe("Amazing grace");
    expect(savedXml).toContain('<root-step>F</root-step><root-alter>1</root-alter>');
    expect(savedXml).toContain('<syllabic>begin</syllabic><text>A</text>');
    expect(savedXml).toContain('<extend type="start"/>');
    expect(savedXml).toContain('<extend type="stop"/>');
  });
});
