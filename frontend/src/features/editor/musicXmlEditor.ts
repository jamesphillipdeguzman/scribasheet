import { buildMusicXmlTimeline, wholeNotesToTimeSec } from "@/features/editor/musicXmlTimeline";
import { prepareDisplayMusicXml } from "@/features/editor/musicXmlNormalization";
import type { ScoreNote, ScoreTrack } from "@/types/api";

export type EditableNoteType = "whole" | "half" | "quarter" | "eighth" | "16th";

export interface XmlNoteTarget {
  partIndex: number;
  measureNumber: number;
  onsetWhole: number;
  pitchMidi: number | null;
}

const STEP_TO_PC: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const PC_TO_SHARP: Array<{ step: string; alter: number }> = [
  { step: "C", alter: 0 },
  { step: "C", alter: 1 },
  { step: "D", alter: 0 },
  { step: "D", alter: 1 },
  { step: "E", alter: 0 },
  { step: "F", alter: 0 },
  { step: "F", alter: 1 },
  { step: "G", alter: 0 },
  { step: "G", alter: 1 },
  { step: "A", alter: 0 },
  { step: "A", alter: 1 },
  { step: "B", alter: 0 },
];

const PC_TO_FLAT: Array<{ step: string; alter: number }> = [
  { step: "C", alter: 0 },
  { step: "D", alter: -1 },
  { step: "D", alter: 0 },
  { step: "E", alter: -1 },
  { step: "E", alter: 0 },
  { step: "F", alter: 0 },
  { step: "G", alter: -1 },
  { step: "G", alter: 0 },
  { step: "A", alter: -1 },
  { step: "A", alter: 0 },
  { step: "B", alter: -1 },
  { step: "B", alter: 0 },
];

const TYPE_TO_QUARTERS: Record<EditableNoteType, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
};

function parseXmlDoc(xmlStr: string): Document | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(prepareDisplayMusicXml(xmlStr, true), "application/xml");
  return doc.querySelector("parsererror") ? null : doc;
}

function serializeXmlDoc(doc: Document): string {
  const raw = new XMLSerializer().serializeToString(doc);
  return prepareDisplayMusicXml(raw, true);
}

function getEffectiveDivisionsAndFifths(partEl: Element, upToMeasureIdx: number): { divisions: number; fifths: number } {
  const measures = Array.from(partEl.getElementsByTagName("measure"));
  let divisions = 1;
  let fifths = 0;
  for (let i = 0; i <= Math.min(upToMeasureIdx, measures.length - 1); i++) {
    const attrs = measures[i].getElementsByTagName("attributes")[0];
    if (!attrs) continue;
    const divTxt = attrs.getElementsByTagName("divisions")[0]?.textContent;
    const fTxt = attrs.getElementsByTagName("fifths")[0]?.textContent;
    if (divTxt) {
      const d = Number.parseFloat(divTxt);
      if (Number.isFinite(d) && d > 0) divisions = d;
    }
    if (fTxt) {
      const f = Number.parseInt(fTxt, 10);
      if (Number.isFinite(f)) fifths = f;
    }
  }
  return { divisions, fifths };
}

