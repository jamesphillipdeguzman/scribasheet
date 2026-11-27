import { buildMusicXmlTimeline, wholeNotesToTimeSec } from "@/features/editor/musicXmlTimeline";
import { applyAutomaticBeaming, applyAutomaticBeamingToDoc } from "@/features/editor/musicXmlBeaming";
import { prepareDisplayMusicXml } from "@/features/editor/musicXmlNormalization";
import {
  extractScoreStructure,
  getBeatUnitQuarters,
  getMeasureNumber,
  type NavigationMarkerType,
  validateNavigationMarkers,
  validateVoltaEndings,
} from "@/features/editor/musicXmlStructure";
import type { RecordedScoreNote, SnapGridMode } from "@/features/editor/midiRecordingUtils";
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

export type EditableNoteType =
  | "64th"
  | "32nd"
  | "16th"
  | "eighth"
  | "quarter"
  | "half"
  | "whole"
  | "breve"
  | "long";
export const DURATION_ORDER: readonly EditableNoteType[] = [
  "64th",
  "32nd",
  "16th",
  "eighth",
  "quarter",
  "half",
  "whole",
  "breve",
  "long",
];
export type XmlAccidentalType = "flat-flat" | "flat" | "natural" | "sharp" | "double-sharp";
export type XmlArticulationType = "marcato" | "accent" | "tenuto" | "staccato";
export type PlaygroundClefMode = "grand" | "treble" | "bass";

export const TUPLET_RATIOS: Record<number, { actual: number; normal: number }> = {
  2: { actual: 2, normal: 3 },
  3: { actual: 3, normal: 2 },
  4: { actual: 4, normal: 3 },
  5: { actual: 5, normal: 4 },
  6: { actual: 6, normal: 4 },
  7: { actual: 7, normal: 4 },
  8: { actual: 8, normal: 6 },
  9: { actual: 9, normal: 8 },
};

export interface XmlNoteTarget {
  partIndex: number;
  measureNumber: number;
  onsetWhole: number;
  pitchMidi: number | null;
  staffNumber?: number;
  voice?: string;
  noteIndex?: number;
  noteId?: string;
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
  tupletActual: number | null;
  tupletNormal: number | null;
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
  long: 16,
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
  "32nd": 0.125,
  "64th": 0.0625,
};

export function stepNoteDurationType(
  current: EditableNoteType,
  direction: "double" | "halve",
): EditableNoteType {
  const idx = DURATION_ORDER.indexOf(current);
  const safeIdx = idx >= 0 ? idx : DURATION_ORDER.indexOf("quarter");
  const nextIdx =
    direction === "double"
      ? Math.min(DURATION_ORDER.length - 1, safeIdx + 1)
      : Math.max(0, safeIdx - 1);
  return DURATION_ORDER[nextIdx];
}

export { applyAutomaticBeaming, formatPitchLabel, getKeySignatureAlterForStep };

export type NoteLetter = "A" | "B" | "C" | "D" | "E" | "F" | "G";

export function resolveLetterNotePitch(options: {
  letter: NoteLetter;
  keyFifths: number;
  clef: "treble" | "bass";
  previousMidi?: number | null;
}): DiatonicPitchResult {
  const step = options.letter.toUpperCase() as NoteLetter;
  const alter = getKeySignatureAlterForStep(step, clampKeyFifths(options.keyFifths));
  const stepPc = STEP_TO_PC[step] ?? 0;
  const staffCenterMidi = options.clef === "bass" ? 53 : 67; // F3 in bass, G4 in treble
  // With no previous note context, anchor on middle-C octave (4 for treble, 3 for bass)
  const referenceMidi =
    typeof options.previousMidi === "number" && Number.isFinite(options.previousMidi)
      ? options.previousMidi
      : options.clef === "bass"
        ? 53 // F3 -> lands C3..B3 cleanly around bass staff
        : 65; // F4 -> lands C4..B4 cleanly in treble octave 4

  let bestOctave = options.clef === "bass" ? 3 : 4;
  let bestDist = Infinity;
  let bestCenterDist = Infinity;

  for (let oct = 1; oct <= 7; oct++) {
    const rawMidi = (oct + 1) * 12 + stepPc + alter;
    if (rawMidi < 21 || rawMidi > 108) continue;
    const dist = Math.abs(rawMidi - referenceMidi);
    const centerDist = Math.abs(rawMidi - staffCenterMidi);
    if (dist < bestDist - 0.001 || (Math.abs(dist - bestDist) < 0.001 && centerDist < bestCenterDist)) {
      bestDist = dist;
      bestCenterDist = centerDist;
      bestOctave = oct;
    }
  }

  const midi = Math.max(21, Math.min(108, (bestOctave + 1) * 12 + stepPc + alter));
  return {
    step,
    alter,
    octave: bestOctave,
    midi,
    label: formatPitchLabel(step, alter, bestOctave),
  };
}

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
    const mNum = getMeasureNumber(m, mIdx);
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
    rawType === "whole" ||
    rawType === "breve" ||
    rawType === "long"
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
  const tupletActualRaw = Number.parseInt(
    timeMod?.getElementsByTagName("actual-notes")[0]?.textContent?.trim() || "",
    10,
  );
  const tupletNormalRaw = Number.parseInt(
    timeMod?.getElementsByTagName("normal-notes")[0]?.textContent?.trim() || "",
    10,
  );
  const tupletActual = Number.isFinite(tupletActualRaw) && tupletActualRaw > 0 ? tupletActualRaw : null;
  const tupletNormal = Number.isFinite(tupletNormalRaw) && tupletNormalRaw > 0 ? tupletNormalRaw : null;
  const isTriplet = tupletActual === 3;

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
    tupletActual,
    tupletNormal,
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

function readNoteTupletRatio(noteEl: Element): { actual: number; normal: number } | null {
  const tm = noteEl.getElementsByTagName("time-modification")[0];
  if (!tm) return null;
  const a = Number.parseInt(tm.getElementsByTagName("actual-notes")[0]?.textContent?.trim() || "", 10);
  const n = Number.parseInt(tm.getElementsByTagName("normal-notes")[0]?.textContent?.trim() || "", 10);
  if (Number.isFinite(a) && a >= 2 && Number.isFinite(n) && n >= 1) {
    return { actual: a, normal: n };
  }
  return null;
}

function getTargetChordGroup(measureEl: Element, noteEl: Element): Element[] {
  const mNotes = Array.from(measureEl.children).filter((c) => c.tagName.toLowerCase() === "note");
  const idx = mNotes.indexOf(noteEl);
  if (idx < 0) return [noteEl];
  let rootIdx = idx;
  while (rootIdx > 0 && mNotes[rootIdx].getElementsByTagName("chord").length > 0) {
    rootIdx -= 1;
  }
  const group = [mNotes[rootIdx]];
  for (let i = rootIdx + 1; i < mNotes.length; i++) {
    if (mNotes[i].getElementsByTagName("chord").length === 0) break;
    group.push(mNotes[i]);
  }
  return group;
}

