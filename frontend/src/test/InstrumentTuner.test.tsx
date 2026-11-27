import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { InstrumentTunerControl } from "@/features/editor/InstrumentTunerControl";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { api } from "@/services/api";
import {
  centsBetweenFrequencies,
  createPitchSmoother,
  DEFAULT_TUNER_FFT_SIZE,
  detectPitchYin,
  findNearestStringTarget,
  getTunerPreset,
  midiToFrequency,
} from "@/utils/pitchTuner";

function generateToneBuffer(
  freqHz: number,
  sampleRate = 48000,
  length = DEFAULT_TUNER_FFT_SIZE,
  amplitude = 0.45,
  withHarmonics = true,
): Float32Array {
  const buf = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const phase = (2 * Math.PI * freqHz * i) / sampleRate;
    let s = amplitude * Math.sin(phase);
    if (withHarmonics) {
      s += amplitude * 0.35 * Math.sin(2 * phase) + amplitude * 0.15 * Math.sin(3 * phase);
    }
    buf[i] = s;
  }
  return buf;
}

function generateDeterministicNoise(length = DEFAULT_TUNER_FFT_SIZE, amplitude = 0.25): Float32Array {
  const buf = new Float32Array(length);
  let seed = 1337;
  for (let i = 0; i < length; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    buf[i] = ((seed / 0xffffffff) * 2 - 1) * amplitude;
  }
  return buf;
}

