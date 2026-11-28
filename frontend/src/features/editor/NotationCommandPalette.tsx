import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  FlipVertical2,
  HelpCircle,
  MessageSquareText,
  Music2,
  Pencil,
  Plus,
  Redo2,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  MeasureMeterControl,
  type MeasureMeterChangePayload,
  type PendingOverflowWarning,
} from "@/features/editor/MeasureMeterControl";
import {
  type EditableNoteType,
  type XmlAccidentalType,
  type XmlArticulationType,
  type XmlNoteInfo,
  type XmlNoteTarget,
} from "@/features/editor/musicXmlEditor";
import { type MeasureStructureInfo, type NavigationMarkerType } from "@/features/editor/musicXmlStructure";
import { RepeatPaletteControl } from "@/features/editor/RepeatPaletteControl";
import { midiToNoteName } from "@/lib/utils";

const DURATION_PALETTE_ITEMS: Array<{
  type: EditableNoteType;
  label: string;
  glyph: string;
  shortcut: string;
}> = [
  { type: "64th", label: "64th", glyph: "1/64", shortcut: "1" },
  { type: "32nd", label: "32nd", glyph: "1/32", shortcut: "2" },
  { type: "16th", label: "16th", glyph: "♬", shortcut: "3" },
  { type: "eighth", label: "Eighth", glyph: "♪", shortcut: "4" },
  { type: "quarter", label: "Quarter", glyph: "♩", shortcut: "5" },
  { type: "half", label: "Half", glyph: "𝅗𝅥", shortcut: "6" },
  { type: "whole", label: "Whole", glyph: "𝅝", shortcut: "7" },
  { type: "breve", label: "Breve", glyph: "𝅜", shortcut: "8" },
  { type: "long", label: "Longa", glyph: "𝅛", shortcut: "9" },
];

const ACCIDENTAL_ITEMS: Array<{
  acc: XmlAccidentalType;
  symbol: string;
  label: string;
}> = [
  { acc: "flat-flat", symbol: "𝄫", label: "Set accidental flat-flat" },
  { acc: "flat", symbol: "♭", label: "Set accidental flat" },
  { acc: "natural", symbol: "♮", label: "Set accidental natural" },
  { acc: "sharp", symbol: "♯", label: "Set accidental sharp" },
  { acc: "double-sharp", symbol: "𝄪", label: "Set accidental double-sharp" },
];

const ARTICULATION_ITEMS: Array<{
  id: XmlArticulationType;
  symbol: string;
  label: string;
  title: string;
}> = [
  { id: "marcato", symbol: "^", label: "Marcato articulation", title: "Marcato (^)" },
  { id: "accent", symbol: ">", label: "Accent articulation", title: "Accent (>)" },
  { id: "tenuto", symbol: "–", label: "Tenuto articulation", title: "Tenuto (-)" },
  { id: "staccato", symbol: "•", label: "Staccato articulation", title: "Staccato (.) — articulation, separate from augmentation dot" },
];

interface NotationCommandPaletteProps {
  isPlaying: boolean;
  noteInputMode: boolean;
  onToggleNoteInputMode: () => void;
  restInputMode?: boolean;
  activeTupletActual?: number | null;
  activeDuration: EditableNoteType;
  activeDotted: boolean;
  activeVoice: "1" | "2";
  keyFifths?: number;
  selectedTarget: XmlNoteTarget | null;
  selectedMeasureNumber?: number | null;
  noteInfo: XmlNoteInfo | null;
  statusMessage?: string | null;
  hideInlineMetaControls?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onSelectDuration: (dur: EditableNoteType) => void;
  onToggleDot: () => void;
  onToggleRest: () => void;
  onSelectAccidental: (acc: XmlAccidentalType) => void;
  onToggleTie: () => void;
  onToggleSlur: () => void;
  onToggleArticulation: (art: XmlArticulationType) => void;
  onToggleTriplet: () => void;
  onFlipStem: () => void;
  onSelectVoice: (voice: "1" | "2") => void;
  onTranspose: (semitones: number) => void;
  onAddMeasure: () => void;
  onDeleteMeasure: () => void;
  activeMeasureInfo?: MeasureStructureInfo | null;
  pendingOverflow?: PendingOverflowWarning | null;
  onDismissOverflow?: () => void;
  onApplyMeasureMeter?: (payload: MeasureMeterChangePayload) => void;
  onToggleRepeatBarline?: (measureNumber: number, kind: "forward" | "backward" | "both", repeatCount: number) => void;
  onSetRepeatCount?: (measureNumber: number, repeatCount: number) => void;
  onSetVoltaEnding?: (measureNumber: number, action: "start_1" | "start_2" | "end_ending" | "clear_ending") => void;
  onToggleNavigationMarker?: (measureNumber: number, marker: NavigationMarkerType) => void;
  onOpenChordEditor?: () => void;
  onOpenLyricEditor?: () => void;
  isChordEditorOpen?: boolean;
  isLyricEditorOpen?: boolean;
}

