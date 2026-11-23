import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  samplerInstances,
  samplerStartSpy,
  oscStartSpy,
  mockOsmdState,
} = vi.hoisted(() => {
  const instances: Array<{
    resolveLoad: () => void;
    rejectLoad: (err?: unknown) => void;
    load: Promise<unknown>;
    start: ReturnType<typeof vi.fn>;
  }> = [];

  const startSpy = vi.fn((_opts?: { note?: number }) => () => undefined);
  const oscSpy = vi.fn();

  const osmdState = {
    steps: [] as Array<{
      realValue: number;
      measureNumber: number;
      measureAbsReal?: number;
      durationReal: number;
      num: number;
      den: number;
      isRest?: boolean;
      offsetLeft: number;
    }>,
    measureList: [] as unknown[],
    idx: 0,
    cursorEl: document.createElement("img"),
  };

  return {
    samplerInstances: instances,
    samplerStartSpy: startSpy,
    oscStartSpy: oscSpy,
    mockOsmdState: osmdState,
  };
});

vi.mock("smplr", () => ({
  SplendidGrandPiano: function MockSplendidGrandPiano() {
    let resolveLoad!: (v?: unknown) => void;
    let rejectLoad!: (e?: unknown) => void;
    const load = new Promise((res, rej) => {
      resolveLoad = res;
      rejectLoad = rej;
    });
    const inst = {
      load,
      resolveLoad: () => resolveLoad(inst),
      rejectLoad: (e?: unknown) => rejectLoad(e ?? new Error("load failed")),
      start: samplerStartSpy,
    };
    samplerInstances.push(inst);
    return inst;
  },
  Soundfont: function MockSoundfont() {
    return {
      load: Promise.resolve({}),
      start: vi.fn(() => () => undefined),
    };
  },
}));

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: function MockOpenSheetMusicDisplay() {
    return {
      load: async () => undefined,
      render: () => undefined,
      Dispose: () => undefined,
      Zoom: 1,
      EngravingRules: { RenderChordSymbols: true },
      cursor: {
        cursorElement: mockOsmdState.cursorEl,
        show: () => undefined,
        hide: () => undefined,
        reset: () => {
          mockOsmdState.idx = 0;
        },
        next: () => {
          mockOsmdState.idx = Math.min(mockOsmdState.idx + 1, mockOsmdState.steps.length);
        },
        previous: () => {
          mockOsmdState.idx = Math.max(mockOsmdState.idx - 1, 0);
        },
        update: () => {
          const cur = mockOsmdState.steps[mockOsmdState.idx];
          if (cur) {
            Object.defineProperty(mockOsmdState.cursorEl, "offsetLeft", {
              value: cur.offsetLeft,
              configurable: true,
            });
          }
        },
        GNotesUnderCursor: () => [],
        NotesUnderCursor: () => {
          const cur = mockOsmdState.steps[mockOsmdState.idx];
          return cur ? [{ isRest: () => Boolean(cur.isRest) }] : [];
        },
        iterator: {
          get EndReached() {
            return mockOsmdState.idx >= mockOsmdState.steps.length;
          },
          get CurrentMeasureIndex() {
            const cur = mockOsmdState.steps[mockOsmdState.idx];
            if (!cur) return 0;
            const seen = new Set<number>();
            for (let i = 0; i <= mockOsmdState.idx; i++) {
              seen.add(mockOsmdState.steps[i].measureNumber);
            }
            return Math.max(0, seen.size - 1);
          },
          get currentTimeStamp() {
            const cur = mockOsmdState.steps[mockOsmdState.idx];
            return { RealValue: cur ? cur.realValue : 0 };
          },
          get CurrentMeasure() {
            const cur = mockOsmdState.steps[mockOsmdState.idx];
            if (!cur) return undefined;
            return {
              MeasureNumber: cur.measureNumber,
              AbsoluteTimestamp: { RealValue: cur.measureAbsReal ?? (cur.measureNumber === 0 ? 0 : cur.measureNumber) },
              Duration: { RealValue: cur.durationReal },
              ActiveTimeSignature: { Numerator: cur.num, Denominator: cur.den },
            };
          },
        },
      },
      GraphicSheet: {
        get MeasureList() {
          return mockOsmdState.measureList;
        },
      },
    };
  },
}));

