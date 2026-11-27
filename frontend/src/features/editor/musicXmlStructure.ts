export type NavigationMarkerType =
  | "dc_al_fine"
  | "dc_al_coda"
  | "ds_al_fine"
  | "ds_al_coda"
  | "segno"
  | "coda"
  | "fine"
  | "to_coda";

export interface MeasureStructureInfo {
  measureIndex: number;
  measureNumber: number;
  isImplicit: boolean;
  isPickup: boolean;
  isIrregular: boolean;
  timeBeats: number;
  timeBeatType: number;
  hasExplicitTimeChange: boolean;
  nominalQuarters: number;
  actualQuarters: number;
  beatsInActiveUnit: number;
  forwardRepeat: boolean;
  backwardRepeat: boolean;
  repeatCount: number;
  endingStart: number[] | null;
  endingStop: number[] | null;
  endingDiscontinue: number[] | null;
  navigationMarkers: NavigationMarkerType[];
}

export interface ScoreStructureMetadata {
  hasPickup: boolean;
  pickupBeatsInUnit: number;
  pickupQuarterBeats: number;
  baseTimeSignature: string;
  baseBeats: number;
  baseBeatType: number;
  measures: MeasureStructureInfo[];
}

export function getBeatUnitQuarters(beatType: number): number {
  const safe = Number.isFinite(beatType) && beatType > 0 ? beatType : 4;
  return 4 / safe;
}

/**
 * Safely parse a MusicXML <measure number="..."> attribute without treating
 * Measure 0 (anacrusis / pickup) as falsy.
 */
