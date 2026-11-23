export interface MusicXmlTimeSegment {
  wholeNoteStart: number;
  wholeNoteEnd: number;
  quarterStart: number;
  quarterEnd: number;
  secStart: number;
  secEnd: number;
  tempoBpm: number;
  measureNumber: number;
  measureIndex?: number;
  isPickup?: boolean;
}

export interface MusicXmlTimeline {
  segments: MusicXmlTimeSegment[];
  totalWholeNotes: number;
  totalQuarterBeats: number;
  totalSec: number;
  hasPickup: boolean;
  pickupQuarterBeats: number;
}

export interface OsmdCursorSnapshot {
  wholeNote: number;
  osmdRealValue?: number;
  sec: number;
  stepIndex: number;
}

/** Convert MusicXML / OSMD RealValue (whole-note units) to quarter-note units. */
export function wholeNotesToQuarterNotes(wholeNotes: number): number {
  return wholeNotes * 4;
}

/** Convert quarter-note units back to whole-note units for timeline lookup. */
export function quarterNotesToWholeNotes(quarterNotes: number): number {
  return quarterNotes / 4;
}

const BEAT_UNIT_QUARTERS: Record<string, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
  "32nd": 0.125,
};

function parseDirectionQuarterBpm(el: Element): number | null {
  const soundEl = el.getElementsByTagName("sound")[0];
  const tAttr = soundEl?.getAttribute("tempo");
  if (tAttr) {
    const parsed = Number.parseFloat(tAttr);
    if (Number.isFinite(parsed) && parsed >= 20 && parsed <= 320) return parsed;
  }
  const metEl = el.getElementsByTagName("metronome")[0];
  const perMinEl = (metEl ?? el).getElementsByTagName("per-minute")[0];
  if (perMinEl?.textContent) {
    const rawPerMin = Number.parseFloat(perMinEl.textContent);
    if (Number.isFinite(rawPerMin) && rawPerMin >= 20 && rawPerMin <= 320) {
      const beatUnit = (metEl?.getElementsByTagName("beat-unit")[0]?.textContent || "quarter")
        .trim()
        .toLowerCase();
      const dots = metEl ? metEl.getElementsByTagName("beat-unit-dot").length : 0;
      let unitQuarters = BEAT_UNIT_QUARTERS[beatUnit] ?? 1;
      if (dots > 0) unitQuarters *= 1.5;
      return Math.max(20, Math.min(320, rawPerMin * unitQuarters));
    }
  }
  return null;
}

/**
 * Build a conductor-aware timeline across all MusicXML parts, tracking
 * <divisions>, <time>, <sound tempo>, <metronome>, pickup measures
 * (number="0" / implicit="yes" / short first bar), <note>, <chord>, <rest>,
 * <backup>, and <forward> in quarter-note beats and elapsed seconds.
 */
