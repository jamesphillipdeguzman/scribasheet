import { useEffect, useState } from "react";
import { ArrowRightLeft, Music2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  CIRCLE_OF_FIFTHS_KEYS,
  computeShortestKeyInterval,
  formatKeySignatureName,
  getKeySignatureOption,
  type KeyMode,
} from "@/lib/keySignature";

export type KeyChangeAction = "respell" | "transpose";

interface KeySignatureControlProps {
  fifths: number;
  mode: KeyMode;
  noteCount: number;
  disabled?: boolean;
  compact?: boolean;
  onApplyKeyChange: (targetFifths: number, targetMode: KeyMode, action: KeyChangeAction) => void;
}

export function KeySignatureControl({
  fifths,
  mode,
  noteCount,
  disabled = false,
  compact = false,
  onApplyKeyChange,
}: KeySignatureControlProps) {
  const [pendingChange, setPendingChange] = useState<{
    targetFifths: number;
    targetMode: KeyMode;
  } | null>(null);

  useEffect(() => {
    if (!pendingChange) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPendingChange(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingChange]);

  const triggerChange = (nextFifths: number, nextMode: KeyMode) => {
    if (nextFifths === fifths && nextMode === mode) return;
    if (noteCount <= 0) {
      onApplyKeyChange(nextFifths, nextMode, "respell");
      return;
    }
    setPendingChange({ targetFifths: nextFifths, targetMode: nextMode });
  };

  const currentOpt = getKeySignatureOption(fifths);
  const currentLabel = formatKeySignatureName(fifths, mode);
  const pendingLabel = pendingChange
    ? formatKeySignatureName(pendingChange.targetFifths, pendingChange.targetMode)
    : "";
  const pendingOpt = pendingChange ? getKeySignatureOption(pendingChange.targetFifths) : null;
  const semitoneDelta = pendingChange
    ? computeShortestKeyInterval(fifths, mode, pendingChange.targetFifths, pendingChange.targetMode)
    : 0;
  const signedDelta = `${semitoneDelta >= 0 ? "+" : ""}${semitoneDelta}`;

  return (
    <>
      <div
        className="inline-flex items-center gap-1"
        data-testid={compact ? "toolbar-key-signature-control" : "playground-key-signature-control"}
      >
        <label className="sr-only" htmlFor={compact ? "toolbar-key-select" : "playground-key-select"}>
          Key Signature
        </label>
        <select
          id={compact ? "toolbar-key-select" : "playground-key-select"}
          aria-label="Key Signature"
          disabled={disabled}
          value={String(currentOpt.fifths)}
          onChange={(e) => {
            const nextF = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(nextF)) triggerChange(nextF, mode);
          }}
          className={`${
            compact ? "h-8 text-xs" : "h-7 text-xs"
          } rounded-lg border border-stone-300 bg-white px-2 text-stone-900 font-medium focus:outline-none focus:ring-2 focus:ring-violet-500/40 disabled:opacity-50 dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF]`}
        >
          {CIRCLE_OF_FIFTHS_KEYS.map((opt) => (
            <option key={opt.fifths} value={String(opt.fifths)}>
              {opt.dropdownLabel}
            </option>
          ))}
        </select>

        <div
          role="group"
          aria-label="Key mode"
          className="inline-flex rounded-lg border border-stone-300 bg-stone-100 p-0.5 text-[11px] dark:border-[#27273A] dark:bg-[#09090F]"
        >
          {(["major", "minor"] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={disabled}
              aria-pressed={mode === m}
              onClick={() => triggerChange(fifths, m)}
              className={`rounded-md px-1.5 py-0.5 transition-colors capitalize ${
                mode === m
                  ? "bg-violet-600 text-white font-semibold dark:bg-[#8B5CF6] dark:text-white"
                  : "text-stone-700 hover:text-stone-950 dark:text-[#A1A1AA] dark:hover:text-white"
              }`}
            >
              {m === "major" ? "Maj" : "Min"}
            </button>
          ))}
        </div>
      </div>

      {pendingChange && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="key-change-dialog-title"
          data-testid="key-change-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPendingChange(null);
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-stone-300 bg-white p-5 shadow-2xl space-y-4 text-left dark:border-[#27273A] dark:bg-[#11111B]">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <h2
                  id="key-change-dialog-title"
                  className="text-base font-semibold text-stone-900 dark:text-[#F5F3FF] flex items-center gap-2"
                >
                  <Music2 className="h-4 w-4 text-violet-600 dark:text-[#A78BFA]" />
                  Change Key Signature
                </h2>
                <p className="text-xs text-stone-600 dark:text-[#A1A1AA]">
                  Changing key from <strong>{currentLabel}</strong> to{" "}
                  <strong>{pendingLabel}</strong> ({pendingOpt?.accidentalLabel}) on a score with{" "}
                  <strong>{noteCount}</strong> notes.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close key signature dialog"
                onClick={() => setPendingChange(null)}
                className="rounded-md p-1 text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:text-[#A1A1AA] dark:hover:bg-white/10 dark:hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-2.5">
              <button
                type="button"
                data-testid="key-change-respell-btn"
                onClick={() => {
                  const target = pendingChange;
                  setPendingChange(null);
                  onApplyKeyChange(target.targetFifths, target.targetMode, "respell");
                }}
                className="w-full rounded-lg border border-violet-400/60 bg-violet-50 p-3 text-left transition-colors hover:bg-violet-100 dark:border-violet-500/40 dark:bg-violet-500/15 dark:hover:bg-violet-500/25"
              >
                <div className="flex items-center gap-2 text-xs font-semibold text-violet-950 dark:text-violet-200">
                  <Sparkles className="h-3.5 w-3.5" />
                  Set Key &amp; Re-spell Notes (Keep Pitch)
                </div>
                <p className="mt-1 text-[11px] text-violet-900/80 dark:text-violet-200/80">
                  Keeps exact MIDI pitches unchanged and updates notation &amp; chord spellings
                  to fit {pendingLabel} (for example, A♯ → B♭).
                </p>
              </button>

              <button
                type="button"
                data-testid="key-change-transpose-btn"
                onClick={() => {
                  const target = pendingChange;
                  setPendingChange(null);
                  onApplyKeyChange(target.targetFifths, target.targetMode, "transpose");
                }}
                className="w-full rounded-lg border border-stone-300 bg-stone-50 p-3 text-left transition-colors hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#181825] dark:hover:bg-[#232336]"
              >
                <div className="flex items-center gap-2 text-xs font-semibold text-stone-900 dark:text-[#F5F3FF]">
                  <ArrowRightLeft className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  Transpose Score to Key ({signedDelta} semitones)
                </div>
                <p className="mt-1 text-[11px] text-stone-600 dark:text-[#A1A1AA]">
                  Shifts all note pitches and chord symbols by {signedDelta} semitones into{" "}
                  {pendingLabel}.
                </p>
              </button>
            </div>

            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="key-change-cancel-btn"
                onClick={() => setPendingChange(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