function collectConsecutiveFollowingRestsInLane(
  afterEl: Element,
  measureEl: Element,
  staffNumber: number,
  voice: string,
): { rests: Element[]; totalDivs: number; blockedByNote: boolean } {
  const rests: Element[] = [];
  let totalDivs = 0;
  let blockedByNote = false;
  let seenAfter = false;

  for (const child of Array.from(measureEl.children)) {
    if (!seenAfter) {
      if (child === afterEl) seenAfter = true;
      continue;
    }
    const tag = child.tagName.toLowerCase();
    if (tag === "backup" || tag === "forward") break;
    if (tag !== "note") continue;
    if (getNoteStaffNumber(child) !== staffNumber || getNoteVoice(child) !== voice) continue;
    if (child.getElementsByTagName("chord").length > 0) continue;
    if (child.getElementsByTagName("rest").length > 0) {
      const d = Math.max(0, Math.round(Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0") || 0));
      rests.push(child);
      totalDivs += d;
    } else {
      blockedByNote = true;
      break;
    }
  }
  return { rests, totalDivs, blockedByNote };
}

function collectLeadingRestsInMeasureLane(
  measureEl: Element,
  staffNumber: number,
  voice: string,
): { rests: Element[]; totalDivs: number; insertBeforeEl: Element | null } {
  const rests: Element[] = [];
  let totalDivs = 0;
  let insertBeforeEl: Element | null = null;

  for (const child of Array.from(measureEl.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "backup") break;
    if (tag !== "note") continue;
    if (getNoteStaffNumber(child) !== staffNumber || getNoteVoice(child) !== voice) continue;
    if (child.getElementsByTagName("chord").length > 0) continue;
    if (child.getElementsByTagName("rest").length > 0) {
      const d = Math.max(0, Math.round(Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0") || 0));
      rests.push(child);
      totalDivs += d;
      if (!insertBeforeEl) insertBeforeEl = child;
    } else {
      break;
    }
  }
  return { rests, totalDivs, insertBeforeEl };
}

function addTieMarker(doc: Document, el: Element, tieType: "start" | "stop"): void {
  const existingTie = Array.from(el.getElementsByTagName("tie")).some((t) => t.getAttribute("type") === tieType);
  if (!existingTie) {
    const tEl = doc.createElement("tie");
    tEl.setAttribute("type", tieType);
    const voiceEl = el.getElementsByTagName("voice")[0];
    if (voiceEl) el.insertBefore(tEl, voiceEl);
    else el.appendChild(tEl);
  }
  const notEl = getOrCreateChild(doc, el, "notations");
  const existingTied = Array.from(notEl.getElementsByTagName("tied")).some((t) => t.getAttribute("type") === tieType);
  if (!existingTied) {
    const td = doc.createElement("tied");
    td.setAttribute("type", tieType);
    notEl.appendChild(td);
  }
}

function consumeRestsFromFront(
  doc: Document,
  measureEl: Element,
  rests: Element[],
  consumeDivs: number,
  divisions: number,
  voice: string,
  staffNumber: number | null,
): void {
  let remToConsume = Math.round(consumeDivs);
  for (const rEl of rests) {
    if (remToConsume <= 0) break;
    const rDur = Math.max(0, Math.round(Number.parseFloat(rEl.getElementsByTagName("duration")[0]?.textContent || "0") || 0));
    if (rDur <= remToConsume) {
      remToConsume -= rDur;
      measureEl.removeChild(rEl);
    } else {
      const leftover = rDur - remToConsume;
      remToConsume = 0;
      const replacements = buildRestNoteElementsForDuration(doc, leftover, divisions, voice, staffNumber);
      for (const rep of replacements) {
        measureEl.insertBefore(rep, rEl);
      }
      measureEl.removeChild(rEl);
    }
  }
}

function applyDurationAndTypeToNoteGroup(
  doc: Document,
  group: Element[],
  durDivs: number,
  noteType: EditableNoteType,
  dotted: boolean,
  tupletRatio: { actual: number; normal: number } | null,
): void {
  for (const el of group) {
    setElementText(doc, el, "duration", String(durDivs));
    setElementText(doc, el, "type", noteType);
    for (const d of Array.from(el.getElementsByTagName("dot"))) d.parentNode?.removeChild(d);
    if (dotted) {
      const typeEl = el.getElementsByTagName("type")[0];
      const dotEl = doc.createElement("dot");
      if (typeEl && typeEl.nextSibling) el.insertBefore(dotEl, typeEl.nextSibling);
      else el.appendChild(dotEl);
    }
    for (const tm of Array.from(el.getElementsByTagName("time-modification"))) tm.parentNode?.removeChild(tm);
    for (const tup of Array.from(el.getElementsByTagName("tuplet"))) tup.parentNode?.removeChild(tup);
    if (tupletRatio) {
      const tm = doc.createElement("time-modification");
      setElementText(doc, tm, "actual-notes", String(tupletRatio.actual));
      setElementText(doc, tm, "normal-notes", String(tupletRatio.normal));
      el.appendChild(tm);
      const notations = getOrCreateChild(doc, el, "notations");
      const tup = doc.createElement("tuplet");
      tup.setAttribute("type", "start");
      tup.setAttribute("bracket", "yes");
      notations.appendChild(tup);
    }
  }
}

export function setXmlNoteDuration(
  xmlStr: string,
  target: XmlNoteTarget,
  noteType: EditableNoteType,
  options?: {
    dotted?: boolean;
    triplet?: boolean;
    tupletRatio?: { actual: number; normal: number } | null;
    rebalanceMeasure?: boolean;
  },
): { xml: string; nextTarget: XmlNoteTarget; changed: boolean; warning?: string } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl, partEl, measureEl, measureIdx, staffNumber, voice } = found;
  const divisions = ensurePartDivisionsAtLeast(doc, partEl, measureIdx, 48);
  const oldDurDivs = Math.max(
    1,
    Math.round(Number.parseFloat(noteEl.getElementsByTagName("duration")[0]?.textContent || String(divisions)) || divisions),
  );

  const dotted = options?.dotted ?? noteEl.getElementsByTagName("dot").length > 0;
  const existingTuplet = readNoteTupletRatio(noteEl);
  const effectiveTuplet =
    options?.tupletRatio !== undefined
      ? options.tupletRatio
      : options?.triplet !== undefined
        ? options.triplet
          ? { actual: 3, normal: 2 }
          : null
        : existingTuplet;

  let newDur = divisions * TYPE_TO_QUARTERS[noteType];
  if (dotted) newDur *= 1.5;
  if (effectiveTuplet) newDur *= effectiveTuplet.normal / effectiveTuplet.actual;
  const safeDur = Math.max(1, Math.round(newDur));

  const chordGroup = getTargetChordGroup(measureEl, noteEl);
  const groupRoot = chordGroup[0];
  const groupLast = chordGroup[chordGroup.length - 1];
  const hasGrand = computePartHasGrandStaves(partEl, measureIdx);
  const targetStaffNum = hasGrand ? staffNumber : null;

  if (!options?.rebalanceMeasure || safeDur === oldDurDivs) {
    applyDurationAndTypeToNoteGroup(doc, chordGroup, safeDur, noteType, dotted, effectiveTuplet);
    recomputePartAccidentals(doc, partEl);
    applyAutomaticBeamingToDoc(doc, partEl);
    return {
      xml: serializeXmlDoc(doc),
      nextTarget: target,
      changed: true,
    };
  }

  if (safeDur < oldDurDivs) {
    applyDurationAndTypeToNoteGroup(doc, chordGroup, safeDur, noteType, dotted, effectiveTuplet);
    const diff = oldDurDivs - safeDur;
    const trailingRests = buildRestNoteElementsForDuration(doc, diff, divisions, voice, targetStaffNum);
    const insertRef = groupLast.nextSibling;
    for (const r of trailingRests) {
      if (insertRef) measureEl.insertBefore(r, insertRef);
      else measureEl.appendChild(r);
    }
    recomputePartAccidentals(doc, partEl);
    applyAutomaticBeamingToDoc(doc, partEl);
    return {
      xml: serializeXmlDoc(doc),
      nextTarget: target,
      changed: true,
    };
  }

  // Lengthening (safeDur > oldDurDivs) with Measure Auto-Rebalance
  const extra = safeDur - oldDurDivs;
  const following = collectConsecutiveFollowingRestsInLane(groupLast, measureEl, staffNumber, voice);

  if (following.totalDivs >= extra) {
    consumeRestsFromFront(doc, measureEl, following.rests, extra, divisions, voice, targetStaffNum);
    applyDurationAndTypeToNoteGroup(doc, chordGroup, safeDur, noteType, dotted, effectiveTuplet);
    recomputePartAccidentals(doc, partEl);
    applyAutomaticBeamingToDoc(doc, partEl);
    return {
      xml: serializeXmlDoc(doc),
      nextTarget: target,
      changed: true,
    };
  }

  if (following.blockedByNote) {
    return {
      xml: xmlStr,
      nextTarget: target,
      changed: false,
      warning: "Cannot lengthen note: it would overlap the next note in this measure.",
    };
  }

  // Reached end of measure: check if pitched note can split across the barline with a tie into leading rests of next bar
  const isPitched = groupRoot.getElementsByTagName("rest").length === 0;
  const measures = Array.from(partEl.getElementsByTagName("measure"));
  const nextMeasure = measures[measureIdx + 1];
  const overflow = extra - following.totalDivs;

  if (isPitched && nextMeasure && overflow > 0) {
    const nextLeading = collectLeadingRestsInMeasureLane(nextMeasure, staffNumber, voice);
    if (nextLeading.totalDivs >= overflow && nextLeading.insertBeforeEl) {
      const m1TotalDivs = oldDurDivs + following.totalDivs;
      const m1Spec = durationDivsToBestType(m1TotalDivs, divisions);
      const m2Spec = durationDivsToBestType(overflow, divisions);

      if (following.rests.length > 0) {
        consumeRestsFromFront(doc, measureEl, following.rests, following.totalDivs, divisions, voice, targetStaffNum);
      }
      applyDurationAndTypeToNoteGroup(doc, chordGroup, m1TotalDivs, m1Spec.type, m1Spec.dotted, effectiveTuplet);

      const contAnchor = nextLeading.insertBeforeEl;
      for (const srcNote of chordGroup) {
        addTieMarker(doc, srcNote, "start");
        const clone = srcNote.cloneNode(true) as Element;
        for (const t of Array.from(clone.getElementsByTagName("tie"))) clone.removeChild(t);
        const cloneNots = clone.getElementsByTagName("notations")[0];
        if (cloneNots) {
          for (const td of Array.from(cloneNots.getElementsByTagName("tied"))) cloneNots.removeChild(td);
        }
        setElementText(doc, clone, "duration", String(overflow));
        setElementText(doc, clone, "type", m2Spec.type);
        for (const d of Array.from(clone.getElementsByTagName("dot"))) clone.removeChild(d);
        if (m2Spec.dotted) {
          const typeEl = clone.getElementsByTagName("type")[0];
          const dotEl = doc.createElement("dot");
          if (typeEl && typeEl.nextSibling) clone.insertBefore(dotEl, typeEl.nextSibling);
          else clone.appendChild(dotEl);
        }
        addTieMarker(doc, clone, "stop");
        nextMeasure.insertBefore(clone, contAnchor);
      }
      consumeRestsFromFront(doc, nextMeasure, nextLeading.rests, overflow, divisions, voice, targetStaffNum);
      recomputePartAccidentals(doc, partEl);
      applyAutomaticBeamingToDoc(doc, partEl);
      return {
        xml: serializeXmlDoc(doc),
        nextTarget: target,
        changed: true,
      };
    }
  }

  return {
    xml: xmlStr,
    nextTarget: target,
    changed: false,
    warning: "Duration exceeds remaining beats in this measure.",
  };
}

export function toggleXmlNoteDot(
  xmlStr: string,
  target: XmlNoteTarget,
  options?: { rebalanceMeasure?: boolean },
): { xml: string; dotted: boolean; nextTarget: XmlNoteTarget; changed: boolean; warning?: string } | null {
  const info = getXmlNoteInfo(xmlStr, target);
  if (!info) return null;
  const nextDotted = !info.dotted;
  const noteType: EditableNoteType = info.durationType || "quarter";
  const res = setXmlNoteDuration(xmlStr, target, noteType, {
    dotted: nextDotted,
    tupletRatio:
      info.tupletActual && info.tupletNormal
        ? { actual: info.tupletActual, normal: info.tupletNormal }
        : null,
    rebalanceMeasure: options?.rebalanceMeasure,
  });
  if (!res) return null;
  return {
    xml: res.xml,
    dotted: res.changed ? nextDotted : info.dotted,
    nextTarget: res.nextTarget,
    changed: res.changed,
    warning: res.warning,
  };
}

export function toggleXmlNoteTie(
  xmlStr: string,
  target: XmlNoteTarget,
): { xml: string; changed: boolean; nextTarget?: XmlNoteTarget; message?: string } {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return { xml: xmlStr, changed: false, message: "Unable to parse MusicXML." };
  const found = findTargetNoteElement(doc, target);
  if (!found) return { xml: xmlStr, changed: false, message: "Select a pitched note to tie." };

  const pitchA = found.noteEl.getElementsByTagName("pitch")[0];
  if (!pitchA) {
    return { xml: xmlStr, changed: false, message: "Rests cannot be tied." };
  }

  const removeTieType = (el: Element, tieType: "start" | "stop") => {
    for (const t of Array.from(el.getElementsByTagName("tie"))) {
      if (t.getAttribute("type") === tieType) t.parentNode?.removeChild(t);
    }
    for (const t of Array.from(el.getElementsByTagName("tied"))) {
      if (t.getAttribute("type") === tieType) t.parentNode?.removeChild(t);
    }
  };

  const hasStart = Array.from(found.noteEl.getElementsByTagName("tie")).some(
    (t) => t.getAttribute("type") === "start",
  );
  if (hasStart) {
    const nextPitched = findNextPitchedNoteInStream(doc, found);
    removeTieType(found.noteEl, "start");
    if (nextPitched) removeTieType(nextPitched.noteEl, "stop");
    return { xml: serializeXmlDoc(doc), changed: true, nextTarget: target };
  }

  // Inspect immediately following element in this (staff, voice) lane
  const { partEl, measureEl, measureIdx, staffNumber, voice } = found;
  const divisions = ensurePartDivisionsAtLeast(doc, partEl, measureIdx, 48);
  const chordGroup = getTargetChordGroup(measureEl, found.noteEl);
  const groupLast = chordGroup[chordGroup.length - 1];
  const hasGrand = computePartHasGrandStaves(partEl, measureIdx);
  const targetStaffNum = hasGrand ? staffNumber : null;

  const findImmediateNextInLane = (): {
    el: Element;
    mEl: Element;
    mIdx: number;
    isRest: boolean;
  } | null => {
    const measures = Array.from(partEl.getElementsByTagName("measure"));
    let pastAnchor = false;
    for (let mIdx = measureIdx; mIdx < measures.length; mIdx++) {
      const m = measures[mIdx];
      for (const child of Array.from(m.children)) {
        if (mIdx === measureIdx && !pastAnchor) {
          if (child === groupLast) pastAnchor = true;
          continue;
        }
        const tag = child.tagName.toLowerCase();
        if (tag !== "note") continue;
        if (child.getElementsByTagName("chord").length > 0) continue;
        if (getNoteStaffNumber(child) !== staffNumber || getNoteVoice(child) !== voice) continue;
        return {
          el: child,
          mEl: m,
          mIdx,
          isRest: child.getElementsByTagName("rest").length > 0,
        };
      }
    }
    return null;
  };

  const immediateNext = findImmediateNextInLane();
  if (!immediateNext) {
    return { xml: xmlStr, changed: false, message: "No following note or rest space found to tie." };
  }

  if (immediateNext.isRest) {
    const srcDur = Math.max(
      1,
      Math.round(Number.parseFloat(found.noteEl.getElementsByTagName("duration")[0]?.textContent || String(divisions)) || divisions),
    );
    const { rests, totalDivs } =
      immediateNext.mIdx === measureIdx
        ? collectConsecutiveFollowingRestsInLane(groupLast, measureEl, staffNumber, voice)
        : collectLeadingRestsInMeasureLane(immediateNext.mEl, staffNumber, voice);
    const tieDur = Math.min(srcDur, totalDivs);
    if (tieDur <= 0 || rests.length === 0) {
      return { xml: xmlStr, changed: false, message: "No rest space available for tied continuation." };
    }
    const spec = durationDivsToBestType(tieDur, divisions);
    const anchor = rests[0];
    for (const srcNote of chordGroup) {
      addTieMarker(doc, srcNote, "start");
      const clone = srcNote.cloneNode(true) as Element;
      for (const t of Array.from(clone.getElementsByTagName("tie"))) clone.removeChild(t);
      const cloneNots = clone.getElementsByTagName("notations")[0];
      if (cloneNots) {
        for (const td of Array.from(cloneNots.getElementsByTagName("tied"))) cloneNots.removeChild(td);
      }
      setElementText(doc, clone, "duration", String(tieDur));
      setElementText(doc, clone, "type", spec.type);
      for (const d of Array.from(clone.getElementsByTagName("dot"))) clone.removeChild(d);
      if (spec.dotted) {
        const typeEl = clone.getElementsByTagName("type")[0];
        const dotEl = doc.createElement("dot");
        if (typeEl && typeEl.nextSibling) clone.insertBefore(dotEl, typeEl.nextSibling);
        else clone.appendChild(dotEl);
      }
      addTieMarker(doc, clone, "stop");
      immediateNext.mEl.insertBefore(clone, anchor);
    }
    consumeRestsFromFront(doc, immediateNext.mEl, rests, tieDur, divisions, voice, targetStaffNum);
    recomputePartAccidentals(doc, partEl);
    return { xml: serializeXmlDoc(doc), changed: true, nextTarget: target };
  }

  const pitchB = immediateNext.el.getElementsByTagName("pitch")[0];
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

  addTieMarker(doc, found.noteEl, "start");
  addTieMarker(doc, immediateNext.el, "stop");
  return { xml: serializeXmlDoc(doc), changed: true, nextTarget: target };
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

export function toggleXmlNoteTuplet(
  xmlStr: string,
  target: XmlNoteTarget,
  actualNotes = 3,
  options?: { rebalanceMeasure?: boolean },
): {
  xml: string;
  isTuplet: boolean;
  actualNotes: number | null;
  nextTarget: XmlNoteTarget;
  warning?: string;
} | null {
  const ratio = TUPLET_RATIOS[actualNotes] ?? { actual: Math.max(2, Math.min(9, actualNotes)), normal: 2 };
  const info = getXmlNoteInfo(xmlStr, target);
  if (!info) return null;
  const turningOff = info.tupletActual === ratio.actual;
  const nextRatio = turningOff ? null : ratio;
  const noteType: EditableNoteType = info.durationType || "eighth";
  const res = setXmlNoteDuration(xmlStr, target, noteType, {
    dotted: info.dotted,
    tupletRatio: nextRatio,
    rebalanceMeasure: options?.rebalanceMeasure,
  });
  if (!res) return null;
  return {
    xml: res.xml,
    isTuplet: res.changed ? !turningOff : info.tupletActual !== null,
    actualNotes: res.changed ? (turningOff ? null : ratio.actual) : info.tupletActual,
    nextTarget: res.nextTarget,
    warning: res.warning,
  };
}

export function toggleXmlNoteTriplet(
  xmlStr: string,
  target: XmlNoteTarget,
): { xml: string; isTriplet: boolean } | null {
  const res = toggleXmlNoteTuplet(xmlStr, target, 3);
  if (!res) return null;
  return { xml: res.xml, isTriplet: res.actualNotes === 3 };
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

  applyAutomaticBeamingToDoc(doc, found.partEl);
  return { xml: serializeXmlDoc(doc), voice };
}

export function convertXmlNoteToRest(
  xmlStr: string,
  target: XmlNoteTarget,
): { xml: string; nextTarget: XmlNoteTarget } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl, partEl, measureEl, staffNumber, voice } = found;
  const hadTieStart = Array.from(noteEl.getElementsByTagName("tie")).some((t) => t.getAttribute("type") === "start");
  if (hadTieStart) {
    const nextPitched = findNextPitchedNoteInStream(doc, found);
    if (nextPitched) {
      for (const t of Array.from(nextPitched.noteEl.getElementsByTagName("tie"))) {
        if (t.getAttribute("type") === "stop") t.parentNode?.removeChild(t);
      }
      for (const td of Array.from(nextPitched.noteEl.getElementsByTagName("tied"))) {
        if (td.getAttribute("type") === "stop") td.parentNode?.removeChild(td);
      }
    }
  }

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
  applyAutomaticBeamingToDoc(doc, partEl);
  const mNotes = Array.from(measureEl.children).filter((c) => c.tagName.toLowerCase() === "note");
  const idxAfter = mNotes.indexOf(noteEl);
  return {
    xml: serializeXmlDoc(doc),
    nextTarget: {
      partIndex: target.partIndex,
      measureNumber: target.measureNumber,
      onsetWhole: target.onsetWhole,
      pitchMidi: null,
      staffNumber,
      voice,
      noteIndex: idxAfter >= 0 ? idxAfter : target.noteIndex,
    },
  };
}

/**
 * Delete an individual selected note or chord tone:
 * - Within a chord: removes ONLY the selected note, promoting the next chord sibling if needed.
 * - Sole note at its onset: converts that rhythmic slot to an equal-duration rest preserving
 *   duration/dot/tuplet/staff/voice and keeps the resulting rest selected.
 */
export function deleteXmlNote(
  xmlStr: string,
  target: XmlNoteTarget,
): { xml: string; deletedChordTone: boolean; nextTarget: XmlNoteTarget } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl, measureEl, partEl, staffNumber, voice } = found;
  const isChordChild = noteEl.getElementsByTagName("chord").length > 0;
  const nextEl = noteEl.nextElementSibling;
  const hasChordFollower =
    Boolean(nextEl) &&
    nextEl!.tagName.toLowerCase() === "note" &&
    nextEl!.getElementsByTagName("chord").length > 0;

  if (isChordChild || hasChordFollower) {
    let survivingEl: Element | null = null;
    if (!isChordChild && hasChordFollower && nextEl) {
      const followerChordTag = nextEl.getElementsByTagName("chord")[0];
      if (followerChordTag) nextEl.removeChild(followerChordTag);
      survivingEl = nextEl;
    } else if (isChordChild) {
      const prevEl = noteEl.previousElementSibling;
      if (prevEl && prevEl.tagName.toLowerCase() === "note") survivingEl = prevEl;
    }
    measureEl.removeChild(noteEl);
    recomputePartAccidentals(doc, partEl);
    applyAutomaticBeamingToDoc(doc, partEl);
    let nextPitch: number | null = null;
    let nextNoteIdx = target.noteIndex;
    if (survivingEl) {
      const mNotes = Array.from(measureEl.children).filter((c) => c.tagName.toLowerCase() === "note");
      nextNoteIdx = mNotes.indexOf(survivingEl);
      const pEl = survivingEl.getElementsByTagName("pitch")[0];
      if (pEl) {
        const s = (pEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
        const a = Number.parseInt(pEl.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0;
        const o = Number.parseInt(pEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
        nextPitch = (o + 1) * 12 + (STEP_TO_PC[s] ?? 0) + a;
      }
    }
    return {
      xml: serializeXmlDoc(doc),
      deletedChordTone: true,
      nextTarget: {
        partIndex: target.partIndex,
        measureNumber: target.measureNumber,
        onsetWhole: target.onsetWhole,
        pitchMidi: nextPitch,
        staffNumber,
        voice,
        noteIndex: nextNoteIdx,
      },
    };
  }

  const restConverted = convertXmlNoteToRest(xmlStr, target);
  if (!restConverted) return null;
  return {
    xml: restConverted.xml,
    deletedChordTone: false,
    nextTarget: restConverted.nextTarget,
  };
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
    for (const p of parts) {
      ensurePartDivisionsAtLeast(doc, p, 0, 48);
      const pMeasures = Array.from(p.getElementsByTagName("measure"));
      const pm1 = pMeasures[0];
      if (!pm1) continue;
      const pAttrs = getOrCreateChild(doc, pm1, "attributes");
      const timeEl = getOrCreateChild(doc, pAttrs, "time");
      setElementText(doc, timeEl, "beats", String(beats));
      setElementText(doc, timeEl, "beat-type", String(beatType));

      const { divisions } = getEffectiveDivisionsAndFifths(p, 0);
      const targetDivs = Math.max(1, Math.round(divisions * beats * getBeatUnitQuarters(beatType)));
      for (let mIdx = 0; mIdx < pMeasures.length; mIdx++) {
        const curM = pMeasures[mIdx];
        if (mIdx === 0 && ((curM.getAttribute("implicit") || "").toLowerCase() === "yes" || getMeasureNumber(curM, 0) === 0)) {
          continue;
        }
        if (mIdx > 0) {
          const curAttrs = Array.from(curM.children).find((c) => c.tagName.toLowerCase() === "attributes");
          if (curAttrs && curAttrs.getElementsByTagName("time").length > 0) break;
        }
        const hasPitched = Array.from(curM.getElementsByTagName("note")).some(
          (n) => n.getElementsByTagName("pitch").length > 0,
        );
        if (!hasPitched) {
          inspectAndResizeMeasure(doc, p, curM, mIdx, targetDivs, divisions, true);
        }
      }
      applyAutomaticBeamingToDoc(doc, p);
    }
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
    [16, "long", false],
    [12, "breve", true],
    [8, "breve", false],
    [6, "whole", true],
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
  let best = table[8];
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

function decomposeDivsToRhythmicParts(
  totalDivs: number,
  divisions: number,
): Array<{ durDivs: number; type: EditableNoteType; dotted: boolean }> {
  let rem = Math.max(1, Math.round(totalDivs));
  const candidates: Array<[number, EditableNoteType, boolean]> = [
    [divisions * 16, "long", false],
    [divisions * 12, "breve", true],
    [divisions * 8, "breve", false],
    [divisions * 6, "whole", true],
    [divisions * 4, "whole", false],
    [divisions * 3, "half", true],
    [divisions * 2, "half", false],
    [Math.round(divisions * 1.5), "quarter", true],
    [divisions, "quarter", false],
    [Math.round(divisions * 0.75), "eighth", true],
    [Math.round(divisions * 0.5), "eighth", false],
    [Math.round(divisions * 0.375), "16th", true],
    [Math.round(divisions * 0.25), "16th", false],
    [Math.round(divisions * 0.125), "32nd", false],
    [Math.max(1, Math.round(divisions * 0.0625)), "64th", false],
  ];

  // Exact single-duration match fast path
  const exact = candidates.find(([d]) => d === rem);
  if (exact) {
    return [{ durDivs: exact[0], type: exact[1], dotted: exact[2] }];
  }

  const parts: Array<{ durDivs: number; type: EditableNoteType; dotted: boolean }> = [];
  let guard = 0;
  while (rem > 0 && guard < 8) {
    guard += 1;
    const match = candidates.find(([d]) => d > 0 && d <= rem);
    if (!match) {
      const spec = durationDivsToBestType(rem, divisions);
      parts.push({ durDivs: rem, type: spec.type, dotted: spec.dotted });
      break;
    }
    parts.push({ durDivs: match[0], type: match[1], dotted: match[2] });
    rem -= match[0];
  }
  return parts.length > 0 ? parts : [{ durDivs: Math.max(1, Math.round(totalDivs)), ...durationDivsToBestType(totalDivs, divisions) }];
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
    [divisions * 16, "long", false],
    [divisions * 8, "breve", false],
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
    pitchesMidi?: number[];
    explicitPitches?: Array<{ step: string; alter: number; octave: number }>;
    durDivs: number;
    noteType: EditableNoteType;
    dotted: boolean;
    tupletRatio?: { actual: number; normal: number } | null;
    voice: string;
    staffNumber: number | null;
    fifths: number;
  },
): Element[] {
  const spelledList: Array<{ step: string; alter: number; octave: number; midi: number }> =
    options.explicitPitches && options.explicitPitches.length > 0
      ? options.explicitPitches
          .map((p) => {
            const step = p.step.trim().toUpperCase();
            const alter = Math.max(-2, Math.min(2, Math.round(p.alter)));
            const octave = Math.max(0, Math.min(8, Math.round(p.octave)));
            const midi = Math.max(21, Math.min(108, (octave + 1) * 12 + (STEP_TO_PC[step] ?? 0) + alter));
            return { step, alter, octave, midi };
          })
          .sort((a, b) => a.midi - b.midi)
      : [...(options.pitchesMidi ?? [])]
          .sort((a, b) => a - b)
          .map((rawMidi) => {
            const midi = Math.max(21, Math.min(108, Math.round(rawMidi)));
            const spelled = spellMidiPitch(midi, options.fifths);
            return { ...spelled, midi };
          });

  return spelledList.map((spelled, idx) => {
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
    if (options.tupletRatio) {
      const tm = doc.createElement("time-modification");
      setElementText(doc, tm, "actual-notes", String(options.tupletRatio.actual));
      setElementText(doc, tm, "normal-notes", String(options.tupletRatio.normal));
      noteEl.appendChild(tm);
    }
    if (options.staffNumber !== null) setElementText(doc, noteEl, "staff", String(options.staffNumber));
    return noteEl;
  });
}

function computeMeasureAndNoteOnsetWhole(
  partEl: Element,
  targetMeasureIdx: number,
  targetNoteEl: Element,
): number {
  const measures = Array.from(partEl.getElementsByTagName("measure"));
  let divisions = 1;
  let curWhole = 0;

  for (let mIdx = 0; mIdx <= Math.min(targetMeasureIdx, measures.length - 1); mIdx++) {
    const m = measures[mIdx];
    let offsetDiv = 0;
    let lastStartDiv = 0;
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
        const isChord = child.getElementsByTagName("chord").length > 0;
        const noteDiv = isChord ? lastStartDiv : offsetDiv;
        if (mIdx === targetMeasureIdx && child === targetNoteEl) {
          return Number((curWhole + noteDiv / (divisions * 4)).toFixed(6));
        }
        if (!isChord && child.getElementsByTagName("grace").length === 0) {
          const dur = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
          lastStartDiv = offsetDiv;
          if (Number.isFinite(dur) && dur > 0) {
            offsetDiv += dur;
            maxDiv = Math.max(maxDiv, offsetDiv);
          }
        }
      }
    }
    curWhole += (maxDiv > 0 ? maxDiv : divisions * 4) / (divisions * 4);
  }
  return 0;
}

