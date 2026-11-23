export type NormalizedScorePayload =
  | { kind: "empty" }
  | { kind: "url"; url: string }
  | { kind: "compressed_mxl"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "xml"; xml: string };

const TITLE_EXT_RE = /\.(?:pdf|mxl|musicxml|xml|mid|midi|mp3|wav)$/i;
const XML_DECL_RE = /^<\?xml\b[^>]*\?>\s*/i;
const URL_RE = /^https?:\/\/\S+$/i;

const FOOTER_PHRASE_RE =
  /(?:©|\(c\)|copyright|all\s+rights\s+reserved|used\s+by\s+permission|without\s+permission|personal\s+use|non[- ]?commercial|non[- ]?church|making\s+copies|(?:may|not)\s+be\s+reproduced|ccli\b|licen[cs]e|arr\.?\s+by|arranged\s+by|words\s*(?:&|and)\s*music|(?:music|text|lyrics)\s+by\s+[A-Z][\w.-]+(?:\s+[A-Z][\w.-]+){0,3}|published\s+by|engraved\s+by|typeset\s+by|printed\s+in|hal\s+leonard|imslp|public\s+domain|musescore|(?:https?:\/\/|www\.)\S+|^(?:page|p\.?)\s*\d+(?:\s*of\s*\d+)?$)/i;

const CREDIT_BY_NAME_RE = /\bby\s+[A-Z][a-z]{1,24}(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]{1,24}\b/;

function sanitizeDocumentFooterLyrics(doc: Document): void {
  const parts = Array.from(doc.getElementsByTagName("part"));
  const numParts = parts.length;

  // Pass 1: multi-note phrase reconstruction per part and verse
  for (let pIdx = 0; pIdx < numParts; pIdx++) {
    const partEl = parts[pIdx];
    const isLowerPart = numParts >= 2 && pIdx >= Math.max(1, numParts - 2);
    const measures = Array.from(partEl.getElementsByTagName("measure"));
    const byVerse = new Map<
      string,
      Array<{ noteEl: Element; lyrEl: Element; text: string; syllabic: string; mIdx: number }>
    >();

    for (let mIdx = 0; mIdx < measures.length; mIdx++) {
      for (const noteEl of Array.from(measures[mIdx].getElementsByTagName("note"))) {
        for (const lyrEl of Array.from(noteEl.getElementsByTagName("lyric"))) {
          const vNum = lyrEl.getAttribute("number") || "1";
          const txt = Array.from(lyrEl.getElementsByTagName("text"))
            .map((t) => t.textContent || "")
            .join("")
            .trim();
          const syl = (lyrEl.getElementsByTagName("syllabic")[0]?.textContent || "").trim().toLowerCase();
          const rawY = lyrEl.getAttribute("default-y");
          const dy = rawY !== null ? Number.parseFloat(rawY) : NaN;

          if ((Number.isFinite(dy) && dy < -150) || FOOTER_PHRASE_RE.test(txt)) {
            lyrEl.parentNode?.removeChild(lyrEl);
            continue;
          }
          if (!byVerse.has(vNum)) byVerse.set(vNum, []);
          byVerse.get(vNum)!.push({ noteEl, lyrEl, text: txt, syllabic: syl, mIdx });
        }
      }
    }

    for (const tokList of byVerse.values()) {
      const chunks: Array<typeof tokList> = [];
      let cur: typeof tokList = [];
      for (const tok of tokList) {
        if (cur.length > 0 && tok.mIdx - cur[cur.length - 1].mIdx > 2) {
          chunks.push(cur);
          cur = [];
        }
        cur.push(tok);
      }
      if (cur.length > 0) chunks.push(cur);

      for (const chunk of chunks) {
        let phrase = "";
        let prevJoined = false;
        for (let i = 0; i < chunk.length; i++) {
          const t = chunk[i].text;
          if (!t) continue;
          if (i > 0 && !prevJoined) phrase += " ";
          const isHyphenEnd = t.endsWith("-") && t.length > 1;
          phrase += isHyphenEnd && (chunk[i].syllabic === "begin" || chunk[i].syllabic === "middle" || !chunk[i].syllabic)
            ? t.slice(0, -1)
            : t;
          prevJoined = chunk[i].syllabic === "begin" || chunk[i].syllabic === "middle" || t.endsWith("-");
        }
        const trimmed = phrase.trim();
        if (!trimmed) continue;

        const isFooter =
          FOOTER_PHRASE_RE.test(trimmed) ||
          ((isLowerPart || chunk.length <= 6) && CREDIT_BY_NAME_RE.test(trimmed));
        if (isFooter) {
          for (const tok of chunk) {
            tok.lyrEl.parentNode?.removeChild(tok.lyrEl);
          }
        }
      }
    }
  }

  // Pass 2: remove sparse bottom-staff pseudo-lyrics in multi-part hymnal scores
  if (numParts >= 2) {
    const counts = parts.map((p) => p.getElementsByTagName("lyric").length);
    const topCount = counts[0];
    if (topCount >= 12) {
      for (let pIdx = 1; pIdx < numParts; pIdx++) {
        const cnt = counts[pIdx];
        if (cnt > 0 && cnt <= Math.max(4, Math.floor(topCount * 0.18)) && (pIdx >= 2 || numParts === 2)) {
          for (const lyr of Array.from(parts[pIdx].getElementsByTagName("lyric"))) {
            lyr.parentNode?.removeChild(lyr);
          }
        }
      }
    }
  }
}