function findTargetNoteElement(
  doc: Document,
  target: XmlNoteTarget,
): { noteEl: Element; partEl: Element; measureIdx: number; divisions: number; fifths: number } | null {
  const parts = Array.from(doc.getElementsByTagName("part"));
  const partEl = parts[target.partIndex];
  if (!partEl) return null;

  const measures = Array.from(partEl.getElementsByTagName("measure"));
  let divisions = 1;
  let fifths = 0;
  let curWhole = 0;

  for (let mIdx = 0; mIdx < measures.length; mIdx++) {
    const m = measures[mIdx];
    const mNum = Number.parseInt(m.getAttribute("number") || String(mIdx + 1), 10) || mIdx + 1;
    let offsetDiv = 0;
    let lastNoteStartDiv = 0;
    let maxDiv = 0;

    for (const child of Array.from(m.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === "attributes") {
        const divTxt = child.getElementsByTagName("divisions")[0]?.textContent;
        const fTxt = child.getElementsByTagName("fifths")[0]?.textContent;
        if (divTxt) {
          const d = Number.parseFloat(divTxt);
          if (Number.isFinite(d) && d > 0) divisions = d;
        }
        if (fTxt) {
          const f = Number.parseInt(fTxt, 10);
          if (Number.isFinite(f)) fifths = f;
        }
      } else if (tag === "backup") {
        const d = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
        if (Number.isFinite(d) && d > 0) offsetDiv = Math.max(0, offsetDiv - d);
      } else if (tag === "forward") {
        const d = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
        if (Number.isFinite(d) && d > 0) {
          offsetDiv += d;
          maxDiv = Math.max(maxDiv, offsetDiv);
        }
      } else if (tag === "note") {
        const isChord = child.getElementsByTagName("chord").length > 0;
        const noteDiv = isChord ? lastNoteStartDiv : offsetDiv;
        const noteWhole = curWhole + noteDiv / (divisions * 4);

        const pitchEl = child.getElementsByTagName("pitch")[0];
        let midi: number | null = null;
        if (pitchEl) {
          const step = (pitchEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
          const alter = Number.parseInt(pitchEl.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0;
          const oct = Number.parseInt(pitchEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
          midi = (oct + 1) * 12 + (STEP_TO_PC[step] ?? 0) + alter;
        }

        const measureMatches = mNum === target.measureNumber;
        const onsetMatches = Math.abs(noteWhole - target.onsetWhole) < 0.015;
        const pitchMatches = target.pitchMidi === null || midi === target.pitchMidi;

        if (measureMatches && onsetMatches && pitchMatches) {
          return { noteEl: child, partEl, measureIdx: mIdx, divisions, fifths };
        }

        if (!isChord && child.getElementsByTagName("grace").length === 0) {
          const dur = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
          lastNoteStartDiv = offsetDiv;
          if (Number.isFinite(dur) && dur > 0) {
            offsetDiv += dur;
            maxDiv = Math.max(maxDiv, offsetDiv);
          }
        }
      }
    }
    curWhole += (maxDiv > 0 ? maxDiv : divisions * 4) / (divisions * 4);
  }
  return null;
}

function setElementText(doc: Document, parent: Element, tagName: string, value: string): Element {
  let el = parent.getElementsByTagName(tagName)[0];
  if (!el) {
    el = doc.createElement(tagName);
    parent.appendChild(el);
  }
  el.textContent = value;
  return el;
}

export function getXmlNoteInfo(
  xmlStr: string,
  target: XmlNoteTarget,
): { durationType: EditableNoteType | null; accidental: "sharp" | "flat" | "natural" | null } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const rawType = (found.noteEl.getElementsByTagName("type")[0]?.textContent || "").trim().toLowerCase();
  const durationType: EditableNoteType | null =
    rawType === "whole" ||
    rawType === "half" ||
    rawType === "quarter" ||
    rawType === "eighth" ||
    rawType === "16th"
      ? rawType
      : null;

  const accText = (found.noteEl.getElementsByTagName("accidental")[0]?.textContent || "").trim().toLowerCase();
  let accidental: "sharp" | "flat" | "natural" | null = null;
  if (accText === "sharp" || accText === "flat" || accText === "natural") {
    accidental = accText;
  } else {
    const alterEl = found.noteEl.getElementsByTagName("alter")[0];
    const alterVal = alterEl ? Number.parseInt(alterEl.textContent || "0", 10) : 0;
    if (alterVal === 1) accidental = "sharp";
    else if (alterVal === -1) accidental = "flat";
  }

  return { durationType, accidental };
}

export function transposeXmlNote(
  xmlStr: string,
  target: XmlNoteTarget,
  semitones: number,
): { xml: string; nextTarget: XmlNoteTarget } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl, fifths } = found;
  const pitchEl = noteEl.getElementsByTagName("pitch")[0];
  if (!pitchEl) return null;

  const step = (pitchEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
  const alter = Number.parseInt(pitchEl.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0;
  const oct = Number.parseInt(pitchEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
  const curMidi = (oct + 1) * 12 + (STEP_TO_PC[step] ?? 0) + alter;
  const nextMidi = Math.max(21, Math.min(108, curMidi + semitones));

  const table = fifths < 0 ? PC_TO_FLAT : PC_TO_SHARP;
  const spelled = table[nextMidi % 12];
  const nextOct = Math.floor(nextMidi / 12) - 1;

  setElementText(doc, pitchEl, "step", spelled.step);
  if (spelled.alter === 0) {
    const altEl = pitchEl.getElementsByTagName("alter")[0];
    if (altEl) pitchEl.removeChild(altEl);
  } else {
    setElementText(doc, pitchEl, "alter", String(spelled.alter));
  }
  setElementText(doc, pitchEl, "octave", String(nextOct));

  return {
    xml: serializeXmlDoc(doc),
    nextTarget: { ...target, pitchMidi: nextMidi },
  };
}

export function setXmlNoteAccidental(
  xmlStr: string,
  target: XmlNoteTarget,
  accidental: "sharp" | "flat" | "natural",
): { xml: string; nextTarget: XmlNoteTarget } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl } = found;
  const pitchEl = noteEl.getElementsByTagName("pitch")[0];
  if (!pitchEl) return null;

  const step = (pitchEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
  const oct = Number.parseInt(pitchEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
  const alterVal = accidental === "sharp" ? 1 : accidental === "flat" ? -1 : 0;

  if (alterVal === 0) {
    const altEl = pitchEl.getElementsByTagName("alter")[0];
    if (altEl) pitchEl.removeChild(altEl);
  } else {
    setElementText(doc, pitchEl, "alter", String(alterVal));
  }
  setElementText(doc, noteEl, "accidental", accidental);

  const nextMidi = (oct + 1) * 12 + (STEP_TO_PC[step] ?? 0) + alterVal;
  return {
    xml: serializeXmlDoc(doc),
    nextTarget: { ...target, pitchMidi: nextMidi },
  };
}

export function setXmlNoteDuration(
  xmlStr: string,
  target: XmlNoteTarget,
  noteType: EditableNoteType,
): { xml: string; nextTarget: XmlNoteTarget } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl, divisions } = found;
  const newDur = Math.max(1, Math.round(divisions * TYPE_TO_QUARTERS[noteType]));
  setElementText(doc, noteEl, "duration", String(newDur));
  setElementText(doc, noteEl, "type", noteType);

  return {
    xml: serializeXmlDoc(doc),
    nextTarget: target,
  };
}

export function convertXmlNoteToRest(
  xmlStr: string,
  target: XmlNoteTarget,
): { xml: string } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl } = found;
  const pitchEl = noteEl.getElementsByTagName("pitch")[0];
  if (pitchEl) noteEl.removeChild(pitchEl);
  const chordEl = noteEl.getElementsByTagName("chord")[0];
  if (chordEl) noteEl.removeChild(chordEl);
  if (!noteEl.getElementsByTagName("rest")[0]) {
    const restEl = doc.createElement("rest");
    noteEl.insertBefore(restEl, noteEl.firstChild);
  }
  return { xml: serializeXmlDoc(doc) };
}

