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
      durationReal: number;
      num: number;
      den: number;
      isRest?: boolean;
      offsetLeft: number;
    }>,
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
              Duration: { RealValue: cur.durationReal },
              ActiveTimeSignature: { Numerator: cur.num, Denominator: cur.den },
            };
          },
        },
      },
      GraphicSheet: {
        MeasureList: [],
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
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

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
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

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
    const synthStopSpy = vi.spyOn(midiSynth, "stop").mockImplementation(() => {});

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
});
