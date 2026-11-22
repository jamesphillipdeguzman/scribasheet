import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_METRONOME_SETTINGS,
  loadMetronomeSettings,
  metronomeEngine,
  saveMetronomeSettings,
  scheduleMetronomeClickNode,
} from "@/features/editor/metronome";
import { midiSynth } from "@/features/editor/midiSynth";
import { PianoRollEditor } from "@/features/editor/PianoRollEditor";
import { WaveformPlayer } from "@/features/editor/WaveformPlayer";
import type { ScoreNote } from "@/types/api";

function installMockAudioContext() {
  const createdOscs: Array<{ type: string; freq: number; stopped: boolean }> = [];
  class MockAudioContext {
    public currentTime = 0;
    public sampleRate = 44100;
    public state = "running";
    public destination = {};
    public resume = vi.fn().mockResolvedValue(undefined);
    public createOscillator() {
      const rec = { type: "sine", freq: 440, stopped: false };
      createdOscs.push(rec);
      return {
        set type(v: string) {
          rec.type = v;
        },
        get type() {
          return rec.type;
        },
        frequency: {
          setValueAtTime: (f: number) => {
            rec.freq = f;
          },
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        start: vi.fn(),
        stop: () => {
          rec.stopped = true;
        },
      };
    }
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
    public createBiquadFilter() {
      return {
        type: "bandpass",
        frequency: { setValueAtTime: vi.fn() },
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
  return { createdOscs };
}

const sampleNotes: ScoreNote[] = [
  { id: "n1", pitch_midi: 60, onset_sec: 0, offset_sec: 1.0, velocity: 85, track_index: 0 },
];

describe("Functional Metronome & Settings Popover", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    metronomeEngine.stop();
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
    });
  });

  afterEach(() => {
    metronomeEngine.stop();
    vi.useRealTimers();
  });

  it("synthesizes Woodblock, Studio Beep, and Stick/Rimshot clicks with independent volume", () => {
    const { createdOscs } = installMockAudioContext();
    const ctx = new window.AudioContext();

    scheduleMetronomeClickNode(ctx, 0, {
      sound: "woodblock",
      isDownbeat: true,
      isSubdivision: false,
      volume: 0.8,
    });
    scheduleMetronomeClickNode(ctx, 0, {
      sound: "studio_beep",
      isDownbeat: false,
      isSubdivision: false,
      volume: 0.6,
    });
    scheduleMetronomeClickNode(ctx, 0, {
      sound: "stick_rimshot",
      isDownbeat: true,
      isSubdivision: false,
      volume: 0.9,
    });

    expect(createdOscs.map((o) => o.type)).toEqual(["triangle", "sine", "triangle"]);
    expect(createdOscs[0].freq).toBe(1180);
    expect(createdOscs[1].freq).toBe(880);
    expect(createdOscs[2].freq).toBe(1850);
  });

  it("persists metronome settings and supports standalone operation + immediate stop", () => {
    installMockAudioContext();
    vi.useFakeTimers();

    render(
      <WaveformPlayer
        mediaAssetId={null}
        isScoreOnly={true}
        notes={sampleNotes}
        durationSeconds={4}
        tempoBpm={120}
        timeSignature="3/4"
        playheadSec={0}
        onPlayheadChange={vi.fn()}
      />,
    );

    // Open Settings Popover
    fireEvent.click(screen.getByRole("button", { name: "Metronome settings" }));
    expect(screen.getByRole("dialog", { name: "Metronome Settings" })).toBeInTheDocument();

    // Configure sound, subdivision, count-in, volume, and time signature
    fireEvent.change(screen.getByLabelText("Click sound"), { target: { value: "studio_beep" } });
    fireEvent.change(screen.getByLabelText("Metronome subdivision"), { target: { value: "eighth" } });
    fireEvent.change(screen.getByLabelText("Count-in bars"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Metronome volume"), { target: { value: "60" } });

    const persisted = loadMetronomeSettings();
    expect(persisted.sound).toBe("studio_beep");
    expect(persisted.subdivision).toBe("eighth");
    expect(persisted.countInBars).toBe(1);
    expect(persisted.volume).toBeCloseTo(0.6, 2);

    // Start standalone click -> visual beat indicator displays 3 beats (from 3/4) and runs single scheduler
    fireEvent.click(screen.getByRole("button", { name: /Standalone Click/i }));
    expect(metronomeEngine.isRunning()).toBe(true);
    expect(metronomeEngine.getMode()).toBe("standalone");
    const beatIndicator = screen.getByTestId("metronome-beat-indicator");
    expect(beatIndicator.querySelectorAll("[data-beat]")).toHaveLength(3);

    // Disable Metronome -> stops immediately
    fireEvent.click(screen.getByRole("button", { name: "Metronome" }));
    expect(metronomeEngine.isRunning()).toBe(false);
  });

  it("runs count-in before synthesized score playback and stops cleanly on Stop", () => {
    installMockAudioContext();
    vi.useFakeTimers();
    const synthStartSpy = vi.spyOn(midiSynth, "start").mockImplementation(() => {});
    vi.spyOn(midiSynth, "stop").mockImplementation(() => {});

    saveMetronomeSettings({
      ...DEFAULT_METRONOME_SETTINGS,
      enabled: true,
      countInBars: 1,
    });

    render(
      <WaveformPlayer
        mediaAssetId={null}
        isScoreOnly={true}
        notes={sampleNotes}
        durationSeconds={4}
        tempoBpm={120}
        timeSignature="4/4"
        playheadSec={0}
        onPlayheadChange={vi.fn()}
      />,
    );

    // Click Play -> enters 1-bar count-in (4 beats @ 120 BPM = 2000ms) before midiSynth starts
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(metronomeEngine.getMode()).toBe("count_in");
    expect(synthStartSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2050);
    });
    expect(synthStartSpy).toHaveBeenCalledTimes(1);

    // Click Stop -> stops both midiSynth and metronomeEngine immediately
    fireEvent.click(screen.getByRole("button", { name: "Stop playback" }));
    expect(metronomeEngine.isRunning()).toBe(false);
  });

  it("exposes Metronome Settings and synchronized beat indicator inside Focus Mode", () => {
    installMockAudioContext();
    saveMetronomeSettings({
      ...DEFAULT_METRONOME_SETTINGS,
      enabled: true,
    });

    render(
      <PianoRollEditor
        notes={sampleNotes}
        tracks={[]}
        durationSeconds={4}
        tempoBpm={120}
        timeSignature="4/4"
        playheadSec={0}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={vi.fn()}
        activeBeat={2}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(screen.getByRole("button", { name: "Metronome settings" })).toBeInTheDocument();
    const beat2 = screen
      .getByTestId("metronome-beat-indicator")
      .querySelector('[data-beat="2"]');
    expect(beat2).toHaveAttribute("data-active", "true");

    fireEvent.click(screen.getByRole("button", { name: "Metronome settings" }));
    expect(screen.getByRole("dialog", { name: "Metronome Settings" })).toBeInTheDocument();
  });
});