export function addMeasureToAllParts(
  xmlStr: string,
  afterMeasureNumber?: number,
): string | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;

  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length === 0) return null;

  for (const partEl of parts) {
    const measures = Array.from(partEl.getElementsByTagName("measure"));
    const insertIdx =
      afterMeasureNumber !== undefined
        ? measures.findIndex(
            (m, idx) =>
              (Number.parseInt(m.getAttribute("number") || String(idx + 1), 10) || idx + 1) ===
              afterMeasureNumber,
          )
        : measures.length - 1;
    const refIdx = insertIdx >= 0 ? insertIdx : measures.length - 1;
    const { divisions } = getEffectiveDivisionsAndFifths(partEl, Math.max(0, refIdx));

    // Determine active time signature beats/beat-type
    let beats = 4;
    let beatType = 4;
    for (let i = 0; i <= Math.max(0, refIdx); i++) {
      const timeEl = measures[i]?.getElementsByTagName("time")[0];
      if (timeEl) {
        const b = Number.parseInt(timeEl.getElementsByTagName("beats")[0]?.textContent || "4", 10);
        const bt = Number.parseInt(timeEl.getElementsByTagName("beat-type")[0]?.textContent || "4", 10);
        if (Number.isFinite(b) && b > 0) beats = b;
        if (Number.isFinite(bt) && bt > 0) beatType = bt;
      }
    }

    const measureDiv = Math.max(1, Math.round(divisions * beats * (4 / beatType)));
    const newMeasure = doc.createElement("measure");
    const noteEl = doc.createElement("note");
    const restEl = doc.createElement("rest");
    restEl.setAttribute("measure", "yes");
    noteEl.appendChild(restEl);
    setElementText(doc, noteEl, "duration", String(measureDiv));
    setElementText(doc, noteEl, "voice", "1");
    newMeasure.appendChild(noteEl);

    const refNode = measures[refIdx];
    if (refNode && refNode.nextSibling) {
      partEl.insertBefore(newMeasure, refNode.nextSibling);
    } else {
      partEl.appendChild(newMeasure);
    }

    // Renumber sequentially
    Array.from(partEl.getElementsByTagName("measure")).forEach((m, idx) => {
      m.setAttribute("number", String(idx + 1));
    });
  }

  return serializeXmlDoc(doc);
}

