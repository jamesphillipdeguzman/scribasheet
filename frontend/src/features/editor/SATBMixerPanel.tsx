import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, Loader2, Play, Square, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { api, ApiError } from "@/services/api";
import type { ScoreData } from "@/types/api";

interface SATBMixerPanelProps {
  projectId: string;
  projectTitle: string;
  scoreData: ScoreData;
  onScoreUpdated?: (score: ScoreData, version: number, musicxml: string | null) => void;
}

const SATB_VOICES = ["Soprano", "Alto", "Tenor", "Bass"] as const;

export function SATBMixerPanel({
  projectId,
  projectTitle,
  scoreData,
  onScoreUpdated,
}: SATBMixerPanelProps) {
  const [soloVoice, setSoloVoice] = useState<string | null>(null);
  const [mutedVoices, setMutedVoices] = useState<Record<string, boolean>>({});
  const [volumes, setVolumes] = useState<Record<string, number>>({
    soprano: 1.0,
    alto: 1.0,
    tenor: 1.0,
    bass: 1.0,
  });
  const [instruments, setInstruments] = useState<Record<string, number>>({
    soprano: 52,
    alto: 52,
    tenor: 52,
    bass: 52,
  });
  const [tempoBpm, setTempoBpm] = useState<number>(Math.round(scoreData.tempo_bpm || 100));
  const [startMeasure, setStartMeasure] = useState<number>(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [exportingKey, setExportingKey] = useState<string | null>(null);
  const [savingAssignments, setSavingAssignments] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const stopTimerRef = useRef<number | null>(null);

  const satbMeta = (scoreData.analysis?.satb as {
    needs_review?: boolean;
    warnings?: string[];
    assignments?: Array<{ part_index: number; source_label: string; assigned_voice: string; uncertain?: boolean }>;
  }) || {};

  const [assignments, setAssignments] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    for (const t of scoreData.tracks || []) {
      init[t.index] = SATB_VOICES.includes(t.name as (typeof SATB_VOICES)[number]) ? t.name : "Soprano";
    }
    return init;
  });

  useEffect(() => {
    setTempoBpm(Math.round(scoreData.tempo_bpm || 100));
  }, [scoreData.tempo_bpm]);

  useEffect(() => {
    return () => {
      if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
      if (audioCtxRef.current) {
        void audioCtxRef.current.close();
      }
    };
  }, []);

  const isVoiceAudible = (voiceKey: string) => {
    if (soloVoice !== null) return soloVoice === voiceKey;
    return !mutedVoices[voiceKey];
  };

  const stopPlayback = () => {
    if (stopTimerRef.current) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
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
    const ctx = new AudioCtx();
    audioCtxRef.current = ctx;
    const baseBpm = Math.max(20, scoreData.tempo_bpm || 100);
    const scale = baseBpm / Math.max(20, tempoBpm);
    const beatsPerBar = Math.max(1, parseInt((scoreData.time_signature || "4/4").split("/")[0] || "4", 10));
    const secPerBar = (60 / Math.max(20, tempoBpm)) * beatsPerBar;
    const offsetSec = Math.max(0, (startMeasure - 1) * secPerBar);

    const trackVoiceMap: Record<number, string> = {};
    for (const t of scoreData.tracks || []) {
      trackVoiceMap[t.index] = (assignments[t.index] || t.name || "Soprano").toLowerCase();
    }

    const now = ctx.currentTime + 0.05;
    let maxEnd = 0.2;

    for (const n of scoreData.notes) {
      const vKey = trackVoiceMap[n.track_index] || "soprano";
      if (!isVoiceAudible(vKey)) continue;
      const s = n.onset_sec * scale - offsetSec;
      const e = n.offset_sec * scale - offsetSec;
      if (e <= 0) continue;
      const startAt = now + Math.max(0, s);
      const dur = Math.max(0.05, e - Math.max(0, s));
      maxEnd = Math.max(maxEnd, Math.max(0, s) + dur);

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const freq = 440 * Math.pow(2, (n.pitch_midi - 69) / 12);
      const isChoir = (instruments[vKey] ?? 52) === 52;
      osc.type = isChoir ? "triangle" : "sine";
      osc.frequency.setValueAtTime(freq, startAt);

      const vol = Math.max(0.01, (volumes[vKey] ?? 1.0) * (n.velocity / 127) * 0.18);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.linearRampToValueAtTime(vol, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + dur + 0.02);
    }

    setIsPlaying(true);
    stopTimerRef.current = window.setTimeout(() => {
      stopPlayback();
    }, Math.ceil((maxEnd + 0.2) * 1000));
  };

  const handleSaveAssignments = async () => {
    setSavingAssignments(true);
    setError(null);
    try {
      const instByIdx: Record<number, number> = {};
      for (const t of scoreData.tracks || []) {
        const vKey = (assignments[t.index] || t.name || "soprano").toLowerCase();
        instByIdx[t.index] = instruments[vKey] ?? 52;
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
          const isSolo = soloVoice === vKey;
          const isMuted = Boolean(mutedVoices[vKey]);
          return (
            <div
              key={voice}
              className="grid grid-cols-1 sm:grid-cols-12 items-center gap-2 rounded-lg border border-[#27273A] bg-[#09090F] px-3 py-2 text-xs"
            >
              <div className="sm:col-span-2 font-semibold text-[#F5F3FF]">{voice}</div>
              <div className="sm:col-span-2 flex items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={isSolo}
                  onClick={() => setSoloVoice(isSolo ? null : vKey)}
                  className={`rounded px-2 py-1 text-[11px] font-medium border ${
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
                  onClick={() => setMutedVoices((prev) => ({ ...prev, [vKey]: !prev[vKey] }))}
                  className={`rounded px-2 py-1 text-[11px] font-medium border ${
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
                  min={0}
                  max={1.5}
                  step={0.05}
                  value={volumes[vKey] ?? 1.0}
                  onChange={(e) =>
                    setVolumes((prev) => ({ ...prev, [vKey]: Number(e.target.value) }))
                  }
                  className="w-full accent-[#8B5CF6]"
                />
              </div>
              <div className="sm:col-span-3">
                <select
                  aria-label={`${voice} Sound`}
                  value={instruments[vKey] ?? 52}
                  onChange={(e) =>
                    setInstruments((prev) => ({ ...prev, [vKey]: Number(e.target.value) }))
                  }
                  className="w-full h-8 rounded border border-[#27273A] bg-[#11111B] px-2 text-xs text-[#F5F3FF]"
                >
                  <option value={52}>Choir Aahs</option>
                  <option value={0}>Piano (Fallback)</option>
                </select>
              </div>
              <div className="sm:col-span-2 flex items-center justify-end gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={exportingKey !== null}
                  onClick={() => handleExport(vKey, "mp3")}
                >
                  {exportingKey === `${vKey}_mp3` ? "..." : "MP3"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={exportingKey !== null}
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
                <span className="text-[#A1A1AA] truncate">Part {t.index + 1}</span>
                <select
                  aria-label={`Assign Part ${t.index + 1}`}
                  value={assignments[t.index] || t.name}
                  onChange={(e) =>
                    setAssignments((prev) => ({ ...prev, [t.index]: e.target.value }))
                  }
                  className="h-8 rounded border border-[#27273A] bg-[#11111B] px-2 text-xs text-[#F5F3FF]"
                >
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
