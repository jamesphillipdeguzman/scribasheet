import { buildMusicXmlTimeline, wholeNotesToTimeSec } from "@/features/editor/musicXmlTimeline";
import { prepareDisplayMusicXml } from "@/features/editor/musicXmlNormalization";
import type { SnapGridMode } from "@/features/editor/midiRecordingUtils";
import {
  clampKeyFifths,
  computeShortestKeyInterval,
  formatKeySignatureName,
  formatPitchLabel,
  getKeySignatureAlterForStep,
  type KeyMode,
  type KeySignatureState,
  parseKeySignature,
  respellChordSymbol,
  spellMidiPitch,
  STEP_TO_PC,
} from "@/lib/keySignature";
import type { ScoreNote, ScoreTrack } from "@/types/api";

export type EditableNoteType = "64th" | "32nd" | "16th" | "eighth" | "quarter" | "half" | "whole";
export type XmlAccidentalType = "flat-flat" | "flat" | "natural" | "sharp" | "double-sharp";
export type XmlArticulationType = "marcato" | "accent" | "tenuto" | "staccato";
export type PlaygroundClefMode = "grand" | "treble" | "bass";

export interface XmlNoteTarget {
  partIndex: number;
  measureNumber: number;
  onsetWhole: number;
  pitchMidi: number | null;
  staffNumber?: number;
  voice?: string;
  noteIndex?: number;
}

export interface XmlNoteInfo {
  durationType: EditableNoteType | null;
  dotted: boolean;
  accidental: XmlAccidentalType | null;
  hasTieStart: boolean;
  hasTieStop: boolean;
  hasSlurStart: boolean;
  hasSlurStop: boolean;
  articulations: XmlArticulationType[];
  isTriplet: boolean;
  stem: "up" | "down" | null;
  voice: string;
  staff: number;
  clef: "treble" | "bass";
  keyFifths: number;
  isRest: boolean;
  step: string | null;
  alter: number;
  octave: number | null;
  pitchMidi: number | null;
}

export interface DiatonicPitchResult {
  step: string;
  alter: number;
  octave: number;
  midi: number;
  label: string;
}

const DIATONIC_STEPS = ["C", "D", "E", "F", "G", "A", "B"] as const;

export const TYPE_TO_QUARTERS: Record<EditableNoteType, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
  "32nd": 0.125,
  "64th": 0.0625,
};

export { formatPitchLabel, getKeySignatureAlterForStep };

export function computeDiatonicDragPitch(
  origin: { step: string; octave: number; alter?: number },
  diatonicStepDelta: number,
  keyFifths = 0,
): DiatonicPitchResult {
  const originIdx = Math.max(0, DIATONIC_STEPS.indexOf(origin.step.toUpperCase() as (typeof DIATONIC_STEPS)[number]));
  const totalStep = origin.octave * 7 + originIdx + diatonicStepDelta;
  // Clamp between A0 (oct 0, step A -> total 5) and C8 (oct 8, step C -> total 56)
  const clampedTotal = Math.max(5, Math.min(56, totalStep));
  const nextOctave = Math.floor(clampedTotal / 7);
  const nextStep = DIATONIC_STEPS[((clampedTotal % 7) + 7) % 7];
  const nextAlter =
    diatonicStepDelta === 0 && origin.alter !== undefined
      ? origin.alter
      : getKeySignatureAlterForStep(nextStep, keyFifths);
  const midi = Math.max(21, Math.min(108, (nextOctave + 1) * 12 + (STEP_TO_PC[nextStep] ?? 0) + nextAlter));
  return {
    step: nextStep,
    alter: nextAlter,
    octave: nextOctave,
    midi,
    label: formatPitchLabel(nextStep, nextAlter, nextOctave),
  };
}

function parseXmlDoc(xmlStr: string): Document | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(prepareDisplayMusicXml(xmlStr, true), "application/xml");
  return doc.querySelector("parsererror") ? null : doc;
}

function serializeXmlDoc(doc: Document): string {
  const raw = new XMLSerializer().serializeToString(doc);
  return prepareDisplayMusicXml(raw, true);
}

function setElementText(doc: Document, parent: Element, tagName: string, value: string): Element {
  let el = Array.from(parent.children).find((c) => c.tagName.toLowerCase() === tagName.toLowerCase()) || null;
  if (!el) {
    el = doc.createElement(tagName);
    parent.appendChild(el);
  }
  el.textContent = value;
  return el;
}