function collectPartNotePositions(partEl: Element): Array<{ mIdx: number; onsetWhole: number; noteEl: Element; isRest: boolean }> {
  const items: Array<{ mIdx: number; onsetWhole: number; noteEl: Element; isRest: boolean }> = [];
  let divisions = 1;
  const measures = Array.from(partEl.getElementsByTagName("measure"));
  for (let mIdx = 0; mIdx < measures.length; mIdx++) {
    let offsetDiv = 0;
    let lastStartDiv = 0;
    for (const child of Array.from(measures[mIdx].children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === "attributes") {
        const d = Number.parseFloat(child.getElementsByTagName("divisions")[0]?.textContent || "");
        if (Number.isFinite(d) && d > 0) divisions = d;
      } else if (tag === "backup") {
        const d = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
        if (Number.isFinite(d) && d > 0) offsetDiv = Math.max(0, offsetDiv - d);
      } else if (tag === "forward") {
        const d = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
        if (Number.isFinite(d) && d > 0) offsetDiv += d;
      } else if (tag === "note") {
        const isChord = child.getElementsByTagName("chord").length > 0;
        const isGrace = child.getElementsByTagName("grace").length > 0;
        const isRest = child.getElementsByTagName("rest").length > 0;
        const startDiv = isChord ? lastStartDiv : offsetDiv;
        const onsetWhole = Math.round((startDiv / (divisions * 4)) * 10000) / 10000;
        if (!isChord) {
          items.push({ mIdx, onsetWhole, noteEl: child, isRest });
        }
        if (!isChord && !isGrace) {
          const dur = Number.parseFloat(child.getElementsByTagName("duration")[0]?.textContent || "0");
          lastStartDiv = offsetDiv;
          if (Number.isFinite(dur) && dur > 0) offsetDiv += dur;
        }
      }
    }
  }
  return items;
}

