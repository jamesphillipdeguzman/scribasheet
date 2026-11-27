import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstrumentTunerControl } from "@/features/editor/InstrumentTunerControl";
import { NotationMidiBar } from "@/features/editor/NotationMidiBar";
import { TranscriptionConfigPanel } from "@/features/transcription/TranscriptionConfigPanel";
import {
  createLivePitchNoteTracker,
  VIOLIN_MAX_MIDI,
  VIOLIN_MIN_MIDI,
} from "@/utils/livePitchNoteTracker";
import { getActiveMicOwner, resetMicCoordinatorForTests } from "@/utils/micCoordinator";
import { DEFAULT_TUNER_FFT_SIZE, midiToFrequency } from "@/utils/pitchTuner";

function makeMinimalTrebleXml(fifths = 0): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Violin</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>${fifths}</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><rest/><duration>16</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;
}

function generateViolinBuffer(
  freqHz: number,
  sampleRate = 48000,
  length = DEFAULT_TUNER_FFT_SIZE,
  amplitude = 0.45,
): Float32Array {
  const buf = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const phase = (2 * Math.PI * freqHz * i) / sampleRate;
    buf[i] =
      amplitude * Math.sin(phase) +
      amplitude * 0.35 * Math.sin(2 * phase) +
      amplitude * 0.15 * Math.sin(3 * phase);
  }
  return buf;
}

function createMockMicEnvironment(initialFreqHz: number | null = 440) {
  let signalFreqHz: number | null = initialFreqHz;
  let clockMs = 1000;
  let nextRafId = 1;
  const rafCallbacks = new Map<number, FrameRequestCallback>();
  const createdContexts: Array<{ close: ReturnType<typeof vi.fn>; state: string }> = [];
  const createdTracks: Array<{ stop: ReturnType<typeof vi.fn>; kind: string }> = [];
  const cancelAnimationFrameSpy = vi.fn((id: number) => {
    rafCallbacks.delete(id);
  });

  vi.stubGlobal("performance", {
    now: () => clockMs,
  });

  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrameSpy);

  class MockAudioContext {
    sampleRate = 48000;
    state = "running";
    currentTime = 0;
    destination = {};
    close = vi.fn().mockImplementation(async () => {
      this.state = "closed";
    });
    resume = vi.fn().mockResolvedValue(undefined);
    constructor() {
      createdContexts.push(this);
    }
    createOscillator() {
      return {
        type: "triangle",
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
    }
    createBiquadFilter() {
      return {
        type: "lowpass",
        frequency: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
          value: 1000,
        },
        Q: { setValueAtTime: vi.fn(), value: 1 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
    }
    createMediaStreamSource() {
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
    }
    createAnalyser() {
      return {
        fftSize: DEFAULT_TUNER_FFT_SIZE,
        smoothingTimeConstant: 0,
        disconnect: vi.fn(),
        getFloatTimeDomainData: (arr: Float32Array) => {
          if (signalFreqHz === null) {
            arr.fill(0);
            return;
          }
          const tone = generateViolinBuffer(signalFreqHz, 48000, arr.length, 0.45);
          arr.set(tone);
        },
      };
    }
  }

  vi.stubGlobal("AudioContext", MockAudioContext);

  const getUserMedia = vi.fn().mockImplementation(async () => {
    const track = { kind: "audio", stop: vi.fn() };
    createdTracks.push(track);
    return {
      getTracks: () => [track],
    };
  });

  const enumerateDevices = vi.fn().mockResolvedValue([
    { deviceId: "mic-1", kind: "audioinput", label: "USB Audio Interface" },
    { deviceId: "mic-2", kind: "audioinput", label: "Built-in Microphone" },
  ]);

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices,
    },
  });

  const stepFrames = async (count: number, dtMs = 45) => {
    for (let i = 0; i < count; i += 1) {
      clockMs += dtMs;
      const entries = Array.from(rafCallbacks.entries());
      rafCallbacks.clear();
      await act(async () => {
        for (const [, cb] of entries) {
          cb(clockMs);
        }
      });
    }
  };

  return {
    setFreq: (hz: number | null) => {
      signalFreqHz = hz;
    },
    advanceTime: (dtMs: number) => {
      clockMs += dtMs;
    },
    stepFrames,
    getUserMedia,
    enumerateDevices,
    createdContexts,
    createdTracks,
    cancelAnimationFrameSpy,
  };
}