function getNoteStaffNumber(noteEl: Element): number {
  const txt = noteEl.getElementsByTagName("staff")[0]?.textContent;
  const n = txt ? Number.parseInt(txt, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function getNoteVoice(noteEl: Element): string {
  const txt = noteEl.getElementsByTagName("voice")[0]?.textContent?.trim();
  return txt || "1";
}

function getNoteClef(partEl: Element, upToMeasureIdx: number, staffNumber: number): "treble" | "bass" {
  const measures = Array.from(partEl.getElementsByTagName("measure"));
  let clef: "treble" | "bass" = staffNumber === 2 ? "bass" : "treble";
  for (let i = 0; i <= Math.min(upToMeasureIdx, measures.length - 1); i++) {
    const attrs = measures[i].getElementsByTagName("attributes")[0];
    if (!attrs) continue;
    for (const clefEl of Array.from(attrs.getElementsByTagName("clef"))) {
      const cNum = Number.parseInt(clefEl.getAttribute("number") || "1", 10) || 1;
      if (cNum === staffNumber) {
        const sign = (clefEl.getElementsByTagName("sign")[0]?.textContent || "G").trim().toUpperCase();
        clef = sign === "F" ? "bass" : "treble";
      }
    }
  }
  return clef;
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

/**
 * Ensure a part uses at least targetDivisions (e.g. 48, divisible by 16 and 3)
 * and rescale every duration/backup/forward in that part proportionally so exact rhythm is preserved.
 */
function ensurePartDivisionsAtLeast(doc: Document, partEl: Element, upToMeasureIdx: number, minDivisions = 48): number {
  const { divisions: currentDiv } = getEffectiveDivisionsAndFifths(partEl, upToMeasureIdx);
  if (currentDiv >= minDivisions && currentDiv % 3 === 0 && currentDiv % 16 === 0) {
    return currentDiv;
  }
  const targetDiv = Math.max(48, Math.ceil(currentDiv / 48) * 48);
  const scale = targetDiv / Math.max(1, currentDiv);
  const measures = Array.from(partEl.getElementsByTagName("measure"));
  for (let mIdx = 0; mIdx < measures.length; mIdx++) {
    const m = measures[mIdx];
    const attrs = Array.from(m.children).find((c) => c.tagName.toLowerCase() === "attributes");
    if (attrs) {
      const divEl = attrs.getElementsByTagName("divisions")[0];
      if (divEl || mIdx === 0) {
        setElementText(doc, attrs, "divisions", String(targetDiv));
      }
    }
    for (const child of Array.from(m.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === "note" || tag === "backup" || tag === "forward") {
        const durEl = Array.from(child.children).find((c) => c.tagName.toLowerCase() === "duration");
        if (durEl && durEl.textContent) {
          const oldVal = Number.parseFloat(durEl.textContent);
          if (Number.isFinite(oldVal) && oldVal > 0) {
            durEl.textContent = String(Math.max(1, Math.round(oldVal * scale)));
          }
        }
      }
    }
  }
  return targetDiv;
}

interface TargetMatch {
  noteEl: Element;
  partEl: Element;
  measureEl: Element;
  measureIdx: number;
  noteIdxInMeasure: number;
  divisions: number;
  fifths: number;
  staffNumber: number;
  voice: string;
}

function findTargetNoteElement(doc: Document, target: XmlNoteTarget): TargetMatch | null {
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
    let noteCounter = 0;

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
        const curNoteIdx = noteCounter++;
        const isChord = child.getElementsByTagName("chord").length > 0;
        const noteDiv = isChord ? lastNoteStartDiv : offsetDiv;
        const noteWhole = curWhole + noteDiv / (divisions * 4);
        const staffNum = getNoteStaffNumber(child);
        const voice = getNoteVoice(child);

        const pitchEl = child.getElementsByTagName("pitch")[0];
        let midi: number | null = null;
        if (pitchEl) {
          const step = (pitchEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
          const alter = Number.parseInt(pitchEl.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0;
          const oct = Number.parseInt(pitchEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
          midi = (oct + 1) * 12 + (STEP_TO_PC[step] ?? 0) + alter;
        }

        const measureMatches = mNum === target.measureNumber;
        const noteIdxMatches = target.noteIndex === undefined || curNoteIdx === target.noteIndex;
        const onsetMatches = Math.abs(noteWhole - target.onsetWhole) < 0.015;
        const pitchMatches = target.pitchMidi === null || midi === target.pitchMidi;
        const staffMatches = target.staffNumber === undefined || staffNum === target.staffNumber;

        if (measureMatches && staffMatches && ((target.noteIndex !== undefined && noteIdxMatches && pitchMatches) || (onsetMatches && pitchMatches))) {
          return {
            noteEl: child,
            partEl,
            measureEl: m,
            measureIdx: mIdx,
            noteIdxInMeasure: curNoteIdx,
            divisions,
            fifths,
            staffNumber: staffNum,
            voice,
          };
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

function getOrCreateChild(doc: Document, parent: Element, tagName: string): Element {
  const existing = Array.from(parent.children).find((c) => c.tagName.toLowerCase() === tagName.toLowerCase());
  if (existing) return existing;
  const created = doc.createElement(tagName);
  parent.appendChild(created);
  return created;
}

function findNextPitchedNoteInStream(
  doc: Document,
  startMatch: TargetMatch,
): TargetMatch | null {
  const measures = Array.from(startMatch.partEl.getElementsByTagName("measure"));
  let pastStart = false;
  for (let mIdx = startMatch.measureIdx; mIdx < measures.length; mIdx++) {
    const m = measures[mIdx];
    const notes = Array.from(m.children).filter((c) => c.tagName.toLowerCase() === "note");
    for (let nIdx = 0; nIdx < notes.length; nIdx++) {
      const noteEl = notes[nIdx];
      if (!pastStart) {
        if (noteEl === startMatch.noteEl) {
          pastStart = true;
        }
        continue;
      }
      if (noteEl.getElementsByTagName("rest").length > 0) continue;
      if (noteEl.getElementsByTagName("chord").length > 0) continue;
      const staffNum = getNoteStaffNumber(noteEl);
      const voice = getNoteVoice(noteEl);
      if (staffNum === startMatch.staffNumber && voice === startMatch.voice) {
        const { divisions, fifths } = getEffectiveDivisionsAndFifths(startMatch.partEl, mIdx);
        return {
          noteEl,
          partEl: startMatch.partEl,
          measureEl: m,
          measureIdx: mIdx,
          noteIdxInMeasure: nIdx,
          divisions,
          fifths,
          staffNumber: staffNum,
          voice,
        };
      }
    }
  }
  void doc;
  return null;
}

export function getXmlNoteInfo(xmlStr: string, target: XmlNoteTarget): XmlNoteInfo | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl, partEl, measureIdx, fifths, staffNumber, voice } = found;
  const rawType = (noteEl.getElementsByTagName("type")[0]?.textContent || "").trim().toLowerCase();
  const durationType: EditableNoteType | null =
    rawType === "64th" ||
    rawType === "32nd" ||
    rawType === "16th" ||
    rawType === "eighth" ||
    rawType === "quarter" ||
    rawType === "half" ||
    rawType === "whole"
      ? rawType
      : null;

  const dotted = noteEl.getElementsByTagName("dot").length > 0;

  const accText = (noteEl.getElementsByTagName("accidental")[0]?.textContent || "").trim().toLowerCase();
  let accidental: XmlAccidentalType | null = null;
  if (
    accText === "flat-flat" ||
    accText === "flat" ||
    accText === "natural" ||
    accText === "sharp" ||
    accText === "double-sharp"
  ) {
    accidental = accText;
  } else {
    const alterEl = noteEl.getElementsByTagName("alter")[0];
    const alterVal = alterEl ? Number.parseInt(alterEl.textContent || "0", 10) : 0;
    if (alterVal === 2) accidental = "double-sharp";
    else if (alterVal === 1) accidental = "sharp";
    else if (alterVal === -1) accidental = "flat";
    else if (alterVal === -2) accidental = "flat-flat";
  }

  const tieEls = Array.from(noteEl.getElementsByTagName("tie"));
  const hasTieStart = tieEls.some((t) => t.getAttribute("type") === "start");
  const hasTieStop = tieEls.some((t) => t.getAttribute("type") === "stop");

  const slurEls = Array.from(noteEl.getElementsByTagName("slur"));
  const hasSlurStart = slurEls.some((s) => s.getAttribute("type") === "start");
  const hasSlurStop = slurEls.some((s) => s.getAttribute("type") === "stop");

  const articulations: XmlArticulationType[] = [];
  const artRoot = noteEl.getElementsByTagName("articulations")[0];
  if (artRoot) {
    if (artRoot.getElementsByTagName("strong-accent").length > 0) articulations.push("marcato");
    if (artRoot.getElementsByTagName("accent").length > 0) articulations.push("accent");
    if (artRoot.getElementsByTagName("tenuto").length > 0) articulations.push("tenuto");
    if (artRoot.getElementsByTagName("staccato").length > 0) articulations.push("staccato");
  }

  const timeMod = noteEl.getElementsByTagName("time-modification")[0];
  const isTriplet =
    Boolean(timeMod) && timeMod.getElementsByTagName("actual-notes")[0]?.textContent?.trim() === "3";

  const stemTxt = (noteEl.getElementsByTagName("stem")[0]?.textContent || "").trim().toLowerCase();
  const stem: "up" | "down" | null = stemTxt === "up" || stemTxt === "down" ? stemTxt : null;

  const isRest = noteEl.getElementsByTagName("rest").length > 0;
  const pitchEl = noteEl.getElementsByTagName("pitch")[0];
  const step = pitchEl ? (pitchEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase() : null;
  const alter = pitchEl ? Number.parseInt(pitchEl.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0 : 0;
  const octave = pitchEl ? Number.parseInt(pitchEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4 : null;
  const pitchMidi =
    step !== null && octave !== null
      ? Math.max(0, Math.min(127, (octave + 1) * 12 + (STEP_TO_PC[step] ?? 0) + alter))
      : null;

  return {
    durationType,
    dotted,
    accidental,
    hasTieStart,
    hasTieStop,
    hasSlurStart,
    hasSlurStop,
    articulations,
    isTriplet,
    stem,
    voice,
    staff: staffNumber,
    clef: getNoteClef(partEl, measureIdx, staffNumber),
    keyFifths: fifths,
    isRest,
    step,
    alter,
    octave,
    pitchMidi,
  };
}

function alterToAccidentalName(alter: number): XmlAccidentalType {
  if (alter === 2) return "double-sharp";
  if (alter === 1) return "sharp";
  if (alter === -1) return "flat";
  if (alter === -2) return "flat-flat";
  return "natural";
}

/**
 * Recompute measure-scoped <accidental> elements across every measure in a part
 * so key-signature accidentals are suppressed while chromatic and cancellation accidentals are emitted.
 */
function recomputePartAccidentals(doc: Document, partEl: Element): void {
  const measures = Array.from(partEl.getElementsByTagName("measure"));
  let activeFifths = 0;

  for (const m of measures) {
    const attrs = Array.from(m.children).find((c) => c.tagName.toLowerCase() === "attributes");
    const fifthsTxt = attrs?.getElementsByTagName("fifths")[0]?.textContent;
    if (fifthsTxt !== undefined && fifthsTxt !== null && fifthsTxt.trim() !== "") {
      const f = Number.parseInt(fifthsTxt, 10);
      if (Number.isFinite(f)) activeFifths = clampKeyFifths(f);
    }

    const measureState = new Map<string, number>();
    for (const child of Array.from(m.children)) {
      if (child.tagName.toLowerCase() !== "note") continue;
      if (child.getElementsByTagName("rest").length > 0) continue;
      const pitchEl = child.getElementsByTagName("pitch")[0];
      if (!pitchEl) continue;

      const step = (pitchEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
      const alter = Number.parseInt(pitchEl.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0;
      const octave = Number.parseInt(pitchEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
      const staff = getNoteStaffNumber(child);
      const stateKey = `${staff}:${step}:${octave}`;

      const expectedAlter = measureState.get(stateKey) ?? getKeySignatureAlterForStep(step, activeFifths);
      const existingAcc = child.getElementsByTagName("accidental")[0];

      if (alter !== expectedAlter) {
        setElementText(doc, child, "accidental", alterToAccidentalName(alter));
        measureState.set(stateKey, alter);
      } else if (existingAcc) {
        existingAcc.parentNode?.removeChild(existingAcc);
      }
    }
  }
}

export function extractKeySignatureFromXml(xmlStr: string | null | undefined): KeySignatureState {
  if (!xmlStr) return { fifths: 0, mode: "major", label: "C Major" };
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return { fifths: 0, mode: "major", label: "C Major" };
  const keyEl = doc.getElementsByTagName("key")[0];
  if (!keyEl) return { fifths: 0, mode: "major", label: "C Major" };
  const rawFifths = Number.parseInt(keyEl.getElementsByTagName("fifths")[0]?.textContent || "0", 10);
  const fifths = Number.isFinite(rawFifths) ? clampKeyFifths(rawFifths) : 0;
  const rawMode = (keyEl.getElementsByTagName("mode")[0]?.textContent || "major").trim().toLowerCase();
  const mode: KeyMode = rawMode === "minor" ? "minor" : "major";
  return { fifths, mode, label: formatKeySignatureName(fifths, mode) };
}

export function setXmlNotePitch(
  xmlStr: string,
  target: XmlNoteTarget,
  nextPitch: { step: string; octave: number; alter: number },
): { xml: string; nextTarget: XmlNoteTarget } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl, partEl } = found;
  const restEl = noteEl.getElementsByTagName("rest")[0];
  if (restEl) noteEl.removeChild(restEl);

  const step = nextPitch.step.trim().toUpperCase();
  const alter = Math.max(-2, Math.min(2, Math.round(nextPitch.alter)));
  const octave = Math.max(0, Math.min(8, Math.round(nextPitch.octave)));

  let pitchEl = noteEl.getElementsByTagName("pitch")[0];
  if (!pitchEl) {
    pitchEl = doc.createElement("pitch");
    noteEl.insertBefore(pitchEl, noteEl.firstChild);
  }
  setElementText(doc, pitchEl, "step", step);
  if (alter === 0) {
    const altEl = pitchEl.getElementsByTagName("alter")[0];
    if (altEl) pitchEl.removeChild(altEl);
  } else {
    setElementText(doc, pitchEl, "alter", String(alter));
  }
  setElementText(doc, pitchEl, "octave", String(octave));

  recomputePartAccidentals(doc, partEl);

  const nextMidi = Math.max(21, Math.min(108, (octave + 1) * 12 + (STEP_TO_PC[step] ?? 0) + alter));
  return {
    xml: serializeXmlDoc(doc),
    nextTarget: { ...target, pitchMidi: nextMidi },
  };
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

  const spelled = spellMidiPitch(nextMidi, fifths);
  return setXmlNotePitch(xmlStr, target, {
    step: spelled.step,
    alter: spelled.alter,
    octave: spelled.octave,
  });
}

export function setXmlNoteAccidental(
  xmlStr: string,
  target: XmlNoteTarget,
  accidental: XmlAccidentalType,
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
  const alterVal =
    accidental === "double-sharp"
      ? 2
      : accidental === "sharp"
        ? 1
        : accidental === "flat"
          ? -1
          : accidental === "flat-flat"
            ? -2
            : 0;

  if (alterVal === 0) {
    const altEl = pitchEl.getElementsByTagName("alter")[0];
    if (altEl) pitchEl.removeChild(altEl);
  } else {
    setElementText(doc, pitchEl, "alter", String(alterVal));
  }
  setElementText(doc, noteEl, "accidental", accidental);

  const nextMidi = Math.max(21, Math.min(108, (oct + 1) * 12 + (STEP_TO_PC[step] ?? 0) + alterVal));
  return {
    xml: serializeXmlDoc(doc),
    nextTarget: { ...target, pitchMidi: nextMidi },
  };
}

export function setXmlNoteDuration(
  xmlStr: string,
  target: XmlNoteTarget,
  noteType: EditableNoteType,
  options?: { dotted?: boolean; triplet?: boolean },
): { xml: string; nextTarget: XmlNoteTarget } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl, partEl, measureEl, measureIdx } = found;
  const divisions = ensurePartDivisionsAtLeast(doc, partEl, measureIdx, 48);

  const dotted = options?.dotted ?? noteEl.getElementsByTagName("dot").length > 0;
  const isTriplet =
    options?.triplet ??
    noteEl.getElementsByTagName("time-modification")[0]?.getElementsByTagName("actual-notes")[0]?.textContent?.trim() ===
      "3";

  let newDur = divisions * TYPE_TO_QUARTERS[noteType];
  if (dotted) newDur *= 1.5;
  if (isTriplet) newDur *= 2 / 3;
  const safeDur = Math.max(1, Math.round(newDur));

  const applyToNote = (el: Element) => {
    setElementText(doc, el, "duration", String(safeDur));
    setElementText(doc, el, "type", noteType);
    const existingDots = Array.from(el.getElementsByTagName("dot"));
    for (const d of existingDots) d.parentNode?.removeChild(d);
    if (dotted) {
      const typeEl = el.getElementsByTagName("type")[0];
      const dotEl = doc.createElement("dot");
      if (typeEl && typeEl.nextSibling) el.insertBefore(dotEl, typeEl.nextSibling);
      else el.appendChild(dotEl);
    }
  };

  applyToNote(noteEl);
  // Keep simultaneous <chord/> sibling notes synchronized in duration & type
  const siblings = Array.from(measureEl.children).filter((c) => c.tagName.toLowerCase() === "note");
  const idx = siblings.indexOf(noteEl);
  if (idx >= 0) {
    for (let i = idx + 1; i < siblings.length; i++) {
      if (siblings[i].getElementsByTagName("chord").length === 0) break;
      applyToNote(siblings[i]);
    }
  }

  return {
    xml: serializeXmlDoc(doc),
    nextTarget: target,
  };
}

export function toggleXmlNoteDot(
  xmlStr: string,
  target: XmlNoteTarget,
): { xml: string; dotted: boolean } | null {
  const info = getXmlNoteInfo(xmlStr, target);
  if (!info) return null;
  const nextDotted = !info.dotted;
  const noteType: EditableNoteType = info.durationType || "quarter";
  const res = setXmlNoteDuration(xmlStr, target, noteType, { dotted: nextDotted, triplet: info.isTriplet });
  if (!res) return null;
  return { xml: res.xml, dotted: nextDotted };
}

export function toggleXmlNoteTie(
  xmlStr: string,
  target: XmlNoteTarget,
): { xml: string; changed: boolean; message?: string } {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return { xml: xmlStr, changed: false, message: "Unable to parse MusicXML." };
  const found = findTargetNoteElement(doc, target);
  if (!found) return { xml: xmlStr, changed: false, message: "Select a pitched note to tie." };

  const pitchA = found.noteEl.getElementsByTagName("pitch")[0];
  if (!pitchA) {
    return { xml: xmlStr, changed: false, message: "Rests cannot be tied." };
  }

  const nextMatch = findNextPitchedNoteInStream(doc, found);
  if (!nextMatch) {
    return { xml: xmlStr, changed: false, message: "No following note found in this voice to tie." };
  }

  const pitchB = nextMatch.noteEl.getElementsByTagName("pitch")[0];
  if (!pitchB) {
    return { xml: xmlStr, changed: false, message: "Ties require two consecutive notes of the same pitch." };
  }

  const sig = (p: Element) => {
    const s = (p.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
    const a = (p.getElementsByTagName("alter")[0]?.textContent || "0").trim();
    const o = (p.getElementsByTagName("octave")[0]?.textContent || "4").trim();
    return `${s}:${a}:${o}`;
  };

  if (sig(pitchA) !== sig(pitchB)) {
    return { xml: xmlStr, changed: false, message: "Ties require two consecutive notes of the same pitch." };
  }

  const hasStart = Array.from(found.noteEl.getElementsByTagName("tie")).some(
    (t) => t.getAttribute("type") === "start",
  );

  const removeTieType = (el: Element, tieType: "start" | "stop") => {
    for (const t of Array.from(el.getElementsByTagName("tie"))) {
      if (t.getAttribute("type") === tieType) t.parentNode?.removeChild(t);
    }
    for (const t of Array.from(el.getElementsByTagName("tied"))) {
      if (t.getAttribute("type") === tieType) t.parentNode?.removeChild(t);
    }
  };

  if (hasStart) {
    removeTieType(found.noteEl, "start");
    removeTieType(nextMatch.noteEl, "stop");
  } else {
    const tStart = doc.createElement("tie");
    tStart.setAttribute("type", "start");
    found.noteEl.appendChild(tStart);
    const notA = getOrCreateChild(doc, found.noteEl, "notations");
    const tdStart = doc.createElement("tied");
    tdStart.setAttribute("type", "start");
    notA.appendChild(tdStart);

    const tStop = doc.createElement("tie");
    tStop.setAttribute("type", "stop");
    nextMatch.noteEl.appendChild(tStop);
    const notB = getOrCreateChild(doc, nextMatch.noteEl, "notations");
    const tdStop = doc.createElement("tied");
    tdStop.setAttribute("type", "stop");
    notB.appendChild(tdStop);
  }

  return { xml: serializeXmlDoc(doc), changed: true };
}

export function toggleXmlNoteSlur(
  xmlStr: string,
  startTarget: XmlNoteTarget,
  endTarget?: XmlNoteTarget | null,
): { xml: string; changed: boolean; message?: string } {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return { xml: xmlStr, changed: false, message: "Unable to parse MusicXML." };
  const startMatch = findTargetNoteElement(doc, startTarget);
  if (!startMatch) return { xml: xmlStr, changed: false, message: "Select a start note for the slur." };
  if (startMatch.noteEl.getElementsByTagName("rest").length > 0) {
    return { xml: xmlStr, changed: false, message: "Slurs must start on a pitched note." };
  }

  const endMatch = endTarget ? findTargetNoteElement(doc, endTarget) : findNextPitchedNoteInStream(doc, startMatch);
  if (!endMatch || endMatch.noteEl === startMatch.noteEl) {
    return { xml: xmlStr, changed: false, message: "No target end note found for slur." };
  }

  const existingStart = Array.from(startMatch.noteEl.getElementsByTagName("slur")).find(
    (s) => s.getAttribute("type") === "start",
  );
  const existingStop = Array.from(endMatch.noteEl.getElementsByTagName("slur")).find(
    (s) => s.getAttribute("type") === "stop",
  );

  if (existingStart && existingStop) {
    existingStart.parentNode?.removeChild(existingStart);
    existingStop.parentNode?.removeChild(existingStop);
  } else {
    const notStart = getOrCreateChild(doc, startMatch.noteEl, "notations");
    if (!existingStart) {
      const s1 = doc.createElement("slur");
      s1.setAttribute("type", "start");
      s1.setAttribute("number", "1");
      notStart.appendChild(s1);
    }
    const notEnd = getOrCreateChild(doc, endMatch.noteEl, "notations");
    if (!existingStop) {
      const s2 = doc.createElement("slur");
      s2.setAttribute("type", "stop");
      s2.setAttribute("number", "1");
      notEnd.appendChild(s2);
    }
  }

  return { xml: serializeXmlDoc(doc), changed: true };
}

export function toggleXmlNoteArticulation(
  xmlStr: string,
  target: XmlNoteTarget,
  articulation: XmlArticulationType,
): { xml: string; active: boolean } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;
  if (found.noteEl.getElementsByTagName("rest").length > 0) return null;

  const tagName = articulation === "marcato" ? "strong-accent" : articulation;
  const notations = getOrCreateChild(doc, found.noteEl, "notations");
  const artEl = getOrCreateChild(doc, notations, "articulations");
  const existing = Array.from(artEl.children).find((c) => c.tagName.toLowerCase() === tagName);

  let active = false;
  if (existing) {
    artEl.removeChild(existing);
    if (artEl.children.length === 0) notations.removeChild(artEl);
    active = false;
  } else {
    const el = doc.createElement(tagName);
    if (articulation === "marcato") el.setAttribute("type", "up");
    artEl.appendChild(el);
    active = true;
  }

  return { xml: serializeXmlDoc(doc), active };
}

export function toggleXmlNoteTriplet(
  xmlStr: string,
  target: XmlNoteTarget,
): { xml: string; isTriplet: boolean } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl, partEl, measureIdx } = found;
  const divisions = ensurePartDivisionsAtLeast(doc, partEl, measureIdx, 48);

  const existingTimeMod = noteEl.getElementsByTagName("time-modification")[0];
  const wasTriplet =
    Boolean(existingTimeMod) &&
    existingTimeMod.getElementsByTagName("actual-notes")[0]?.textContent?.trim() === "3";

  const rawType = (noteEl.getElementsByTagName("type")[0]?.textContent || "eighth").trim().toLowerCase();
  const baseType: EditableNoteType =
    rawType in TYPE_TO_QUARTERS ? (rawType as EditableNoteType) : "eighth";
  const dotted = noteEl.getElementsByTagName("dot").length > 0;

  let baseDur = divisions * TYPE_TO_QUARTERS[baseType];
  if (dotted) baseDur *= 1.5;

  if (wasTriplet) {
    if (existingTimeMod) noteEl.removeChild(existingTimeMod);
    for (const tup of Array.from(noteEl.getElementsByTagName("tuplet"))) {
      tup.parentNode?.removeChild(tup);
    }
    setElementText(doc, noteEl, "duration", String(Math.max(1, Math.round(baseDur))));
    return { xml: serializeXmlDoc(doc), isTriplet: false };
  }

  const timeMod = doc.createElement("time-modification");
  const actual = doc.createElement("actual-notes");
  actual.textContent = "3";
  const normal = doc.createElement("normal-notes");
  normal.textContent = "2";
  timeMod.appendChild(actual);
  timeMod.appendChild(normal);
  noteEl.appendChild(timeMod);

  const notations = getOrCreateChild(doc, noteEl, "notations");
  if (notations.getElementsByTagName("tuplet").length === 0) {
    const tuplet = doc.createElement("tuplet");
    tuplet.setAttribute("type", "start");
    tuplet.setAttribute("bracket", "yes");
    notations.appendChild(tuplet);
  }
  setElementText(doc, noteEl, "duration", String(Math.max(1, Math.round((baseDur * 2) / 3))));

  return { xml: serializeXmlDoc(doc), isTriplet: true };
}

export function flipXmlNoteStem(
  xmlStr: string,
  target: XmlNoteTarget,
): { xml: string; stem: "up" | "down" } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl, partEl, measureIdx, staffNumber } = found;
  if (noteEl.getElementsByTagName("rest").length > 0) return null;

  const currentStem = (noteEl.getElementsByTagName("stem")[0]?.textContent || "").trim().toLowerCase();
  let nextStem: "up" | "down";
  if (currentStem === "up") {
    nextStem = "down";
  } else if (currentStem === "down") {
    nextStem = "up";
  } else {
    const pitchEl = noteEl.getElementsByTagName("pitch")[0];
    const step = (pitchEl?.getElementsByTagName("step")[0]?.textContent || "B").trim().toUpperCase();
    const oct = Number.parseInt(pitchEl?.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
    const diatonicPos = oct * 7 + Math.max(0, DIATONIC_STEPS.indexOf(step as (typeof DIATONIC_STEPS)[number]));
    const clef = getNoteClef(partEl, measureIdx, staffNumber);
    const middleLinePos = clef === "bass" ? 3 * 7 + 1 : 4 * 7 + 6; // D3 (22) or B4 (34)
    nextStem = diatonicPos >= middleLinePos ? "up" : "down";
  }

  setElementText(doc, noteEl, "stem", nextStem);
  return { xml: serializeXmlDoc(doc), stem: nextStem };
}

export function setXmlNoteVoice(
  xmlStr: string,
  target: XmlNoteTarget,
  voice: "1" | "2",
): { xml: string; voice: "1" | "2" } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl, measureEl, staffNumber } = found;
  setElementText(doc, noteEl, "voice", voice);

  // If Voice 2 is introduced on the same staff and no <backup> exists between voices, insert one if needed
  const staffNotes = Array.from(measureEl.children).filter(
    (c) => c.tagName.toLowerCase() === "note" && getNoteStaffNumber(c) === staffNumber,
  );
  const v1Notes = staffNotes.filter((n) => getNoteVoice(n) === "1" && n.getElementsByTagName("chord").length === 0);
  if (voice === "2" && v1Notes.length > 0 && measureEl.getElementsByTagName("backup").length === 0) {
    const totalV1Dur = v1Notes.reduce(
      (sum, n) => sum + (Number.parseFloat(n.getElementsByTagName("duration")[0]?.textContent || "0") || 0),
      0,
    );
    if (totalV1Dur > 0) {
      const backupEl = doc.createElement("backup");
      setElementText(doc, backupEl, "duration", String(Math.round(totalV1Dur)));
      measureEl.insertBefore(backupEl, noteEl);
    }
  }

  return { xml: serializeXmlDoc(doc), voice };
}

export function convertXmlNoteToRest(xmlStr: string, target: XmlNoteTarget): { xml: string } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl, partEl } = found;
  for (const tag of ["pitch", "chord", "tie", "accidental", "stem"]) {
    for (const el of Array.from(noteEl.getElementsByTagName(tag))) {
      el.parentNode?.removeChild(el);
    }
  }
  const notEl = noteEl.getElementsByTagName("notations")[0];
  if (notEl) noteEl.removeChild(notEl);

  if (!noteEl.getElementsByTagName("rest")[0]) {
    const restEl = doc.createElement("rest");
    noteEl.insertBefore(restEl, noteEl.firstChild);
  }
  recomputePartAccidentals(doc, partEl);
  return { xml: serializeXmlDoc(doc) };
}

/**
 * Delete an individual selected note or chord tone:
 * - Within a chord: removes ONLY the selected note, promoting the next chord sibling if needed.
 * - Sole note at its onset: converts that rhythmic slot to a rest preserving duration/staff/voice.
 */
export function deleteXmlNote(
  xmlStr: string,
  target: XmlNoteTarget,
): { xml: string; deletedChordTone: boolean } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl, measureEl, partEl } = found;
  const isChordChild = noteEl.getElementsByTagName("chord").length > 0;
  const nextEl = noteEl.nextElementSibling;
  const hasChordFollower =
    Boolean(nextEl) &&
    nextEl!.tagName.toLowerCase() === "note" &&
    nextEl!.getElementsByTagName("chord").length > 0;

  if (isChordChild || hasChordFollower) {
    if (!isChordChild && hasChordFollower && nextEl) {
      const followerChordTag = nextEl.getElementsByTagName("chord")[0];
      if (followerChordTag) nextEl.removeChild(followerChordTag);
    }
    measureEl.removeChild(noteEl);
    recomputePartAccidentals(doc, partEl);
    return { xml: serializeXmlDoc(doc), deletedChordTone: true };
  }

  const restConverted = convertXmlNoteToRest(xmlStr, target);
  if (!restConverted) return null;
  return { xml: restConverted.xml, deletedChordTone: false };
}