export function addChordToneToXmlNote(
  xmlStr: string,
  target: XmlNoteTarget,
  pitch: { step: string; alter: number; octave: number },
): { xml: string; addedTarget: XmlNoteTarget; chordRootTarget: XmlNoteTarget; midi: number } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const found = findTargetNoteElement(doc, target);
  if (!found) return null;

  const { noteEl, partEl, measureEl, measureIdx, staffNumber, voice } = found;
  if (noteEl.getElementsByTagName("rest").length > 0) return null;

  const chordGroup = getTargetChordGroup(measureEl, noteEl);
  const chordRoot = chordGroup[0];
  const groupLast = chordGroup[chordGroup.length - 1];

  const step = pitch.step.trim().toUpperCase();
  const alter = Math.max(-2, Math.min(2, Math.round(pitch.alter)));
  const octave = Math.max(0, Math.min(8, Math.round(pitch.octave)));
  const midi = Math.max(21, Math.min(108, (octave + 1) * 12 + (STEP_TO_PC[step] ?? 0) + alter));

  // Avoid duplicate unison pitch inside the chord
  const existingNote = chordGroup.find((el) => {
    const pEl = el.getElementsByTagName("pitch")[0];
    if (!pEl) return false;
    const s = (pEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
    const a = Number.parseInt(pEl.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0;
    const o = Number.parseInt(pEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
    return (o + 1) * 12 + (STEP_TO_PC[s] ?? 0) + a === midi;
  });

  const mNum = getMeasureNumber(measureEl, measureIdx);
  const onsetWhole = computeMeasureAndNoteOnsetWhole(partEl, measureIdx, chordRoot);
  if (existingNote) {
    const mNotes = Array.from(measureEl.children).filter((c) => c.tagName.toLowerCase() === "note");
    const existIdx = mNotes.indexOf(existingNote);
    const rootIdx = mNotes.indexOf(chordRoot);
    return {
      xml: xmlStr,
      addedTarget: {
        partIndex: target.partIndex,
        measureNumber: mNum,
        onsetWhole,
        pitchMidi: midi,
        staffNumber,
        voice,
        noteIndex: existIdx >= 0 ? existIdx : target.noteIndex,
      },
      chordRootTarget: {
        partIndex: target.partIndex,
        measureNumber: mNum,
        onsetWhole,
        pitchMidi: target.pitchMidi,
        staffNumber,
        voice,
        noteIndex: rootIdx >= 0 ? rootIdx : target.noteIndex,
      },
      midi,
    };
  }

  const newChordNote = doc.createElement("note");
  newChordNote.appendChild(doc.createElement("chord"));
  const pitchEl = doc.createElement("pitch");
  setElementText(doc, pitchEl, "step", step);
  if (alter !== 0) setElementText(doc, pitchEl, "alter", String(alter));
  setElementText(doc, pitchEl, "octave", String(octave));
  newChordNote.appendChild(pitchEl);

  const durText = chordRoot.getElementsByTagName("duration")[0]?.textContent?.trim() || "48";
  const typeText = chordRoot.getElementsByTagName("type")[0]?.textContent?.trim() || "quarter";
  setElementText(doc, newChordNote, "duration", durText);
  setElementText(doc, newChordNote, "voice", voice);
  setElementText(doc, newChordNote, "type", typeText);

  const dotCount = chordRoot.getElementsByTagName("dot").length;
  for (let d = 0; d < dotCount; d++) {
    newChordNote.appendChild(doc.createElement("dot"));
  }
  const timeMod = chordRoot.getElementsByTagName("time-modification")[0];
  if (timeMod) {
    newChordNote.appendChild(timeMod.cloneNode(true));
  }
  if (chordRoot.getElementsByTagName("staff").length > 0) {
    setElementText(doc, newChordNote, "staff", String(staffNumber));
  }

  if (groupLast.nextSibling) {
    measureEl.insertBefore(newChordNote, groupLast.nextSibling);
  } else {
    measureEl.appendChild(newChordNote);
  }

  recomputePartAccidentals(doc, partEl);
  applyAutomaticBeamingToDoc(doc, partEl);

  const mNotesAfter = Array.from(measureEl.children).filter((c) => c.tagName.toLowerCase() === "note");
  const addedIdx = mNotesAfter.indexOf(newChordNote);
  const rootIdx = mNotesAfter.indexOf(chordRoot);
  const rootPitchEl = chordRoot.getElementsByTagName("pitch")[0];
  let rootMidi = target.pitchMidi;
  if (rootPitchEl) {
    const rs = (rootPitchEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
    const ra = Number.parseInt(rootPitchEl.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0;
    const ro = Number.parseInt(rootPitchEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
    rootMidi = (ro + 1) * 12 + (STEP_TO_PC[rs] ?? 0) + ra;
  }

  return {
    xml: serializeXmlDoc(doc),
    addedTarget: {
      partIndex: target.partIndex,
      measureNumber: mNum,
      onsetWhole,
      pitchMidi: midi,
      staffNumber,
      voice,
      noteIndex: addedIdx >= 0 ? addedIdx : undefined,
    },
    chordRootTarget: {
      partIndex: target.partIndex,
      measureNumber: mNum,
      onsetWhole,
      pitchMidi: rootMidi,
      staffNumber,
      voice,
      noteIndex: rootIdx >= 0 ? rootIdx : undefined,
    },
    midi,
  };
}

export interface MeasureMeterUpdateResult {
  xml: string;
  requiresOverflowConfirmation?: boolean;
  overflowNoteCount?: number;
  overflowMessage?: string;
}

function renumberPartMeasures(partEl: Element): void {
  const measures = Array.from(partEl.getElementsByTagName("measure"));
  if (measures.length === 0) return;
  const first = measures[0];
  const firstIsPickup =
    (first.getAttribute("implicit") || "").toLowerCase() === "yes" ||
    getMeasureNumber(first, 0) === 0;
  measures.forEach((m, idx) => {
    if (idx === 0 && firstIsPickup) {
      m.setAttribute("number", "0");
      m.setAttribute("implicit", "yes");
    } else {
      m.removeAttribute("implicit");
      m.setAttribute("number", String(firstIsPickup ? idx : idx + 1));
    }
  });
}

function computePartHasGrandStaves(partEl: Element, upToMeasureIdx: number): boolean {
  const measures = Array.from(partEl.getElementsByTagName("measure"));
  for (let i = 0; i <= Math.min(upToMeasureIdx, measures.length - 1); i++) {
    const staves = measures[i]?.getElementsByTagName("staves")[0]?.textContent;
    if (staves && Number.parseInt(staves, 10) >= 2) return true;
  }
  return Array.from(partEl.getElementsByTagName("clef")).some(
    (c) => Number.parseInt(c.getAttribute("number") || "1", 10) >= 2,
  );
}

interface ParsedLaneEvent {
  el: Element;
  isRest: boolean;
  isChord: boolean;
  startDiv: number;
  endDiv: number;
  durDiv: number;
}

function inspectAndResizeMeasure(
  doc: Document,
  partEl: Element,
  measureEl: Element,
  measureIdx: number,
  targetDivs: number,
  divisions: number,
  applyMutation: boolean,
): { overflowCount: number } {
  const hasGrand = computePartHasGrandStaves(partEl, measureIdx);
  const leadingMeta: Element[] = [];
  const trailingBarlines: Element[] = [];
  const lanes = new Map<string, { voice: string; staff: number | null; events: ParsedLaneEvent[] }>();

  let offsetDiv = 0;
  let lastStartDiv = 0;
  let seenNoteOrBackup = false;

  for (const child of Array.from(measureEl.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "note") {
      seenNoteOrBackup = true;
      const isRest = child.getElementsByTagName("rest").length > 0;
      const isChord = child.getElementsByTagName("chord").length > 0;
      const dur = Math.max(0, Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0") || 0);
      const startDiv = isChord ? lastStartDiv : offsetDiv;
      const endDiv = startDiv + dur;
      const voice = getNoteVoice(child);
      const staffNum = hasGrand ? getNoteStaffNumber(child) : null;
      const key = `${staffNum ?? 0}:${voice}`;
      if (!lanes.has(key)) lanes.set(key, { voice, staff: staffNum, events: [] });
      lanes.get(key)!.events.push({ el: child, isRest, isChord, startDiv, endDiv, durDiv: dur });
      if (!isChord) {
        lastStartDiv = offsetDiv;
        offsetDiv += dur;
      }
    } else if (tag === "backup") {
      seenNoteOrBackup = true;
      const dur = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0") || 0;
      offsetDiv = Math.max(0, offsetDiv - dur);
    } else if (tag === "forward") {
      seenNoteOrBackup = true;
      const dur = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0") || 0;
      offsetDiv += dur;
    } else if (tag === "barline" && seenNoteOrBackup && child.getAttribute("location") !== "left") {
      trailingBarlines.push(child);
    } else {
      leadingMeta.push(child);
    }
  }

  let overflowCount = 0;
  for (const lane of lanes.values()) {
    for (const ev of lane.events) {
      if (!ev.isRest && ev.endDiv > targetDivs + 0.5) {
        overflowCount += 1;
      }
    }
  }

  if (!applyMutation) {
    return { overflowCount };
  }

  if (lanes.size === 0) {
    if (hasGrand) {
      lanes.set("1:1", { voice: "1", staff: 1, events: [] });
      lanes.set("2:2", { voice: "2", staff: 2, events: [] });
    } else {
      lanes.set("0:1", { voice: "1", staff: null, events: [] });
    }
  } else if (hasGrand) {
    const hasS1 = Array.from(lanes.values()).some((l) => l.staff === 1);
    const hasS2 = Array.from(lanes.values()).some((l) => l.staff === 2);
    if (!hasS1) lanes.set("1:1", { voice: "1", staff: 1, events: [] });
    if (!hasS2) lanes.set("2:2", { voice: "2", staff: 2, events: [] });
  }

  // Clear children and rebuild in canonical MusicXML order
  while (measureEl.firstChild) measureEl.removeChild(measureEl.firstChild);
  for (const el of leadingMeta) measureEl.appendChild(el);

  const laneList = Array.from(lanes.values()).sort((a, b) => (a.staff ?? 0) - (b.staff ?? 0));
  laneList.forEach((lane, lIdx) => {
    const lastPitchedEnd = lane.events.reduce(
      (maxEnd, ev) => (!ev.isRest && ev.startDiv < targetDivs - 0.5 ? Math.max(maxEnd, Math.min(targetDivs, ev.endDiv)) : maxEnd),
      0,
    );
    let cursor = 0;

    for (const ev of lane.events) {
      if (ev.isRest) {
        if (ev.startDiv < lastPitchedEnd - 0.5 && ev.endDiv <= targetDivs + 0.5) {
          for (const restAttr of Array.from(ev.el.getElementsByTagName("rest"))) {
            restAttr.removeAttribute("measure");
          }
          measureEl.appendChild(ev.el);
          cursor = Math.max(cursor, ev.endDiv);
        }
        continue;
      }
      if (ev.startDiv >= targetDivs - 0.5) {
        continue;
      }
      if (ev.endDiv > targetDivs + 0.5) {
        const clampedDur = Math.max(1, Math.round(targetDivs - ev.startDiv));
        setElementText(doc, ev.el, "duration", String(clampedDur));
        const spec = durationDivsToBestType(clampedDur, divisions);
        setElementText(doc, ev.el, "type", spec.type);
        for (const d of Array.from(ev.el.getElementsByTagName("dot"))) {
          d.parentNode?.removeChild(d);
        }
        if (spec.dotted) ev.el.appendChild(doc.createElement("dot"));
        if (!ev.isChord) cursor = ev.startDiv + clampedDur;
      } else {
        if (!ev.isChord) cursor = Math.max(cursor, ev.endDiv);
      }
      measureEl.appendChild(ev.el);
    }

    const rem = Math.round(targetDivs - cursor);
    if (rem > 0) {
      const fillRests = buildRestNoteElementsForDuration(doc, rem, divisions, lane.voice, lane.staff);
      for (const r of fillRests) measureEl.appendChild(r);
    }

    if (lIdx < laneList.length - 1) {
      const backupEl = doc.createElement("backup");
      setElementText(doc, backupEl, "duration", String(targetDivs));
      measureEl.appendChild(backupEl);
    }
  });

  for (const bl of trailingBarlines) measureEl.appendChild(bl);
  return { overflowCount };
}

function buildRestMeasureContent(
  doc: Document,
  measureEl: Element,
  divisions: number,
  targetDivs: number,
  hasGrand: boolean,
  isWholeBarRest: boolean,
): void {
  const appendLane = (voice: string, staff: number | null) => {
    if (isWholeBarRest) {
      const noteEl = doc.createElement("note");
      const restEl = doc.createElement("rest");
      restEl.setAttribute("measure", "yes");
      noteEl.appendChild(restEl);
      setElementText(doc, noteEl, "duration", String(targetDivs));
      setElementText(doc, noteEl, "voice", voice);
      const spec = durationDivsToBestType(targetDivs, divisions);
      setElementText(doc, noteEl, "type", spec.type);
      if (spec.dotted) noteEl.appendChild(doc.createElement("dot"));
      if (staff !== null) setElementText(doc, noteEl, "staff", String(staff));
      measureEl.appendChild(noteEl);
    } else {
      const rests = buildRestNoteElementsForDuration(doc, targetDivs, divisions, voice, staff);
      for (const r of rests) measureEl.appendChild(r);
    }
  };

  if (hasGrand) {
    appendLane("1", 1);
    const backupEl = doc.createElement("backup");
    setElementText(doc, backupEl, "duration", String(targetDivs));
    measureEl.appendChild(backupEl);
    appendLane("2", 2);
  } else {
    appendLane("1", null);
  }
}

export function setScorePickupMeasure(
  xmlStr: string,
  pickupBeats: number | null,
  options?: { forceTruncate?: boolean },
): MeasureMeterUpdateResult | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length === 0) return null;

  const structure = extractScoreStructure(xmlStr);
  const beatUnitQ = getBeatUnitQuarters(structure.baseBeatType);
  const firstMeasureHasPickup =
    structure.measures.length > 0 &&
    (structure.measures[0].isImplicit || structure.measures[0].measureNumber === 0);

  if (pickupBeats === null || pickupBeats <= 0) {
    if (!firstMeasureHasPickup) return { xml: serializeXmlDoc(doc) };

    let pickupPitchedCount = 0;
    for (const partEl of parts) {
      const m0 = partEl.getElementsByTagName("measure")[0];
      if (!m0) continue;
      for (const n of Array.from(m0.getElementsByTagName("note"))) {
        if (n.getElementsByTagName("pitch").length > 0 && n.getElementsByTagName("chord").length === 0) {
          pickupPitchedCount += 1;
        }
      }
    }
    if (pickupPitchedCount > 0 && !options?.forceTruncate) {
      return {
        xml: xmlStr,
        requiresOverflowConfirmation: true,
        overflowNoteCount: pickupPitchedCount,
        overflowMessage: `Removing the pickup measure will discard ${pickupPitchedCount} note${pickupPitchedCount === 1 ? "" : "s"} in Measure 0 (Pickup).`,
      };
    }

    for (const partEl of parts) {
      const measures = Array.from(partEl.getElementsByTagName("measure"));
      if (measures.length <= 1) return null;
      const m0 = measures[0];
      const m1 = measures[1];
      const attrs = Array.from(m0.children).find((c) => c.tagName.toLowerCase() === "attributes");
      if (attrs && !Array.from(m1.children).some((c) => c.tagName.toLowerCase() === "attributes")) {
        m1.insertBefore(attrs.cloneNode(true), m1.firstChild);
      }
      const m1Attrs = Array.from(m1.children).find((c) => c.tagName.toLowerCase() === "attributes");
      const dirs = Array.from(m0.children).filter((c) => c.tagName.toLowerCase() === "direction");
      for (const dir of dirs.reverse()) {
        if (m1Attrs && m1Attrs.nextSibling) m1.insertBefore(dir.cloneNode(true), m1Attrs.nextSibling);
        else m1.insertBefore(dir.cloneNode(true), m1.firstChild);
      }
      const leftBar = Array.from(m0.children).find(
        (c) => c.tagName.toLowerCase() === "barline" && c.getAttribute("location") === "left",
      );
      if (leftBar) m1.insertBefore(leftBar.cloneNode(true), m1.firstChild);
      partEl.removeChild(m0);
      renumberPartMeasures(partEl);
      recomputePartAccidentals(doc, partEl);
      applyAutomaticBeamingToDoc(doc, partEl);
    }
    return { xml: serializeXmlDoc(doc) };
  }

  for (const p of parts) ensurePartDivisionsAtLeast(doc, p, 0, 48);

  if (firstMeasureHasPickup) {
    let totalOverflow = 0;
    for (const p of parts) {
      const m0 = p.getElementsByTagName("measure")[0];
      if (!m0) continue;
      const { divisions } = getEffectiveDivisionsAndFifths(p, 0);
      const targetDivs = Math.max(Math.round(divisions / 8), Math.round(divisions * pickupBeats * beatUnitQ));
      totalOverflow += inspectAndResizeMeasure(doc, p, m0, 0, targetDivs, divisions, false).overflowCount;
    }
    if (totalOverflow > 0 && !options?.forceTruncate) {
      return {
        xml: xmlStr,
        requiresOverflowConfirmation: true,
        overflowNoteCount: totalOverflow,
        overflowMessage: `${totalOverflow} note${totalOverflow === 1 ? "" : "s"} in the pickup measure extend beyond ${pickupBeats} beat(s) and will be truncated or removed.`,
      };
    }
    for (const p of parts) {
      const m0 = p.getElementsByTagName("measure")[0];
      if (!m0) continue;
      const { divisions } = getEffectiveDivisionsAndFifths(p, 0);
      const targetDivs = Math.max(Math.round(divisions / 8), Math.round(divisions * pickupBeats * beatUnitQ));
      inspectAndResizeMeasure(doc, p, m0, 0, targetDivs, divisions, true);
      m0.setAttribute("number", "0");
      m0.setAttribute("implicit", "yes");
      renumberPartMeasures(p);
      recomputePartAccidentals(doc, p);
      applyAutomaticBeamingToDoc(doc, p);
    }
    return { xml: serializeXmlDoc(doc) };
  }

  // Create new <measure number="0" implicit="yes"> before existing Measure 1 across all parts
  for (const partEl of parts) {
    const measures = Array.from(partEl.getElementsByTagName("measure"));
    if (measures.length === 0) continue;
    const oldM1 = measures[0];
    const divisions = ensurePartDivisionsAtLeast(doc, partEl, 0, 48);
    const pickupDivs = Math.max(Math.round(divisions / 8), Math.round(divisions * pickupBeats * beatUnitQ));
    const hasGrand = computePartHasGrandStaves(partEl, 0);

    const m0 = doc.createElement("measure");
    m0.setAttribute("number", "0");
    m0.setAttribute("implicit", "yes");

    const attrs = Array.from(oldM1.children).find((c) => c.tagName.toLowerCase() === "attributes");
    if (attrs) {
      m0.appendChild(attrs);
    }
    const leadDirs = Array.from(oldM1.children).filter(
      (c) =>
        c.tagName.toLowerCase() === "direction" &&
        (c.getElementsByTagName("sound").length > 0 || c.getElementsByTagName("metronome").length > 0),
    );
    for (const ld of leadDirs) {
      m0.appendChild(ld);
    }
    const leftBar = Array.from(oldM1.children).find(
      (c) => c.tagName.toLowerCase() === "barline" && c.getAttribute("location") === "left",
    );
    if (leftBar) m0.insertBefore(leftBar, m0.firstChild);

    buildRestMeasureContent(doc, m0, divisions, pickupDivs, hasGrand, false);
    partEl.insertBefore(m0, oldM1);
    renumberPartMeasures(partEl);
    recomputePartAccidentals(doc, partEl);
    applyAutomaticBeamingToDoc(doc, partEl);
  }

  return { xml: serializeXmlDoc(doc) };
}

export function setMeasureBeatsOrMeter(
  xmlStr: string,
  options: {
    measureNumber: number;
    mode: "this_measure_only" | "from_this_measure_onward";
    beats: number;
    beatType?: number;
    showMeterChange?: boolean;
    forceTruncate?: boolean;
  },
): MeasureMeterUpdateResult | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length === 0) return null;

  for (const p of parts) ensurePartDivisionsAtLeast(doc, p, 0, 48);

  const primaryMeasures = Array.from(parts[0].getElementsByTagName("measure"));
  const targetIdx = primaryMeasures.findIndex(
    (m, idx) => getMeasureNumber(m, idx) === options.measureNumber,
  );
  if (targetIdx < 0) return null;

  const structure = extractScoreStructure(xmlStr);
  const prevInfo = structure.measures[Math.max(0, targetIdx - 1)];
  const curInfo = structure.measures[targetIdx];
  const prevBeats = curInfo?.hasExplicitTimeChange ? prevInfo?.timeBeats ?? 4 : curInfo?.timeBeats ?? 4;
  const prevBeatType = curInfo?.hasExplicitTimeChange ? prevInfo?.timeBeatType ?? 4 : curInfo?.timeBeatType ?? 4;

  const nextBeatType = options.beatType && [2, 4, 8, 16].includes(options.beatType) ? options.beatType : prevBeatType;
  const rawBeats = Math.max(0.25, Math.min(16, Number.isFinite(options.beats) ? options.beats : prevBeats));
  const beatUnitQ = getBeatUnitQuarters(nextBeatType);

  let endIdx = targetIdx + 1;
  if (options.mode === "from_this_measure_onward") {
    while (endIdx < primaryMeasures.length) {
      const attrs = Array.from(primaryMeasures[endIdx].children).find(
        (c) => c.tagName.toLowerCase() === "attributes",
      );
      if (attrs && attrs.getElementsByTagName("time").length > 0) {
        break;
      }
      endIdx += 1;
    }
  }

  // Pre-check note overflow across all parts & affected measures
  let totalOverflow = 0;
  for (const p of parts) {
    const pMeasures = Array.from(p.getElementsByTagName("measure"));
    const { divisions } = getEffectiveDivisionsAndFifths(p, targetIdx);
    const targetDivs = Math.max(Math.round(divisions / 8), Math.round(divisions * rawBeats * beatUnitQ));
    for (let mIdx = targetIdx; mIdx < Math.min(endIdx, pMeasures.length); mIdx++) {
      totalOverflow += inspectAndResizeMeasure(doc, p, pMeasures[mIdx], mIdx, targetDivs, divisions, false).overflowCount;
    }
  }

  if (totalOverflow > 0 && !options.forceTruncate) {
    return {
      xml: xmlStr,
      requiresOverflowConfirmation: true,
      overflowNoteCount: totalOverflow,
      overflowMessage: `Shortening ${
        options.mode === "this_measure_only" ? `Measure ${options.measureNumber}` : `Measures ${options.measureNumber} onward`
      } will clip or remove ${totalOverflow} note${totalOverflow === 1 ? "" : "s"}. Proceed anyway?`,
    };
  }

  for (const p of parts) {
    const pMeasures = Array.from(p.getElementsByTagName("measure"));
    const { divisions } = getEffectiveDivisionsAndFifths(p, targetIdx);
    const targetDivs = Math.max(Math.round(divisions / 8), Math.round(divisions * rawBeats * beatUnitQ));

    for (let mIdx = targetIdx; mIdx < Math.min(endIdx, pMeasures.length); mIdx++) {
      inspectAndResizeMeasure(doc, p, pMeasures[mIdx], mIdx, targetDivs, divisions, true);
    }

    const targetM = pMeasures[targetIdx];
    const shouldWriteMeter =
      options.mode === "from_this_measure_onward" || Boolean(options.showMeterChange);
    const intBeats = Math.max(1, Math.min(16, Math.round(rawBeats)));

    if (shouldWriteMeter && targetM) {
      const attrs = getOrCreateChild(doc, targetM, "attributes");
      const timeEl = getOrCreateChild(doc, attrs, "time");
      setElementText(doc, timeEl, "beats", String(intBeats));
      setElementText(doc, timeEl, "beat-type", String(nextBeatType));

      if (options.mode === "this_measure_only" && targetIdx + 1 < pMeasures.length) {
        const nextM = pMeasures[targetIdx + 1];
        const nextAttrs = Array.from(nextM.children).find((c) => c.tagName.toLowerCase() === "attributes");
        const nextAlreadyHasTime = Boolean(nextAttrs && nextAttrs.getElementsByTagName("time").length > 0);
        if (!nextAlreadyHasTime) {
          const restoreAttrs = getOrCreateChild(doc, nextM, "attributes");
          const restoreTime = getOrCreateChild(doc, restoreAttrs, "time");
          setElementText(doc, restoreTime, "beats", String(prevBeats));
          setElementText(doc, restoreTime, "beat-type", String(prevBeatType));
        }
      }
    } else if (options.mode === "this_measure_only" && targetM && targetIdx > 0) {
      // Remove any prior local <time> display on this measure if switching to hidden irregular duration
      const mAttrs = Array.from(targetM.children).find((c) => c.tagName.toLowerCase() === "attributes");
      if (mAttrs) {
        for (const t of Array.from(mAttrs.getElementsByTagName("time"))) {
          mAttrs.removeChild(t);
        }
        if (mAttrs.children.length === 0) targetM.removeChild(mAttrs);
      }
    }

    renumberPartMeasures(p);
    recomputePartAccidentals(doc, p);
    applyAutomaticBeamingToDoc(doc, p);
  }

  return { xml: serializeXmlDoc(doc) };
}

function getOrCreateMeasureBarline(doc: Document, measureEl: Element, location: "left" | "right"): Element {
  const existing = Array.from(measureEl.children).find(
    (c) => c.tagName.toLowerCase() === "barline" && (c.getAttribute("location") || "right") === location,
  );
  if (existing) return existing;

  const bl = doc.createElement("barline");
  bl.setAttribute("location", location);
  if (location === "left") {
    const attrs = Array.from(measureEl.children).find((c) => c.tagName.toLowerCase() === "attributes");
    if (attrs && attrs.nextSibling) measureEl.insertBefore(bl, attrs.nextSibling);
    else measureEl.insertBefore(bl, measureEl.firstChild);
  } else {
    measureEl.appendChild(bl);
  }
  return bl;
}

function cleanupEmptyBarline(measureEl: Element, barlineEl: Element): void {
  if (barlineEl.children.length === 0) {
    measureEl.removeChild(barlineEl);
  }
}

export function toggleMeasureRepeatBarline(
  xmlStr: string,
  measureNumber: number,
  kind: "forward" | "backward" | "both",
  repeatCount = 2,
): { xml: string; message?: string } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length === 0) return null;

  const structure = extractScoreStructure(xmlStr);
  const mInfo = structure.measures.find((m) => m.measureNumber === measureNumber);
  if (!mInfo) return null;

  const safeTimes = Math.max(2, Math.min(8, Math.round(repeatCount || 2)));
  let infoMsg: string | undefined;

  if (kind === "forward") {
    const nextEnabled = !mInfo.forwardRepeat;
    for (const partEl of parts) {
      const m = Array.from(partEl.getElementsByTagName("measure")).find(
        (el, i) => getMeasureNumber(el, i) === measureNumber,
      );
      if (!m) continue;
      if (nextEnabled) {
        const bl = getOrCreateMeasureBarline(doc, m, "left");
        setElementText(doc, bl, "bar-style", "heavy-light");
        for (const r of Array.from(bl.getElementsByTagName("repeat"))) bl.removeChild(r);
        const rep = doc.createElement("repeat");
        rep.setAttribute("direction", "forward");
        bl.appendChild(rep);
      } else {
        const bl = Array.from(m.children).find(
          (c) => c.tagName.toLowerCase() === "barline" && c.getAttribute("location") === "left",
        );
        if (bl) {
          for (const r of Array.from(bl.getElementsByTagName("repeat"))) bl.removeChild(r);
          for (const bs of Array.from(bl.getElementsByTagName("bar-style"))) bl.removeChild(bs);
          cleanupEmptyBarline(m, bl);
        }
      }
    }
  } else if (kind === "backward") {
    const nextEnabled = !mInfo.backwardRepeat;
    for (const partEl of parts) {
      const m = Array.from(partEl.getElementsByTagName("measure")).find(
        (el, i) => getMeasureNumber(el, i) === measureNumber,
      );
      if (!m) continue;
      if (nextEnabled) {
        const bl = getOrCreateMeasureBarline(doc, m, "right");
        setElementText(doc, bl, "bar-style", "light-heavy");
        for (const r of Array.from(bl.getElementsByTagName("repeat"))) bl.removeChild(r);
        const rep = doc.createElement("repeat");
        rep.setAttribute("direction", "backward");
        if (safeTimes > 2) rep.setAttribute("times", String(safeTimes));
        bl.appendChild(rep);
      } else {
        const bl = Array.from(m.children).find(
          (c) => c.tagName.toLowerCase() === "barline" && (c.getAttribute("location") || "right") === "right",
        );
        if (bl) {
          for (const r of Array.from(bl.getElementsByTagName("repeat"))) bl.removeChild(r);
          for (const bs of Array.from(bl.getElementsByTagName("bar-style"))) bl.removeChild(bs);
          cleanupEmptyBarline(m, bl);
        }
      }
    }
  } else {
    // both (:| |:) -> backward on measureNumber, forward on following measure
    const nextMInfo = structure.measures[mInfo.measureIndex + 1] ?? null;
    const bothActive = mInfo.backwardRepeat && Boolean(nextMInfo?.forwardRepeat);
    const nextEnabled = !bothActive;

    for (const partEl of parts) {
      const measures = Array.from(partEl.getElementsByTagName("measure"));
      const m = measures[mInfo.measureIndex];
      const mNext = measures[mInfo.measureIndex + 1];
      if (m) {
        if (nextEnabled) {
          const bl = getOrCreateMeasureBarline(doc, m, "right");
          setElementText(doc, bl, "bar-style", "light-heavy");
          for (const r of Array.from(bl.getElementsByTagName("repeat"))) bl.removeChild(r);
          const rep = doc.createElement("repeat");
          rep.setAttribute("direction", "backward");
          if (safeTimes > 2) rep.setAttribute("times", String(safeTimes));
          bl.appendChild(rep);
        } else {
          const bl = Array.from(m.children).find(
            (c) => c.tagName.toLowerCase() === "barline" && (c.getAttribute("location") || "right") === "right",
          );
          if (bl) {
            for (const r of Array.from(bl.getElementsByTagName("repeat"))) bl.removeChild(r);
            for (const bs of Array.from(bl.getElementsByTagName("bar-style"))) bl.removeChild(bs);
            cleanupEmptyBarline(m, bl);
          }
        }
      }
      if (mNext) {
        if (nextEnabled) {
          const bl = getOrCreateMeasureBarline(doc, mNext, "left");
          setElementText(doc, bl, "bar-style", "heavy-light");
          for (const r of Array.from(bl.getElementsByTagName("repeat"))) bl.removeChild(r);
          const rep = doc.createElement("repeat");
          rep.setAttribute("direction", "forward");
          bl.appendChild(rep);
        } else {
          const bl = Array.from(mNext.children).find(
            (c) => c.tagName.toLowerCase() === "barline" && c.getAttribute("location") === "left",
          );
          if (bl) {
            for (const r of Array.from(bl.getElementsByTagName("repeat"))) bl.removeChild(r);
            for (const bs of Array.from(bl.getElementsByTagName("bar-style"))) bl.removeChild(bs);
            cleanupEmptyBarline(mNext, bl);
          }
        }
      } else if (nextEnabled) {
        infoMsg = "Backward repeat added on the final measure (no following bar for forward repeat).";
      }
    }
  }

  return { xml: serializeXmlDoc(doc), message: infoMsg };
}

