import { useEffect, useRef } from "react";
import { Trash2, X } from "lucide-react";

export interface InlineScoreTextEditorProps {
  mode: "chord" | "lyric";
  anchor: { x: number; y: number };
  targetKey: string;
  value: string;
  verse?: 1 | 2 | 3;
  inWord?: boolean;
  positionLabel?: string;
  errorMessage?: string | null;
  containerWidth?: number;
  hasExistingValue?: boolean;
  onChange: (nextValue: string) => void;
  onVerseChange?: (verse: 1 | 2 | 3) => void;
  onCommitAndClose: () => void;
  onCommitAndAdvance: (trigger: "tab" | "space" | "hyphen" | "underscore") => void;
  onDelete?: () => void;
  onCancel: () => void;
}

/**
 * Compact MuseScore-style floating inline input for chord symbols (above staff)
 * and lyric syllables (below notehead). Stops keystroke propagation so editor keys
 * never trigger global Studio shortcuts.
 */
export function InlineScoreTextEditor({
  mode,
  anchor,
  targetKey,
  value,
  verse = 1,
  inWord = false,
  positionLabel,
  errorMessage = null,
  containerWidth = 760,
  hasExistingValue = false,
  onChange,
  onVerseChange,
  onCommitAndClose,
  onCommitAndAdvance,
  onDelete,
  onCancel,
}: InlineScoreTextEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [targetKey, verse]);

  const panelWidth = mode === "lyric" ? 268 : 228;
  const maxLeft = Math.max(8, (containerWidth > 0 ? containerWidth : 760) - panelWidth - 12);
  const clampedLeft = Math.max(8, Math.min(maxLeft, Math.round(anchor.x - 24)));
  const clampedTop = Math.max(6, Math.round(anchor.y));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Allow Ctrl+A/C/V/X clipboard editing inside the input, but block all other keystrokes from bubbling
    e.stopPropagation();

    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      onCommitAndClose();
      return;
    }

    if (mode === "chord") {
      if (e.key === "Tab") {
        e.preventDefault();
        onCommitAndAdvance("tab");
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        onCommitAndAdvance("space");
        return;
      }
    } else {
      // Lyric syllable navigation: '-' hyphen splits syllable, '_' extends melisma, ' ' finishes word
      if (e.key === "-" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        onCommitAndAdvance("hyphen");
        return;
      }
      if (e.key === "_" || (e.key === "-" && e.shiftKey)) {
        e.preventDefault();
        onCommitAndAdvance("underscore");
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        onCommitAndAdvance("space");
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        onCommitAndAdvance("space");
        return;
      }
    }
  };

  return (
    <div
      data-inline-score-editor="true"
      data-testid={mode === "chord" ? "inline-chord-editor" : "inline-lyric-editor"}
      style={{
        position: "absolute",
        left: `${clampedLeft}px`,
        top: `${clampedTop}px`,
        width: `${panelWidth}px`,
        maxWidth: "calc(100vw - 2rem)",
        zIndex: 45,
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className="rounded-lg border border-violet-500/70 bg-white p-2 shadow-xl ring-2 ring-violet-500/20 text-xs text-stone-900 dark:border-violet-400/60 dark:bg-[#141422] dark:text-[#F5F3FF]"
    >
      <div className="flex items-center justify-between gap-1.5 mb-1.5">
        <span className="font-semibold text-[11px] text-violet-800 dark:text-violet-300 truncate">
          {mode === "chord" ? "Chord Symbol" : inWord ? "Lyric (cont.)" : "Lyric Syllable"}
          {positionLabel ? (
            <span className="ml-1 font-mono text-[10px] font-normal text-stone-500 dark:text-[#A1A1AA]">
              {positionLabel}
            </span>
          ) : null}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {mode === "lyric" && onVerseChange && (
            <select
              aria-label="Lyric verse"
              data-testid="inline-lyric-verse-select"
              value={verse}
              onChange={(e) => onVerseChange(Number(e.target.value) as 1 | 2 | 3)}
              className="h-5 rounded border border-stone-300 bg-stone-50 px-1 text-[10px] font-medium text-stone-800 focus:border-violet-500 focus:outline-none dark:border-[#2E2E45] dark:bg-[#0D0D16] dark:text-[#E4E4F0]"
            >
              <option value={1}>Verse 1</option>
              <option value={2}>Verse 2</option>
              <option value={3}>Verse 3</option>
            </select>
          )}
          {hasExistingValue && onDelete && (
            <button
              type="button"
              onClick={onDelete}
              aria-label={mode === "chord" ? "Delete chord symbol" : "Clear lyric syllable"}
              title={mode === "chord" ? "Remove chord" : "Clear syllable"}
              data-testid={mode === "chord" ? "inline-chord-delete-btn" : "inline-lyric-delete-btn"}
              className="rounded p-0.5 text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-500/15"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel inline edit"
            title="Cancel (Esc)"
            className="rounded p-0.5 text-stone-500 hover:bg-stone-100 dark:text-[#A1A1AA] dark:hover:bg-white/10"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1">
        {mode === "lyric" && inWord && (
          <span
            aria-hidden="true"
            className="text-xs font-mono font-bold text-violet-600 dark:text-violet-300"
          >
            -
          </span>
        )}
        <input
          ref={inputRef}
          type="text"
          aria-label={mode === "chord" ? "Chord symbol input" : "Lyric syllable input"}
          data-testid={mode === "chord" ? "inline-chord-input" : "inline-lyric-input"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={mode === "chord" ? "e.g. F#m7, Bb/D" : "Syllable (- / Space / _)"}
          className="h-7 w-full rounded border border-stone-300 bg-white px-2 font-mono text-xs text-stone-900 placeholder:font-sans placeholder:text-[11px] placeholder:text-stone-400 focus:border-violet-500 focus:outline-none dark:border-[#2E2E45] dark:bg-[#09090F] dark:text-[#F5F3FF] dark:placeholder:text-[#71717A]"
        />
      </div>

      {errorMessage ? (
        <div
          role="alert"
          data-testid={mode === "chord" ? "inline-chord-error" : "inline-lyric-error"}
          className="mt-1 rounded bg-red-50 px-1.5 py-1 text-[10px] font-medium text-red-800 border border-red-200 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30"
        >
          {errorMessage}
        </div>
      ) : (
        <div className="mt-1 text-[10px] text-stone-500 dark:text-[#8E8EA0]">
          {mode === "chord"
            ? "Enter: Save • Tab/Space: Next beat • Esc: Cancel"
            : "- Next syllable • Space End word • _ Melisma • Enter Done"}
        </div>
      )}
    </div>
  );
}