export function applyKeySignatureToMusicXml(
  xmlStr: string,
  options: {
    targetFifths: number;
    targetMode: KeyMode;
    action: "respell" | "transpose";
    fromFifths?: number;
    fromMode?: KeyMode;
  },
): { xml: string; semitoneDelta: number } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;

  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length === 0) return null;

  const currentKey = extractKeySignatureFromXml(xmlStr);
  const oldFifths = options.fromFifths ?? currentKey.fifths;
  const oldMode = options.fromMode ?? currentKey.mode;
  const targetFifths = clampKeyFifths(options.targetFifths);
  const targetMode: KeyMode = options.targetMode === "minor" ? "minor" : "major";

  const semitoneDelta =
    options.action === "transpose"
      ? computeShortestKeyInterval(oldFifths, oldMode, targetFifths, targetMode)
      : 0;

  for (const partEl of parts) {
    const measures = Array.from(partEl.getElementsByTagName("measure"));
    if (measures.length > 0) {
      const m1 = measures[0];
      const attrs = getOrCreateChild(doc, m1, "attributes");
      const keyEl = getOrCreateChild(doc, attrs, "key");
      setElementText(doc, keyEl, "fifths", String(targetFifths));
      setElementText(doc, keyEl, "mode", targetMode);
    }

    // Re-spell or transpose every pitched note in this part
    for (const noteEl of Array.from(partEl.getElementsByTagName("note"))) {
      if (noteEl.getElementsByTagName("rest").length > 0) continue;
      const pitchEl = noteEl.getElementsByTagName("pitch")[0];
      if (!pitchEl) continue;

      const step = (pitchEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
      const alter = Number.parseInt(pitchEl.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0;
      const oct = Number.parseInt(pitchEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
      const curMidi = (oct + 1) * 12 + (STEP_TO_PC[step] ?? 0) + alter;
      const nextMidi = Math.max(21, Math.min(108, curMidi + semitoneDelta));
      const spelled = spellMidiPitch(nextMidi, targetFifths);

      setElementText(doc, pitchEl, "step", spelled.step);
      if (spelled.alter === 0) {
        const altEl = pitchEl.getElementsByTagName("alter")[0];
        if (altEl) pitchEl.removeChild(altEl);
      } else {
        setElementText(doc, pitchEl, "alter", String(spelled.alter));
      }
      setElementText(doc, pitchEl, "octave", String(spelled.octave));
    }

    // Re-spell / transpose <harmony> root & bass elements
    for (const harmEl of Array.from(partEl.getElementsByTagName("harmony"))) {
      const rootEl = harmEl.getElementsByTagName("root")[0];
      const rootStepEl = rootEl?.getElementsByTagName("root-step")[0];
      if (rootEl && rootStepEl?.textContent) {
        const rs = rootStepEl.textContent.trim().toUpperCase();
        const ra = Number.parseInt(rootEl.getElementsByTagName("root-alter")[0]?.textContent || "0", 10) || 0;
        const kindText = harmEl.getElementsByTagName("kind")[0]?.getAttribute("text") || "";
        const bassEl = harmEl.getElementsByTagName("bass")[0];
        const bs = bassEl?.getElementsByTagName("bass-step")[0]?.textContent?.trim().toUpperCase();
        const ba = Number.parseInt(bassEl?.getElementsByTagName("bass-alter")[0]?.textContent || "0", 10) || 0;
        const rawSym =
          `${rs}${ra === 1 ? "#" : ra === -1 ? "b" : ""}${kindText}` +
          (bs ? `/${bs}${ba === 1 ? "#" : ba === -1 ? "b" : ""}` : "");
        const updated = respellChordSymbol(rawSym, targetFifths, semitoneDelta);
        const [newMain, newBass] = updated.symbol.split("/", 2);
        const rm = newMain.match(/^([A-G])([#b]?)/);
        if (rm) {
          setElementText(doc, rootEl, "root-step", rm[1]);
          if (rm[2]) setElementText(doc, rootEl, "root-alter", rm[2] === "#" ? "1" : "-1");
          else {
            const existingRa = rootEl.getElementsByTagName("root-alter")[0];
            if (existingRa) rootEl.removeChild(existingRa);
          }
        }
        if (bassEl && newBass) {
          const bm = newBass.match(/^([A-G])([#b]?)/);
          if (bm) {
            setElementText(doc, bassEl, "bass-step", bm[1]);
            if (bm[2]) setElementText(doc, bassEl, "bass-alter", bm[2] === "#" ? "1" : "-1");
            else {
              const existingBa = bassEl.getElementsByTagName("bass-alter")[0];
              if (existingBa) bassEl.removeChild(existingBa);
            }
          }
        }
      }
    }

    recomputePartAccidentals(doc, partEl);
  }

  return { xml: serializeXmlDoc(doc), semitoneDelta };
}

export function updateXmlScoreHeader(
  xmlStr: string,
  options: {
    keySignature?: string;
    timeSignature?: string;
    tempoBpm?: number;
    clefMode?: PlaygroundClefMode;
  },
): string | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;

  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length === 0) return null;

  if (options.keySignature !== undefined) {
    const parsed = parseKeySignature(options.keySignature);
    for (const partEl of parts) {
      const m1 = partEl.getElementsByTagName("measure")[0];
      if (!m1) continue;
      const attrs = getOrCreateChild(doc, m1, "attributes");
      const keyEl = getOrCreateChild(doc, attrs, "key");
      setElementText(doc, keyEl, "fifths", String(parsed.fifths));
      setElementText(doc, keyEl, "mode", parsed.mode);
      recomputePartAccidentals(doc, partEl);
    }
  }

  const partEl = parts[0];
  const measures = Array.from(partEl.getElementsByTagName("measure"));
  if (measures.length === 0) return null;
  const m1 = measures[0];
  const attrs = getOrCreateChild(doc, m1, "attributes");

  if (options.timeSignature !== undefined && options.timeSignature.includes("/")) {
    const [bStr, btStr] = options.timeSignature.split("/", 2);
    const beats = Math.max(1, Math.min(16, Number.parseInt(bStr.trim(), 10) || 4));
    const beatType = Math.max(1, Math.min(16, Number.parseInt(btStr.trim(), 10) || 4));
    const timeEl = getOrCreateChild(doc, attrs, "time");
    setElementText(doc, timeEl, "beats", String(beats));
    setElementText(doc, timeEl, "beat-type", String(beatType));
  }

  if (options.tempoBpm !== undefined) {
    const bpm = Math.round(Math.max(30, Math.min(240, options.tempoBpm)));
    const soundEl = doc.getElementsByTagName("sound")[0];
    if (soundEl) {
      soundEl.setAttribute("tempo", String(bpm));
    } else {
      const dir = doc.createElement("direction");
      dir.setAttribute("placement", "above");
      const sound = doc.createElement("sound");
      sound.setAttribute("tempo", String(bpm));
      dir.appendChild(sound);
      m1.insertBefore(dir, attrs.nextSibling);
    }
    const perMin = doc.getElementsByTagName("per-minute")[0];
    if (perMin) perMin.textContent = String(bpm);
  }

  if (options.clefMode !== undefined) {
    for (const c of Array.from(attrs.getElementsByTagName("clef"))) {
      c.parentNode?.removeChild(c);
    }
    for (const s of Array.from(attrs.getElementsByTagName("staves"))) {
      s.parentNode?.removeChild(s);
    }
    if (options.clefMode === "grand") {
      setElementText(doc, attrs, "staves", "2");
      const c1 = doc.createElement("clef");
      c1.setAttribute("number", "1");
      setElementText(doc, c1, "sign", "G");
      setElementText(doc, c1, "line", "2");
      const c2 = doc.createElement("clef");
      c2.setAttribute("number", "2");
      setElementText(doc, c2, "sign", "F");
      setElementText(doc, c2, "line", "4");
      attrs.appendChild(c1);
      attrs.appendChild(c2);
    } else {
      const c1 = doc.createElement("clef");
      setElementText(doc, c1, "sign", options.clefMode === "bass" ? "F" : "G");
      setElementText(doc, c1, "line", options.clefMode === "bass" ? "4" : "2");
      attrs.appendChild(c1);
    }
  }

  return serializeXmlDoc(doc);
}

function durationDivsToBestType(divs: number, divisions: number): { type: EditableNoteType; dotted: boolean } {
  const q = divs / Math.max(1, divisions);
  const table: Array<[number, EditableNoteType, boolean]> = [
    [4, "whole", false],
    [3, "half", true],
    [2, "half", false],
    [1.5, "quarter", true],
    [1, "quarter", false],
    [0.75, "eighth", true],
    [0.5, "eighth", false],
    [0.375, "16th", true],
    [0.25, "16th", false],
    [0.125, "32nd", false],
    [0.0625, "64th", false],
  ];
  let best = table[4];
  let bestDiff = Infinity;
  for (const row of table) {
    const diff = Math.abs(q - row[0]);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = row;
    }
  }
  return { type: best[1], dotted: best[2] };
}

function buildRestNoteElementsForDuration(
  doc: Document,
  totalDivs: number,
  divisions: number,
  voice: string,
  staffNumber: number | null,
): Element[] {
  const out: Element[] = [];
  let remaining = Math.round(totalDivs);
  const candidates: Array<[number, EditableNoteType, boolean]> = [
    [divisions * 4, "whole", false],
    [divisions * 3, "half", true],
    [divisions * 2, "half", false],
    [Math.round(divisions * 1.5), "quarter", true],
    [divisions, "quarter", false],
    [Math.round(divisions * 0.75), "eighth", true],
    [Math.round(divisions * 0.5), "eighth", false],
    [Math.round(divisions * 0.25), "16th", false],
    [Math.round(divisions * 0.125), "32nd", false],
    [Math.max(1, Math.round(divisions * 0.0625)), "64th", false],
  ];
  let guard = 0;
  while (remaining > 0 && guard < 16) {
    guard++;
    const match = candidates.find(([d]) => d > 0 && d <= remaining) || [remaining, "16th" as EditableNoteType, false];
    const [usedDivs, rType, rDot] = match;
    const noteEl = doc.createElement("note");
    noteEl.appendChild(doc.createElement("rest"));
    setElementText(doc, noteEl, "duration", String(usedDivs));
    setElementText(doc, noteEl, "voice", voice);
    setElementText(doc, noteEl, "type", rType);
    if (rDot) noteEl.appendChild(doc.createElement("dot"));
    if (staffNumber !== null) setElementText(doc, noteEl, "staff", String(staffNumber));
    out.push(noteEl);
    remaining -= usedDivs;
  }
  return out;
}

function createPitchedNoteElements(
  doc: Document,
  options: {
    pitchesMidi: number[];
    durDivs: number;
    noteType: EditableNoteType;
    dotted: boolean;
    voice: string;
    staffNumber: number | null;
    fifths: number;
  },
): Element[] {
  const sorted = [...options.pitchesMidi].sort((a, b) => a - b);
  return sorted.map((rawMidi, idx) => {
    const midi = Math.max(21, Math.min(108, Math.round(rawMidi)));
    const spelled = spellMidiPitch(midi, options.fifths);
    const noteEl = doc.createElement("note");
    if (idx > 0) noteEl.appendChild(doc.createElement("chord"));
    const pitchEl = doc.createElement("pitch");
    setElementText(doc, pitchEl, "step", spelled.step);
    if (spelled.alter !== 0) setElementText(doc, pitchEl, "alter", String(spelled.alter));
    setElementText(doc, pitchEl, "octave", String(spelled.octave));
    noteEl.appendChild(pitchEl);
    setElementText(doc, noteEl, "duration", String(options.durDivs));
    setElementText(doc, noteEl, "voice", options.voice);
    setElementText(doc, noteEl, "type", options.noteType);
    if (options.dotted) noteEl.appendChild(doc.createElement("dot"));
    if (options.staffNumber !== null) setElementText(doc, noteEl, "staff", String(options.staffNumber));
    return noteEl;
  });
}

export function addMeasureToAllParts(xmlStr: string, afterMeasureNumber?: number): string | null {
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

    let beats = 4;
    let beatType = 4;
    let hasGrandStaves = false;
    for (let i = 0; i <= Math.max(0, refIdx); i++) {
      const attrs = measures[i]?.getElementsByTagName("attributes")[0];
      if (!attrs) continue;
      const stavesEl = attrs.getElementsByTagName("staves")[0];
      if (stavesEl && Number.parseInt(stavesEl.textContent || "1", 10) >= 2) {
        hasGrandStaves = true;
      }
      const timeEl = attrs.getElementsByTagName("time")[0];
      if (timeEl) {
        const b = Number.parseInt(timeEl.getElementsByTagName("beats")[0]?.textContent || "4", 10);
        const bt = Number.parseInt(timeEl.getElementsByTagName("beat-type")[0]?.textContent || "4", 10);
        if (Number.isFinite(b) && b > 0) beats = b;
        if (Number.isFinite(bt) && bt > 0) beatType = bt;
      }
    }

    const measureDiv = Math.max(1, Math.round(divisions * beats * (4 / beatType)));
    const newMeasure = doc.createElement("measure");

    const addRest = (voice: string, staffNum: number | null) => {
      const noteEl = doc.createElement("note");
      const restEl = doc.createElement("rest");
      restEl.setAttribute("measure", "yes");
      noteEl.appendChild(restEl);
      setElementText(doc, noteEl, "duration", String(measureDiv));
      setElementText(doc, noteEl, "voice", voice);
      if (staffNum !== null) setElementText(doc, noteEl, "staff", String(staffNum));
      newMeasure.appendChild(noteEl);
    };

    if (hasGrandStaves) {
      addRest("1", 1);
      const backupEl = doc.createElement("backup");
      setElementText(doc, backupEl, "duration", String(measureDiv));
      newMeasure.appendChild(backupEl);
      addRest("2", 2);
    } else {
      addRest("1", null);
    }

    const refNode = measures[refIdx];
    if (refNode && refNode.nextSibling) {
      partEl.insertBefore(newMeasure, refNode.nextSibling);
    } else {
      partEl.appendChild(newMeasure);
    }

    Array.from(partEl.getElementsByTagName("measure")).forEach((m, idx) => {
      m.setAttribute("number", String(idx + 1));
    });
  }

  return serializeXmlDoc(doc);
}

export function deleteMeasureFromAllParts(xmlStr: string, measureNumber: number): string | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;

  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length === 0) return null;

  for (const partEl of parts) {
    const measures = Array.from(partEl.getElementsByTagName("measure"));
    if (measures.length <= 1) return null;

    const delIdx = measures.findIndex(
      (m, idx) =>
        (Number.parseInt(m.getAttribute("number") || String(idx + 1), 10) || idx + 1) ===
        measureNumber,
    );
    if (delIdx < 0) continue;

    const removed = measures[delIdx];
    if (delIdx === 0 && measures[1]) {
      const attrs = removed.getElementsByTagName("attributes")[0];
      if (attrs && !measures[1].getElementsByTagName("attributes")[0]) {
        measures[1].insertBefore(attrs.cloneNode(true), measures[1].firstChild);
      }
      const tempoDir = Array.from(removed.children).find(
        (c) => c.tagName.toLowerCase() === "direction" && c.getElementsByTagName("sound").length > 0,
      );
      if (tempoDir && !Array.from(measures[1].children).some((c) => c.tagName.toLowerCase() === "direction" && c.getElementsByTagName("sound").length > 0)) {
        const nextAttrs = measures[1].getElementsByTagName("attributes")[0];
        if (nextAttrs && nextAttrs.nextSibling) {
          measures[1].insertBefore(tempoDir.cloneNode(true), nextAttrs.nextSibling);
        } else {
          measures[1].insertBefore(tempoDir.cloneNode(true), measures[1].firstChild);
        }
      }
    }

    // Preserve final barline if deleting the last measure
    const removedBarline = Array.from(removed.children).find(
      (c) => c.tagName.toLowerCase() === "barline" && c.getAttribute("location") === "right",
    );

    // Clear orphaned cross-bar ties on adjacent measures
    if (delIdx > 0) {
      for (const t of Array.from(measures[delIdx - 1].getElementsByTagName("tie"))) {
        if (t.getAttribute("type") === "start") t.parentNode?.removeChild(t);
      }
      for (const t of Array.from(measures[delIdx - 1].getElementsByTagName("tied"))) {
        if (t.getAttribute("type") === "start") t.parentNode?.removeChild(t);
      }
    }
    if (delIdx + 1 < measures.length) {
      for (const t of Array.from(measures[delIdx + 1].getElementsByTagName("tie"))) {
        if (t.getAttribute("type") === "stop") t.parentNode?.removeChild(t);
      }
      for (const t of Array.from(measures[delIdx + 1].getElementsByTagName("tied"))) {
        if (t.getAttribute("type") === "stop") t.parentNode?.removeChild(t);
      }
    }

    partEl.removeChild(removed);
    const remaining = Array.from(partEl.getElementsByTagName("measure"));
    remaining.forEach((m, idx) => {
      m.setAttribute("number", String(idx + 1));
    });
    if (removedBarline && remaining.length > 0) {
      const newLast = remaining[remaining.length - 1];
      if (newLast.getElementsByTagName("barline").length === 0) {
        newLast.appendChild(removedBarline.cloneNode(true));
      }
    }
    recomputePartAccidentals(doc, partEl);
  }

  return serializeXmlDoc(doc);
}

/**
 * Step-time MIDI insertion: inserts single notes, chords, or rests into the target staff/voice
 * at the active cursor (or first rest), splitting long rests cleanly and advancing the cursor.
 */
export function insertStepMidiNotesIntoXml(
  xmlStr: string,
  options: {
    pitchesMidi: number[];
    durationType: EditableNoteType;
    dotted: boolean;
    isRest?: boolean;
    voice?: "1" | "2";
    staffNumber?: 1 | 2;
    cursorTarget?: XmlNoteTarget | null;
  },
): { xml: string; nextCursorTarget: XmlNoteTarget | null } | null {
  let workingXml = xmlStr;
  let doc = parseXmlDoc(workingXml);
  if (!doc) return null;

  const partIndex = options.cursorTarget?.partIndex ?? 0;
  let partEl = doc.getElementsByTagName("part")[partIndex] || doc.getElementsByTagName("part")[0];
  if (!partEl) return null;

  const hasTwoStaves =
    Number.parseInt(partEl.getElementsByTagName("staves")[0]?.textContent || "1", 10) >= 2;
  const targetStaff: number | null = hasTwoStaves ? options.staffNumber ?? options.cursorTarget?.staffNumber ?? 1 : null;
  const targetVoice = options.voice || (targetStaff === 2 ? "2" : "1");

  const divisions = ensurePartDivisionsAtLeast(doc, partEl, 0, 48);
  const { fifths } = getEffectiveDivisionsAndFifths(partEl, 0);
  const rawDurDivs = divisions * TYPE_TO_QUARTERS[options.durationType] * (options.dotted ? 1.5 : 1);
  const insertDivs = Math.max(1, Math.round(rawDurDivs));

  let targetMatch: TargetMatch | null = options.cursorTarget
    ? findTargetNoteElement(doc, options.cursorTarget)
    : null;

  if (!targetMatch) {
    const measures = Array.from(partEl.getElementsByTagName("measure"));
    outer: for (let mIdx = 0; mIdx < measures.length; mIdx++) {
      const m = measures[mIdx];
      const children = Array.from(m.children).filter((c) => c.tagName.toLowerCase() === "note");
      for (let nIdx = 0; nIdx < children.length; nIdx++) {
        const n = children[nIdx];
        if (n.getElementsByTagName("rest").length === 0) continue;
        if (targetStaff !== null && getNoteStaffNumber(n) !== targetStaff) continue;
        targetMatch = {
          noteEl: n,
          partEl,
          measureEl: m,
          measureIdx: mIdx,
          noteIdxInMeasure: nIdx,
          divisions,
          fifths,
          staffNumber: getNoteStaffNumber(n),
          voice: getNoteVoice(n),
        };
        break outer;
      }
    }
  }

  if (!targetMatch) {
    const extended = addMeasureToAllParts(serializeXmlDoc(doc));
    if (!extended) return null;
    workingXml = extended;
    doc = parseXmlDoc(workingXml);
    if (!doc) return null;
    partEl = doc.getElementsByTagName("part")[partIndex] || doc.getElementsByTagName("part")[0];
    if (!partEl) return null;
    const measures = Array.from(partEl.getElementsByTagName("measure"));
    const lastM = measures[measures.length - 1];
    const lastNotes = Array.from(lastM.children).filter((c) => c.tagName.toLowerCase() === "note");
    const chosen =
      lastNotes.find((n) => targetStaff === null || getNoteStaffNumber(n) === targetStaff) || lastNotes[0];
    if (!chosen) return null;
    targetMatch = {
      noteEl: chosen,
      partEl,
      measureEl: lastM,
      measureIdx: measures.length - 1,
      noteIdxInMeasure: lastNotes.indexOf(chosen),
      divisions,
      fifths,
      staffNumber: getNoteStaffNumber(chosen),
      voice: getNoteVoice(chosen),
    };
  }

  const { noteEl, measureEl, measureIdx } = targetMatch;
  const oldDurDivs = Math.max(1, Math.round(Number.parseFloat(noteEl.getElementsByTagName("duration")[0]?.textContent || "0") || divisions));

  // Collect chord siblings attached right after noteEl so we replace the full chord slot cleanly
  const toRemove: Element[] = [noteEl];
  let sib = noteEl.nextElementSibling;
  while (sib && sib.tagName.toLowerCase() === "note" && sib.getElementsByTagName("chord").length > 0) {
    toRemove.push(sib);
    sib = sib.nextElementSibling;
  }

  const effectiveVoice = options.voice || getNoteVoice(noteEl) || targetVoice;
  const actualDur = Math.min(insertDivs, oldDurDivs);
  const actualSpec =
    actualDur === insertDivs
      ? { type: options.durationType, dotted: options.dotted }
      : durationDivsToBestType(actualDur, divisions);

  const newElements =
    options.isRest || options.pitchesMidi.length === 0
      ? buildRestNoteElementsForDuration(doc, actualDur, divisions, effectiveVoice, targetStaff)
      : createPitchedNoteElements(doc, {
          pitchesMidi: options.pitchesMidi,
          durDivs: actualDur,
          noteType: actualSpec.type,
          dotted: actualSpec.dotted,
          voice: effectiveVoice,
          staffNumber: targetStaff,
          fifths,
        });

  const remainderDivs = oldDurDivs - actualDur;
  const remainderRests =
    remainderDivs > 0
      ? buildRestNoteElementsForDuration(doc, remainderDivs, divisions, effectiveVoice, targetStaff)
      : [];

  const anchor = toRemove[0];
  for (const el of [...newElements, ...remainderRests]) {
    measureEl.insertBefore(el, anchor);
  }
  for (const oldEl of toRemove) {
    measureEl.removeChild(oldEl);
  }
  recomputePartAccidentals(doc, partEl);

  // Locate next slot cursor (either remainder rest, next slot in measure, or next measure's first slot)
  const serialized = serializeXmlDoc(doc);
  const nextDoc = parseXmlDoc(serialized);
  if (!nextDoc) return { xml: serialized, nextCursorTarget: null };
  const nextPart = nextDoc.getElementsByTagName("part")[partIndex] || nextDoc.getElementsByTagName("part")[0];
  const nextMeasures = Array.from(nextPart.getElementsByTagName("measure"));
  const curMeasure = nextMeasures[measureIdx];
  const curMeasureNum = Number.parseInt(curMeasure?.getAttribute("number") || String(measureIdx + 1), 10) || measureIdx + 1;

  let nextCursorTarget: XmlNoteTarget | null = null;
  if (remainderRests.length > 0) {
    const mNotes = Array.from(curMeasure.children).filter((c) => c.tagName.toLowerCase() === "note");
    const firstRest = mNotes.find(
      (n) =>
        n.getElementsByTagName("rest").length > 0 &&
        (targetStaff === null || getNoteStaffNumber(n) === targetStaff),
    );
    if (firstRest) {
      nextCursorTarget = {
        partIndex,
        measureNumber: curMeasureNum,
        onsetWhole: 0,
        pitchMidi: null,
        staffNumber: targetStaff ?? 1,
        noteIndex: mNotes.indexOf(firstRest),
      };
    }
  } else {
    for (let mI = measureIdx + 1; mI < nextMeasures.length; mI++) {
      const m = nextMeasures[mI];
      const mNum = Number.parseInt(m.getAttribute("number") || String(mI + 1), 10) || mI + 1;
      const mNotes = Array.from(m.children).filter((c) => c.tagName.toLowerCase() === "note");
      const slot = mNotes.find((n) => targetStaff === null || getNoteStaffNumber(n) === targetStaff);
      if (slot) {
        nextCursorTarget = {
          partIndex,
          measureNumber: mNum,
          onsetWhole: 0,
          pitchMidi: null,
          staffNumber: targetStaff ?? 1,
          noteIndex: mNotes.indexOf(slot),
        };
        break;
      }
    }
  }

  return { xml: serialized, nextCursorTarget };
}

/**
 * Convert quantized recorded MIDI ScoreNote[] directly into grand-staff / treble / bass MusicXML
 * while keeping time signature, key signature, tempo, and measure structure valid.
 */
export function mergeLiveMidiRecordingIntoXml(
  xmlStr: string,
  recordedNotes: ScoreNote[],
  options: {
    tempoBpm: number;
    timeSignature: string;
    snapMode: SnapGridMode;
    clefMode?: PlaygroundClefMode;
    splitPointMidi?: number;
  },
): string | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc || recordedNotes.length === 0) return null;

  const partEl = doc.getElementsByTagName("part")[0];
  if (!partEl) return null;

  const [bStr, btStr] = (options.timeSignature || "4/4").split("/", 2);
  const beats = Math.max(1, Math.min(16, Number.parseInt(bStr, 10) || 4));
  const beatType = Math.max(1, Math.min(16, Number.parseInt(btStr, 10) || 4));

  const divisions = ensurePartDivisionsAtLeast(doc, partEl, 0, 48);
  const { fifths } = getEffectiveDivisionsAndFifths(partEl, 0);
  const measureDivs = Math.max(1, Math.round(divisions * beats * (4 / beatType)));
  const secPerBeat = 60 / Math.max(30, options.tempoBpm || 120);
  const divPerSec = divisions / secPerBeat;

  const stepDivs =
    options.snapMode === "1/8" ? divisions / 2 : options.snapMode === "1/16" ? divisions / 4 : Math.max(3, divisions / 8);

  const quantizedEvents = recordedNotes.map((n) => {
    const rawStart = Math.max(0, Math.round((n.onset_sec * divPerSec) / stepDivs) * stepDivs);
    const rawEnd = Math.max(rawStart + stepDivs, Math.round((n.offset_sec * divPerSec) / stepDivs) * stepDivs);
    return {
      pitchMidi: n.pitch_midi,
      startDiv: Math.round(rawStart),
      endDiv: Math.round(rawEnd),
    };
  });

  const maxEndDiv = quantizedEvents.reduce((m, e) => Math.max(m, e.endDiv), measureDivs);
  const neededMeasures = Math.max(1, Math.ceil(maxEndDiv / measureDivs));
  const existingMeasures = Array.from(partEl.getElementsByTagName("measure")).length;

  let workingXml = serializeXmlDoc(doc);
  for (let m = existingMeasures; m < neededMeasures; m++) {
    const added = addMeasureToAllParts(workingXml);
    if (added) workingXml = added;
  }

  const nextDoc = parseXmlDoc(workingXml);
  if (!nextDoc) return null;
  const nextPart = nextDoc.getElementsByTagName("part")[0];
  const hasTwoStaves =
    options.clefMode === "grand" ||
    Number.parseInt(nextPart.getElementsByTagName("staves")[0]?.textContent || "1", 10) >= 2;
  const splitMidi = options.splitPointMidi ?? 60;

  const measures = Array.from(nextPart.getElementsByTagName("measure"));

  const populateStaffInMeasure = (
    mEl: Element,
    mStartDiv: number,
    mEndDiv: number,
    staffEvents: typeof quantizedEvents,
    voice: string,
    staffNumber: number | null,
  ) => {
    // Group events by clipped onset within measure
    const clipped = staffEvents
      .filter((e) => e.endDiv > mStartDiv && e.startDiv < mEndDiv)
      .map((e) => ({
        pitchMidi: e.pitchMidi,
        start: Math.max(0, e.startDiv - mStartDiv),
        end: Math.min(measureDivs, e.endDiv - mStartDiv),
      }))
      .filter((e) => e.end > e.start);

    const byOnset = new Map<number, typeof clipped>();
    for (const ev of clipped) {
      if (!byOnset.has(ev.start)) byOnset.set(ev.start, []);
      byOnset.get(ev.start)!.push(ev);
    }
    const sortedOnsets = Array.from(byOnset.keys()).sort((a, b) => a - b);

    let cursor = 0;
    for (let i = 0; i < sortedOnsets.length; i++) {
      const onset = sortedOnsets[i];
      if (onset > cursor) {
        const gapRests = buildRestNoteElementsForDuration(nextDoc, onset - cursor, divisions, voice, staffNumber);
        for (const r of gapRests) mEl.appendChild(r);
        cursor = onset;
      }
      const nextOnset = i + 1 < sortedOnsets.length ? sortedOnsets[i + 1] : measureDivs;
      const chordGroup = byOnset.get(onset)!;
      const maxChordEnd = chordGroup.reduce((m, e) => Math.max(m, e.end), onset);
      const availDur = Math.max(stepDivs, Math.min(maxChordEnd, nextOnset) - onset);
      const spec = durationDivsToBestType(availDur, divisions);
      const noteEls = createPitchedNoteElements(nextDoc, {
        pitchesMidi: chordGroup.map((c) => c.pitchMidi),
        durDivs: Math.round(availDur),
        noteType: spec.type,
        dotted: spec.dotted,
        voice,
        staffNumber,
        fifths,
      });
      for (const ne of noteEls) mEl.appendChild(ne);
      cursor = onset + Math.round(availDur);
    }

    if (cursor < measureDivs) {
      const tailRests = buildRestNoteElementsForDuration(nextDoc, measureDivs - cursor, divisions, voice, staffNumber);
      for (const r of tailRests) mEl.appendChild(r);
    }
  };

  measures.forEach((mEl, mIdx) => {
    // Preserve <attributes> and <direction> in measure 1; clear old notes & backups cleanly
    for (const child of Array.from(mEl.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === "note" || tag === "backup" || tag === "forward") {
        mEl.removeChild(child);
      }
    }
    const mStartDiv = mIdx * measureDivs;
    const mEndDiv = mStartDiv + measureDivs;

    if (hasTwoStaves) {
      const rhEvents = quantizedEvents.filter((e) => e.pitchMidi >= splitMidi);
      const lhEvents = quantizedEvents.filter((e) => e.pitchMidi < splitMidi);
      populateStaffInMeasure(mEl, mStartDiv, mEndDiv, rhEvents, "1", 1);
      const backupEl = nextDoc.createElement("backup");
      setElementText(nextDoc, backupEl, "duration", String(measureDivs));
      mEl.appendChild(backupEl);
      populateStaffInMeasure(mEl, mStartDiv, mEndDiv, lhEvents, "2", 2);
    } else {
      populateStaffInMeasure(mEl, mStartDiv, mEndDiv, quantizedEvents, "1", null);
    }
  });

  recomputePartAccidentals(nextDoc, nextPart);
  return serializeXmlDoc(nextDoc);
}

