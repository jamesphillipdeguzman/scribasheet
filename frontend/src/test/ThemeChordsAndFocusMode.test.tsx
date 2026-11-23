import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as alphaTab from "@coderline/alphatab";
import { AmbientScoreBackdrop } from "@/components/AmbientScoreBackdrop";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/Button";
import { injectChordsIntoMusicXml } from "@/features/editor/musicXmlChords";
import { prepareDisplayMusicXml } from "@/features/editor/musicXmlNormalization";
import { buildMusicXmlTimeline } from "@/features/editor/musicXmlTimeline";
import { PianoRollEditor } from "@/features/editor/PianoRollEditor";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";
import { ThemeProvider } from "@/features/theme/ThemeContext";
import { TranscriptionConfigPanel } from "@/features/transcription/TranscriptionConfigPanel";
import type { ScoreChord, ScoreNote } from "@/types/api";

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: class {
    Zoom = 1;
    EngravingRules = { RenderChordSymbols: true };
    cursor = {
      cursorElement: document.createElement("img"),
      show: () => undefined,
      hide: () => undefined,
      reset: () => undefined,
      next: () => undefined,
      update: () => undefined,
      GNotesUnderCursor: () => [],
      iterator: { EndReached: false, CurrentMeasureIndex: 0, currentTimeStamp: { RealValue: 0 } },
    };
    GraphicSheet = { MeasureList: [] };
    async load() {}
    render() {}
    Dispose() {}
  },
}));

function buildAwayInAMangerSatbXml(): string {
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
            <divisions>1</divisions>
            <key><fifths>-1</fifths></key>
            <time><beats>3</beats><beat-type>4</beat-type></time>
          </attributes>
          <direction placement="above">
            <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>68</per-minute></metronome></direction-type>
            <sound tempo="68"/>
          </direction>
          <note><pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch><duration>1</duration><type>quarter</type></note>
        </measure>
        <measure number="1">
          <note><pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch><duration>2</duration><type>half</type></note>
          <note><pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch><duration>1</duration><type>quarter</type></note>
        </measure>
        <measure number="2">
          <note><pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch><duration>3</duration><type>half</type><dot/></note>
        </measure>
      </part>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1"><part-list>${partList}</part-list>${partBodies}</score-partwise>`;
}

