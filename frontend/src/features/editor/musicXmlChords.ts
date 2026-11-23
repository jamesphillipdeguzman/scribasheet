import { buildMusicXmlTimeline } from "@/features/editor/musicXmlTimeline";
import type { ScoreChord, ScoreNote } from "@/types/api";

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

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

const KIND_MAP: Array<[RegExp, { kind: string; kindText: string }]> = [
  [/^(maj7|M7|\u03947?)$/, { kind: "major-seventh", kindText: "maj7" }],
  [/^(m7b5|\u00f87?)$/, { kind: "half-diminished", kindText: "m7b5" }],
  [/^(dim7|\u00b07)$/, { kind: "diminished-seventh", kindText: "dim7" }],
  [/^(m7|min7|-7)$/, { kind: "minor-seventh", kindText: "m7" }],
  [/^(7|dom7)$/, { kind: "dominant", kindText: "7" }],
  [/^(m|min|-|minor)$/i, { kind: "minor", kindText: "m" }],
  [/^(dim|\u00b0|diminished)$/i, { kind: "diminished", kindText: "dim" }],
  [/^(aug|\+|augmented)$/i, { kind: "augmented", kindText: "aug" }],
  [/^(sus4|sus)$/i, { kind: "suspended-fourth", kindText: "sus4" }],
  [/^(sus2)$/i, { kind: "suspended-second", kindText: "sus2" }],
  [/^(maj|major|M)?$/i, { kind: "major", kindText: "" }],
];

function parsePitchClassName(raw: string): { step: string; alter: number } | null {
  const m = raw.trim().match(/^([A-Ga-g])([#b\u266f\u266d]?)/);
  if (!m) return null;
  const step = m[1].toUpperCase();
  const acc = m[2];
  const alter = acc === "#" || acc === "\u266f" ? 1 : acc === "b" || acc === "\u266d" ? -1 : 0;
  return { step, alter };
}

function parseChordSymbol(symbol: string, fallbackRoot?: string, fallbackQuality?: string): {
  rootStep: string;
  rootAlter: number;
  kind: string;
  kindText: string;
  bassStep?: string;
  bassAlter?: number;
} | null {
  const clean = symbol.trim();
  if (!clean) return null;

  const [mainPart, bassPart] = clean.split("/");
  const m = mainPart.match(/^([A-Ga-g])([#b\u266f\u266d]?)(.*)$/);
  let rootStep: string;
  let rootAlter = 0;
  let rest = "";

  if (m) {
    rootStep = m[1].toUpperCase();
    const acc = m[2];
    rootAlter = acc === "#" || acc === "\u266f" ? 1 : acc === "b" || acc === "\u266d" ? -1 : 0;
    rest = m[3].trim();
  } else if (fallbackRoot) {
    const parsedRoot = parsePitchClassName(fallbackRoot);
    if (!parsedRoot) return null;
    rootStep = parsedRoot.step;
    rootAlter = parsedRoot.alter;
    rest = fallbackQuality || "";
  } else {
    return null;
  }

  let kind = "major";
  let kindText = "";
  for (const [re, mapped] of KIND_MAP) {
    if (re.test(rest)) {
      kind = mapped.kind;
      kindText = mapped.kindText;
      break;
    }
  }

  let bassStep: string | undefined;
  let bassAlter: number | undefined;
  if (bassPart) {
    const parsedBass = parsePitchClassName(bassPart);
    if (parsedBass) {
      bassStep = parsedBass.step;
      bassAlter = parsedBass.alter;
    }
  }

  return { rootStep, rootAlter, kind, kindText, bassStep, bassAlter };
}

function inferChordFromPitches(
  pitchesMidi: number[],
  preferFlats: boolean,
): { symbol: string } | null {
  if (pitchesMidi.length < 2) return null;
  const sorted = [...pitchesMidi].sort((a, b) => a - b);
  const bassPc = ((sorted[0] % 12) + 12) % 12;
  const pitchClasses = Array.from(new Set(sorted.map((p) => ((p % 12) + 12) % 12)));
  if (pitchClasses.length < 2) return null;

  const names = preferFlats ? FLAT_NAMES : SHARP_NAMES;
  let bestScore = -1;
  let bestSymbol: string | null = null;

  for (const rootPc of pitchClasses) {
    const relSet = new Set(pitchClasses.map((pc) => (pc - rootPc + 12) % 12));
    for (const tpl of CHORD_TEMPLATES) {
      const matched = tpl.intervals.filter((iv) => relSet.has(iv)).length;
      if (matched < 2) continue;
      if (pitchClasses.length >= 3 && matched < 3) continue;
      // Score: matched template tones - unmatched extra tones + small bonus if bass is root
      const extra = pitchClasses.length - matched;
      const rootBonus = rootPc === bassPc ? 0.35 : 0;
      const triadBonus = tpl.intervals.length === 3 && matched === 3 ? 0.15 : 0;
      const score = matched * 2 - extra * 0.75 + rootBonus + triadBonus;
      if (score > bestScore) {
        bestScore = score;
        bestSymbol = `${names[rootPc]}${tpl.suffix}`;
      }
    }
  }

  // Dyad fallback (root + 3rd) only when 2 pitch classes are present
  if (!bestSymbol && pitchClasses.length === 2) {
    for (const rootPc of pitchClasses) {
      const other = pitchClasses.find((pc) => pc !== rootPc)!;
      const iv = (other - rootPc + 12) % 12;
      if (iv === 4) return { symbol: names[rootPc] };
      if (iv === 3) return { symbol: `${names[rootPc]}m` };
    }
  }

  return bestSymbol ? { symbol: bestSymbol } : null;
}

function findTargetPart(doc: Document): Element | null {
  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length === 0) return null;

  const scoreParts = Array.from(doc.getElementsByTagName("score-part"));
  for (const sp of scoreParts) {
    const id = sp.getAttribute("id");
    const name = sp.getElementsByTagName("part-name")[0]?.textContent?.trim() || "";
    if (id && /\bsoprano\b/i.test(name)) {
      const matched = parts.find((p) => p.getAttribute("id") === id);
      if (matched) return matched;
    }
  }
  return parts[0];
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
): string {
  if (!xml || !xml.includes("<score-") || typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    return xml;
  }

  try {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) return xml;

    const targetPart = findTargetPart(doc);
    if (!targetPart) return xml;

    const measures = Array.from(targetPart.getElementsByTagName("measure"));
    if (measures.length === 0) return xml;

    const fifthsText = doc.getElementsByTagName("fifths")[0]?.textContent?.trim();
    const fifthsVal = fifthsText ? Number(fifthsText) : 0;
    const preferFlats = Number.isFinite(fifthsVal) && fifthsVal < 0;

    const timeline = buildMusicXmlTimeline(xml, tempoBpm);

    // Collect existing <harmony> positions and <note> insertion anchors per measure
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
          harmOffsets.push(cursorDivs / divisions);
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

        placements.push({
          measureIdx: mIdx,
          quarterOffset: qOffset,
          symbol: ch.symbol,
          root: ch.root,
          quality: ch.quality,
        });
      }
    } else if (notes.length > 0 && timeline.segments.length > 0) {
      // Infer chords from simultaneous SATB notes at beat positions
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
            preferFlats,
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

      const parsed = parseChordSymbol(p.symbol, p.root, p.quality);
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
    const serialized = new XMLSerializer().serializeToString(doc).replace(/^\uFEFF/, "").trim();
    if (serialized.startsWith("<?xml")) return serialized;
    return `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
  } catch {
    return xml;
  }
}