/**
 * Convert a MusicXML document into synchronized ScoreNote[] and durationSeconds
 * so Grid Editor, Practice Cascade, MIDI playback (including articulations & ties), and Save Score stay in sync.
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
    const measures = Array.from(partEl.getElementsByTagName("measure"));
    let divisions = 1;
    let curWhole = 0;
    const activeTies = new Map<string, ScoreNote>();

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
          const staffNum = getNoteStaffNumber(child);
          const trackIndex =
            parts.length === 1 && tracks.length >= 2 && staffNum >= 2
              ? tracks[Math.min(staffNum - 1, tracks.length - 1)]?.index ?? 1
              : tracks[pIdx]?.index ?? pIdx;

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
                let rawOffsetSec = Number(
                  Math.max(onsetSec + 0.05, wholeNotesToTimeSec(timeline, endWhole, fallbackTempoBpm)).toFixed(4),
                );
                maxOffsetSec = Math.max(maxOffsetSec, rawOffsetSec);

                // Apply articulation expressions to playback timing & velocity
                const artEl = child.getElementsByTagName("articulations")[0];
                let velocity = 84;
                if (artEl) {
                  const rawDurSec = Math.max(0.05, rawOffsetSec - onsetSec);
                  if (artEl.getElementsByTagName("staccato").length > 0) {
                    rawOffsetSec = Number((onsetSec + Math.max(0.05, rawDurSec * 0.55)).toFixed(4));
                  } else if (artEl.getElementsByTagName("tenuto").length > 0) {
                    rawOffsetSec = Number((onsetSec + Math.max(0.05, rawDurSec * 0.98)).toFixed(4));
                  }
                  if (artEl.getElementsByTagName("strong-accent").length > 0) {
                    velocity = 114;
                    rawOffsetSec = Number((onsetSec + Math.max(0.05, rawDurSec * 0.8)).toFixed(4));
                  } else if (artEl.getElementsByTagName("accent").length > 0) {
                    velocity = 104;
                  }
                }

                const tieKey = `${trackIndex}:${midi}`;
                const tieEls = Array.from(child.getElementsByTagName("tie"));
                const hasStart = tieEls.some((t) => t.getAttribute("type") === "start");
                const hasStop = tieEls.some((t) => t.getAttribute("type") === "stop");

                if (hasStop && activeTies.has(tieKey)) {
                  const prev = activeTies.get(tieKey)!;
                  prev.offset_sec = Math.max(prev.offset_sec, rawOffsetSec);
                  if (!hasStart) activeTies.delete(tieKey);
                } else {
                  const sn: ScoreNote = {
                    id: `mxml_${pIdx}_${outNotes.length}_${midi}`,
                    pitch_midi: midi,
                    onset_sec: onsetSec,
                    offset_sec: rawOffsetSec,
                    velocity,
                    track_index: trackIndex,
                  };
                  outNotes.push(sn);
                  if (hasStart) activeTies.set(tieKey, sn);
                  else activeTies.delete(tieKey);
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