export function getMeasureNumber(measureEl: Element, fallbackIdx: number): number {
  const raw = measureEl.getAttribute("number");
  const parsed = raw !== null ? Number.parseInt(raw.trim(), 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallbackIdx + 1;
}

function parseEndingNumbers(raw: string | null): number[] | null {
  if (!raw) return null;
  const nums = raw
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return nums.length > 0 ? nums : null;
}

function collectDirectionNavigationMarkers(dirEl: Element, out: Set<NavigationMarkerType>): void {
  if (dirEl.getElementsByTagName("segno").length > 0) {
    out.add("segno");
  }
  if (dirEl.getElementsByTagName("coda").length > 0) {
    out.add("coda");
  }

  const wordsText = Array.from(dirEl.getElementsByTagName("words"))
    .map((w) => (w.textContent || "").trim())
    .join(" ")
    .toLowerCase();
  const soundEl = dirEl.getElementsByTagName("sound")[0];

  if (soundEl) {
    if (soundEl.hasAttribute("segno")) out.add("segno");
    if (soundEl.hasAttribute("coda")) out.add("coda");
    if (soundEl.hasAttribute("fine")) out.add("fine");
    if (soundEl.hasAttribute("tocoda")) out.add("to_coda");
    if (soundEl.hasAttribute("dacapo")) {
      out.add(wordsText.includes("coda") ? "dc_al_coda" : "dc_al_fine");
    }
    if (soundEl.hasAttribute("dalsegno")) {
      out.add(wordsText.includes("coda") ? "ds_al_coda" : "ds_al_fine");
    }
  }

  if (wordsText) {
    if (/d\.?\s*c\.?\s*al\s*coda/.test(wordsText)) out.add("dc_al_coda");
    else if (/d\.?\s*c\.?\s*al\s*fine|^d\.?\s*c\.?$/.test(wordsText)) out.add("dc_al_fine");

    if (/d\.?\s*s\.?\s*al\s*coda/.test(wordsText)) out.add("ds_al_coda");
    else if (/d\.?\s*s\.?\s*al\s*fine|^d\.?\s*s\.?$/.test(wordsText)) out.add("ds_al_fine");

    if (/^fine\b/.test(wordsText)) out.add("fine");
    if (/\bto\s+coda\b/.test(wordsText)) out.add("to_coda");
  }
}

export function extractScoreStructure(
  xmlStr: string | null | undefined,
  fallbackTimeSignature = "4/4",
): ScoreStructureMetadata {
  const [fbBeatsRaw, fbBeatTypeRaw] = (fallbackTimeSignature || "4/4").split("/", 2);
  const fbBeats = Math.max(1, Number.parseInt(fbBeatsRaw || "4", 10) || 4);
  const fbBeatType = Math.max(1, Number.parseInt(fbBeatTypeRaw || "4", 10) || 4);

  if (!xmlStr || typeof DOMParser === "undefined") {
    return {
      hasPickup: false,
      pickupBeatsInUnit: 0,
      pickupQuarterBeats: 0,
      baseTimeSignature: `${fbBeats}/${fbBeatType}`,
      baseBeats: fbBeats,
      baseBeatType: fbBeatType,
      measures: [],
    };
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xmlStr, "application/xml");
    if (doc.querySelector("parsererror")) {
      return {
        hasPickup: false,
        pickupBeatsInUnit: 0,
        pickupQuarterBeats: 0,
        baseTimeSignature: `${fbBeats}/${fbBeatType}`,
        baseBeats: fbBeats,
        baseBeatType: fbBeatType,
        measures: [],
      };
    }
  } catch {
    return {
      hasPickup: false,
      pickupBeatsInUnit: 0,
      pickupQuarterBeats: 0,
      baseTimeSignature: `${fbBeats}/${fbBeatType}`,
      baseBeats: fbBeats,
      baseBeatType: fbBeatType,
      measures: [],
    };
  }

  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length === 0) {
    return {
      hasPickup: false,
      pickupBeatsInUnit: 0,
      pickupQuarterBeats: 0,
      baseTimeSignature: `${fbBeats}/${fbBeatType}`,
      baseBeats: fbBeats,
      baseBeatType: fbBeatType,
      measures: [],
    };
  }

  const partMeasures = parts.map((p) => Array.from(p.getElementsByTagName("measure")));
  const measureCount = Math.max(...partMeasures.map((ms) => ms.length), 0);
  const partDivisions = parts.map(() => 1);

  let activeBeats = fbBeats;
  let activeBeatType = fbBeatType;
  let baseBeats = fbBeats;
  let baseBeatType = fbBeatType;
  let capturedBaseTime = false;
  let hasPickup = false;
  let pickupBeatsInUnit = 0;
  let pickupQuarterBeats = 0;

  const measures: MeasureStructureInfo[] = [];

  for (let mIdx = 0; mIdx < measureCount; mIdx++) {
    const primaryM = partMeasures[0][mIdx];
    const measureNumber = primaryM ? getMeasureNumber(primaryM, mIdx) : mIdx + 1;
    const isImplicit = primaryM ? (primaryM.getAttribute("implicit") || "").toLowerCase() === "yes" : false;

    let maxMeasureQuarters = 0;
    let hasExplicitTimeChange = false;
    let forwardRepeat = false;
    let backwardRepeat = false;
    let repeatCount = 2;
    const endingStartSet = new Set<number>();
    const endingStopSet = new Set<number>();
    const endingDiscontinueSet = new Set<number>();
    const navMarkersSet = new Set<NavigationMarkerType>();

    for (let pIdx = 0; pIdx < parts.length; pIdx++) {
      const m = partMeasures[pIdx][mIdx];
      if (!m) continue;

      let divisions = partDivisions[pIdx];
      let offsetDiv = 0;
      let maxDiv = 0;

      for (const el of Array.from(m.children)) {
        const tag = el.tagName.toLowerCase();
        if (tag === "attributes") {
          const divTxt = el.getElementsByTagName("divisions")[0]?.textContent;
          const d = divTxt ? Number.parseFloat(divTxt) : NaN;
          if (Number.isFinite(d) && d > 0) {
            divisions = d;
            partDivisions[pIdx] = d;
          }
          const timeEl = el.getElementsByTagName("time")[0];
          if (timeEl && pIdx === 0) {
            const b = Number.parseInt(timeEl.getElementsByTagName("beats")[0]?.textContent || "", 10);
            const bt = Number.parseInt(timeEl.getElementsByTagName("beat-type")[0]?.textContent || "", 10);
            if (Number.isFinite(b) && b > 0 && Number.isFinite(bt) && bt > 0) {
              activeBeats = b;
              activeBeatType = bt;
              if (!capturedBaseTime) {
                baseBeats = b;
                baseBeatType = bt;
                capturedBaseTime = true;
              }
              hasExplicitTimeChange = true;
            }
          }
        } else if (tag === "note") {
          const isChord = el.getElementsByTagName("chord").length > 0;
          const isGrace = el.getElementsByTagName("grace").length > 0;
          if (!isChord && !isGrace) {
            const dur = Number.parseFloat(el.getElementsByTagName("duration")[0]?.textContent || "0");
            if (Number.isFinite(dur) && dur > 0) {
              offsetDiv += dur;
              maxDiv = Math.max(maxDiv, offsetDiv);
            }
          }
        } else if (tag === "backup") {
          const dur = Number.parseFloat(el.getElementsByTagName("duration")[0]?.textContent || "0");
          if (Number.isFinite(dur) && dur > 0) {
            offsetDiv = Math.max(0, offsetDiv - dur);
          }
        } else if (tag === "forward") {
          const dur = Number.parseFloat(el.getElementsByTagName("duration")[0]?.textContent || "0");
          if (Number.isFinite(dur) && dur > 0) {
            offsetDiv += dur;
            maxDiv = Math.max(maxDiv, offsetDiv);
          }
        } else if (tag === "barline" && pIdx === 0) {
          for (const rep of Array.from(el.getElementsByTagName("repeat"))) {
            const dir = (rep.getAttribute("direction") || "").toLowerCase();
            if (dir === "forward") {
              forwardRepeat = true;
            } else if (dir === "backward") {
              backwardRepeat = true;
              const timesAttr = rep.getAttribute("times");
              const parsedTimes = timesAttr ? Number.parseInt(timesAttr, 10) : NaN;
              if (Number.isFinite(parsedTimes) && parsedTimes >= 2) {
                repeatCount = Math.min(8, parsedTimes);
              }
            }
          }
          for (const endEl of Array.from(el.getElementsByTagName("ending"))) {
            const nums = parseEndingNumbers(endEl.getAttribute("number"));
            const etype = (endEl.getAttribute("type") || "").toLowerCase();
            if (!nums) continue;
            if (etype === "start") nums.forEach((n) => endingStartSet.add(n));
            else if (etype === "stop") nums.forEach((n) => endingStopSet.add(n));
            else if (etype === "discontinue") nums.forEach((n) => endingDiscontinueSet.add(n));
          }
        } else if (tag === "direction" && pIdx === 0) {
          collectDirectionNavigationMarkers(el, navMarkersSet);
        } else if (tag === "sound" && pIdx === 0) {
          if (el.hasAttribute("segno")) navMarkersSet.add("segno");
          if (el.hasAttribute("coda")) navMarkersSet.add("coda");
          if (el.hasAttribute("fine")) navMarkersSet.add("fine");
          if (el.hasAttribute("tocoda")) navMarkersSet.add("to_coda");
          if (el.hasAttribute("dacapo")) navMarkersSet.add("dc_al_fine");
          if (el.hasAttribute("dalsegno")) navMarkersSet.add("ds_al_fine");
        }
      }

      if (maxDiv > 0) {
        maxMeasureQuarters = Math.max(maxMeasureQuarters, maxDiv / divisions);
      }
    }

    const nominalQuarters = activeBeats * getBeatUnitQuarters(activeBeatType);
    const actualQuarters = maxMeasureQuarters > 0 ? maxMeasureQuarters : nominalQuarters;
    const isPickup =
      mIdx === 0 &&
      (measureNumber === 0 || isImplicit || actualQuarters < nominalQuarters - 1e-4);
    const isIrregular = !isPickup && Math.abs(actualQuarters - nominalQuarters) > 1e-3;
    const unitQuarters = getBeatUnitQuarters(activeBeatType);
    const beatsInActiveUnit = Number((actualQuarters / unitQuarters).toFixed(4));

    if (isPickup) {
      hasPickup = true;
      pickupQuarterBeats = Number(actualQuarters.toFixed(4));
      pickupBeatsInUnit = beatsInActiveUnit;
    }

    measures.push({
      measureIndex: mIdx,
      measureNumber,
      isImplicit,
      isPickup,
      isIrregular,
      timeBeats: activeBeats,
      timeBeatType: activeBeatType,
      hasExplicitTimeChange: hasExplicitTimeChange && !(mIdx === 0 && !isPickup),
      nominalQuarters,
      actualQuarters,
      beatsInActiveUnit,
      forwardRepeat,
      backwardRepeat,
      repeatCount,
      endingStart: endingStartSet.size > 0 ? Array.from(endingStartSet).sort((a, b) => a - b) : null,
      endingStop: endingStopSet.size > 0 ? Array.from(endingStopSet).sort((a, b) => a - b) : null,
      endingDiscontinue:
        endingDiscontinueSet.size > 0 ? Array.from(endingDiscontinueSet).sort((a, b) => a - b) : null,
      navigationMarkers: Array.from(navMarkersSet),
    });
  }

  return {
    hasPickup,
    pickupBeatsInUnit,
    pickupQuarterBeats,
    baseTimeSignature: `${baseBeats}/${baseBeatType}`,
    baseBeats,
    baseBeatType,
    measures,
  };
}

