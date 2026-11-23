export interface MusicXmlTimeSegment {
  wholeNoteStart: number;
  wholeNoteEnd: number;
  secStart: number;
  secEnd: number;
  tempoBpm: number;
  measureNumber: number;
  measureIndex?: number;
}

export interface MusicXmlTimeline {
  segments: MusicXmlTimeSegment[];
  totalWholeNotes: number;
  totalSec: number;
}

export interface OsmdCursorSnapshot {
  wholeNote: number;
  osmdRealValue?: number;
  sec: number;
  stepIndex: number;
}

/**
 * Parse MusicXML divisions, mid-measure and measure-level tempo changes,
 * notes (including tuplets), rests, backups, and forwards into an exact
 * whole-note <-> seconds timeline.
 */
export function buildMusicXmlTimeline(
  xmlStr: string | null | undefined,
  fallbackTempoBpm = 120,
): MusicXmlTimeline {
  const safeFallback = Math.max(20, fallbackTempoBpm || 120);
  if (!xmlStr || typeof DOMParser === "undefined") {
    return { segments: [], totalWholeNotes: 0, totalSec: 0 };
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xmlStr, "application/xml");
    if (doc.querySelector("parsererror")) {
      return { segments: [], totalWholeNotes: 0, totalSec: 0 };
    }
  } catch {
    return { segments: [], totalWholeNotes: 0, totalSec: 0 };
  }

  const firstPart = doc.getElementsByTagName("part")[0];
  if (!firstPart) {
    return { segments: [], totalWholeNotes: 0, totalSec: 0 };
  }

  const measures = Array.from(firstPart.getElementsByTagName("measure"));
  let divisions = 1;
  let currentTempo = safeFallback;
  let curWhole = 0;
  let curSec = 0;
  const segments: MusicXmlTimeSegment[] = [];

  for (let mIdx = 0; mIdx < measures.length; mIdx++) {
    const m = measures[mIdx];
    const parsedNum = Number.parseInt(m.getAttribute("number") || "", 10);
    const measureNum = Number.isFinite(parsedNum) ? parsedNum : mIdx + 1;
    let measureOffsetDiv = 0;
    let maxMeasureDiv = 0;
    const tempoEvents: Array<{ divOffset: number; tempoBpm: number }> = [];

    const children = Array.from(m.children);
    for (const el of children) {
      const tag = el.tagName.toLowerCase();
      if (tag === "attributes") {
        const divText = el.getElementsByTagName("divisions")[0]?.textContent;
        const parsedDiv = divText ? Number.parseFloat(divText) : NaN;
        if (Number.isFinite(parsedDiv) && parsedDiv > 0) {
          divisions = parsedDiv;
        }
      } else if (tag === "sound") {
        const tAttr = el.getAttribute("tempo");
        const parsedT = tAttr ? Number.parseFloat(tAttr) : NaN;
        if (Number.isFinite(parsedT) && parsedT >= 20 && parsedT <= 320) {
          tempoEvents.push({ divOffset: measureOffsetDiv, tempoBpm: parsedT });
        }
      } else if (tag === "direction") {
        const soundEl = el.getElementsByTagName("sound")[0];
        const tAttr = soundEl?.getAttribute("tempo");
        const perMin = el.getElementsByTagName("per-minute")[0]?.textContent;
        const parsedT = Number.parseFloat(tAttr || perMin || "");
        if (Number.isFinite(parsedT) && parsedT >= 20 && parsedT <= 320) {
          tempoEvents.push({ divOffset: measureOffsetDiv, tempoBpm: parsedT });
        }
      } else if (tag === "note") {
        const isChord = el.getElementsByTagName("chord").length > 0;
        const isGrace = el.getElementsByTagName("grace").length > 0;
        if (isChord || isGrace) continue;
        const durText = el.getElementsByTagName("duration")[0]?.textContent;
        const durDiv = durText ? Number.parseFloat(durText) : 0;
        if (Number.isFinite(durDiv) && durDiv > 0) {
          measureOffsetDiv += durDiv;
          maxMeasureDiv = Math.max(maxMeasureDiv, measureOffsetDiv);
        }
      } else if (tag === "backup") {
        const durText = el.getElementsByTagName("duration")[0]?.textContent;
        const durDiv = durText ? Number.parseFloat(durText) : 0;
        if (Number.isFinite(durDiv) && durDiv > 0) {
          measureOffsetDiv = Math.max(0, measureOffsetDiv - durDiv);
        }
      } else if (tag === "forward") {
        const durText = el.getElementsByTagName("duration")[0]?.textContent;
        const durDiv = durText ? Number.parseFloat(durText) : 0;
        if (Number.isFinite(durDiv) && durDiv > 0) {
          measureOffsetDiv += durDiv;
          maxMeasureDiv = Math.max(maxMeasureDiv, measureOffsetDiv);
        }
      }
    }

    const totalMeasureDiv = maxMeasureDiv > 0 ? maxMeasureDiv : divisions * 4;
    // Split measure at any mid-measure tempo change
    tempoEvents.sort((a, b) => a.divOffset - b.divOffset);
    let localDiv = 0;
    for (const ev of tempoEvents) {
      const clampedDiv = Math.max(localDiv, Math.min(totalMeasureDiv, ev.divOffset));
      if (clampedDiv > localDiv) {
        const segWhole = (clampedDiv - localDiv) / (divisions * 4);
        const segSec = segWhole * 4 * (60 / currentTempo);
        segments.push({
          wholeNoteStart: curWhole,
          wholeNoteEnd: curWhole + segWhole,
          secStart: curSec,
          secEnd: curSec + segSec,
          tempoBpm: currentTempo,
          measureNumber: measureNum,
          measureIndex: mIdx,
        });
        curWhole += segWhole;
        curSec += segSec;
        localDiv = clampedDiv;
      }
      currentTempo = ev.tempoBpm;
    }

    if (totalMeasureDiv > localDiv) {
      const remWhole = (totalMeasureDiv - localDiv) / (divisions * 4);
      const remSec = remWhole * 4 * (60 / currentTempo);
      segments.push({
        wholeNoteStart: curWhole,
        wholeNoteEnd: curWhole + remWhole,
        secStart: curSec,
        secEnd: curSec + remSec,
        tempoBpm: currentTempo,
        measureNumber: measureNum,
        measureIndex: mIdx,
      });
      curWhole += remWhole;
      curSec += remSec;
    }
  }

  return {
    segments,
    totalWholeNotes: curWhole,
    totalSec: curSec,
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
