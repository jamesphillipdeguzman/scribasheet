export type HarmonyDegreeType = "add" | "alter" | "subtract";

export interface ChordDegree {
  value: number;
  alter: number;
  type: HarmonyDegreeType;
}

export interface ParsedChord {
  rootStep: "A" | "B" | "C" | "D" | "E" | "F" | "G";
  rootAlter: number;
  rootDisplay: string;
  kind: string;
  kindText: string;
  degrees: ChordDegree[];
  bassStep?: "A" | "B" | "C" | "D" | "E" | "F" | "G";
  bassAlter?: number;
  bassDisplay?: string;
  qualityLabel: string;
  normalizedSymbol: string;
}

export type ChordParseResult =
  | { ok: true; chord: ParsedChord }
  | { ok: false; error: string };

const ALTER_TO_DISPLAY: Record<number, string> = {
  "-2": "bb",
  "-1": "b",
  "0": "",
  "1": "#",
  "2": "##",
};

interface KindRule {
  re: RegExp;
  kind: string;
  kindText: string;
  qualityLabel: string;
  degrees?: ChordDegree[];
}

const KIND_RULES: KindRule[] = [
  { re: /^(6\/9|69)$/, kind: "major-sixth", kindText: "6/9", qualityLabel: "6/9", degrees: [{ value: 9, alter: 0, type: "add" }] },
  { re: /^(7sus4|7sus|sus4-7|suspended-fourth-seventh)$/i, kind: "suspended-fourth", kindText: "7sus4", qualityLabel: "7sus4", degrees: [{ value: 7, alter: -1, type: "add" }] },
  { re: /^(9sus4|9sus)$/i, kind: "suspended-fourth", kindText: "9sus4", qualityLabel: "9sus4", degrees: [{ value: 7, alter: -1, type: "add" }, { value: 9, alter: 0, type: "add" }] },
  { re: /^(m\(maj7\)|min\(maj7\)|mMaj7|mmaj7|mM7)$/i, kind: "major-minor", kindText: "m(maj7)", qualityLabel: "minor-major 7th" },
  { re: /^(madd9|minadd9)$/i, kind: "minor", kindText: "m(add9)", qualityLabel: "minor add9", degrees: [{ value: 9, alter: 0, type: "add" }] },
  { re: /^(madd2|minadd2)$/i, kind: "minor", kindText: "m(add2)", qualityLabel: "minor add2", degrees: [{ value: 2, alter: 0, type: "add" }] },
  { re: /^(madd4|minadd4)$/i, kind: "minor", kindText: "m(add4)", qualityLabel: "minor add4", degrees: [{ value: 4, alter: 0, type: "add" }] },
  { re: /^(add9|add2)$/i, kind: "major", kindText: "add9", qualityLabel: "add9", degrees: [{ value: 9, alter: 0, type: "add" }] },
  { re: /^(add4|add11)$/i, kind: "major", kindText: "add4", qualityLabel: "add4", degrees: [{ value: 4, alter: 0, type: "add" }] },
  { re: /^(maj13|M13|\u039413)$/, kind: "major-13th", kindText: "maj13", qualityLabel: "major 13th" },
  { re: /^(m13|min13|-13)$/, kind: "minor-13th", kindText: "m13", qualityLabel: "minor 13th" },
  { re: /^(13|dom13)$/, kind: "dominant-13th", kindText: "13", qualityLabel: "dominant 13th" },
  { re: /^(maj11|M11|\u039411)$/, kind: "major-11th", kindText: "maj11", qualityLabel: "major 11th" },
  { re: /^(m11|min11|-11)$/, kind: "minor-11th", kindText: "m11", qualityLabel: "minor 11th" },
  { re: /^(11|dom11)$/, kind: "dominant-11th", kindText: "11", qualityLabel: "dominant 11th" },
  { re: /^(maj9|M9|\u03949)$/, kind: "major-ninth", kindText: "maj9", qualityLabel: "major 9th" },
  { re: /^(m9|min9|-9)$/, kind: "minor-ninth", kindText: "m9", qualityLabel: "minor 9th" },
  { re: /^(9|dom9)$/, kind: "dominant-ninth", kindText: "9", qualityLabel: "dominant 9th" },
  { re: /^(m7b5|\u00f87?)$/, kind: "half-diminished", kindText: "m7b5", qualityLabel: "half-diminished" },
  { re: /^(dim7|\u00b07|o7)$/, kind: "diminished-seventh", kindText: "dim7", qualityLabel: "diminished 7th" },
  { re: /^(aug7|\+7|7#5|7\+)$/, kind: "augmented-seventh", kindText: "aug7", qualityLabel: "augmented 7th" },
  { re: /^(maj7|M7|\u03947?)$/, kind: "major-seventh", kindText: "maj7", qualityLabel: "major 7th" },
  { re: /^(m7|min7|-7)$/, kind: "minor-seventh", kindText: "m7", qualityLabel: "minor 7th" },
  { re: /^(7|dom7)$/, kind: "dominant", kindText: "7", qualityLabel: "dominant 7th" },
  { re: /^(m6|min6|-6)$/, kind: "minor-sixth", kindText: "m6", qualityLabel: "minor 6th" },
  { re: /^(6)$/, kind: "major-sixth", kindText: "6", qualityLabel: "major 6th" },
  { re: /^(dim|\u00b0|diminished)$/i, kind: "diminished", kindText: "dim", qualityLabel: "diminished" },
  { re: /^(aug|\+|augmented)$/i, kind: "augmented", kindText: "aug", qualityLabel: "augmented" },
  { re: /^(sus4|sus)$/i, kind: "suspended-fourth", kindText: "sus4", qualityLabel: "suspended 4th" },
  { re: /^(sus2)$/i, kind: "suspended-second", kindText: "sus2", qualityLabel: "suspended 2nd" },
  { re: /^(5)$/, kind: "power", kindText: "5", qualityLabel: "power" },
  { re: /^(m|min|-|minor)$/i, kind: "minor", kindText: "m", qualityLabel: "minor" },
  { re: /^(maj|major|M)?$/, kind: "major", kindText: "", qualityLabel: "major" },
];

const KIND_TO_SUFFIX: Record<string, string> = {
  major: "",
  minor: "m",
  augmented: "aug",
  diminished: "dim",
  dominant: "7",
  "major-seventh": "maj7",
  "minor-seventh": "m7",
  "diminished-seventh": "dim7",
  "augmented-seventh": "aug7",
  "half-diminished": "m7b5",
  "major-minor": "m(maj7)",
  "major-sixth": "6",
  "minor-sixth": "m6",
  "dominant-ninth": "9",
  "major-ninth": "maj9",
  "minor-ninth": "m9",
  "dominant-11th": "11",
  "major-11th": "maj11",
  "minor-11th": "m11",
  "dominant-13th": "13",
  "major-13th": "maj13",
  "minor-13th": "m13",
  "suspended-second": "sus2",
  "suspended-fourth": "sus4",
  power: "5",
};

function parseAccidentalToken(accRaw: string): number | null {
  if (!accRaw) return 0;
  const norm = accRaw.replace(/\u266f/g, "#").replace(/\u266d/g, "b");
  if (norm === "#") return 1;
  if (norm === "##" || norm === "x") return 2;
  if (norm === "b") return -1;
  if (norm === "bb") return -2;
  return null;
}

export function parsePitchTokenStrict(raw: string): {
  step: "A" | "B" | "C" | "D" | "E" | "F" | "G";
  alter: number;
  display: string;
} | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/^([A-Ga-g])(##|bb|x|[#b\u266f\u266d]?)$/);
  if (!match) return null;
  const step = match[1].toUpperCase() as "A" | "B" | "C" | "D" | "E" | "F" | "G";
  const alter = parseAccidentalToken(match[2] || "");
  if (alter === null) return null;
  return {
    step,
    alter,
    display: `${step}${ALTER_TO_DISPLAY[alter] ?? ""}`,
  };
}

function parseDegreeToken(tok: string): ChordDegree | null {
  const clean = tok.trim().replace(/\u266f/g, "#").replace(/\u266d/g, "b");
  if (!clean) return null;

  const noMatch = clean.match(/^no(3|5|7|9|11|13)$/i);
  if (noMatch) {
    return { value: Number.parseInt(noMatch[1], 10), alter: 0, type: "subtract" };
  }

  const addMatch = clean.match(/^add([#b]?)(2|4|6|9|11|13)$/i);
  if (addMatch) {
    const alter = addMatch[1] === "#" ? 1 : addMatch[1] === "b" ? -1 : 0;
    return { value: Number.parseInt(addMatch[2], 10), alter, type: "add" };
  }

  const altMatch = clean.match(/^(#|b)(5|9|11|13)$/);
  if (altMatch) {
    const alter = altMatch[1] === "#" ? 1 : -1;
    const val = Number.parseInt(altMatch[2], 10);
    return {
      value: val,
      alter,
      type: val === 5 ? "alter" : "add",
    };
  }

  return null;
}

function splitSuffixAndAlterations(rawRest: string): { baseSuffix: string; extraDegrees: ChordDegree[]; extraDisplay: string } | null {
  let working = rawRest.trim();
  const extraDegrees: ChordDegree[] = [];
  const extraLabels: string[] = [];

  // Handle parenthesized trailing groups like C7(#9), Am7(b5), G7(#11b13)
  while (working.endsWith(")")) {
    const openIdx = working.lastIndexOf("(");
    if (openIdx < 0) return null;
    const inner = working.slice(openIdx + 1, -1).trim();
    const prefix = working.slice(0, openIdx);
    // Keep m(maj7) intact as base quality
    if (/^(m|min)$/i.test(prefix) && /^maj7$/i.test(inner)) {
      break;
    }
    const tokens = inner.split(/[,\s]+|(?=[#b]|no|add)/i).filter(Boolean);
    if (tokens.length === 0) return null;
    const parsedGroup: ChordDegree[] = [];
    for (const t of tokens) {
      const d = parseDegreeToken(t);
      if (!d) return null;
      parsedGroup.push(d);
    }
    extraDegrees.unshift(...parsedGroup);
    extraLabels.unshift(`(${inner.replace(/\u266f/g, "#").replace(/\u266d/g, "b")})`);
    working = prefix;
  }

  // Peel trailing unparenthesized b5/#5/b9/#9/#11/b13/no5/no3 unless handled directly in KIND_RULES (e.g. m7b5)
  const matchedDirect = KIND_RULES.some((r) => r.re.test(working));
  if (!matchedDirect) {
    const altSuffixes: ChordDegree[] = [];
    const altStrings: string[] = [];
    let scan = working;
    while (scan.length > 0) {
      const m = scan.match(/(no(?:3|5|7|9|11|13)|add[#b]?(?:2|4|6|9|11|13)|[#b](?:5|9|11|13))$/i);
      if (!m) break;
      const d = parseDegreeToken(m[1]);
      if (!d) break;
      altSuffixes.unshift(d);
      altStrings.unshift(m[1].replace(/\u266f/g, "#").replace(/\u266d/g, "b"));
      scan = scan.slice(0, -m[1].length);
      if (KIND_RULES.some((r) => r.re.test(scan))) {
        working = scan;
        extraDegrees.unshift(...altSuffixes);
        extraLabels.unshift(...altStrings);
        break;
      }
    }
  }

  return {
    baseSuffix: working,
    extraDegrees,
    extraDisplay: extraLabels.join(""),
  };
}

/**
 * Strictly parse a user-entered chord symbol into MusicXML `<harmony>` fields.
 * Rejects malformed roots, unknown quality tokens, empty slash basses, and internal whitespace.
 */
export function parseChordSymbolStrict(raw: string): ChordParseResult {
  const clean = raw.trim();
  if (!clean) {
    return { ok: false, error: "Enter a chord symbol such as C, F#m7, Dsus2, or Amaj7/G#." };
  }
  if (/\s/.test(clean)) {
    return { ok: false, error: "Chord symbols cannot contain spaces (e.g. use F#m7, not F# m7)." };
  }

  // Handle 6/9 carefully alongside optional slash bass
  let mainPart = clean;
  let bassRaw: string | undefined;
  const slashParts = clean.split("/");
  if (slashParts.length === 2) {
    if (/6$/.test(slashParts[0]) && slashParts[1] === "9") {
      mainPart = clean;
    } else {
      mainPart = slashParts[0];
      bassRaw = slashParts[1];
      if (!bassRaw) {
        return { ok: false, error: "Slash chord requires a bass note after '/' (e.g. Bb/D)." };
      }
    }
  } else if (slashParts.length === 3 && /6$/.test(slashParts[0]) && slashParts[1] === "9") {
    mainPart = `${slashParts[0]}/9`;
    bassRaw = slashParts[2];
    if (!bassRaw) {
      return { ok: false, error: "Slash chord requires a bass note after '/' (e.g. C6/9/G)." };
    }
  } else if (slashParts.length > 2) {
    return { ok: false, error: `Invalid chord symbol "${clean}": too many '/' separators.` };
  }

  const rootMatch = mainPart.match(/^([A-Ga-g])(##|bb|x|[#b\u266f\u266d]?)(.*)$/);
  if (!rootMatch) {
    return {
      ok: false,
      error: `Invalid chord root in "${clean}". Start with A–G plus optional # or b (e.g. C, Bb, F#m7).`,
    };
  }

  const rootStep = rootMatch[1].toUpperCase() as "A" | "B" | "C" | "D" | "E" | "F" | "G";
  const rootAlter = parseAccidentalToken(rootMatch[2] || "");
  if (rootAlter === null) {
    return { ok: false, error: `Invalid accidental on root note in "${clean}".` };
  }
  const rootDisplay = `${rootStep}${ALTER_TO_DISPLAY[rootAlter] ?? ""}`;
  const rawRest = rootMatch[3] || "";

  const split = splitSuffixAndAlterations(rawRest);
  if (!split) {
    return {
      ok: false,
      error: `Invalid chord extension syntax in "${clean}".`,
    };
  }

  const matchedRule = KIND_RULES.find((rule) => rule.re.test(split.baseSuffix));
  if (!matchedRule) {
    return {
      ok: false,
      error: `Unrecognized chord quality "${rawRest}" in "${clean}". Try m, m7, maj7, dim, aug, sus2, sus4, 6, 7, 9, or 7sus4.`,
    };
  }

  let bassStep: "A" | "B" | "C" | "D" | "E" | "F" | "G" | undefined;
  let bassAlter: number | undefined;
  let bassDisplay: string | undefined;
  if (bassRaw !== undefined) {
    const parsedBass = parsePitchTokenStrict(bassRaw);
    if (!parsedBass) {
      return {
        ok: false,
        error: `Invalid slash bass note "${bassRaw}" in "${clean}". Expected A–G with optional # or b.`,
      };
    }
    bassStep = parsedBass.step;
    bassAlter = parsedBass.alter;
    bassDisplay = parsedBass.display;
  }

  const kindText = `${matchedRule.kindText}${split.extraDisplay}`;
  const degrees = [...(matchedRule.degrees ?? []), ...split.extraDegrees];
  const normalizedSymbol = `${rootDisplay}${kindText}${bassDisplay ? `/${bassDisplay}` : ""}`;

  return {
    ok: true,
    chord: {
      rootStep,
      rootAlter,
      rootDisplay,
      kind: matchedRule.kind,
      kindText,
      degrees,
      bassStep,
      bassAlter,
      bassDisplay,
      qualityLabel: matchedRule.qualityLabel,
      normalizedSymbol,
    },
  };
}

/** Reconstruct a canonical display chord symbol from a MusicXML `<harmony>` element. */
export function formatHarmonyElementToSymbol(harmonyEl: Element): {
  symbol: string;
  root: string;
  quality: string;
} | null {
  const rootEl = harmonyEl.getElementsByTagName("root")[0];
  if (!rootEl) return null;
  const rawStep = (rootEl.getElementsByTagName("root-step")[0]?.textContent || "").trim().toUpperCase();
  if (!/^[A-G]$/.test(rawStep)) return null;
  const rawAlter = Number.parseInt(
    (rootEl.getElementsByTagName("root-alter")[0]?.textContent || "0").trim(),
    10,
  );
  const rootAlter = Number.isFinite(rawAlter) ? Math.max(-2, Math.min(2, rawAlter)) : 0;
  const root = `${rawStep}${ALTER_TO_DISPLAY[rootAlter] ?? ""}`;

  const kindEl = harmonyEl.getElementsByTagName("kind")[0];
  const kindVal = (kindEl?.textContent || "major").trim().toLowerCase();
  const explicitKindText = kindEl?.getAttribute("text");

  let suffix = "";
  if (explicitKindText !== null && explicitKindText !== undefined) {
    suffix = explicitKindText.trim();
  } else {
    suffix = KIND_TO_SUFFIX[kindVal] ?? "";
  }

  let bassDisplay = "";
  const bassEl = harmonyEl.getElementsByTagName("bass")[0];
  if (bassEl) {
    const bStep = (bassEl.getElementsByTagName("bass-step")[0]?.textContent || "").trim().toUpperCase();
    if (/^[A-G]$/.test(bStep)) {
      const bAlterRaw = Number.parseInt(
        (bassEl.getElementsByTagName("bass-alter")[0]?.textContent || "0").trim(),
        10,
      );
      const bAlter = Number.isFinite(bAlterRaw) ? Math.max(-2, Math.min(2, bAlterRaw)) : 0;
      bassDisplay = `/${bStep}${ALTER_TO_DISPLAY[bAlter] ?? ""}`;
    }
  }

  return {
    symbol: `${root}${suffix}${bassDisplay}`,
    root,
    quality: kindVal || "major",
  };
}