export function validateVoltaEndings(xmlStr: string | null | undefined): string[] {
  const structure = extractScoreStructure(xmlStr);
  const warnings: string[] = [];
  const openEndings = new Map<number, number>();

  for (const m of structure.measures) {
    if (m.endingStart) {
      for (const n of m.endingStart) {
        if (openEndings.has(n)) {
          warnings.push(`Ending ${n} opens again on measure ${m.measureNumber} before previous span closed.`);
        }
        openEndings.set(n, m.measureNumber);
      }
    }
    const closers = [...(m.endingStop || []), ...(m.endingDiscontinue || [])];
    for (const n of closers) {
      if (!openEndings.has(n)) {
        warnings.push(`Ending ${n} closes on measure ${m.measureNumber} without an opening bracket.`);
      } else {
        openEndings.delete(n);
      }
    }
  }

  for (const [n, startBar] of openEndings.entries()) {
    warnings.push(`Ending ${n} started on measure ${startBar} has no closing bracket.`);
  }

  return warnings;
}

export function validateNavigationMarkers(xmlStr: string | null | undefined): string[] {
  const structure = extractScoreStructure(xmlStr);
  const warnings: string[] = [];
  const hasSegno = structure.measures.some((m) => m.navigationMarkers.includes("segno"));
  const hasCoda = structure.measures.some((m) => m.navigationMarkers.includes("coda"));
  const hasFine = structure.measures.some((m) => m.navigationMarkers.includes("fine"));
  const hasToCoda = structure.measures.some((m) => m.navigationMarkers.includes("to_coda"));
  const hasDs = structure.measures.some(
    (m) => m.navigationMarkers.includes("ds_al_fine") || m.navigationMarkers.includes("ds_al_coda"),
  );
  const hasDcFine = structure.measures.some((m) => m.navigationMarkers.includes("dc_al_fine"));
  const hasDsFine = structure.measures.some((m) => m.navigationMarkers.includes("ds_al_fine"));
  const hasAlCoda = structure.measures.some(
    (m) => m.navigationMarkers.includes("dc_al_coda") || m.navigationMarkers.includes("ds_al_coda"),
  );

  if (hasDs && !hasSegno) {
    warnings.push("D.S. marker added without a Segno (𝄋) destination; playback will jump to measure 1.");
  }
  if ((hasDcFine || hasDsFine) && !hasFine) {
    warnings.push("al Fine marker added without a Fine measure; playback will continue to the end.");
  }
  if ((hasAlCoda || hasToCoda) && !hasCoda) {
    warnings.push("Coda jump present without a Coda (𝄌) destination measure.");
  }

  return warnings;
}
