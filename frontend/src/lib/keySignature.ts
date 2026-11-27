export type KeyMode = "major" | "minor";

export interface KeySignatureOption {
  fifths: number;
  majorName: string;
  minorName: string;
  majorTonicPc: number;
  minorTonicPc: number;
  accidentalLabel: string;
  dropdownLabel: string;
}

export interface KeySignatureState {
  fifths: number;
  mode: KeyMode;
  label: string;
}

export interface SpelledPitch {
  step: string;
  alter: number;
  octave: number;
  label: string;
  midi: number;
}

export const CIRCLE_OF_FIFTHS_KEYS: readonly KeySignatureOption[] = [
  {
    fifths: 0,
    majorName: "C Major",
    minorName: "A Minor",
    majorTonicPc: 0,
    minorTonicPc: 9,
    accidentalLabel: "0",
    dropdownLabel: "C Major / A Minor (0)",
  },
  {
    fifths: 1,
    majorName: "G Major",
    minorName: "E Minor",
    majorTonicPc: 7,
    minorTonicPc: 4,
    accidentalLabel: "1♯",
    dropdownLabel: "G Major / E Minor (1♯)",
  },
  {
    fifths: 2,
    majorName: "D Major",
    minorName: "B Minor",
    majorTonicPc: 2,
    minorTonicPc: 11,
    accidentalLabel: "2♯",
    dropdownLabel: "D Major / B Minor (2♯)",
  },
  {
    fifths: 3,
    majorName: "A Major",
    minorName: "F# Minor",
    majorTonicPc: 9,
    minorTonicPc: 6,
    accidentalLabel: "3♯",
    dropdownLabel: "A Major / F♯ Minor (3♯)",
  },
  {
    fifths: 4,
    majorName: "E Major",
    minorName: "C# Minor",
    majorTonicPc: 4,
    minorTonicPc: 1,
    accidentalLabel: "4♯",
    dropdownLabel: "E Major / C♯ Minor (4♯)",
  },
  {
    fifths: 5,
    majorName: "B Major",
    minorName: "G# Minor",
    majorTonicPc: 11,
    minorTonicPc: 8,
    accidentalLabel: "5♯",
    dropdownLabel: "B Major / G♯ Minor (5♯)",
  },
  {
    fifths: 6,
    majorName: "F# Major",
    minorName: "D# Minor",
    majorTonicPc: 6,
    minorTonicPc: 3,
    accidentalLabel: "6♯",
    dropdownLabel: "F♯ Major / D♯ Minor (6♯)",
  },
  {
    fifths: 7,
    majorName: "C# Major",
    minorName: "A# Minor",
    majorTonicPc: 1,
    minorTonicPc: 10,
    accidentalLabel: "7♯",
    dropdownLabel: "C♯ Major / A♯ Minor (7♯)",
  },
  {
    fifths: -1,
    majorName: "F Major",
    minorName: "D Minor",
    majorTonicPc: 5,
    minorTonicPc: 2,
    accidentalLabel: "1♭",
    dropdownLabel: "F Major / D Minor (1♭)",
  },
  {
    fifths: -2,
    majorName: "Bb Major",
    minorName: "G Minor",
    majorTonicPc: 10,
    minorTonicPc: 7,
    accidentalLabel: "2♭",
    dropdownLabel: "B♭ Major / G Minor (2♭)",
  },
  {
    fifths: -3,
    majorName: "Eb Major",
    minorName: "C Minor",
    majorTonicPc: 3,
    minorTonicPc: 0,
    accidentalLabel: "3♭",
    dropdownLabel: "E♭ Major / C Minor (3♭)",
  },
  {
    fifths: -4,
    majorName: "Ab Major",
    minorName: "F Minor",
    majorTonicPc: 8,
    minorTonicPc: 5,
    accidentalLabel: "4♭",
    dropdownLabel: "A♭ Major / F Minor (4♭)",
  },
  {
    fifths: -5,
    majorName: "Db Major",
    minorName: "Bb Minor",
    majorTonicPc: 1,
    minorTonicPc: 10,
    accidentalLabel: "5♭",
    dropdownLabel: "D♭ Major / B♭ Minor (5♭)",
  },
  {
    fifths: -6,
    majorName: "Gb Major",
    minorName: "Eb Minor",
    majorTonicPc: 6,
    minorTonicPc: 3,
    accidentalLabel: "6♭",
    dropdownLabel: "G♭ Major / E♭ Minor (6♭)",
  },
  {
    fifths: -7,
    majorName: "Cb Major",
    minorName: "Ab Minor",
    majorTonicPc: 11,
    minorTonicPc: 8,
    accidentalLabel: "7♭",
    dropdownLabel: "C♭ Major / A♭ Minor (7♭)",
  },
] as const;

