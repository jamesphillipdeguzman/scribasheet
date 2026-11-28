import {
  formatHarmonyElementToSymbol,
  parseChordSymbolStrict,
  parsePitchTokenStrict,
  type ParsedChord,
} from "@/lib/chordParser";
import { extractScoreStructure, getBeatUnitQuarters, getMeasureNumber } from "@/features/editor/musicXmlStructure";
import { buildMusicXmlTimeline, wholeNotesToTimeSec } from "@/features/editor/musicXmlTimeline";
import { respellChordSymbol, spellPitchClass } from "@/lib/keySignature";
import type { ScoreChord, ScoreNote } from "@/types/api";

interface ChordTemplate {
  suffix: string;
  kind: string;
  kindText: string;
  intervals: number[];
}

const CHORD_TEMPLATES: ChordTemplate[] = [
  { suffix: "maj7", kind: "major-seventh", kindText: "maj7", intervals: [0, 4, 7, 11] },
  { suffix: "m7", kind: "minor-seventh", kindText: "m7", intervals: [0, 3, 7, 10] },
  { suffix: "7", kind: "dominant", kindText: "7", intervals: [0, 4, 7, 10] },
  { suffix: "m7b5", kind: "half-diminished", kindText: "m7b5", intervals: [0, 3, 6, 10] },
  { suffix: "dim7", kind: "diminished-seventh", kindText: "dim7", intervals: [0, 3, 6, 9] },
  { suffix: "", kind: "major", kindText: "", intervals: [0, 4, 7] },
  { suffix: "m", kind: "minor", kindText: "m", intervals: [0, 3, 7] },
  { suffix: "dim", kind: "diminished", kindText: "dim", intervals: [0, 3, 6] },
  { suffix: "aug", kind: "augmented", kindText: "aug", intervals: [0, 4, 8] },
  { suffix: "sus4", kind: "suspended-fourth", kindText: "sus4", intervals: [0, 5, 7] },
  { suffix: "sus2", kind: "suspended-second", kindText: "sus2", intervals: [0, 2, 7] },
];

export interface XmlHarmonyEntry {
  measureNumber: number;
  measureIndex: number;
  partIndex: number;
  onsetWhole: number;
  beat: number;
  symbol: string;
  root: string;
  quality: string;
  harmonyIndexInMeasure: number;
}

function parseChordWithFallback(
  symbol: string,
  fallbackRoot?: string,
  fallbackQuality?: string,
): ParsedChord | null {
  const strict = parseChordSymbolStrict(symbol);
  if (strict.ok) return strict.chord;

  if (fallbackRoot) {
    const parsedRoot = parsePitchTokenStrict(fallbackRoot);
    if (parsedRoot) {
      const q = fallbackQuality?.trim() || "";
      const combined = `${parsedRoot.display}${q === "major" ? "" : q === "minor" ? "m" : q}`;
      const reParsed = parseChordSymbolStrict(combined);
      if (reParsed.ok) return reParsed.chord;
    }
  }
  return null;
}

function inferChordFromPitches(
  pitchesMidi: number[],
  keyFifths: number,
): { symbol: string } | null {
  if (pitchesMidi.length < 2) return null;
  const sorted = [...pitchesMidi].sort((a, b) => a - b);
  const bassPc = ((sorted[0] % 12) + 12) % 12;
  const pitchClasses = Array.from(new Set(sorted.map((p) => ((p % 12) + 12) % 12)));
  if (pitchClasses.length < 2) return null;

  let bestScore = -1;
  let bestSymbol: string | null = null;

  for (const rootPc of pitchClasses) {
    const relSet = new Set(pitchClasses.map((pc) => (pc - rootPc + 12) % 12));
    for (const tpl of CHORD_TEMPLATES) {
      const matched = tpl.intervals.filter((iv) => relSet.has(iv)).length;
      if (matched < 2) continue;
      if (pitchClasses.length >= 3 && matched < 3) continue;
      const extra = pitchClasses.length - matched;
      const rootBonus = rootPc === bassPc ? 0.35 : 0;
      const triadBonus = tpl.intervals.length === 3 && matched === 3 ? 0.15 : 0;
      const score = matched * 2 - extra * 0.75 + rootBonus + triadBonus;
      if (score > bestScore) {
        bestScore = score;
        bestSymbol = `${spellPitchClass(rootPc, keyFifths).name}${tpl.suffix}`;
      }
    }
  }

  if (!bestSymbol && pitchClasses.length === 2) {
    for (const rootPc of pitchClasses) {
      const other = pitchClasses.find((pc) => pc !== rootPc)!;
      const iv = (other - rootPc + 12) % 12;
      if (iv === 4) return { symbol: spellPitchClass(rootPc, keyFifths).name };
      if (iv === 3) return { symbol: `${spellPitchClass(rootPc, keyFifths).name}m` };
    }
  }

  return bestSymbol ? { symbol: bestSymbol } : null;
}

