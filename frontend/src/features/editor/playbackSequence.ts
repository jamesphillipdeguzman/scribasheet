import { buildMusicXmlTimeline } from "@/features/editor/musicXmlTimeline";
import {
  extractScoreStructure,
  getBeatUnitQuarters,
  validateNavigationMarkers,
  validateVoltaEndings,
  type MeasureStructureInfo,
} from "@/features/editor/musicXmlStructure";
import type { ScoreNote } from "@/types/api";

export interface PlaybackMeasureVisit {
  visitIndex: number;
  measureIndex: number;
  measureNumber: number;
  isPickup: boolean;
  playbackSecStart: number;
  playbackSecEnd: number;
  physicalSecStart: number;
  physicalSecEnd: number;
  physicalWholeStart: number;
  physicalWholeEnd: number;
  timeBeats: number;
  timeBeatType: number;
  tempoBpm: number;
  actualQuarters: number;
}

export interface PlaybackMetronomeBeat {
  sec: number;
  beatInBar: number;
  isDownbeat: boolean;
  isSubdivision: boolean;
  measureNumber: number;
}

export interface PlaybackSequence {
  visits: PlaybackMeasureVisit[];
  playbackNotes: ScoreNote[];
  totalPlaybackSec: number;
  hasRepeatsOrNavigation: boolean;
  hasPickup: boolean;
  pickupBeatsInUnit: number;
  baseBeatType: number;
  metronomeBeats: PlaybackMetronomeBeat[];
  warnings: string[];
}

function findEndingSpanEndIndex(measures: MeasureStructureInfo[], startIdx: number, endingNum: number): number {
  for (let j = startIdx; j < measures.length; j++) {
    const stops = measures[j].endingStop || [];
    const discont = measures[j].endingDiscontinue || [];
    if (stops.includes(endingNum) || discont.includes(endingNum)) {
      return j;
    }
  }
  return startIdx;
}

function findRepeatOriginIndex(measures: MeasureStructureInfo[], backwardIdx: number): number {
  for (let j = backwardIdx; j >= 0; j--) {
    if (measures[j].forwardRepeat) return j;
  }
  if (measures.length > 1 && measures[0]?.isPickup) {
    return 1;
  }
  return 0;
}

