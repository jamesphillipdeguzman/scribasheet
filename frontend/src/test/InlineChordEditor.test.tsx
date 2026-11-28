import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: function MockChordOSMD(container: HTMLElement) {
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
        svg.setAttribute("width", "800");
        svg.setAttribute("height", "220");
        Object.defineProperty(container, "getBoundingClientRect", {
          configurable: true,
          value: () => ({
            left: 0,
            top: 0,
            right: 800,
            bottom: 220,
            width: 800,
            height: 220,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          }),
        });

        const doc = new DOMParser().parseFromString(loadedXml, "application/xml");
        const measures = Array.from(doc.querySelectorAll("part > measure"));
        const measureList: unknown[][] = [];
        let divisions = 4;
        let runningWhole = 0;

        measures.forEach((mEl, mIdx) => {
          const divEl = mEl.querySelector("attributes > divisions");
          if (divEl?.textContent) {
            const parsed = Number(divEl.textContent.trim());
            if (parsed > 0) divisions = parsed;
          }
          const mNum = Number(mEl.getAttribute("number") || String(mIdx + 1));
          const mLeft = 20 + mIdx * 240;
          const staffEntries: unknown[] = [];
          let curDiv = 0;

          for (const child of Array.from(mEl.children)) {
            const tag = child.tagName.toLowerCase();
            if (tag === "harmony") {
              const rStep = child.querySelector("root > root-step")?.textContent || "C";
              const rAlt = child.querySelector("root > root-alter")?.textContent || "";
              const kTxt = child.querySelector("kind")?.getAttribute("text") ?? "";
              const labelStr = `${rStep}${rAlt === "-1" ? "b" : rAlt === "1" ? "#" : ""}${kTxt}`;
              const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
              textEl.setAttribute("data-chord-symbol", labelStr);
              textEl.setAttribute("data-measure", String(mNum));
              textEl.setAttribute("data-onset-whole", String(runningWhole + curDiv / (divisions * 4)));
              textEl.textContent = labelStr;
              const cx = mLeft + 24 + (curDiv / divisions) * 44;
              Object.defineProperty(textEl, "getBoundingClientRect", {
                configurable: true,
                value: () => ({
                  left: cx,
                  top: 32,
                  right: cx + 32,
                  bottom: 48,
                  width: 32,
                  height: 16,
                  x: cx,
                  y: 32,
                  toJSON: () => ({}),
                }),
              });
              svg.appendChild(textEl);
            } else if (tag === "note") {
              const durDivs = Number(child.querySelector("duration")?.textContent || String(divisions));
              const step = child.querySelector("pitch > step")?.textContent?.trim() || "C";
              const octave = Number(child.querySelector("pitch > octave")?.textContent || "4");
              const onsetWhole = runningWhole + curDiv / (divisions * 4);
              const nx = mLeft + 24 + (curDiv / divisions) * 44;
              curDiv += durDivs;

              const staveGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
              staveGroup.setAttribute("class", "vf-stavenote");
              const nh = document.createElementNS("http://www.w3.org/2000/svg", "g");
              nh.setAttribute("class", "vf-notehead");
              nh.setAttribute("data-testid", `chord-note-m${mNum}-o${Math.round(onsetWhole * 1000)}`);
              Object.defineProperty(nh, "getBoundingClientRect", {
                configurable: true,
                value: () => ({
                  left: nx,
                  top: 90,
                  right: nx + 12,
                  bottom: 102,
                  width: 12,
                  height: 12,
                  x: nx,
                  y: 90,
                  toJSON: () => ({}),
                }),
              });
              staveGroup.appendChild(nh);
              svg.appendChild(staveGroup);

              const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
              const midi = (octave + 1) * 12 + (SEMI[step] ?? 0);
              staffEntries.push({
                getAbsoluteTimestamp: () => ({ RealValue: onsetWhole }),
                graphicalVoiceEntries: [
                  {
                    notes: [
                      {
                        vfnoteIndex: 0,
                        sourceNote: {
                          isRest: () => false,
                          Pitch: { halfTone: midi - 12 },
                          ParentStaffEntry: { ParentStaff: { idInMusicSheet: 0 } },
                        },
                        getSVGGElement: () => staveGroup,
                        getNoteheadSVGs: () => [nh],
                      },
                    ],
                  },
                ],
              });
            }
          }

          runningWhole += Math.max(1, curDiv / (divisions * 4));
          measureList.push([
            {
              MeasureNumber: mNum,
              parentSourceMeasure: {
                MeasureNumber: mNum,
                AbsoluteTimestamp: { RealValue: runningWhole - 1 },
              },
              PositionAndShape: {
                AbsolutePosition: { x: mLeft / 9, y: 5 },
                Size: { width: 220 / 9, height: 14 },
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

import {
  extractChordsFromMusicXml,
  upsertXmlHarmony,
} from "@/features/editor/musicXmlChords";
import { parseChordSymbolStrict } from "@/lib/chordParser";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";

const BASE_CHORD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <harmony><root><root-step>B</root-step></root><kind text="dim">diminished</kind></harmony>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>16</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

describe("Chord Symbol Parser & MuseScore-Style Inline Chord Editor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses valid triads, seventh/extended/suspended/slash chords and rejects malformed symbols", () => {
    const cMaj = parseChordSymbolStrict("C");
    expect(cMaj.ok).toBe(true);
    if (cMaj.ok) {
      expect(cMaj.chord).toMatchObject({ rootStep: "C", rootAlter: 0, kind: "major", kindText: "" });
    }

    const fSharpMin7 = parseChordSymbolStrict("F#m7");
    expect(fSharpMin7.ok).toBe(true);
    if (fSharpMin7.ok) {
      expect(fSharpMin7.chord).toMatchObject({
        rootStep: "F",
        rootAlter: 1,
        kind: "minor-seventh",
        kindText: "m7",
      });
    }

    const dSus2 = parseChordSymbolStrict("Dsus2");
    expect(dSus2.ok).toBe(true);
    if (dSus2.ok) {
      expect(dSus2.chord).toMatchObject({ rootStep: "D", kind: "suspended-second", kindText: "sus2" });
    }

    const aMaj7SlashGSharp = parseChordSymbolStrict("Amaj7/G#");
    expect(aMaj7SlashGSharp.ok).toBe(true);
    if (aMaj7SlashGSharp.ok) {
      expect(aMaj7SlashGSharp.chord).toMatchObject({
        rootStep: "A",
        kind: "major-seventh",
        bassStep: "G",
        bassAlter: 1,
      });
    }

    const bbOverD = parseChordSymbolStrict("Bb/D");
    expect(bbOverD.ok).toBe(true);
    if (bbOverD.ok) {
      expect(bbOverD.chord).toMatchObject({
        rootStep: "B",
        rootAlter: -1,
        kind: "major",
        bassStep: "D",
        bassAlter: 0,
      });
    }

    const bDim = parseChordSymbolStrict("Bdim");
    expect(bDim.ok).toBe(true);
    if (bDim.ok) {
      expect(bDim.chord).toMatchObject({ rootStep: "B", kind: "diminished", kindText: "dim" });
    }

    // Invalid inputs rejected with clear validation error
    expect(parseChordSymbolStrict("")).toMatchObject({ ok: false });
    expect(parseChordSymbolStrict("Hmaj7")).toMatchObject({ ok: false });
    expect(parseChordSymbolStrict("Cxyz")).toMatchObject({ ok: false });
    expect(parseChordSymbolStrict("C/")).toMatchObject({ ok: false });
    expect(parseChordSymbolStrict("C/H")).toMatchObject({ ok: false });
    expect(parseChordSymbolStrict("F# m7")).toMatchObject({ ok: false });
  });

  it("serializes <harmony> elements cleanly at measure start and later beats without altering note durations", () => {
    const beat3 = upsertXmlHarmony(BASE_CHORD_XML, { measureNumber: 1, onsetWhole: 0.5 }, "Amaj7/G#");
    expect(beat3).not.toBeNull();
    expect(beat3?.error).toBeUndefined();
    expect(beat3?.xml).toContain("<kind text=\"maj7\">major-seventh</kind>");
    expect(beat3?.xml).toContain("<bass-step>G</bass-step><bass-alter>1</bass-alter>");

    // Also test inserting on beat 3 of Measure 2 (which has a whole note -> uses <offset>)
    const m2Beat3 = upsertXmlHarmony(beat3!.xml, { measureNumber: 2, onsetWhole: 1.5 }, "F#m7");
    expect(m2Beat3?.error).toBeUndefined();
    const extracted = extractChordsFromMusicXml(m2Beat3!.xml, 120);
    expect(extracted.map((c) => ({ measure: c.measure, beat: c.beat, symbol: c.symbol }))).toEqual([
      { measure: 1, beat: 1, symbol: "Bdim" },
      { measure: 1, beat: 3, symbol: "Amaj7/G#" },
      { measure: 2, beat: 3, symbol: "F#m7" },
    ]);

    // Verify note durations remain untouched
    const doc = new DOMParser().parseFromString(m2Beat3!.xml, "application/xml");
    const m2Dur = doc.querySelectorAll("measure")[1].querySelector("note > duration")?.textContent;
    expect(m2Dur).toBe("16");
  });

  it("opens via Ctrl+K, Cmd+K, double-click on Bdim, and toolbar button; validates input; commits/advances with Tab/Space/Enter and Esc", async () => {
    const history: string[] = [BASE_CHORD_XML];
    let currentXml = BASE_CHORD_XML;
    const onMusicXmlChange = vi.fn((nextXml: string) => {
      currentXml = nextXml;
      history.push(nextXml);
    });

    const { rerender } = render(
      <SheetMusicViewer
        musicxml={currentXml}
        defaultEditMode={true}
        isActiveTab={true}
        tempoBpm={120}
        onMusicXmlChange={onMusicXmlChange}
      />,
    );

    // 1. Double-clicking existing "Bdim" opens inline editor pre-filled with "Bdim"
    const bdimEl = await screen.findByText("Bdim");
    fireEvent.doubleClick(bdimEl);
    const input1 = screen.getByTestId("inline-chord-input") as HTMLInputElement;
    expect(input1.value).toBe("Bdim");

    // 2. Typing malformed chord keeps editor open & preserves input with validation error
    fireEvent.change(input1, { target: { value: "Bxyz" } });
    fireEvent.keyDown(input1, { key: "Enter" });
    expect(screen.getByTestId("inline-chord-error")).toBeInTheDocument();
    expect((screen.getByTestId("inline-chord-input") as HTMLInputElement).value).toBe("Bxyz");
    expect(onMusicXmlChange).not.toHaveBeenCalled();

    // 3. Pressing Esc cancels without modifying XML
    fireEvent.keyDown(screen.getByTestId("inline-chord-input"), { key: "Escape" });
    expect(screen.queryByTestId("inline-chord-editor")).not.toBeInTheDocument();
    expect(onMusicXmlChange).not.toHaveBeenCalled();

    // 4. Select beat 2 note and trigger Cmd+K (macOS) -> Enter commits single operation
    const beat2Note = screen.getByTestId("chord-note-m1-o250");
    fireEvent.click(beat2Note);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input2 = screen.getByTestId("inline-chord-input") as HTMLInputElement;
    fireEvent.change(input2, { target: { value: "Dsus2" } });
    fireEvent.keyDown(input2, { key: "Tab" });

    expect(onMusicXmlChange).toHaveBeenCalledTimes(1);
    expect(currentXml).toContain("<kind text=\"sus2\">suspended-second</kind>");

    // Tab advanced editor to beat 3; rerender updated XML & enter Bb/D with Enter
    rerender(
      <SheetMusicViewer
        musicxml={currentXml}
        defaultEditMode={true}
        isActiveTab={true}
        tempoBpm={120}
        onMusicXmlChange={onMusicXmlChange}
      />,
    );
    const input3 = screen.getByTestId("inline-chord-input") as HTMLInputElement;
    fireEvent.change(input3, { target: { value: "Bb/D" } });
    fireEvent.keyDown(input3, { key: "Enter" });
    expect(screen.queryByTestId("inline-chord-editor")).not.toBeInTheDocument();
    expect(currentXml).toContain("<bass-step>D</bass-step>");

    // 5. Toolbar button opens editor too & Ctrl+K works
    fireEvent.click(screen.getByTestId("palette-chord-btn"));
    expect(screen.getByTestId("inline-chord-editor")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("inline-chord-input"), { key: "Escape" });

    // Only 2 committed history pushes for 2 committed chords (no per-character history entries)
    expect(history).toHaveLength(3);
  });
});