function findPrimaryHarmonyPart(doc: Document): { partEl: Element; partIndex: number } | null {
  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length === 0) return null;

  const scoreParts = Array.from(doc.getElementsByTagName("score-part"));
  for (const sp of scoreParts) {
    const id = sp.getAttribute("id");
    const name = sp.getElementsByTagName("part-name")[0]?.textContent?.trim() || "";
    if (id && /\bsoprano\b/i.test(name)) {
      const idx = parts.findIndex((p) => p.getAttribute("id") === id);
      if (idx >= 0) return { partEl: parts[idx], partIndex: idx };
    }
  }
  return { partEl: parts[0], partIndex: 0 };
}

function buildHarmonyElement(doc: Document, parsed: ParsedChord, offsetDiv?: number): Element {
  const harmonyEl = doc.createElement("harmony");
  const rootEl = doc.createElement("root");
  const stepEl = doc.createElement("root-step");
  stepEl.textContent = parsed.rootStep;
  rootEl.appendChild(stepEl);
  if (parsed.rootAlter !== 0) {
    const alterEl = doc.createElement("root-alter");
    alterEl.textContent = String(parsed.rootAlter);
    rootEl.appendChild(alterEl);
  }
  harmonyEl.appendChild(rootEl);

  const kindEl = doc.createElement("kind");
  kindEl.setAttribute("text", parsed.kindText);
  kindEl.textContent = parsed.kind;
  harmonyEl.appendChild(kindEl);

  if (parsed.bassStep) {
    const bassEl = doc.createElement("bass");
    const bassStepEl = doc.createElement("bass-step");
    bassStepEl.textContent = parsed.bassStep;
    bassEl.appendChild(bassStepEl);
    if (parsed.bassAlter && parsed.bassAlter !== 0) {
      const bassAlterEl = doc.createElement("bass-alter");
      bassAlterEl.textContent = String(parsed.bassAlter);
      bassEl.appendChild(bassAlterEl);
    }
    harmonyEl.appendChild(bassEl);
  }

  for (const deg of parsed.degrees) {
    const degEl = doc.createElement("degree");
    const valEl = doc.createElement("degree-value");
    valEl.textContent = String(deg.value);
    const altEl = doc.createElement("degree-alter");
    altEl.textContent = String(deg.alter);
    const typeEl = doc.createElement("degree-type");
    typeEl.textContent = deg.type;
    degEl.appendChild(valEl);
    degEl.appendChild(altEl);
    degEl.appendChild(typeEl);
    harmonyEl.appendChild(degEl);
  }

  if (typeof offsetDiv === "number" && Number.isFinite(offsetDiv) && Math.round(offsetDiv) !== 0) {
    const offEl = doc.createElement("offset");
    offEl.textContent = String(Math.round(offsetDiv));
    harmonyEl.appendChild(offEl);
  }

  return harmonyEl;
}

function serializeXmlDocument(doc: Document): string {
  const serialized = new XMLSerializer().serializeToString(doc).replace(/^\uFEFF/, "").trim();
  if (serialized.startsWith("<?xml")) return serialized;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
}

interface PlacementTarget {
  measureIdx: number;
  quarterOffset: number;
  symbol: string;
  root?: string;
  quality?: string;
}