export function setMeasureRepeatCount(
  xmlStr: string,
  measureNumber: number,
  repeatCount: number,
): string | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const safeTimes = Math.max(2, Math.min(8, Math.round(repeatCount || 2)));
  let updated = false;
  for (const partEl of Array.from(doc.getElementsByTagName("part"))) {
    const m = Array.from(partEl.getElementsByTagName("measure")).find(
      (el, i) => getMeasureNumber(el, i) === measureNumber,
    );
    if (!m) continue;
    for (const rep of Array.from(m.getElementsByTagName("repeat"))) {
      if (rep.getAttribute("direction") === "backward") {
        rep.setAttribute("times", String(safeTimes));
        updated = true;
      }
    }
  }
  return updated ? serializeXmlDoc(doc) : null;
}

export function setMeasureVoltaEnding(
  xmlStr: string,
  measureNumber: number,
  action: "start_1" | "start_2" | "end_ending" | "clear_ending",
): { xml: string; warning?: string } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length === 0) return null;

  const removeEndingFromBarline = (m: Element, loc: "left" | "right", types: string[]) => {
    const bl = Array.from(m.children).find(
      (c) => c.tagName.toLowerCase() === "barline" && (c.getAttribute("location") || "right") === loc,
    );
    if (!bl) return;
    for (const endEl of Array.from(bl.getElementsByTagName("ending"))) {
      if (types.includes((endEl.getAttribute("type") || "").toLowerCase())) {
        bl.removeChild(endEl);
      }
    }
    cleanupEmptyBarline(m, bl);
  };

  for (const partEl of parts) {
    const measures = Array.from(partEl.getElementsByTagName("measure"));
    const targetIdx = measures.findIndex((m, idx) => getMeasureNumber(m, idx) === measureNumber);
    if (targetIdx < 0) continue;
    const targetM = measures[targetIdx];

    if (action === "clear_ending") {
      removeEndingFromBarline(targetM, "left", ["start"]);
      removeEndingFromBarline(targetM, "right", ["stop", "discontinue"]);
    } else if (action === "start_1" || action === "start_2") {
      const endingNum = action === "start_1" ? "1" : "2";
      const closeType = action === "start_1" ? "stop" : "discontinue";
      removeEndingFromBarline(targetM, "left", ["start"]);
      const leftBl = getOrCreateMeasureBarline(doc, targetM, "left");
      const startEl = doc.createElement("ending");
      startEl.setAttribute("number", endingNum);
      startEl.setAttribute("type", "start");
      startEl.textContent = `${endingNum}.`;
      leftBl.insertBefore(startEl, leftBl.firstChild);

      // Pair with a closing tag on targetM unless an ending closer already exists ahead
      removeEndingFromBarline(targetM, "right", ["stop", "discontinue"]);
      const rightBl = getOrCreateMeasureBarline(doc, targetM, "right");
      const stopEl = doc.createElement("ending");
      stopEl.setAttribute("number", endingNum);
      stopEl.setAttribute("type", closeType);
      rightBl.appendChild(stopEl);
    } else if (action === "end_ending") {
      // Find nearest active <ending type="start"> at or before targetIdx
      let activeNum = "1";
      let startIdx = -1;
      for (let i = targetIdx; i >= 0; i--) {
        const starts = Array.from(measures[i].getElementsByTagName("ending")).filter(
          (e) => e.getAttribute("type") === "start",
        );
        if (starts.length > 0) {
          activeNum = starts[0].getAttribute("number") || "1";
          startIdx = i;
          break;
        }
      }
      if (startIdx < 0) {
        return {
          xml: xmlStr,
          warning: "Start a 1st or 2nd ending before closing it on a measure.",
        };
      }
      // Remove any intermediate closer for this ending number between startIdx and targetIdx
      for (let i = startIdx; i <= targetIdx; i++) {
        removeEndingFromBarline(measures[i], "right", ["stop", "discontinue"]);
      }
      const rightBl = getOrCreateMeasureBarline(doc, targetM, "right");
      const closeType = activeNum.includes("1") && !activeNum.includes("2") ? "stop" : "discontinue";
      const stopEl = doc.createElement("ending");
      stopEl.setAttribute("number", activeNum);
      stopEl.setAttribute("type", closeType);
      rightBl.appendChild(stopEl);
    }
  }

  const outXml = serializeXmlDoc(doc);
  const warnings = validateVoltaEndings(outXml);
  return { xml: outXml, warning: warnings[0] };
}

