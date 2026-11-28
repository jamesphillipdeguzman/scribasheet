import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

const { mockWsState } = vi.hoisted(() => ({
  mockWsState: {
    playing: false,
    currentTime: 0,
    duration: 14,
    seekCalls: [] as number[],
    playCalls: 0,
    pauseCalls: 0,
  },
}));

vi.mock("wavesurfer.js", () => ({
  default: {
    create: () => {
      const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
      const inst = {
        on: (evt: string, cb: (...args: unknown[]) => void) => {
          const list = handlers.get(evt) || [];
          list.push(cb);
          handlers.set(evt, list);
          if (evt === "ready") {
            setTimeout(() => cb(mockWsState.duration), 0);
          }
        },
        getDuration: () => mockWsState.duration,
        getCurrentTime: () => mockWsState.currentTime,
        isPlaying: () => mockWsState.playing,
        seekTo: (frac: number) => {
          const sec = frac * mockWsState.duration;
          mockWsState.seekCalls.push(sec);
          mockWsState.currentTime = sec;
        },
        play: async () => {
          mockWsState.playCalls += 1;
          mockWsState.playing = true;
        },
        pause: () => {
          mockWsState.pauseCalls += 1;
          mockWsState.playing = false;
        },
        setPlaybackRate: () => undefined,
        setVolume: () => undefined,
        destroy: () => undefined,
      };
      return inst;
    },
  },
}));

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: function MockSeekOSMD(container: HTMLElement) {
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
        svg.setAttribute("width", "1000");
        svg.setAttribute("height", "220");
        Object.defineProperty(container, "getBoundingClientRect", {
          configurable: true,
          value: () => ({
            left: 0,
            top: 0,
            right: 1000,
            bottom: 220,
            width: 1000,
            height: 220,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          }),
        });

        const doc = new DOMParser().parseFromString(loadedXml, "application/xml");
        const measures = Array.from(doc.querySelectorAll("part > measure"));
        const measureList: unknown[][] = [];
        let divisions = 1;
        let runningWhole = 0;

        measures.forEach((mEl, mIdx) => {
          const divEl = mEl.querySelector("attributes > divisions");
          if (divEl?.textContent) {
            const parsedDiv = Number(divEl.textContent.trim());
            if (parsedDiv > 0) divisions = parsedDiv;
          }
          const mNum = Number(mEl.getAttribute("number") ?? String(mIdx + 1));
          const mLeftPx = 20 + mIdx * 120;
          const mWidthPx = 100;
          const mStartWhole = runningWhole;
          let curWholeInMeasure = 0;
          const staffEntries: unknown[] = [];

          const noteEls = Array.from(mEl.children).filter((c) => c.tagName === "note");
          noteEls.forEach((nEl, nIdx) => {
            const isRest = Boolean(nEl.querySelector("rest"));
            const step = nEl.querySelector("pitch > step")?.textContent?.trim() || "C";
            const octave = Number(nEl.querySelector("pitch > octave")?.textContent || "4");
            const durDivs = Number(nEl.querySelector("duration")?.textContent || String(divisions));
            const durWhole = durDivs / (4 * divisions);
            const onsetWhole = mStartWhole + curWholeInMeasure;
            curWholeInMeasure += durWhole;

            const staveGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
            staveGroup.setAttribute("class", "vf-stavenote");
            const nh = document.createElementNS("http://www.w3.org/2000/svg", "g");
            nh.setAttribute("class", "vf-notehead");
            nh.setAttribute("data-testid", `seek-note-m${mNum}-n${nIdx}`);
            const nx = mLeftPx + 18 + nIdx * 24;
            Object.defineProperty(nh, "getBoundingClientRect", {
              configurable: true,
              value: () => ({
                left: nx,
                top: 70,
                right: nx + 12,
                bottom: 82,
                width: 12,
                height: 12,
                x: nx,
                y: 70,
                toJSON: () => ({}),
              }),
            });
            staveGroup.appendChild(nh);
            svg.appendChild(staveGroup);

            const STEP_SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
            const midi = (octave + 1) * 12 + (STEP_SEMI[step] ?? 0);
            staffEntries.push({
              getAbsoluteTimestamp: () => ({ RealValue: onsetWhole }),
              graphicalVoiceEntries: [
                {
                  notes: [
                    {
                      vfnoteIndex: 0,
                      sourceNote: {
                        isRest: () => isRest,
                        Pitch: isRest ? undefined : { halfTone: midi - 12 },
                        ParentStaffEntry: { ParentStaff: { idInMusicSheet: 0 } },
                      },
                      getSVGGElement: () => staveGroup,
                      getNoteheadSVGs: () => [nh],
                    },
                  ],
                },
              ],
            });
          });

          runningWhole += Math.max(0.25, curWholeInMeasure);
          measureList.push([
            {
              MeasureNumber: mNum,
              parentSourceMeasure: {
                MeasureNumber: mNum,
                AbsoluteTimestamp: { RealValue: mStartWhole },
              },
              PositionAndShape: {
                AbsolutePosition: { x: mLeftPx / 9, y: 2 },
                Size: { width: mWidthPx / 9, height: 14 },
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

import { midiSynth } from "@/features/editor/midiSynth";
import { buildMusicXmlTimeline, resolveScoreSeekSec } from "@/features/editor/musicXmlTimeline";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";
import { WaveformPlayer } from "@/features/editor/WaveformPlayer";
import { api } from "@/services/api";
import type { ScoreNote } from "@/types/api";

// Score with 1-beat pickup (m.0) + meter change (3/4 -> 4/4 -> 2/4) + tempo change (120 -> 60 -> 120)
// m.0 (1 beat @ 120 BPM) = 0.0..0.5s
// m.1 (3/4  @ 120 BPM) = 0.5..2.0s
// m.2 (4/4  @  60 BPM) = 2.0..6.0s
// m.3 (2/4  @  60 BPM) = 6.0..8.0s
// m.4 (4/4  @ 120 BPM) = 8.0..10.0s
// m.5 (4/4  @ 120 BPM) = 10.0..12.0s (notes at beat 1 = 10.0s, beat 2 = 10.5s, beat 3 = 11.0s)
const COMPLEX_TIMING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Melody</part-name></score-part></part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes><divisions>2</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
    </measure>
    <measure number="1">
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>6</duration><type>half</type><dot/></note>
    </measure>
    <measure number="2">
      <attributes><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <direction><sound tempo="60"/></direction>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>8</duration><type>whole</type></note>
    </measure>
    <measure number="3">
      <attributes><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
      <note><rest/><duration>4</duration><type>half</type></note>
    </measure>
    <measure number="4">
      <attributes><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><type>whole</type></note>
    </measure>
    <measure number="5">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;

const SAMPLE_NOTES: ScoreNote[] = [
  { id: "n0", pitch_midi: 67, onset_sec: 0, offset_sec: 0.5, velocity: 85, track_index: 0 },
  { id: "n1", pitch_midi: 69, onset_sec: 0.5, offset_sec: 2.0, velocity: 85, track_index: 0 },
  { id: "n2", pitch_midi: 71, onset_sec: 2.0, offset_sec: 6.0, velocity: 85, track_index: 0 },
  { id: "n4", pitch_midi: 72, onset_sec: 8.0, offset_sec: 10.0, velocity: 85, track_index: 0 },
  { id: "n5a", pitch_midi: 72, onset_sec: 10.0, offset_sec: 10.5, velocity: 85, track_index: 0 },
  { id: "n5b", pitch_midi: 74, onset_sec: 10.5, offset_sec: 11.0, velocity: 85, track_index: 0 },
  { id: "n5c", pitch_midi: 76, onset_sec: 11.0, offset_sec: 12.0, velocity: 85, track_index: 0 },
];

describe("Click-to-Seek Playback Timing and Synchronization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockWsState.playing = false;
    mockWsState.currentTime = 0;
    mockWsState.seekCalls = [];
    mockWsState.playCalls = 0;
    mockWsState.pauseCalls = 0;
  });

  it("computes measure and note beat timestamps accurately across pickups, meter changes, and tempo changes", () => {
    const timeline = buildMusicXmlTimeline(COMPLEX_TIMING_XML, 120);
    expect(timeline.hasPickup).toBe(true);
    expect(resolveScoreSeekSec({ timeline, measureNumber: 1 })).toBeCloseTo(0.5, 3);
    expect(resolveScoreSeekSec({ timeline, measureNumber: 2 })).toBeCloseTo(2.0, 3);
    expect(resolveScoreSeekSec({ timeline, measureNumber: 3 })).toBeCloseTo(6.0, 3);
    expect(resolveScoreSeekSec({ timeline, measureNumber: 4 })).toBeCloseTo(8.0, 3);
    expect(resolveScoreSeekSec({ timeline, measureNumber: 5 })).toBeCloseTo(10.0, 3);
    // Second quarter note in Measure 5 (quarter offset = 1.0 => +0.25 whole => +0.5s at 120 BPM)
    const m5StartWhole = timeline.segments.find((s) => s.measureNumber === 5)!.wholeNoteStart;
    expect(
      resolveScoreSeekSec({ timeline, measureNumber: 5, onsetWhole: m5StartWhole + 0.25 }),
    ).toBeCloseTo(10.5, 3);
  });

  it("seeks to clicked empty Measure 5 and clicked note beat in Measure 5, moves blue cursor separately from purple selection, and ignores out-of-bounds clicks", async () => {
    const onSeek = vi.fn();
    const onMusicXmlChange = vi.fn();
    const onTogglePlay = vi.fn();

    const { rerender } = render(
      <SheetMusicViewer
        musicxml={COMPLEX_TIMING_XML}
        notes={SAMPLE_NOTES}
        playheadSec={0}
        isPlaying={false}
        defaultEditMode={true}
        tempoBpm={120}
        onSeek={onSeek}
        onTogglePlay={onTogglePlay}
        onMusicXmlChange={onMusicXmlChange}
      />,
    );

    const m5Note2 = await screen.findByTestId("seek-note-m5-n1");
    // 1. Click empty area inside Measure 5 (mIdx=5 => left = 20 + 5*120 = 620..720, top = 18..144)
    const scrollContainer = screen.getByTestId("sheet-music-scroll-container");
    fireEvent.click(scrollContainer, { clientX: 695, clientY: 110 });
    expect(onSeek).toHaveBeenCalledWith(10);
    expect(screen.getByTestId("selected-measure-highlight")).toHaveAttribute(
      "aria-label",
      "Selected Measure 5",
    );

    // Rerender with updated playheadSec (paused) -> blue playhead moves to Measure 5 independently of purple highlight
    rerender(
      <SheetMusicViewer
        musicxml={COMPLEX_TIMING_XML}
        notes={SAMPLE_NOTES}
        playheadSec={10}
        isPlaying={false}
        defaultEditMode={true}
        tempoBpm={120}
        onSeek={onSeek}
        onTogglePlay={onTogglePlay}
        onMusicXmlChange={onMusicXmlChange}
      />,
    );
    const playheadAfterMeasureSeek = screen.getByTestId("sheet-music-playhead");
    const leftAtMeasure5 = Number.parseFloat(playheadAfterMeasureSeek.style.left);
    expect(leftAtMeasure5).toBeGreaterThan(500);

    // 2. Click second notehead in Measure 5 (10.5s)
    fireEvent.click(m5Note2, { clientX: 668, clientY: 75 });
    expect(onSeek).toHaveBeenLastCalledWith(10.5);
    expect(onTogglePlay).not.toHaveBeenCalled();

    // 3. Clicking outside any valid measure must NOT call onSeek or corrupt playback position
    onSeek.mockClear();
    fireEvent.click(scrollContainer, { clientX: 980, clientY: 210 });
    expect(onSeek).not.toHaveBeenCalled();

    // 4. Clicking a notehead while already playing seeks immediately WITHOUT pausing playback
    rerender(
      <SheetMusicViewer
        musicxml={COMPLEX_TIMING_XML}
        notes={SAMPLE_NOTES}
        playheadSec={2.0}
        isPlaying={true}
        defaultEditMode={true}
        tempoBpm={120}
        onSeek={onSeek}
        onTogglePlay={onTogglePlay}
        onMusicXmlChange={onMusicXmlChange}
      />,
    );
    fireEvent.click(m5Note2, { clientX: 668, clientY: 75 });
    expect(onSeek).toHaveBeenCalledWith(10.5);
    expect(onTogglePlay).not.toHaveBeenCalled();
  });

  it("synchronizes paused/playing seeks across midiSynth, Spacebar start position, and WaveSurfer audio without restarting engines unnecessarily", async () => {
    vi.spyOn(api, "getSignedMediaUrl").mockResolvedValue({
      url: "https://example.com/audio.wav",
      expires_in: 600,
    });
    const midiStartSpy = vi.spyOn(midiSynth, "start").mockImplementation(() => undefined);
    const midiSeekSpy = vi.spyOn(midiSynth, "seek").mockReturnValue(true);
    const midiStopSpy = vi.spyOn(midiSynth, "stop").mockImplementation(() => undefined);
    vi.spyOn(midiSynth, "preloadPiano").mockImplementation(() => undefined);
    vi.spyOn(midiSynth, "needsSamplerWait").mockReturnValue(false);
    const midiPausedSpy = vi.spyOn(midiSynth, "setPausedPosition").mockImplementation(() => undefined);
    const clockSpy = vi
      .spyOn(midiSynth, "getPlaybackClock")
      .mockReturnValue({ isPlaying: false, currentSec: 0 });

    const onPlayheadChange = vi.fn();

    // Score-only (MIDI synth) test: paused seek stores start position; Spacebar begins from sought position
    const { rerender } = render(
      <WaveformPlayer
        mediaAssetId={null}
        isScoreOnly={true}
        notes={SAMPLE_NOTES}
        durationSeconds={12}
        tempoBpm={120}
        playheadSec={0}
        onPlayheadChange={onPlayheadChange}
        seekRequest={{ sec: 10.5, autoplay: false, nonce: 1 }}
      />,
    );
    expect(onPlayheadChange).toHaveBeenCalledWith(10.5);
    expect(midiPausedSpy).toHaveBeenCalledWith(10.5);
    expect(midiStartSpy).not.toHaveBeenCalled();

    // Update prop playheadSec -> pressing Spacebar starts playback at 10.5s
    rerender(
      <WaveformPlayer
        mediaAssetId={null}
        isScoreOnly={true}
        notes={SAMPLE_NOTES}
        durationSeconds={12}
        tempoBpm={120}
        playheadSec={10.5}
        onPlayheadChange={onPlayheadChange}
        seekRequest={{ sec: 10.5, autoplay: false, nonce: 1 }}
      />,
    );
    fireEvent.keyDown(window, { code: "Space", key: " " });
    expect(midiStartSpy).toHaveBeenCalledWith(expect.objectContaining({ fromSec: 10.5 }));

    // Active playback seek uses midiSynth.seek() in place without calling midiSynth.stop()
    clockSpy.mockReturnValue({ isPlaying: true, currentSec: 10.6 });
    midiStopSpy.mockClear();
    rerender(
      <WaveformPlayer
        mediaAssetId={null}
        isScoreOnly={true}
        notes={SAMPLE_NOTES}
        durationSeconds={12}
        tempoBpm={120}
        playheadSec={10.6}
        onPlayheadChange={onPlayheadChange}
        seekRequest={{ sec: 2.0, autoplay: true, nonce: 2 }}
      />,
    );
    expect(midiSeekSpy).toHaveBeenCalledWith(2.0);
    expect(midiStopSpy).not.toHaveBeenCalled();
  });

  it("seeks loaded WaveSurfer audio without calling play() when paused and without restarting if already playing", async () => {
    vi.spyOn(api, "getSignedMediaUrl").mockResolvedValue({
      url: "https://example.com/song.wav",
      expires_in: 600,
    });
    vi.spyOn(midiSynth, "preloadPiano").mockImplementation(() => undefined);
    vi.spyOn(midiSynth, "stop").mockImplementation(() => undefined);
    const onPlayheadChange = vi.fn();

    const { rerender } = render(
      <WaveformPlayer
        mediaAssetId="asset-1"
        isScoreOnly={false}
        notes={SAMPLE_NOTES}
        durationSeconds={14}
        tempoBpm={120}
        playheadSec={0}
        onPlayheadChange={onPlayheadChange}
      />,
    );

    await new Promise((r) => setTimeout(r, 20));

    // Paused seek: moves audio playhead via seekTo without auto-starting playback
    rerender(
      <WaveformPlayer
        mediaAssetId="asset-1"
        isScoreOnly={false}
        notes={SAMPLE_NOTES}
        durationSeconds={14}
        tempoBpm={120}
        playheadSec={0}
        onPlayheadChange={onPlayheadChange}
        seekRequest={{ sec: 7.0, autoplay: false, nonce: 10 }}
      />,
    );
    expect(mockWsState.seekCalls).toContain(7.0);
    expect(mockWsState.playCalls).toBe(0);

    // Already playing seek: calls seekTo without redundantly calling play() again
    mockWsState.playing = true;
    rerender(
      <WaveformPlayer
        mediaAssetId="asset-1"
        isScoreOnly={false}
        notes={SAMPLE_NOTES}
        durationSeconds={14}
        tempoBpm={120}
        playheadSec={7.0}
        onPlayheadChange={onPlayheadChange}
        seekRequest={{ sec: 10.5, autoplay: true, nonce: 11 }}
      />,
    );
    expect(mockWsState.seekCalls).toContain(10.5);
    expect(mockWsState.playCalls).toBe(0);
  });
});