/**
 * Enrich a MusicXML string with `<harmony>` chord symbols (from detected `chords`
 * or inferred from simultaneous SATB `notes`) without altering note durations,
 * ties, lyrics, or measure timing, and without duplicating existing `<harmony>` tags.
 */
export function injectChordsIntoMusicXml(
  xml: string,
  chords: ScoreChord[] = [],
  notes: ScoreNote[] = [],
  tempoBpm = 120,
  options?: { skipAutoInfer?: boolean },
): string {
  if (!xml || !xml.includes("<score-") || typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    return xml;
  }

  try {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) return xml;

    const target = findPrimaryHarmonyPart(doc);
    if (!target) return xml;
    const targetPart = target.partEl;

    const measures = Array.from(targetPart.getElementsByTagName("measure"));
    if (measures.length === 0) return xml;

    const fifthsText = doc.getElementsByTagName("fifths")[0]?.textContent?.trim();
    const fifthsVal = fifthsText ? Number(fifthsText) : 0;
    const keyFifths = Number.isFinite(fifthsVal) ? Math.max(-7, Math.min(7, Math.round(fifthsVal))) : 0;

    const timeline = buildMusicXmlTimeline(xml, tempoBpm);

    const existingHarmonyOffsets = new Map<number, number[]>();
    const measureNoteAnchors = new Map<number, Array<{ el: Element; quarterOffset: number }>>();
    const measureNumberToIdx = new Map<number, number>();

    let divisions = 1;
    for (let mIdx = 0; mIdx < measures.length; mIdx += 1) {
      const mEl = measures[mIdx];
      const rawNum = Number(mEl.getAttribute("number"));
      if (Number.isFinite(rawNum)) {
        measureNumberToIdx.set(rawNum, mIdx);
      }
      const divText = mEl.getElementsByTagName("divisions")[0]?.textContent?.trim();
      const parsedDiv = divText ? Number(divText) : NaN;
      if (Number.isFinite(parsedDiv) && parsedDiv > 0) {
        divisions = parsedDiv;
      }

      let cursorDivs = 0;
      let lastStartDivs = 0;
      const anchors: Array<{ el: Element; quarterOffset: number }> = [];
      const harmOffsets: number[] = [];

      for (const child of Array.from(mEl.children)) {
        const tag = child.tagName.toLowerCase();
        if (tag === "harmony") {
          const explicitOff = Number.parseFloat(child.getElementsByTagName("offset")[0]?.textContent || "0");
          const effDivs = cursorDivs + (Number.isFinite(explicitOff) ? explicitOff : 0);
          harmOffsets.push(effDivs / divisions);
        } else if (tag === "note") {
          if (child.getElementsByTagName("grace").length > 0) continue;
          const durText = child.getElementsByTagName("duration")[0]?.textContent?.trim();
          const dur = durText ? Math.max(0, Number(durText) || 0) : 0;
          const isChord = child.getElementsByTagName("chord").length > 0;
          const startDivs = isChord ? lastStartDivs : cursorDivs;
          if (!isChord) {
            anchors.push({ el: child, quarterOffset: startDivs / divisions });
            lastStartDivs = startDivs;
            cursorDivs += dur;
          }
        } else if (tag === "backup") {
          const durText = child.getElementsByTagName("duration")[0]?.textContent?.trim();
          const dur = durText ? Math.max(0, Number(durText) || 0) : 0;
          cursorDivs = Math.max(0, cursorDivs - dur);
        } else if (tag === "forward") {
          const durText = child.getElementsByTagName("duration")[0]?.textContent?.trim();
          const dur = durText ? Math.max(0, Number(durText) || 0) : 0;
          cursorDivs += dur;
        }
      }

      existingHarmonyOffsets.set(mIdx, harmOffsets);
      measureNoteAnchors.set(mIdx, anchors);
    }

    const placements: PlacementTarget[] = [];

    if (chords.length > 0) {
      for (const ch of chords) {
        if (!ch.symbol?.trim()) continue;
        let mIdx = -1;
        let qOffset = Math.max(0, (ch.beat || 1) - 1);

        if (Number.isFinite(ch.onset_sec) && timeline.segments.length > 0) {
          const seg =
            timeline.segments.find(
              (s) => ch.onset_sec >= s.secStart - 0.04 && ch.onset_sec < s.secEnd - 0.02,
            ) ?? timeline.segments[timeline.segments.length - 1];
          if (seg && seg.measureIndex !== undefined) {
            mIdx = seg.measureIndex;
            const secPerQuarter = 60 / Math.max(20, seg.tempoBpm || tempoBpm || 120);
            qOffset = Math.max(0, (ch.onset_sec - seg.secStart) / secPerQuarter);
          }
        }

        if (mIdx < 0) {
          if (measureNumberToIdx.has(ch.measure)) {
            mIdx = measureNumberToIdx.get(ch.measure)!;
          } else {
            mIdx = Math.max(0, Math.min(measures.length - 1, (ch.measure || 1) - 1));
          }
        }

        const resSymbol = respellChordSymbol(ch.symbol, keyFifths);
        placements.push({
          measureIdx: mIdx,
          quarterOffset: qOffset,
          symbol: resSymbol.symbol || ch.symbol,
          root: resSymbol.root || ch.root,
          quality: ch.quality,
        });
      }
    } else if (!options?.skipAutoInfer && notes.length > 0 && timeline.segments.length > 0) {
      let prevSymbol = "";
      for (let sIdx = 0; sIdx < timeline.segments.length; sIdx += 1) {
        const seg = timeline.segments[sIdx];
        const mIdx = seg.measureIndex ?? sIdx;
        if (mIdx < 0 || mIdx >= measures.length) continue;

        const segQuarters = Math.max(0.5, seg.quarterEnd - seg.quarterStart);
        const secPerQuarter = 60 / Math.max(20, seg.tempoBpm || tempoBpm || 120);
        const stepCount = Math.max(1, Math.ceil(segQuarters));

        for (let b = 0; b < stepCount; b += 1) {
          const tSec = seg.secStart + b * secPerQuarter;
          if (tSec >= seg.secEnd - 0.02) break;
          const sounding = notes.filter(
            (n) => n.onset_sec <= tSec + 0.04 && n.offset_sec > tSec + 0.04,
          );
          const inferred = inferChordFromPitches(
            sounding.map((n) => n.pitch_midi),
            keyFifths,
          );
          if (!inferred) continue;
          if (inferred.symbol === prevSymbol && b > 0) continue;
          prevSymbol = inferred.symbol;
          placements.push({
            measureIdx: mIdx,
            quarterOffset: b,
            symbol: inferred.symbol,
          });
        }
      }
    }

    if (placements.length === 0) return xml;

    let inserted = false;
    for (const p of placements) {
      if (p.measureIdx < 0 || p.measureIdx >= measures.length) continue;
      const existing = existingHarmonyOffsets.get(p.measureIdx) ?? [];
      if (existing.some((off) => Math.abs(off - p.quarterOffset) <= 0.25)) {
        continue;
      }

      const parsed = parseChordWithFallback(p.symbol, p.root, p.quality);
      if (!parsed) continue;

      const mEl = measures[p.measureIdx];
      const anchors = measureNoteAnchors.get(p.measureIdx) ?? [];
      let anchorEl: Element | null = null;
      let bestDist = Infinity;
      for (const a of anchors) {
        const d = Math.abs(a.quarterOffset - p.quarterOffset);
        if (d < bestDist) {
          bestDist = d;
          anchorEl = a.el;
        }
      }

      const harmonyEl = buildHarmonyElement(doc, parsed);
      if (anchorEl && anchorEl.parentNode === mEl) {
        mEl.insertBefore(harmonyEl, anchorEl);
      } else {
        mEl.appendChild(harmonyEl);
      }
      existing.push(p.quarterOffset);
      existingHarmonyOffsets.set(p.measureIdx, existing);
      inserted = true;
    }

    if (!inserted) return xml;
    return serializeXmlDocument(doc);
  } catch {
    return xml;
  }
}

