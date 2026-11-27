import { useEffect, useState } from "react";
import { Repeat, X } from "lucide-react";
import type { MeasureStructureInfo, NavigationMarkerType } from "@/features/editor/musicXmlStructure";

interface RepeatPaletteControlProps {
  measureInfo: MeasureStructureInfo | null;
  disabled?: boolean;
  onToggleRepeatBarline: (measureNumber: number, kind: "forward" | "backward" | "both", repeatCount: number) => void;
  onSetRepeatCount: (measureNumber: number, repeatCount: number) => void;
  onSetVoltaEnding: (measureNumber: number, action: "start_1" | "start_2" | "end_ending" | "clear_ending") => void;
  onToggleNavigationMarker: (measureNumber: number, marker: NavigationMarkerType) => void;
}

const NAV_ITEMS: Array<{ marker: NavigationMarkerType; label: string; shortLabel: string }> = [
  { marker: "segno", label: "Segno (𝄋)", shortLabel: "𝄋 Segno" },
  { marker: "coda", label: "Coda (𝄌)", shortLabel: "𝄌 Coda" },
  { marker: "fine", label: "Fine", shortLabel: "Fine" },
  { marker: "to_coda", label: "To Coda", shortLabel: "To Coda" },
  { marker: "dc_al_fine", label: "D.C. al Fine", shortLabel: "D.C. al Fine" },
  { marker: "dc_al_coda", label: "D.C. al Coda", shortLabel: "D.C. al Coda" },
  { marker: "ds_al_fine", label: "D.S. al Fine", shortLabel: "D.S. al Fine" },
  { marker: "ds_al_coda", label: "D.S. al Coda", shortLabel: "D.S. al Coda" },
];