export const STEP_TO_PC: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"] as const;
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"] as const;

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

// C Major / A Minor (fifths === 0) conventional chromatic spelling: C#, Eb, F#, G#, Bb
const PC_TO_NEUTRAL_MIXED: Array<{ step: string; alter: number }> = [
  { step: "C", alter: 0 },
  { step: "C", alter: 1 },
  { step: "D", alter: 0 },
  { step: "E", alter: -1 },
  { step: "E", alter: 0 },
  { step: "F", alter: 0 },
  { step: "F", alter: 1 },
  { step: "G", alter: 0 },
  { step: "G", alter: 1 },
  { step: "A", alter: 0 },
  { step: "B", alter: -1 },
  { step: "B", alter: 0 },
];

export function clampKeyFifths(fifths: number): number {
  if (!Number.isFinite(fifths)) return 0;
  return Math.max(-7, Math.min(7, Math.round(fifths)));
}

export function getKeySignatureOption(fifths: number): KeySignatureOption {
  const f = clampKeyFifths(fifths);
  return CIRCLE_OF_FIFTHS_KEYS.find((k) => k.fifths === f) ?? CIRCLE_OF_FIFTHS_KEYS[0];
}

export function formatKeySignatureName(fifths: number, mode: KeyMode = "major"): string {
  const opt = getKeySignatureOption(fifths);
  return mode === "minor" ? opt.minorName : opt.majorName;
}