/** Extract all MusicXML `<harmony>` symbols with exact measure, beat, whole-note, and timeline second positions. */
export function extractHarmoniesFromMusicXml(
  xmlStr: string | null | undefined,
  fallbackTempoBpm = 120,
): Array<XmlHarmonyEntry & { onsetSec: number }> {
  if (!xmlStr || typeof DOMParser === "undefined" || !xmlStr.includes("<score-")) return [];
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xmlStr, "application/xml");
    if (doc.querySelector("parsererror")) return [];
  } catch {
    return [];
  }

  const timeline = buildMusicXmlTimeline(xmlStr, fallbackTempoBpm);
  const measureStartWholeByIdx = new Map<number, number>();
  for (const seg of timeline.segments) {
    if (typeof seg.measureIndex === "number" && !measureStartWholeByIdx.has(seg.measureIndex)) {
      measureStartWholeByIdx.set(seg.measureIndex, seg.wholeNoteStart);
    }
  }

  const parts = Array.from(doc.getElementsByTagName("part"));
  const primary = findPrimaryHarmonyPart(doc);
  const targetPart = primary?.partEl ?? parts[0];
  const partIndex = primary?.partIndex ?? 0;
  if (!targetPart) return [];

  const measures = Array.from(targetPart.getElementsByTagName("measure"));
  const results: Array<XmlHarmonyEntry & { onsetSec: number }> = [];
  let divisions = 1;
  let beatType = 4;
  let fallbackCurWhole = 0;

  for (let mIdx = 0; mIdx < measures.length; mIdx += 1) {
    const mEl = measures[mIdx];
    const mNum = getMeasureNumber(mEl, mIdx);
    const mStartWhole = measureStartWholeByIdx.get(mIdx) ?? fallbackCurWhole;
    let cursorDivs = 0;
    let maxDivs = 0;
    let harmonyIdx = 0;

    for (const child of Array.from(mEl.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === "attributes") {
        const divTxt = child.getElementsByTagName("divisions")[0]?.textContent;
        const d = divTxt ? Number.parseFloat(divTxt) : NaN;
        if (Number.isFinite(d) && d > 0) divisions = d;
        const btTxt = child.getElementsByTagName("time")[0]?.getElementsByTagName("beat-type")[0]?.textContent;
        const bt = btTxt ? Number.parseInt(btTxt, 10) : NaN;
        if (Number.isFinite(bt) && bt > 0) beatType = bt;
      } else if (tag === "backup") {
        const d = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
        if (Number.isFinite(d) && d > 0) cursorDivs = Math.max(0, cursorDivs - d);
      } else if (tag === "forward") {
        const d = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
        if (Number.isFinite(d) && d > 0) {
          cursorDivs += d;
          maxDivs = Math.max(maxDivs, cursorDivs);
        }
      } else if (tag === "note") {
        const isChord = child.getElementsByTagName("chord").length > 0;
        const isGrace = child.getElementsByTagName("grace").length > 0;
        if (!isChord && !isGrace) {
          const d = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
          if (Number.isFinite(d) && d > 0) {
            cursorDivs += d;
            maxDivs = Math.max(maxDivs, cursorDivs);
          }
        }
      } else if (tag === "harmony") {
        const curHIdx = harmonyIdx++;
        const explicitOff = Number.parseFloat(child.getElementsByTagName("offset")[0]?.textContent || "0");
        const effDivs = Math.max(0, cursorDivs + (Number.isFinite(explicitOff) ? explicitOff : 0));
        const onsetWhole = mStartWhole + effDivs / (divisions * 4);
        const beatUnitQ = getBeatUnitQuarters(beatType);
        const beat = Math.max(1, Number((1 + effDivs / divisions / beatUnitQ).toFixed(3)));
        const formatted = formatHarmonyElementToSymbol(child);
        if (formatted) {
          const onsetSec = Number(wholeNotesToTimeSec(timeline, onsetWhole, fallbackTempoBpm).toFixed(4));
          results.push({
            measureNumber: mNum,
            measureIndex: mIdx,
            partIndex,
            onsetWhole: Math.round(onsetWhole * 10000) / 10000,
            beat,
            symbol: formatted.symbol,
            root: formatted.root,
            quality: formatted.quality,
            harmonyIndexInMeasure: curHIdx,
            onsetSec,
          });
        }
      }
    }

    fallbackCurWhole += (maxDivs > 0 ? maxDivs : divisions * 4) / (divisions * 4);
  }

  return results;
}

