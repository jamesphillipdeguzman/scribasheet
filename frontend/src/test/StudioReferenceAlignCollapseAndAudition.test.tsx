import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { midiSynth } from "@/features/editor/midiSynth";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { api } from "@/services/api";
import type { Project, ScoreData } from "@/types/api";

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
              currentStaveNote.setAttribute("data-testid", `osmd-stavenote-m${mNum}-n${nIdx}`);
              svg.appendChild(currentStaveNote);
              chordIdx = 0;
            } else {
              chordIdx += 1;
            }

            const nh = document.createElementNS("http://www.w3.org/2000/svg", "g");
            nh.setAttribute("class", "vf-notehead");
            nh.setAttribute("data-testid", `osmd-note-m${mNum}-n${nIdx}`);
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
      EngravingRules: { RenderChordSymbols: true },
    };
    return instance;
  },
}));

const AUDITION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>B</step><alter>-1</alter><octave>3</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><rest/><duration>4</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

function makeStudioScore(): ScoreData {
  return {
    title: "Alignment & Audition Test",
    tempo_bpm: 120,
    tempo_estimated: false,
    time_signature: "4/4",
    time_signature_estimated: false,
    key_signature: "C major",
    key_signature_estimated: false,
    duration_seconds: 2,
    tracks: [{ index: 0, name: "Piano", instrument: "piano", clef: "treble", program: 0, muted: false }],
    notes: [
      { id: "n1", pitch_midi: 66, onset_sec: 0, offset_sec: 0.5, velocity: 85, track_index: 0 },
    ],
    chords: [],
    analysis: { source_type: "midi_playground" },
  };
}

function makePlaygroundProject(): Project {
  return {
    id: "proj-align-test",
    user_id: "u1",
    title: "Alignment Playground",
    description: "",
    instrument: "piano",
    transcription_mode: "midi_playground",
    status: "ready",
    duration_seconds: 2,
    created_at: "2026-11-28T00:00:00Z",
    updated_at: "2026-11-28T00:00:00Z",
    media_assets: [],
  };
}

