import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";

let mockMeasureList: unknown[][] = [];

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: function MockOSMD(container: HTMLElement) {
    return {
      load: async () => undefined,
      render: () => {
        container.innerHTML = "";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const stavenote1 = document.createElementNS("http://www.w3.org/2000/svg", "g");
        stavenote1.setAttribute("class", "vf-stavenote");
        const notehead1 = document.createElementNS("http://www.w3.org/2000/svg", "g");
        notehead1.setAttribute("class", "vf-notehead");
        notehead1.setAttribute("data-testid", "mock-notehead-c4");
        const path1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path1.setAttribute("d", "M0 0 L10 0");
        path1.setAttribute("fill", "#000000");
        notehead1.appendChild(path1);
        stavenote1.appendChild(notehead1);

        const stavenote2 = document.createElementNS("http://www.w3.org/2000/svg", "g");
        stavenote2.setAttribute("class", "vf-stavenote");
        const notehead2 = document.createElementNS("http://www.w3.org/2000/svg", "g");
        notehead2.setAttribute("class", "vf-notehead");
        notehead2.setAttribute("data-testid", "mock-notehead-e4");
        const path2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path2.setAttribute("d", "M20 0 L30 0");
        path2.setAttribute("fill", "#000000");
        notehead2.appendChild(path2);
        stavenote2.appendChild(notehead2);

        svg.appendChild(stavenote1);
        svg.appendChild(stavenote2);
        container.appendChild(svg);

        mockMeasureList = [
          [
            {
              MeasureNumber: 1,
              staffEntries: [
                {
                  getAbsoluteTimestamp: () => ({ RealValue: 0 }),
                  graphicalVoiceEntries: [
                    {
                      notes: [
                        {
                          getSVGGElement: () => stavenote1,
                          sourceNote: {
                            Pitch: { halfTone: 48 }, // C4 (48 + 12 = 60)
                            isRest: () => false,
                          },
                        },
                      ],
                    },
                  ],
                },
                {
                  getAbsoluteTimestamp: () => ({ RealValue: 0.25 }),
                  graphicalVoiceEntries: [
                    {
                      notes: [
                        {
                          getSVGGElement: () => stavenote2,
                          sourceNote: {
                            Pitch: { halfTone: 52 }, // E4 (52 + 12 = 64)
                            isRest: () => false,
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        ];
      },
      Dispose: () => undefined,
      Zoom: 1,
      EngravingRules: { RenderChordSymbols: true },
      cursor: {
        cursorElement: document.createElement("img"),
        show: () => undefined,
        hide: () => undefined,
        reset: () => undefined,
        next: () => undefined,
        update: () => undefined,
        GNotesUnderCursor: () => [],
        iterator: { EndReached: true, currentTimeStamp: { RealValue: 0 } },
      },
      get GraphicSheet() {
        return { MeasureList: mockMeasureList };
      },
    };
  },
}));

const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration>
        <type>quarter</type>
      </note>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>2</duration>
        <type>eighth</type>
      </note>
    </measure>
  </part>
</score-partwise>`;

describe("Edit Notation Light-Mode Contrast & Direct Notehead Selection", () => {
  it("applies high-contrast Light Mode and Dark Mode classes to Edit Notation toggle, toolbar, readout, and buttons", () => {
    render(
      <SheetMusicViewer
        musicxml={sampleXml}
        defaultEngine="osmd"
        onMusicXmlChange={vi.fn()}
      />,
    );

    const editBtn = screen.getByRole("button", { name: /Edit notation/i });
    expect(editBtn.className).toContain("bg-white");
    expect(editBtn.className).toContain("text-stone-800");

    fireEvent.click(editBtn);

    expect(editBtn.className).toContain("bg-amber-100");
    expect(editBtn.className).toContain("text-amber-950");
    expect(editBtn.className).toContain("border-amber-400");
    expect(editBtn.className).toContain("dark:bg-amber-500/20");
    expect(editBtn.className).toContain("dark:text-amber-200");

    const toolbar = screen.getByTestId("notation-edit-toolbar");
    expect(toolbar.className).toContain("bg-amber-50/90");
    expect(toolbar.className).toContain("border-amber-300");
    expect(toolbar.className).toContain("dark:bg-amber-500/10");

    const readout = screen.getByTestId("notation-edit-readout");
    expect(readout.textContent).toBe("Click a notehead to edit");
    expect(readout.className).toContain("text-amber-950");
    expect(readout.className).toContain("font-medium");
    expect(readout.className).toContain("dark:text-amber-200");

    // Disabled state on Pitch up before note selection
    const pitchUp = screen.getByRole("button", { name: "Pitch up" });
    expect(pitchUp).toBeDisabled();
    expect(pitchUp.className).toContain("bg-stone-100");
    expect(pitchUp.className).toContain("text-stone-500");
    expect(pitchUp.className).toContain("border-stone-200");

    // Enabled state on Add Measure
    const addMeasure = screen.getByRole("button", { name: "Add measure" });
    expect(addMeasure).not.toBeDisabled();
    expect(addMeasure.className).toContain("bg-white");
    expect(addMeasure.className).toContain("text-stone-800");
    expect(addMeasure.className).toContain("border-stone-300");
  });

  it("auto-activates Edit Notation when clicking a notehead directly, highlights it, supports edits and Escape", async () => {
    const onXmlChange = vi.fn();
    render(
      <SheetMusicViewer
        musicxml={sampleXml}
        defaultEngine="osmd"
        onMusicXmlChange={onXmlChange}
      />,
    );

    // Edit Notation is initially off
    expect(screen.queryByTestId("notation-edit-toolbar")).toBeNull();

    // Wait for OSMD mock render to populate SVG noteheads
    const e4Notehead = await screen.findByTestId("mock-notehead-e4");
    expect(e4Notehead.getAttribute("data-mxml-note")).toBe("true");

    // Click E4 notehead directly while Edit Notation is off
    fireEvent.click(e4Notehead);

    // Edit Notation automatically activates and selects E4 (Eighth)
    expect(screen.getByTestId("notation-edit-toolbar")).toBeTruthy();
    const readout = screen.getByTestId("notation-edit-readout");
    expect(readout.textContent).toContain("Selected: E4 (Eighth)");
    expect(e4Notehead.querySelector("path")?.getAttribute("data-selected-note")).toBe("true");

    // Active duration button ("Eighth") has violet active styling
    const eighthBtn = screen.getByRole("button", { name: "Set duration eighth" });
    expect(eighthBtn.className).toContain("bg-violet-600");
    expect(eighthBtn.className).toContain("text-white");
    expect(eighthBtn.className).toContain("border-violet-700");

    // Pitch up modifies E4 -> F4
    fireEvent.click(screen.getByRole("button", { name: "Pitch up" }));
    await waitFor(() => {
      expect(onXmlChange).toHaveBeenCalledTimes(1);
      expect(onXmlChange.mock.calls[0][0]).toContain("<step>F</step>");
    });

    // Escape deselects and clears highlight, and ignores input targets
    const input = document.createElement("input");
    document.body.appendChild(input);
    const inputEsc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(inputEsc);
    expect(inputEsc.defaultPrevented).toBe(false);
    input.remove();

    const esc = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);

    await waitFor(() => {
      expect(screen.getByTestId("notation-edit-readout").textContent).toBe("Click a notehead to edit");
      expect(e4Notehead.querySelector("path")?.getAttribute("data-selected-note")).toBeNull();
    });
  });
});