/** Derive canonical ScoreChord[] directly from MusicXML `<harmony>` tags. */
export function extractChordsFromMusicXml(
  xmlStr: string | null | undefined,
  fallbackTempoBpm = 120,
): ScoreChord[] {
  return extractHarmoniesFromMusicXml(xmlStr, fallbackTempoBpm).map((h, idx) => ({
    id: `chord_m${h.measureNumber}_${idx}_${Math.round(h.onsetWhole * 1000)}`,
    measure: h.measureNumber,
    beat: h.beat,
    onset_sec: h.onsetSec,
    symbol: h.symbol,
    root: h.root,
    quality: h.quality,
  }));
}

/** Find an existing `<harmony>` at a specific measure and beat offset. */
export function getXmlHarmonyAtPosition(
  xmlStr: string | null | undefined,
  target: { measureNumber: number; onsetWhole: number; toleranceWhole?: number },
): XmlHarmonyEntry | null {
  const harmonies = extractHarmoniesFromMusicXml(xmlStr);
  const tol = target.toleranceWhole ?? 0.032; // ~1/32nd whole note tolerance
  let best: XmlHarmonyEntry | null = null;
  let bestDist = Infinity;
  for (const h of harmonies) {
    if (h.measureNumber !== target.measureNumber) continue;
    const d = Math.abs(h.onsetWhole - target.onsetWhole);
    if (d <= tol && d < bestDist) {
      bestDist = d;
      best = h;
    }
  }
  return best;
}