function consolidateSatbLyricsToSoprano(doc: Document): void {
  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length < 2) return;

  const partNames = new Map<string, string>();
  for (const sp of Array.from(doc.getElementsByTagName("score-part"))) {
    const id = sp.getAttribute("id") || "";
    const name = (sp.getElementsByTagName("part-name")[0]?.textContent || "").trim();
    partNames.set(id, name);
  }

  const isAccomp = (name: string) => /(?:piano|accompaniment|accomp|keyboard|organ|pno)/i.test(name);
  const vocalIndices: number[] = [];
  let sopranoIdx: number | null = null;
  for (let i = 0; i < parts.length; i++) {
    const pname = (partNames.get(parts[i].getAttribute("id") || "") || "").toLowerCase();
    if (isAccomp(pname)) continue;
    vocalIndices.push(i);
    if (sopranoIdx === null && (pname.includes("soprano") || pname === "sop")) {
      sopranoIdx = i;
    }
  }
  if (sopranoIdx === null) {
    if (vocalIndices.length === 0) return;
    sopranoIdx = vocalIndices[0];
  }
  const otherIndices = vocalIndices.filter((i) => i !== sopranoIdx);
  if (otherIndices.length === 0) return;

  const sopItems = collectPartNotePositions(parts[sopranoIdx]);
  const sopNonRestNotes: Array<{ mIdx: number; onsetWhole: number; globalWhole: number; noteEl: Element }> = [];
  const sopByMeasure = new Map<number, Array<{ onsetWhole: number; noteEl: Element }>>();
  for (const it of sopItems) {
    if (!it.isRest) {
      sopNonRestNotes.push({
        mIdx: it.mIdx,
        onsetWhole: it.onsetWhole,
        globalWhole: it.mIdx + it.onsetWhole,
        noteEl: it.noteEl,
      });
      if (!sopByMeasure.has(it.mIdx)) sopByMeasure.set(it.mIdx, []);
      sopByMeasure.get(it.mIdx)!.push({ onsetWhole: it.onsetWhole, noteEl: it.noteEl });
    }
  }
  if (sopNonRestNotes.length === 0) return;

  const hasVerseOnNote = (noteEl: Element, vNum: string): boolean =>
    Array.from(noteEl.getElementsByTagName("lyric")).some(
      (sl) => (sl.getAttribute("number") || "1") === vNum,
    );

  const findNearestSopNote = (
    mIdx: number,
    onset: number,
    vNum: string,
  ): { noteEl: Element; exactMatch: boolean } => {
    const measureNotes = sopByMeasure.get(mIdx) || [];
    // 1. Exact onset match in same measure
    for (const s of measureNotes) {
      if (Math.abs(s.onsetWhole - onset) <= 0.025) {
        return { noteEl: s.noteEl, exactMatch: true };
      }
    }
    // 2. Nearest note in same measure without this verse (handles passing-tone offsets)
    let bestInMeasure: { onsetWhole: number; noteEl: Element } | null = null;
    let bestInMeasureDist = Infinity;
    for (const s of measureNotes) {
      if (!hasVerseOnNote(s.noteEl, vNum)) {
        const d = Math.abs(s.onsetWhole - onset);
        if (d < bestInMeasureDist) {
          bestInMeasureDist = d;
          bestInMeasure = s;
        }
      }
    }
    if (bestInMeasure) {
      return { noteEl: bestInMeasure.noteEl, exactMatch: false };
    }
    // 3. Nearest Soprano note across adjacent measures without this verse
    const targetGlobal = mIdx + onset;
    let bestGlobal: (typeof sopNonRestNotes)[number] | null = null;
    let bestGlobalDist = Infinity;
    for (const s of sopNonRestNotes) {
      if (!hasVerseOnNote(s.noteEl, vNum)) {
        const d = Math.abs(s.globalWhole - targetGlobal);
        if (d < bestGlobalDist) {
          bestGlobalDist = d;
          bestGlobal = s;
        }
      }
    }
    if (bestGlobal) {
      return { noteEl: bestGlobal.noteEl, exactMatch: false };
    }
    // 4. Fallback: nearest Soprano note in same measure or globally
    if (measureNotes.length > 0) {
      let closest = measureNotes[0];
      let closestDist = Math.abs(closest.onsetWhole - onset);
      for (const s of measureNotes) {
        const d = Math.abs(s.onsetWhole - onset);
        if (d < closestDist) {
          closestDist = d;
          closest = s;
        }
      }
      return { noteEl: closest.noteEl, exactMatch: false };
    }
    let closestGlobal = sopNonRestNotes[0];
    let closestGlobalDist = Math.abs(closestGlobal.globalWhole - targetGlobal);
    for (const s of sopNonRestNotes) {
      const d = Math.abs(s.globalWhole - targetGlobal);
      if (d < closestGlobalDist) {
        closestGlobalDist = d;
        closestGlobal = s;
      }
    }
    return { noteEl: closestGlobal.noteEl, exactMatch: false };
  };

  const sopLyricsByVerse = new Map<string, Array<{ mIdx: number; onset: number; txt: string }>>();
  for (const it of sopItems) {
    for (const lyr of Array.from(it.noteEl.getElementsByTagName("lyric"))) {
      const vNum = lyr.getAttribute("number") || "1";
      const txt = Array.from(lyr.getElementsByTagName("text"))
        .map((t) => t.textContent || "")
        .join("")
        .trim();
      if (!sopLyricsByVerse.has(vNum)) sopLyricsByVerse.set(vNum, []);
      sopLyricsByVerse.get(vNum)!.push({ mIdx: it.mIdx, onset: it.onsetWhole, txt });
    }
  }

  for (const otherIdx of otherIndices) {
    const otherItems = collectPartNotePositions(parts[otherIdx]);
    const byVerse = new Map<string, Array<{ mIdx: number; onset: number; noteEl: Element; lyr: Element; txt: string }>>();
    for (const it of otherItems) {
      for (const lyr of Array.from(it.noteEl.getElementsByTagName("lyric"))) {
        const vNum = lyr.getAttribute("number") || "1";
        const txt = Array.from(lyr.getElementsByTagName("text"))
          .map((t) => t.textContent || "")
          .join("")
          .trim();
        if (!byVerse.has(vNum)) byVerse.set(vNum, []);
        byVerse.get(vNum)!.push({ mIdx: it.mIdx, onset: it.onsetWhole, noteEl: it.noteEl, lyr, txt });
      }
    }

    for (const [vNum, entries] of byVerse.entries()) {
      const sopV = sopLyricsByVerse.get(vNum) || [];
      let overlapSame = 0;
      let overlapDiff = 0;
      for (const e of entries) {
        const match = sopV.find((s) => s.mIdx === e.mIdx && Math.abs(s.onset - e.onset) <= 0.025);
        if (match) {
          if (match.txt.toLowerCase() === e.txt.toLowerCase()) overlapSame++;
          else overlapDiff++;
        }
      }
      const totalOverlap = overlapSame + overlapDiff;
      if (vocalIndices.length === 2 && totalOverlap >= 4 && overlapDiff / totalOverlap >= 0.4) {
        continue; // Preserve genuine independent polytextual 2-part vocal scores
      }

      for (const e of entries) {
        const { noteEl: sopNote } = findNearestSopNote(e.mIdx, e.onset, vNum);
        const already = hasVerseOnNote(sopNote, vNum);
        if (!already) {
          sopNote.appendChild(e.lyr.cloneNode(true));
          if (!sopLyricsByVerse.has(vNum)) sopLyricsByVerse.set(vNum, []);
          sopLyricsByVerse.get(vNum)!.push({ mIdx: e.mIdx, onset: e.onset, txt: e.txt });
        } else if (e.txt) {
          // Preserve distinct orphaned syllables that map to the same Soprano note
          const existingLyr = Array.from(sopNote.getElementsByTagName("lyric")).find(
            (sl) => (sl.getAttribute("number") || "1") === vNum,
          );
          const existingTxtEl = existingLyr?.getElementsByTagName("text")[0];
          const existingTxt = (existingTxtEl?.textContent || "").trim();
          const existingWords = existingTxt.toLowerCase().split(/\s+/);
          if (
            existingTxtEl &&
            existingTxt &&
            existingTxt.toLowerCase() !== e.txt.toLowerCase() &&
            !existingWords.includes(e.txt.toLowerCase())
          ) {
            existingTxtEl.textContent = `${existingTxt} ${e.txt}`;
          }
        }
        if (e.lyr.parentNode === e.noteEl) {
          e.noteEl.removeChild(e.lyr);
        }
      }
    }
  }

  for (const it of sopItems) {
    const lyrs = Array.from(it.noteEl.getElementsByTagName("lyric"));
    if (lyrs.length > 1) {
      for (const lyr of lyrs) it.noteEl.removeChild(lyr);
      lyrs.sort((a, b) => (Number.parseInt(a.getAttribute("number") || "1", 10) || 99) - (Number.parseInt(b.getAttribute("number") || "1", 10) || 99));
      for (const lyr of lyrs) it.noteEl.appendChild(lyr);
    }
  }
}