export function buildMusicXmlTimeline(
  xmlStr: string | null | undefined,
  fallbackTempoBpm = 120,
): MusicXmlTimeline {
  const safeFallback = Math.max(20, fallbackTempoBpm || 120);
  if (!xmlStr || typeof DOMParser === "undefined") {
    return {
      segments: [],
      totalWholeNotes: 0,
      totalQuarterBeats: 0,
      totalSec: 0,
      hasPickup: false,
      pickupQuarterBeats: 0,
    };
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xmlStr, "application/xml");
    if (doc.querySelector("parsererror")) {
      return {
        segments: [],
        totalWholeNotes: 0,
        totalQuarterBeats: 0,
        totalSec: 0,
        hasPickup: false,
        pickupQuarterBeats: 0,
      };
    }
  } catch {
    return {
      segments: [],
      totalWholeNotes: 0,
      totalQuarterBeats: 0,
      totalSec: 0,
      hasPickup: false,
      pickupQuarterBeats: 0,
    };
  }

  const parts = Array.from(doc.getElementsByTagName("part"));
  if (parts.length === 0) {
    return {
      segments: [],
      totalWholeNotes: 0,
      totalQuarterBeats: 0,
      totalSec: 0,
      hasPickup: false,
      pickupQuarterBeats: 0,
    };
  }

  const partMeasures = parts.map((p) => Array.from(p.getElementsByTagName("measure")));
  const measureCount = Math.max(...partMeasures.map((ms) => ms.length), 0);
  const partDivisions = parts.map(() => 1);
  let timeBeats = 4;
  let timeBeatType = 4;
  let currentTempo = safeFallback;
  let curQuarter = 0;
  let curSec = 0;
  let hasPickup = false;
  let pickupQuarterBeats = 0;
  const segments: MusicXmlTimeSegment[] = [];

  for (let mIdx = 0; mIdx < measureCount; mIdx++) {
    let measureNum = mIdx + 1;
    let isImplicit = false;
    let maxMeasureQuarters = 0;
    const tempoEvents: Array<{ quarterOffset: number; tempoBpm: number }> = [];

    for (let pIdx = 0; pIdx < parts.length; pIdx++) {
      const m = partMeasures[pIdx][mIdx];
      if (!m) continue;
      if (pIdx === 0) {
        const parsedNum = Number.parseInt(m.getAttribute("number") || "", 10);
        measureNum = Number.isFinite(parsedNum) ? parsedNum : mIdx + 1;
        isImplicit = (m.getAttribute("implicit") || "").toLowerCase() === "yes";
      }

      let divisions = partDivisions[pIdx];
      let offsetDiv = 0;
      let maxDiv = 0;

      for (const el of Array.from(m.children)) {
        const tag = el.tagName.toLowerCase();
        if (tag === "attributes") {
          const divText = el.getElementsByTagName("divisions")[0]?.textContent;
          const parsedDiv = divText ? Number.parseFloat(divText) : NaN;
          if (Number.isFinite(parsedDiv) && parsedDiv > 0) {
            divisions = parsedDiv;
            partDivisions[pIdx] = parsedDiv;
          }
          const timeEl = el.getElementsByTagName("time")[0];
          if (timeEl) {
            const b = Number.parseInt(timeEl.getElementsByTagName("beats")[0]?.textContent || "", 10);
            const bt = Number.parseInt(timeEl.getElementsByTagName("beat-type")[0]?.textContent || "", 10);
            if (Number.isFinite(b) && b > 0) timeBeats = b;
            if (Number.isFinite(bt) && bt > 0) timeBeatType = bt;
          }
        } else if (tag === "sound") {
          const tAttr = el.getAttribute("tempo");
          const parsedT = tAttr ? Number.parseFloat(tAttr) : NaN;
          if (Number.isFinite(parsedT) && parsedT >= 20 && parsedT <= 320) {
            tempoEvents.push({ quarterOffset: offsetDiv / divisions, tempoBpm: parsedT });
          }
        } else if (tag === "direction") {
          const parsedT = parseDirectionQuarterBpm(el);
          if (parsedT !== null) {
            tempoEvents.push({ quarterOffset: offsetDiv / divisions, tempoBpm: parsedT });
          }
        } else if (tag === "note") {
          const isChord = el.getElementsByTagName("chord").length > 0;
          const isGrace = el.getElementsByTagName("grace").length > 0;
          if (isChord || isGrace) continue;
          const durText = el.getElementsByTagName("duration")[0]?.textContent;
          const durDiv = durText ? Number.parseFloat(durText) : 0;
          if (Number.isFinite(durDiv) && durDiv > 0) {
            offsetDiv += durDiv;
            maxDiv = Math.max(maxDiv, offsetDiv);
          }
        } else if (tag === "backup") {
          const durText = el.getElementsByTagName("duration")[0]?.textContent;
          const durDiv = durText ? Number.parseFloat(durText) : 0;
          if (Number.isFinite(durDiv) && durDiv > 0) {
            offsetDiv = Math.max(0, offsetDiv - durDiv);
          }
        } else if (tag === "forward") {
          const durText = el.getElementsByTagName("duration")[0]?.textContent;
          const durDiv = durText ? Number.parseFloat(durText) : 0;
          if (Number.isFinite(durDiv) && durDiv > 0) {
            offsetDiv += durDiv;
            maxDiv = Math.max(maxDiv, offsetDiv);
          }
        }
      }

      if (maxDiv > 0) {
        maxMeasureQuarters = Math.max(maxMeasureQuarters, maxDiv / divisions);
      }
    }

    const expectedBarQuarters = (timeBeats * 4) / timeBeatType;
    const totalMeasureQuarters = maxMeasureQuarters > 0 ? maxMeasureQuarters : expectedBarQuarters;
    const isPickup =
      mIdx === 0 &&
      (measureNum === 0 || isImplicit || totalMeasureQuarters < expectedBarQuarters - 1e-4);
    if (isPickup) {
      hasPickup = true;
      pickupQuarterBeats = totalMeasureQuarters;
    }

    // Deduplicate identical tempo events across parts at the same quarterOffset
    tempoEvents.sort((a, b) => a.quarterOffset - b.quarterOffset);
    let localQuarter = 0;
    for (const ev of tempoEvents) {
      const clampedQuarter = Math.max(localQuarter, Math.min(totalMeasureQuarters, ev.quarterOffset));
      if (clampedQuarter > localQuarter + 1e-6) {
        const segQuarters = clampedQuarter - localQuarter;
        const segSec = segQuarters * (60 / currentTempo);
        segments.push({
          wholeNoteStart: curQuarter / 4,
          wholeNoteEnd: (curQuarter + segQuarters) / 4,
          quarterStart: curQuarter,
          quarterEnd: curQuarter + segQuarters,
          secStart: curSec,
          secEnd: curSec + segSec,
          tempoBpm: currentTempo,
          measureNumber: measureNum,
          measureIndex: mIdx,
          isPickup,
        });
        curQuarter += segQuarters;
        curSec += segSec;
        localQuarter = clampedQuarter;
      }
      currentTempo = ev.tempoBpm;
    }

    if (totalMeasureQuarters > localQuarter + 1e-6) {
      const remQuarters = totalMeasureQuarters - localQuarter;
      const remSec = remQuarters * (60 / currentTempo);
      segments.push({
        wholeNoteStart: curQuarter / 4,
        wholeNoteEnd: (curQuarter + remQuarters) / 4,
        quarterStart: curQuarter,
        quarterEnd: curQuarter + remQuarters,
        secStart: curSec,
        secEnd: curSec + remSec,
        tempoBpm: currentTempo,
        measureNumber: measureNum,
        measureIndex: mIdx,
        isPickup,
      });
      curQuarter += remQuarters;
      curSec += remSec;
    }
  }

  return {
    segments,
    totalWholeNotes: curQuarter / 4,
    totalQuarterBeats: curQuarter,
    totalSec: curSec,
    hasPickup,
    pickupQuarterBeats,
  };
}