export function formatNotationSelectionReadout(params: {
  selectedTarget: XmlNoteTarget | null;
  selectedMeasureNumber?: number | null;
  currentDuration: EditableNoteType;
  currentDotted: boolean;
  keyFifths?: number;
}): string {
  const { selectedTarget, selectedMeasureNumber = null, currentDuration, currentDotted, keyFifths = 0 } = params;
  const durLabel =
    currentDuration === "16th" || currentDuration === "32nd" || currentDuration === "64th"
      ? currentDuration
      : currentDuration.charAt(0).toUpperCase() + currentDuration.slice(1);
  if (selectedTarget) {
    return `Selected: ${selectedTarget.pitchMidi !== null ? midiToNoteName(selectedTarget.pitchMidi, keyFifths) : "Rest"} (${durLabel}${currentDotted ? "." : ""}) • ${selectedTarget.measureNumber === 0 ? "Pickup (m.0)" : `m.${selectedTarget.measureNumber}`}`;
  }
  if (selectedMeasureNumber !== null && selectedMeasureNumber !== undefined) {
    return `Selected: ${selectedMeasureNumber === 0 ? "Measure 0 (Pickup)" : `Measure ${selectedMeasureNumber}`} (Press Delete/Backspace to remove)`;
  }
  return "Click a notehead to edit";
}

