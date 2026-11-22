import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cable,
  Circle,
  Disc,
  Maximize2,
  Minimize2,
  Plus,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { MetronomeControl } from "@/features/editor/MetronomeControl";
import {
  loadMetronomeSettings,
  type MetronomeSettings,
  saveMetronomeSettings,
} from "@/features/editor/metronome";
import { midiSynth } from "@/features/editor/midiSynth";
import { PracticeCascade } from "@/features/editor/PracticeCascade";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";
import {
  type RecordedRawNote,
  type SnapGridMode,
  buildQuantizedRecordedNotes,
  getGridStepSec,
  mergeOrReplaceRecordedNotes,
  quantizeSeconds,
  rePitchSelectedNotes,
} from "@/features/editor/midiRecordingUtils";
import { type MidiConnectionStatus, useWebMidi } from "@/features/editor/useWebMidi";
import {
  type PlaybackActivePitch,
  VirtualPianoKeyboard,
} from "@/features/editor/VirtualPianoKeyboard";
import { midiToNoteName } from "@/lib/utils";
import type { ScoreNote, ScoreTrack } from "@/types/api";

interface PianoRollEditorProps {
  notes: ScoreNote[];
  tracks?: ScoreTrack[];
  durationSeconds: number;
  tempoBpm: number;
  timeSignature?: string;
  playheadSec: number;
  selectedNoteId: string | null;
  onSelectNote: (id: string | null) => void;
  onChangeNotes: (notes: ScoreNote[]) => void;
  onPlayheadChange?: (sec: number) => void;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  onStopPlay?: () => void;
  playbackRate?: number;
  onPlaybackRateChange?: (rate: number) => void;
  satbSoloVoice?: string | null;
  satbMutedVoices?: Record<string, boolean>;
  onSatbSoloChange?: (voice: string | null) => void;
  loop?: boolean;
  onToggleLoop?: () => void;
  metronomeSettings?: MetronomeSettings;
  onMetronomeSettingsChange?: (next: MetronomeSettings) => void;
  activeBeat?: number | null;
  onActiveBeatChange?: (beat: number | null) => void;
  musicxml?: string | null;
  showChordSymbols?: boolean;
  onToggleChordSymbols?: (value: boolean) => void;
}

const MIN_PITCH = 36; // C2
const MAX_PITCH = 96; // C7
const ROW_H = 16;

type InputMode = "audition" | "record";
type RecordPhase = "idle" | "count_in" | "recording";

