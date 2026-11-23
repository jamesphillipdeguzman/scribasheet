import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MidiSynthesizer } from "@/features/editor/midiSynth";
import type { ScoreNote } from "@/types/api";

function makeNote(id: string, pitchMidi: number, onsetSec: number, offsetSec = onsetSec + 0.4): ScoreNote {
  return {
    id,
    pitch_midi: pitchMidi,
    onset_sec: onsetSec,
    offset_sec: offsetSec,
    velocity: 85,
    track_index: 0,
  };
}

function createMockAudioContext() {
  const compressors: any[] = [];
  const gains: any[] = [];
  const oscs: any[] = [];

  const makeNode = (extra: Record<string, unknown> = {}) => {
    const node: any = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      ...extra,
    };
    return node;
  };

  const ctx: any = {
    currentTime: 0,
    sampleRate: 44100,
    state: "running",
    destination: makeNode({ kind: "destination" }),
    resume: vi.fn().mockResolvedValue(undefined),
    createGain: vi.fn(() => {
      const g = makeNode({
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
        },
      });
      gains.push(g);
      return g;
    }),
    createDynamicsCompressor: vi.fn(() => {
      const c = makeNode({
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
      });
      compressors.push(c);
      return c;
    }),
    createConvolver: vi.fn(() => makeNode({ buffer: null })),
    createBuffer: vi.fn(() => ({ getChannelData: () => new Float32Array(128) })),
    createBiquadFilter: vi.fn(() =>
      makeNode({
        type: "lowpass",
        frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      }),
    ),
    createOscillator: vi.fn(() => {
      const o = makeNode({
        type: "triangle",
        frequency: { setValueAtTime: vi.fn() },
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      });
      oscs.push(o);
      return o;
    }),
    __compressors: compressors,
    __gains: gains,
    __oscs: oscs,
  };

  return ctx;
}