export function buildPlaybackSequence(
  xmlStr: string | null | undefined,
  notes: ScoreNote[],
  fallbackTempoBpm = 120,
): PlaybackSequence {
  const safeFallbackTempo = Math.max(20, fallbackTempoBpm || 120);
  const structure = extractScoreStructure(xmlStr);
  const timeline = buildMusicXmlTimeline(xmlStr, safeFallbackTempo);

  if (structure.measures.length === 0 || timeline.segments.length === 0) {
    const dur = Math.max(0, notes.reduce((m, n) => Math.max(m, n.offset_sec), 0));
    return {
      visits: [],
      playbackNotes: notes,
      totalPlaybackSec: dur,
      hasRepeatsOrNavigation: false,
      hasPickup: false,
      pickupBeatsInUnit: 0,
      baseBeatType: structure.baseBeatType,
      metronomeBeats: [],
      warnings: [],
    };
  }

  const measurePhysMap = new Map<
    number,
    {
      secStart: number;
      secEnd: number;
      wholeStart: number;
      wholeEnd: number;
      tempoBpm: number;
    }
  >();

  for (const seg of timeline.segments) {
    const idx =
      typeof seg.measureIndex === "number"
        ? seg.measureIndex
        : structure.measures.findIndex((m) => m.measureNumber === seg.measureNumber);
    if (idx < 0) continue;
    const prev = measurePhysMap.get(idx);
    if (!prev) {
      measurePhysMap.set(idx, {
        secStart: seg.secStart,
        secEnd: seg.secEnd,
        wholeStart: seg.wholeNoteStart,
        wholeEnd: seg.wholeNoteEnd,
        tempoBpm: seg.tempoBpm,
      });
    } else {
      prev.secEnd = Math.max(prev.secEnd, seg.secEnd);
      prev.wholeEnd = Math.max(prev.wholeEnd, seg.wholeNoteEnd);
    }
  }

  const measures = structure.measures;
  const maxVisits = Math.max(64, measures.length * 8);
  const warnings = [...validateVoltaEndings(xmlStr), ...validateNavigationMarkers(xmlStr)];

  const passCountByBackward = new Map<number, number>();
  const usedNavJumps = new Set<number>();
  let currentPass = 1;
  let jumpingBackMode = false;
  let activeJumpTarget: "fine" | "coda" | null = null;
  let hasRepeatsOrNavigation = false;

  const visitOrder: number[] = [];
  let idx = 0;

  while (idx >= 0 && idx < measures.length) {
    if (visitOrder.length >= maxVisits) {
      warnings.push("Playback stopped early after reaching maximum repeat expansion limit.");
      break;
    }

    const m = measures[idx];

    // Check volta ending filter
    if (m.endingStart && m.endingStart.length > 0) {
      const minEnding = m.endingStart[0];
      const spanEnd = findEndingSpanEndIndex(measures, idx, minEnding);
      if (jumpingBackMode) {
        const spanHasRepeatBack = measures
          .slice(idx, spanEnd + 1)
          .some((sm) => sm.backwardRepeat);
        if (spanHasRepeatBack) {
          hasRepeatsOrNavigation = true;
          idx = spanEnd + 1;
          continue;
        }
      } else if (!m.endingStart.includes(currentPass)) {
        hasRepeatsOrNavigation = true;
        idx = spanEnd + 1;
        continue;
      }
    }

    visitOrder.push(idx);

    // Clear pass counter once ending closes cleanly if not repeating backward here
    const closedNums = [...(m.endingStop || []), ...(m.endingDiscontinue || [])];
    if (closedNums.length > 0 && !m.backwardRepeat) {
      currentPass = 1;
    }

    // Navigation markers on return pass (Fine stops, To Coda jumps)
    if (jumpingBackMode) {
      if (activeJumpTarget === "fine" && m.navigationMarkers.includes("fine")) {
        break;
      }
      if (activeJumpTarget === "coda" && m.navigationMarkers.includes("to_coda")) {
        const codaIdx =
          measures.findIndex((cm, ci) => ci > idx && cm.navigationMarkers.includes("coda")) !== -1
            ? measures.findIndex((cm, ci) => ci > idx && cm.navigationMarkers.includes("coda"))
            : measures.findIndex((cm) => cm.navigationMarkers.includes("coda"));
        if (codaIdx >= 0 && codaIdx !== idx) {
          jumpingBackMode = false;
          activeJumpTarget = null;
          idx = codaIdx;
          continue;
        }
      }
    }

    // Backward repeat barline (only triggered on forward passes, not while finishing D.C./D.S.)
    if (m.backwardRepeat && !jumpingBackMode) {
      const targetJumps = Math.max(0, (m.repeatCount || 2) - 1);
      const takenJumps = passCountByBackward.get(idx) ?? 0;
      if (takenJumps < targetJumps) {
        hasRepeatsOrNavigation = true;
        passCountByBackward.set(idx, takenJumps + 1);
        const originIdx = findRepeatOriginIndex(measures, idx);
        // Reset inner nested backward repeats strictly inside [originIdx, idx)
        for (const innerKey of Array.from(passCountByBackward.keys())) {
          if (innerKey >= originIdx && innerKey < idx) {
            passCountByBackward.delete(innerKey);
          }
        }
        currentPass = takenJumps + 2;
        idx = originIdx;
        continue;
      }
      // Done repeating this section: advance pass back to 1
      currentPass = 1;
    } else if (m.forwardRepeat || (m.endingStart && m.endingStart.length > 0)) {
      hasRepeatsOrNavigation = true;
    }

    // D.C. / D.S. jumps (triggered at most once per marker measure)
    if (!usedNavJumps.has(idx)) {
      const hasDcFine = m.navigationMarkers.includes("dc_al_fine");
      const hasDcCoda = m.navigationMarkers.includes("dc_al_coda");
      const hasDsFine = m.navigationMarkers.includes("ds_al_fine");
      const hasDsCoda = m.navigationMarkers.includes("ds_al_coda");
      if (hasDcFine || hasDcCoda) {
        hasRepeatsOrNavigation = true;
        usedNavJumps.add(idx);
        jumpingBackMode = true;
        activeJumpTarget = hasDcCoda ? "coda" : "fine";
        currentPass = 1;
        idx = 0;
        continue;
      }
      if (hasDsFine || hasDsCoda) {
        hasRepeatsOrNavigation = true;
        usedNavJumps.add(idx);
        jumpingBackMode = true;
        activeJumpTarget = hasDsCoda ? "coda" : "fine";
        currentPass = 1;
        const segnoIdx = measures.findIndex((sm) => sm.navigationMarkers.includes("segno"));
        idx = segnoIdx >= 0 ? segnoIdx : 0;
        continue;
      }
    }

    idx += 1;
  }

  // Fallback if visitOrder ended up identical linearly
  if (
    visitOrder.length !== measures.length ||
    visitOrder.some((mi, i) => mi !== i)
  ) {
    hasRepeatsOrNavigation = true;
  }

  const visits: PlaybackMeasureVisit[] = [];
  const metronomeBeats: PlaybackMetronomeBeat[] = [];
  let cursorSec = 0;

  for (let vIdx = 0; vIdx < visitOrder.length; vIdx++) {
    const mIdx = visitOrder[vIdx];
    const info = measures[mIdx];
    const phys = measurePhysMap.get(mIdx) ?? {
      secStart: 0,
      secEnd: info.actualQuarters * (60 / safeFallbackTempo),
      wholeStart: 0,
      wholeEnd: info.actualQuarters / 4,
      tempoBpm: safeFallbackTempo,
    };
    const mDur = Math.max(0.01, phys.secEnd - phys.secStart);
    const playbackSecStart = cursorSec;
    const playbackSecEnd = cursorSec + mDur;

    visits.push({
      visitIndex: vIdx,
      measureIndex: mIdx,
      measureNumber: info.measureNumber,
      isPickup: info.isPickup,
      playbackSecStart,
      playbackSecEnd,
      physicalSecStart: phys.secStart,
      physicalSecEnd: phys.secEnd,
      physicalWholeStart: phys.wholeStart,
      physicalWholeEnd: phys.wholeEnd,
      timeBeats: info.timeBeats,
      timeBeatType: info.timeBeatType,
      tempoBpm: phys.tempoBpm,
      actualQuarters: info.actualQuarters,
    });

    // Generate beat-accurate metronome clicks for this measure visit
    const beatUnitQ = getBeatUnitQuarters(info.timeBeatType);
    const beatUnitSec = beatUnitQ * (60 / Math.max(20, phys.tempoBpm));
    const nominalBeats = Math.max(1, info.timeBeats);

    if (info.isPickup) {
      // Align pickup clicks backward from Beat 1 of Measure 1 (playbackSecEnd)
      const countFloat = mDur / beatUnitSec;
      const wholePickupBeats = Math.max(1, Math.round(countFloat + 1e-4));
      const firstBeatStart = playbackSecEnd - countFloat * beatUnitSec;
      for (let b = 0; b < wholePickupBeats; b++) {
        const beatSec = Math.max(playbackSecStart, firstBeatStart + b * beatUnitSec);
        if (beatSec >= playbackSecEnd - 0.01) continue;
        const numberedBeat = Math.max(1, nominalBeats - wholePickupBeats + b + 1);
        metronomeBeats.push({
          sec: Number(beatSec.toFixed(4)),
          beatInBar: numberedBeat,
          isDownbeat: false,
          isSubdivision: false,
          measureNumber: info.measureNumber,
        });
        const subSec = beatSec + beatUnitSec * 0.5;
        if (subSec < playbackSecEnd - 0.015) {
          metronomeBeats.push({
            sec: Number(subSec.toFixed(4)),
            beatInBar: numberedBeat,
            isDownbeat: false,
            isSubdivision: true,
            measureNumber: info.measureNumber,
          });
        }
      }
    } else {
      const totalBeats = Math.max(1, Math.ceil(info.beatsInActiveUnit - 1e-3));
      for (let b = 0; b < totalBeats; b++) {
        const beatSec = playbackSecStart + b * beatUnitSec;
        if (beatSec >= playbackSecEnd - 0.01) break;
        const beatInBar = b + 1;
        metronomeBeats.push({
          sec: Number(beatSec.toFixed(4)),
          beatInBar,
          isDownbeat: beatInBar === 1,
          isSubdivision: false,
          measureNumber: info.measureNumber,
        });
        const subSec = beatSec + beatUnitSec * 0.5;
        if (subSec < playbackSecEnd - 0.015) {
          metronomeBeats.push({
            sec: Number(subSec.toFixed(4)),
            beatInBar,
            isDownbeat: false,
            isSubdivision: true,
            measureNumber: info.measureNumber,
          });
        }
      }
    }

    cursorSec = playbackSecEnd;
  }

  let playbackNotes: ScoreNote[];
  if (!hasRepeatsOrNavigation) {
    playbackNotes = notes;
  } else {
    playbackNotes = [];
    for (const v of visits) {
      const shift = v.playbackSecStart - v.physicalSecStart;
      for (const n of notes) {
        if (n.onset_sec >= v.physicalSecStart - 0.002 && n.onset_sec < v.physicalSecEnd - 0.002) {
          const onset = Math.max(0, Number((n.onset_sec + shift).toFixed(4)));
          const offset = Math.max(onset + 0.04, Number((n.offset_sec + shift).toFixed(4)));
          playbackNotes.push({
            ...n,
            id: `${n.id}__v${v.visitIndex}`,
            onset_sec: onset,
            offset_sec: offset,
          });
        }
      }
    }
    playbackNotes.sort((a, b) => a.onset_sec - b.onset_sec || a.track_index - b.track_index || a.pitch_midi - b.pitch_midi);
  }

  const maxNoteOffset = playbackNotes.reduce((m, n) => Math.max(m, n.offset_sec), 0);
  return {
    visits,
    playbackNotes,
    totalPlaybackSec: Math.max(cursorSec, maxNoteOffset),
    hasRepeatsOrNavigation,
    hasPickup: structure.hasPickup,
    pickupBeatsInUnit: structure.pickupBeatsInUnit,
    baseBeatType: structure.baseBeatType,
    metronomeBeats,
    warnings: Array.from(new Set(warnings)),
  };
}

