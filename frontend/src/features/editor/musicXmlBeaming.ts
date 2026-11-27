const BEAM_LEVELS_BY_TYPE: Record<string, number> = {
  eighth: 1,
  "16th": 2,
  "32nd": 3,
  "64th": 4,
  "128th": 5,
};

export function getBeamLevelCount(noteType: string | null | undefined): number {
  if (!noteType) return 0;
  return BEAM_LEVELS_BY_TYPE[noteType.trim().toLowerCase()] ?? 0;
}

interface BeamLaneEvent {
  el: Element;
  startDiv: number;
  durDiv: number;
  endDiv: number;
  logicalStart: number;
  logicalEnd: number;
  isRest: boolean;
  isManualBeam: boolean;
  dotted: boolean;
  beamLevels: number;
  tupletKey: string | null;
}

function getDirectChild(parent: Element, tagName: string): Element | null {
  const target = tagName.toLowerCase();
  for (const child of Array.from(parent.children)) {
    if (child.tagName.toLowerCase() === target) return child;
  }
  return null;
}

function getDirectChildText(parent: Element, tagName: string): string | null {
  return getDirectChild(parent, tagName)?.textContent?.trim() ?? null;
}

function getNoteStaffNumberLocal(noteEl: Element): number {
  const txt = getDirectChildText(noteEl, "staff");
  const n = txt ? Number.parseInt(txt, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function getNoteVoiceLocal(noteEl: Element): string {
  return getDirectChildText(noteEl, "voice") || "1";
}

function readTupletKey(noteEl: Element): string | null {
  const tm = getDirectChild(noteEl, "time-modification");
  if (!tm) return null;
  const actual = getDirectChildText(tm, "actual-notes");
  const normal = getDirectChildText(tm, "normal-notes");
  if (!actual || !normal) return null;
  return `${actual}:${normal}`;
}

function stripBeamChildren(noteEl: Element): void {
  for (const child of Array.from(noteEl.children)) {
    if (child.tagName.toLowerCase() === "beam") {
      noteEl.removeChild(child);
    }
  }
}

function insertBeamElements(
  doc: Document,
  noteEl: Element,
  beams: Array<{ level: number; value: "begin" | "continue" | "end" | "forward hook" | "backward hook" }>,
): void {
  if (beams.length === 0) return;
  const sorted = [...beams].sort((a, b) => a.level - b.level);
  const insertBeforeTarget =
    getDirectChild(noteEl, "notations") ||
    getDirectChild(noteEl, "lyric") ||
    getDirectChild(noteEl, "play") ||
    null;

  for (const b of sorted) {
    const beamEl = doc.createElement("beam");
    beamEl.setAttribute("number", String(b.level));
    beamEl.textContent = b.value;
    if (insertBeforeTarget) {
      noteEl.insertBefore(beamEl, insertBeforeTarget);
    } else {
      noteEl.appendChild(beamEl);
    }
  }
}

interface MeterBeamSpec {
  primaryBoundaries: number[];
  secondaryBreakDivs: number;
}

function buildBeatGridBoundaries(measureDivs: number, stepDivs: number): number[] {
  const safeStep = Math.max(1, stepDivs);
  const bounds: number[] = [0];
  let cur = safeStep;
  while (cur < measureDivs - 0.5) {
    bounds.push(cur);
    cur += safeStep;
  }
  bounds.push(Math.max(measureDivs, cur));
  return bounds;
}

function computeMeterBeamSpec(
  beats: number,
  beatType: number,
  divisions: number,
  fullBarDivs: number,
  events: BeamLaneEvent[],
  isPickup: boolean,
): MeterBeamSpec {
  const beatUnitDivs = Math.max(1, (divisions * 4) / Math.max(1, beatType));
  const maxLogicalEnd = Math.max(
    fullBarDivs,
    events.reduce((m, e) => Math.max(m, e.logicalEnd), 0),
  );

  // Compound meters (e.g. 6/8, 9/8, 12/8, or 6/16, 9/16, 12/16): group in dotted beats of 3 units
  if ((beatType === 8 || beatType === 16) && beats >= 6 && beats % 3 === 0) {
    return {
      primaryBoundaries: buildBeatGridBoundaries(maxLogicalEnd, beatUnitDivs * 3),
      secondaryBreakDivs: beatUnitDivs,
    };
  }

  // Simple 4/4: never cross middle of measure (beat 2 -> beat 3).
  // Allow half-bar 4-eighth beaming when all beamable notes in that half-bar are plain eighths
  // (unless it's a pickup measure, where beat-level grouping keeps offbeat anacrusis clean).
  if (beats === 4 && beatType === 4) {
    const bounds: number[] = [0];
    for (let halfIdx = 0; halfIdx < Math.ceil(maxLogicalEnd / (2 * divisions)); halfIdx++) {
      const hs = halfIdx * 2 * divisions;
      const mid = hs + divisions;
      const he = hs + 2 * divisions;
      const inHalf = events.filter(
        (ev) => !ev.isRest && ev.beamLevels > 0 && ev.logicalStart >= hs - 0.25 && ev.logicalStart < he - 0.25,
      );
      const plainEighthsOnly =
        !isPickup &&
        inHalf.length > 0 &&
        inHalf.every((ev) => ev.beamLevels === 1 && !ev.dotted && ev.tupletKey === null);
      if (!plainEighthsOnly && mid < maxLogicalEnd - 0.25) {
        bounds.push(mid);
      }
      if (he < maxLogicalEnd - 0.25) {
        bounds.push(he);
      }
    }
    bounds.push(Math.max(maxLogicalEnd, bounds[bounds.length - 1] + divisions));
    return { primaryBoundaries: bounds, secondaryBreakDivs: divisions };
  }

  // Simple 2/4: allow full-bar 4-eighth beaming if all beamable notes are plain eighths, else quarter beats
  if (beats === 2 && beatType === 4) {
    const inBar = events.filter(
      (ev) => !ev.isRest && ev.beamLevels > 0 && ev.logicalStart < fullBarDivs - 0.5,
    );
    const plainEighthsOnly =
      inBar.length > 0 && inBar.every((ev) => ev.beamLevels === 1 && !ev.dotted && ev.tupletKey === null);
    if (plainEighthsOnly) {
      return {
        primaryBoundaries: buildBeatGridBoundaries(maxLogicalEnd, divisions * 2),
        secondaryBreakDivs: divisions,
      };
    }
    return {
      primaryBoundaries: buildBeatGridBoundaries(maxLogicalEnd, divisions),
      secondaryBreakDivs: divisions,
    };
  }

  // Simple 3/4: clear quarter-note beat groups
  if (beats === 3 && beatType === 4) {
    return {
      primaryBoundaries: buildBeatGridBoundaries(maxLogicalEnd, divisions),
      secondaryBreakDivs: divisions,
    };
  }

  // Cut time 2/2: half-note beats with quarter-note secondary subdivision
  if (beats === 2 && beatType === 2) {
    return {
      primaryBoundaries: buildBeatGridBoundaries(maxLogicalEnd, divisions * 2),
      secondaryBreakDivs: divisions,
    };
  }

  // 3/8: full-bar dotted-quarter group with eighth-note secondary subdivision
  if (beats === 3 && beatType === 8) {
    return {
      primaryBoundaries: buildBeatGridBoundaries(maxLogicalEnd, beatUnitDivs * 3),
      secondaryBreakDivs: beatUnitDivs,
    };
  }

  // Irregular 5/8 (3 + 2) and 7/8 (2 + 2 + 3) or other N/8 meters
  if (beatType === 8) {
    if (beats === 5) {
      return {
        primaryBoundaries: [0, beatUnitDivs * 3, Math.max(maxLogicalEnd, beatUnitDivs * 5)],
        secondaryBreakDivs: beatUnitDivs,
      };
    }
    if (beats === 7) {
      return {
        primaryBoundaries: [0, beatUnitDivs * 2, beatUnitDivs * 4, Math.max(maxLogicalEnd, beatUnitDivs * 7)],
        secondaryBreakDivs: beatUnitDivs,
      };
    }
    const bounds: number[] = [0];
    let posBeats = 0;
    while (posBeats < beats) {
      const rem = beats - posBeats;
      const stepBeats = rem === 3 ? 3 : 2;
      posBeats += stepBeats;
      bounds.push(posBeats * beatUnitDivs);
    }
    return { primaryBoundaries: bounds, secondaryBreakDivs: beatUnitDivs };
  }

  // General simple meter (5/4, 6/4, etc.): beat-unit groups
  return {
    primaryBoundaries: buildBeatGridBoundaries(maxLogicalEnd, beatUnitDivs),
    secondaryBreakDivs: beatUnitDivs,
  };
}

function findPrimaryGroupIndex(posDiv: number, boundaries: number[]): number {
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (posDiv < boundaries[i + 1] - 0.25) return i;
  }
  return Math.max(0, boundaries.length - 2);
}

function beamLaneEvents(
  doc: Document,
  events: BeamLaneEvent[],
  beats: number,
  beatType: number,
  divisions: number,
  isPickup: boolean,
): void {
  if (events.length === 0) return;

  const fullBarDivs = Math.max(1, Math.round(divisions * beats * (4 / Math.max(1, beatType))));
  const laneMaxEnd = events.reduce((m, e) => Math.max(m, e.endDiv), 0);
  const pickupShiftDivs =
    isPickup && laneMaxEnd > 0 && laneMaxEnd < fullBarDivs - 0.5 ? fullBarDivs - laneMaxEnd : 0;

  for (const ev of events) {
    ev.logicalStart = ev.startDiv + pickupShiftDivs;
    ev.logicalEnd = ev.endDiv + pickupShiftDivs;
    if (!ev.isManualBeam) {
      stripBeamChildren(ev.el);
    }
  }

  const spec = computeMeterBeamSpec(beats, beatType, divisions, fullBarDivs, events, isPickup);

  // Build contiguous beamable groups
  const groups: BeamLaneEvent[][] = [];
  let current: BeamLaneEvent[] = [];

  const flushCurrent = () => {
    if (current.length >= 2) {
      groups.push(current);
    }
    current = [];
  };

  for (const ev of events) {
    if (ev.isRest || ev.beamLevels <= 0 || ev.isManualBeam || ev.durDiv <= 0) {
      flushCurrent();
      continue;
    }

    const evGroupIdx = findPrimaryGroupIndex(ev.logicalStart, spec.primaryBoundaries);
    const evEndGroupIdx = findPrimaryGroupIndex(Math.max(ev.logicalStart, ev.logicalEnd - 0.5), spec.primaryBoundaries);

    if (evGroupIdx !== evEndGroupIdx) {
      // Note spans across a primary beat group boundary (e.g., syncopation) — don't beam across boundary
      flushCurrent();
      continue;
    }

    if (current.length === 0) {
      current.push(ev);
      continue;
    }

    const prev = current[current.length - 1];
    const prevGroupIdx = findPrimaryGroupIndex(prev.logicalStart, spec.primaryBoundaries);
    const contiguous = Math.abs(ev.startDiv - prev.endDiv) <= 0.5;
    const sameGroup = evGroupIdx === prevGroupIdx;
    const sameTuplet = ev.tupletKey === prev.tupletKey;

    if (contiguous && sameGroup && sameTuplet) {
      current.push(ev);
    } else {
      flushCurrent();
      current.push(ev);
    }
  }
  flushCurrent();

  for (const group of groups) {
    const perNoteBeams = group.map(() => new Map<number, "begin" | "continue" | "end" | "forward hook" | "backward hook">());
    const maxLevelsInGroup = group.reduce((m, ev) => Math.max(m, ev.beamLevels), 1);

    // Level 1 spans the entire contiguous group
    for (let i = 0; i < group.length; i++) {
      perNoteBeams[i].set(1, i === 0 ? "begin" : i === group.length - 1 ? "end" : "continue");
    }

    // Levels 2..maxLevels partition within secondary sub-beat boundaries and emit hooks cleanly
    const secBreak = Math.max(1, spec.secondaryBreakDivs);
    for (let level = 2; level <= maxLevelsInGroup; level++) {
      let runStart = -1;

      const emitRun = (startIdx: number, endIdx: number) => {
        if (startIdx < 0 || endIdx < startIdx) return;
        if (endIdx > startIdx) {
          for (let k = startIdx; k <= endIdx; k++) {
            perNoteBeams[k].set(level, k === startIdx ? "begin" : k === endIdx ? "end" : "continue");
          }
        } else {
          // Single shorter note (e.g. dotted 8th + 16th): emit forward/backward hook
          const idx = startIdx;
          let hook: "forward hook" | "backward hook";
          if (idx === 0) {
            hook = "forward hook";
          } else if (idx === group.length - 1) {
            hook = "backward hook";
          } else {
            const curSec = Math.floor((group[idx].logicalStart + 0.5) / secBreak);
            const prevSec = Math.floor((group[idx - 1].logicalStart + 0.5) / secBreak);
            hook = curSec > prevSec ? "forward hook" : "backward hook";
          }
          perNoteBeams[idx].set(level, hook);
        }
      };

      for (let i = 0; i < group.length; i++) {
        const eligible = group[i].beamLevels >= level;
        if (!eligible) {
          if (runStart >= 0) {
            emitRun(runStart, i - 1);
            runStart = -1;
          }
          continue;
        }
        if (runStart < 0) {
          runStart = i;
        } else {
          const prevSec = Math.floor((group[i - 1].logicalStart + 0.5) / secBreak);
          const curSec = Math.floor((group[i].logicalStart + 0.5) / secBreak);
          if (curSec !== prevSec) {
            emitRun(runStart, i - 1);
            runStart = i;
          }
        }
      }
      if (runStart >= 0) {
        emitRun(runStart, group.length - 1);
      }
    }

    for (let i = 0; i < group.length; i++) {
      const entries = Array.from(perNoteBeams[i].entries()).map(([level, value]) => ({ level, value }));
      insertBeamElements(doc, group[i].el, entries);
    }
  }
}

export function applyAutomaticBeamingToDoc(
  doc: Document,
  partEl: Element,
  options?: { preserveExistingMeasures?: boolean },
): void {
  const measures = Array.from(partEl.children).filter((c) => c.tagName.toLowerCase() === "measure");
  let divisions = 1;
  let beats = 4;
  let beatType = 4;

  for (let mIdx = 0; mIdx < measures.length; mIdx++) {
    const mEl = measures[mIdx];
    const attrs = getDirectChild(mEl, "attributes");
    if (attrs) {
      const divTxt = getDirectChildText(attrs, "divisions");
      if (divTxt) {
        const d = Number.parseFloat(divTxt);
        if (Number.isFinite(d) && d > 0) divisions = d;
      }
      const timeEl = getDirectChild(attrs, "time");
      if (timeEl) {
        const bTxt = getDirectChildText(timeEl, "beats");
        const btTxt = getDirectChildText(timeEl, "beat-type");
        const b = bTxt ? Number.parseInt(bTxt, 10) : NaN;
        const bt = btTxt ? Number.parseInt(btTxt, 10) : NaN;
        if (Number.isFinite(b) && b > 0) beats = b;
        if (Number.isFinite(bt) && bt > 0) beatType = bt;
      }
    }

    if (options?.preserveExistingMeasures && mEl.getElementsByTagName("beam").length > 0) {
      continue;
    }

    const isPickup =
      (mEl.getAttribute("implicit") || "").trim().toLowerCase() === "yes" ||
      mEl.getAttribute("number") === "0";

    const lanes = new Map<string, BeamLaneEvent[]>();
    let offsetDiv = 0;

    for (const child of Array.from(mEl.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === "backup") {
        const d = Number.parseFloat(getDirectChildText(child, "duration") || "0");
        if (Number.isFinite(d) && d > 0) offsetDiv = Math.max(0, offsetDiv - d);
        continue;
      }
      if (tag === "forward") {
        const d = Number.parseFloat(getDirectChildText(child, "duration") || "0");
        if (Number.isFinite(d) && d > 0) offsetDiv += d;
        continue;
      }
      if (tag !== "note") continue;

      const isGrace = getDirectChild(child, "grace") !== null;
      const isChord = getDirectChild(child, "chord") !== null;
      if (isChord) {
        // MusicXML beams belong only on the primary note of a chord
        if (child.getAttribute("data-manual-beam") !== "true") {
          stripBeamChildren(child);
        }
        continue;
      }
      if (isGrace) continue;

      const durDiv = Number.parseFloat(getDirectChildText(child, "duration") || "0") || 0;
      const startDiv = offsetDiv;
      const endDiv = startDiv + Math.max(0, durDiv);
      offsetDiv = endDiv;

      const isRest = getDirectChild(child, "rest") !== null;
      const noteType = getDirectChildText(child, "type");
      const dotted = getDirectChild(child, "dot") !== null;
      const staff = getNoteStaffNumberLocal(child);
      const voice = getNoteVoiceLocal(child);
      const laneKey = `${staff}:${voice}`;
      if (!lanes.has(laneKey)) lanes.set(laneKey, []);

      lanes.get(laneKey)!.push({
        el: child,
        startDiv,
        durDiv,
        endDiv,
        logicalStart: startDiv,
        logicalEnd: endDiv,
        isRest,
        isManualBeam: child.getAttribute("data-manual-beam") === "true",
        dotted,
        beamLevels: isRest ? 0 : getBeamLevelCount(noteType),
        tupletKey: readTupletKey(child),
      });
    }

    for (const laneEvents of lanes.values()) {
      beamLaneEvents(doc, laneEvents, beats, beatType, divisions, isPickup);
    }
  }
}

export function applyAutomaticBeaming(
  xmlStr: string,
  options?: { preserveExistingMeasures?: boolean },
): string {
  if (!xmlStr || typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    return xmlStr;
  }
  const doc = new DOMParser().parseFromString(xmlStr, "application/xml");
  if (doc.querySelector("parsererror")) return xmlStr;
  for (const partEl of Array.from(doc.getElementsByTagName("part"))) {
    applyAutomaticBeamingToDoc(doc, partEl, options);
  }
  return new XMLSerializer().serializeToString(doc);
}