describe("MidiSynthesizer Background-Tab Burst Prevention & Compressor", () => {
  let synth: MidiSynthesizer;
  let mockCtx: ReturnType<typeof createMockAudioContext>;
  let nowMs: number;
  let rafQueue: Array<FrameRequestCallback>;
  const origAudioContext = window.AudioContext;
  const origRaf = window.requestAnimationFrame;
  const origCaf = window.cancelAnimationFrame;

  beforeEach(() => {
    nowMs = 0;
    rafQueue = [];
    mockCtx = createMockAudioContext();

    (window as unknown as { AudioContext: unknown }).AudioContext = function MockAudioContext() {
      return mockCtx;
    };
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    synth = new MidiSynthesizer();
  });

  afterEach(() => {
    synth.dispose();
    (window as unknown as { AudioContext: unknown }).AudioContext = origAudioContext;
    window.requestAnimationFrame = origRaf;
    window.cancelAnimationFrame = origCaf;
    vi.restoreAllMocks();
  });

  function flushNextFrame(advanceMs: number) {
    nowMs += advanceMs;
    mockCtx.currentTime = nowMs / 1000;
    const cb = rafQueue.shift();
    if (cb) cb(nowMs);
  }

  it("creates protective DynamicsCompressorNode once and routes master gain through it", () => {
    synth.triggerNote(60, 0.4, 85, 0.7, 0);
    synth.triggerNote(64, 0.4, 85, 0.7, 0);

    expect(mockCtx.createDynamicsCompressor).toHaveBeenCalledTimes(1);
    const comp = mockCtx.__compressors[0];
    expect(comp.threshold.value).toBe(-6);
    expect(comp.knee.value).toBe(6);
    expect(comp.ratio.value).toBe(12);
    expect(comp.attack.value).toBe(0.002);
    expect(comp.release.value).toBe(0.15);
    expect(comp.connect).toHaveBeenCalledWith(mockCtx.destination);
  });

  it("schedules normal foreground notes and simultaneous 4-note chords intact", () => {
    const triggerSpy = vi.spyOn(synth, "triggerNote");
    const notes = [
      makeNote("c1", 60, 0.02),
      makeNote("c2", 64, 0.02),
      makeNote("c3", 67, 0.02),
      makeNote("c4", 72, 0.02),
      makeNote("n5", 62, 0.5),
    ];

    synth.start({
      notes,
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

    flushNextFrame(16);
    expect(triggerSpy).toHaveBeenCalledTimes(4);

    flushNextFrame(484);
    expect(triggerSpy).toHaveBeenCalledTimes(5);
  });

  it("skips stale overdue notes after background-tab throttling and never re-triggers them", () => {
    const triggerSpy = vi.spyOn(synth, "triggerNote");
    const notes = [
      makeNote("n0", 60, 0.0),
      makeNote("n1", 62, 1.0),
      makeNote("n2", 64, 2.0),
      makeNote("n3", 65, 5.02),
    ];

    synth.start({
      notes,
      fromSec: 0,
      durationSec: 6,
      tempoBpm: 120,
      playbackRate: 1,
      volume: 0.8,
      loop: false,
      metronome: false,
      onPosition: vi.fn(),
      onEnd: vi.fn(),
    });

    // Normal first tick at t=16ms -> triggers n0
    flushNextFrame(16);
    expect(triggerSpy).toHaveBeenCalledTimes(1);

    // Simulate 5-second background tab pause: n1 (1.0s) and n2 (2.0s) are >80ms overdue!
    flushNextFrame(4984); // now = 5.0s
    expect(triggerSpy).toHaveBeenCalledTimes(2); // only n3 (5.02s), NOT n1 or n2
    expect(triggerSpy.mock.calls[1][0]).toBe(65);

    // Next foreground frame must not re-trigger skipped notes
    flushNextFrame(16);
    expect(triggerSpy).toHaveBeenCalledTimes(2);
  });

  it("caps simultaneous voices per 5ms window at 8 to prevent burst overload", () => {
    const triggerSpy = vi.spyOn(synth, "triggerNote");
    const notes = Array.from({ length: 14 }, (_, idx) =>
      makeNote(`burst_${idx}`, 60 + (idx % 12), 0.01),
    );

    synth.start({
      notes,
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

    flushNextFrame(10);
    expect(triggerSpy).toHaveBeenCalledTimes(8);
  });

  it("synchronizes scheduler cursor on visibilitychange without restarting or altering tempo", () => {
    const triggerSpy = vi.spyOn(synth, "triggerNote");
    const onPos = vi.fn();
    const notes = [
      makeNote("v0", 60, 0.0),
      makeNote("v1", 62, 1.5),
      makeNote("v2", 64, 3.0),
      makeNote("v3", 67, 4.03),
    ];

    synth.start({
      notes,
      fromSec: 0,
      durationSec: 6,
      tempoBpm: 120,
      playbackRate: 1,
      volume: 0.8,
      loop: false,
      metronome: false,
      onPosition: onPos,
      onEnd: vi.fn(),
    });

    flushNextFrame(16);
    expect(triggerSpy).toHaveBeenCalledTimes(1);

    // Advance clock to 4.0s while tab was hidden, then return to visible
    nowMs = 4000;
    mockCtx.currentTime = 4.0;
    document.dispatchEvent(new Event("visibilitychange"));

    // Clock stays at live ~4.0s position, not restarted to 0
    expect(synth.getPlaybackClock().isPlaying).toBe(true);
    expect(synth.getPlaybackClock().currentSec).toBeCloseTo(4.0, 2);

    // Next tick triggers v3 (4.03s), skipping v1 and v2
    flushNextFrame(16);
    expect(triggerSpy).toHaveBeenCalledTimes(2);
    expect(triggerSpy.mock.calls[1][0]).toBe(67);
  });

  it("supports pause/stop, seek/resume, and cleans up visibilitychange listeners without duplicates", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const triggerSpy = vi.spyOn(synth, "triggerNote");
    const notes = [makeNote("s1", 60, 0.5), makeNote("s2", 64, 2.5)];

    synth.start({
      notes,
      fromSec: 0,
      durationSec: 4,
      tempoBpm: 120,
      playbackRate: 1,
      volume: 0.8,
      loop: false,
      metronome: false,
      onPosition: vi.fn(),
      onEnd: vi.fn(),
    });
    synth.stop();
    synth.start({
      notes,
      fromSec: 2.49,
      durationSec: 4,
      tempoBpm: 120,
      playbackRate: 1,
      volume: 0.8,
      loop: false,
      metronome: false,
      onPosition: vi.fn(),
      onEnd: vi.fn(),
    });

    const visAdds = addSpy.mock.calls.filter(([evt]) => evt === "visibilitychange");
    expect(visAdds).toHaveLength(1);

    flushNextFrame(16);
    expect(triggerSpy).toHaveBeenCalledTimes(1);
    expect(triggerSpy.mock.calls[0][0]).toBe(64);

    synth.dispose();
    const visRemoves = removeSpy.mock.calls.filter(([evt]) => evt === "visibilitychange");
    expect(visRemoves).toHaveLength(1);
  });
});