describe("Violin Live Mic Tracker, UI Integration, & Transcription Preset", () => {
  beforeEach(() => {
    resetMicCoordinatorForTests();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetMicCoordinatorForTests();
  });

  it("tracks real synthesized violin waveforms across G3–E7 and enforces range bounds", () => {
    const tracker = createLivePitchNoteTracker();

    const testMidis = [VIOLIN_MIN_MIDI, 62, 69, 76, 88, VIOLIN_MAX_MIDI];
    let t = 0;
    for (const midi of testMidis) {
      const buf = generateViolinBuffer(midiToFrequency(midi), 48000, DEFAULT_TUNER_FFT_SIZE, 0.45);
      // Warm up across debounce (0, 60, 140 ms)
      tracker.processSamples(buf, 48000, t);
      tracker.processSamples(buf, 48000, t + 60);
      const res = tracker.processSamples(buf, 48000, t + 140);
      expect(res.events.some((e) => e.type === "noteOn" && e.midi === midi)).toBe(true);
      expect(tracker.getActiveNote()).toBe(midi);
      t += 300;
    }

    // Silence triggers noteOff
    const silent = new Float32Array(DEFAULT_TUNER_FFT_SIZE);
    tracker.processSamples(silent, 48000, t);
    const offRes = tracker.processSamples(silent, 48000, t + 80);
    expect(offRes.events.some((e) => e.type === "noteOff")).toBe(true);
    expect(tracker.getActiveNote()).toBeNull();

    // Below violin range (C3 = 130.81 Hz) must be ignored
    const lowBuf = generateViolinBuffer(130.81, 48000, DEFAULT_TUNER_FFT_SIZE, 0.45);
    tracker.processSamples(lowBuf, 48000, t + 200);
    const lowRes = tracker.processSamples(lowBuf, 48000, t + 400);
    expect(lowRes.events).toHaveLength(0);
    expect(tracker.getActiveNote()).toBeNull();
  });

  it("debounces stable pitch (~120ms), ignores bow transients & vibrato, handles transitions and same-pitch rearticulation", () => {
    const tracker = createLivePitchNoteTracker({ stableDebounceMs: 120, vibratoToleranceCents: 55 });

    // Brief 60ms glitch -> no noteOn
    expect(
      tracker.processObservation({ frequencyHz: 440, confidence: 0.92, rms: 0.08, timestampMs: 100 })
        .events,
    ).toHaveLength(0);
    expect(
      tracker.processObservation({ frequencyHz: 440, confidence: 0.92, rms: 0.08, timestampMs: 160 })
        .state,
    ).toBe("stabilizing");
    // Drop to silence before 120ms
    expect(
      tracker.processObservation({ frequencyHz: null, confidence: 0, rms: 0.001, timestampMs: 190 })
        .events,
    ).toHaveLength(0);
    expect(tracker.getActiveNote()).toBeNull();

    // Hold steady A4 (440 Hz) >= 120ms -> exactly one noteOn(69)
    tracker.processObservation({ frequencyHz: 440, confidence: 0.93, rms: 0.09, timestampMs: 300 });
    tracker.processObservation({ frequencyHz: 440, confidence: 0.93, rms: 0.09, timestampMs: 370 });
    const startRes = tracker.processObservation({
      frequencyHz: 440,
      confidence: 0.93,
      rms: 0.09,
      timestampMs: 430,
    });
    expect(startRes.events).toEqual([
      expect.objectContaining({ type: "noteOn", midi: 69 }),
    ]);

    // Continuous 6Hz ±38 cents vibrato while holding A4 never splits or re-triggers
    for (let k = 1; k <= 8; k += 1) {
      const cents = Math.sin(k * 1.1) * 38;
      const vibHz = 440 * Math.pow(2, cents / 1200);
      const vibRes = tracker.processObservation({
        frequencyHz: vibHz,
        confidence: 0.91,
        rms: 0.09,
        timestampMs: 430 + k * 45,
      });
      expect(vibRes.events).toHaveLength(0);
      expect(tracker.getActiveNote()).toBe(69);
    }

    // Brief bow-change transient jumping 1 frame to E5 (659 Hz) does not emit E5
    const transientRes = tracker.processObservation({
      frequencyHz: 659.25,
      confidence: 0.9,
      rms: 0.06,
      timestampMs: 830,
    });
    expect(transientRes.events).toHaveLength(0);
    expect(
      tracker.processObservation({ frequencyHz: 440, confidence: 0.92, rms: 0.09, timestampMs: 860 })
        .events,
    ).toHaveLength(0);
    expect(tracker.getActiveNote()).toBe(69);

    // Same-pitch bow re-articulation (RMS dip then sharp re-attack after cooldown) triggers noteOff(69) + noteOn(69)
    tracker.processObservation({ frequencyHz: 440, confidence: 0.9, rms: 0.03, timestampMs: 920 });
    const reattackRes = tracker.processObservation({
      frequencyHz: 440,
      confidence: 0.93,
      rms: 0.09,
      timestampMs: 965,
    });
    expect(reattackRes.events).toEqual([
      expect.objectContaining({ type: "noteOff", midi: 69 }),
      expect.objectContaining({ type: "noteOn", midi: 69 }),
    ]);

    // Genuine semitone/whole-tone shift to B4 (493.88 Hz) held >= 120ms switches cleanly
    tracker.processObservation({ frequencyHz: 493.88, confidence: 0.92, rms: 0.08, timestampMs: 1100 });
    tracker.processObservation({ frequencyHz: 493.88, confidence: 0.92, rms: 0.08, timestampMs: 1160 });
    const shiftRes = tracker.processObservation({
      frequencyHz: 493.88,
      confidence: 0.92,
      rms: 0.08,
      timestampMs: 1230,
    });
    expect(shiftRes.events).toEqual([
      expect.objectContaining({ type: "noteOff", midi: 69 }),
      expect.objectContaining({ type: "noteOn", midi: 71 }),
    ]);
    expect(tracker.getActiveNote()).toBe(71);
  });

  it("handles permission denied, missing device, and unsupported browser errors in NotationMidiBar", async () => {
    // 1. Unsupported browser
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });

    const onCommitXml = vi.fn();
    render(
      <NotationMidiBar
        isActiveTab={true}
        activeXml={makeMinimalTrebleXml(0)}
        tempoBpm={120}
        timeSignature="4/4"
        clefMode="treble"
        activeDuration="quarter"
        activeDotted={false}
        activeVoice="1"
        selectedTarget={null}
        onCommitXml={onCommitXml}
      />,
    );

    const micBtn = screen.getByTestId("notation-mic-input-btn");
    await act(async () => {
      fireEvent.click(micBtn);
    });
    expect(screen.getByTestId("notation-mic-error").textContent).toMatch(/not supported/i);

    // 2. Permission denied
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error("Denied"), { name: "NotAllowedError" })),
      },
    });
    vi.stubGlobal("AudioContext", class {});
    await act(async () => {
      fireEvent.click(screen.getByTestId("notation-mic-input-btn"));
    });
    expect(screen.getByTestId("notation-mic-error").textContent).toMatch(/permission was denied/i);

    // 3. Missing device
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("No mic"), { name: "NotFoundError" }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("notation-mic-input-btn"));
    });
    expect(screen.getByTestId("notation-mic-error").textContent).toMatch(/no compatible microphone/i);
  });

  it("inserts Step Input notes with key-signature spelling and chromatic accidentals without repeating sustained notes", async () => {
    // G Major (fifths = 1): F#4 (MIDI 66) and chromatic C#4 (MIDI 61)
    const harness = createMockMicEnvironment(midiToFrequency(66));
    let currentXml = makeMinimalTrebleXml(1);
    const committedXmls: string[] = [];

    render(
      <NotationMidiBar
        isActiveTab={true}
        activeXml={currentXml}
        tempoBpm={120}
        timeSignature="4/4"
        clefMode="treble"
        activeDuration="quarter"
        activeDotted={false}
        activeVoice="1"
        selectedTarget={null}
        onCommitXml={(nextXml) => {
          currentXml = nextXml;
          committedXmls.push(nextXml);
        }}
      />,
    );

    fireEvent.click(screen.getByTestId("notation-step-input-btn"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("notation-mic-input-btn"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("notation-mic-panel")).toBeTruthy();
    });

    // Run ~180ms of F#4 frames -> inserts exactly ONCE (holding does not repeat)
    await harness.stepFrames(5, 45);
    expect(committedXmls).toHaveLength(1);
    expect(committedXmls[0]).toContain("<step>F</step>");
    expect(committedXmls[0]).toContain("<alter>1</alter>");
    expect(screen.getByTestId("notation-mic-detected-pitch").textContent).toContain("F#4");

    // Hold F#4 longer -> still only 1 note inserted
    await harness.stepFrames(4, 45);
    expect(committedXmls).toHaveLength(1);

    // Switch to chromatic note C#4 (MIDI 61) -> inserts chromatic C#4
    harness.setFreq(midiToFrequency(61));
    await harness.stepFrames(5, 45);
    expect(committedXmls).toHaveLength(2);
    expect(currentXml).toContain("<step>C</step>");
    expect(currentXml).toContain("<alter>1</alter>");

    // Stop Mic cleans up MediaStream tracks, AudioContext, and rAF
    fireEvent.click(screen.getByTestId("notation-mic-stop-btn"));
    expect(harness.createdTracks[0]?.stop).toHaveBeenCalled();
    expect(harness.createdContexts[0]?.close).toHaveBeenCalled();
    expect(harness.cancelAnimationFrameSpy).toHaveBeenCalled();
  });

  it("supports Live Record with Mic / Violin Input without Web MIDI devices and writes single Treble staff MusicXML", async () => {
    const harness = createMockMicEnvironment(midiToFrequency(69)); // A4
    const committedXmls: string[] = [];

    // Web MIDI unsupported / no hardware MIDI connected
    Object.defineProperty(navigator, "requestMIDIAccess", {
      configurable: true,
      value: undefined,
    });

    render(
      <NotationMidiBar
        isActiveTab={true}
        activeXml={makeMinimalTrebleXml(-1)} // F major
        tempoBpm={120}
        timeSignature="4/4"
        clefMode="grand"
        activeDuration="quarter"
        activeDotted={false}
        activeVoice="1"
        selectedTarget={null}
        onCommitXml={(nextXml) => {
          committedXmls.push(nextXml);
        }}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("notation-mic-input-btn"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("notation-mic-stop-btn")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("notation-record-midi-btn"));
    // Hold A4 for ~5 frames (225ms)
    await harness.stepFrames(5, 45);
    // Shift to Bb4 (MIDI 70) in F major
    harness.setFreq(midiToFrequency(70));
    await harness.stepFrames(6, 45);

    fireEvent.click(screen.getByTestId("notation-stop-record-btn"));
    expect(committedXmls).toHaveLength(1);
    const recordedXml = committedXmls[0];
    expect(recordedXml).toContain("<sign>G</sign>");
    expect(recordedXml).toContain("<step>A</step>");
    expect(recordedXml).toContain("<step>B</step>");
    expect(recordedXml).toContain("<alter>-1</alter>");
  });

  it("coordinates exclusive microphone ownership between Live Mic Input and Studio Tuner, and tears down on tab switch", async () => {
    const harness = createMockMicEnvironment(440);

    const { rerender } = render(
      <div>
        <InstrumentTunerControl />
        <NotationMidiBar
          isActiveTab={true}
          activeXml={makeMinimalTrebleXml(0)}
          tempoBpm={120}
          timeSignature="4/4"
          clefMode="treble"
          activeDuration="quarter"
          activeDotted={false}
          activeVoice="1"
          selectedTarget={null}
          onCommitXml={vi.fn()}
        />
      </div>,
    );

    // 1. Activate Live Mic Input
    await act(async () => {
      fireEvent.click(screen.getByTestId("notation-mic-input-btn"));
    });
    await waitFor(() => {
      expect(getActiveMicOwner()).toBe("live_mic_input");
    });

    // 2. Opening Instrument Tuner cleanly releases Live Mic Input first
    await act(async () => {
      fireEvent.click(screen.getByTestId("studio-tuner-btn"));
    });
    await waitFor(() => {
      expect(getActiveMicOwner()).toBe("tuner");
    });
    expect(screen.queryByTestId("notation-mic-stop-btn")).toBeNull();
    expect(harness.createdTracks[0]?.stop).toHaveBeenCalled();

    // 3. Switching back to Live Mic Input cleanly closes Tuner mic without throwing
    await act(async () => {
      fireEvent.click(screen.getByTestId("notation-mic-input-btn"));
    });
    await waitFor(() => {
      expect(getActiveMicOwner()).toBe("live_mic_input");
    });
    expect(screen.queryByRole("dialog", { name: /instrument tuner/i })).toBeNull();

    // 4. Switching away from Sheet Music tab stops Live Mic cleanly
    rerender(
      <div>
        <InstrumentTunerControl />
        <NotationMidiBar
          isActiveTab={false}
          activeXml={makeMinimalTrebleXml(0)}
          tempoBpm={120}
          timeSignature="4/4"
          clefMode="treble"
          activeDuration="quarter"
          activeDotted={false}
          activeVoice="1"
          selectedTarget={null}
          onCommitXml={vi.fn()}
        />
      </div>,
    );
    await waitFor(() => {
      expect(getActiveMicOwner()).toBeNull();
    });
  });

  it("configures Violin (Solo Monophonic) preset cleanly in TranscriptionConfigPanel", () => {
    const onStart = vi.fn();

    render(
      <TranscriptionConfigPanel
        hasMedia={true}
        hasScore={false}
        activeJob={null}
        workerOnline={true}
        defaultInstrument="piano"
        defaultMode="piano"
        onStart={onStart}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        isStarting={false}
      />,
    );

    const modeSelect = screen.getByLabelText(/output arrangement/i) as HTMLSelectElement;
    const instrumentSelect = screen.getByLabelText(/^instrument$/i) as HTMLSelectElement;
    const demucsToggle = screen.getByLabelText(/separate audio stems/i) as HTMLInputElement;

    fireEvent.change(modeSelect, { target: { value: "violin_solo" } });

    expect(modeSelect.value).toBe("violin_solo");
    expect(instrumentSelect.value).toBe("violin");
    expect(instrumentSelect.disabled).toBe(true);
    expect(demucsToggle.checked).toBe(false);
    expect(demucsToggle.disabled).toBe(true);
    expect(screen.getByTestId("violin-solo-preset-info").textContent).toContain("G3–E7");

    fireEvent.click(screen.getByRole("button", { name: /start ai transcription/i }));
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "violin_solo",
        instrument: "violin",
        enable_source_separation: false,
        audio_source_type: "solo_piano",
        min_midi_pitch: 55,
        max_midi_pitch: 100,
      }),
    );
  });
});