import { MidiSynthesizer, midiSynth } from "@/features/editor/midiSynth";
import { PianoRollEditor } from "@/features/editor/PianoRollEditor";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";
import { WaveformPlayer } from "@/features/editor/WaveformPlayer";
import { metronomeEngine } from "@/features/editor/metronome";
import type { ScoreNote, ScoreTrack } from "@/types/api";

function installMockAudio(initialState: AudioContextState = "suspended") {
  const resumeSpy = vi.fn(function (this: { state: AudioContextState }) {
    this.state = "running";
    return Promise.resolve();
  });

  class MockAudioContext {
    public currentTime = 0;
    public sampleRate = 44100;
    public state: AudioContextState = initialState;
    public destination = {};
    public resume = resumeSpy;
    public createGain() {
      return {
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };
    }
    public createOscillator() {
      return {
        type: "triangle",
        frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: oscStartSpy,
        stop: vi.fn(),
        onended: null,
      };
    }
    public createBiquadFilter() {
      return {
        type: "lowpass",
        frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        Q: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
      };
    }
    public createBuffer(_ch: number, len: number) {
      return { getChannelData: () => new Float32Array(len) };
    }
    public createBufferSource() {
      return { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    }
  }

  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    writable: true,
    value: MockAudioContext,
  });

  return { resumeSpy };
}

const sampleNotes: ScoreNote[] = [
  { id: "pickup", pitch_midi: 67, onset_sec: 0.0, offset_sec: 0.5, velocity: 90, track_index: 0 },
  { id: "m1_b1", pitch_midi: 72, onset_sec: 0.5, offset_sec: 1.0, velocity: 90, track_index: 0 },
];

const sampleTracks: ScoreTrack[] = [
  { index: 0, name: "Soprano", instrument: "piano", clef: "treble", program: 0, muted: false },
];