const NAV_MARKER_LABELS: Record<NavigationMarkerType, string> = {
  segno: "",
  coda: "",
  fine: "Fine",
  to_coda: "To Coda",
  dc_al_fine: "D.C. al Fine",
  dc_al_coda: "D.C. al Coda",
  ds_al_fine: "D.S. al Fine",
  ds_al_coda: "D.S. al Coda",
};

function matchesNavigationDirection(dirEl: Element, marker: NavigationMarkerType): boolean {
  if (marker === "segno") return dirEl.getElementsByTagName("segno").length > 0;
  if (marker === "coda") return dirEl.getElementsByTagName("coda").length > 0;
  const words = Array.from(dirEl.getElementsByTagName("words"))
    .map((w) => (w.textContent || "").trim().toLowerCase())
    .join(" ");
  const soundEl = dirEl.getElementsByTagName("sound")[0];
  if (marker === "fine") return Boolean(soundEl?.hasAttribute("fine") || words === "fine");
  if (marker === "to_coda") return Boolean(soundEl?.hasAttribute("tocoda") || words === "to coda");
  if (marker === "dc_al_fine") return Boolean(soundEl?.hasAttribute("dacapo") && !words.includes("coda"));
  if (marker === "dc_al_coda") return Boolean(soundEl?.hasAttribute("dacapo") && words.includes("coda"));
  if (marker === "ds_al_fine") return Boolean(soundEl?.hasAttribute("dalsegno") && !words.includes("coda"));
  if (marker === "ds_al_coda") return Boolean(soundEl?.hasAttribute("dalsegno") && words.includes("coda"));
  return false;
}

