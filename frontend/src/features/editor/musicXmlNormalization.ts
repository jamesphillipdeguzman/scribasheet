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