export function cleanDisplayScoreTitle(rawTitle: string): string {
  return rawTitle.trim().replace(TITLE_EXT_RE, "").trim();
}

export function isMusicXmlDocument(text: string): boolean {
  return /<score-(?:partwise|timewise)\b/i.test(text);
}

/**
 * Normalize a raw MusicXML string (strip BOM/whitespace, ensure <?xml ...?> header)
 * and apply display options (chord stripping, clean title, ScribaSheet attribution).
 */
export function prepareDisplayMusicXml(xml: string, showChords: boolean): string {
  const stripped = xml.replace(/^\uFEFF/, "").trim();
  if (!isMusicXmlDocument(stripped)) {
    return stripped;
  }

  const declMatch = stripped.match(XML_DECL_RE);
  const existingDecl = declMatch ? declMatch[0].trim() : null;

  if (typeof DOMParser !== "undefined" && typeof XMLSerializer !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(stripped, "application/xml");
      if (!doc.querySelector("parsererror")) {
        if (!showChords) {
          const harmonies = Array.from(doc.getElementsByTagName("harmony"));
          for (const el of harmonies) {
            el.parentNode?.removeChild(el);
          }
        }
        for (const tag of ["work-title", "movement-title"]) {
          const el = doc.getElementsByTagName(tag)[0];
          if (el?.textContent) {
            el.textContent = cleanDisplayScoreTitle(el.textContent);
          }
        }
        for (const creator of Array.from(doc.getElementsByTagName("creator"))) {
          if ((creator.textContent || "").trim().toLowerCase().startsWith("music21")) {
            creator.textContent = "ScribaSheet";
          }
        }
        for (const sw of Array.from(doc.getElementsByTagName("software"))) {
          if ((sw.textContent || "").trim().toLowerCase().startsWith("music21")) {
            sw.textContent = "ScribaSheet";
          }
        }
        for (const cw of Array.from(doc.getElementsByTagName("credit-words"))) {
          if ((cw.textContent || "").trim().toLowerCase() === "music21") {
            cw.textContent = "ScribaSheet";
          }
        }
        sanitizeDocumentFooterLyrics(doc);
        consolidateSatbLyricsToSoprano(doc);

        const serialized = new XMLSerializer().serializeToString(doc).replace(/^\uFEFF/, "").trim();
        if (serialized.startsWith("<?xml")) {
          return serialized;
        }
        const decl = existingDecl || '<?xml version="1.0" encoding="UTF-8"?>';
        return `${decl}\n${serialized}`;
      }
    } catch {
      // Fall back to string normalization below
    }
  }

  const withoutHarmony = showChords
    ? stripped
    : stripped.replace(/<harmony\b[^>]*>[\s\S]*?<\/harmony>/gi, "");
  if (withoutHarmony.startsWith("<?xml")) {
    return withoutHarmony;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${withoutHarmony}`;
}

export function normalizeScorePayload(
  raw: string | null | undefined,
  showChords = true,
): NormalizedScorePayload {
  if (typeof raw !== "string") {
    return { kind: "empty" };
  }
  const cleaned = raw.replace(/^\uFEFF/, "").trim();
  if (!cleaned) {
    return { kind: "empty" };
  }
  if (URL_RE.test(cleaned)) {
    return { kind: "url", url: cleaned };
  }
  if (cleaned.startsWith("PK\x03\x04") || cleaned.startsWith("PK")) {
    return {
      kind: "compressed_mxl",
      message: "Compressed .mxl score cannot be loaded directly. Click Re-Process Score to extract notation.",
    };
  }
  if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
    return {
      kind: "invalid",
      message: "Unsupported legacy JSON score payload. Click Re-Transcribe or Re-Process Score to generate MusicXML.",
    };
  }
  if (!isMusicXmlDocument(cleaned)) {
    return {
      kind: "invalid",
      message: "Unsupported or invalid score format. Expected a MusicXML document.",
    };
  }
  return {
    kind: "xml",
    xml: prepareDisplayMusicXml(cleaned, showChords),
  };
}
