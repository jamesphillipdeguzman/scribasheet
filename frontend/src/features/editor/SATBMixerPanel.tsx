import { useEffect, useState } from "react";
import { AlertTriangle, Download, Loader2, Play, Square, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { loadMetronomeSettings, metronomeEngine, type MetronomeSettings } from "@/features/editor/metronome";
import { GM_INSTRUMENT_PRESETS, midiSynth } from "@/features/editor/midiSynth";
import { api, ApiError } from "@/services/api";
import type { ScoreData } from "@/types/api";

interface SATBMixerPanelProps {
  projectId: string;
  projectTitle: string;
  scoreData: ScoreData;
  onScoreUpdated?: (score: ScoreData, version: number, musicxml: string | null) => void;
  soloVoice?: string | null;
  onSoloVoiceChange?: (voice: string | null) => void;
  mutedVoices?: Record<string, boolean>;
  onMutedVoicesChange?: (muted: Record<string, boolean>) => void;
  metronomeSettings?: MetronomeSettings;
  onActiveBeatChange?: (beat: number | null) => void;
}

const SATB_VOICES = ["Soprano", "Alto", "Tenor", "Bass"] as const;

export function inferDefaultSatbAssignments(scoreData: ScoreData): Record<number, string> {
  const tracks = scoreData.tracks || [];
  const result: Record<number, string> = {};
  const used = new Set<string>();

  const satbMeta = (scoreData.analysis?.satb as {
    assignments?: Array<{ part_index: number; assigned_voice: string }>;
  }) || {};
  const metaMap = new Map<number, string>();
  for (const item of satbMeta.assignments || []) {
    if (SATB_VOICES.includes(item.assigned_voice as (typeof SATB_VOICES)[number])) {
      metaMap.set(item.part_index, item.assigned_voice);
    }
  }

  for (const t of tracks) {
    if (SATB_VOICES.includes(t.name as (typeof SATB_VOICES)[number])) {
      result[t.index] = t.name;
      used.add(t.name);
      continue;
    }
    const fromMeta = metaMap.get(t.index);
    if (fromMeta) {
      result[t.index] = fromMeta;
      used.add(fromMeta);
    }
  }

  const isGenuineSatb =
    scoreData.analysis?.mode === "satb_pdf" || Boolean(scoreData.analysis?.satb);

  for (const t of tracks) {
    if (t.index in result) continue;
    const label = `${t.name || ""} ${t.instrument || ""}`.toLowerCase();
    if (
      label.includes("accompaniment") ||
      label.includes("piano") ||
      label.includes("keyboard") ||
      label.includes("guitar") ||
      label.includes("drums")
    ) {
      result[t.index] = "";
      continue;
    }
    if (label.includes("vocal") || label.includes("melody")) {
      if (!used.has("Soprano")) {
        result[t.index] = "Soprano";
        used.add("Soprano");
      } else {
        result[t.index] = "";
      }
      continue;
    }
    if (isGenuineSatb && tracks.length === 4 && t.index >= 0 && t.index < 4) {
      const candidate = SATB_VOICES[t.index];
      if (!used.has(candidate)) {
        result[t.index] = candidate;
        used.add(candidate);
        continue;
      }
    }
    result[t.index] = "";
  }

  return result;
}

export function SATBMixerPanel({
  projectId,
  projectTitle,
  scoreData,
  onScoreUpdated,
  soloVoice: controlledSoloVoice,
  onSoloVoiceChange,
  mutedVoices: controlledMutedVoices,
  onMutedVoicesChange,
  metronomeSettings: controlledMetronome,
  onActiveBeatChange,
}: SATBMixerPanelProps) {
  const [internalSoloVoice, setInternalSoloVoice] = useState<string | null>(null);
  const [internalMutedVoices, setInternalMutedVoices] = useState<Record<string, boolean>>({});
  const soloVoice = controlledSoloVoice !== undefined ? controlledSoloVoice : internalSoloVoice;
  const mutedVoices = controlledMutedVoices !== undefined ? controlledMutedVoices : internalMutedVoices;
  const setSoloVoice = (next: string | null) => {
    setInternalSoloVoice(next);
    onSoloVoiceChange?.(next);
  };
  const setMutedVoices = (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => {
    const next = updater(mutedVoices);
    setInternalMutedVoices(next);
    onMutedVoicesChange?.(next);
  };
  const [volumes, setVolumes] = useState<Record<string, number>>({
    soprano: 1.0,
    alto: 1.0,
    tenor: 1.0,
    bass: 1.0,
  });
  const [instruments, setInstruments] = useState<Record<string, number>>({
    soprano: 0,
    alto: 0,
    tenor: 0,
    bass: 0,
  });
  const [tempoBpm, setTempoBpm] = useState<number>(Math.round(scoreData.tempo_bpm || 100));
  const [startMeasure, setStartMeasure] = useState<number>(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [exportingKey, setExportingKey] = useState<string | null>(null);
  const [savingAssignments, setSavingAssignments] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const satbMeta = (scoreData.analysis?.satb as {
    needs_review?: boolean;
    warnings?: string[];
    assignments?: Array<{ part_index: number; source_label: string; assigned_voice: string; uncertain?: boolean }>;
  }) || {};

  const [assignments, setAssignments] = useState<Record<number, string>>(() =>
    inferDefaultSatbAssignments(scoreData),
  );

  useEffect(() => {
    setAssignments(inferDefaultSatbAssignments(scoreData));
  }, [scoreData]);

  const assignedVoices = new Set(
    Object.values(assignments)
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v === "soprano" || v === "alto" || v === "tenor" || v === "bass"),
  );

  useEffect(() => {
    setTempoBpm(Math.round(scoreData.tempo_bpm || 100));
  }, [scoreData.tempo_bpm]);

  useEffect(() => {
    return () => {
      midiSynth.stop();
    };
  }, []);

  const isVoiceAudible = (voiceKey: string) => {
    if (soloVoice !== null) return soloVoice === voiceKey;
    return !mutedVoices[voiceKey];
  };

  const stopPlayback = () => {
    midiSynth.stop();
    if (metronomeEngine.getMode() !== "standalone") {
      metronomeEngine.stop();
    }
    setIsPlaying(false);
  };

  const startPlayback = () => {
    stopPlayback();
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      setError("Web Audio playback is not supported in this browser.");
      return;
    }

    const baseBpm = Math.max(20, scoreData.tempo_bpm || 100);
    const playbackRate = Math.max(20, tempoBpm) / baseBpm;
    const beatsPerBar = Math.max(1, parseInt((scoreData.time_signature || "4/4").split("/")[0] || "4", 10));
    const secPerBarBase = (60 / baseBpm) * beatsPerBar;
    const offsetSec = Math.max(0, (startMeasure - 1) * secPerBarBase);

    const trackVoiceMap: Record<number, string> = {};
    const trackPrograms: Record<number, number> = {};
    const trackVolumes: Record<number, number> = {};
    for (const t of scoreData.tracks || []) {
      const vKey = (assignments[t.index] || t.name || "Soprano").toLowerCase();
      trackVoiceMap[t.index] = vKey;
      trackPrograms[t.index] = instruments[vKey] ?? 0;
      trackVolumes[t.index] = volumes[vKey] ?? 1.0;
    }

    const audibleNotes = scoreData.notes.filter((n) => {
      const vKey = trackVoiceMap[n.track_index] || "soprano";
      return isVoiceAudible(vKey) && n.offset_sec > offsetSec;
    });

    const totalDur = Math.max(
      offsetSec + 0.5,
      audibleNotes.reduce((m, n) => Math.max(m, n.offset_sec), offsetSec),
    );

    const effMetronome = controlledMetronome ?? loadMetronomeSettings();
    const beginSatb = () => {
      setIsPlaying(true);
      midiSynth.start({
        notes: audibleNotes,
        fromSec: offsetSec,
        durationSec: totalDur,
        tempoBpm: baseBpm,
        playbackRate,
        volume: 0.85,
        loop: false,
        metronome: false,
        trackPrograms,
        trackVolumes,
        onPosition: () => {},
        onEnd: () => {
          setIsPlaying(false);
          metronomeEngine.stop();
        },
      });
      if (effMetronome.enabled) {
        metronomeEngine.startSynced({
          getSongSec: () => {
            const clock = midiSynth.getPlaybackClock();
            return clock.isPlaying ? clock.currentSec : offsetSec;
          },
          bpm: baseBpm,
          playbackRate,
          scoreTimeSignature: scoreData.time_signature || "4/4",
          settings: effMetronome,
          onBeatChange: onActiveBeatChange,
        });
      }
    };

    if (effMetronome.enabled && (effMetronome.countInBars === 1 || effMetronome.countInBars === 2)) {
      setIsPlaying(true);
      metronomeEngine.startCountIn({
        bars: effMetronome.countInBars,
        bpm: tempoBpm,
        scoreTimeSignature: scoreData.time_signature || "4/4",
        settings: effMetronome,
        onBeatChange: onActiveBeatChange,
        onComplete: beginSatb,
      });
    } else {
      beginSatb();
    }
  };

  const handleSaveAssignments = async () => {
    setSavingAssignments(true);
    setError(null);
    try {
      const instByIdx: Record<number, number> = {};
      for (const t of scoreData.tracks || []) {
        const vKey = (assignments[t.index] || t.name || "soprano").toLowerCase();
        instByIdx[t.index] = instruments[vKey] ?? 0;
      }
      const updated = await api.updateSatbAssignments(projectId, {
        assignments,
        instruments: instByIdx,
      });
      onScoreUpdated?.(updated.score_json, updated.version, updated.musicxml);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save SATB assignments.");
    } finally {
      setSavingAssignments(false);
    }
  };

  const handleExport = async (
    part: "soprano" | "alto" | "tenor" | "bass" | "combined",
    format: "mp3" | "wav",
  ) => {
    if (part !== "combined" && !assignedVoices.has(part)) {
      return;
    }
    const key = `${part}_${format}`;
    setExportingKey(key);
    setError(null);
    try {
      const cleanTitle = (projectTitle || "Song_Title").replace(/\s+/g, "_");
      const label = part === "combined" ? "SATB_Combined" : part.charAt(0).toUpperCase() + part.slice(1);
      await api.exportSatbAudio(
        projectId,
        {
          part,
          format,
          volumes,
          instruments,
          voice_assignments: assignments,
          tempo_bpm: tempoBpm,
          start_measure: startMeasure > 1 ? startMeasure : undefined,
        },
        `${cleanTitle}_${label}.${format}`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to export SATB audio.");
    } finally {
      setExportingKey(null);
    }
  };

  return (
    <div className="rounded-xl border border-[#27273A] bg-[#11111B] p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-[#F5F3FF]">SATB Mixer &amp; Practice Tracks</h3>
          <p className="text-xs text-[#A1A1AA]">
            Solo, mute, adjust part volumes/instruments, and download synchronized MP3 or WAV tracks.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isPlaying ? (
            <Button size="sm" onClick={startPlayback}>
              <Play className="h-3.5 w-3.5" /> Play SATB
            </Button>
          ) : (
            <Button size="sm" variant="danger" onClick={stopPlayback}>
              <Square className="h-3.5 w-3.5" /> Stop
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={exportingKey !== null}
            onClick={() => handleExport("combined", "mp3")}
          >
            {exportingKey === "combined_mp3" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Combined MP3
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={exportingKey !== null}
            onClick={() => handleExport("combined", "wav")}
          >
            Combined WAV
          </Button>
        </div>
      </div>

      {satbMeta.warnings && satbMeta.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200 space-y-1">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {satbMeta.needs_review ? "SATB Recognition Needs Review" : "Recognition Notes"}
          </div>
          <ul className="list-disc pl-5 space-y-0.5">
            {satbMeta.warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-300">
          {error}
        </div>
      )}

      {/* Playback Tempo & Start Measure */}
      <div className="grid gap-3 sm:grid-cols-2 rounded-lg border border-[#27273A] bg-[#09090F] p-3 text-xs">
        <label className="flex items-center justify-between gap-3">
          <span className="text-[#A1A1AA] whitespace-nowrap">Tempo ({tempoBpm} BPM)</span>
          <input
            type="range"
            aria-label="SATB Tempo"
            min={40}
            max={200}
            value={tempoBpm}
            onChange={(e) => setTempoBpm(Number(e.target.value))}
            className="w-full accent-[#8B5CF6]"
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="text-[#A1A1AA] whitespace-nowrap">Start Measure</span>
          <input
            type="number"
            aria-label="Start Measure"
            min={1}
            value={startMeasure}
            onChange={(e) => setStartMeasure(Math.max(1, Number(e.target.value) || 1))}
            className="w-20 h-8 rounded border border-[#27273A] bg-[#11111B] px-2 text-xs text-[#F5F3FF]"
          />
        </label>
      </div>

      {/* Per-Voice Mixer Table */}
      <div className="space-y-2">
        {SATB_VOICES.map((voice) => {
          const vKey = voice.toLowerCase() as "soprano" | "alto" | "tenor" | "bass";
          const isAssigned = assignedVoices.has(vKey);
          const isSolo = soloVoice === vKey;
          const isMuted = Boolean(mutedVoices[vKey]);
          return (
            <div
              key={voice}
              title={isAssigned ? undefined : "Not assigned in score"}
              className={`grid grid-cols-1 sm:grid-cols-12 items-center gap-2 rounded-lg border border-[#27273A] bg-[#09090F] px-3 py-2 text-xs ${
                isAssigned ? "" : "opacity-55"
              }`}
            >
              <div className="sm:col-span-2">
                <div className="font-semibold text-[#F5F3FF]">{voice}</div>
                {!isAssigned && (
                  <div className="text-[10px] text-[#71717A]">Not assigned in score</div>
                )}
              </div>
              <div className="sm:col-span-2 flex items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={isSolo}
                  disabled={!isAssigned}
                  onClick={() => setSoloVoice(isSolo ? null : vKey)}
                  className={`rounded px-2 py-1 text-[11px] font-medium border disabled:opacity-40 disabled:pointer-events-none ${
                    isSolo
                      ? "bg-[#8B5CF6] border-[#A78BFA] text-white"
                      : "bg-[#11111B] border-[#27273A] text-[#A1A1AA]"
                  }`}
                >
                  Solo
                </button>
                <button
                  type="button"
                  aria-pressed={isMuted}
                  disabled={!isAssigned}
                  onClick={() => setMutedVoices((prev) => ({ ...prev, [vKey]: !prev[vKey] }))}
                  className={`rounded px-2 py-1 text-[11px] font-medium border disabled:opacity-40 disabled:pointer-events-none ${
                    isMuted
                      ? "bg-red-500/20 border-red-500/40 text-red-300"
                      : "bg-[#11111B] border-[#27273A] text-[#A1A1AA]"
                  }`}
                >
                  Mute
                </button>
              </div>
              <div className="sm:col-span-3 flex items-center gap-2">
                <Volume2 className="h-3.5 w-3.5 text-[#A1A1AA] shrink-0" />
                <input
                  type="range"
                  aria-label={`${voice} Volume`}
                  disabled={!isAssigned}
                  min={0}
                  max={1.5}
                  step={0.05}
                  value={volumes[vKey] ?? 1.0}
                  onChange={(e) =>
                    setVolumes((prev) => ({ ...prev, [vKey]: Number(e.target.value) }))
                  }
                  className="w-full accent-[#8B5CF6] disabled:opacity-40"
                />
              </div>
              <div className="sm:col-span-3">
                <select
                  aria-label={`${voice} Sound`}
                  disabled={!isAssigned}
                  value={instruments[vKey] ?? 0}
                  onChange={(e) =>
                    setInstruments((prev) => ({ ...prev, [vKey]: Number(e.target.value) }))
                  }
                  className="w-full h-8 rounded border border-[#27273A] bg-[#11111B] px-2 text-xs text-[#F5F3FF] disabled:opacity-40"
                >
                  {GM_INSTRUMENT_PRESETS.map((preset) => (
                    <option key={preset.program} value={preset.program}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2 flex items-center justify-end gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!isAssigned || exportingKey !== null}
                  title={isAssigned ? `Download ${voice} MP3` : "Not assigned in score"}
                  onClick={() => handleExport(vKey, "mp3")}
                >
                  {exportingKey === `${vKey}_mp3` ? "..." : "MP3"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!isAssigned || exportingKey !== null}
                  title={isAssigned ? `Download ${voice} WAV` : "Not assigned in score"}
                  onClick={() => handleExport(vKey, "wav")}
                >
                  WAV
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Part Assignment Review */}
      {(scoreData.tracks || []).length > 0 && (
        <div className="rounded-lg border border-[#27273A] bg-[#09090F] p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-[#A1A1AA]">SATB Voice Assignments</span>
            <Button size="sm" variant="secondary" disabled={savingAssignments} onClick={handleSaveAssignments}>
              {savingAssignments ? "Saving..." : "Save Assignments"}
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {(scoreData.tracks || []).map((t) => (
              <label key={t.index} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-[#A1A1AA] truncate" title={t.name}>
                  Part {t.index + 1} ({t.name})
                </span>
                <select
                  aria-label={`Assign Part ${t.index + 1}`}
                  value={assignments[t.index] ?? ""}
                  onChange={(e) =>
                    setAssignments((prev) => ({ ...prev, [t.index]: e.target.value }))
                  }
                  className="h-8 rounded border border-[#27273A] bg-[#11111B] px-2 text-xs text-[#F5F3FF]"
                >
                  <option value="">Unassigned</option>
                  {SATB_VOICES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
