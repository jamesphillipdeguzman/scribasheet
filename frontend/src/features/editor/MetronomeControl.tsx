import { useEffect, useRef, useState } from "react";
import { ChevronDown, Play, SlidersHorizontal, Square, Volume2 } from "lucide-react";
import {
  type MetronomeCountInBars,
  metronomeEngine,
  type MetronomeSettings,
  type MetronomeSound,
  type MetronomeSubdivision,
  parseTimeSignature,
  resolveEffectiveTimeSignature,
} from "@/features/editor/metronome";

interface MetronomeControlProps {
  settings: MetronomeSettings;
  onChangeSettings: (next: MetronomeSettings) => void;
  scoreTimeSignature?: string;
  tempoBpm: number;
  activeBeat: number | null;
  isPlaybackActive?: boolean;
  onBeatChange?: (beat: number | null) => void;
}

const TIME_SIG_OPTIONS = ["2/4", "3/4", "4/4", "6/8"] as const;

export function MetronomeControl({
  settings,
  onChangeSettings,
  scoreTimeSignature = "4/4",
  tempoBpm,
  activeBeat,
  isPlaybackActive = false,
  onBeatChange,
}: MetronomeControlProps) {
  const [open, setOpen] = useState(false);
  const [standaloneActive, setStandaloneActive] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const effectiveSig = resolveEffectiveTimeSignature(
    scoreTimeSignature,
    settings.timeSignatureOverride,
  );
  const { beatsPerBar } = parseTimeSignature(effectiveSig);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointer);
    return () => document.removeEventListener("mousedown", handlePointer);
  }, [open]);

  // Keep standalone metronome updated if tempo or settings change while running
  useEffect(() => {
    if (!standaloneActive) return;
    if (!settings.enabled || isPlaybackActive) {
      if (metronomeEngine.getMode() === "standalone") {
        metronomeEngine.stop();
      }
      setStandaloneActive(false);
      return;
    }
    metronomeEngine.updateStandalone({
      bpm: tempoBpm,
      scoreTimeSignature,
      settings,
    });
  }, [standaloneActive, settings, tempoBpm, scoreTimeSignature, isPlaybackActive]);

  const toggleEnabled = () => {
    const nextEnabled = !settings.enabled;
    onChangeSettings({ ...settings, enabled: nextEnabled });
    if (!nextEnabled && metronomeEngine.getMode() === "standalone") {
      metronomeEngine.stop();
      setStandaloneActive(false);
    }
  };

  const toggleStandalone = () => {
    if (standaloneActive) {
      metronomeEngine.stop();
      setStandaloneActive(false);
      return;
    }
    const nextSettings = settings.enabled ? settings : { ...settings, enabled: true };
    if (!settings.enabled) {
      onChangeSettings(nextSettings);
    }
    setStandaloneActive(true);
    metronomeEngine.startStandalone({
      bpm: tempoBpm,
      scoreTimeSignature,
      settings: nextSettings,
      onBeatChange,
      onStandaloneStop: () => setStandaloneActive(false),
    });
  };

  return (
    <div ref={containerRef} className="relative inline-flex items-center gap-1.5">
      {/* Split Transport Toggle + Settings Popover Trigger */}
      <div className="inline-flex items-center rounded border border-[#27273A] bg-[#09090F]">
        <button
          type="button"
          aria-pressed={settings.enabled}
          onClick={toggleEnabled}
          className={`px-2 py-1 text-xs rounded-l transition-colors ${
            settings.enabled
              ? "bg-[#181825] text-[#A78BFA] font-medium"
              : "text-[#A1A1AA] hover:text-[#F5F3FF]"
          }`}
        >
          Metronome
        </button>
        <button
          type="button"
          aria-label="Metronome settings"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`px-1.5 py-1 border-l border-[#27273A] rounded-r text-[#A1A1AA] hover:text-[#F5F3FF] ${
            open ? "bg-[#181825] text-[#F5F3FF]" : ""
          }`}
          title="Metronome Settings"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Visual Numbered Beat Indicator */}
      {(settings.enabled || activeBeat !== null) && (
        <div
          data-testid="metronome-beat-indicator"
          aria-label="Visual beat indicator"
          className="inline-flex items-center gap-0.5 rounded border border-[#27273A] bg-[#09090F] px-1.5 py-0.5"
        >
          {Array.from({ length: beatsPerBar }, (_, idx) => {
            const beatNum = idx + 1;
            const isActive = activeBeat === beatNum;
            const isDownbeat = beatNum === 1 && settings.accentBeatOne;
            return (
              <span
                key={beatNum}
                data-beat={beatNum}
                data-active={isActive ? "true" : "false"}
                className={`inline-flex h-4 w-4 items-center justify-center rounded-sm font-mono text-[10px] transition-colors ${
                  isActive
                    ? isDownbeat
                      ? "bg-emerald-400 text-[#09090F] font-bold"
                      : "bg-[#A78BFA] text-[#09090F] font-bold"
                    : "text-[#71717A]"
                }`}
              >
                {beatNum}
              </span>
            );
          })}
        </div>
      )}

      {/* Settings Popover */}
      {open && (
        <div
          role="dialog"
          aria-label="Metronome Settings"
          className="absolute right-0 top-full mt-2 z-50 w-72 rounded-xl border border-[#27273A] bg-[#11111B] p-3 shadow-2xl space-y-3 text-xs text-[#F5F3FF]"
        >
          <div className="flex items-center justify-between border-b border-[#27273A] pb-2">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <SlidersHorizontal className="h-3.5 w-3.5 text-[#A78BFA]" />
              Metronome Settings
            </span>
            <label className="inline-flex items-center gap-1.5 text-[#A1A1AA] cursor-pointer">
              <input
                type="checkbox"
                aria-label="Metronome enabled"
                checked={settings.enabled}
                onChange={toggleEnabled}
                className="accent-[#8B5CF6]"
              />
              Enabled
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="block text-[11px] text-[#A1A1AA]">Count-in</span>
              <select
                aria-label="Count-in bars"
                value={settings.countInBars}
                onChange={(e) =>
                  onChangeSettings({
                    ...settings,
                    countInBars: Number(e.target.value) as MetronomeCountInBars,
                  })
                }
                className="w-full h-7 rounded border border-[#27273A] bg-[#09090F] px-2 text-xs text-[#F5F3FF]"
              >
                <option value={0}>Off</option>
                <option value={1}>1 Bar</option>
                <option value={2}>2 Bars</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="block text-[11px] text-[#A1A1AA]">Click Sound</span>
              <select
                aria-label="Click sound"
                value={settings.sound}
                onChange={(e) =>
                  onChangeSettings({
                    ...settings,
                    sound: e.target.value as MetronomeSound,
                  })
                }
                className="w-full h-7 rounded border border-[#27273A] bg-[#09090F] px-2 text-xs text-[#F5F3FF]"
              >
                <option value="woodblock">Woodblock</option>
                <option value="studio_beep">Studio Beep</option>
                <option value="stick_rimshot">Stick/Rimshot</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="block text-[11px] text-[#A1A1AA]">Subdivision</span>
              <select
                aria-label="Metronome subdivision"
                value={settings.subdivision}
                onChange={(e) =>
                  onChangeSettings({
                    ...settings,
                    subdivision: e.target.value as MetronomeSubdivision,
                  })
                }
                className="w-full h-7 rounded border border-[#27273A] bg-[#09090F] px-2 text-xs text-[#F5F3FF]"
              >
                <option value="quarter">Quarter Notes (1/4)</option>
                <option value="eighth">Eighth Notes (1/8)</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="block text-[11px] text-[#A1A1AA]">Time Signature</span>
              <select
                aria-label="Metronome time signature"
                value={settings.timeSignatureOverride ?? "score"}
                onChange={(e) =>
                  onChangeSettings({
                    ...settings,
                    timeSignatureOverride: e.target.value === "score" ? null : e.target.value,
                  })
                }
                className="w-full h-7 rounded border border-[#27273A] bg-[#09090F] px-2 text-xs text-[#F5F3FF]"
              >
                <option value="score">Score ({scoreTimeSignature || "4/4"})</option>
                {TIME_SIG_OPTIONS.map((sig) => (
                  <option key={sig} value={sig}>
                    {sig}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-[#A1A1AA]">
              <span className="inline-flex items-center gap-1">
                <Volume2 className="h-3 w-3" /> Volume
              </span>
              <span className="font-mono text-[#F5F3FF]">{Math.round(settings.volume * 100)}%</span>
            </div>
            <input
              type="range"
              aria-label="Metronome volume"
              min={0}
              max={100}
              step={5}
              value={Math.round(settings.volume * 100)}
              onChange={(e) =>
                onChangeSettings({
                  ...settings,
                  volume: Number(e.target.value) / 100,
                })
              }
              className="w-full accent-[#8B5CF6]"
            />
          </div>

          <div className="flex items-center justify-between pt-1 border-t border-[#27273A]">
            <label className="inline-flex items-center gap-1.5 text-[#A1A1AA] cursor-pointer">
              <input
                type="checkbox"
                aria-label="Accent beat 1"
                checked={settings.accentBeatOne}
                onChange={(e) =>
                  onChangeSettings({ ...settings, accentBeatOne: e.target.checked })
                }
                className="accent-[#8B5CF6]"
              />
              Accent Beat 1
            </label>

            {!isPlaybackActive && (
              <button
                type="button"
                onClick={toggleStandalone}
                className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-medium border ${
                  standaloneActive
                    ? "border-rose-500/40 bg-rose-500/15 text-rose-200"
                    : "border-[#8B5CF6]/50 bg-[#8B5CF6]/15 text-[#F5F3FF] hover:bg-[#8B5CF6]/25"
                }`}
              >
                {standaloneActive ? (
                  <>
                    <Square className="h-3 w-3 fill-current" /> Stop Click
                  </>
                ) : (
                  <>
                    <Play className="h-3 w-3 fill-current" /> Standalone Click
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