export function deleteMeasureFromAllParts(
  xmlStr: string,
  measureNumber: number,
): string | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;

  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length === 0) return null;

  for (const partEl of parts) {
    const measures = Array.from(partEl.getElementsByTagName("measure"));
    if (measures.length <= 1) return null; // Never delete the last remaining measure

    const delIdx = measures.findIndex(
      (m, idx) =>
        (Number.parseInt(m.getAttribute("number") || String(idx + 1), 10) || idx + 1) ===
        measureNumber,
    );
    if (delIdx < 0) continue;

    const removed = measures[delIdx];
    // Preserve leading <attributes> (divisions, key, time, clef) if deleting measure 1
    if (delIdx === 0 && measures[1]) {
      const attrs = removed.getElementsByTagName("attributes")[0];
      if (attrs && !measures[1].getElementsByTagName("attributes")[0]) {
        measures[1].insertBefore(attrs.cloneNode(true), measures[1].firstChild);
      }
    }

    partEl.removeChild(removed);
    Array.from(partEl.getElementsByTagName("measure")).forEach((m, idx) => {
      m.setAttribute("number", String(idx + 1));
    });
  }

  return serializeXmlDoc(doc);
}

/**
 * Convert a MusicXML document into synchronized ScoreNote[] and durationSeconds
 * so Grid Editor, Practice Cascade, MIDI playback, and Save Score stay in sync.
 */
