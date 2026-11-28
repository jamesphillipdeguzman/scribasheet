import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: function MockLyricOSMD(container: HTMLElement) {
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
        svg.setAttribute("width", "860");
        svg.setAttribute("height", "240");
        Object.defineProperty(container, "getBoundingClientRect", {
          configurable: true,
          value: () => ({
            left: 0,
            top: 0,
            right: 860,
            bottom: 240,
            width: 860,
            height: 240,
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
          const mLeft = 20 + mIdx * 280;
          const staffEntries: unknown[] = [];
          let curDiv = 0;

          for (const child of Array.from(mEl.children)) {
            if (child.tagName.toLowerCase() !== "note") continue;
            const isRest = Boolean(child.querySelector("rest"));
            const durDivs = Number(child.querySelector("duration")?.textContent || String(divisions));
            const step = child.querySelector("pitch > step")?.textContent?.trim() || "C";
            const octave = Number(child.querySelector("pitch > octave")?.textContent || "5");
            const onsetWhole = runningWhole + curDiv / (divisions * 4);
            const nx = mLeft + 24 + (curDiv / divisions) * 48;
            curDiv += durDivs;

            const staveGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
            staveGroup.setAttribute("class", "vf-stavenote");
            const nh = document.createElementNS("http://www.w3.org/2000/svg", "g");
            nh.setAttribute("class", "vf-notehead");
            nh.setAttribute("data-testid", `lyric-note-m${mNum}-o${Math.round(onsetWhole * 1000)}`);
            Object.defineProperty(nh, "getBoundingClientRect", {
              configurable: true,
              value: () => ({
                left: nx,
                top: 84,
                right: nx + 12,
                bottom: 96,
                width: 12,
                height: 12,
                x: nx,
                y: 84,
                toJSON: () => ({}),
              }),
            });
            staveGroup.appendChild(nh);
            svg.appendChild(staveGroup);

            const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
            const midi = (octave + 1) * 12 + (SEMI[step] ?? 0);

            for (const lyr of Array.from(child.querySelectorAll("lyric"))) {
              const txt = lyr.querySelector("text")?.textContent?.trim();
              if (!txt) continue;
              const vNum = lyr.getAttribute("number") || "1";
              const lEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
              lEl.setAttribute("data-lyric-text", txt);
              lEl.setAttribute("data-lyric-verse", vNum);
              lEl.setAttribute("data-measure", String(mNum));
              lEl.setAttribute("data-onset-whole", String(onsetWhole));
              if (!isRest) lEl.setAttribute("data-pitch-midi", String(midi));
              lEl.textContent = txt;
              Object.defineProperty(lEl, "getBoundingClientRect", {
                configurable: true,
                value: () => ({
                  left: nx,
                  top: 130,
                  right: nx + 28,
                  bottom: 146,
                  width: 28,
                  height: 16,
                  x: nx,
                  y: 130,
                  toJSON: () => ({}),
                }),
              });
              svg.appendChild(lEl);
            }

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
                Size: { width: 260 / 9, height: 15 },
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
  extendXmlNoteMelisma,
  extractLyricsDataFromMusicXml,
  getXmlNoteLyric,
  setXmlNoteLyric,
} from "@/features/editor/musicXmlLyrics";
import { prepareDisplayMusicXml } from "@/features/editor/musicXmlNormalization";
import { LyricsPanel } from "@/features/editor/LyricsPanel";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";
import { api } from "@/services/api";

const MELODY_LYRIC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>8</duration><type>half</type></note>
      <note><pitch><step>A</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><rest/><duration>4</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

describe("MuseScore-Style Inline Lyric Entry, Melisma, Verses, and LyricsPanel Sync", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes verses 1..3 independently and preserves melisma <extend> through normalization", () => {
    const t0 = { partIndex: 0, measureNumber: 1, onsetWhole: 0, pitchMidi: 72, staffNumber: 1 };
    const t1 = { partIndex: 0, measureNumber: 1, onsetWhole: 0.25, pitchMidi: 74, staffNumber: 1 };

    const r1 = setXmlNoteLyric(MELODY_LYRIC_XML, t0, 1, { text: "Praise", syllabic: "single" })!;
    const r2 = setXmlNoteLyric(r1.xml, t0, 2, { text: "Hal", syllabic: "begin" })!;
    const r3 = setXmlNoteLyric(r2.xml, t0, 3, { text: "Glory", syllabic: "single" })!;
    const rMel = extendXmlNoteMelisma(r3.xml, t1, 1, "Lord", false)!;

    expect(getXmlNoteLyric(rMel.xml, t0, 1)?.text).toBe("Praise");
    expect(getXmlNoteLyric(rMel.xml, t0, 2)?.text).toBe("Hal");
    expect(getXmlNoteLyric(rMel.xml, t0, 3)?.text).toBe("Glory");

    // Preserve pure <extend type="stop"/> elements during OSMD display normalization
    const normalized = prepareDisplayMusicXml(rMel.xml, true);
    expect(normalized).toContain('<extend type="start"/>');
    expect(normalized).toContain('<extend type="stop"/>');

    const extracted = extractLyricsDataFromMusicXml(rMel.xml, 120);
    expect(extracted?.text).toContain("Praise Lord");
    expect(extracted?.segments.map((s) => s.id)).toEqual(["verse_1", "verse_2", "verse_3"]);
  });

  it("handles hyphenated syllables (A-maz-ing), Space, underscore melisma, verse switching, double-click, Esc, and focus guards", async () => {
    let xml = MELODY_LYRIC_XML;
    const commits: string[] = [xml];
    const onMusicXmlChange = vi.fn((nextXml: string) => {
      xml = nextXml;
      commits.push(nextXml);
    });

    const { rerender } = render(
      <div>
        <input aria-label="Unrelated studio field" />
        <SheetMusicViewer
          musicxml={xml}
          defaultEditMode={true}
          isActiveTab={true}
          tempoBpm={120}
          onMusicXmlChange={onMusicXmlChange}
        />
      </div>,
    );

    // 1. Focus guard: Ctrl+L inside unrelated input must NOT open lyric editor
    const unrelatedInput = screen.getByLabelText("Unrelated studio field");
    unrelatedInput.focus();
    fireEvent.keyDown(unrelatedInput, { key: "l", ctrlKey: true });
    expect(screen.queryByTestId("inline-lyric-editor")).not.toBeInTheDocument();

    // 2. Clicking a rest note and pressing Ctrl+L rejects with helpful message
    const restEl = await screen.findByTestId("lyric-note-m2-o1750");
    fireEvent.click(restEl);
    fireEvent.keyDown(window, { key: "l", ctrlKey: true });
    expect(screen.queryByTestId("inline-lyric-editor")).not.toBeInTheDocument();
    expect(screen.getByTestId("palette-status-message")).toHaveTextContent(/rests cannot carry lyrics/i);

    // 3. Select first note and open with Ctrl+L; enter "A-maz-ing" via '-' then 'Space'
    const n1 = screen.getByTestId("lyric-note-m1-o0");
    fireEvent.click(n1);
    fireEvent.keyDown(window, { key: "l", ctrlKey: true });
    let input = screen.getByTestId("inline-lyric-input") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "A" } });
    fireEvent.keyDown(input, { key: "-" });
    expect(xml).toContain("<syllabic>begin</syllabic><text>A</text>");

    rerender(
      <div>
        <input aria-label="Unrelated studio field" />
        <SheetMusicViewer
          musicxml={xml}
          defaultEditMode={true}
          isActiveTab={true}
          tempoBpm={120}
          onMusicXmlChange={onMusicXmlChange}
        />
      </div>,
    );
    input = screen.getByTestId("inline-lyric-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "maz" } });
    fireEvent.keyDown(input, { key: "-" });
    expect(xml).toContain("<syllabic>middle</syllabic><text>maz</text>");

    rerender(
      <div>
        <input aria-label="Unrelated studio field" />
        <SheetMusicViewer
          musicxml={xml}
          defaultEditMode={true}
          isActiveTab={true}
          tempoBpm={120}
          onMusicXmlChange={onMusicXmlChange}
        />
      </div>,
    );
    input = screen.getByTestId("inline-lyric-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ing" } });
    fireEvent.keyDown(input, { key: " ", code: "Space" });
    expect(xml).toContain("<syllabic>end</syllabic><text>ing</text>");

    // 4. Fourth note: type "grace" with '_' melisma underscore extending into Measure 2
    rerender(
      <div>
        <input aria-label="Unrelated studio field" />
        <SheetMusicViewer
          musicxml={xml}
          defaultEditMode={true}
          isActiveTab={true}
          tempoBpm={120}
          onMusicXmlChange={onMusicXmlChange}
        />
      </div>,
    );
    input = screen.getByTestId("inline-lyric-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "grace" } });
    fireEvent.keyDown(input, { key: "_", shiftKey: true });
    expect(xml).toContain('<extend type="start"/>');
    expect(xml).toContain('<extend type="stop"/>');

    // 5. Switch to Verse 2 in the verse selector and enter "Second" then press Esc to verify Esc does not discard committed syllables
    rerender(
      <div>
        <input aria-label="Unrelated studio field" />
        <SheetMusicViewer
          musicxml={xml}
          defaultEditMode={true}
          isActiveTab={true}
          tempoBpm={120}
          onMusicXmlChange={onMusicXmlChange}
        />
      </div>,
    );
    fireEvent.change(screen.getByTestId("inline-lyric-verse-select"), { target: { value: "2" } });
    input = screen.getByTestId("inline-lyric-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Uncommitted" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("inline-lyric-editor")).not.toBeInTheDocument();
    expect(xml).not.toContain("Uncommitted");
    expect(xml).toContain("<text>A</text>");
    expect(xml).toContain("<text>maz</text>");
    expect(xml).toContain("<text>ing</text>");

    // 6. Double-click rendered "maz" syllable -> opens pre-filled editor; verify LyricsPanel receives synced LyricsData
    const mazSvg = await screen.findByText("maz");
    fireEvent.doubleClick(mazSvg);
    const editMaz = screen.getByTestId("inline-lyric-input") as HTMLInputElement;
    expect(editMaz.value).toBe("maz");
    fireEvent.keyDown(editMaz, { key: "Enter" });

    // Synced canonical LyricsData check via LyricsPanel
    const extracted = extractLyricsDataFromMusicXml(xml, 120)!;
    expect(extracted.text).toBe("Amazing grace");
    vi.spyOn(api, "getLyrics").mockResolvedValue({
      ...extracted,
      text: "",
      segments: [],
      updated_at: "2020-01-01T00:00:00Z",
    });
    render(
      <LyricsPanel
        projectId="p1"
        projectTitle="Amazing Grace"
        hasMedia={false}
        activeJob={null}
        scoreLyrics={extracted}
      />,
    );
    const area = (await screen.findByLabelText(/editable lyrics text/i)) as HTMLTextAreaElement;
    expect(area.value).toBe("Amazing grace");

    // 4 commits: "A", "maz", "ing", "grace_" (Esc & no-op Enter did not add history entries)
    expect(commits).toHaveLength(5);
  });
});