/**
 * Insert, update, or delete a MusicXML `<harmony>` symbol at an exact measure and whole-note beat
 * without altering any note durations, voices, or measure timing.
 */
export function upsertXmlHarmony(
  xmlStr: string,
  target: { measureNumber: number; onsetWhole: number; existingHarmonyIndex?: number },
  chordSymbol: string | null,
): { xml: string; symbol: string | null; parsed: ParsedChord | null; error?: string } | null {
  if (!xmlStr || typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    return null;
  }
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xmlStr, "application/xml");
    if (doc.querySelector("parsererror")) return null;
  } catch {
    return null;
  }

  const trimmed = (chordSymbol ?? "").trim();
  let parsedChord: ParsedChord | null = null;
  if (trimmed.length > 0) {
    const res = parseChordSymbolStrict(trimmed);
    if (!res.ok) {
      return { xml: xmlStr, symbol: null, parsed: null, error: res.error };
    }
    parsedChord = res.chord;
  }

  const primary = findPrimaryHarmonyPart(doc);
  if (!primary) return null;
  const targetPart = primary.partEl;
  const measures = Array.from(targetPart.getElementsByTagName("measure"));
  const timeline = buildMusicXmlTimeline(xmlStr, 120);
  const measureStartWholeByIdx = new Map<number, number>();
  for (const seg of timeline.segments) {
    if (typeof seg.measureIndex === "number" && !measureStartWholeByIdx.has(seg.measureIndex)) {
      measureStartWholeByIdx.set(seg.measureIndex, seg.wholeNoteStart);
    }
  }

  let divisions = 1;
  let fallbackCurWhole = 0;

  for (let mIdx = 0; mIdx < measures.length; mIdx += 1) {
    const mEl = measures[mIdx];
    const mNum = getMeasureNumber(mEl, mIdx);
    const mStartWhole = measureStartWholeByIdx.get(mIdx) ?? fallbackCurWhole;

    let maxDivs = 0;
    let scanDivs = 0;
    for (const ch of Array.from(mEl.children)) {
      const tag = ch.tagName.toLowerCase();
      if (tag === "attributes") {
        const divTxt = ch.getElementsByTagName("divisions")[0]?.textContent;
        const d = divTxt ? Number.parseFloat(divTxt) : NaN;
        if (Number.isFinite(d) && d > 0) divisions = d;
      } else if (tag === "backup") {
        const d = Number.parseFloat(ch.getElementsByTagName("duration")[0]?.textContent || "0");
        if (Number.isFinite(d) && d > 0) scanDivs = Math.max(0, scanDivs - d);
      } else if (tag === "forward") {
        const d = Number.parseFloat(ch.getElementsByTagName("duration")[0]?.textContent || "0");
        if (Number.isFinite(d) && d > 0) {
          scanDivs += d;
          maxDivs = Math.max(maxDivs, scanDivs);
        }
      } else if (tag === "note") {
        const isChord = ch.getElementsByTagName("chord").length > 0;
        const isGrace = ch.getElementsByTagName("grace").length > 0;
        if (!isChord && !isGrace) {
          const d = Number.parseFloat(ch.getElementsByTagName("duration")[0]?.textContent || "0");
          if (Number.isFinite(d) && d > 0) {
            scanDivs += d;
            maxDivs = Math.max(maxDivs, scanDivs);
          }
        }
      }
    }

    if (mNum !== target.measureNumber) {
      fallbackCurWhole += (maxDivs > 0 ? maxDivs : divisions * 4) / (divisions * 4);
      continue;
    }

    const desiredLocalWhole = Math.max(0, target.onsetWhole - mStartWhole);
    const desiredLocalDivs = Math.round(desiredLocalWhole * divisions * 4);

    // Track first pass through the measure to find existing <harmony> & anchor <note>/<forward> positions
    let cursorDivs = 0;
    let passedFirstVoice = false;
    let matchedHarmony: Element | null = null;
    let bestHarmonyDist = Infinity;
    let harmonyCounter = 0;
    let insertBeforeNode: Element | null = null;
    let anchorDivsAtInsert = 0;

    for (const child of Array.from(mEl.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === "harmony") {
        const hIdx = harmonyCounter++;
        const explicitOff = Number.parseFloat(child.getElementsByTagName("offset")[0]?.textContent || "0");
        const effDivs = cursorDivs + (Number.isFinite(explicitOff) ? explicitOff : 0);
        if (target.existingHarmonyIndex !== undefined && hIdx === target.existingHarmonyIndex) {
          matchedHarmony = child;
          anchorDivsAtInsert = cursorDivs;
        } else {
          const dist = Math.abs(effDivs - desiredLocalDivs);
          if (dist <= Math.max(1, divisions * 0.125) && dist < bestHarmonyDist) {
            bestHarmonyDist = dist;
            matchedHarmony = child;
            anchorDivsAtInsert = cursorDivs;
          }
        }
      } else if (tag === "backup") {
        passedFirstVoice = true;
        if (!insertBeforeNode) {
          insertBeforeNode = child;
          anchorDivsAtInsert = cursorDivs;
        }
        const d = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
        if (Number.isFinite(d) && d > 0) cursorDivs = Math.max(0, cursorDivs - d);
      } else if (!passedFirstVoice && (tag === "note" || tag === "forward")) {
        const isChord = tag === "note" && child.getElementsByTagName("chord").length > 0;
        const isGrace = tag === "note" && child.getElementsByTagName("grace").length > 0;
        if (!isChord && !isGrace) {
          const d = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
          const safeDur = Number.isFinite(d) && d > 0 ? d : 0;
          if (!insertBeforeNode && cursorDivs + 0.01 >= desiredLocalDivs) {
            insertBeforeNode = child;
            anchorDivsAtInsert = cursorDivs;
          }
          // If desired position falls INSIDE this note (after start, before end), anchor BEFORE this note with positive <offset>
          if (
            !insertBeforeNode &&
            desiredLocalDivs > cursorDivs &&
            desiredLocalDivs < cursorDivs + safeDur
          ) {
            insertBeforeNode = child;
            anchorDivsAtInsert = cursorDivs;
          }
          cursorDivs += safeDur;
        }
      } else if (!passedFirstVoice && tag === "barline" && !insertBeforeNode) {
        insertBeforeNode = child;
        anchorDivsAtInsert = cursorDivs;
      }
    }

    if (!insertBeforeNode) {
      anchorDivsAtInsert = cursorDivs;
    }

    if (!parsedChord) {
      if (matchedHarmony) {
        matchedHarmony.parentNode?.removeChild(matchedHarmony);
      }
      return { xml: serializeXmlDocument(doc), symbol: null, parsed: null };
    }

    if (matchedHarmony) {
      const explicitOff = Number.parseFloat(matchedHarmony.getElementsByTagName("offset")[0]?.textContent || "0");
      const preservedOffset = Number.isFinite(explicitOff) && Math.round(explicitOff) !== 0 ? explicitOff : undefined;
      const replacement = buildHarmonyElement(doc, parsedChord, preservedOffset);
      mEl.insertBefore(replacement, matchedHarmony);
      matchedHarmony.parentNode?.removeChild(matchedHarmony);
      return {
        xml: serializeXmlDocument(doc),
        symbol: parsedChord.normalizedSymbol,
        parsed: parsedChord,
      };
    }

    const offsetDiv = desiredLocalDivs - anchorDivsAtInsert;
    const nextHarmony = buildHarmonyElement(
      doc,
      parsedChord,
      Math.abs(offsetDiv) >= Math.max(1, divisions * 0.05) ? offsetDiv : undefined,
    );
    if (insertBeforeNode && insertBeforeNode.parentNode === mEl) {
      mEl.insertBefore(nextHarmony, insertBeforeNode);
    } else {
      mEl.appendChild(nextHarmony);
    }
    return {
      xml: serializeXmlDocument(doc),
      symbol: parsedChord.normalizedSymbol,
      parsed: parsedChord,
    };
  }

  return null;
}