export function musicXmlToScoreNotes(
  xmlStr: string,
  tracks: ScoreTrack[],
  fallbackTempoBpm = 120,
): { notes: ScoreNote[]; durationSeconds: number } {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return { notes: [], durationSeconds: 0 };

  const timeline = buildMusicXmlTimeline(xmlStr, fallbackTempoBpm);
  const parts = Array.from(doc.getElementsByTagName("part"));
  const outNotes: ScoreNote[] = [];
  let maxOffsetSec = timeline.totalSec;

  parts.forEach((partEl, pIdx) => {
    const trackIndex = tracks[pIdx]?.index ?? pIdx;
    const measures = Array.from(partEl.getElementsByTagName("measure"));
    let divisions = 1;
    let curWhole = 0;
    const activeTies = new Map<number, ScoreNote>();

    for (const m of measures) {
      let offsetDiv = 0;
      let lastNoteStartDiv = 0;
      let maxDiv = 0;

      for (const child of Array.from(m.children)) {
        const tag = child.tagName.toLowerCase();
        if (tag === "attributes") {
          const divTxt = child.getElementsByTagName("divisions")[0]?.textContent;
          const d = divTxt ? Number.parseFloat(divTxt) : NaN;
          if (Number.isFinite(d) && d > 0) divisions = d;
        } else if (tag === "backup") {
          const d = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
          if (Number.isFinite(d) && d > 0) offsetDiv = Math.max(0, offsetDiv - d);
        } else if (tag === "forward") {
          const d = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
          if (Number.isFinite(d) && d > 0) {
            offsetDiv += d;
            maxDiv = Math.max(maxDiv, offsetDiv);
          }
        } else if (tag === "note") {
          const isGrace = child.getElementsByTagName("grace").length > 0;
          const isChord = child.getElementsByTagName("chord").length > 0;
          const isRest = child.getElementsByTagName("rest").length > 0;
          const durDiv = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
          const startDiv = isChord ? lastNoteStartDiv : offsetDiv;

          if (!isGrace && Number.isFinite(durDiv) && durDiv > 0) {
            const startWhole = curWhole + startDiv / (divisions * 4);
            const endWhole = curWhole + (startDiv + durDiv) / (divisions * 4);

            if (!isRest) {
              const pitchEl = child.getElementsByTagName("pitch")[0];
              if (pitchEl) {
                const step = (pitchEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
                const alter = Number.parseInt(pitchEl.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0;
                const oct = Number.parseInt(pitchEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
                const midi = Math.max(0, Math.min(127, (oct + 1) * 12 + (STEP_TO_PC[step] ?? 0) + alter));
                const onsetSec = Number(wholeNotesToTimeSec(timeline, startWhole, fallbackTempoBpm).toFixed(4));
                const offsetSec = Number(
                  Math.max(onsetSec + 0.05, wholeNotesToTimeSec(timeline, endWhole, fallbackTempoBpm)).toFixed(4),
                );
                maxOffsetSec = Math.max(maxOffsetSec, offsetSec);

                const tieEls = Array.from(child.getElementsByTagName("tie"));
                const hasStart = tieEls.some((t) => t.getAttribute("type") === "start");
                const hasStop = tieEls.some((t) => t.getAttribute("type") === "stop");

                if (hasStop && activeTies.has(midi)) {
                  const prev = activeTies.get(midi)!;
                  prev.offset_sec = Math.max(prev.offset_sec, offsetSec);
                  if (!hasStart) activeTies.delete(midi);
                } else {
                  const sn: ScoreNote = {
                    id: `mxml_${pIdx}_${outNotes.length}_${midi}`,
                    pitch_midi: midi,
                    onset_sec: onsetSec,
                    offset_sec: offsetSec,
                    velocity: 84,
                    track_index: trackIndex,
                  };
                  outNotes.push(sn);
                  if (hasStart) activeTies.set(midi, sn);
                  else activeTies.delete(midi);
                }
              }
            }

            if (!isChord) {
              lastNoteStartDiv = offsetDiv;
              offsetDiv += durDiv;
              maxDiv = Math.max(maxDiv, offsetDiv);
            }
          }
        }
      }
      curWhole += (maxDiv > 0 ? maxDiv : divisions * 4) / (divisions * 4);
    }
  });

  outNotes.sort((a, b) => a.onset_sec - b.onset_sec || a.track_index - b.track_index || a.pitch_midi - b.pitch_midi);
  return { notes: outNotes, durationSeconds: Number(maxOffsetSec.toFixed(3)) };
}
