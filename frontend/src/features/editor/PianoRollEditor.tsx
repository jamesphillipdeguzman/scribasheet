import React, { useMemo, useRef, useState } from "react";
import { Plus, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { midiToNoteName } from "@/lib/utils";
import { midiSynth } from "@/features/editor/midiSynth";
import type { ScoreNote } from "@/types/api";

interface PianoRollEditorProps {
  notes: ScoreNote[];
  durationSeconds: number;
  tempoBpm: number;
  playheadSec: number;
  selectedNoteId: string | null;
  onSelectNote: (id: string | null) => void;
  onChangeNotes: (notes: ScoreNote[]) => void;
}

const MIN_PITCH = 36; // C2
const MAX_PITCH = 96; // C7
const ROW_H = 16;

export function PianoRollEditor({
  notes,
  durationSeconds,
  tempoBpm,
  playheadSec,
  selectedNoteId,
  onSelectNote,
  onChangeNotes,
}: PianoRollEditorProps) {
  const [pxPerSec, setPxPerSec] = useState(140);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [dragState, setDragState] = useState<{
    noteId: string;
    mode: "move" | "resize";
    startX: number;
    startY: number;
    origOnset: number;
    origOffset: number;
    origPitch: number;
  } | null>(null);

  const gridRef = useRef<HTMLDivElement>(null);

  const totalDur = useMemo(() => {
    const maxNote = notes.reduce((m, n) => Math.max(m, n.offset_sec), 0);
    return Math.max(4, durationSeconds, maxNote + 1.5);
  }, [notes, durationSeconds]);

  const totalWidth = Math.max(640, Math.ceil(totalDur * pxPerSec));
  const totalHeight = (MAX_PITCH - MIN_PITCH + 1) * ROW_H;
  const gridStepSec = (60 / Math.max(20, tempoBpm)) * 0.25; // 16th note

  const snap = (sec: number) => {
    if (!snapToGrid) return Math.max(0, Number(sec.toFixed(3)));
    return Math.max(0, Number((Math.round(sec / gridStepSec) * gridStepSec).toFixed(3)));
  };

  const selectedNote = notes.find((n) => n.id === selectedNoteId) || null;

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    const dt = dx / pxPerSec;
    const dp = -Math.round(dy / ROW_H);

    onChangeNotes(
      notes.map((n) => {
        if (n.id !== dragState.noteId) return n;
        if (dragState.mode === "move") {
          const dur = dragState.origOffset - dragState.origOnset;
          const newOnset = snap(dragState.origOnset + dt);
          const newPitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, dragState.origPitch + dp));
          return {
            ...n,
            onset_sec: newOnset,
            offset_sec: Number((newOnset + dur).toFixed(3)),
            pitch_midi: newPitch,
          };
        } else {
          const newOffset = Math.max(dragState.origOnset + 0.06, snap(dragState.origOffset + dt));
          return { ...n, offset_sec: newOffset };
        }
      })
    );
  };

  const handleMouseUp = () => {
    setDragState(null);
  };

  const handleGridDoubleClick = (e: React.MouseEvent) => {
    if (!gridRef.current) return;
    const rect = gridRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const onset = snap(x / pxPerSec);
    const pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, MAX_PITCH - Math.floor(y / ROW_H)));
    const newNote: ScoreNote = {
      id: `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      pitch_midi: pitch,
      onset_sec: onset,
      offset_sec: Number((onset + Math.max(0.2, gridStepSec * 2)).toFixed(3)),
      velocity: 85,
      track_index: 0,
    };
    midiSynth.triggerNote(pitch, 0.25, 85);
    onSelectNote(newNote.id);
    onChangeNotes([...notes, newNote]);
  };

  const addNoteAtPlayhead = () => {
    const onset = snap(playheadSec);
    const newNote: ScoreNote = {
      id: `note_${Date.now().toString(36)}`,
      pitch_midi: 60,
      onset_sec: onset,
      offset_sec: Number((onset + 0.5).toFixed(3)),
      velocity: 90,
      track_index: 0,
    };
    midiSynth.triggerNote(60, 0.25, 90);
    onSelectNote(newNote.id);
    onChangeNotes([...notes, newNote]);
  };

  const deleteSelected = () => {
    if (!selectedNoteId) return;
    onChangeNotes(notes.filter((n) => n.id !== selectedNoteId));
    onSelectNote(null);
  };

  const pitchRows = useMemo(() => {
    const rows: number[] = [];
    for (let p = MAX_PITCH; p >= MIN_PITCH; p--) rows.push(p);
    return rows;
  }, []);

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={addNoteAtPlayhead}>
            <Plus className="h-3.5 w-3.5" />
            Add Note
          </Button>
          <Button size="sm" variant="danger" disabled={!selectedNote} onClick={deleteSelected}>
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
          <label className="inline-flex items-center gap-1.5 text-xs text-[#A1A1AA] ml-2">
            <input
              type="checkbox"
              checked={snapToGrid}
              onChange={(e) => setSnapToGrid(e.target.checked)}
              className="accent-[#A78BFA]"
            />
            Snap 1/16
          </label>
        </div>

        {selectedNote && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[#27273A] bg-[#181825] px-3 py-1 text-xs">
            <span className="font-mono text-[#A78BFA]">{midiToNoteName(selectedNote.pitch_midi)}</span>
            <span className="text-[#A1A1AA]">
              {selectedNote.onset_sec.toFixed(2)}s – {selectedNote.offset_sec.toFixed(2)}s
            </span>
            <label className="inline-flex items-center gap-1.5 text-[#A1A1AA]">
              Vel:
              <input
                type="range"
                min={20}
                max={127}
                value={selectedNote.velocity}
                onChange={(e) =>
                  onChangeNotes(
                    notes.map((n) =>
                      n.id === selectedNote.id ? { ...n, velocity: Number(e.target.value) } : n
                    )
                  )
                }
                className="w-20 accent-[#A78BFA]"
              />
              <span className="font-mono w-6">{selectedNote.velocity}</span>
            </label>
          </div>
        )}

        <div className="flex items-center gap-1">
          <Button size="sm" variant="secondary" onClick={() => setPxPerSec((p) => Math.max(60, p - 30))} aria-label="Zoom out piano roll">
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setPxPerSec((p) => Math.min(320, p + 30))} aria-label="Zoom in piano roll">
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Piano Roll Canvas */}
      <div
        className="relative flex max-h-[340px] overflow-auto rounded-xl border border-[#27273A] bg-[#09090F] select-none"
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* Pitch Keys Column */}
        <div className="sticky left-0 z-20 w-12 shrink-0 border-r border-[#27273A] bg-[#11111B]">
          {pitchRows.map((p) => {
            const isSharp = [1, 3, 6, 8, 10].includes(p % 12);
            const isC = p % 12 === 0;
            return (
              <div
                key={p}
                style={{ height: ROW_H }}
                onClick={() => midiSynth.triggerNote(p, 0.25, 85)}
                className={`flex items-center justify-end pr-1.5 text-[10px] font-mono border-b border-[#1E1E2E] cursor-pointer ${
                  isSharp ? "bg-[#0B0B12] text-[#71717A]" : "bg-[#181825] text-[#A1A1AA]"
                } ${isC ? "text-[#A78BFA] font-semibold" : ""}`}
              >
                {isC || isSharp === false ? midiToNoteName(p) : ""}
              </div>
            );
          })}
        </div>

        {/* Grid & Notes */}
        <div
          ref={gridRef}
          onDoubleClick={handleGridDoubleClick}
          style={{ width: totalWidth, height: totalHeight }}
          className="relative shrink-0"
          title="Double-click to add a note; drag note to move, drag right edge to resize"
        >
          {/* Horizontal Pitch Lanes */}
          {pitchRows.map((p, idx) => {
            const isSharp = [1, 3, 6, 8, 10].includes(p % 12);
            return (
              <div
                key={p}
                style={{ top: idx * ROW_H, height: ROW_H }}
                className={`absolute left-0 right-0 border-b border-[#181825] ${
                  isSharp ? "bg-[#0D0D15]" : "bg-[#09090F]"
                }`}
              />
            );
          })}

          {/* Beat Vertical Lines */}
          {Array.from({ length: Math.ceil(totalDur / (60 / Math.max(20, tempoBpm))) }).map((_, bIdx) => {
            const x = bIdx * (60 / Math.max(20, tempoBpm)) * pxPerSec;
            const isBar = bIdx % 4 === 0;
            return (
              <div
                key={bIdx}
                style={{ left: x }}
                className={`absolute top-0 bottom-0 w-px ${isBar ? "bg-[#2E2E45]" : "bg-[#181825]"}`}
              />
            );
          })}

          {/* Note Blocks */}
          {notes.map((n) => {
            if (n.pitch_midi < MIN_PITCH || n.pitch_midi > MAX_PITCH) return null;
            const top = (MAX_PITCH - n.pitch_midi) * ROW_H + 1;
            const left = n.onset_sec * pxPerSec;
            const width = Math.max(8, (n.offset_sec - n.onset_sec) * pxPerSec);
            const selected = n.id === selectedNoteId;
            return (
              <div
                key={n.id}
                style={{ top, left, width, height: ROW_H - 2 }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  onSelectNote(n.id);
                  midiSynth.triggerNote(n.pitch_midi, 0.2, n.velocity);
                  setDragState({
                    noteId: n.id,
                    mode: "move",
                    startX: e.clientX,
                    startY: e.clientY,
                    origOnset: n.onset_sec,
                    origOffset: n.offset_sec,
                    origPitch: n.pitch_midi,
                  });
                }}
                className={`absolute rounded-sm border text-[9px] leading-none flex items-center pl-1 overflow-hidden cursor-grab active:cursor-grabbing ${
                  selected
                    ? "bg-[#A78BFA] border-[#F5F3FF] text-[#09090F] font-semibold z-10"
                    : "bg-[#8B5CF6]/85 border-[#A78BFA]/60 text-[#F5F3FF] hover:bg-[#A78BFA]"
                }`}
              >
                <span className="truncate pointer-events-none">{width > 26 ? midiToNoteName(n.pitch_midi) : ""}</span>
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    onSelectNote(n.id);
                    setDragState({
                      noteId: n.id,
                      mode: "resize",
                      startX: e.clientX,
                      startY: e.clientY,
                      origOnset: n.onset_sec,
                      origOffset: n.offset_sec,
                      origPitch: n.pitch_midi,
                    });
                  }}
                  className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/40"
                />
              </div>
            );
          })}

          {/* Playhead */}
          <div
            style={{ left: playheadSec * pxPerSec }}
            className="absolute top-0 bottom-0 w-0.5 bg-emerald-400 pointer-events-none z-20"
          />
        </div>
      </div>
      <p className="text-[11px] text-[#71717A]">
        Tip: Double-click anywhere on the grid to add a note. Drag a note to change pitch or timing, or drag its right edge to resize duration.
      </p>
    </div>
  );
}