export function RepeatPaletteControl({
  measureInfo,
  disabled = false,
  onToggleRepeatBarline,
  onSetRepeatCount,
  onSetVoltaEnding,
  onToggleNavigationMarker,
}: RepeatPaletteControlProps) {
  const [open, setOpen] = useState(false);
  const [repeatCount, setRepeatCount] = useState(2);

  useEffect(() => {
    if (measureInfo?.repeatCount) {
      setRepeatCount(measureInfo.repeatCount);
    }
  }, [measureInfo?.measureNumber, measureInfo?.repeatCount]);

  const hasAnyRepeatOrNav = Boolean(
    measureInfo &&
      (measureInfo.forwardRepeat ||
        measureInfo.backwardRepeat ||
        measureInfo.endingStart ||
        measureInfo.endingStop ||
        measureInfo.endingDiscontinue ||
        measureInfo.navigationMarkers.length > 0),
  );

  const chipClass = (active: boolean) =>
    `inline-flex items-center justify-center h-7 rounded-md border px-2 text-[11px] font-medium transition-colors ${
      active
        ? "border-violet-600 bg-violet-600 text-white font-semibold"
        : "border-stone-300 bg-white hover:bg-stone-100 text-stone-800 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#E4E4E7] dark:hover:bg-white/10"
    }`;

  return (
    <div className="relative inline-block">
      <button
        type="button"
        disabled={disabled || !measureInfo}
        data-testid="palette-repeats-btn"
        aria-label="Repeats, Endings & Navigation"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 h-7 rounded-md border px-2 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500/40 ${
          disabled || !measureInfo
            ? "bg-stone-100 text-stone-500 border-stone-200 cursor-not-allowed dark:bg-white/5 dark:text-slate-500 dark:border-white/10"
            : open || hasAnyRepeatOrNav
              ? "bg-violet-600 text-white border-violet-700 font-semibold dark:bg-violet-500 dark:border-violet-400"
              : "bg-white hover:bg-stone-100 text-stone-800 border-stone-300 font-medium dark:bg-[#11111B] dark:hover:bg-white/10 dark:text-slate-200 dark:border-[#27273A]"
        }`}
      >
        <Repeat className="h-3 w-3" />
        <span>Repeats</span>
      </button>

      {open && measureInfo && (
        <div
          data-testid="repeat-palette-popover"
          className="absolute left-0 top-8 z-40 w-80 rounded-xl border border-stone-300 bg-white p-3 shadow-2xl space-y-3 text-left text-xs dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF]"
        >
          <div className="flex items-center justify-between border-b border-stone-200 pb-2 dark:border-[#27273A]">
            <span className="font-semibold text-stone-900 dark:text-white">
              Repeats &amp; Navigation (Measure {measureInfo.measureNumber})
            </span>
            <button
              type="button"
              aria-label="Close repeats panel"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:text-[#A1A1AA] dark:hover:bg-white/10"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Repeat Barlines */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-stone-600 dark:text-[#A1A1AA]">
              Repeat Barlines
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                aria-pressed={measureInfo.forwardRepeat}
                data-testid="repeat-forward-btn"
                onClick={() => onToggleRepeatBarline(measureInfo.measureNumber, "forward", repeatCount)}
                className={chipClass(measureInfo.forwardRepeat)}
              >
                |: Start
              </button>
              <button
                type="button"
                aria-pressed={measureInfo.backwardRepeat}
                data-testid="repeat-backward-btn"
                onClick={() => onToggleRepeatBarline(measureInfo.measureNumber, "backward", repeatCount)}
                className={chipClass(measureInfo.backwardRepeat)}
              >
                :| End
              </button>
              <button
                type="button"
                data-testid="repeat-both-btn"
                onClick={() => onToggleRepeatBarline(measureInfo.measureNumber, "both", repeatCount)}
                className={chipClass(false)}
              >
                :| |:
              </button>
              {measureInfo.backwardRepeat && (
                <label className="ml-auto inline-flex items-center gap-1 text-[11px] text-stone-600 dark:text-[#A1A1AA]">
                  Times
                  <input
                    type="number"
                    min={2}
                    max={8}
                    aria-label="Repeat count"
                    data-testid="repeat-times-input"
                    value={repeatCount}
                    onChange={(e) => {
                      const next = Math.max(2, Math.min(8, Number.parseInt(e.target.value, 10) || 2));
                      setRepeatCount(next);
                      onSetRepeatCount(measureInfo.measureNumber, next);
                    }}
                    className="h-7 w-12 rounded border border-stone-300 bg-white px-1.5 text-center font-mono text-xs text-stone-900 dark:border-[#27273A] dark:bg-[#0D0D16] dark:text-white"
                  />
                </label>
              )}
            </div>
          </div>

          {/* 1st / 2nd Ending Volta Brackets */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-stone-600 dark:text-[#A1A1AA]">
              Volta Endings
            </div>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                aria-pressed={Boolean(measureInfo.endingStart?.includes(1))}
                data-testid="volta-ending-1-btn"
                onClick={() => onSetVoltaEnding(measureInfo.measureNumber, "start_1")}
                className={chipClass(Boolean(measureInfo.endingStart?.includes(1)))}
              >
                1. Ending
              </button>
              <button
                type="button"
                aria-pressed={Boolean(
                  measureInfo.endingStop?.length || measureInfo.endingDiscontinue?.length,
                )}
                data-testid="volta-end-btn"
                onClick={() => onSetVoltaEnding(measureInfo.measureNumber, "end_ending")}
                className={chipClass(
                  Boolean(measureInfo.endingStop?.length || measureInfo.endingDiscontinue?.length),
                )}
              >
                End Ending
              </button>
              <button
                type="button"
                aria-pressed={Boolean(measureInfo.endingStart?.includes(2))}
                data-testid="volta-ending-2-btn"
                onClick={() => onSetVoltaEnding(measureInfo.measureNumber, "start_2")}
                className={chipClass(Boolean(measureInfo.endingStart?.includes(2)))}
              >
                2. Ending
              </button>
              <button
                type="button"
                data-testid="volta-clear-btn"
                onClick={() => onSetVoltaEnding(measureInfo.measureNumber, "clear_ending")}
                className={chipClass(false)}
              >
                Clear
              </button>
            </div>
          </div>

          {/* Navigation Markers */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-stone-600 dark:text-[#A1A1AA]">
              Navigation Repeats &amp; Markers
            </div>
            <div className="grid grid-cols-2 gap-1">
              {NAV_ITEMS.map((item) => {
                const active = measureInfo.navigationMarkers.includes(item.marker);
                return (
                  <button
                    key={item.marker}
                    type="button"
                    aria-pressed={active}
                    aria-label={item.label}
                    data-testid={`nav-marker-${item.marker}`}
                    onClick={() => onToggleNavigationMarker(measureInfo.measureNumber, item.marker)}
                    className={chipClass(active)}
                  >
                    {item.shortLabel}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
