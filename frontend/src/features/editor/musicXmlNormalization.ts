export type NormalizedScorePayload =
  | { kind: "empty" }
  | { kind: "url"; url: string }
  | { kind: "compressed_mxl"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "xml"; xml: string };

const TITLE_EXT_RE = /\.(?:pdf|mxl|musicxml|xml|mid|midi|mp3|wav)$/i;
const XML_DECL_RE = /^<\?xml\b[^>]*\?>\s*/i;
const URL_RE = /^https?:\/\/\S+$/i;

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