function parseBeatsPerBar(timeSignature?: string): number {
  const raw = (timeSignature || "4/4").split("/")[0];
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

function formatStatusLabel(status: MidiConnectionStatus, deviceName: string | null): string {
  switch (status) {
    case "connected":
      return `Connected: ${deviceName || "MIDI Device"}`;
    case "disconnected":
      return "Device Disconnected";
    case "not_supported":
      return "MIDI Not Supported";
    case "permission_denied":
      return "Permission Denied";
    default:
      return "Not Connected";
  }
}

export function PianoRollEditor({
  notes,
  tracks = [],
  durationSeconds,
  tempoBpm,
  timeSignature = "4/4",
  playheadSec,
  selectedNoteId,
  onSelectNote,
  onChangeNotes,
  onPlayheadChange,
  isPlaying = false,
  onTogglePlay,
  onStopPlay,
  playbackRate = 1.0,
  onPlaybackRateChange,
  satbSoloVoice = null,
  satbMutedVoices = {},
  onSatbSoloChange,
  loop,
  onToggleLoop,
  metronomeSettings: controlledMetronome,
  onMetronomeSettingsChange,
  activeBeat: controlledBeat,
  onActiveBeatChange,
  musicxml = null,
  showChordSymbols = true,
  onToggleChordSymbols,
}: PianoRollEditorProps) {
  const [viewMode, setViewMode] = useState<"grid" | "cascade" | "sheet">("grid");
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [autoSwitchToCascade, setAutoSwitchToCascade] = useState(false);
  const [internalMetronome, setInternalMetronome] = useState<MetronomeSettings>(() =>
    loadMetronomeSettings(),
  );
  const [internalBeat, setInternalBeat] = useState<number | null>(null);
  const metronomeSettings = controlledMetronome ?? internalMetronome;
  const activeBeat = controlledBeat !== undefined ? controlledBeat : internalBeat;
  const setMetronomeSettings = (next: MetronomeSettings) => {
    setInternalMetronome(next);
    saveMetronomeSettings(next);
    onMetronomeSettingsChange?.(next);
  };
  const setActiveBeat = (beat: number | null) => {
    setInternalBeat(beat);
    onActiveBeatChange?.(beat);
  };
  const [pxPerSec, setPxPerSec] = useState(140);
  const [snapMode, setSnapMode] = useState<SnapGridMode>("1/16");
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() =>
    selectedNoteId ? new Set([selectedNoteId]) : new Set(),
  );
  const [dragState, setDragState] = useState<{
    noteId: string;
    mode: "move" | "resize";
    startX: number;
    startY: number;
    origOnset: number;
    origOffset: number;
    origPitch: number;
  } | null>(null);

  // MIDI & Keyboard state
  const [inputMode, setInputMode] = useState<InputMode>("audition");
  const [monitorEnabled, setMonitorEnabled] = useState(true);
  const [metronomeEnabled, setMetronomeEnabled] = useState(true);
  const [countInEnabled, setCountInEnabled] = useState(true);
  const [recordMode, setRecordMode] = useState<"merge" | "replace">("merge");
  const [targetTrackIndex, setTargetTrackIndex] = useState<number>(() => {
    const pianoTrack = tracks.find(
      (t) => t.index > 0 || t.instrument.toLowerCase().includes("piano"),
    );
    return pianoTrack ? pianoTrack.index : 0;
  });
  const [activeMidiPitches, setActiveMidiPitches] = useState<Set<number>>(() => new Set());
  const [recordPhase, setRecordPhase] = useState<RecordPhase>("idle");
  const [recordStatusNote, setRecordStatusNote] = useState<string | null>(null);
  const [recordElapsedSec, setRecordElapsedSec] = useState(0);

  const gridRef = useRef<HTMLDivElement>(null);
  const keyboardBodyRef = useRef<HTMLDivElement>(null);
  const prevPlayingRef = useRef(isPlaying);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const selectedIdsRef = useRef(selectedNoteIds);
  selectedIdsRef.current = selectedNoteIds;
  const inputModeRef = useRef(inputMode);
  inputModeRef.current = inputMode;
  const monitorRef = useRef(monitorEnabled);
  monitorRef.current = monitorEnabled;
  const recordPhaseRef = useRef<RecordPhase>(recordPhase);
  recordPhaseRef.current = recordPhase;

  const recordAnchorPerfMsRef = useRef(0);
  const recordStartSongSecRef = useRef(0);
  const openRecordedNotesRef = useRef<Map<number, { velocity: number; onsetSec: number }>>(
    new Map(),
  );
  const finishedRecordedNotesRef = useRef<RecordedRawNote[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const countInTimersRef = useRef<number[]>([]);
  const lastMetroBeatRef = useRef<number>(-1);

  // Optional auto-switch to Practice Cascade when playback starts
  useEffect(() => {
    if (autoSwitchToCascade && isPlaying && !prevPlayingRef.current) {
      setViewMode("cascade");
    }
    prevPlayingRef.current = isPlaying;
  }, [autoSwitchToCascade, isPlaying]);

  // Focus Mode: Escape key to exit + lock background body scroll while active
  useEffect(() => {
    if (!isFocusMode) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsFocusMode(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isFocusMode]);

  // Keep selectedNoteIds synchronized with external selectedNoteId prop
  useEffect(() => {
    if (!selectedNoteId) {
      setSelectedNoteIds(new Set());
    } else if (!selectedIdsRef.current.has(selectedNoteId)) {
      setSelectedNoteIds(new Set([selectedNoteId]));
    }
  }, [selectedNoteId]);

  // Keep default target track aligned when tracks prop loads
  useEffect(() => {
    if (tracks.length === 0) return;
    if (tracks.some((t) => t.index === targetTrackIndex)) return;
    const pianoTrack = tracks.find(
      (t) => t.index > 0 || t.instrument.toLowerCase().includes("piano"),
    );
    setTargetTrackIndex(pianoTrack ? pianoTrack.index : tracks[0].index);
  }, [tracks, targetTrackIndex]);

  const totalDur = useMemo(() => {
    const maxNote = notes.reduce((m, n) => Math.max(m, n.offset_sec), 0);
    return Math.max(4, durationSeconds, maxNote + 1.5);
  }, [notes, durationSeconds]);

  const totalWidth = Math.max(640, Math.ceil(totalDur * pxPerSec));
  const totalHeight = (MAX_PITCH - MIN_PITCH + 1) * ROW_H;
  const gridStepSec = getGridStepSec(tempoBpm, snapMode);

  const snap = (sec: number) => quantizeSeconds(sec, gridStepSec);

  const selectedNote = notes.find((n) => n.id === selectedNoteId) || null;
  const selectedCount = useMemo(
    () => notes.filter((n) => selectedNoteIds.has(n.id)).length,
    [notes, selectedNoteIds],
  );
  const rePitchArmed = inputMode === "audition" && selectedCount > 0;

  const activePlaybackNotes: PlaybackActivePitch[] = useMemo(() => {
    return notes
      .filter((n) => playheadSec >= n.onset_sec && playheadSec < n.offset_sec)
      .map((n) => ({ pitchMidi: n.pitch_midi, trackIndex: n.track_index }));
  }, [notes, playheadSec]);

  const clearRecordingTimers = useCallback(() => {
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    for (const id of countInTimersRef.current) {
      window.clearTimeout(id);
    }
    countInTimersRef.current = [];
  }, []);

  const stopRecording = useCallback(() => {
    const phase = recordPhaseRef.current;
    if (phase === "idle") return;
    clearRecordingTimers();

    if (phase === "recording") {
      const stopSongSec =
        recordStartSongSecRef.current +
        Math.max(0, (performance.now() - recordAnchorPerfMsRef.current) / 1000);
      // Close any notes still held when recording stops
      for (const [pitchMidi, active] of openRecordedNotesRef.current.entries()) {
        finishedRecordedNotesRef.current.push({
          pitchMidi,
          velocity: active.velocity,
          onsetSec: active.onsetSec,
          offsetSec: Math.max(active.onsetSec + 0.08, stopSongSec),
        });
      }
      openRecordedNotesRef.current.clear();

      const rawCaptured = finishedRecordedNotesRef.current;
      finishedRecordedNotesRef.current = [];
      if (rawCaptured.length > 0) {
        const quantized = buildQuantizedRecordedNotes(rawCaptured, {
          tempoBpm,
          snapMode,
          targetTrackIndex,
        });
        const nextNotes = mergeOrReplaceRecordedNotes(notesRef.current, quantized, {
          mode: recordMode,
          targetTrackIndex,
        });
        onChangeNotes(nextNotes);
        setRecordStatusNote(`Recorded ${quantized.length} note${quantized.length === 1 ? "" : "s"}`);
      } else {
        setRecordStatusNote("No notes captured");
      }
    } else {
      openRecordedNotesRef.current.clear();
      finishedRecordedNotesRef.current = [];
      setRecordStatusNote("Recording cancelled");
    }

    midiSynth.stopAllSustainedNotes();
    setRecordPhase("idle");
    setRecordElapsedSec(0);
  }, [clearRecordingTimers, onChangeNotes, recordMode, snapMode, targetTrackIndex, tempoBpm]);

  const startRecording = useCallback(() => {
    if (recordPhaseRef.current !== "idle") return;
    setRecordStatusNote(null);
    openRecordedNotesRef.current.clear();
    finishedRecordedNotesRef.current = [];
    const startSec = Math.max(0, playheadSec);
    recordStartSongSecRef.current = startSec;

    const beatSec = 60 / Math.max(20, tempoBpm || 120);
    const beatsPerBar = parseBeatsPerBar(timeSignature);

    const beginCapture = () => {
      recordAnchorPerfMsRef.current = performance.now();
      lastMetroBeatRef.current = -1;
      setRecordPhase("recording");
      setRecordElapsedSec(0);

      recordTimerRef.current = window.setInterval(() => {
        const elapsed = Math.max(0, (performance.now() - recordAnchorPerfMsRef.current) / 1000);
        setRecordElapsedSec(elapsed);
        const currentSongSec = recordStartSongSecRef.current + elapsed;
        onPlayheadChange?.(currentSongSec);

        if (metronomeEnabled) {
          const beatIdx = Math.floor(elapsed / beatSec);
          if (beatIdx > lastMetroBeatRef.current) {
            lastMetroBeatRef.current = beatIdx;
            midiSynth.playMetronomeClick(beatIdx % beatsPerBar === 0, 0.55);
          }
        }
      }, 50);
    };

    if (countInEnabled) {
      setRecordPhase("count_in");
      for (let b = 0; b < beatsPerBar; b++) {
        const tid = window.setTimeout(() => {
          if (recordPhaseRef.current === "count_in") {
            midiSynth.playMetronomeClick(b === 0, 0.7);
          }
        }, Math.round(b * beatSec * 1000));
        countInTimersRef.current.push(tid);
      }
      const startTid = window.setTimeout(() => {
        if (recordPhaseRef.current === "count_in") {
          beginCapture();
        }
      }, Math.round(beatsPerBar * beatSec * 1000));
      countInTimersRef.current.push(startTid);
    } else {
      beginCapture();
    }
  }, [countInEnabled, metronomeEnabled, onPlayheadChange, playheadSec, tempoBpm, timeSignature]);

  useEffect(() => {
    return () => {
      clearRecordingTimers();
      midiSynth.stopAllSustainedNotes();
    };
  }, [clearRecordingTimers]);

  const handlePitchNoteOn = useCallback(
    (pitchMidi: number, velocity = 90) => {
      setActiveMidiPitches((prev) => {
        const next = new Set(prev);
        next.add(pitchMidi);
        return next;
      });

      if (monitorRef.current) {
        midiSynth.startSustainedNote(pitchMidi, velocity, 0.7);
      }

      if (inputModeRef.current === "record") {
        if (recordPhaseRef.current === "recording") {
          // Prevent duplicate note-on for an already-held pitch
          if (!openRecordedNotesRef.current.has(pitchMidi)) {
            const elapsed = Math.max(0, (performance.now() - recordAnchorPerfMsRef.current) / 1000);
            openRecordedNotesRef.current.set(pitchMidi, {
              velocity,
              onsetSec: recordStartSongSecRef.current + elapsed,
            });
          }
        }
        return;
      }

      // Audition / Re-pitch Mode
      if (selectedIdsRef.current.size > 0) {
        const updated = rePitchSelectedNotes(
          notesRef.current,
          selectedIdsRef.current,
          pitchMidi,
        );
        if (updated !== notesRef.current) {
          onChangeNotes(updated);
        }
      }
    },
    [onChangeNotes],
  );

  const handlePitchNoteOff = useCallback((pitchMidi: number) => {
    setActiveMidiPitches((prev) => {
      if (!prev.has(pitchMidi)) return prev;
      const next = new Set(prev);
      next.delete(pitchMidi);
      return next;
    });

    midiSynth.stopSustainedNote(pitchMidi);

    if (inputModeRef.current === "record" && recordPhaseRef.current === "recording") {
      const active = openRecordedNotesRef.current.get(pitchMidi);
      if (active) {
        openRecordedNotesRef.current.delete(pitchMidi);
        const elapsed = Math.max(0, (performance.now() - recordAnchorPerfMsRef.current) / 1000);
        const offsetSec = Math.max(active.onsetSec + 0.06, recordStartSongSecRef.current + elapsed);
        finishedRecordedNotesRef.current.push({
          pitchMidi,
          velocity: active.velocity,
          onsetSec: active.onsetSec,
          offsetSec,
        });
      }
    }
  }, []);

  const webMidi = useWebMidi({
    onNoteOn: handlePitchNoteOn,
    onNoteOff: handlePitchNoteOff,
  });

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
      }),
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
      offset_sec: Number((onset + Math.max(0.2, (gridStepSec || 0.125) * 2)).toFixed(3)),
      velocity: 85,
      track_index: targetTrackIndex,
    };
    midiSynth.triggerNote(pitch, 0.25, 85);
    onSelectNote(newNote.id);
    setSelectedNoteIds(new Set([newNote.id]));
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
      track_index: targetTrackIndex,
    };
    midiSynth.triggerNote(60, 0.25, 90);
    onSelectNote(newNote.id);
    setSelectedNoteIds(new Set([newNote.id]));
    onChangeNotes([...notes, newNote]);
  };

  const deleteSelected = () => {
    if (selectedNoteIds.size === 0 && !selectedNoteId) return;
    const idsToDelete =
      selectedNoteIds.size > 0 ? selectedNoteIds : new Set(selectedNoteId ? [selectedNoteId] : []);
    onChangeNotes(notes.filter((n) => !idsToDelete.has(n.id)));
    setSelectedNoteIds(new Set());
    onSelectNote(null);
  };

  const pitchRows = useMemo(() => {
    const rows: number[] = [];
    for (let p = MAX_PITCH; p >= MIN_PITCH; p--) rows.push(p);
    return rows;
  }, []);

  const formatRecTime = (sec: number) => {
    const clamped = Math.max(0, Math.floor(sec));
    const m = Math.floor(clamped / 60);
    const s = clamped % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const statusText = formatStatusLabel(webMidi.status, webMidi.selectedDeviceName);

  return (
    <div
      data-testid="piano-roll-workspace"
      data-focus-mode={isFocusMode ? "true" : "false"}
      className={
        isFocusMode
          ? "fixed inset-0 z-50 flex flex-col gap-3 bg-[#09090F] p-3 sm:p-4 w-screen h-screen overflow-hidden"
          : "space-y-3 w-full min-w-0 max-w-full overflow-hidden"
      }
    >
      {/* Main Piano Roll Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          {/* Segmented View Selector */}
          <div
            role="group"
            aria-label="Piano Roll View Mode"
            className="inline-flex rounded-lg border border-[#27273A] bg-[#09090F] p-0.5"
          >
            <button
              type="button"
              aria-pressed={viewMode === "grid"}
              onClick={() => setViewMode("grid")}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                viewMode === "grid"
                  ? "bg-[#8B5CF6] text-[#F5F3FF]"
                  : "text-[#A1A1AA] hover:text-[#F5F3FF]"
              }`}
            >
              Grid Editor
            </button>
            <button
              type="button"
              aria-pressed={viewMode === "cascade"}
              onClick={() => setViewMode("cascade")}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                viewMode === "cascade"
                  ? "bg-[#8B5CF6] text-[#F5F3FF]"
                  : "text-[#A1A1AA] hover:text-[#F5F3FF]"
              }`}
            >
              Practice Cascade
            </button>
            <button
              type="button"
              aria-pressed={viewMode === "sheet"}
              onClick={() => setViewMode("sheet")}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                viewMode === "sheet"
                  ? "bg-[#8B5CF6] text-[#F5F3FF]"
                  : "text-[#A1A1AA] hover:text-[#F5F3FF]"
              }`}
            >
              Sheet Music
            </button>
          </div>

          <label className="inline-flex items-center gap-1.5 text-[11px] text-[#A1A1AA] cursor-pointer">
            <input
              type="checkbox"
              checked={autoSwitchToCascade}
              onChange={(e) => setAutoSwitchToCascade(e.target.checked)}
              className="accent-[#8B5CF6]"
            />
            Auto-switch to Practice Cascade on Play
          </label>

          {viewMode === "grid" && (
            <>
              <Button size="sm" variant="secondary" onClick={addNoteAtPlayhead}>
                <Plus className="h-3.5 w-3.5" />
                Add Note
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={selectedCount === 0}
                onClick={deleteSelected}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
              <label className="inline-flex items-center gap-1.5 text-xs text-[#A1A1AA] ml-1">
                <span>Snap:</span>
                <select
                  aria-label="Snap quantization"
                  value={snapMode}
                  onChange={(e) => setSnapMode(e.target.value as SnapGridMode)}
                  className="rounded border border-[#27273A] bg-[#181825] px-1.5 py-0.5 text-xs text-[#F5F3FF]"
                >
                  <option value="1/16">1/16</option>
                  <option value="1/8">1/8</option>
                  <option value="off">Off</option>
                </select>
              </label>
            </>
          )}
        </div>

        {selectedNote && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[#27273A] bg-[#181825] px-3 py-1 text-xs">
            <span className="font-mono text-[#A78BFA]">
              {midiToNoteName(selectedNote.pitch_midi)}
              {selectedCount > 1 ? ` (+${selectedCount - 1})` : ""}
            </span>
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
                      n.id === selectedNote.id ? { ...n, velocity: Number(e.target.value) } : n,
                    ),
                  )
                }
                className="w-20 accent-[#A78BFA]"
              />
              <span className="font-mono w-6">{selectedNote.velocity}</span>
            </label>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          {isFocusMode && (
            <MetronomeControl
              settings={metronomeSettings}
              onChangeSettings={setMetronomeSettings}
              scoreTimeSignature={timeSignature}
              tempoBpm={tempoBpm * playbackRate}
              activeBeat={activeBeat}
              isPlaybackActive={isPlaying}
              onBeatChange={setActiveBeat}
            />
          )}
          {viewMode === "grid" && (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setPxPerSec((p) => Math.max(60, p - 30))}
                aria-label="Zoom out piano roll"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setPxPerSec((p) => Math.min(320, p + 30))}
                aria-label="Zoom in piano roll"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant={isFocusMode ? "primary" : "secondary"}
            onClick={() => setIsFocusMode((v) => !v)}
            title={isFocusMode ? "Exit Focus" : "Maximize"}
            aria-label={isFocusMode ? "Exit Focus" : "Maximize"}
          >
            {isFocusMode ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            {isFocusMode && <span>Exit Focus</span>}
          </Button>
        </div>
      </div>

      {viewMode === "grid" ? (
        /* Piano Roll Grid Canvas */
        <div
          className={`relative flex w-full max-w-full overflow-auto rounded-xl border border-[#27273A] bg-[#09090F] select-none touch-pan-x touch-pan-y ${
            isFocusMode ? "flex-1 min-h-0" : "max-h-[340px]"
          }`}
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
          onClick={() => {
            setSelectedNoteIds(new Set());
            onSelectNote(null);
          }}
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
            const selected = selectedNoteIds.has(n.id) || n.id === selectedNoteId;
            const isAccomp = n.track_index > 0;
            return (
              <div
                key={n.id}
                style={{ top, left, width, height: ROW_H - 2 }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  if (e.shiftKey || e.ctrlKey || e.metaKey) {
                    setSelectedNoteIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(n.id)) next.delete(n.id);
                      else next.add(n.id);
                      return next;
                    });
                    onSelectNote(n.id);
                  } else {
                    setSelectedNoteIds(new Set([n.id]));
                    onSelectNote(n.id);
                  }
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
                    : isAccomp
                      ? "bg-sky-500/80 border-sky-300/60 text-[#F5F3FF] hover:bg-sky-400"
                      : "bg-[#8B5CF6]/85 border-[#A78BFA]/60 text-[#F5F3FF] hover:bg-[#A78BFA]"
                }`}
              >
                <span className="truncate pointer-events-none">
                  {width > 26 ? midiToNoteName(n.pitch_midi) : ""}
                </span>
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setSelectedNoteIds(new Set([n.id]));
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
      ) : viewMode === "cascade" ? (
        <PracticeCascade
          notes={notes}
          tracks={tracks}
          durationSeconds={durationSeconds}
          tempoBpm={tempoBpm}
          timeSignature={timeSignature}
          playheadSec={playheadSec}
          isPlaying={isPlaying}
          activeMidiPitches={activeMidiPitches}
          minPitch={21}
          maxPitch={108}
          keyboardBodyRef={keyboardBodyRef}
          satbSoloVoice={satbSoloVoice}
          satbMutedVoices={satbMutedVoices}
          onSatbSoloChange={onSatbSoloChange}
          onTogglePlay={onTogglePlay}
          onStop={onStopPlay}
          onPlayheadChange={onPlayheadChange}
          playbackRate={playbackRate}
          onPlaybackRateChange={onPlaybackRateChange}
          isFocusMode={isFocusMode}
          loop={loop}
          onToggleLoop={onToggleLoop}
        />
      ) : (
        <SheetMusicViewer
          musicxml={musicxml}
          showChordSymbols={showChordSymbols}
          onToggleChordSymbols={onToggleChordSymbols}
          playheadSec={playheadSec}
          isPlaying={isPlaying}
          tempoBpm={tempoBpm * playbackRate}
          tracks={tracks}
          satbSoloVoice={satbSoloVoice}
          satbMutedVoices={satbMutedVoices}
          onTogglePlay={onTogglePlay}
          onStopPlay={onStopPlay}
          onSeek={onPlayheadChange}
          isFocusMode={isFocusMode}
        />
      )}

      {/* Integrated MIDI & Virtual Keyboard Toolbar */}
      <div className="rounded-xl border border-[#27273A] bg-[#11111B] p-2.5 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          {/* Left: MIDI Connection & Device Selector */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={webMidi.status === "connected" ? "secondary" : "outline"}
              onClick={webMidi.status === "connected" ? webMidi.disconnect : webMidi.connect}
            >
              <Cable className="h-3.5 w-3.5" />
              {webMidi.status === "connected" ? "Disconnect MIDI" : "Connect MIDI Device"}
            </Button>

            <span
              data-testid="midi-connection-status"
              className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                webMidi.status === "connected"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : webMidi.status === "permission_denied" || webMidi.status === "not_supported"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                    : "border-[#27273A] bg-[#181825] text-[#A1A1AA]"
              }`}
            >
              {statusText}
            </span>

            {webMidi.devices.length > 1 && (
              <select
                aria-label="MIDI Input Device"
                value={webMidi.selectedDeviceId}
                onChange={(e) => webMidi.setSelectedDeviceId(e.target.value)}
                className="rounded border border-[#27273A] bg-[#181825] px-2 py-1 text-xs text-[#F5F3FF]"
              >
                {webMidi.devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Right: Input Mode, Monitor, Metronome, Recording */}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="inline-flex rounded-lg border border-[#27273A] bg-[#09090F] p-0.5">
              <button
                type="button"
                onClick={() => setInputMode("audition")}
                className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                  inputMode === "audition"
                    ? "bg-[#8B5CF6] text-[#F5F3FF]"
                    : "text-[#A1A1AA] hover:text-[#F5F3FF]"
                }`}
              >
                Audition / Re-pitch
              </button>
              <button
                type="button"
                onClick={() => setInputMode("record")}
                className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                  inputMode === "record"
                    ? "bg-rose-600 text-white"
                    : "text-[#A1A1AA] hover:text-[#F5F3FF]"
                }`}
              >
                Record MIDI
              </button>
            </div>

            <button
              type="button"
              onClick={() => setMonitorEnabled((v) => !v)}
              aria-pressed={monitorEnabled}
              title="Toggle local MIDI audio monitoring"
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${
                monitorEnabled
                  ? "border-[#8B5CF6]/50 bg-[#8B5CF6]/15 text-[#E4E4E7]"
                  : "border-[#27273A] bg-[#181825] text-[#71717A]"
              }`}
            >
              {monitorEnabled ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
              Monitor
            </button>

            {inputMode === "record" && (
              <>
                <button
                  type="button"
                  onClick={() => setMetronomeEnabled((v) => !v)}
                  aria-pressed={metronomeEnabled}
                  className={`rounded-md border px-2 py-1 text-[11px] ${
                    metronomeEnabled
                      ? "border-[#8B5CF6]/50 bg-[#8B5CF6]/15 text-[#E4E4E7]"
                      : "border-[#27273A] bg-[#181825] text-[#71717A]"
                  }`}
                >
                  Metronome
                </button>
                <label className="inline-flex items-center gap-1 text-[11px] text-[#A1A1AA] px-1">
                  <input
                    type="checkbox"
                    checked={countInEnabled}
                    onChange={(e) => setCountInEnabled(e.target.checked)}
                    className="accent-[#A78BFA]"
                  />
                  Count-in
                </label>

                {tracks.length > 1 && (
                  <select
                    aria-label="Target Recording Part"
                    value={targetTrackIndex}
                    onChange={(e) => setTargetTrackIndex(Number(e.target.value))}
                    className="rounded border border-[#27273A] bg-[#181825] px-1.5 py-1 text-[11px] text-[#F5F3FF]"
                  >
                    {tracks.map((t) => (
                      <option key={t.index} value={t.index}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}

                <select
                  aria-label="Recording Mode"
                  value={recordMode}
                  onChange={(e) => setRecordMode(e.target.value as "merge" | "replace")}
                  className="rounded border border-[#27273A] bg-[#181825] px-1.5 py-1 text-[11px] text-[#F5F3FF]"
                >
                  <option value="merge">Merge</option>
                  <option value="replace">Replace Part</option>
                </select>

                {recordPhase === "idle" ? (
                  <Button size="sm" variant="primary" onClick={startRecording}>
                    <Circle className="h-3 w-3 fill-rose-400 text-rose-400" />
                    Record
                  </Button>
                ) : (
                  <Button size="sm" variant="danger" onClick={stopRecording}>
                    <Square className="h-3 w-3 fill-current" />
                    Stop
                  </Button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Contextual Feedback Row */}
        {(rePitchArmed || recordPhase !== "idle" || recordStatusNote || webMidi.errorMessage) && (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {rePitchArmed && (
              <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-200">
                Re-pitch armed ({selectedCount} selected): press any key to{" "}
                {selectedCount > 1 ? "transpose preserving intervals" : "update pitch"}
              </span>
            )}
            {recordPhase === "count_in" && (
              <span className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-200">
                <Disc className="h-3 w-3 animate-pulse" />
                Count-in...
              </span>
            )}
            {recordPhase === "recording" && (
              <span className="inline-flex items-center gap-1 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-rose-200 font-mono">
                <Disc className="h-3 w-3 animate-pulse" />
                REC {formatRecTime(recordElapsedSec)}
              </span>
            )}
            {recordPhase === "idle" && recordStatusNote && (
              <span className="text-emerald-300">{recordStatusNote}</span>
            )}
            {webMidi.errorMessage && (
              <span className="text-amber-300">{webMidi.errorMessage}</span>
            )}
          </div>
        )}

        {/* Synthesia-Style Virtual Piano Keyboard */}
        <VirtualPianoKeyboard
          minPitch={21}
          maxPitch={108}
          activePlaybackNotes={activePlaybackNotes}
          activeMidiPitches={activeMidiPitches}
          rePitchArmed={rePitchArmed}
          isFocusMode={isFocusMode}
          keyboardBodyRef={keyboardBodyRef}
          onKeyDown={handlePitchNoteOn}
          onKeyUp={handlePitchNoteOff}
        />
      </div>

      <p className="text-[11px] text-[#71717A]">
        Tip: Double-click anywhere on the grid to add a note, Shift/Ctrl-click to multi-select, or use the virtual/MIDI keyboard to audition, re-pitch selected notes, or record.
      </p>
    </div>
  );
}
