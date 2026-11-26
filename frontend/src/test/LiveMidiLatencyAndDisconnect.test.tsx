import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PianoRollEditor } from "@/features/editor/PianoRollEditor";
import { MidiSynthesizer, midiSynth } from "@/features/editor/midiSynth";
import type { ScoreNote } from "@/types/api";

let sheetViewerRenderCount = 0;

vi.mock("@/features/editor/SheetMusicViewer", () => ({
  SheetMusicViewer: function MockSheetMusicViewer() {
    sheetViewerRenderCount += 1;
    return <div data-testid="mock-sheet-viewer" />;
  },
}));

interface MockMidiPort {
  id: string;
  name: string;
  manufacturer: string;
  state: "connected" | "disconnected";
  connection: "open" | "closed" | "pending";
  onmidimessage: ((event: { data: Uint8Array; timeStamp?: number }) => void) | null;
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function createMockMidiAccess() {
  const portA: MockMidiPort = {
    id: "alesis-concert-1",
    name: "Alesis Concert",
    manufacturer: "Alesis",
    state: "connected",
    connection: "closed",
    onmidimessage: null,
    open: vi.fn(async function openPort(this: MockMidiPort) {
      this.connection = "open";
      return this;
    }),
    close: vi.fn(async function closePort(this: MockMidiPort) {
      this.connection = "closed";
      return this;
    }),
  };

  const portB: MockMidiPort = {
    id: "secondary-pad-2",
    name: "Secondary MIDI Pad",
    manufacturer: "Generic",
    state: "connected",
    connection: "closed",
    onmidimessage: null,
    open: vi.fn(async function openPort(this: MockMidiPort) {
      this.connection = "open";
      return this;
    }),
    close: vi.fn(async function closePort(this: MockMidiPort) {
      this.connection = "closed";
      return this;
    }),
  };

  const inputs = new Map<string, MockMidiPort>([
    [portA.id, portA],
    [portB.id, portB],
  ]);

  const access = {
    inputs,
    onstatechange: null as ((event: { port?: MockMidiPort }) => void) | null,
  };

  const requestMIDIAccess = vi.fn().mockResolvedValue(access);
  Object.defineProperty(navigator, "requestMIDIAccess", {
    configurable: true,
    writable: true,
    value: requestMIDIAccess,
  });

  return { portA, portB, access, requestMIDIAccess };
}

function installInteractiveAudioContextMock() {
  const capturedOptions: unknown[] = [];
  const startedOscillatorTimes: number[] = [];
  const startedBufferWakeCount = { count: 0 };
  const resumeCalls = { count: 0 };
  const compressorCalls = { count: 0 };
  const convolverCalls = { count: 0 };

  class MockAudioContext {
    public state: AudioContextState = "suspended";
    public currentTime = 1.25;
    public sampleRate = 48000;
    public baseLatency = 0.01;
    public outputLatency = 0.012;
    public destination = { maxChannelCount: 2 };

    constructor(options?: AudioContextOptions) {
      capturedOptions.push(options ?? null);
    }

    resume = vi.fn(async () => {
      resumeCalls.count += 1;
      this.state = "running";
    });

    createGain() {
      const gainParam = {
        value: 1,
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
      };
      return {
        gain: gainParam,
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
    }

    createOscillator() {
      return {
        type: "sine",
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn((when?: number) => {
          startedOscillatorTimes.push(when ?? 0);
        }),
        stop: vi.fn(),
        onended: null as (() => void) | null,
      };
    }

    createBiquadFilter() {
      return {
        type: "lowpass",
        frequency: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };
    }

    createBuffer(channels: number, length: number, sampleRate: number) {
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        getChannelData: () => new Float32Array(length),
      };
    }

    createBufferSource() {
      return {
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(() => {
          startedBufferWakeCount.count += 1;
        }),
      };
    }

    createDynamicsCompressor() {
      compressorCalls.count += 1;
      return {
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 1 },
        attack: { value: 0 },
        release: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
    }

    createConvolver() {
      convolverCalls.count += 1;
      return {
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
    }
  }

  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    writable: true,
    value: MockAudioContext,
  });