describe("Theme Toggle, Hero Backdrop & SATB Chord Injection", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("light", "dark");
    try {
      window.localStorage?.clear?.();
    } catch {
      // ignore
    }
  });

  it("defaults to dark mode, toggles to light mode, persists scribasheet-theme, and updates AmbientScoreBackdrop", () => {
    render(
      <MemoryRouter>
        <ThemeProvider>
          <ThemeToggle />
          <AmbientScoreBackdrop variant="hero" />
          <AmbientScoreBackdrop variant="watermark" />
        </ThemeProvider>
      </MemoryRouter>,
    );

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    const heroImg = screen.getByTestId("ambient-backdrop-hero").querySelector("img")!;
    const wmImg = screen.getByTestId("ambient-backdrop-watermark").querySelector("img")!;
    expect(heroImg.getAttribute("src")).toBe("/images/hero1.webp");
    expect(heroImg.className).toContain("opacity-[0.22]");
    expect(heroImg.className).toContain("mix-blend-screen");
    expect(wmImg.className).toContain("opacity-[0.12]");

    fireEvent.click(screen.getByTestId("theme-toggle"));
    expect(document.documentElement.classList.contains("light")).toBe(true);
    if (window.localStorage?.getItem) {
      expect(window.localStorage.getItem("scribasheet-theme")).toBe("light");
    }
    expect(heroImg.className).toContain("opacity-[0.35]");
    expect(heroImg.className).toContain("mix-blend-multiply");
    expect(wmImg.className).toContain("opacity-[0.18]");
  });

  it("injects detected SATB chords (Eb, Bb7, Ab, Cm) into Soprano without duplicates or timing changes and parses in AlphaTab", () => {
    const rawXml = buildAwayInAMangerSatbXml();
    const secPerBeat = 60 / 68;
    const chords: ScoreChord[] = [
      { id: "c1", measure: 1, beat: 1, onset_sec: secPerBeat * 1, symbol: "Eb", root: "Eb", quality: "major" },
      { id: "c2", measure: 1, beat: 3, onset_sec: secPerBeat * 3, symbol: "Bb7", root: "Bb", quality: "7" },
      { id: "c3", measure: 2, beat: 1, onset_sec: secPerBeat * 4, symbol: "Cm", root: "C", quality: "minor" },
    ];

    const enriched = injectChordsIntoMusicXml(rawXml, chords, [], 68);
    const doc = new DOMParser().parseFromString(enriched, "application/xml");
    const parts = Array.from(doc.getElementsByTagName("part"));
    // Inserted into Soprano only
    expect(parts[0].getElementsByTagName("harmony").length).toBe(3);
    expect(parts[1].getElementsByTagName("harmony").length).toBe(0);

    // Calling injectChordsIntoMusicXml again must NOT duplicate existing <harmony> elements
    const enrichedTwice = injectChordsIntoMusicXml(enriched, chords, [], 68);
    const docTwice = new DOMParser().parseFromString(enrichedTwice, "application/xml");
    expect(docTwice.getElementsByTagName("harmony").length).toBe(3);

    // Toggling showChords=false hides <harmony> from display XML
    const hidden = prepareDisplayMusicXml(enriched, false);
    const docHidden = new DOMParser().parseFromString(hidden, "application/xml");
    expect(docHidden.getElementsByTagName("harmony").length).toBe(0);

    // Timeline timing (pickup 1 beat -> Measure 1 at ~0.8824s) is completely unaffected
    const tl = buildMusicXmlTimeline(enriched, 68);
    expect(tl.hasPickup).toBe(true);
    expect(tl.segments[1].secStart).toBeCloseTo(secPerBeat, 3);

    // AlphaTab ScoreLoader parses the injected <harmony> symbols natively
    const atScore = alphaTab.importer.ScoreLoader.loadScoreFromBytes(
      new TextEncoder().encode(enriched),
    );
    const m1Beats = atScore.tracks[0].staves[0].bars[1].voices[0].beats;
    expect(m1Beats[0].hasChord).toBe(true);
    expect(m1Beats[0].chord?.name).toBe("Eb");
    expect(m1Beats[1].hasChord).toBe(true);
    expect(m1Beats[1].chord?.name).toBe("Bb7");
  });

  it("infers chord symbols from simultaneous SATB notes when detected chords array is empty", () => {
    const rawXml = buildAwayInAMangerSatbXml();
    const secPerBeat = 60 / 68;
    const notes: ScoreNote[] = [
      // Measure 1 beat 1: F major (F3, F4, A4, C5)
      { id: "n1", pitch_midi: 53, onset_sec: secPerBeat, offset_sec: secPerBeat * 3, velocity: 84, track_index: 3 },
      { id: "n2", pitch_midi: 65, onset_sec: secPerBeat, offset_sec: secPerBeat * 3, velocity: 84, track_index: 2 },
      { id: "n3", pitch_midi: 69, onset_sec: secPerBeat, offset_sec: secPerBeat * 3, velocity: 84, track_index: 1 },
      { id: "n4", pitch_midi: 72, onset_sec: secPerBeat, offset_sec: secPerBeat * 3, velocity: 84, track_index: 0 },
    ];

    const enriched = injectChordsIntoMusicXml(rawXml, [], notes, 68);
    const atScore = alphaTab.importer.ScoreLoader.loadScoreFromBytes(
      new TextEncoder().encode(enriched),
    );
    const m1Beat0 = atScore.tracks[0].staves[0].bars[1].voices[0].beats[0];
    expect(m1Beat0.hasChord).toBe(true);
    expect(m1Beat0.chord?.name).toBe("F");
  });

  it("supports controlled Maximize / Exit Focus mode on both SheetMusicViewer and PianoRollEditor", () => {
    const onToggleFocus = vi.fn();
    const { rerender } = render(
      <SheetMusicViewer
        musicxml={buildAwayInAMangerSatbXml()}
        isFocusMode={true}
        onToggleFocusMode={onToggleFocus}
      />,
    );
    expect(screen.getByTestId("sheet-music-viewer").getAttribute("data-focus-mode")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Exit Focus" }));
    expect(onToggleFocus).toHaveBeenCalledTimes(1);

    rerender(
      <PianoRollEditor
        notes={[]}
        tracks={[]}
        durationSeconds={4}
        tempoBpm={68}
        playheadSec={0}
        selectedNoteId={null}
        onSelectNote={vi.fn()}
        onChangeNotes={vi.fn()}
        onPlayheadChange={vi.fn()}
        isFocusMode={true}
        onToggleFocusMode={onToggleFocus}
      />,
    );
    expect(screen.getByTestId("piano-roll-workspace").getAttribute("data-focus-mode")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Exit Focus" }));
    expect(onToggleFocus).toHaveBeenCalledTimes(2);
  });

  it("renders Light Mode accessible button, toggle, select, and Demucs checkbox styles while preserving dark: variants", () => {
    render(
      <div>
        <Button variant="primary">Play</Button>
        <Button variant="danger" disabled>Stop Worker</Button>
        <SheetMusicViewer musicxml={buildAwayInAMangerSatbXml()} />
        <TranscriptionConfigPanel
          hasMedia={true}
          activeJob={null}
          defaultInstrument="piano"
          defaultMode="single_instrument"
          onStart={vi.fn()}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
          isStarting={false}
        />
      </div>,
    );

    const playBtn = screen.getByRole("button", { name: "Play" });
    expect(playBtn.className).toContain("bg-violet-600");
    expect(playBtn.className).toContain("dark:bg-[#8B5CF6]");

    const stopWorkerBtn = screen.getByRole("button", { name: "Stop Worker" });
    expect(stopWorkerBtn.className).toContain("disabled:bg-stone-100");
    expect(stopWorkerBtn.className).toContain("disabled:text-stone-400");

    const followBtn = screen.getByRole("button", { name: "Follow cursor" });
    expect(followBtn.className).toContain("bg-emerald-100");
    expect(followBtn.className).toContain("text-emerald-900");

    const chordsBtn = screen.getByRole("button", { name: "Show chord symbols" });
    expect(chordsBtn.className).toContain("bg-violet-100");
    expect(chordsBtn.className).toContain("text-violet-900");

    const quantSelect = screen.getByLabelText("Quantization");
    expect(quantSelect.className).toContain("pr-7");
    expect(quantSelect.className).toContain("bg-white");
    expect(quantSelect.className).toContain("dark:bg-[#09090F]");
  });
});
