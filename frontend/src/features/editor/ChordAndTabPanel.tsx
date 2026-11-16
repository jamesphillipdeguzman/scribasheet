import { midiToNoteName } from "@/lib/utils";
import type { ScoreChord, ScoreNote } from "@/types/api";

interface ChordAndTabPanelProps {
  chords: ScoreChord[];
  notes: ScoreNote[];
  onUpdateChord: (chordId: string, symbol: string) => void;
  onUpdateNoteTab: (noteId: string, stringNum: number, fretNum: number) => void;
}

const STRING_LABELS = ["e (1)", "B (2)", "G (3)", "D (4)", "A (5)", "E (6)"];

export function ChordAndTabPanel({
  chords,
  notes,
  onUpdateChord,
  onUpdateNoteTab,
}: ChordAndTabPanelProps) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Chord Analysis */}
      <div className="rounded-xl border border-[#27273A] bg-[#09090F] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Detected Chord Progression</h3>
          <span className="text-xs text-[#A1A1AA]">{chords.length} chord regions</span>
        </div>
        {chords.length === 0 ? (
          <p className="text-xs text-[#71717A]">
            No multi-note harmonic chord regions detected yet. Solo monophonic melodies may have no simultaneous chords.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-60 overflow-y-auto pr-1">
            {chords.map((c) => (
              <div key={c.id} className="rounded-lg border border-[#27273A] bg-[#11111B] p-2.5 space-y-1">
                <div className="text-[10px] font-mono text-[#A1A1AA]">
                  m.{c.measure} • beat {c.beat}
                </div>
                <input
                  aria-label={`Chord symbol at measure ${c.measure}`}
                  value={c.symbol}
                  onChange={(e) => onUpdateChord(c.id, e.target.value)}
                  className="w-full rounded border border-[#27273A] bg-[#09090F] px-2 py-1 text-sm font-semibold text-[#A78BFA] focus:border-[#A78BFA] focus:outline-none"
                />
                <div className="text-[10px] text-[#71717A] capitalize">{c.quality}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Guitar Tablature */}
      <div className="rounded-xl border border-[#27273A] bg-[#09090F] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Guitar Tablature (Standard Tuning)</h3>
          <span className="text-xs text-[#A1A1AA]">Calculated &amp; editable</span>
        </div>
        <p className="text-[11px] text-[#71717A]">
          MIDI does not encode physical fingering; string and fret numbers are estimated for standard tuning (E2–E4) and can be adjusted below.
        </p>
        <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
          {notes.slice(0, 60).map((n) => (
            <div
              key={n.id}
              className="flex items-center justify-between gap-2 rounded border border-[#27273A] bg-[#11111B] px-2.5 py-1.5 text-xs"
            >
              <span className="font-mono text-[#F5F3FF] w-14">
                {midiToNoteName(n.pitch_midi)}
              </span>
              <span className="text-[#71717A] font-mono">{n.onset_sec.toFixed(2)}s</span>
              <div className="flex items-center gap-1.5">
                <select
                  aria-label="Guitar string"
                  value={n.string_num ?? ""}
                  onChange={(e) =>
                    onUpdateNoteTab(n.id, Number(e.target.value || 1), n.fret_num ?? 0)
                  }
                  className="h-7 rounded border border-[#27273A] bg-[#09090F] px-1.5 text-xs"
                >
                  <option value="">—</option>
                  {STRING_LABELS.map((lbl, idx) => (
                    <option key={lbl} value={idx + 1}>
                      {lbl}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  aria-label="Fret number"
                  min={0}
                  max={24}
                  value={n.fret_num ?? ""}
                  placeholder="Fret"
                  onChange={(e) =>
                    onUpdateNoteTab(n.id, n.string_num ?? 1, Number(e.target.value))
                  }
                  className="w-14 h-7 rounded border border-[#27273A] bg-[#09090F] px-2 text-xs font-mono"
                />
              </div>
            </div>
          ))}
          {notes.length === 0 && (
            <p className="text-xs text-[#71717A]">No notes available for tablature mapping.</p>
          )}
        </div>
      </div>
    </div>
  );
}