export function toggleMeasureNavigationMarker(
  xmlStr: string,
  measureNumber: number,
  marker: NavigationMarkerType,
): { xml: string; warning?: string } | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const partEl = doc.getElementsByTagName("part")[0];
  if (!partEl) return null;

  const measures = Array.from(partEl.getElementsByTagName("measure"));
  const m = measures.find((el, i) => getMeasureNumber(el, i) === measureNumber);
  if (!m) return null;

  const existingDirs = Array.from(m.children).filter(
    (c) => c.tagName.toLowerCase() === "direction" && matchesNavigationDirection(c, marker),
  );

  if (existingDirs.length > 0) {
    for (const d of existingDirs) m.removeChild(d);
  } else {
    const dir = doc.createElement("direction");
    dir.setAttribute("placement", "above");
    const dt = doc.createElement("direction-type");
    if (marker === "segno") {
      dt.appendChild(doc.createElement("segno"));
    } else if (marker === "coda") {
      dt.appendChild(doc.createElement("coda"));
    } else {
      const words = doc.createElement("words");
      words.setAttribute("font-weight", "bold");
      words.textContent = NAV_MARKER_LABELS[marker];
      dt.appendChild(words);
    }
    dir.appendChild(dt);

    const sound = doc.createElement("sound");
    if (marker === "segno") sound.setAttribute("segno", "segno");
    else if (marker === "coda") sound.setAttribute("coda", "coda");
    else if (marker === "fine") sound.setAttribute("fine", "yes");
    else if (marker === "to_coda") sound.setAttribute("tocoda", "coda");
    else if (marker === "dc_al_fine" || marker === "dc_al_coda") sound.setAttribute("dacapo", "yes");
    else if (marker === "ds_al_fine" || marker === "ds_al_coda") sound.setAttribute("dalsegno", "segno");
    dir.appendChild(sound);

    if (marker === "segno" || marker === "coda") {
      const attrs = Array.from(m.children).find((c) => c.tagName.toLowerCase() === "attributes");
      if (attrs && attrs.nextSibling) m.insertBefore(dir, attrs.nextSibling);
      else m.insertBefore(dir, m.firstChild);
    } else {
      const rightBar = Array.from(m.children).find(
        (c) => c.tagName.toLowerCase() === "barline" && (c.getAttribute("location") || "right") === "right",
      );
      if (rightBar) m.insertBefore(dir, rightBar);
      else m.appendChild(dir);
    }
  }

  const outXml = serializeXmlDoc(doc);
  const navWarnings = validateNavigationMarkers(outXml);
  return { xml: outXml, warning: navWarnings[0] };
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
        ? measures.findIndex((m, idx) => getMeasureNumber(m, idx) === afterMeasureNumber)
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

    renumberPartMeasures(partEl);
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

    const delIdx = measures.findIndex((m, idx) => getMeasureNumber(m, idx) === measureNumber);
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
    if (delIdx === 0 && measures[1]) {
      measures[1].removeAttribute("implicit");
    }
    renumberPartMeasures(partEl);
    const remaining = Array.from(partEl.getElementsByTagName("measure"));
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