export function NotationShortcutsReference({
  activeTupletActual = null,
}: {
  activeTupletActual?: number | null;
}) {
  return (
    <div
      data-testid="notation-shortcuts-popover"
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 rounded-lg border border-stone-300 bg-white p-3 text-[11px] text-stone-700 dark:border-[#27273A] dark:bg-[#0D0D16] dark:text-[#C4C4D4]"
    >
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500 dark:text-[#A1A1AA]">
          Note Durations (1–9)
        </div>
        <div><kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">1</kbd> 64th &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">2</kbd> 32nd &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">3</kbd> 16th</div>
        <div><kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">4</kbd> Eighth &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">5</kbd> Quarter &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">6</kbd> Half</div>
        <div><kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">7</kbd> Whole &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">8</kbd> Breve &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">9</kbd> Longa</div>
      </div>

      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500 dark:text-[#A1A1AA]">
          Rest, Dot, Tie &amp; Scaling
        </div>
        <div><kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">0</kbd> Rest Mode / Convert Note to Rest</div>
        <div><kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">.</kbd> Toggle Augmentation Dot</div>
        <div><kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">T</kbd> / <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">+</kbd> Tie Same Pitch / Add Tied Continuation</div>
        <div><kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">W</kbd> Double Duration &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">Q</kbd> Halve Duration</div>
      </div>

      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500 dark:text-[#A1A1AA]">
          Tuplets &amp; Editor Modes
        </div>
        <div><kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">Ctrl/Cmd+3</kbd> Triplet (3:2) &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">Ctrl/Cmd+2..9</kbd> Tuplets</div>
        <div><kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">N</kbd> Note Input &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">A–G</kbd> Pitch &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">Shift+A–G</kbd> Chord Tone</div>
        <div><kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">Del</kbd> / <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">Backspace</kbd> Delete Note or Measure &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">Esc</kbd> Exit</div>
        <div><kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">S</kbd> Slur &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">X</kbd> Stem &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">↑/↓</kbd> Pitch &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">Ctrl/Cmd+↑/↓</kbd> Octave &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">Ctrl+Z/Y</kbd> Undo/Redo</div>
        <div><kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">Ctrl/Cmd+K</kbd> Chord Symbol &nbsp; <kbd className="rounded bg-stone-200 px-1 dark:bg-white/10">Ctrl/Cmd+L</kbd> Lyrics (<kbd>-</kbd> Syl, <kbd>Space</kbd> Word, <kbd>_</kbd> Melisma)</div>
        {activeTupletActual && (
          <div className="text-violet-700 dark:text-violet-300 font-medium">
            Active Tuplet Input: {activeTupletActual}-tuplet
          </div>
        )}
      </div>
    </div>
  );
}

export function NotationCommandPalette({
  isPlaying,
  noteInputMode,
  onToggleNoteInputMode,
  restInputMode = false,
  activeTupletActual = null,
  activeDuration,
  activeDotted,
  activeVoice,
  keyFifths = 0,
  selectedTarget,
  selectedMeasureNumber = null,
  noteInfo,
  statusMessage,
  hideInlineMetaControls = false,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onSelectDuration,
  onToggleDot,
  onToggleRest,
  onSelectAccidental,
  onToggleTie,
  onToggleSlur,
  onToggleArticulation,
  onToggleTriplet,
  onFlipStem,
  onSelectVoice,
  onTranspose,
  onAddMeasure,
  onDeleteMeasure,
  activeMeasureInfo = null,
  pendingOverflow = null,
  onDismissOverflow,
  onApplyMeasureMeter,
  onToggleRepeatBarline,
  onSetRepeatCount,
  onSetVoltaEnding,
  onToggleNavigationMarker,
  onOpenChordEditor,
  onOpenLyricEditor,
  isChordEditorOpen = false,
  isLyricEditorOpen = false,
}: NotationCommandPaletteProps) {
  const [showShortcuts, setShowShortcuts] = useState(false);

  const hasSelection = Boolean(selectedTarget);
  const currentDuration = noteInfo?.durationType ?? activeDuration;
  const currentDotted = noteInfo ? noteInfo.dotted : activeDotted;
  const currentVoice = noteInfo?.voice === "2" ? "2" : noteInfo ? "1" : activeVoice;

  const btnClass = (isActive: boolean, isDisabled: boolean) =>
    `inline-flex items-center justify-center gap-1 h-7 min-w-[28px] rounded-md border px-2 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500/40 ${
      isDisabled
        ? "bg-stone-100 text-stone-500 border-stone-200 cursor-not-allowed dark:bg-white/5 dark:text-slate-500 dark:border-white/10"
        : isActive
          ? "bg-violet-600 text-white border-violet-700 font-semibold shadow-xs dark:bg-violet-500 dark:text-white dark:border-violet-400"
          : "bg-white hover:bg-stone-100 text-stone-800 border-stone-300 font-medium dark:bg-[#11111B] dark:hover:bg-white/10 dark:text-slate-200 dark:border-[#27273A]"
    }`;

  const groupSep = "flex flex-wrap items-center gap-1 border-l border-amber-300/70 pl-2 dark:border-[#27273A]";

  const selectionText = formatNotationSelectionReadout({
    selectedTarget,
    selectedMeasureNumber,
    currentDuration,
    currentDotted,
    keyFifths,
  });

  if (isPlaying) {
    return (
      <div
        data-testid="notation-edit-toolbar"
        className="flex items-center justify-between gap-2 rounded-lg bg-amber-50/90 border border-amber-300 px-3 py-2 text-xs shrink-0 dark:bg-amber-500/10 dark:border-amber-500/25"
      >
        <span className="text-amber-950 font-medium dark:text-amber-300">
          Pause playback before editing notation.
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="notation-edit-toolbar"
      className="space-y-2 rounded-xl bg-amber-50/90 border border-amber-300 px-3 py-2.5 text-xs shrink-0 dark:bg-amber-500/10 dark:border-amber-500/25"
    >
      {/* Row 1: Note Input, Durations, Dot/Rest, Accidentals */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="Note input mode"
          aria-pressed={noteInputMode}
          title="Note Input Mode (N)"
          data-testid="palette-note-input-btn"
          onClick={onToggleNoteInputMode}
          className={btnClass(noteInputMode, false)}
        >
          <Pencil className="h-3 w-3" />
          <span>Note Input</span>
          <kbd className="ml-0.5 rounded bg-black/15 px-1 text-[10px]">N</kbd>
        </button>

        <div className={groupSep} role="group" aria-label="Note durations">
          {DURATION_PALETTE_ITEMS.map((item) => (
            <button
              key={item.type}
              type="button"
              aria-label={`Set duration ${item.type}`}
              aria-pressed={currentDuration === item.type}
              title={`${item.label} note (Shortcut: ${item.shortcut})`}
              className={btnClass(currentDuration === item.type, false)}
              onClick={() => onSelectDuration(item.type)}
            >
              <span className="text-sm leading-none">{item.glyph}</span>
              <span className="hidden xl:inline">{item.label}</span>
              <span className="text-[10px] opacity-65">{item.shortcut}</span>
            </button>
          ))}
        </div>

        <div className={groupSep} role="group" aria-label="Augmentation dot and rest">
          <button
            type="button"
            aria-label="Toggle augmentation dot"
            aria-pressed={currentDotted}
            title="Augmentation Dot (.) — extends duration by 1.5×"
            data-testid="palette-dot-btn"
            className={btnClass(currentDotted, false)}
            onClick={onToggleDot}
          >
            <span className="font-bold">d.</span>
            <span className="hidden sm:inline">Dot</span>
          </button>
          <button
            type="button"
            disabled={!hasSelection && !noteInputMode}
            aria-label="Convert note to rest"
            title="Rest mode in Note Input, or convert note to rest (0)"
            data-testid="palette-rest-btn"
            className={btnClass(Boolean(noteInfo?.isRest || ((!hasSelection || noteInfo?.isRest) && restInputMode)), !hasSelection && !noteInputMode)}
            onClick={onToggleRest}
          >
            <span>Rest</span>
            <kbd className="rounded bg-black/10 px-1 text-[10px]">0</kbd>
          </button>
        </div>

        <div className={groupSep} role="group" aria-label="Accidentals">
          {ACCIDENTAL_ITEMS.map((item) => (
            <button
              key={item.acc}
              type="button"
              disabled={!hasSelection}
              aria-label={item.label}
              aria-pressed={noteInfo?.accidental === item.acc}
              title={item.label}
              className={btnClass(noteInfo?.accidental === item.acc, !hasSelection)}
              onClick={() => onSelectAccidental(item.acc)}
            >
              <span className="text-sm leading-none">{item.symbol}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Row 2: Ties/Slurs, Articulations, Tuplet/Stem/Voice, Pitch & Measures, Undo/Redo & Shortcuts */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-amber-300/60 dark:border-[#27273A]">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1" role="group" aria-label="Ties and slurs">
            <button
              type="button"
              disabled={!hasSelection}
              aria-label="Toggle tie"
              aria-pressed={Boolean(noteInfo?.hasTieStart)}
              title="Tie consecutive identical pitch (T)"
              data-testid="palette-tie-btn"
              className={btnClass(Boolean(noteInfo?.hasTieStart), !hasSelection)}
              onClick={onToggleTie}
            >
              <span>⌒ Tie</span>
              <kbd className="rounded bg-black/10 px-1 text-[10px]">T</kbd>
            </button>
            <button
              type="button"
              disabled={!hasSelection}
              aria-label="Toggle slur"
              aria-pressed={Boolean(noteInfo?.hasSlurStart)}
              title="Slur phrase phrasing toggle (S)"
              data-testid="palette-slur-btn"
              className={btnClass(Boolean(noteInfo?.hasSlurStart), !hasSelection)}
              onClick={onToggleSlur}
            >
              <span>⌢ Slur</span>
              <kbd className="rounded bg-black/10 px-1 text-[10px]">S</kbd>
            </button>
          </div>

          <div className={groupSep} role="group" aria-label="Articulations">
            <span className="text-[10px] uppercase tracking-wider text-stone-500 dark:text-[#A1A1AA] mr-0.5">
              Artic:
            </span>
            {ARTICULATION_ITEMS.map((item) => {
              const active = Boolean(noteInfo?.articulations.includes(item.id));
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={!hasSelection}
                  aria-label={item.label}
                  aria-pressed={active}
                  title={item.title}
                  data-testid={`palette-art-${item.id}`}
                  className={btnClass(active, !hasSelection)}
                  onClick={() => onToggleArticulation(item.id)}
                >
                  <span className="font-bold">{item.symbol}</span>
                </button>
              );
            })}
          </div>

          <div className={groupSep} role="group" aria-label="Tuplet stem and voices">
            <button
              type="button"
              disabled={!hasSelection}
              aria-label="Toggle triplet"
              aria-pressed={Boolean(noteInfo?.isTriplet)}
              title="Triplet 3:2 (Ctrl+3)"
              data-testid="palette-triplet-btn"
              className={btnClass(Boolean(noteInfo?.isTriplet), !hasSelection)}
              onClick={onToggleTriplet}
            >
              3:2 Triplet
            </button>
            <button
              type="button"
              disabled={!hasSelection}
              aria-label="Flip stem"
              aria-pressed={noteInfo?.stem === "up"}
              title="Flip Stem Direction (X)"
              data-testid="palette-flip-stem-btn"
              className={btnClass(false, !hasSelection)}
              onClick={onFlipStem}
            >
              <FlipVertical2 className="h-3 w-3" />
              <span>Stem</span>
              <kbd className="rounded bg-black/10 px-1 text-[10px]">X</kbd>
            </button>
            <button
              type="button"
              aria-label="Voice 1"
              aria-pressed={currentVoice === "1"}
              title="Assign / edit Voice 1"
              data-testid="palette-voice-1-btn"
              className={btnClass(currentVoice === "1", false)}
              onClick={() => onSelectVoice("1")}
            >
              V1
            </button>
            <button
              type="button"
              aria-label="Voice 2"
              aria-pressed={currentVoice === "2"}
              title="Assign / edit Voice 2"
              data-testid="palette-voice-2-btn"
              className={btnClass(currentVoice === "2", false)}
              onClick={() => onSelectVoice("2")}
            >
              V2
            </button>
          </div>

          <div className={groupSep} role="group" aria-label="Pitch and measures">
            <button
              type="button"
              disabled={!hasSelection}
              aria-label="Pitch up"
              title="Transpose up 1 semitone (ArrowUp)"
              className={btnClass(false, !hasSelection)}
              onClick={() => onTranspose(1)}
            >
              <ArrowUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              disabled={!hasSelection}
              aria-label="Pitch down"
              title="Transpose down 1 semitone (ArrowDown)"
              className={btnClass(false, !hasSelection)}
              onClick={() => onTranspose(-1)}
            >
              <ArrowDown className="h-3 w-3" />
            </button>
            <button
              type="button"
              disabled={!hasSelection}
              aria-label="Octave up"
              title="Transpose up 1 octave (Ctrl/Cmd+ArrowUp or Shift+ArrowUp)"
              className={btnClass(false, !hasSelection)}
              onClick={() => onTranspose(12)}
            >
              +8va
            </button>
            <button
              type="button"
              disabled={!hasSelection}
              aria-label="Octave down"
              title="Transpose down 1 octave (Ctrl/Cmd+ArrowDown or Shift+ArrowDown)"
              className={btnClass(false, !hasSelection)}
              onClick={() => onTranspose(-12)}
            >
              -8va
            </button>
            <button
              type="button"
              aria-label="Add measure"
              title="Insert empty measure"
              className={btnClass(false, false)}
              onClick={onAddMeasure}
            >
              <Plus className="h-3 w-3" /> Bar
            </button>
            <button
              type="button"
              disabled={!hasSelection && selectedMeasureNumber === null}
              aria-label="Delete measure"
              title="Delete selected measure (Delete / Backspace)"
              className={`inline-flex items-center justify-center gap-1 h-7 rounded-md border px-2 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/40 ${
                !hasSelection && selectedMeasureNumber === null
                  ? "bg-stone-100 text-stone-400 border-stone-200 cursor-not-allowed dark:bg-white/5 dark:text-slate-600 dark:border-white/10"
                  : "bg-white hover:bg-red-50 text-red-800 border-red-300 font-medium dark:bg-red-500/15 dark:hover:bg-red-500/25 dark:text-red-300 dark:border-red-500/35"
              }`}
              onClick={onDeleteMeasure}
            >
              <Trash2 className="h-3 w-3" /> Bar
            </button>
            {onApplyMeasureMeter && (
              <MeasureMeterControl
                measureInfo={activeMeasureInfo}
                pendingOverflow={pendingOverflow}
                onDismissOverflow={onDismissOverflow}
                onApply={onApplyMeasureMeter}
              />
            )}
            {onToggleRepeatBarline && onSetRepeatCount && onSetVoltaEnding && onToggleNavigationMarker && (
              <RepeatPaletteControl
                measureInfo={activeMeasureInfo}
                onToggleRepeatBarline={onToggleRepeatBarline}
                onSetRepeatCount={onSetRepeatCount}
                onSetVoltaEnding={onSetVoltaEnding}
                onToggleNavigationMarker={onToggleNavigationMarker}
              />
            )}
          </div>

          {(onOpenChordEditor || onOpenLyricEditor) && (
            <div className={groupSep} role="group" aria-label="Chord symbols and lyrics">
              {onOpenChordEditor && (
                <button
                  type="button"
                  data-testid="palette-chord-btn"
                  aria-label="Chord (Ctrl+K)"
                  aria-pressed={isChordEditorOpen}
                  title="Add or edit chord symbol (Ctrl+K / Cmd+K)"
                  onClick={onOpenChordEditor}
                  className={btnClass(isChordEditorOpen, false)}
                >
                  <Music2 className="h-3 w-3" />
                  <span>Chord</span>
                  <kbd className="rounded bg-black/10 px-1 text-[10px]">Ctrl+K</kbd>
                </button>
              )}
              {onOpenLyricEditor && (
                <button
                  type="button"
                  data-testid="palette-lyrics-btn"
                  aria-label="Lyrics (Ctrl+L)"
                  aria-pressed={isLyricEditorOpen}
                  title="Add or edit inline lyrics (Ctrl+L / Cmd+L)"
                  onClick={onOpenLyricEditor}
                  className={btnClass(isLyricEditorOpen, false)}
                >
                  <MessageSquareText className="h-3 w-3" />
                  <span>Lyrics</span>
                  <kbd className="rounded bg-black/10 px-1 text-[10px]">Ctrl+L</kbd>
                </button>
              )}
            </div>
          )}
        </div>

        {!hideInlineMetaControls && (
          <div className="flex items-center gap-2 ml-auto">
            <span
              data-testid="notation-edit-readout"
              title={selectionText}
              className="font-mono text-[11px] text-amber-950 font-medium dark:text-amber-200 max-w-[260px] truncate whitespace-nowrap"
            >
              {selectionText}
            </span>
            {onUndo && (
              <button
                type="button"
                disabled={!canUndo}
                aria-label="Undo notation edit"
                title="Undo (Ctrl+Z)"
                className={btnClass(false, !canUndo)}
                onClick={onUndo}
              >
                <Undo2 className="h-3 w-3" />
              </button>
            )}
            {onRedo && (
              <button
                type="button"
                disabled={!canRedo}
                aria-label="Redo notation edit"
                title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
                className={btnClass(false, !canRedo)}
                onClick={onRedo}
              >
                <Redo2 className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              aria-label="Toggle keyboard shortcut reference"
              aria-expanded={showShortcuts}
              onClick={() => setShowShortcuts((v) => !v)}
              className={btnClass(showShortcuts, false)}
            >
              <HelpCircle className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      {statusMessage && (
        <div
          data-testid="palette-status-message"
          className="rounded-md bg-violet-500/15 border border-violet-500/30 px-2.5 py-1 text-[11px] text-violet-900 dark:text-violet-200"
        >
          {statusMessage}
        </div>
      )}

      {!hideInlineMetaControls && showShortcuts && (
        <NotationShortcutsReference activeTupletActual={activeTupletActual} />
      )}
    </div>
  );
}