export function parseKeySignature(
  raw?: string | null,
  fallbackFifths = 0,
  fallbackMode: KeyMode = "major",
): KeySignatureState {
  const cleaned = (raw || "")
    .trim()
    .replace(/♭/g, "b")
    .replace(/♯/g, "#")
    .replace(/\s+/g, " ");

  if (!cleaned) {
    const f = clampKeyFifths(fallbackFifths);
    return { fifths: f, mode: fallbackMode, label: formatKeySignatureName(f, fallbackMode) };
  }

  // Handle dropdown-style label e.g. "Bb Major / G Minor (2b)"
  const primary = cleaned.includes("/") ? cleaned.split("/", 1)[0].trim() : cleaned;
  const lower = primary.toLowerCase();

  for (const opt of CIRCLE_OF_FIFTHS_KEYS) {
    const maj = opt.majorName.toLowerCase();
    const min = opt.minorName.toLowerCase();
    const majShort = maj.replace(/ major$/, "").trim();
    const minShort = `${min.replace(/ minor$/, "").trim()}m`;
    if (lower === maj || lower === majShort || lower === `${majShort} maj`) {
      return { fifths: opt.fifths, mode: "major", label: opt.majorName };
    }
    if (lower === min || lower === minShort || lower === `${min.replace(/ minor$/, "").trim()} min`) {
      return { fifths: opt.fifths, mode: "minor", label: opt.minorName };
    }
  }

  // Fallback for enharmonic aliases such as D# Major / Eb Major or "C major (est.)"
  const m = primary.match(/^([A-Ga-g])([#b]?)\s*(major|maj|minor|min|m)?/i);
  if (m) {
    const step = m[1].toUpperCase();
    const acc = m[2];
    const modeTok = (m[3] || "").toLowerCase();
    const isMinor = modeTok === "minor" || modeTok === "min" || modeTok === "m";
    const mode: KeyMode = isMinor ? "minor" : "major";
    const pc = (((STEP_TO_PC[step] ?? 0) + (acc === "#" ? 1 : acc === "b" ? -1 : 0)) % 12 + 12) % 12;
    const match = CIRCLE_OF_FIFTHS_KEYS.find((k) =>
      mode === "minor" ? k.minorTonicPc === pc : k.majorTonicPc === pc,
    );
    if (match) {
      return {
        fifths: match.fifths,
        mode,
        label: mode === "minor" ? match.minorName : match.majorName,
      };
    }
  }

  const f = clampKeyFifths(fallbackFifths);
  return { fifths: f, mode: fallbackMode, label: formatKeySignatureName(f, fallbackMode) };
}

export function getKeyTonicPc(fifths: number, mode: KeyMode = "major"): number {
  const opt = getKeySignatureOption(fifths);
  return mode === "minor" ? opt.minorTonicPc : opt.majorTonicPc;
}

export function computeShortestKeyInterval(
  fromFifths: number,
  fromMode: KeyMode,
  toFifths: number,
  toMode: KeyMode,
): number {
  const fromPc = getKeyTonicPc(fromFifths, fromMode);
  const toPc = getKeyTonicPc(toFifths, toMode);
  let diff = (((toPc - fromPc) % 12) + 12) % 12;
  if (diff > 6) diff -= 12;
  return diff;
}

export function getKeySignatureAlterForStep(step: string, fifths: number): number {
  const s = step.trim().toUpperCase();
  const f = clampKeyFifths(fifths);
  if (f > 0) {
    return (SHARP_ORDER.slice(0, f) as readonly string[]).includes(s) ? 1 : 0;
  }
  if (f < 0) {
    return (FLAT_ORDER.slice(0, Math.abs(f)) as readonly string[]).includes(s) ? -1 : 0;
  }
  return 0;
}

export function formatPitchLabel(step: string, alter: number, octave: number): string {
  const acc =
    alter === 2 ? "x" : alter === 1 ? "#" : alter === -1 ? "b" : alter === -2 ? "bb" : "";
  return `${step.toUpperCase()}${acc}${octave}`;
}

export function spellPitchClass(
  pitchClass: number,
  keyFifths = 0,
): { step: string; alter: number; name: string } {
  const pc = ((pitchClass % 12) + 12) % 12;
  const f = clampKeyFifths(keyFifths);

  let spelled: { step: string; alter: number };
  if (f < 0) {
    spelled = PC_TO_FLAT[pc];
    if (f <= -6 && pc === 11) {
      spelled = { step: "C", alter: -1 }; // Cb
    } else if (f === -7 && pc === 4) {
      spelled = { step: "F", alter: -1 }; // Fb
    }
  } else if (f > 0) {
    spelled = PC_TO_SHARP[pc];
    if (f >= 6 && pc === 5) {
      spelled = { step: "E", alter: 1 }; // E#
    } else if (f === 7 && pc === 0) {
      spelled = { step: "B", alter: 1 }; // B#
    }
  } else {
    spelled = PC_TO_NEUTRAL_MIXED[pc];
  }

  const acc = spelled.alter === 1 ? "#" : spelled.alter === -1 ? "b" : "";
  return {
    step: spelled.step,
    alter: spelled.alter,
    name: `${spelled.step}${acc}`,
  };
}

export function spellMidiPitch(midi: number, keyFifths = 0): SpelledPitch {
  const clamped = Math.max(0, Math.min(127, Math.round(midi)));
  const pc = ((clamped % 12) + 12) % 12;
  const spelled = spellPitchClass(pc, keyFifths);

  // Compute exact octave so (octave + 1) * 12 + STEP_TO_PC[step] + alter === clamped
  let octave = Math.floor(clamped / 12) - 1;
  const computed = (octave + 1) * 12 + (STEP_TO_PC[spelled.step] ?? 0) + spelled.alter;
  if (computed < clamped) octave += 1;
  else if (computed > clamped) octave -= 1;

  return {
    step: spelled.step,
    alter: spelled.alter,
    octave,
    label: formatPitchLabel(spelled.step, spelled.alter, octave),
    midi: clamped,
  };
}

export function respellChordSymbol(
  symbol: string,
  keyFifths: number,
  transposeSemitones = 0,
): { symbol: string; root: string } {
  const clean = (symbol || "").trim();
  if (!clean || /^N\.?C\.?$/i.test(clean)) {
    return { symbol: clean, root: "" };
  }

  const [mainPart, bassPart] = clean.split("/", 2);
  const rootMatch = mainPart.match(/^([A-Ga-g])(bb|##|x|𝄫|𝄪|[#b♯♭]?)(.*)$/);
  if (!rootMatch) {
    return { symbol: clean, root: "" };
  }

  const parseAlter = (acc: string): number => {
    if (acc === "#" || acc === "♯") return 1;
    if (acc === "b" || acc === "♭") return -1;
    if (acc === "##" || acc === "x" || acc === "𝄪") return 2;
    if (acc === "bb" || acc === "𝄫") return -2;
    return 0;
  };

  const rootStep = rootMatch[1].toUpperCase();
  const rootAlter = parseAlter(rootMatch[2] || "");
  const suffix = rootMatch[3] || "";
  const rootPc = (((STEP_TO_PC[rootStep] ?? 0) + rootAlter + transposeSemitones) % 12 + 12) % 12;
  const spelledRoot = spellPitchClass(rootPc, keyFifths).name;

  let nextBass = "";
  if (bassPart) {
    const bassMatch = bassPart.trim().match(/^([A-Ga-g])(bb|##|x|𝄫|𝄪|[#b♯♭]?)$/);
    if (bassMatch) {
      const bassStep = bassMatch[1].toUpperCase();
      const bassAlter = parseAlter(bassMatch[2] || "");
      const bassPc = (((STEP_TO_PC[bassStep] ?? 0) + bassAlter + transposeSemitones) % 12 + 12) % 12;
      nextBass = `/${spellPitchClass(bassPc, keyFifths).name}`;
    } else {
      nextBass = `/${bassPart.trim()}`;
    }
  }

  return {
    symbol: `${spelledRoot}${suffix}${nextBass}`,
    root: spelledRoot,
  };
}