/** Binary search for the active timeline segment at `sec`. */
export function timeSecToWholeNotes(
  timeline: MusicXmlTimeline,
  sec: number,
  fallbackTempoBpm = 120,
): number {
  const safeSec = Math.max(0, sec);
  const segs = timeline.segments;
  if (segs.length === 0) {
    const beats = safeSec * (Math.max(20, fallbackTempoBpm) / 60);
    return beats / 4;
  }

  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].secEnd < safeSec) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const seg = segs[lo];
  const durSec = Math.max(1e-6, seg.secEnd - seg.secStart);
  const frac = Math.max(0, Math.min(1, (safeSec - seg.secStart) / durSec));
  return seg.wholeNoteStart + frac * (seg.wholeNoteEnd - seg.wholeNoteStart);
}

/** Binary search for the active playback time in seconds at `wholeNotes`. */
export function wholeNotesToTimeSec(
  timeline: MusicXmlTimeline,
  wholeNotes: number,
  fallbackTempoBpm = 120,
): number {
  const safeWhole = Math.max(0, wholeNotes);
  const segs = timeline.segments;
  if (segs.length === 0) {
    return safeWhole * 4 * (60 / Math.max(20, fallbackTempoBpm));
  }

  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].wholeNoteEnd < safeWhole) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const seg = segs[lo];
  const durWhole = Math.max(1e-6, seg.wholeNoteEnd - seg.wholeNoteStart);
  const frac = Math.max(0, Math.min(1, (safeWhole - seg.wholeNoteStart) / durWhole));
  return seg.secStart + frac * (seg.secEnd - seg.secStart);
}

/** Binary search for the latest OSMD cursor snapshot at or before `sec`. */
export function findCursorSnapshotIndex(
  snapshots: OsmdCursorSnapshot[],
  sec: number,
): number {
  if (snapshots.length === 0) return -1;
  let lo = 0;
  let hi = snapshots.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid].sec <= sec + 0.004) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