  return {
    capturedOptions,
    startedOscillatorTimes,
    startedBufferWakeCount,
    resumeCalls,
    compressorCalls,
    convolverCalls,
  };
}

const SAMPLE_NOTES: ScoreNote[] = [
  {
    id: "n-1",
    pitch_midi: 60,
    onset_sec: 0.25,
    offset_sec: 0.75,
    velocity: 90,
    track_index: 0,
  },
];

describe("Live MIDI Disconnect & Latency Fixes", () => {
  const origRequestMidi = (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess;
  const origAudioContext = window.AudioContext;

  beforeEach(() => {
    sheetViewerRenderCount = 0;
    installInteractiveAudioContextMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    midiSynth.stopAllMonitorNotes();
    Object.defineProperty(navigator, "requestMIDIAccess", {
      configurable: true,
      writable: true,
      value: origRequestMidi,
    });
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      writable: true,
      value: origAudioContext,
    });
  });

  it("unbinds and closes all MIDIInput ports on Disconnect MIDI and ignores ghost events", async () => {
    const { portA, portB } = createMockMidiAccess();
    const startSpy = vi.spyOn(midiSynth, "startSustainedNote").mockImplementation(() => {});
    const stopAllSpy = vi.spyOn(midiSynth, "stopAllMonitorNotes");

    render(
      <PianoRollEditor
        notes={SAMPLE_NOTES}
        durationSeconds={4}
        tempoBpm={120}
        playheadSec={0}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect MIDI Device/i }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("midi-connection-status")).toHaveTextContent(
        "Connected: Alesis Concert",
      );
    });

    const attachedHandler = portA.onmidimessage;
    expect(typeof attachedHandler).toBe("function");
    expect(portB.onmidimessage).toBeNull();

    // Pressing C4 while connected sounds audio & highlights C4
    act(() => {
      attachedHandler?.({ data: new Uint8Array([0x90, 60, 100]), timeStamp: 10 });
    });
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Piano key C4" }).className).toContain(
      "bg-[#A78BFA]",
    );

    // Click Disconnect MIDI
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Disconnect MIDI/i }));
    });

    expect(portA.onmidimessage).toBeNull();
    expect(portB.onmidimessage).toBeNull();
    expect(portA.close).toHaveBeenCalledTimes(1);
    expect(portB.close).toHaveBeenCalledTimes(1);
    expect(stopAllSpy).toHaveBeenCalled();
    expect(screen.getByTestId("midi-connection-status")).toHaveTextContent("Not Connected");
    expect(screen.getByRole("button", { name: "Piano key C4" }).className).not.toContain(
      "bg-[#A78BFA]",
    );

    // Even if browser delivers an already-queued callback reference after disconnect, it must NOT sound
    act(() => {
      attachedHandler?.({ data: new Uint8Array([0x90, 64, 105]), timeStamp: 20 });
    });
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Piano key E4" }).className).not.toContain(
      "bg-[#A78BFA]",
    );
  });

  it("unbinds and closes all MIDIInput ports and silences monitor notes on unmount and allows clean reconnect", async () => {
    const { portA, portB } = createMockMidiAccess();
    const stopAllSpy = vi.spyOn(midiSynth, "stopAllMonitorNotes");

    const view1 = render(
      <PianoRollEditor
        notes={SAMPLE_NOTES}
        durationSeconds={4}
        tempoBpm={120}
        playheadSec={0}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect MIDI Device/i }));
    });

    await waitFor(() => {
      expect(typeof portA.onmidimessage).toBe("function");
    });

    const staleHandler = portA.onmidimessage;
    act(() => {
      staleHandler?.({ data: new Uint8Array([0x90, 67, 95]), timeStamp: 30 });
    });

    view1.unmount();

    expect(portA.onmidimessage).toBeNull();
    expect(portB.onmidimessage).toBeNull();
    expect(portA.close).toHaveBeenCalledTimes(1);
    expect(portB.close).toHaveBeenCalledTimes(1);
    expect(stopAllSpy).toHaveBeenCalled();

    // Clean reconnect in fresh mount
    render(
      <PianoRollEditor
        notes={SAMPLE_NOTES}
        durationSeconds={4}
        tempoBpm={120}
        playheadSec={0}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect MIDI Device/i }));
    });

    await waitFor(() => {
      expect(typeof portA.onmidimessage).toBe("function");
      expect(screen.getByTestId("midi-connection-status")).toHaveTextContent(
        "Connected: Alesis Concert",
      );
    });
  });

  it("pre-warms an interactive AudioContext on Connect / Monitor ON and silences audio when Monitor turns OFF", async () => {
    const audioMock = installInteractiveAudioContextMock();
    const synth = new MidiSynthesizer();

    await synth.prepareLiveMidi();
    expect(audioMock.capturedOptions[0]).toEqual({ latencyHint: "interactive" });
    expect(audioMock.resumeCalls.count).toBe(1);
    expect(audioMock.startedBufferWakeCount.count).toBe(1);
    expect(synth.getLiveLatencyDiagnostics()).toMatchObject({
      contextState: "running",
      latencyHint: "interactive",
      sampleRate: 48000,
    });

    // Live monitor sustained notes bypass DynamicsCompressorNode/ConvolverNode for the live oscillator path
    const compBefore = audioMock.compressorCalls.count;
    const convBefore = audioMock.convolverCalls.count;
    synth.startSustainedNote(60, 100, 0.7);
    expect(audioMock.compressorCalls.count).toBe(compBefore);
    expect(audioMock.convolverCalls.count).toBe(convBefore);

    synth.dispose();

    // UI button pre-warm & Monitor toggle behavior
    const { portA } = createMockMidiAccess();
    const prepareSpy = vi.spyOn(midiSynth, "prepareLiveMidi").mockResolvedValue();
    const startSpy = vi.spyOn(midiSynth, "startSustainedNote").mockImplementation(() => {});
    const stopAllSpy = vi.spyOn(midiSynth, "stopAllMonitorNotes");

    render(
      <PianoRollEditor
        notes={SAMPLE_NOTES}
        durationSeconds={4}
        tempoBpm={120}
        playheadSec={0}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect MIDI Device/i }));
    });
    expect(prepareSpy).toHaveBeenCalled();

    // Turn Monitor OFF -> stops ringing monitor notes immediately, preserves key highlight
    const monitorBtn = screen.getByRole("button", { name: /Monitor/i });
    act(() => {
      fireEvent.click(monitorBtn);
    });
    expect(stopAllSpy).toHaveBeenCalled();
    expect(monitorBtn).toHaveAttribute("aria-pressed", "false");

    await waitFor(() => expect(typeof portA.onmidimessage).toBe("function"));
    act(() => {
      portA.onmidimessage?.({ data: new Uint8Array([0x90, 62, 100]), timeStamp: 50 });
    });
    expect(startSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Piano key D4" }).className).toContain(
      "bg-[#A78BFA]",
    );

    // Turn Monitor ON -> pre-warms audio engine again
    const prevPrepareCount = prepareSpy.mock.calls.length;
    act(() => {
      fireEvent.click(monitorBtn);
    });
    expect(prepareSpy.mock.calls.length).toBeGreaterThan(prevPrepareCount);
  });

  it("triggers audio before UI highlight with zero SheetMusicViewer re-renders and handles chords, repeated notes, CC64 sustain, and sub-5ms scheduling", async () => {
    const { portA } = createMockMidiAccess();

    let c4HighlightedDuringAudioStart: boolean | null = null;
    const startSpy = vi.spyOn(midiSynth, "startSustainedNote").mockImplementation((pitch) => {
      if (pitch === 60 && c4HighlightedDuringAudioStart === null) {
        c4HighlightedDuringAudioStart = screen
          .getByRole("button", { name: "Piano key C4" })
          .className.includes("bg-[#A78BFA]");
      }
    });
    const pedalSpy = vi.spyOn(midiSynth, "setSustainPedal");

    render(
      <PianoRollEditor
        notes={SAMPLE_NOTES}
        durationSeconds={4}
        tempoBpm={120}
        playheadSec={0}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={vi.fn()}
        musicxml="<score-partwise/>"
      />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Sheet Music" }));
    });
    expect(screen.getByTestId("mock-sheet-viewer")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect MIDI Device/i }));
    });
    await waitFor(() => expect(typeof portA.onmidimessage).toBe("function"));

    const baselineSheetRenders = sheetViewerRenderCount;
    expect(baselineSheetRenders).toBeGreaterThanOrEqual(1);

    // Fire 10 rapid notes (chord + repeated C4 + scalar run)
    const pitches = [60, 64, 67, 72, 60, 62, 64, 65, 67, 69];
    act(() => {
      for (const pitch of pitches) {
        portA.onmidimessage?.({ data: new Uint8Array([0x90, pitch, 100]), timeStamp: 100 });
        portA.onmidimessage?.({ data: new Uint8Array([0x80, pitch, 0]), timeStamp: 120 });
      }
    });

    expect(c4HighlightedDuringAudioStart).toBe(false);
    expect(startSpy).toHaveBeenCalledTimes(10);
    // Heavy SheetMusicViewer did NOT re-render for live MIDI key presses
    expect(sheetViewerRenderCount).toBe(baselineSheetRenders);

    // CC64 Sustain Pedal down & up forwards cleanly while Monitor is ON
    act(() => {
      portA.onmidimessage?.({ data: new Uint8Array([0xb0, 64, 127]), timeStamp: 130 });
      portA.onmidimessage?.({ data: new Uint8Array([0xb0, 64, 0]), timeStamp: 140 });
    });
    expect(pedalSpy).toHaveBeenNthCalledWith(1, true);
    expect(pedalSpy).toHaveBeenNthCalledWith(2, false);
    startSpy.mockRestore();

    // Verify CC64 sustain deferral & overlapping chord voices directly on MidiSynthesizer
    const audioMock = installInteractiveAudioContextMock();
    const synth = new MidiSynthesizer();
    await synth.prepareLiveMidi();
    const cancelCountBefore = () => audioMock.startedOscillatorTimes.length;

    synth.setSustainPedal(true);
    synth.startSustainedNote(60, 100, 0.7);
    synth.startSustainedNote(64, 100, 0.7);
    synth.startSustainedNote(67, 100, 0.7);
    expect(cancelCountBefore()).toBe(9); // 3 oscillators per chord pitch

    // Repeated note on 60 cleanly re-triggers while pedal is down
    synth.startSustainedNote(60, 110, 0.7);
    expect(cancelCountBefore()).toBe(12);

    // Note-off while pedal is down keeps voices held until pedal release
    synth.stopSustainedNote(60);
    synth.stopSustainedNote(64);
    synth.stopSustainedNote(67);
    expect((synth as unknown as { sustainedVoices: Map<number, unknown> }).sustainedVoices.size).toBe(3);

    synth.setSustainPedal(false);
    expect((synth as unknown as { sustainedVoices: Map<number, unknown> }).sustainedVoices.size).toBe(0);

    // Measure live synth scheduling latency on isolated MidiSynthesizer instance
    const samplesMs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const pitch = 60 + (i % 12);
      const t0 = performance.now();
      synth.startSustainedNote(pitch, 100, 0.7);
      samplesMs.push(performance.now() - t0);
      synth.stopSustainedNote(pitch);
    }
    const maxScheduleMs = Math.max(...samplesMs);
    expect(maxScheduleMs).toBeLessThan(15);
    expect(synth.getLiveLatencyDiagnostics().lastLiveScheduleMs).not.toBeNull();
    synth.dispose();
  });
});
