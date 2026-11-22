export interface MusicXmlTimeSegment {
  wholeNoteStart: number;
  wholeNoteEnd: number;
  secStart: number;
  secEnd: number;
  tempoBpm: number;
  measureNumber: number;
}

export interface MusicXmlTimeline {
  segments: MusicXmlTimeSegment[];
  totalWholeNotes: number;
  totalSec: number;
}

/**
 * Parse MusicXML divisions, tempo changes, notes, rests, backups, and forwards
 * into an exact whole-note <-> seconds timeline (supporting pickups, ties, and tempo changes).
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
    const measureNum = Number.parseInt(m.getAttribute("number") || String(mIdx + 1), 10) || mIdx + 1;
    let measureOffsetDiv = 0;
    let maxMeasureDiv = 0;

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
          currentTempo = parsedT;
        }
      } else if (tag === "direction") {
        const soundEl = el.getElementsByTagName("sound")[0];
        const tAttr = soundEl?.getAttribute("tempo");
        const perMin = el.getElementsByTagName("per-minute")[0]?.textContent;
        const parsedT = Number.parseFloat(tAttr || perMin || "");
        if (Number.isFinite(parsedT) && parsedT >= 20 && parsedT <= 320) {
          currentTempo = parsedT;
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

    const measureWhole = maxMeasureDiv > 0 ? maxMeasureDiv / (divisions * 4) : 1.0;
    const measureSec = measureWhole * 4 * (60 / currentTempo);
    segments.push({
      wholeNoteStart: curWhole,
      wholeNoteEnd: curWhole + measureWhole,
      secStart: curSec,
      secEnd: curSec + measureSec,
      tempoBpm: currentTempo,
      measureNumber: measureNum,
    });
    curWhole += measureWhole;
    curSec += measureSec;
  }

  return {
    segments,
    totalWholeNotes: curWhole,
    totalSec: curSec,
  };
}

export function timeSecToWholeNotes(
  timeline: MusicXmlTimeline,
  sec: number,
  fallbackTempoBpm = 120,
): number {
  const safeSec = Math.max(0, sec);
  if (timeline.segments.length === 0) {
    const beats = safeSec * (Math.max(20, fallbackTempoBpm) / 60);
    return beats / 4;
  }
  for (let i = 0; i < timeline.segments.length; i++) {
    const seg = timeline.segments[i];
    if (safeSec <= seg.secEnd || i === timeline.segments.length - 1) {
      const durSec = Math.max(1e-6, seg.secEnd - seg.secStart);
      const frac = Math.max(0, Math.min(1, (safeSec - seg.secStart) / durSec));
      return seg.wholeNoteStart + frac * (seg.wholeNoteEnd - seg.wholeNoteStart);
    }
  }
  return timeline.totalWholeNotes;
}

export function wholeNotesToTimeSec(
  timeline: MusicXmlTimeline,
  wholeNotes: number,
  fallbackTempoBpm = 120,
): number {
  const safeWhole = Math.max(0, wholeNotes);
  if (timeline.segments.length === 0) {
    return safeWhole * 4 * (60 / Math.max(20, fallbackTempoBpm));
  }
  for (let i = 0; i < timeline.segments.length; i++) {
    const seg = timeline.segments[i];
    if (safeWhole <= seg.wholeNoteEnd || i === timeline.segments.length - 1) {
      const durWhole = Math.max(1e-6, seg.wholeNoteEnd - seg.wholeNoteStart);
      const frac = Math.max(0, Math.min(1, (safeWhole - seg.wholeNoteStart) / durWhole));
      return seg.secStart + frac * (seg.secEnd - seg.secStart);
    }
  }
  return timeline.totalSec;
}