function createMockAudioHarness(opts?: {
  sampleRate?: number;
  signalFreqHz?: number | null;
}) {
  const sampleRate = opts?.sampleRate ?? 48000;
  let currentFreqHz: number | null =
    opts && "signalFreqHz" in opts ? (opts.signalFreqHz ?? null) : 440;
  const createdContexts: Array<{
    state: string;
    sampleRate: number;
    currentTime: number;
    close: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    oscillators: Array<{
      type: string;
      frequency: { setValueAtTime: ReturnType<typeof vi.fn> };
      connect: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }>;
    analysers: Array<{
      fftSize: number;
      smoothingTimeConstant: number;
      disconnect: ReturnType<typeof vi.fn>;
      getFloatTimeDomainData: (arr: Float32Array) => void;
    }>;
    sources: Array<{
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }>;
  }> = [];

  class MockAudioContext {
    sampleRate = sampleRate;
    state = "running";
    currentTime = 0;
    destination = {};
    oscillators: (typeof createdContexts)[number]["oscillators"] = [];
    analysers: (typeof createdContexts)[number]["analysers"] = [];
    sources: (typeof createdContexts)[number]["sources"] = [];

    close = vi.fn().mockImplementation(async () => {
      this.state = "closed";
    });
    resume = vi.fn().mockResolvedValue(undefined);

    constructor() {
      createdContexts.push(this);
    }

    createMediaStreamSource = vi.fn().mockImplementation(() => {
      const src = { connect: vi.fn(), disconnect: vi.fn() };
      this.sources.push(src);
      return src;
    });

    createAnalyser = vi.fn().mockImplementation(() => {
      const analyser = {
        fftSize: 2048,
        smoothingTimeConstant: 0.8,
        disconnect: vi.fn(),
        getFloatTimeDomainData: (arr: Float32Array) => {
          if (currentFreqHz === null) {
            arr.fill(0);
          } else {
            arr.set(generateToneBuffer(currentFreqHz, sampleRate, arr.length));
          }
        },
      };
      this.analysers.push(analyser);
      return analyser;
    });

    createOscillator = vi.fn().mockImplementation(() => {
      const osc = {
        type: "sine",
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      };
      this.oscillators.push(osc);
      return osc;
    });

    createGain = vi.fn().mockImplementation(() => ({
      gain: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
  }

  return {
    MockAudioContext,
    createdContexts,
    setSignalFreq(freq: number | null) {
      currentFreqHz = freq;
    },
  };
}

describe("pitchTuner Engine (YIN, Presets, Calibration & Smoother)", () => {
  it("detects chromatic pitches across supported octaves accurately", () => {
    const cases = [
      { hz: 130.81, note: "C3", midi: 48 },
      { hz: 261.63, note: "C4", midi: 60 },
      { hz: 440.0, note: "A4", midi: 69 },
      { hz: 523.25, note: "C5", midi: 72 },
      { hz: 880.0, note: "A5", midi: 81 },
    ];
    for (const c of cases) {
      const res = detectPitchYin(generateToneBuffer(c.hz, 44100), 44100);
      expect(res).not.toBeNull();
      expect(res!.scientificNote).toBe(c.note);
      expect(res!.midiNote).toBe(c.midi);
      expect(Math.abs(res!.cents)).toBeLessThan(3);
    }
  });

  it("detects Violin (G3, D4, A4, E5), Guitar Standard (incl. E2), Guitar Drop D, and Ukulele High-G & Low-G", () => {
    const presetsAndExpected: Array<[Parameters<typeof getTunerPreset>[0], string[]]> = [
      ["violin", ["G3", "D4", "A4", "E5"]],
      ["guitar_standard", ["E2", "A2", "D3", "G3", "B3", "E4"]],
      ["guitar_drop_d", ["D2", "A2", "D3", "G3", "B3", "E4"]],
      ["ukulele_high_g", ["G4", "C4", "E4", "A4"]],
      ["ukulele_low_g", ["G3", "C4", "E4", "A4"]],
    ];

    for (const [presetId, expectedLabels] of presetsAndExpected) {
      const preset = getTunerPreset(presetId);
      expect(preset.strings.map((s) => s.label)).toEqual(expectedLabels);
      for (const s of preset.strings) {
        const targetHz = midiToFrequency(s.midi, 440);
        const samples = generateToneBuffer(targetHz, 48000, DEFAULT_TUNER_FFT_SIZE);
        const res = detectPitchYin(samples, 48000, {
          minFrequencyHz: preset.minHz,
          maxFrequencyHz: preset.maxHz,
        });
        expect(res, `${presetId} ${s.label}`).not.toBeNull();
        expect(res!.scientificNote).toBe(s.noteName);
        expect(Math.abs(res!.cents)).toBeLessThan(3);
        const nearest = findNearestStringTarget(res!.frequencyHz, preset.strings, 440);
        expect(nearest?.id).toBe(s.id);
      }
    }
  });

  it("calculates frequencies and cents accurately across A4 reference calibrations (432-445 Hz)", () => {
    const a4At432 = detectPitchYin(generateToneBuffer(432.0, 48000), 48000, { referenceA4Hz: 432 });
    expect(a4At432?.scientificNote).toBe("A4");
    expect(Math.abs(a4At432!.cents)).toBeLessThan(2);

    // 440 Hz compared against A4=432 Hz reference should register roughly +31.8 cents sharp
    const ref432Compare = detectPitchYin(generateToneBuffer(440.0, 48000), 48000, { referenceA4Hz: 432 });
    expect(ref432Compare!.cents).toBeCloseTo(centsBetweenFrequencies(440, 432), 0);
    expect(ref432Compare!.cents).toBeGreaterThan(25);

    const a4At445 = detectPitchYin(generateToneBuffer(445.0, 48000), 48000, { referenceA4Hz: 445 });
    expect(a4At445?.scientificNote).toBe("A4");
    expect(Math.abs(a4At445!.cents)).toBeLessThan(2);
  });

  it("returns null on silence and background noise and clears smoother cleanly", () => {
    const silence = new Float32Array(DEFAULT_TUNER_FFT_SIZE);
    expect(detectPitchYin(silence, 48000)).toBeNull();

    const quietHum = generateToneBuffer(440, 48000, DEFAULT_TUNER_FFT_SIZE, 0.002);
    expect(detectPitchYin(quietHum, 48000)).toBeNull();

    const whiteNoise = generateDeterministicNoise(DEFAULT_TUNER_FFT_SIZE, 0.25);
    expect(detectPitchYin(whiteNoise, 48000)).toBeNull();

    const smoother = createPitchSmoother({ maxSilentFrames: 3 });
    const raw = detectPitchYin(generateToneBuffer(440, 48000), 48000);
    expect(smoother.update(raw)?.scientificNote).toBe("A4");
    expect(smoother.update(null)).toBeNull();
    expect(smoother.update(null)).toBeNull();
    expect(smoother.update(null)).toBeNull();
  });
});

describe("InstrumentTunerControl Lifecycle, Drone Playback & Studio Isolation", () => {
  let activeStreams: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId = 1;
  let cancelRafSpy: ReturnType<typeof vi.fn>;
  let getUserMediaMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    activeStreams = [];
    rafCallbacks = new Map();
    nextRafId = 1;

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    cancelRafSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => {
        rafCallbacks.delete(id);
      }) as unknown as ReturnType<typeof vi.fn>;

    getUserMediaMock = vi.fn().mockImplementation(async () => {
      const stopTrack = vi.fn();
      activeStreams.push({ stop: stopTrack });
      return {
        getTracks: () => [{ stop: stopTrack }],
      } as unknown as MediaStream;
    });

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: getUserMediaMock },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens on click, drives live pitch updates, plays/stops calibrated drones, isolates mic, and cleans up on close", async () => {
    const harness = createMockAudioHarness({ sampleRate: 48000, signalFreqHz: 440 });
    vi.stubGlobal("AudioContext", harness.MockAudioContext);

    render(<InstrumentTunerControl />);
    expect(getUserMediaMock).not.toHaveBeenCalled();

    // Open tuner -> acquires 1 stream
    fireEvent.click(screen.getByTestId("studio-tuner-btn"));
    await waitFor(() => expect(getUserMediaMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(harness.createdContexts.length).toBe(1));

    // Fire throttled animation frame -> reads A4 (440 Hz), In Tune
    await act(async () => {
      const entries = Array.from(rafCallbacks.entries());
      const [, cb] = entries[entries.length - 1];
      cb(100);
    });
    expect(screen.getByTestId("tuner-detected-note")).toHaveTextContent("A4");
    expect(screen.getByTestId("tuner-detected-hz")).toHaveTextContent("440.0 Hz");
    expect(screen.getByTestId("tuner-status-badge")).toHaveTextContent("In Tune");

    // Select Guitar Standard and click E2 -> plays E2 drone calibrated to current A4, pausing mic
    fireEvent.change(screen.getByLabelText("Instrument preset"), { target: { value: "guitar_standard" } });
    fireEvent.click(screen.getByTestId("tuner-string-E2"));

    const ctx = harness.createdContexts[0];
    expect(ctx.oscillators.length).toBe(1);
    expect(ctx.oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(
      expect.closeTo(midiToFrequency(40, 440), 2),
      0,
    );
    expect(screen.getByTestId("tuner-status-badge")).toHaveTextContent("Mic Paused");

    // Adjusting A4 calibration to 442 Hz updates active drone frequency cleanly
    fireEvent.click(screen.getByRole("button", { name: "Increase A4 reference frequency" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase A4 reference frequency" }));
    expect(screen.getByTestId("tuner-reference-hz")).toHaveTextContent("442 Hz");
    expect(ctx.oscillators[0].frequency.setValueAtTime).toHaveBeenLastCalledWith(
      expect.closeTo(midiToFrequency(40, 442), 2),
      0,
    );

    // Clicking another string stops previous oscillator before starting new one
    fireEvent.click(screen.getByTestId("tuner-string-A2"));
    expect(ctx.oscillators[0].stop).toHaveBeenCalledTimes(1);
    expect(ctx.oscillators[0].disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.oscillators.length).toBe(2);

    // Stop Tone button halts active drone
    fireEvent.click(screen.getByTestId("tuner-stop-drone-btn"));
    expect(ctx.oscillators[1].stop).toHaveBeenCalledTimes(1);

    // Closing tuner releases stream tracks, closes AudioContext, cancels rAF, and avoids duplicates on reopen
    fireEvent.click(screen.getByTestId("studio-tuner-btn"));
    expect(activeStreams[0].stop).toHaveBeenCalledTimes(1);
    expect(ctx.sources[0].disconnect).toHaveBeenCalled();
    expect(ctx.analysers[0].disconnect).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(cancelRafSpy).toHaveBeenCalled();

    // Reopening starts fresh single stream without leaking old loop
    fireEvent.click(screen.getByTestId("studio-tuner-btn"));
    await waitFor(() => expect(getUserMediaMock).toHaveBeenCalledTimes(2));
    expect(harness.createdContexts.length).toBe(2);
  });

  it("handles permission denial and missing microphone gracefully while preserving reference tones", async () => {
    const harness = createMockAudioHarness({ sampleRate: 48000 });
    vi.stubGlobal("AudioContext", harness.MockAudioContext);

    const deniedErr = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    getUserMediaMock.mockRejectedValueOnce(deniedErr);

    render(<InstrumentTunerControl />);
    fireEvent.click(screen.getByTestId("studio-tuner-btn"));

    const errBanner = await screen.findByTestId("tuner-mic-error");
    expect(errBanner).toHaveTextContent(/microphone access was denied/i);

    // Reference tone still works cleanly even when mic permission is denied
    fireEvent.click(screen.getByTestId("tuner-drone-a4"));
    expect(harness.createdContexts[0].oscillators.length).toBe(1);

    // Retry when no microphone hardware is present
    const missingErr = Object.assign(new Error("Requested device not found"), { name: "NotFoundError" });
    getUserMediaMock.mockRejectedValueOnce(missingErr);
    fireEvent.click(screen.getByRole("button", { name: "Retry Microphone" }));
    await waitFor(() => expect(screen.getByTestId("tuner-mic-error")).toHaveTextContent(/no microphone was found/i));
  });

  it("mounts Tuner button in ProjectStudioPage top toolbar without requesting mic on Studio load", async () => {
    vi.spyOn(api, "getProject").mockResolvedValue({
      id: "proj-tuner-1",
      user_id: "u1",
      title: "Studio Tuner Test",
      description: "",
      status: "draft",
      instrument: "violin",
      transcription_mode: "midi_playground",
      duration_seconds: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      media_assets: [],
    });
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
    vi.spyOn(api, "getScore").mockRejectedValue(new Error("No score"));
    vi.spyOn(api, "getLyrics").mockResolvedValue({ text: "", segments: [] } as never);
    vi.spyOn(api, "listExports").mockResolvedValue([]);
    vi.spyOn(api, "getWorkerStatus").mockResolvedValue({
      worker_online: true,
      status: "online",
      last_seen_seconds: 1,
      worker_id: "w-1",
      active_job_count: 0,
      queue_depth: 0,
      freshness_threshold_seconds: 30,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/projects/proj-tuner-1"]}>
            <Routes>
              <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    const header = await screen.findByTestId("studio-header");
    const tunerBtn = within(header).getByTestId("studio-tuner-btn");
    expect(tunerBtn).toHaveTextContent("Tuner");
    expect(tunerBtn.className).toContain("dark:bg-[#181825]");
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });

  it("renders popover with responsive 340px/380px width, right-aligned positioning, single-line header, full preset names, and aligned cents scale", async () => {
    const harness = createMockAudioHarness({ sampleRate: 48000, signalFreqHz: 440 });
    vi.stubGlobal("AudioContext", harness.MockAudioContext);

    render(<InstrumentTunerControl />);
    const btn = screen.getByTestId("studio-tuner-btn");
    expect(btn.parentElement?.className).toContain("relative");

    fireEvent.click(btn);
    const popover = await screen.findByTestId("instrument-tuner-popover");
    const cls = popover.className;
    expect(cls).toContain("w-[340px]");
    expect(cls).toContain("sm:w-[380px]");
    expect(cls).toContain("max-w-[calc(100vw-2rem)]");
    expect(cls).toContain("right-0");
    expect(cls).toContain("top-full");
    expect(cls).toContain("mt-2");
    expect(cls).toContain("z-50");
    expect(cls).not.toMatch(/(^|\s)max-w-full(\s|$)/);

    // Single-line header: title + status badge + close button stay in header row
    const titleEl = within(popover).getByText("Instrument Tuner");
    expect(titleEl.className).toContain("whitespace-nowrap");
    const closeBtn = within(popover).getByRole("button", { name: "Close tuner" });
    expect(closeBtn.className).toContain("shrink-0");

    // Preset selector spans full available width and includes full preset names
    const presetSelect = within(popover).getByLabelText("Instrument preset") as HTMLSelectElement;
    expect(presetSelect.className).toContain("w-full");
    expect(presetSelect.className).toContain("min-w-0");
    expect(presetSelect.className).toContain("box-border");
    const optionTexts = Array.from(presetSelect.options).map((o) => o.text);
    expect(optionTexts.some((t) => t.includes("Chromatic (All Notes)"))).toBe(true);
    expect(optionTexts.some((t) => t.includes("Violin (G3–D4–A4–E5)"))).toBe(true);
    expect(optionTexts.some((t) => t.includes("Guitar Standard"))).toBe(true);
    expect(optionTexts.some((t) => t.includes("Ukulele Standard High-G"))).toBe(true);

    // Pitch gauge cents scale (-50¢, 0¢, +50¢) and aligned labels (Flat, In Tune, Sharp)
    const centsScale = within(popover).getByTestId("tuner-cents-scale");
    expect(centsScale.className).toContain("flex");
    expect(centsScale.className).toContain("items-center");
    expect(centsScale.className).toContain("justify-between");
    expect(centsScale.className).toContain("text-xs");
    expect(centsScale).toHaveTextContent("-50¢0¢+50¢");

    const centsLabels = within(popover).getByTestId("tuner-cents-labels");
    expect(centsLabels.className).toContain("flex");
    expect(centsLabels.className).toContain("items-center");
    expect(centsLabels.className).toContain("justify-between");
    expect(centsLabels).toHaveTextContent("FlatIn TuneSharp");

    // Reference tone controls & calibration slider remain contained
    const playA4Btn = within(popover).getByTestId("tuner-drone-a4");
    expect(playA4Btn.className).toContain("max-w-full");
    const waveformSelect = within(popover).getByLabelText("Reference tone waveform");
    expect(waveformSelect.className).toContain("min-w-0");
    expect(waveformSelect.className).toContain("box-border");
    const calibSlider = within(popover).getByLabelText("A4 reference frequency");
    expect(calibSlider.className).toContain("min-w-0");
    expect(calibSlider.className).toContain("box-border");
  });
});