function insertNoteInMeasureAt(
  doc: Document,
  measureEl: Element,
  anchor: Element,
  elements: Element[],
): void {
  for (const el of elements) {
    measureEl.insertBefore(el, anchor);
  }
}

/**
 * Step-time MIDI or letter insertion: inserts single notes, chords, or rests into the target staff/voice
 * at the active cursor (or first rest), splitting long rests cleanly and advancing the cursor.
 */
export function insertStepMidiNotesIntoXml(
  xmlStr: string,
  options: {
    pitchesMidi: number[];
    explicitPitches?: Array<{ step: string; alter: number; octave: number }>;
    durationType: EditableNoteType;
    dotted: boolean;
    tupletRatio?: { actual: number; normal: number } | null;
    isRest?: boolean;
    voice?: "1" | "2";
    staffNumber?: 1 | 2;
    cursorTarget?: XmlNoteTarget | null;
  },
): { xml: string; insertedTarget: XmlNoteTarget | null; nextCursorTarget: XmlNoteTarget | null } | null {
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
  let rawDurDivs = divisions * TYPE_TO_QUARTERS[options.durationType] * (options.dotted ? 1.5 : 1);
  if (options.tupletRatio) {
    rawDurDivs *= options.tupletRatio.normal / options.tupletRatio.actual;
  }
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

  const isRestEntry = Boolean(options.isRest) || (options.pitchesMidi.length === 0 && (!options.explicitPitches || options.explicitPitches.length === 0));
  const newElements = isRestEntry
    ? buildRestNoteElementsForDuration(doc, actualDur, divisions, effectiveVoice, targetStaff)
    : createPitchedNoteElements(doc, {
        pitchesMidi: options.pitchesMidi,
        explicitPitches: options.explicitPitches,
        durDivs: actualDur,
        noteType: actualSpec.type,
        dotted: actualSpec.dotted,
        tupletRatio: actualDur === insertDivs ? options.tupletRatio ?? null : null,
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
  insertNoteInMeasureAt(doc, measureEl, anchor, [...newElements, ...remainderRests]);
  for (const oldEl of toRemove) {
    measureEl.removeChild(oldEl);
  }
  recomputePartAccidentals(doc, partEl);
  applyAutomaticBeamingToDoc(doc, partEl);

  const curMeasures = Array.from(partEl.getElementsByTagName("measure"));
  const curMeasureNum = getMeasureNumber(measureEl, measureIdx);
  const mNotesAfter = Array.from(measureEl.children).filter((c) => c.tagName.toLowerCase() === "note");
  const firstInsertedEl = newElements[0];
  const lastInsertedEl = newElements[newElements.length - 1];
  const firstInsertedIdx = firstInsertedEl ? mNotesAfter.indexOf(firstInsertedEl) : -1;
  const lastInsertedIdx = lastInsertedEl ? mNotesAfter.indexOf(lastInsertedEl) : -1;

  let firstInsertedMidi: number | null = null;
  if (firstInsertedEl && firstInsertedEl.getElementsByTagName("rest").length === 0) {
    const pEl = firstInsertedEl.getElementsByTagName("pitch")[0];
    if (pEl) {
      const s = (pEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
      const a = Number.parseInt(pEl.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0;
      const o = Number.parseInt(pEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
      firstInsertedMidi = (o + 1) * 12 + (STEP_TO_PC[s] ?? 0) + a;
    }
  }

  const insertedTarget: XmlNoteTarget | null =
    firstInsertedEl && firstInsertedIdx >= 0
      ? {
          partIndex,
          measureNumber: curMeasureNum,
          onsetWhole: computeMeasureAndNoteOnsetWhole(partEl, measureIdx, firstInsertedEl),
          pitchMidi: firstInsertedMidi,
          staffNumber: targetStaff ?? 1,
          voice: effectiveVoice,
          noteIndex: firstInsertedIdx,
        }
      : null;

  // Locate next slot cursor: first non-chord note/rest AFTER inserted element in same measure & staff, or next measure's first slot
  let nextCursorTarget: XmlNoteTarget | null = null;
  if (lastInsertedIdx >= 0) {
    for (let i = lastInsertedIdx + 1; i < mNotesAfter.length; i++) {
      const candidate = mNotesAfter[i];
      if (candidate.getElementsByTagName("chord").length > 0) continue;
      if (targetStaff !== null && getNoteStaffNumber(candidate) !== targetStaff) continue;
      let candMidi: number | null = null;
      if (candidate.getElementsByTagName("rest").length === 0) {
        const pEl = candidate.getElementsByTagName("pitch")[0];
        if (pEl) {
          const s = (pEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
          const a = Number.parseInt(pEl.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0;
          const o = Number.parseInt(pEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
          candMidi = (o + 1) * 12 + (STEP_TO_PC[s] ?? 0) + a;
        }
      }
      nextCursorTarget = {
        partIndex,
        measureNumber: curMeasureNum,
        onsetWhole: computeMeasureAndNoteOnsetWhole(partEl, measureIdx, candidate),
        pitchMidi: candMidi,
        staffNumber: targetStaff ?? 1,
        voice: getNoteVoice(candidate),
        noteIndex: i,
      };
      break;
    }
  }

  if (!nextCursorTarget) {
    for (let mI = measureIdx + 1; mI < curMeasures.length; mI++) {
      const m = curMeasures[mI];
      const mNum = getMeasureNumber(m, mI);
      const mNotes = Array.from(m.children).filter((c) => c.tagName.toLowerCase() === "note");
      const slotIdx = mNotes.findIndex(
        (n) => n.getElementsByTagName("chord").length === 0 && (targetStaff === null || getNoteStaffNumber(n) === targetStaff),
      );
      if (slotIdx >= 0) {
        const slot = mNotes[slotIdx];
        let candMidi: number | null = null;
        if (slot.getElementsByTagName("rest").length === 0) {
          const pEl = slot.getElementsByTagName("pitch")[0];
          if (pEl) {
            const s = (pEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
            const a = Number.parseInt(pEl.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0;
            const o = Number.parseInt(pEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
            candMidi = (o + 1) * 12 + (STEP_TO_PC[s] ?? 0) + a;
          }
        }
        nextCursorTarget = {
          partIndex,
          measureNumber: mNum,
          onsetWhole: computeMeasureAndNoteOnsetWhole(partEl, mI, slot),
          pitchMidi: candMidi,
          staffNumber: targetStaff ?? 1,
          voice: getNoteVoice(slot),
          noteIndex: slotIdx,
        };
        break;
      }
    }
  }

  return { xml: serializeXmlDoc(doc), insertedTarget, nextCursorTarget };
}

export function insertLetterNoteIntoXml(
  xmlStr: string,
  options: {
    letter: NoteLetter;
    durationType: EditableNoteType;
    dotted: boolean;
    tupletRatio?: { actual: number; normal: number } | null;
    isRest?: boolean;
    voice?: "1" | "2";
    staffNumber?: 1 | 2;
    cursorTarget?: XmlNoteTarget | null;
    previousMidi?: number | null;
    clefOverride?: "treble" | "bass";
  },
): {
  xml: string;
  insertedTarget: XmlNoteTarget | null;
  nextCursorTarget: XmlNoteTarget | null;
  resolvedPitch: DiatonicPitchResult;
} | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc) return null;
  const partIndex = options.cursorTarget?.partIndex ?? 0;
  const partEl = doc.getElementsByTagName("part")[partIndex] || doc.getElementsByTagName("part")[0];
  if (!partEl) return null;

  let measureIdx = 0;
  let fifths = getEffectiveDivisionsAndFifths(partEl, 0).fifths;
  let targetStaff = options.staffNumber ?? options.cursorTarget?.staffNumber ?? 1;

  if (options.cursorTarget) {
    const found = findTargetNoteElement(doc, options.cursorTarget);
    if (found) {
      measureIdx = found.measureIdx;
      fifths = found.fifths;
      targetStaff = options.staffNumber ?? found.staffNumber;
    }
  }

  const clef = options.clefOverride ?? getNoteClef(partEl, measureIdx, targetStaff);
  const resolvedPitch = resolveLetterNotePitch({
    letter: options.letter,
    keyFifths: fifths,
    clef,
    previousMidi: options.previousMidi,
  });

  const stepRes = insertStepMidiNotesIntoXml(xmlStr, {
    pitchesMidi: [resolvedPitch.midi],
    explicitPitches: [{ step: resolvedPitch.step, alter: resolvedPitch.alter, octave: resolvedPitch.octave }],
    durationType: options.durationType,
    dotted: options.dotted,
    tupletRatio: options.tupletRatio,
    isRest: options.isRest,
    voice: options.voice,
    staffNumber: options.staffNumber,
    cursorTarget: options.cursorTarget,
  });
  if (!stepRes) return null;
  return {
    ...stepRes,
    resolvedPitch,
  };
}

/**
 * Convert quantized recorded MIDI ScoreNote[] directly into grand-staff / treble / bass MusicXML
 * while keeping time signature, key signature, tempo, beat beaming, barline ties, and legato slurs valid.
 */
export function mergeLiveMidiRecordingIntoXml(
  xmlStr: string,
  recordedNotes: RecordedScoreNote[],
  options: {
    tempoBpm: number;
    timeSignature: string;
    snapMode: SnapGridMode;
    clefMode?: PlaygroundClefMode;
    splitPointMidi?: number;
    autoSlursTies?: boolean;
    legatoOverlapThresholdSec?: number;
    legatoMaxOverlapSec?: number;
  },
): string | null {
  const doc = parseXmlDoc(xmlStr);
  if (!doc || recordedNotes.length === 0) return null;

  const partEl = doc.getElementsByTagName("part")[0];
  if (!partEl) return null;

  const autoSlursTies = options.autoSlursTies ?? true;
  const legatoOverlapThresholdSec = options.legatoOverlapThresholdSec ?? 0.005;
  const legatoMaxOverlapSec = options.legatoMaxOverlapSec ?? 0.45;

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

  const structure = extractScoreStructure(xmlStr, options.timeSignature);
  const existingMeasureDivs = Array.from(partEl.getElementsByTagName("measure")).map((m, idx) => {
    const mInfo = structure.measures[idx];
    const barQuarters = mInfo ? mInfo.actualQuarters : (beats * 4) / beatType;
    return Math.max(1, Math.round(barQuarters * divisions));
  });

  interface RecordedQuantizedEvent {
    attackId: number;
    pitchMidi: number;
    origStartDiv: number;
    origEndDiv: number;
    clampedEndDiv: number;
    rawOnsetSec?: number;
    rawOffsetSec?: number;
  }

  const quantizedEvents: RecordedQuantizedEvent[] = recordedNotes.map((n, idx) => {
    const rawStart = Math.max(0, Math.round((n.onset_sec * divPerSec) / stepDivs) * stepDivs);
    const rawEnd = Math.max(rawStart + stepDivs, Math.round((n.offset_sec * divPerSec) / stepDivs) * stepDivs);
    return {
      attackId: idx,
      pitchMidi: n.pitch_midi,
      origStartDiv: Math.round(rawStart),
      origEndDiv: Math.round(rawEnd),
      clampedEndDiv: Math.round(rawEnd),
      rawOnsetSec: typeof n.raw_onset_sec === "number" ? n.raw_onset_sec : undefined,
      rawOffsetSec: typeof n.raw_offset_sec === "number" ? n.raw_offset_sec : undefined,
    };
  });

  let cumulativeExistingDivs = existingMeasureDivs.reduce((sum, d) => sum + d, 0);
  const maxEndDiv = quantizedEvents.reduce((m, e) => Math.max(m, e.origEndDiv), measureDivs);

  let workingXml = serializeXmlDoc(doc);
  let safetyAdd = 0;
  while (cumulativeExistingDivs < maxEndDiv && safetyAdd < 64) {
    const added = addMeasureToAllParts(workingXml);
    if (!added) break;
    workingXml = added;
    existingMeasureDivs.push(measureDivs);
    cumulativeExistingDivs += measureDivs;
    safetyAdd += 1;
  }

  const nextDoc = parseXmlDoc(workingXml);
  if (!nextDoc) return null;
  const nextPart = nextDoc.getElementsByTagName("part")[0];
  const hasTwoStaves =
    options.clefMode === "grand" ||
    Number.parseInt(nextPart.getElementsByTagName("staves")[0]?.textContent || "1", 10) >= 2;
  const splitMidi = options.splitPointMidi ?? 60;
  const isPercussion = Array.from(nextPart.getElementsByTagName("sign")).some(
    (s) => (s.textContent || "").trim().toLowerCase() === "percussion",
  );

  // Prevent quantized legato overlap from swallowing subsequent melodic notes in the same single-voice staff
  const prepareStaffLaneGroups = (events: RecordedQuantizedEvent[]) => {
    const sorted = [...events].sort((a, b) => a.origStartDiv - b.origStartDiv || a.pitchMidi - b.pitchMidi);
    const byOnset = new Map<number, RecordedQuantizedEvent[]>();
    for (const ev of sorted) {
      if (!byOnset.has(ev.origStartDiv)) byOnset.set(ev.origStartDiv, []);
      byOnset.get(ev.origStartDiv)!.push(ev);
    }
    const onsetKeys = Array.from(byOnset.keys()).sort((a, b) => a - b);
    const groups = onsetKeys.map((onset) => ({
      onsetDiv: onset,
      events: byOnset.get(onset)!.sort((a, b) => a.pitchMidi - b.pitchMidi),
    }));
    for (let i = 0; i < groups.length - 1; i++) {
      const nextOnset = groups[i + 1].onsetDiv;
      for (const ev of groups[i].events) {
        if (ev.clampedEndDiv > nextOnset) {
          ev.clampedEndDiv = nextOnset;
        }
      }
    }
    return groups;
  };

  const attackFirstElMap = new Map<number, Element>();
  const attackLastElMap = new Map<number, Element>();
  const staffLaneGroupsMap = new Map<string, ReturnType<typeof prepareStaffLaneGroups>>();

  const populateStaffInMeasure = (
    mEl: Element,
    mStartDiv: number,
    mEndDiv: number,
    barDivs: number,
    staffEvents: RecordedQuantizedEvent[],
    laneGroups: ReturnType<typeof prepareStaffLaneGroups>,
    voice: string,
    staffNumber: number | null,
  ) => {
    interface ClippedSlot {
      start: number;
      end: number;
      items: RecordedQuantizedEvent[];
    }

    const slots: ClippedSlot[] = [];
    for (const grp of laneGroups) {
      const active = grp.events.filter((e) => e.clampedEndDiv > mStartDiv && e.origStartDiv < mEndDiv);
      if (active.length === 0) continue;
      const start = Math.max(0, grp.onsetDiv - mStartDiv);
      const maxEnd = active.reduce((m, e) => Math.max(m, Math.min(barDivs, e.clampedEndDiv - mStartDiv)), start);
      if (maxEnd > start) {
        slots.push({ start, end: maxEnd, items: active });
      }
    }
    void staffEvents;
    slots.sort((a, b) => a.start - b.start);

    let cursor = 0;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot.start > cursor) {
        const gapRests = buildRestNoteElementsForDuration(nextDoc, slot.start - cursor, divisions, voice, staffNumber);
        for (const r of gapRests) mEl.appendChild(r);
        cursor = slot.start;
      }
      if (slot.start < cursor) continue;
      const nextSlotStart = i + 1 < slots.length ? slots[i + 1].start : barDivs;
      const availDur = Math.max(Math.round(stepDivs), Math.round(Math.min(slot.end, nextSlotStart) - slot.start));
      const sortedItems = [...slot.items].sort((a, b) => a.pitchMidi - b.pitchMidi);

      const segParts = autoSlursTies
        ? decomposeDivsToRhythmicParts(availDur, divisions)
        : [{ durDivs: availDur, ...durationDivsToBestType(availDur, divisions) }];

      for (let pIdx = 0; pIdx < segParts.length; pIdx++) {
        const partSpec = segParts[pIdx];
        const noteEls = createPitchedNoteElements(nextDoc, {
          pitchesMidi: sortedItems.map((c) => c.pitchMidi),
          durDivs: partSpec.durDivs,
          noteType: partSpec.type,
          dotted: partSpec.dotted,
          voice,
          staffNumber,
          fifths,
        });

        noteEls.forEach((ne, nIdx) => {
          const ev = sortedItems[nIdx];
          if (!ev) return;
          if (!attackFirstElMap.has(ev.attackId)) {
            attackFirstElMap.set(ev.attackId, ne);
          }
          attackLastElMap.set(ev.attackId, ne);

          if (autoSlursTies) {
            const continuesFromBefore = ev.origStartDiv < mStartDiv;
            const continuesAfterBar = ev.clampedEndDiv > mEndDiv;
            const needStopTie = (pIdx === 0 && continuesFromBefore) || pIdx > 0;
            const needStartTie =
              (pIdx === segParts.length - 1 && continuesAfterBar) || pIdx < segParts.length - 1;
            if (needStopTie) addTieMarker(nextDoc, ne, "stop");
            if (needStartTie) addTieMarker(nextDoc, ne, "start");
          }
          mEl.appendChild(ne);
        });
      }

      cursor = slot.start + availDur;
    }

    if (cursor < barDivs) {
      const tailRests = buildRestNoteElementsForDuration(nextDoc, barDivs - cursor, divisions, voice, staffNumber);
      for (const r of tailRests) mEl.appendChild(r);
    }
  };

  if (hasTwoStaves) {
    const rhEvents = quantizedEvents.filter((e) => e.pitchMidi >= splitMidi);
    const lhEvents = quantizedEvents.filter((e) => e.pitchMidi < splitMidi);
    staffLaneGroupsMap.set("1:1", prepareStaffLaneGroups(rhEvents));
    staffLaneGroupsMap.set("2:2", prepareStaffLaneGroups(lhEvents));
  } else {
    staffLaneGroupsMap.set("1:1", prepareStaffLaneGroups(quantizedEvents));
  }

  const measures = Array.from(nextPart.getElementsByTagName("measure"));
  let runningStartDiv = 0;
  measures.forEach((mEl, mIdx) => {
    for (const child of Array.from(mEl.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === "note" || tag === "backup" || tag === "forward") {
        mEl.removeChild(child);
      }
    }
    const barDivs = existingMeasureDivs[mIdx] ?? measureDivs;
    const mStartDiv = runningStartDiv;
    const mEndDiv = mStartDiv + barDivs;
    runningStartDiv = mEndDiv;

    if (hasTwoStaves) {
      const rhEvents = quantizedEvents.filter((e) => e.pitchMidi >= splitMidi);
      const lhEvents = quantizedEvents.filter((e) => e.pitchMidi < splitMidi);
      populateStaffInMeasure(
        mEl,
        mStartDiv,
        mEndDiv,
        barDivs,
        rhEvents,
        staffLaneGroupsMap.get("1:1") || [],
        "1",
        1,
      );
      const backupEl = nextDoc.createElement("backup");
      setElementText(nextDoc, backupEl, "duration", String(barDivs));
      mEl.appendChild(backupEl);
      populateStaffInMeasure(
        mEl,
        mStartDiv,
        mEndDiv,
        barDivs,
        lhEvents,
        staffLaneGroupsMap.get("2:2") || [],
        "2",
        2,
      );
    } else {
      populateStaffInMeasure(
        mEl,
        mStartDiv,
        mEndDiv,
        barDivs,
        quantizedEvents,
        staffLaneGroupsMap.get("1:1") || [],
        "1",
        null,
      );
    }
  });

  // Conservative legato slur detection using actual recorded note-on / note-off timestamps
  if (autoSlursTies && !isPercussion) {
    const appendSlurMarker = (el: Element, slurType: "start" | "stop") => {
      const notations = getOrCreateChild(nextDoc, el, "notations");
      const already = Array.from(notations.getElementsByTagName("slur")).some(
        (s) => s.getAttribute("type") === slurType,
      );
      if (already) return;
      const slurEl = nextDoc.createElement("slur");
      slurEl.setAttribute("type", slurType);
      slurEl.setAttribute("number", "1");
      notations.appendChild(slurEl);
    };

    for (const laneGroups of staffLaneGroupsMap.values()) {
      let phraseStartIdx: number | null = null;
      let phraseEndIdx: number | null = null;

      const flushPhrase = () => {
        if (phraseStartIdx !== null && phraseEndIdx !== null && phraseEndIdx > phraseStartIdx) {
          const firstEv = laneGroups[phraseStartIdx].events[0];
          const lastEv = laneGroups[phraseEndIdx].events[0];
          const startEl = attackFirstElMap.get(firstEv.attackId);
          const endEl = attackLastElMap.get(lastEv.attackId);
          if (startEl && endEl && startEl !== endEl) {
            appendSlurMarker(startEl, "start");
            appendSlurMarker(endEl, "stop");
          }
        }
        phraseStartIdx = null;
        phraseEndIdx = null;
      };

      for (let i = 0; i < laneGroups.length - 1; i++) {
        const curGrp = laneGroups[i];
        const nextGrp = laneGroups[i + 1];
        const curMono = curGrp.events.length === 1 ? curGrp.events[0] : null;
        const nextMono = nextGrp.events.length === 1 ? nextGrp.events[0] : null;

        let isLegatoTransition = false;
        if (
          curMono &&
          nextMono &&
          curMono.pitchMidi !== nextMono.pitchMidi &&
          nextMono.origStartDiv <= curMono.clampedEndDiv + 0.5 &&
          typeof curMono.rawOffsetSec === "number" &&
          typeof nextMono.rawOnsetSec === "number"
        ) {
          const rawOverlap = curMono.rawOffsetSec - nextMono.rawOnsetSec;
          if (rawOverlap >= legatoOverlapThresholdSec && rawOverlap <= legatoMaxOverlapSec) {
            isLegatoTransition = true;
          }
        }

        if (isLegatoTransition) {
          if (phraseStartIdx === null) phraseStartIdx = i;
          phraseEndIdx = i + 1;
        } else {
          flushPhrase();
        }
      }
      flushPhrase();
    }
  }

  recomputePartAccidentals(nextDoc, nextPart);
  applyAutomaticBeamingToDoc(nextDoc, nextPart);
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