export function mapPlaybackSecToPhysicalSec(
  seq: PlaybackSequence | null | undefined,
  playbackSec: number,
): { physicalSec: number; measureIndex: number; measureNumber: number; visitIndex: number } {
  const safeSec = Math.max(0, playbackSec);
  if (!seq || seq.visits.length === 0) {
    return { physicalSec: safeSec, measureIndex: 0, measureNumber: 1, visitIndex: 0 };
  }
  const visits = seq.visits;
  let lo = 0;
  let hi = visits.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (visits[mid].playbackSecEnd <= safeSec + 1e-5) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const v = visits[lo];
  const offset = Math.max(0, Math.min(v.playbackSecEnd - v.playbackSecStart, safeSec - v.playbackSecStart));
  return {
    physicalSec: v.physicalSecStart + offset,
    measureIndex: v.measureIndex,
    measureNumber: v.measureNumber,
    visitIndex: v.visitIndex,
  };
}

export function mapPhysicalSecToPlaybackSec(
  seq: PlaybackSequence | null | undefined,
  physicalSec: number,
): number {
  const safePhys = Math.max(0, physicalSec);
  if (!seq || seq.visits.length === 0) return safePhys;
  for (const v of seq.visits) {
    if (safePhys >= v.physicalSecStart - 1e-4 && safePhys <= v.physicalSecEnd + 1e-4) {
      return v.playbackSecStart + Math.max(0, safePhys - v.physicalSecStart);
    }
  }
  return safePhys;
}
