import type { XmlNoteTarget } from "@/features/editor/musicXmlEditor";
import { getMeasureNumber } from "@/features/editor/musicXmlStructure";
import { buildMusicXmlTimeline, wholeNotesToTimeSec } from "@/features/editor/musicXmlTimeline";
import { STEP_TO_PC } from "@/lib/keySignature";
import type { LyricSegment, LyricsData, LyricWord } from "@/types/api";

export type LyricSyllabic = "single" | "begin" | "middle" | "end";
export type LyricExtendType = "start" | "continue" | "stop";
export type LyricVerseNumber = 1 | 2 | 3;

export interface XmlLyricEntry {
  verse: number;
  text: string;
  syllabic: LyricSyllabic | null;
  extendType: LyricExtendType | null;
  hasExtend: boolean;
}

interface ScannedNoteNode {
  partEl: Element;
  partIndex: number;
  measureEl: Element;
  measureIdx: number;
  measureNumber: number;
  noteEl: Element;
  noteIdxInMeasure: number;
  staffNumber: number;
  voice: string;
  onsetWhole: number;
  endWhole: number;
  pitchMidi: number | null;
  isRest: boolean;
  isChord: boolean;
  isGrace: boolean;
  anchorNoteIdxInMeasure: number;
  target: XmlNoteTarget;
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

function getNoteMidi(noteEl: Element): number | null {
  const pitchEl = noteEl.getElementsByTagName("pitch")[0];
  if (!pitchEl) return null;
  const step = (pitchEl.getElementsByTagName("step")[0]?.textContent || "C").trim().toUpperCase();
  const alter = Number.parseInt(pitchEl.getElementsByTagName("alter")[0]?.textContent || "0", 10) || 0;
  const oct = Number.parseInt(pitchEl.getElementsByTagName("octave")[0]?.textContent || "4", 10) || 4;
  return Math.max(0, Math.min(127, (oct + 1) * 12 + (STEP_TO_PC[step] ?? 0) + alter));
}

function parseXmlDocument(xmlStr: string): Document | null {
  if (!xmlStr || typeof DOMParser === "undefined") return null;
  try {
    const doc = new DOMParser().parseFromString(xmlStr, "application/xml");
    return doc.querySelector("parsererror") ? null : doc;
  } catch {
    return null;
  }
}

function serializeXmlDocument(doc: Document): string {
  const raw = new XMLSerializer().serializeToString(doc).replace(/^\uFEFF/, "").trim();
  if (raw.startsWith("<?xml")) return raw;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${raw}`;
}

function scanPartNotes(doc: Document, partIndex: number, timelineFallbackTempo = 120): ScannedNoteNode[] {
  const parts = Array.from(doc.getElementsByTagName("part"));
  const partEl = parts[partIndex];
  if (!partEl) return [];

  const xmlSerialized = new XMLSerializer().serializeToString(doc);
  const timeline = buildMusicXmlTimeline(xmlSerialized, timelineFallbackTempo);
  const measureStartWholeByIdx = new Map<number, number>();
  for (const seg of timeline.segments) {
    if (typeof seg.measureIndex === "number" && !measureStartWholeByIdx.has(seg.measureIndex)) {
      measureStartWholeByIdx.set(seg.measureIndex, seg.wholeNoteStart);
    }
  }

  const measures = Array.from(partEl.getElementsByTagName("measure"));
  const out: ScannedNoteNode[] = [];
  let divisions = 1;
  let fallbackCurWhole = 0;

  for (let mIdx = 0; mIdx < measures.length; mIdx += 1) {
    const mEl = measures[mIdx];
    const mNum = getMeasureNumber(mEl, mIdx);
    const mStartWhole = measureStartWholeByIdx.get(mIdx) ?? fallbackCurWhole;
    let offsetDiv = 0;
    let lastNoteStartDiv = 0;
    let lastNonChordIdxInMeasure = 0;
    let maxDiv = 0;
    let noteCounter = 0;

    for (const child of Array.from(mEl.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === "attributes") {
        const d = Number.parseFloat(child.getElementsByTagName("divisions")[0]?.textContent || "");
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
        const curNoteIdx = noteCounter++;
        const isChord = child.getElementsByTagName("chord").length > 0;
        const isGrace = child.getElementsByTagName("grace").length > 0;
        const isRest = child.getElementsByTagName("rest").length > 0;
        const dur = !isGrace
          ? Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0")
          : 0;
        const safeDur = Number.isFinite(dur) && dur > 0 ? dur : 0;
        const startDiv = isChord ? lastNoteStartDiv : offsetDiv;
        if (!isChord) {
          lastNonChordIdxInMeasure = curNoteIdx;
        }
        const onsetWhole = Math.round((mStartWhole + startDiv / (divisions * 4)) * 10000) / 10000;
        const endWhole = Math.round((mStartWhole + (startDiv + safeDur) / (divisions * 4)) * 10000) / 10000;
        const staffNumber = getNoteStaffNumber(child);
        const voice = getNoteVoice(child);
        const pitchMidi = isRest ? null : getNoteMidi(child);

        out.push({
          partEl,
          partIndex,
          measureEl: mEl,
          measureIdx: mIdx,
          measureNumber: mNum,
          noteEl: child,
          noteIdxInMeasure: curNoteIdx,
          staffNumber,
          voice,
          onsetWhole,
          endWhole,
          pitchMidi,
          isRest,
          isChord,
          isGrace,
          anchorNoteIdxInMeasure: isChord ? lastNonChordIdxInMeasure : curNoteIdx,
          target: {
            partIndex,
            measureNumber: mNum,
            onsetWhole,
            pitchMidi,
            staffNumber,
            voice,
            noteIndex: curNoteIdx,
            noteId: `p${partIndex}:m${mNum}:s${staffNumber}:o${Math.round(onsetWhole * 1000)}:p${pitchMidi ?? "rest"}`,
          },
        });

        if (!isChord && !isGrace) {
          lastNoteStartDiv = offsetDiv;
          if (safeDur > 0) {
            offsetDiv += safeDur;
            maxDiv = Math.max(maxDiv, offsetDiv);
          }
        }
      }
    }

    fallbackCurWhole += (maxDiv > 0 ? maxDiv : divisions * 4) / (divisions * 4);
  }

  return out;
}

function matchScannedNote(scanned: ScannedNoteNode[], target: XmlNoteTarget): ScannedNoteNode | null {
  const candidates = scanned.filter(
    (s) =>
      s.measureNumber === target.measureNumber &&
      (target.staffNumber === undefined || s.staffNumber === target.staffNumber),
  );
  if (candidates.length === 0) return null;

  if (target.noteIndex !== undefined) {
    const exactIdx = candidates.find(
      (s) =>
        s.noteIdxInMeasure === target.noteIndex &&
        (target.pitchMidi === null || s.pitchMidi === target.pitchMidi),
    );
    if (exactIdx) return exactIdx;
  }

  // Exact onset + pitch match
  const onsetPitch = candidates.find(
    (s) =>
      Math.abs(s.onsetWhole - target.onsetWhole) < 0.015 &&
      (target.pitchMidi === null || s.pitchMidi === target.pitchMidi),
  );
  if (onsetPitch) return onsetPitch;

  // Onset + staff + voice fallback (e.g. if target pitch differs after edit)
  const onsetOnly = candidates.find(
    (s) =>
      !s.isChord &&
      Math.abs(s.onsetWhole - target.onsetWhole) < 0.015 &&
      (!target.voice || s.voice === target.voice),
  );
  return onsetOnly ?? null;
}

function getVerseLyricElement(noteEl: Element, verse: number): Element | null {
  for (const lyr of Array.from(noteEl.children)) {
    if (lyr.tagName.toLowerCase() !== "lyric") continue;
    const rawNum = lyr.getAttribute("number") || "1";
    const parsed = Number.parseInt(rawNum, 10);
    if ((Number.isFinite(parsed) ? parsed : 1) === verse) {
      return lyr;
    }
  }
  return null;
}

function readLyricElement(lyrEl: Element, verse: number): XmlLyricEntry {
  const txt = Array.from(lyrEl.getElementsByTagName("text"))
    .map((t) => t.textContent || "")
    .join("");
  const sylRaw = (lyrEl.getElementsByTagName("syllabic")[0]?.textContent || "").trim().toLowerCase();
  const syllabic: LyricSyllabic | null =
    sylRaw === "single" || sylRaw === "begin" || sylRaw === "middle" || sylRaw === "end"
      ? sylRaw
      : null;
  const extEl = lyrEl.getElementsByTagName("extend")[0];
  const extTypeRaw = (extEl?.getAttribute("type") || "").trim().toLowerCase();
  const extendType: LyricExtendType | null = extEl
    ? extTypeRaw === "continue" || extTypeRaw === "stop" || extTypeRaw === "start"
      ? extTypeRaw
      : "start"
    : null;
  return {
    verse,
    text: txt,
    syllabic,
    extendType,
    hasExtend: Boolean(extEl),
  };
}

function writeVerseLyricOnNote(
  doc: Document,
  noteEl: Element,
  verse: number,
  lyric: { text: string; syllabic: LyricSyllabic | null; extendType?: LyricExtendType | null } | null,
): void {
  const existing = getVerseLyricElement(noteEl, verse);
  if (existing) {
    existing.parentNode?.removeChild(existing);
  }

  const trimmed = lyric?.text?.trim() ?? "";
  const extendType = lyric?.extendType ?? null;
  if (!trimmed && !extendType) {
    return;
  }

  const newLyr = doc.createElement("lyric");
  newLyr.setAttribute("number", String(verse));

  if (trimmed && lyric?.syllabic) {
    const sylEl = doc.createElement("syllabic");
    sylEl.textContent = lyric.syllabic;
    newLyr.appendChild(sylEl);
  }

  if (trimmed) {
    const txtEl = doc.createElement("text");
    txtEl.textContent = trimmed;
    newLyr.appendChild(txtEl);
  }

  if (extendType) {
    const extEl = doc.createElement("extend");
    extEl.setAttribute("type", extendType);
    newLyr.appendChild(extEl);
  }

  // Re-insert all <lyric> children on this note sorted by verse number (preserving other verses)
  const existingLyrics = Array.from(noteEl.children).filter(
    (c) => c.tagName.toLowerCase() === "lyric",
  );
  for (const el of existingLyrics) {
    el.parentNode?.removeChild(el);
  }
  const combined = [...existingLyrics, newLyr].sort((a, b) => {
    const na = Number.parseInt(a.getAttribute("number") || "1", 10) || 1;
    const nb = Number.parseInt(b.getAttribute("number") || "1", 10) || 1;
    return na - nb;
  });
  for (const el of combined) {
    noteEl.appendChild(el);
  }
}

/**
 * Resolve whether a clicked/selected target can host an inline lyric, resolving `<chord/>`
 * secondary noteheads to their primary rhythmic anchor and rejecting rests/grace notes.
 */
export function resolveLyricAnchorTarget(
  xmlStr: string,
  target: XmlNoteTarget | null,
):
  | { eligible: true; target: XmlNoteTarget; staffNumber: number; voice: string }
  | { eligible: false; reason: string } {
  if (!target) {
    return {
      eligible: false,
      reason: "Select a melody note first to enter lyrics (Ctrl+L).",
    };
  }
  const doc = parseXmlDocument(xmlStr);
  if (!doc) {
    return { eligible: false, reason: "Score XML could not be parsed." };
  }
  const scanned = scanPartNotes(doc, target.partIndex);
  const matched = matchScannedNote(scanned, target);
  if (!matched) {
    return {
      eligible: false,
      reason: "Select a pitched melody note to enter lyrics.",
    };
  }
  if (matched.isRest) {
    return {
      eligible: false,
      reason: "Select a pitched melody note to enter lyrics (rests cannot carry lyrics).",
    };
  }
  if (matched.isGrace) {
    return {
      eligible: false,
      reason: "Select a main pitched melody note to enter lyrics.",
    };
  }

  let anchor = matched;
  if (matched.isChord) {
    const primary = scanned.find(
      (s) =>
        s.measureIdx === matched.measureIdx &&
        s.noteIdxInMeasure === matched.anchorNoteIdxInMeasure &&
        !s.isRest,
    );
    if (primary) anchor = primary;
  }

  return {
    eligible: true,
    target: anchor.target,
    staffNumber: anchor.staffNumber,
    voice: anchor.voice,
  };
}

/** Read the existing lyric syllable / extension on a target note for a given verse (1..3). */
export function getXmlNoteLyric(
  xmlStr: string,
  target: XmlNoteTarget,
  verse: number,
): XmlLyricEntry | null {
  const doc = parseXmlDocument(xmlStr);
  if (!doc) return null;
  const scanned = scanPartNotes(doc, target.partIndex);
  const matched = matchScannedNote(scanned, target);
  if (!matched) return null;

  let noteEl = matched.noteEl;
  if (matched.isChord) {
    const anchor = scanned.find(
      (s) => s.measureIdx === matched.measureIdx && s.noteIdxInMeasure === matched.anchorNoteIdxInMeasure,
    );
    if (anchor) noteEl = anchor.noteEl;
  }

  const lyrEl = getVerseLyricElement(noteEl, verse);
  return lyrEl ? readLyricElement(lyrEl, verse) : null;
}

/**
 * Find the next or previous eligible pitched non-rest, non-chord note in the same staff & voice.
 */
export function findNextLyricNoteTarget(
  xmlStr: string,
  current: XmlNoteTarget,
  direction: "next" | "prev" = "next",
): XmlNoteTarget | null {
  const doc = parseXmlDocument(xmlStr);
  if (!doc) return null;
  const scanned = scanPartNotes(doc, current.partIndex);
  const matched = matchScannedNote(scanned, current);
  if (!matched) return null;

  const sameStream = scanned.filter(
    (s) =>
      !s.isRest &&
      !s.isChord &&
      !s.isGrace &&
      s.staffNumber === matched.staffNumber &&
      s.voice === matched.voice,
  );
  const curIdx = sameStream.findIndex(
    (s) =>
      s.measureIdx === matched.measureIdx &&
      (s.noteIdxInMeasure === matched.anchorNoteIdxInMeasure || s.noteIdxInMeasure === matched.noteIdxInMeasure),
  );
  if (curIdx < 0) return null;

  const nextIdx = direction === "next" ? curIdx + 1 : curIdx - 1;
  return sameStream[nextIdx]?.target ?? null;
}

/**
 * Set, update, or remove a single verse lyric on a specific note without affecting other verses
 * or note timing. Empty text without extend removes that verse's `<lyric>` element cleanly.
 */
export function setXmlNoteLyric(
  xmlStr: string,
  target: XmlNoteTarget,
  verse: number,
  lyric: { text: string; syllabic: LyricSyllabic | null; extendType?: LyricExtendType | null } | null,
): { xml: string; nextTarget: XmlNoteTarget; changed: boolean } | null {
  const doc = parseXmlDocument(xmlStr);
  if (!doc) return null;
  const scanned = scanPartNotes(doc, target.partIndex);
  const matched = matchScannedNote(scanned, target);
  if (!matched || matched.isRest || matched.isGrace) return null;

  const anchor = matched.isChord
    ? scanned.find(
        (s) =>
          s.measureIdx === matched.measureIdx &&
          s.noteIdxInMeasure === matched.anchorNoteIdxInMeasure,
      ) ?? matched
    : matched;

  const prevEl = getVerseLyricElement(anchor.noteEl, verse);
  const prevRead = prevEl ? readLyricElement(prevEl, verse) : null;
  const nextText = lyric?.text?.trim() ?? "";
  const nextSyllabic = nextText ? (lyric?.syllabic ?? null) : null;
  const nextExtend = lyric?.extendType ?? null;

  if (!prevRead && !nextText && !nextExtend) {
    return { xml: xmlStr, nextTarget: anchor.target, changed: false };
  }
  if (
    prevRead &&
    prevRead.text.trim() === nextText &&
    prevRead.syllabic === nextSyllabic &&
    prevRead.extendType === nextExtend
  ) {
    return { xml: xmlStr, nextTarget: anchor.target, changed: false };
  }

  writeVerseLyricOnNote(doc, anchor.noteEl, verse, lyric);
  return {
    xml: serializeXmlDocument(doc),
    nextTarget: anchor.target,
    changed: true,
  };
}

/**
 * Handle MuseScore-style `_` melisma entry across held or tied notes on the same staff and voice:
 * attaches `<extend type="start"/>` on the syllable origin and `<extend type="continue|stop"/>`
 * across subsequent melisma notes.
 */
export function extendXmlNoteMelisma(
  xmlStr: string,
  target: XmlNoteTarget,
  verse: number,
  draftText: string,
  inWord: boolean,
): { xml: string; nextTarget: XmlNoteTarget | null; appliedTarget: XmlNoteTarget } | null {
  const doc = parseXmlDocument(xmlStr);
  if (!doc) return null;
  const scanned = scanPartNotes(doc, target.partIndex);
  const matched = matchScannedNote(scanned, target);
  if (!matched || matched.isRest || matched.isGrace) return null;

  const anchor = matched.isChord
    ? scanned.find(
        (s) =>
          s.measureIdx === matched.measureIdx &&
          s.noteIdxInMeasure === matched.anchorNoteIdxInMeasure,
      ) ?? matched
    : matched;

  const sameStream = scanned.filter(
    (s) =>
      !s.isRest &&
      !s.isChord &&
      !s.isGrace &&
      s.staffNumber === anchor.staffNumber &&
      s.voice === anchor.voice,
  );
  const curIdx = sameStream.findIndex(
    (s) => s.measureIdx === anchor.measureIdx && s.noteIdxInMeasure === anchor.noteIdxInMeasure,
  );
  if (curIdx < 0) return null;

  const nextNode = sameStream[curIdx + 1] ?? null;
  const trimmed = draftText.trim();

  if (trimmed) {
    writeVerseLyricOnNote(doc, anchor.noteEl, verse, {
      text: trimmed,
      syllabic: inWord ? "end" : "single",
      extendType: "start",
    });
    if (nextNode) {
      const nextExisting = getVerseLyricElement(nextNode.noteEl, verse);
      const nextRead = nextExisting ? readLyricElement(nextExisting, verse) : null;
      if (!nextRead?.text) {
        writeVerseLyricOnNote(doc, nextNode.noteEl, verse, {
          text: "",
          syllabic: null,
          extendType: "stop",
        });
      }
    }
    return {
      xml: serializeXmlDocument(doc),
      nextTarget: nextNode?.target ?? null,
      appliedTarget: anchor.target,
    };
  }

  // Empty draft: extend an existing syllable or upgrade an existing melisma stop -> continue
  const curExisting = getVerseLyricElement(anchor.noteEl, verse);
  const curRead = curExisting ? readLyricElement(curExisting, verse) : null;

  if (curRead && curRead.text) {
    writeVerseLyricOnNote(doc, anchor.noteEl, verse, {
      text: curRead.text,
      syllabic: curRead.syllabic ?? "single",
      extendType: "start",
    });
    if (nextNode) {
      const nextExisting = getVerseLyricElement(nextNode.noteEl, verse);
      const nextRead = nextExisting ? readLyricElement(nextExisting, verse) : null;
      if (!nextRead?.text) {
        writeVerseLyricOnNote(doc, nextNode.noteEl, verse, {
          text: "",
          syllabic: null,
          extendType: "stop",
        });
      }
    }
    return {
      xml: serializeXmlDocument(doc),
      nextTarget: nextNode?.target ?? null,
      appliedTarget: anchor.target,
    };
  }

  if (curRead && curRead.hasExtend) {
    writeVerseLyricOnNote(doc, anchor.noteEl, verse, {
      text: "",
      syllabic: null,
      extendType: nextNode ? "continue" : "stop",
    });
    if (nextNode) {
      const nextExisting = getVerseLyricElement(nextNode.noteEl, verse);
      const nextRead = nextExisting ? readLyricElement(nextExisting, verse) : null;
      if (!nextRead?.text) {
        writeVerseLyricOnNote(doc, nextNode.noteEl, verse, {
          text: "",
          syllabic: null,
          extendType: "stop",
        });
      }
    }
    return {
      xml: serializeXmlDocument(doc),
      nextTarget: nextNode?.target ?? null,
      appliedTarget: anchor.target,
    };
  }

  // Current note has no lyric yet: link from previous note in the stream if possible
  const prevNode = curIdx > 0 ? sameStream[curIdx - 1] : null;
  if (prevNode) {
    const prevExisting = getVerseLyricElement(prevNode.noteEl, verse);
    const prevRead = prevExisting ? readLyricElement(prevExisting, verse) : null;
    if (prevRead && (prevRead.text || prevRead.hasExtend)) {
      if (prevRead.text) {
        writeVerseLyricOnNote(doc, prevNode.noteEl, verse, {
          text: prevRead.text,
          syllabic: prevRead.syllabic ?? "single",
          extendType: "start",
        });
      } else {
        writeVerseLyricOnNote(doc, prevNode.noteEl, verse, {
          text: "",
          syllabic: null,
          extendType: "continue",
        });
      }
      writeVerseLyricOnNote(doc, anchor.noteEl, verse, {
        text: "",
        syllabic: null,
        extendType: "stop",
      });
      return {
        xml: serializeXmlDocument(doc),
        nextTarget: nextNode?.target ?? null,
        appliedTarget: anchor.target,
      };
    }
  }

  return null;
}

/**
 * Reconstruct canonical LyricsData from MusicXML `<lyric>` elements so inline score lyrics
 * and the Lyrics tab (`LyricsPanel`) remain synchronized on the same score state.
 */
export function extractLyricsDataFromMusicXml(
  xmlStr: string | null | undefined,
  fallbackTempoBpm = 120,
  existingLyrics?: LyricsData | null,
): LyricsData | null {
  if (!xmlStr || !xmlStr.includes("<score-")) return null;
  const doc = parseXmlDocument(xmlStr);
  if (!doc) return null;

  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length === 0) return null;

  let lyricPartIdx = 0;
  const scoreParts = Array.from(doc.getElementsByTagName("score-part"));
  for (const sp of scoreParts) {
    const id = sp.getAttribute("id");
    const name = (sp.getElementsByTagName("part-name")[0]?.textContent || "").trim().toLowerCase();
    if (id && (name.includes("soprano") || name === "sop")) {
      const idx = parts.findIndex((p) => p.getAttribute("id") === id);
      if (idx >= 0) {
        lyricPartIdx = idx;
        break;
      }
    }
  }

  const timeline = buildMusicXmlTimeline(xmlStr, fallbackTempoBpm);
  const scanned = scanPartNotes(doc, lyricPartIdx, fallbackTempoBpm);

  const byVerse = new Map<
    number,
    Array<{ text: string; syllabic: string; startSec: number; endSec: number }>
  >();

  for (const node of scanned) {
    if (node.isChord) continue;
    const startSec = Number(wholeNotesToTimeSec(timeline, node.onsetWhole, fallbackTempoBpm).toFixed(3));
    const endSec = Math.max(
      startSec + 0.05,
      Number(wholeNotesToTimeSec(timeline, node.endWhole, fallbackTempoBpm).toFixed(3)),
    );
    for (const child of Array.from(node.noteEl.children)) {
      if (child.tagName.toLowerCase() !== "lyric") continue;
      const vNum = Number.parseInt(child.getAttribute("number") || "1", 10) || 1;
      const txt = Array.from(child.getElementsByTagName("text"))
        .map((t) => t.textContent || "")
        .join("")
        .trim();
      const syl = (child.getElementsByTagName("syllabic")[0]?.textContent || "").trim().toLowerCase();
      if (!txt) continue;
      if (!byVerse.has(vNum)) byVerse.set(vNum, []);
      byVerse.get(vNum)!.push({ text: txt, syllabic: syl, startSec, endSec });
    }
  }

  if (byVerse.size === 0) return null;

  const verseNums = Array.from(byVerse.keys()).sort((a, b) => a - b);
  const verseLines: string[] = [];
  const segments: LyricSegment[] = [];

  for (const vNum of verseNums) {
    const tokens = byVerse.get(vNum)!;
    const words: LyricWord[] = [];
    let curWordText = "";
    let curWordStart = tokens[0].startSec;
    let curWordEnd = tokens[0].endSec;

    for (const tok of tokens) {
      if (tok.syllabic === "begin" || tok.syllabic === "middle") {
        if (!curWordText) curWordStart = tok.startSec;
        const cleanPart = tok.text.endsWith("-") ? tok.text.slice(0, -1) : tok.text;
        curWordText += cleanPart;
        curWordEnd = Math.max(curWordEnd, tok.endSec);
      } else if (tok.syllabic === "end") {
        if (!curWordText) curWordStart = tok.startSec;
        curWordText += tok.text;
        curWordEnd = Math.max(curWordEnd, tok.endSec);
        words.push({
          text: curWordText,
          start_sec: curWordStart,
          end_sec: curWordEnd,
          confidence: 1,
          needs_review: false,
        });
        curWordText = "";
      } else {
        if (curWordText) {
          words.push({
            text: curWordText,
            start_sec: curWordStart,
            end_sec: curWordEnd,
            confidence: 1,
            needs_review: false,
          });
          curWordText = "";
        }
        words.push({
          text: tok.text,
          start_sec: tok.startSec,
          end_sec: tok.endSec,
          confidence: 1,
          needs_review: false,
        });
      }
    }

    if (curWordText) {
      words.push({
        text: curWordText,
        start_sec: curWordStart,
        end_sec: curWordEnd,
        confidence: 1,
        needs_review: false,
      });
    }

    const lineText = words.map((w) => w.text).join(" ").trim();
    if (!lineText) continue;
    verseLines.push(lineText);
    segments.push({
      id: `verse_${vNum}`,
      text: lineText,
      start_sec: words[0]?.start_sec ?? 0,
      end_sec: words[words.length - 1]?.end_sec ?? 0,
      confidence: 1,
      needs_review: false,
      reviewed: true,
      edited: true,
      words,
    });
  }

  if (verseLines.length === 0) return null;

  return {
    text: verseLines.join("\n"),
    segments,
    language: existingLyrics?.language ?? null,
    language_probability: existingLyrics?.language_probability ?? null,
    source_used: existingLyrics?.source_used ?? "manual",
    demucs_requested: existingLyrics?.demucs_requested ?? false,
    demucs_fallback_used: existingLyrics?.demucs_fallback_used ?? false,
    model_name: existingLyrics?.model_name ?? "manual",
    device: existingLyrics?.device ?? "browser",
    has_word_timestamps: true,
    uncertain_segments: [],
    alignment_uncertain_segments: [],
    original_text: existingLyrics?.original_text ?? existingLyrics?.text ?? null,
    processing_metadata: existingLyrics?.processing_metadata ?? {},
    manually_edited: true,
    updated_at: new Date().toISOString(),
  };
}
