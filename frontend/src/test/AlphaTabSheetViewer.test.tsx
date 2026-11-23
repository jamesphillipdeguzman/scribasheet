import { act, fireEvent, render as renderUi, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as alphaTab from "@coderline/alphatab";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import {
  AlphaTabSheetViewer,
  resolveAlphaTabTrackRole,
} from "@/features/editor/AlphaTabSheetViewer";
import { midiSynth } from "@/features/editor/midiSynth";
import { prepareDisplayMusicXml } from "@/features/editor/musicXmlNormalization";
import { buildMusicXmlTimeline } from "@/features/editor/musicXmlTimeline";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";
import type { ScoreNote, ScoreTrack } from "@/types/api";

vi.mock("opensheetmusicdisplay", () => {
  const tracker = {
    holdNextLoad: false,
    pendingResolvers: [] as Array<() => void>,
    instances: [] as Array<{
      container: HTMLElement;
      loadCalls: number;
      renderCalls: number;
      disposeCalls: number;
    }>,
  };

  class MockOpenSheetMusicDisplay {
    static __tracker = tracker;
    Zoom = 1;
    EngravingRules = { RenderChordSymbols: true };
    cursor: Record<string, unknown>;
    GraphicSheet = { MeasureList: [] };
    private rec: (typeof tracker.instances)[number];

    constructor(container: HTMLElement) {
      const cursorEl = document.createElement("img");
      Object.defineProperty(cursorEl, "offsetLeft", { value: 64, configurable: true });
      Object.defineProperty(cursorEl, "offsetTop", { value: 24, configurable: true });
      Object.defineProperty(cursorEl, "offsetHeight", { value: 120, configurable: true });
      this.cursor = {
        cursorElement: cursorEl,
        show: () => undefined,
        hide: () => undefined,
        reset: () => undefined,
        next: () => undefined,
        update: () => undefined,
        GNotesUnderCursor: () => [],
        iterator: { EndReached: false, CurrentMeasureIndex: 0, currentTimeStamp: { RealValue: 0 } },
      };
      this.rec = { container, loadCalls: 0, renderCalls: 0, disposeCalls: 0 };
      tracker.instances.push(this.rec);
    }

    async load() {
      this.rec.loadCalls += 1;
      if (tracker.holdNextLoad) {
        tracker.holdNextLoad = false;
        await new Promise<void>((resolve) => {
          tracker.pendingResolvers.push(resolve);
        });
      }
    }

    render() {
      this.rec.renderCalls += 1;
    }

    Dispose() {
      this.rec.disposeCalls += 1;
    }
  }

  return {
    OpenSheetMusicDisplay: MockOpenSheetMusicDisplay,
  };
});

vi.mock("@/features/editor/midiSynth", () => {
  const clockState = { playing: false, sec: 0 };
  return {
    midiSynth: {
      __clockState: clockState,
      getPlaybackClock: () => ({
        isPlaying: clockState.playing,
        currentSec: clockState.sec,
      }),
    },
  };
});

vi.mock("@coderline/alphatab", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@coderline/alphatab")>();
  const { vi: v } = await import("vitest");

  function makeEvent<T = unknown>() {
    const listeners = new Set<(arg: T) => void>();
    return {
      listeners,
      on(fn: (arg: T) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      emit(arg: T) {
        for (const fn of Array.from(listeners)) {
          fn(arg);
        }
      },
      clear() {
        listeners.clear();
      },
    };
  }

  const instances: Array<any> = [];

  class MockAlphaTabApi {
    static instances = instances;
    container: HTMLElement;
    settings: Record<string, unknown>;
    load = v.fn(() => true);
    render = v.fn();
    renderTracks = v.fn();
    updateSettings = v.fn();
    destroy = v.fn();
    player = {
      output: {
        handler: null as Record<string, unknown> | null,
        updatePosition: v.fn(),
      },
    };
    playerReady = makeEvent<void>();
    scoreLoaded = makeEvent<{ tracks: Array<{ index: number; name: string }> }>();
    renderFinished = makeEvent<void>();
    activeBeatsChanged = makeEvent<{ activeBeats: Array<Record<string, unknown>> }>();
    beatMouseDown = makeEvent<{ playbackStart?: number }>();
    error = makeEvent<unknown>();

    constructor(container: HTMLElement, settings: Record<string, unknown>) {
      this.container = container;
      this.settings = settings;
      instances.push(this);
    }
  }

  return {
    ...actual,
    AlphaTabApi: MockAlphaTabApi,
  };
});

const mockClockState = (midiSynth as unknown as { __clockState: { playing: boolean; sec: number } })
  .__clockState;
const mockApiState = {
  get instances(): Array<any> {
    return (alphaTab.AlphaTabApi as unknown as { instances: Array<any> }).instances;
  },
  lastInstance() {
    return this.instances[this.instances.length - 1];
  },
};

const osmdTracker = (
  OpenSheetMusicDisplay as unknown as {
    __tracker: {
      holdNextLoad: boolean;
      pendingResolvers: Array<() => void>;
      instances: Array<{
        container: HTMLElement;
        loadCalls: number;
        renderCalls: number;
        disposeCalls: number;
      }>;
    };
  }
).__tracker;

function buildAwayInAMangerSatbXml(measureCount = 10): string {
  const parts = [
    { id: "P1", name: "Soprano", step: "C", octave: "5" },
    { id: "P2", name: "Alto", step: "A", octave: "4" },
    { id: "P3", name: "Tenor", step: "F", octave: "4" },
    { id: "P4", name: "Bass", step: "F", octave: "3" },
  ];

  const partList = parts
    .map((p) => `<score-part id="${p.id}"><part-name>${p.name}</part-name></score-part>`)
    .join("");

  const partBodies = parts
    .map((p) => {
      const measures: string[] = [];
      // Measure 0 (implicit="yes") 1-beat pickup in 3/4
      measures.push(`
        <measure number="0" implicit="yes">
          <attributes>
            <divisions>1</divisions>
            <key><fifths>-1</fifths></key>
            <time><beats>3</beats><beat-type>4</beat-type></time>
            <clef><sign>${p.id === "P3" || p.id === "P4" ? "F" : "G"}</sign><line>${
              p.id === "P3" || p.id === "P4" ? "4" : "2"
            }</line></clef>
          </attributes>
          <direction placement="above">
            <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>84</per-minute></metronome></direction-type>
            <sound tempo="84"/>
          </direction>
          <note>
            <pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch>
            <duration>1</duration>
            <type>quarter</type>
          </note>
        </measure>
      `);

      for (let m = 1; m <= measureCount; m += 1) {
        if (m === 2) {
          // Include a rest and a sustained half note
          measures.push(`
            <measure number="${m}">
              <note>
                <pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch>
                <duration>2</duration>
                <type>half</type>
              </note>
              <note><rest/><duration>1</duration><type>quarter</type></note>
            </measure>
          `);
        } else {
          measures.push(`
            <measure number="${m}">
              <note>
                <pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch>
                <duration>1</duration>
                <type>quarter</type>
              </note>
              <note>
                <pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch>
                <duration>1</duration>
                <type>quarter</type>
              </note>
              <note>
                <pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch>
                <duration>1</duration>
                <type>quarter</type>
              </note>
            </measure>
          `);
        }
      }
      return `<part id="${p.id}">${measures.join("")}</part>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
    <score-partwise version="3.1">
      <part-list>${partList}</part-list>
      ${partBodies}
    </score-partwise>`;
}

function buildFourFourNoPickupXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <score-partwise version="3.1">
      <part-list>
        <score-part id="P1"><part-name>Melody</part-name></score-part>
      </part-list>
      <part id="P1">
        <measure number="1">
          <attributes>
            <divisions>1</divisions>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <clef><sign>G</sign><line>2</line></clef>
          </attributes>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
        </measure>
        <measure number="2">
          <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
        </measure>
      </part>
    </score-partwise>`;
}

function buildTwoPartScoreXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <score-partwise version="3.1">
      <part-list>
        <score-part id="P1"><part-name>Piano Right</part-name></score-part>
        <score-part id="P2"><part-name>Piano Left</part-name></score-part>
      </part-list>
      <part id="P1">
        <measure number="1">
          <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
          <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
        </measure>
      </part>
      <part id="P2">
        <measure number="1">
          <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
          <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>whole</type></note>
        </measure>
      </part>
    </score-partwise>`;
}

describe("AlphaTab native ScoreLoader & SATB integration", () => {
  beforeEach(() => {
    mockApiState.instances.length = 0;
    osmdTracker.instances.length = 0;
    osmdTracker.pendingResolvers.length = 0;
    osmdTracker.holdNextLoad = false;
    mockClockState.playing = false;
    mockClockState.sec = 0;
    try {
      window.localStorage?.clear?.();
    } catch {
      // ignore in environments without localStorage
    }
  });

  it("parses Away in a Manger 3/4 opening pickup, Measure 1..10, and all 4 SATB tracks natively", () => {
    const xml = buildAwayInAMangerSatbXml(10);
    const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(xml));

    expect(score.tracks.map((t) => t.name)).toEqual(["Soprano", "Alto", "Tenor", "Bass"]);
    expect(score.masterBars.length).toBe(11);

    // Pickup measure (index 0): 1 quarter beat = 960 MIDI ticks
    expect(score.masterBars[0].isAnacrusis).toBe(true);
    expect(score.masterBars[0].start).toBe(0);
    expect(score.masterBars[0].calculateDuration()).toBe(960);

    // Measure 1 (index 1): full 3/4 bar = 2880 ticks starting right after pickup at 960
    expect(score.masterBars[1].isAnacrusis).toBe(false);
    expect(score.masterBars[1].start).toBe(960);
    expect(score.masterBars[1].calculateDuration()).toBe(2880);

    // Measure 2 (index 2): starts at 960 + 2880 = 3840
    expect(score.masterBars[2].start).toBe(3840);
    expect(score.masterBars[2].calculateDuration()).toBe(2880);

    // Measures 8-10 (indices 8..10)
    expect(score.masterBars[8].start).toBe(960 + 7 * 2880);
    expect(score.masterBars[9].start).toBe(960 + 8 * 2880);
    expect(score.masterBars[10].start).toBe(960 + 9 * 2880);
  });

  it("parses non-pickup 4/4 score and 2-part arrangement without inventing SATB voices", () => {
    const noPickupScore = alphaTab.importer.ScoreLoader.loadScoreFromBytes(
      new TextEncoder().encode(buildFourFourNoPickupXml()),
    );
    expect(noPickupScore.tracks.map((t) => t.name)).toEqual(["Melody"]);
    expect(noPickupScore.masterBars[0].isAnacrusis).toBe(false);
    expect(noPickupScore.masterBars[0].start).toBe(0);
    expect(noPickupScore.masterBars[0].calculateDuration()).toBe(3840);

    const twoPartScore = alphaTab.importer.ScoreLoader.loadScoreFromBytes(
      new TextEncoder().encode(buildTwoPartScoreXml()),
    );
    expect(twoPartScore.tracks.map((t) => t.name.replace(/\u00a0/g, " "))).toEqual([
      "Piano Right",
      "Piano Left",
    ]);
    expect(twoPartScore.tracks.length).toBe(2);
  });

  it("resolveAlphaTabTrackRole maps explicit SATB metadata and ScoreTrack fallbacks without pitch guessing", () => {
    const scoreTracks: ScoreTrack[] = [
      { index: 0, name: "Voice 1", instrument: "Choir", clef: "treble", program: 52, muted: false },
      { index: 1, name: "Alto", instrument: "Choir", clef: "treble", program: 52, muted: false },
      { index: 2, name: "Tenor", instrument: "Choir", clef: "bass", program: 52, muted: false },
      { index: 3, name: "Bass", instrument: "Choir", clef: "bass", program: 52, muted: false },
    ];

    expect(resolveAlphaTabTrackRole({ index: 0, name: "Soprano" }, scoreTracks)).toBe("soprano");
    expect(resolveAlphaTabTrackRole({ index: 1, name: "" }, scoreTracks)).toBe("alto");
    expect(resolveAlphaTabTrackRole({ index: 2, name: "Tenor" }, scoreTracks)).toBe("tenor");
    expect(resolveAlphaTabTrackRole({ index: 3, name: "Bass" }, scoreTracks)).toBe("bass");
    expect(resolveAlphaTabTrackRole({ index: 0, name: "Piano" }, [])).toBe("other");
  });

  it("initializes AlphaTabApi in EnabledExternalMedia mode, syncs Option B clock, and cleans up on unmount", () => {
    const onTogglePlay = vi.fn();
    const onSeek = vi.fn();
    const notes: ScoreNote[] = [
      { id: "n1", pitch_midi: 72, onset_sec: 0, offset_sec: 0.71, velocity: 90, track_index: 0 },
      { id: "n2", pitch_midi: 69, onset_sec: 0.71, offset_sec: 2.13, velocity: 90, track_index: 1 },
      { id: "n3", pitch_midi: 65, onset_sec: 3.5, offset_sec: 4.2, velocity: 90, track_index: 3 },
    ];

    const { unmount, rerender } = renderUi(
      <AlphaTabSheetViewer
        musicxml={buildAwayInAMangerSatbXml(4)}
        notes={notes}
        playheadSec={0}
        isPlaying={false}
        playbackRate={1.25}
        onTogglePlay={onTogglePlay}
        onSeek={onSeek}
      />,
    );

    const api = mockApiState.lastInstance();
    expect(api).toBeDefined();
    expect((api.settings.core as Record<string, unknown>).useWorkers).toBe(false);
    expect((api.settings.core as Record<string, unknown>).engine).toBe("svg");
    expect((api.settings.core as Record<string, unknown>).fontDirectory).toBe("/alphatab/font/");
    expect((api.settings.player as Record<string, unknown>).playerMode).toBe(
      alphaTab.PlayerMode.EnabledExternalMedia,
    );
    expect(api.load).toHaveBeenCalledTimes(1);

    // Fire playerReady and check ExternalMediaHandler wiring
    act(() => {
      api.playerReady.emit();
      api.scoreLoaded.emit({
        tracks: [
          { index: 0, name: "Soprano" },
          { index: 1, name: "Alto" },
          { index: 2, name: "Tenor" },
          { index: 3, name: "Bass" },
        ],
      });
      api.renderFinished.emit();
    });

    const handler = api.player.output.handler as {
      backingTrackDuration: number;
      playbackRate: number;
      seekTo: (ms: number) => void;
      play: () => void;
      pause: () => void;
    };
    expect(handler).toBeTruthy();
    expect(handler.backingTrackDuration).toBeCloseTo(4200, 0);
    expect(handler.playbackRate).toBe(1.25);
    expect(api.player.output.updatePosition).toHaveBeenCalledWith(0);

    handler.play();
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
    handler.seekTo(1420);
    expect(onSeek).toHaveBeenCalledWith(1.42);

    // Simulate active playback clock advancing from pickup (0s) into Measure 1 (0.75s)
    mockClockState.playing = true;
    mockClockState.sec = 0.75;
    rerender(
      <AlphaTabSheetViewer
        musicxml={buildAwayInAMangerSatbXml(4)}
        notes={notes}
        playheadSec={0.75}
        isPlaying={true}
        playbackRate={1.25}
        onTogglePlay={onTogglePlay}
        onSeek={onSeek}
      />,
    );
    expect(api.player.output.updatePosition).toHaveBeenCalledWith(750);

    // Pause and stop/reset to 0
    mockClockState.playing = false;
    mockClockState.sec = 0;
    rerender(
      <AlphaTabSheetViewer
        musicxml={buildAwayInAMangerSatbXml(4)}
        notes={notes}
        playheadSec={0}
        isPlaying={false}
        playbackRate={1.25}
        onTogglePlay={onTogglePlay}
        onSeek={onSeek}
      />,
    );
    expect(api.player.output.updatePosition).toHaveBeenCalledWith(0);

    // Replace score with non-pickup score
    rerender(
      <AlphaTabSheetViewer
        musicxml={buildFourFourNoPickupXml()}
        notes={notes}
        playheadSec={0}
        isPlaying={false}
        playbackRate={1}
        onTogglePlay={onTogglePlay}
        onSeek={onSeek}
      />,
    );
    expect(api.load).toHaveBeenCalledTimes(2);

    unmount();
    expect(api.destroy).toHaveBeenCalledTimes(1);
  });

  it("highlights simultaneous SATB active beats and respects solo and mute filtering", () => {
    const { rerender } = renderUi(
      <AlphaTabSheetViewer
        musicxml={buildAwayInAMangerSatbXml(2)}
        satbSoloVoice={null}
        satbMutedVoices={{ alto: true }}
      />,
    );

    const api = mockApiState.lastInstance();
    const makeBeat = (trackIndex: number, trackName: string, barIndex: number, beatIndex: number) => ({
      index: beatIndex,
      voice: {
        bar: {
          index: barIndex,
          staff: {
            track: { index: trackIndex, name: trackName },
          },
        },
      },
    });

    act(() => {
      api.activeBeatsChanged.emit({
        activeBeats: [
          makeBeat(0, "Soprano", 0, 0),
          makeBeat(1, "Alto", 0, 0),
          makeBeat(2, "Tenor", 0, 0),
          makeBeat(3, "Bass", 0, 0),
        ],
      });
    });

    const activeVoices = screen.getByTestId("alphatab-active-voices");
    expect(activeVoices.querySelector('[title="soprano"]')).not.toBeNull();
    expect(activeVoices.querySelector('[title="alto"]')).toBeNull(); // muted
    expect(activeVoices.querySelector('[title="tenor"]')).not.toBeNull();
    expect(activeVoices.querySelector('[title="bass"]')).not.toBeNull();

    // Now solo bass and emit beat in Measure 2 (barIndex = 1)
    rerender(
      <AlphaTabSheetViewer
        musicxml={buildAwayInAMangerSatbXml(2)}
        satbSoloVoice="bass"
        satbMutedVoices={{}}
      />,
    );

    act(() => {
      api.activeBeatsChanged.emit({
        activeBeats: [
          makeBeat(0, "Soprano", 1, 2),
          makeBeat(3, "Bass", 1, 2),
        ],
      });
    });

    const soloVoices = screen.getByTestId("alphatab-active-voices");
    expect(soloVoices.querySelector('[title="soprano"]')).toBeNull();
    expect(soloVoices.querySelector('[title="bass"]')).not.toBeNull();
  });

  it("SheetMusicViewer switches cleanly between AlphaTab and OSMD engines", () => {
    renderUi(
      <SheetMusicViewer
        musicxml={buildAwayInAMangerSatbXml(2)}
        defaultEngine="alphatab"
      />,
    );

    expect(screen.getByTestId("alphatab-sheet-music-viewer")).toBeInTheDocument();

    const osmdBtn = screen.getByRole("button", { name: "OSMD" });
    fireEvent.click(osmdBtn);

    if (typeof window !== "undefined" && window.localStorage?.getItem) {
      expect(window.localStorage.getItem("scribasheet:notation_engine")).toBe("osmd");
    }
    expect(screen.getByTestId("sheet-music-viewer")).toBeInTheDocument();

    const alphaTabBtn = screen.getByRole("button", { name: "AlphaTab" });
    fireEvent.click(alphaTabBtn);
    if (typeof window !== "undefined" && window.localStorage?.getItem) {
      expect(window.localStorage.getItem("scribasheet:notation_engine")).toBe("alphatab");
    }
    expect(screen.getByTestId("alphatab-sheet-music-viewer")).toBeInTheDocument();
  });

  it("strips artificial trailing half rest from Away in a Manger Measure 0 and aligns AlphaTab + OSMD at ~0.882s (68 BPM)", () => {
    const parts = [
      { id: "P1", name: "Soprano", step: "C", octave: "5" },
      { id: "P2", name: "Alto", step: "A", octave: "4" },
      { id: "P3", name: "Tenor", step: "F", octave: "4" },
      { id: "P4", name: "Bass", step: "F", octave: "3" },
    ];
    const partList = parts
      .map((p) => `<score-part id="${p.id}"><part-name>${p.name}</part-name></score-part>`)
      .join("");
    const partBodies = parts
      .map(
        (p) => `
      <part id="${p.id}">
        <measure number="0" implicit="yes">
          <attributes>
            <divisions>2</divisions>
            <time><beats>3</beats><beat-type>4</beat-type></time>
          </attributes>
          <direction placement="above">
            <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>68</per-minute></metronome></direction-type>
            <sound tempo="68"/>
          </direction>
          <note><pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch><duration>1</duration><type>eighth</type></note>
          <note><pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch><duration>1</duration><type>eighth</type></note>
          <note><rest/><duration>4</duration><type>half</type></note>
        </measure>
        <measure number="1">
          <note><pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch><duration>4</duration><type>half</type></note>
          <note><pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
        <measure number="2">
          <note><pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch><duration>4</duration><type>half</type></note>
          <note><rest/><duration>2</duration><type>quarter</type></note>
        </measure>
      </part>`,
      )
      .join("");
    const rawXml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1"><part-list>${partList}</part-list>${partBodies}</score-partwise>`;

    const normalizedXml = prepareDisplayMusicXml(rawXml, true);
    const parsedDoc = new DOMParser().parseFromString(normalizedXml, "application/xml");
    for (const partEl of Array.from(parsedDoc.getElementsByTagName("part"))) {
      const measures = Array.from(partEl.getElementsByTagName("measure"));
      expect(measures[0].getAttribute("implicit")).toBe("yes");
      const m0Notes = Array.from(measures[0].getElementsByTagName("note"));
      expect(m0Notes.length).toBe(2);
      expect(m0Notes.every((n) => n.getElementsByTagName("rest").length === 0)).toBe(true);
      // Measure 2 legitimate rest preserved
      const m2Notes = Array.from(measures[2].getElementsByTagName("note"));
      expect(m2Notes.length).toBe(2);
      expect(m2Notes[1].getElementsByTagName("rest").length).toBe(1);
    }

    // OSMD/MusicXML timeline: Measure 1 begins at 1 quarter-note = 60/68 ~= 0.8824s
    const timeline = buildMusicXmlTimeline(normalizedXml, 68);
    expect(timeline.hasPickup).toBe(true);
    expect(timeline.pickupQuarterBeats).toBeCloseTo(1, 4);
    expect(timeline.segments[0].wholeNoteEnd).toBeCloseTo(0.25, 4);
    expect(timeline.segments[1].secStart).toBeCloseTo(60 / 68, 3);

    // AlphaTab ScoreLoader agrees: Measure 0 is 1-beat anacrusis (960 ticks), Measure 1 starts at 960
    const atScore = alphaTab.importer.ScoreLoader.loadScoreFromBytes(
      new TextEncoder().encode(normalizedXml),
    );
    expect(atScore.masterBars[0].isAnacrusis).toBe(true);
    expect(atScore.masterBars[0].calculateDuration()).toBe(960);
    expect(atScore.masterBars[1].start).toBe(960);

    // Non-pickup score with legitimate trailing rest remains untouched
    const noPickupWithRest = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>half</type></note><note><rest/><duration>2</duration><type>half</type></note></measure></part></score-partwise>`;
    const normalizedNoPickup = prepareDisplayMusicXml(noPickupWithRest, true);
    const noPickupDoc = new DOMParser().parseFromString(normalizedNoPickup, "application/xml");
    expect(noPickupDoc.getElementsByTagName("rest").length).toBe(1);
  });

  it("re-initializes and renders a fresh OSMD instance across repeated OSMD -> AlphaTab -> OSMD toggles", async () => {
    renderUi(
      <SheetMusicViewer
        musicxml={buildAwayInAMangerSatbXml(2)}
        defaultEngine="osmd"
      />,
    );

    await waitFor(() => {
      expect(osmdTracker.instances.length).toBe(1);
      expect(osmdTracker.instances[0].renderCalls).toBe(1);
    });

    // Toggle OSMD -> AlphaTab: disposes OSMD instance
    fireEvent.click(screen.getByRole("button", { name: "AlphaTab" }));
    expect(osmdTracker.instances[0].disposeCalls).toBe(1);
    expect(screen.getByTestId("alphatab-sheet-music-viewer")).toBeInTheDocument();

    // Toggle AlphaTab -> OSMD: creates a NEW OSMD instance on the newly mounted DOM container and renders
    fireEvent.click(screen.getByRole("button", { name: "OSMD" }));
    await waitFor(() => {
      expect(osmdTracker.instances.length).toBe(2);
      expect(osmdTracker.instances[1].loadCalls).toBe(1);
      expect(osmdTracker.instances[1].renderCalls).toBe(1);
    });
    expect(osmdTracker.instances[1].container).not.toBe(osmdTracker.instances[0].container);
    expect(osmdTracker.instances[1].container.isConnected).toBe(true);

    // Toggle again OSMD -> AlphaTab -> OSMD
    fireEvent.click(screen.getByRole("button", { name: "AlphaTab" }));
    expect(osmdTracker.instances[1].disposeCalls).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "OSMD" }));
    await waitFor(() => {
      expect(osmdTracker.instances.length).toBe(3);
      expect(osmdTracker.instances[2].renderCalls).toBe(1);
    });
  });

  it("cancels stale async OSMD loads when toggling engines mid-load", async () => {
    osmdTracker.holdNextLoad = true;
    renderUi(
      <SheetMusicViewer
        musicxml={buildAwayInAMangerSatbXml(2)}
        defaultEngine="osmd"
      />,
    );

    await waitFor(() => {
      expect(osmdTracker.instances.length).toBe(1);
      expect(osmdTracker.instances[0].loadCalls).toBe(1);
      expect(osmdTracker.instances[0].renderCalls).toBe(0);
    });

    // Switch to AlphaTab and back to OSMD before the first load resolves
    fireEvent.click(screen.getByRole("button", { name: "AlphaTab" }));
    fireEvent.click(screen.getByRole("button", { name: "OSMD" }));

    await waitFor(() => {
      expect(osmdTracker.instances.length).toBe(2);
      expect(osmdTracker.instances[1].renderCalls).toBe(1);
    });

    // Now resolve the stale first load; it must NOT call render() on the disposed first instance
    act(() => {
      for (const resolve of osmdTracker.pendingResolvers) resolve();
    });
    expect(osmdTracker.instances[0].disposeCalls).toBe(1);
    expect(osmdTracker.instances[0].renderCalls).toBe(0);
    expect(osmdTracker.instances[1].renderCalls).toBe(1);
  });
});

describe("AlphaTabSheetViewer Reactive Lifecycle", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const sampleXmlA = buildAwayInAMangerSatbXml(2);
  const sampleXmlB = buildAwayInAMangerSatbXml(3);

  beforeEach(() => {
    mockApiState.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.ResizeObserver = originalResizeObserver;
    vi.restoreAllMocks();
  });

  it("mounts with empty MusicXML, then initializes and loads automatically when valid XML arrives", async () => {
    const { rerender } = renderUi(<AlphaTabSheetViewer musicxml={null} />);
    expect(screen.getByTestId("sheet-music-empty")).toBeInTheDocument();
    expect(mockApiState.instances).toHaveLength(0);

    await act(async () => {
      rerender(<AlphaTabSheetViewer musicxml={sampleXmlA} />);
    });

    expect(mockApiState.instances).toHaveLength(1);
    const api = mockApiState.lastInstance();
    expect(api.load).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Rendering sheet music notation with AlphaTab/i)).toBeInTheDocument();

    act(() => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      api.container.appendChild(svg);
      api.renderFinished.emit();
    });

    expect(screen.queryByText(/Rendering sheet music notation with AlphaTab/i)).not.toBeInTheDocument();
  });

  it("waits for container width via ResizeObserver and flushes pending XML when API becomes ready", async () => {
    let roCallback: ResizeObserverCallback | null = null;
    const disconnectSpy = vi.fn();
    const observeSpy = vi.fn();

    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb;
      }
      observe = observeSpy;
      unobserve = vi.fn();
      disconnect = disconnectSpy;
    } as unknown as typeof ResizeObserver;

    await act(async () => {
      renderUi(<AlphaTabSheetViewer musicxml={sampleXmlA} />);
    });

    expect(mockApiState.instances).toHaveLength(0);
    expect(observeSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      roCallback?.(
        [{ contentRect: { width: 820, height: 400 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(mockApiState.instances).toHaveLength(1);
    expect(mockApiState.lastInstance().load).toHaveBeenCalledTimes(1);
  });

  it("reloads on updated XML, skips redundant loads for unchanged XML, and reloads after empty job reset", async () => {
    const { rerender } = renderUi(<AlphaTabSheetViewer musicxml={sampleXmlA} />);
    const api = mockApiState.lastInstance();
    expect(api.load).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender(<AlphaTabSheetViewer musicxml={sampleXmlA} />);
    });
    expect(api.load).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender(<AlphaTabSheetViewer musicxml={sampleXmlB} />);
    });
    expect(api.load).toHaveBeenCalledTimes(2);

    await act(async () => {
      rerender(<AlphaTabSheetViewer musicxml={null} />);
    });
    expect(screen.getByTestId("sheet-music-empty")).toBeInTheDocument();

    await act(async () => {
      rerender(<AlphaTabSheetViewer musicxml={sampleXmlB} />);
    });
    const newApi = mockApiState.lastInstance();
    expect(newApi.load).toHaveBeenCalledTimes(1);
  });

  it("clears loading state and exposes error when api.error fires", async () => {
    await act(async () => {
      renderUi(<AlphaTabSheetViewer musicxml={sampleXmlA} />);
    });
    const api = mockApiState.lastInstance();
    expect(screen.getByText(/Rendering sheet music notation with AlphaTab/i)).toBeInTheDocument();

    act(() => {
      api.error.emit(new Error("Invalid measure divisions"));
    });

    expect(screen.queryByText(/Rendering sheet music notation with AlphaTab/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Invalid measure divisions/i)).toBeInTheDocument();
  });

  it("handles missing SVG via bounded 4-second safety check without infinite reload loops", async () => {
    await act(async () => {
      renderUi(<AlphaTabSheetViewer musicxml={sampleXmlA} />);
    });
    const api = mockApiState.lastInstance();

    act(() => {
      api.renderFinished.emit();
    });
    expect(screen.getByText(/Rendering sheet music notation with AlphaTab/i)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(api.render).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(api.render).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Rendering sheet music notation with AlphaTab/i)).not.toBeInTheDocument();
    const errBanner = screen.getByText(/without producing notation SVG/i);
    expect(errBanner).toBeInTheDocument();
    expect(errBanner.className).toContain("bg-red-50");
    expect(errBanner.className).toContain("text-red-800");
    expect(errBanner.className).toContain("border-red-300");

    // If SVG is injected later and renderFinished fires, stale false-positive error clears
    act(() => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      api.container.appendChild(svg);
      api.renderFinished.emit();
    });
    expect(screen.queryByText(/without producing notation SVG/i)).not.toBeInTheDocument();
  });

  it("destroys API and disconnects ResizeObserver and listeners on unmount", async () => {
    const disconnectSpy = vi.fn();
    let roCallback: ResizeObserverCallback | null = null;
    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = disconnectSpy;
    } as unknown as typeof ResizeObserver;

    const { unmount } = renderUi(<AlphaTabSheetViewer musicxml={sampleXmlA} />);
    await act(async () => {
      roCallback?.(
        [{ contentRect: { width: 640, height: 300 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    const api = mockApiState.lastInstance();
    expect(api.renderFinished.listeners.size).toBe(1);
    expect(api.error.listeners.size).toBe(1);

    unmount();
    expect(api.destroy).toHaveBeenCalledTimes(1);
    expect(api.renderFinished.listeners.size).toBe(0);
    expect(api.error.listeners.size).toBe(0);
  });
});
