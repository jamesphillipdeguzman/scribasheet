import { useEffect, useState } from "react";
import { AlertTriangle, Clock, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { MeasureStructureInfo } from "@/features/editor/musicXmlStructure";

export interface MeasureMeterChangePayload {
  measureNumber: number;
  mode: "this_measure_only" | "from_this_measure_onward";
  beats: number;
  beatType: number;
  showMeterChange: boolean;
  forceTruncate?: boolean;
}

export interface PendingOverflowWarning {
  message: string;
  onConfirmTruncate: () => void;
}

interface MeasureMeterControlProps {
  measureInfo: MeasureStructureInfo | null;
  disabled?: boolean;
  pendingOverflow?: PendingOverflowWarning | null;
  onDismissOverflow?: () => void;
  onApply: (payload: MeasureMeterChangePayload) => void;
}

const BEAT_PRESETS = [1, 2, 3, 4, 5, 6];
const BEAT_UNITS = [2, 4, 8, 16];
const METER_PRESETS = ["4/4", "3/4", "2/4", "6/8", "3/8", "12/8", "2/2", "5/4"];

export function MeasureMeterControl({
  measureInfo,
  disabled = false,
  pendingOverflow = null,
  onDismissOverflow,
  onApply,
}: MeasureMeterControlProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"this_measure_only" | "from_this_measure_onward">(
    "this_measure_only",
  );
  const [customBeats, setCustomBeats] = useState("4");
  const [beatType, setBeatType] = useState(4);
  const [showMeterChange, setShowMeterChange] = useState(false);

  const mNum = measureInfo?.measureNumber;
  const mBeats = measureInfo?.beatsInActiveUnit;
  const mBeatType = measureInfo?.timeBeatType;
  const mExplicit = measureInfo?.hasExplicitTimeChange;

  useEffect(() => {
    if (mNum === undefined || mBeats === undefined || mBeatType === undefined) return;
    const rounded = Number(mBeats.toFixed(2));
    setCustomBeats(String(rounded > 0 ? rounded : 4));
    setBeatType(mBeatType || 4);
    setShowMeterChange(Boolean(mExplicit));
  }, [mNum, mBeats, mBeatType, mExplicit]);

  const measureLabel = measureInfo
    ? measureInfo.isPickup || measureInfo.measureNumber === 0
      ? "Measure 0 (Pickup)"
      : `Measure ${measureInfo.measureNumber}`
    : "Select a measure";

  const applyUpdate = (nextBeats: number, nextBeatType: number, nextMode = mode, nextShow = showMeterChange) => {
    if (!measureInfo) return;
    onApply({
      measureNumber: measureInfo.measureNumber,
      mode: nextMode,
      beats: nextBeats,
      beatType: nextBeatType,
      showMeterChange: nextMode === "from_this_measure_onward" ? true : nextShow,
    });
  };

  return (
    <div className="relative inline-block">
      <button
        type="button"
        disabled={disabled || !measureInfo}
        data-testid="palette-measure-meter-btn"
        aria-label="Measure beats and time signature"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 h-7 rounded-md border px-2 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500/40 ${
          disabled || !measureInfo
            ? "bg-stone-100 text-stone-500 border-stone-200 cursor-not-allowed dark:bg-white/5 dark:text-slate-500 dark:border-white/10"
            : open
              ? "bg-violet-600 text-white border-violet-700 font-semibold dark:bg-violet-500 dark:border-violet-400"
              : "bg-white hover:bg-stone-100 text-stone-800 border-stone-300 font-medium dark:bg-[#11111B] dark:hover:bg-white/10 dark:text-slate-200 dark:border-[#27273A]"
        }`}
      >
        <Clock className="h-3 w-3" />
        <span>
          Beats / Meter
          {measureInfo ? ` (${Number(measureInfo.beatsInActiveUnit.toFixed(2))}/${measureInfo.timeBeatType})` : ""}
        </span>
      </button>

      {open && measureInfo && (
        <div
          data-testid="measure-meter-popover"
          className="absolute left-0 top-8 z-40 w-80 rounded-xl border border-stone-300 bg-white p-3 shadow-2xl space-y-3 text-left text-xs dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF]"
        >
          <div className="flex items-center justify-between border-b border-stone-200 pb-2 dark:border-[#27273A]">
            <div>
              <div className="font-semibold text-stone-900 dark:text-white">{measureLabel}</div>
              <div className="text-[11px] text-stone-500 dark:text-[#A1A1AA]">
                Active: {Number(measureInfo.beatsInActiveUnit.toFixed(2))} beats in /{measureInfo.timeBeatType}
                {measureInfo.isPickup ? " (Pickup)" : measureInfo.isIrregular ? " (Irregular)" : ""}
              </div>
            </div>
            <button
              type="button"
              aria-label="Close beats and meter panel"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:text-[#A1A1AA] dark:hover:bg-white/10"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Scope toggle */}
          <div role="group" aria-label="Meter change scope" className="grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-0.5 dark:bg-[#09090F]">
            <button
              type="button"
              aria-pressed={mode === "this_measure_only"}
              data-testid="meter-scope-single"
              onClick={() => setMode("this_measure_only")}
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                mode === "this_measure_only"
                  ? "bg-violet-600 text-white shadow-xs"
                  : "text-stone-700 hover:text-stone-950 dark:text-[#A1A1AA] dark:hover:text-white"
              }`}
            >
              This Measure Only
            </button>
            <button
              type="button"
              aria-pressed={mode === "from_this_measure_onward"}
              data-testid="meter-scope-onward"
              onClick={() => setMode("from_this_measure_onward")}
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                mode === "from_this_measure_onward"
                  ? "bg-violet-600 text-white shadow-xs"
                  : "text-stone-700 hover:text-stone-950 dark:text-[#A1A1AA] dark:hover:text-white"
              }`}
            >
              From Here Onward
            </button>
          </div>

          {mode === "this_measure_only" ? (
            <div className="space-y-2.5">
              <div>
                <div className="mb-1 text-[11px] font-medium text-stone-600 dark:text-[#A1A1AA]">
                  Beats (active /{beatType} unit):
                </div>
                <div className="flex flex-wrap gap-1">
                  {BEAT_PRESETS.map((b) => (
                    <button
                      key={b}
                      type="button"
                      data-testid={`measure-beat-preset-${b}`}
                      onClick={() => {
                        setCustomBeats(String(b));
                        applyUpdate(b, beatType, "this_measure_only", showMeterChange);
                      }}
                      className={`h-7 min-w-[30px] rounded-md border px-2 font-mono text-xs ${
                        Math.abs(Number(customBeats) - b) < 0.01
                          ? "border-violet-500 bg-violet-600 text-white font-semibold"
                          : "border-stone-300 bg-white hover:bg-stone-100 text-stone-800 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#E4E4E7]"
                      }`}
                    >
                      {b}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <label className="flex items-center gap-2 text-[11px] cursor-pointer">
                  <input
                    type="radio"
                    name="local-meter-visibility"
                    data-testid="meter-hide-change-radio"
                    checked={!showMeterChange}
                    onChange={() => setShowMeterChange(false)}
                  />
                  <span>Hide meter change (Irregular / Pickup)</span>
                </label>
                <label className="flex items-center gap-2 text-[11px] cursor-pointer">
                  <input
                    type="radio"
                    name="local-meter-visibility"
                    data-testid="meter-show-change-radio"
                    checked={showMeterChange}
                    onChange={() => setShowMeterChange(true)}
                  />
                  <span>Show local time signature &amp; restore next bar</span>
                </label>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-[11px] font-medium text-stone-600 dark:text-[#A1A1AA]">
                Meter Presets (applied onward until next explicit change):
              </div>
              <div className="flex flex-wrap gap-1">
                {METER_PRESETS.map((preset) => {
                  const [pb, pbt] = preset.split("/").map(Number);
                  return (
                    <button
                      key={preset}
                      type="button"
                      data-testid={`meter-preset-${preset.replace("/", "-")}`}
                      onClick={() => {
                        setCustomBeats(String(pb));
                        setBeatType(pbt);
                        applyUpdate(pb, pbt, "from_this_measure_onward", true);
                      }}
                      className="h-7 rounded-md border border-stone-300 bg-white px-2 font-mono text-[11px] font-medium hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#181825] dark:hover:bg-white/10"
                    >
                      {preset}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Custom beats / denominator form */}
          <div className="flex items-end gap-1.5 border-t border-stone-200 pt-2 dark:border-[#27273A]">
            <label className="flex-1 space-y-0.5 text-[11px]">
              <span className="text-stone-500 dark:text-[#A1A1AA]">Custom Beats</span>
              <input
                type="number"
                min={0.25}
                max={16}
                step={0.25}
                aria-label="Custom beat count"
                data-testid="measure-custom-beats-input"
                value={customBeats}
                onChange={(e) => setCustomBeats(e.target.value)}
                className="h-7 w-full rounded-md border border-stone-300 bg-white px-2 font-mono text-xs text-stone-900 dark:border-[#27273A] dark:bg-[#0D0D16] dark:text-white"
              />
            </label>
            <label className="w-20 space-y-0.5 text-[11px]">
              <span className="text-stone-500 dark:text-[#A1A1AA]">Beat Unit</span>
              <select
                aria-label="Measure beat unit"
                data-testid="measure-beat-unit-select"
                value={beatType}
                onChange={(e) => setBeatType(Number.parseInt(e.target.value, 10) || 4)}
                className="h-7 w-full rounded-md border border-stone-300 bg-white px-1.5 font-mono text-xs text-stone-900 dark:border-[#27273A] dark:bg-[#0D0D16] dark:text-white"
              >
                {BEAT_UNITS.map((u) => (
                  <option key={u} value={u}>
                    /{u}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              size="sm"
              data-testid="measure-meter-apply-btn"
              onClick={() => {
                const parsedB = Number.parseFloat(customBeats);
                if (!Number.isFinite(parsedB) || parsedB <= 0) return;
                applyUpdate(parsedB, beatType, mode, showMeterChange);
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      )}

      {pendingOverflow && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="measure-overflow-title"
          data-testid="measure-overflow-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
          onClick={(e) => {
            if (e.target === e.currentTarget) onDismissOverflow?.();
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-amber-400/60 bg-white p-5 shadow-2xl space-y-4 text-left dark:border-amber-500/40 dark:bg-[#11111B]">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5 dark:text-amber-400" />
              <div className="space-y-1">
                <h2 id="measure-overflow-title" className="text-sm font-semibold text-stone-900 dark:text-white">
                  Notes Exceed Target Measure Duration
                </h2>
                <p className="text-xs text-stone-600 dark:text-[#A1A1AA]">{pendingOverflow.message}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                data-testid="measure-overflow-cancel-btn"
                onClick={onDismissOverflow}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="danger"
                data-testid="measure-overflow-confirm-btn"
                onClick={pendingOverflow.onConfirmTruncate}
              >
                Truncate &amp; Apply
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