/**
 * Advance to the next beat position in the score (respecting measure beat units, pickup lengths,
 * and meter changes) for Tab / Space chord-entry progression.
 */
export function advanceChordBeatPosition(
  xmlStr: string,
  current: { measureNumber: number; onsetWhole: number; partIndex?: number },
): { measureNumber: number; onsetWhole: number; partIndex: number } | null {
  const structure = extractScoreStructure(xmlStr);
  const timeline = buildMusicXmlTimeline(xmlStr, 120);
  if (structure.measures.length === 0) return null;

  const measureRanges = new Map<number, { wholeStart: number; wholeEnd: number }>();
  for (const seg of timeline.segments) {
    const prev = measureRanges.get(seg.measureNumber);
    if (!prev) {
      measureRanges.set(seg.measureNumber, { wholeStart: seg.wholeNoteStart, wholeEnd: seg.wholeNoteEnd });
    } else {
      prev.wholeEnd = Math.max(prev.wholeEnd, seg.wholeNoteEnd);
    }
  }

  const mIdx = structure.measures.findIndex((m) => m.measureNumber === current.measureNumber);
  if (mIdx < 0) return null;
  const curMeasure = structure.measures[mIdx];
  const range = measureRanges.get(curMeasure.measureNumber);
  if (!range) return null;

  const beatWhole = getBeatUnitQuarters(curMeasure.timeBeatType) / 4;
  const nextBeatWhole = Math.round((current.onsetWhole + beatWhole) * 10000) / 10000;

  if (nextBeatWhole < range.wholeEnd - 0.015) {
    return {
      measureNumber: curMeasure.measureNumber,
      onsetWhole: nextBeatWhole,
      partIndex: current.partIndex ?? 0,
    };
  }

  const nextMeasure = structure.measures[mIdx + 1];
  if (!nextMeasure) return null;
  const nextRange = measureRanges.get(nextMeasure.measureNumber);
  if (!nextRange) return null;

  return {
    measureNumber: nextMeasure.measureNumber,
    onsetWhole: Math.round(nextRange.wholeStart * 10000) / 10000,
    partIndex: current.partIndex ?? 0,
  };
}