function renderStudio(projectId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[`/projects/${projectId}`]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("Reference Sheet Vertical Alignment, Left-Edge Collapse Rail & Notehead Click Audition", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    try {
      window.localStorage.clear();
    } catch {
      // Ignore restricted storage in test environments
    }

    vi.spyOn(api, "getLyrics").mockResolvedValue({ text: "", segments: [] } as never);
    vi.spyOn(api, "listExports").mockResolvedValue([]);
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 2,
      worker_id: "w-1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 30,
    });
    vi.spyOn(api, "getProject").mockResolvedValue(makePlaygroundProject());
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
    vi.spyOn(api, "getScore").mockResolvedValue({
      id: "score-align-1",
      project_id: "proj-align-test",
      version: 1,
      score_json: makeStudioScore(),
      musicxml: AUDITION_XML,
      updated_at: "2026-11-28T00:00:00Z",
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("places toolbars above the split at 100% width and aligns Reference Sheet directly beside the score canvas", async () => {
    renderStudio("proj-align-test");

    await waitFor(() => {
      expect(screen.getByTestId("toggle-reference-sheet-btn")).toBeInTheDocument();
      expect(screen.getByTestId("notation-edit-toolbar")).toBeInTheDocument();
      expect(screen.getByTestId("notation-midi-bar")).toBeInTheDocument();
      expect(screen.getByTestId("sheet-music-scroll-container")).toBeInTheDocument();
    });

    const midiBarBefore = screen.getByTestId("notation-midi-bar");
    const scrollCanvasBefore = screen.getByTestId("sheet-music-scroll-container");

    // Open Reference Sheet split
    fireEvent.click(screen.getByTestId("toggle-reference-sheet-btn"));

    const splitWorkspace = await screen.findByTestId("playground-split-workspace");
    const refPane = screen.getByTestId("reference-sheet-pane");
    const canvasPane = screen.getByTestId("studio-score-canvas-pane");
    const palette = screen.getByTestId("notation-edit-toolbar");
    const midiBar = screen.getByTestId("notation-midi-bar");
    const scrollCanvas = screen.getByTestId("sheet-music-scroll-container");

    // Toolbars MUST sit ABOVE and OUTSIDE playground-split-workspace (full width)
    expect(splitWorkspace.contains(palette)).toBe(false);
    expect(splitWorkspace.contains(midiBar)).toBe(false);
    expect(
      Boolean(
        midiBar.compareDocumentPosition(splitWorkspace) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    // Split workspace MUST contain ONLY Reference Sheet pane, divider, and score canvas pane
    expect(splitWorkspace.contains(refPane)).toBe(true);
    expect(splitWorkspace.contains(canvasPane)).toBe(true);
    expect(canvasPane.contains(scrollCanvas)).toBe(true);
    expect(within(refPane).getByTestId("reference-sheet-viewer")).toBeInTheDocument();

    // Neither toolbar nor score canvas unmounted across opening the split
    expect(midiBar).toBe(midiBarBefore);
    expect(scrollCanvas).toBe(scrollCanvasBefore);
  });

  it("synchronizes header & divider collapse handles into a ~28px left rail, preserves file/zoom/scrollTop/page, and restores split width", async () => {
    if (!URL.createObjectURL) {
      Object.defineProperty(URL, "createObjectURL", {
        writable: true,
        value: vi.fn(() => "blob:ref-align-image"),
      });
    } else {
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ref-align-image");
    }
    if (!URL.revokeObjectURL) {
      Object.defineProperty(URL, "revokeObjectURL", { writable: true, value: vi.fn() });
    } else {
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    }

    renderStudio("proj-align-test");
    await waitFor(() => {
      expect(screen.getByTestId("toggle-reference-sheet-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("toggle-reference-sheet-btn"));

    // Resize divider from 50% to 60% first
    const divider = await screen.findByTestId("reference-split-divider");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider).toHaveAttribute("aria-valuenow", "60");

    // Load a local image into ReferenceSheetViewer
    const fileInput = screen.getByTestId("reference-file-input") as HTMLInputElement;
    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const imageFile = new File([pngHeader], "etude-page-1.png", { type: "image/png" });
    Object.defineProperty(imageFile, "arrayBuffer", {
      value: async () => pngHeader.buffer,
    });
    fireEvent.change(fileInput, { target: { files: [imageFile] } });

    await waitFor(() => {
      expect(screen.getByTestId("reference-filename")).toHaveTextContent("etude-page-1.png");
      expect(screen.getByTestId("reference-image-preview")).toBeInTheDocument();
    });

    // Customize zoom, Fit Width, and scroll position before collapsing
    fireEvent.click(screen.getByTitle("Zoom In"));
    expect(screen.getByText("115%")).toBeInTheDocument();
    const scrollBox = screen.getByTestId("reference-image-scroll");
    Object.defineProperty(scrollBox, "scrollTop", { value: 185, writable: true });

    const resizeSpy = vi.spyOn(window, "dispatchEvent");
    const canvasBeforeCollapse = screen.getByTestId("sheet-music-scroll-container");

    // 1. Collapse via the ReferenceSheetViewer header button («)
    fireEvent.click(screen.getByTestId("reference-collapse-btn"));

    const refPane = screen.getByTestId("reference-sheet-pane");
    expect(refPane).toHaveAttribute("data-collapsed", "true");
    expect(refPane.className).toContain("lg:w-[28px]");
    expect(screen.queryByTestId("reference-split-divider")).not.toBeInTheDocument();
    const collapsedRail = screen.getByTestId("reference-collapsed-rail");
    expect(collapsedRail).toHaveTextContent("Reference");
    expect(screen.getByTestId("sheet-music-scroll-container")).toBe(canvasBeforeCollapse);

    // 2. Expand via the ~28px collapsed rail (› Reference)
    fireEvent.click(collapsedRail);

    expect(refPane).toHaveAttribute("data-collapsed", "false");
    expect(refPane.style.getPropertyValue("--ref-split-pct")).toBe("60%");
    const restoredDivider = screen.getByTestId("reference-split-divider");
    expect(restoredDivider).toHaveAttribute("aria-valuenow", "60");

    // Loaded file, zoom, and scrollTop MUST be preserved without resetting
    expect(screen.getByTestId("reference-filename")).toHaveTextContent("etude-page-1.png");
    expect(screen.getByText("115%")).toBeInTheDocument();
    expect(screen.getByTestId("reference-image-scroll").scrollTop).toBe(185);

    // 3. Collapse via the synchronized divider toggle button (‹)
    fireEvent.click(screen.getByTestId("reference-divider-toggle-btn"));
    expect(refPane).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByTestId("reference-collapsed-rail")).toBeInTheDocument();

    // Verify layout resize signal was emitted (dispatched via rAF / transition end)
    await waitFor(() => {
      expect(
        resizeSpy.mock.calls.some(([ev]) => ev instanceof Event && ev.type === "resize"),
      ).toBe(true);
    });
  });

  it("auditions pitched noteheads immediately on click (exact octave & accidental), supports chords, skips rests/blank areas, and skips after drag", async () => {
    const auditionSpy = vi.spyOn(midiSynth, "auditionNotes").mockImplementation(() => {});
    const onSeek = vi.fn();
    const onMusicXmlChange = vi.fn();

    render(
      <SheetMusicViewer
        musicxml={AUDITION_XML}
        tempoBpm={120}
        onSeek={onSeek}
        onMusicXmlChange={onMusicXmlChange}
        defaultEditMode={true}
        defaultEngine="osmd"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("osmd-note-m1-n0")).toBeInTheDocument();
    });

    // Click F#4 (MIDI 66) -> auditioned once with [66]
    fireEvent.click(screen.getByTestId("osmd-note-m1-n0"), { clientX: 60, clientY: 110 });
    expect(auditionSpy).toHaveBeenCalledTimes(1);
    expect(auditionSpy).toHaveBeenLastCalledWith([66]);
    expect(onSeek).toHaveBeenCalledTimes(1);

    // Click Bb3 (MIDI 58) -> auditioned once with [58]
    fireEvent.click(screen.getByTestId("osmd-note-m1-n1"), { clientX: 108, clientY: 110 });
    expect(auditionSpy).toHaveBeenCalledTimes(2);
    expect(auditionSpy).toHaveBeenLastCalledWith([58]);

    // Click specific upper chord tone E5 (MIDI 76)
    fireEvent.click(screen.getByTestId("osmd-note-m1-n3"), { clientX: 204, clientY: 94 });
    expect(auditionSpy).toHaveBeenCalledTimes(3);
    expect(auditionSpy).toHaveBeenLastCalledWith([76]);

    // Click shared vf-stavenote chord group container (stem/group) -> auditions full chord [72, 76]
    fireEvent.click(screen.getByTestId("osmd-stavenote-m1-n2"), { clientX: 156, clientY: 50 });
    expect(auditionSpy).toHaveBeenCalledTimes(4);
    expect(auditionSpy).toHaveBeenLastCalledWith([72, 76]);

    // Click Rest (m1-n4) -> must NOT audition
    const callsBeforeRest = auditionSpy.mock.calls.length;
    fireEvent.click(screen.getByTestId("osmd-note-m1-n4"), { clientX: 252, clientY: 110 });
    expect(auditionSpy).toHaveBeenCalledTimes(callsBeforeRest);

    // Click empty measure background -> seeks measure, must NOT audition
    fireEvent.click(screen.getByTestId("mock-osmd-svg"), { clientX: 300, clientY: 50 });
    expect(auditionSpy).toHaveBeenCalledTimes(callsBeforeRest);

    // Drag a notehead (pointerdown -> vertical move -> pointerup -> trailing click) -> no extra click audition
    const firstNote = screen.getByTestId("osmd-note-m1-n0");
    const makePointerEvt = (type: string, clientX: number, clientY: number) => {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 });
      Object.defineProperty(ev, "pointerId", { value: 1 });
      return ev;
    };
    fireEvent(firstNote, makePointerEvt("pointerdown", 60, 110));
    fireEvent(firstNote, makePointerEvt("pointermove", 60, 95));
    fireEvent(firstNote, makePointerEvt("pointerup", 60, 95));
    fireEvent.click(firstNote, { clientX: 60, clientY: 95 });
    expect(auditionSpy).toHaveBeenCalledTimes(callsBeforeRest);
    // Confirm the drag committed rather than aborting
    expect(onMusicXmlChange).toHaveBeenCalled();

    // Keyboard A-G note entry in Note Input mode reuses the same auditionNotes helper
    fireEvent.click(screen.getByRole("button", { name: /Note Input/i }));
    const scrollContainer = screen.getByTestId("sheet-music-scroll-container");
    fireEvent.keyDown(scrollContainer, { key: "g" });
    expect(auditionSpy).toHaveBeenCalledTimes(callsBeforeRest + 1);
  });

  it("resumes suspended AudioContext inside user click, triggers audition once on resolve, and degrades safely on Web Audio failure", async () => {
    let ctxState: AudioContextState = "suspended";
    let resolveResume!: () => void;
    const resumeSpy = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveResume = () => {
            ctxState = "running";
            res();
          };
        }),
    );

    const mockGain = {
      gain: {
        value: 1,
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    const mockCtx = {
      get state() {
        return ctxState;
      },
      currentTime: 0,
      sampleRate: 44100,
      destination: {},
      resume: resumeSpy,
      createGain: vi.fn(() => ({ ...mockGain, gain: { ...mockGain.gain } })),
      createOscillator: vi.fn(() => ({
        type: "triangle",
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      })),
      createBiquadFilter: vi.fn(() => ({
        type: "lowpass",
        frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      })),
      createBuffer: vi.fn(() => ({ getChannelData: vi.fn(() => new Float32Array(128)) })),
      createBufferSource: vi.fn(() => ({ buffer: null, connect: vi.fn(), start: vi.fn() })),
    };

    const origAudioContext = window.AudioContext;
    const triggerSpy = vi.spyOn(midiSynth, "triggerNote");

    try {
      // Point internal ctx to our controlled suspended AudioContext
      Object.defineProperty(window, "AudioContext", {
        writable: true,
        configurable: true,
        value: function MockAudioContext() {
          return mockCtx;
        },
      });
      (midiSynth as unknown as { ctx: unknown; dryGain: unknown }).ctx = mockCtx;
      (midiSynth as unknown as { dryGain: unknown }).dryGain = null;

      midiSynth.auditionNotes([66]);

      // Resume called synchronously inside gesture; note NOT triggered yet before resume resolves
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(triggerSpy).not.toHaveBeenCalled();

      resolveResume();
      await waitFor(() => {
        expect(triggerSpy).toHaveBeenCalledTimes(1);
        expect(triggerSpy).toHaveBeenCalledWith(66, 0.25, 84, 0.7, 0, 0);
      });

      // Audio failure must NOT break note selection or seek
      triggerSpy.mockImplementationOnce(() => {
        throw new Error("Audio hardware unavailable");
      });
      const onSeek = vi.fn();
      const onMusicXmlChange = vi.fn();
      render(
        <SheetMusicViewer
          musicxml={AUDITION_XML}
          tempoBpm={120}
          onSeek={onSeek}
          onMusicXmlChange={onMusicXmlChange}
          defaultEditMode={true}
          defaultEngine="osmd"
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("osmd-note-m1-n0")).toBeInTheDocument();
      });

      expect(() => {
        fireEvent.click(screen.getByTestId("osmd-note-m1-n0"), { clientX: 60, clientY: 110 });
      }).not.toThrow();
      expect(onSeek).toHaveBeenCalledTimes(1);
    } finally {
      (midiSynth as unknown as { ctx: unknown; dryGain: unknown }).ctx = null;
      (midiSynth as unknown as { dryGain: unknown }).dryGain = null;
      Object.defineProperty(window, "AudioContext", {
        writable: true,
        configurable: true,
        value: origAudioContext,
      });
    }
  });
});