describe("Piano Sampler Preloading, Pickup Timing & Spacebar Playback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    samplerInstances.length = 0;
    samplerStartSpy.mockClear();
    oscStartSpy.mockClear();
    metronomeEngine.stop();
    vi.stubGlobal("fetch", vi.fn());
    Object.defineProperty(mockOsmdState.cursorEl, "offsetTop", { value: 20, configurable: true });
    Object.defineProperty(mockOsmdState.cursorEl, "offsetHeight", { value: 100, configurable: true });
    Object.defineProperty(mockOsmdState.cursorEl, "offsetLeft", { value: 40, configurable: true });
  });

  afterEach(() => {
    midiSynth.stop();
    metronomeEngine.stop();
  });

  it("preloads Acoustic Grand Piano on mount, resumes AudioContext on gesture, and awaits readiness before first note", async () => {
    const { resumeSpy } = installMockAudio("suspended");
    const synth = new MidiSynthesizer();

    // 1. Preload on mount creates SplendidGrandPiano before Play is clicked
    synth.preloadPiano();
    expect(samplerInstances).toHaveLength(1);
    expect(synth.isPianoReady()).toBe(false);

    // 2. First user gesture resumes suspended AudioContext
    fireEvent.pointerDown(window);
    await waitFor(() => {
      expect(resumeSpy).toHaveBeenCalled();
    });

    // 3. Start playback before sampler resolves -> waits for loaded(), never starts clock or oscillators early
    let rafCb: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCb = cb;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => { });

    const startPromise = synth.start({
      notes: sampleNotes,
      fromSec: 0,
      durationSec: 2,
      tempoBpm: 120,
      playbackRate: 1,
      volume: 0.8,
      loop: false,
      metronome: false,
      onPosition: vi.fn(),
      onEnd: vi.fn(),
    });

    expect(synth.getPlaybackClock().isPlaying).toBe(false);
    expect(oscStartSpy).not.toHaveBeenCalled();

    // Resolve sampler load -> playback starts with sampled piano for the pickup note
    await act(async () => {
      samplerInstances[0].resolveLoad();
      await startPromise;
    });

    expect(synth.isPianoReady()).toBe(true);
    expect(synth.getPlaybackClock().isPlaying).toBe(true);

    // Trigger first animation frame to schedule pickup note at 0.0s
    act(() => {
      rafCb?.(performance.now());
    });
    expect(samplerStartSpy).toHaveBeenCalledTimes(1);
    expect(samplerStartSpy.mock.calls[0]?.[0]?.note).toBe(67);
    expect(oscStartSpy).not.toHaveBeenCalled();
    synth.stop();
  });

  it("never switches from oscillator fallback to piano mid-playback if sampler fails to load", async () => {
    installMockAudio("running");
    const synth = new MidiSynthesizer();
    synth.preloadPiano();

    let rafCb: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCb = cb;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => { });

    await act(async () => {
      samplerInstances[0].rejectLoad(new Error("network offline"));
      await synth.start({
        notes: sampleNotes,
        fromSec: 0,
        durationSec: 2,
        tempoBpm: 120,
        playbackRate: 1,
        volume: 0.8,
        loop: false,
        metronome: false,
        onPosition: vi.fn(),
        onEnd: vi.fn(),
      });
    });

    act(() => {
      rafCb?.(performance.now());
    });
    expect(oscStartSpy).toHaveBeenCalled();
    expect(samplerStartSpy).not.toHaveBeenCalled();
    synth.stop();
  });

  it("removes OSMD phantom padding in implicit Measure 0 pickup bars and keeps normal measures accurate", async () => {
    const pickupXml = `<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
    <measure number="1">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

    // OSMD pads Measure 0 (0.25 whole note) to a full 4/4 bar (1.0), so Measure 1 starts at RealValue 1.0
    mockOsmdState.steps = [
      { realValue: 0.0, measureNumber: 0, durationReal: 0.25, num: 4, den: 4, offsetLeft: 50 },
      { realValue: 1.0, measureNumber: 1, durationReal: 1.0, num: 4, den: 4, offsetLeft: 160 },
      { realValue: 2.0, measureNumber: 2, durationReal: 1.0, num: 4, den: 4, offsetLeft: 280 },
    ];

    // At 120 BPM, pickup quarter note = 0.5s, so Measure 1 downbeat occurs at 0.5s
    const { rerender } = render(
      <SheetMusicViewer
        musicxml={pickupXml}
        playheadSec={0}
        isPlaying={false}
        tempoBpm={120}
        tracks={sampleTracks}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("sheet-music-playhead")).toBeInTheDocument();
    });
    expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "50px" });

    rerender(
      <SheetMusicViewer
        musicxml={pickupXml}
        playheadSec={0.5}
        isPlaying={false}
        tempoBpm={120}
        tracks={sampleTracks}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "160px" });
    });

    // Normal measure without pickup: Measure 1 at 0.0s, Measure 2 at 2.0s (4 beats @ 120 BPM)
    const normalXml = `<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

    mockOsmdState.steps = [
      { realValue: 0.0, measureNumber: 1, durationReal: 1.0, num: 4, den: 4, offsetLeft: 60 },
      { realValue: 1.0, measureNumber: 2, durationReal: 1.0, num: 4, den: 4, offsetLeft: 190 },
    ];

    rerender(
      <SheetMusicViewer
        musicxml={normalXml}
        playheadSec={2.0}
        isPlaying={false}
        tempoBpm={120}
        tracks={sampleTracks}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "190px" });
    });

    // Passing note at beat 2 (0.75s with 0.5s pickup) + rest/tie does not shift timeline
    mockOsmdState.steps = [
      { realValue: 0.0, measureNumber: 0, durationReal: 0.25, num: 4, den: 4, offsetLeft: 50 },
      { realValue: 1.0, measureNumber: 1, durationReal: 1.0, num: 4, den: 4, offsetLeft: 160 },
      { realValue: 1.25, measureNumber: 1, durationReal: 1.0, num: 4, den: 4, offsetLeft: 210 },
      { realValue: 1.5, measureNumber: 1, durationReal: 1.0, num: 4, den: 4, isRest: true, offsetLeft: 240 },
    ];
    rerender(
      <SheetMusicViewer
        musicxml={pickupXml}
        notes={[
          { id: "p0", pitch_midi: 67, onset_sec: 0.0, offset_sec: 0.5, velocity: 90, track_index: 0 },
          { id: "m1_1", pitch_midi: 72, onset_sec: 0.5, offset_sec: 1.0, velocity: 90, track_index: 0 },
          { id: "m1_pass", pitch_midi: 71, onset_sec: 1.0, offset_sec: 1.5, velocity: 80, track_index: 1 },
        ]}
        playheadSec={1.0}
        isPlaying={false}
        tempoBpm={120}
        tracks={sampleTracks}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "210px" });
    });
  });

  it("toggles Play/Stop via global Spacebar across Grid, Cascade, Sheet Music, and Focus Mode while ignoring typing fields", async () => {
    installMockAudio("running");
    vi.spyOn(midiSynth, "needsSamplerWait").mockReturnValue(false);
    const synthStartSpy = vi.spyOn(midiSynth, "start").mockResolvedValue(undefined);
    const synthStopSpy = vi.spyOn(midiSynth, "stop").mockImplementation(() => { });

    function StudioHarness() {
      const [isPlaying, setIsPlaying] = useState(false);
      const [playheadSec, setPlayheadSec] = useState(0);
      const [toggleSignal, setToggleSignal] = useState(0);
      return (
        <div>
          <input aria-label="Test text input" />
          <textarea aria-label="Test textarea" />
          <div contentEditable={true} data-testid="editable-box" />
          <WaveformPlayer
            mediaAssetId={null}
            isScoreOnly={true}
            notes={sampleNotes}
            durationSeconds={4}
            tempoBpm={120}
            timeSignature="4/4"
            playheadSec={playheadSec}
            onPlayheadChange={setPlayheadSec}
            onPlayingChange={setIsPlaying}
            externalToggleSignal={toggleSignal}
          />
          <PianoRollEditor
            notes={sampleNotes}
            tracks={sampleTracks}
            durationSeconds={4}
            tempoBpm={120}
            timeSignature="4/4"
            playheadSec={playheadSec}
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onChangeNotes={vi.fn()}
            onPlayheadChange={setPlayheadSec}
            isPlaying={isPlaying}
            onTogglePlay={() => setToggleSignal((n) => n + 1)}
            musicxml="<score-partwise><part id='P1'><measure number='1'><note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration></note></measure></part></score-partwise>"
          />
        </div>
      );
    }

    render(<StudioHarness />);

    // Transport button has Play / Stop (Space) tooltip
    expect(screen.getByRole("button", { name: "Play" })).toHaveAttribute("title", "Play / Stop (Space)");

    // Repeated Space keydown is ignored
    fireEvent.keyDown(window, { code: "Space", key: " ", repeat: true });
    expect(synthStartSpy).not.toHaveBeenCalled();

    // Typing contexts are ignored
    fireEvent.keyDown(screen.getByLabelText("Test text input"), { code: "Space", key: " " });
    fireEvent.keyDown(screen.getByLabelText("Test textarea"), { code: "Space", key: " " });
    fireEvent.keyDown(screen.getByTestId("editable-box"), { code: "Space", key: " " });
    fireEvent.keyDown(screen.getByLabelText("Playback speed"), { code: "Space", key: " " });
    expect(synthStartSpy).not.toHaveBeenCalled();

    // Spacebar starts playback in Grid Editor and calls preventDefault()
    const spaceEvt = new KeyboardEvent("keydown", { code: "Space", key: " ", cancelable: true });
    window.dispatchEvent(spaceEvt);
    expect(spaceEvt.defaultPrevented).toBe(true);
    await waitFor(() => expect(synthStartSpy).toHaveBeenCalledTimes(1));

    // Spacebar stops playback
    fireEvent.keyDown(window, { code: "Space", key: " " });
    await waitFor(() => expect(synthStopSpy).toHaveBeenCalled());

    // Switch to Practice Cascade -> tooltip present & Spacebar toggles playback
    fireEvent.click(screen.getByRole("button", { name: "Practice Cascade" }));
    expect(screen.getByRole("button", { name: "Play cascade" })).toHaveAttribute("title", "Play / Stop (Space)");
    fireEvent.keyDown(window, { code: "Space", key: " " });
    await waitFor(() => expect(synthStartSpy).toHaveBeenCalledTimes(2));

    // Enter Focus Mode and switch to Sheet Music -> tooltip present & Spacebar stops playback
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    fireEvent.click(screen.getByRole("button", { name: "Sheet Music" }));
    expect(screen.getByRole("button", { name: "Pause sheet music" })).toHaveAttribute(
      "title",
      "Play / Stop (Space)",
    );
    const stopCountBefore = synthStopSpy.mock.calls.length;
    fireEvent.keyDown(window, { code: "Space", key: " " });
    await waitFor(() => expect(synthStopSpy.mock.calls.length).toBeGreaterThan(stopCountBefore));
  });

  it("initializes playhead immediately at t=0 and keeps rAF uninterrupted across Play, Pause, Resume, Seek, Stop, and tempo changes", async () => {
    const pickupXml = `<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
    <measure number="1">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

    mockOsmdState.steps = [
      { realValue: 0.0, measureNumber: 0, durationReal: 0.25, num: 4, den: 4, offsetLeft: 50 },
      { realValue: 1.0, measureNumber: 1, durationReal: 1.0, num: 4, den: 4, offsetLeft: 160 },
    ];

    let clockSec = 0;
    let clockPlaying = false;
    vi.spyOn(midiSynth, "getPlaybackClock").mockImplementation(() => ({
      isPlaying: clockPlaying,
      currentSec: clockSec,
    }));

    const rafCallbacks: FrameRequestCallback[] = [];
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => { });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });

    const { rerender } = render(
      <SheetMusicViewer
        musicxml={pickupXml}
        playheadSec={0}
        isPlaying={false}
        tempoBpm={120}
        tracks={sampleTracks}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "50px" });
    });

    // Play starts at t=0 -> immediate initialization & rAF starts
    clockPlaying = true;
    clockSec = 0;
    rerender(
      <SheetMusicViewer
        musicxml={pickupXml}
        playheadSec={0}
        isPlaying={true}
        tempoBpm={120}
        tracks={sampleTracks}
      />,
    );
    expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "50px" });

    // Even as playheadSec updates on every React render, rAF is NOT cancelled/restarted
    const cancelCountAfterStart = cancelSpy.mock.calls.length;
    clockSec = 0.5;
    rerender(
      <SheetMusicViewer
        musicxml={pickupXml}
        playheadSec={0.5}
        isPlaying={true}
        tempoBpm={120}
        tracks={sampleTracks}
      />,
    );
    expect(cancelSpy.mock.calls.length).toBe(cancelCountAfterStart);

    // Next rAF tick immediately moves playhead to Measure 1 downbeat (160px)
    act(() => {
      const cb = rafCallbacks[rafCallbacks.length - 1];
      cb?.(performance.now());
    });
    expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "160px" });

    // Pause -> Stop/Seek back to 0 -> playhead returns immediately to 50px
    clockPlaying = false;
    clockSec = 0;
    rerender(
      <SheetMusicViewer
        musicxml={pickupXml}
        playheadSec={0}
        isPlaying={false}
        tempoBpm={60}
        tracks={sampleTracks}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "50px" });
    });

    // Tempo change to 60 BPM: Measure 1 downbeat now occurs at 1.0s (instead of 0.5s)
    rerender(
      <SheetMusicViewer
        musicxml={pickupXml}
        playheadSec={0.5}
        isPlaying={false}
        tempoBpm={60}
        tracks={sampleTracks}
      />,
    );
    expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "50px" });
    rerender(
      <SheetMusicViewer
        musicxml={pickupXml}
        playheadSec={1.0}
        isPlaying={false}
        tempoBpm={60}
        tracks={sampleTracks}
      />,
    );
    expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "160px" });
  });

  it("removes OSMD 3-beat right-aligned pickup lead-in at 68 BPM and normalizes leading rests in 3/4", async () => {
    const pickup68Xml = `<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type></note>
    </measure>
    <measure number="1">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>half</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;

    // Simulate OSMD right-aligning 1-beat pickup in Measure 0: rawReal=0.75, 0.875 while AbsoluteTimestamp=0.0
    mockOsmdState.steps = [
      { realValue: 0.75, measureNumber: 0, measureAbsReal: 0.0, durationReal: 0.25, num: 4, den: 4, offsetLeft: 55 },
      { realValue: 0.875, measureNumber: 0, measureAbsReal: 0.0, durationReal: 0.25, num: 4, den: 4, offsetLeft: 95 },
      { realValue: 1.0, measureNumber: 1, measureAbsReal: 1.0, durationReal: 1.0, num: 4, den: 4, offsetLeft: 170 },
      { realValue: 1.5, measureNumber: 1, measureAbsReal: 1.0, durationReal: 1.0, num: 4, den: 4, offsetLeft: 250 },
    ];

    const { rerender } = render(
      <SheetMusicViewer
        musicxml={pickup68Xml}
        playheadSec={0}
        isPlaying={true}
        tempoBpm={68}
        tracks={sampleTracks}
      />,
    );

    // At t=0.0s, cursor starts immediately at first pickup eighth note (55px), NOT frozen for 2.6471s
    await waitFor(() => {
      expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "55px" });
    });

    // At t=0.45s (after 1 eighth note @ 68 BPM = 0.4412s), cursor moves to second pickup eighth note (95px)
    rerender(
      <SheetMusicViewer
        musicxml={pickup68Xml}
        playheadSec={0.45}
        isPlaying={false}
        tempoBpm={68}
        tracks={sampleTracks}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "95px" });
    });

    // At t=0.90s (after 1 beat @ 68 BPM = 0.8824s), cursor enters Measure 1 downbeat (170px)
    rerender(
      <SheetMusicViewer
        musicxml={pickup68Xml}
        playheadSec={0.9}
        isPlaying={false}
        tempoBpm={68}
        tracks={sampleTracks}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "170px" });
    });

    // 3/4 score with a leading quarter rest before the first sounding note
    const waltzRestXml = `<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><rest/><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;

    mockOsmdState.steps = [
      { realValue: 0.0, measureNumber: 1, measureAbsReal: 0.0, durationReal: 0.75, num: 3, den: 4, isRest: true, offsetLeft: 40 },
      { realValue: 0.25, measureNumber: 1, measureAbsReal: 0.0, durationReal: 0.75, num: 3, den: 4, isRest: false, offsetLeft: 120 },
    ];

    rerender(
      <SheetMusicViewer
        musicxml={waltzRestXml}
        playheadSec={0}
        isPlaying={false}
        tempoBpm={120}
        tracks={sampleTracks}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "120px" });
    });
  });

  it("interpolates playhead smoothly between consecutive musical timestamps during rAF regardless of wide measure spacing", async () => {
    const wideMeasureXml = `<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="8">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
    <measure number="9">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

    // Measure 9 is rendered very wide (left: 100px -> 500px), but musical duration is 2.0s @ 120 BPM
    mockOsmdState.steps = [
      { realValue: 0.0, measureNumber: 8, measureAbsReal: 0.0, durationReal: 1.0, num: 4, den: 4, offsetLeft: 100 },
      { realValue: 1.0, measureNumber: 9, measureAbsReal: 1.0, durationReal: 1.0, num: 4, den: 4, offsetLeft: 500 },
    ];

    let clockSec = 0;
    let clockPlaying = false;
    vi.spyOn(midiSynth, "getPlaybackClock").mockImplementation(() => ({
      isPlaying: clockPlaying,
      currentSec: clockSec,
    }));

    const rafCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => { });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });

    const { rerender } = render(
      <SheetMusicViewer
        musicxml={wideMeasureXml}
        playheadSec={0}
        isPlaying={false}
        tempoBpm={120}
        tracks={sampleTracks}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "100px" });
    });

    clockPlaying = true;
    clockSec = 0;
    rerender(
      <SheetMusicViewer
        musicxml={wideMeasureXml}
        playheadSec={0}
        isPlaying={true}
        tempoBpm={120}
        tracks={sampleTracks}
      />,
    );
    expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "100px" });

    // Halfway through Measure 8 in musical time (1.0s of 2.0s) -> playhead interpolates halfway (300px)
    clockSec = 1.0;
    act(() => {
      rafCallbacks[rafCallbacks.length - 1]?.(performance.now());
    });
    expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "300px" });

    // At Measure 9 downbeat (2.0s) -> playhead arrives at 500px
    clockSec = 2.0;
    act(() => {
      rafCallbacks[rafCallbacks.length - 1]?.(performance.now());
    });
    expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "500px" });
  });

  it("drives both SATB notehead highlights and vertical playhead from canonical active notes across pickup, Measure 1, simultaneous SATB, rests, and system wraps", async () => {
    const makeSvgNote = (leftX: number) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill", "#000000");
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.appendChild(path);
      g.getBoundingClientRect = () =>
        ({ left: leftX, right: leftX + 12, top: 20, bottom: 30, width: 12, height: 10, x: leftX, y: 20, toJSON: () => ({}) }) as DOMRect;
      return { g, path };
    };

    const pickupSop = makeSvgNote(60);
    const m1Sop = makeSvgNote(180);
    const m1Bass = makeSvgNote(182);
    const m2Sop = makeSvgNote(320);

    // Override GraphicSheet.MeasureList for this test via a local XML and spy
    const pickupXml = `<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Bass</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
    <measure number="1">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>3</duration><type>half</type><dot/></note>
    </measure>
    <measure number="2">
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>3</duration><type>half</type><dot/></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="0" implicit="yes">
      <attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><rest/><duration>1</duration><type>quarter</type></note>
    </measure>
    <measure number="1">
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>3</duration><type>half</type><dot/></note>
    </measure>
    <measure number="2">
      <note><rest/><duration>3</duration><type>half</type><dot/></note>
    </measure>
  </part>
</score-partwise>`;

    const satb2Tracks: ScoreTrack[] = [
      { index: 0, name: "Soprano", instrument: "piano", clef: "treble", program: 0, muted: false },
      { index: 1, name: "Bass", instrument: "piano", clef: "bass", program: 0, muted: false },
    ];
    const satbNotes: ScoreNote[] = [
      { id: "n_p0", pitch_midi: 67, onset_sec: 0.0, offset_sec: 0.5, velocity: 90, track_index: 0 },
      { id: "n_m1_s", pitch_midi: 72, onset_sec: 0.5, offset_sec: 2.0, velocity: 90, track_index: 0 },
      { id: "n_m1_b", pitch_midi: 48, onset_sec: 0.5, offset_sec: 2.0, velocity: 90, track_index: 1 },
      { id: "n_m2_s", pitch_midi: 76, onset_sec: 2.0, offset_sec: 3.5, velocity: 90, track_index: 0 },
    ];

    // Attach MeasureList onto the mocked OSMD instance by spying on container getBoundingClientRect
    const origGetBCR = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (
        this.className?.includes?.("relative min-w-") ||
        this.parentElement?.className?.includes?.("relative min-w-")
      ) {
        return { left: 0, right: 800, top: 0, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return origGetBCR.call(this);
    });

    mockOsmdState.measureList = [
      [
        {
          MeasureNumber: 0,
          parentSourceMeasure: { MeasureNumber: 0, AbsoluteTimestamp: { RealValue: 0 } },
          ParentMusicSystem: { Id: 0, PositionAndShape: { AbsolutePosition: { y: 2 }, Size: { height: 14 } } },
          staffEntries: [
            {
              getAbsoluteTimestamp: () => ({ RealValue: 0.75 }), // Right-aligned pickup in OSMD
              graphicalVoiceEntries: [{ notes: [{ getSVGGElement: () => pickupSop.g, sourceNote: { Pitch: { halfTone: 55 }, isRest: () => false } }] }],
            },
          ],
        },
      ],
      [
        {
          MeasureNumber: 1,
          parentSourceMeasure: { MeasureNumber: 1, AbsoluteTimestamp: { RealValue: 1.0 } },
          ParentMusicSystem: { Id: 0, PositionAndShape: { AbsolutePosition: { y: 2 }, Size: { height: 14 } } },
          staffEntries: [
            {
              getAbsoluteTimestamp: () => ({ RealValue: 1.0 }),
              graphicalVoiceEntries: [{ notes: [{ getSVGGElement: () => m1Sop.g, sourceNote: { Pitch: { halfTone: 60 }, isRest: () => false } }] }],
            },
          ],
        },
        {
          MeasureNumber: 1,
          parentSourceMeasure: { MeasureNumber: 1, AbsoluteTimestamp: { RealValue: 1.0 } },
          ParentMusicSystem: { Id: 0, PositionAndShape: { AbsolutePosition: { y: 2 }, Size: { height: 14 } } },
          staffEntries: [
            {
              getAbsoluteTimestamp: () => ({ RealValue: 1.0 }),
              graphicalVoiceEntries: [{ notes: [{ getSVGGElement: () => m1Bass.g, sourceNote: { Pitch: { halfTone: 36 }, isRest: () => false } }] }],
            },
          ],
        },
      ],
      [
        {
          MeasureNumber: 2,
          parentSourceMeasure: { MeasureNumber: 2, AbsoluteTimestamp: { RealValue: 1.75 } },
          ParentMusicSystem: { Id: 1, PositionAndShape: { AbsolutePosition: { y: 20 }, Size: { height: 16 } } },
          staffEntries: [
            {
              getAbsoluteTimestamp: () => ({ RealValue: 1.75 }),
              graphicalVoiceEntries: [{ notes: [{ getSVGGElement: () => m2Sop.g, sourceNote: { Pitch: { halfTone: 64 }, isRest: () => false } }] }],
            },
          ],
        },
      ],
    ];

    const { rerender } = render(
      <SheetMusicViewer
        musicxml={pickupXml}
        notes={satbNotes}
        playheadSec={0}
        isPlaying={true}
        tempoBpm={120}
        tracks={satb2Tracks}
      />,
    );

    // At t=0.0s: pickup notehead is highlighted blue & playhead sits at 60px
    await waitFor(() => {
      expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "60px" });
    });
    expect(pickupSop.path.getAttribute("fill")).toBe("#3b82f6");

    // At t=0.5s (Measure 1 downbeat): Soprano blue & Bass purple are highlighted and cursor moves to shared Measure 1 X-position
    rerender(
      <SheetMusicViewer
        musicxml={pickupXml}
        notes={satbNotes}
        playheadSec={0.5}
        isPlaying={false}
        tempoBpm={120}
        tracks={satb2Tracks}
      />,
    );
    await waitFor(() => {
      expect(m1Sop.path.getAttribute("fill")).toBe("#3b82f6");
      expect(m1Bass.path.getAttribute("fill")).toBe("#8b5cf6");
      expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "182px" });
    });

    // At t=2.0s (Measure 2 on system 1): cursor wraps to new system height and 320px
    rerender(
      <SheetMusicViewer
        musicxml={pickupXml}
        notes={satbNotes}
        playheadSec={2.0}
        isPlaying={false}
        tempoBpm={120}
        tracks={satb2Tracks}
      />,
    );
    await waitFor(() => {
      expect(m2Sop.path.getAttribute("fill")).toBe("#3b82f6");
      expect(screen.getByTestId("sheet-music-playhead")).toHaveStyle({ left: "320px" });
    });

    // Restore empty MeasureList for subsequent test isolation
    mockOsmdState.measureList = [];
  });
});
