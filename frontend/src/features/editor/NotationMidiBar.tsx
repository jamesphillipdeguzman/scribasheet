import { useCallback, useEffect, useRef, useState } from "react";
import { Circle, Keyboard, Piano, Radio, Square, Volume2, VolumeX } from "lucide-react";
import { metronomeEngine, type MetronomeSettings } from "@/features/editor/metronome";
import {
  buildQuantizedRecordedNotes,
  type RecordedRawNote,
  type SnapGridMode,
} from "@/features/editor/midiRecordingUtils";
import { midiSynth } from "@/features/editor/midiSynth";
import {
  type EditableNoteType,
  insertStepMidiNotesIntoXml,
  mergeLiveMidiRecordingIntoXml,
  type PlaygroundClefMode,
  type XmlNoteTarget,
} from "@/features/editor/musicXmlEditor";
import {
  loadMidiMonitorPreference,
  saveMidiMonitorPreference,
  useWebMidi,
} from "@/features/editor/useWebMidi";

interface NotationMidiBarProps {
  isActiveTab: boolean;
  activeXml: string;
  tempoBpm: number;
  timeSignature: string;
  clefMode?: PlaygroundClefMode;
  activeDuration: EditableNoteType;
  activeDotted: boolean;
  activeVoice: "1" | "2";
  selectedTarget: XmlNoteTarget | null;
  metronomeSettings?: MetronomeSettings;
  onMetronomeSettingsChange?: (next: MetronomeSettings) => void;
  onTempoChange?: (nextBpm: number) => void;
  onCommitXml: (nextXml: string, nextTarget?: XmlNoteTarget | null) => void;
}

const CHORD_WINDOW_MS = 45;

export function NotationMidiBar({
  isActiveTab,
  activeXml,
  tempoBpm,
  timeSignature,
  clefMode = "grand",
  activeDuration,
  activeDotted,
  activeVoice,
  selectedTarget,
  metronomeSettings,
  onMetronomeSettingsChange,
  onTempoChange,
  onCommitXml,
}: NotationMidiBarProps) {
  const [monitorEnabled, setMonitorEnabled] = useState<boolean>(() => loadMidiMonitorPreference());
  const [stepInputEnabled, setStepInputEnabled] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [countInEnabled, setCountInEnabled] = useState<boolean>(false);
  const [countingIn, setCountingIn] = useState<boolean>(false);
  const [snapMode, setSnapMode] = useState<SnapGridMode>("1/16");
  const [targetStaff, setTargetStaff] = useState<1 | 2>(1);
  const [midiStatusNote, setMidiStatusNote] = useState<string | null>(null);

  const activeXmlRef = useRef(activeXml);
  activeXmlRef.current = activeXml;
  const selectedTargetRef = useRef(selectedTarget);
  selectedTargetRef.current = selectedTarget;
  const stepBufferRef = useRef<number[]>([]);
  const stepTimerRef = useRef<number | null>(null);

  const recStartPerfRef = useRef<number>(0);
  const recOpenNotesRef = useRef<Map<number, { onsetSec: number; velocity: number }>>(new Map());
  const recCapturedRef = useRef<RecordedRawNote[]>([]);

  const flushStepChord = useCallback(() => {
    stepTimerRef.current = null;
    const pitches = Array.from(new Set(stepBufferRef.current));
    stepBufferRef.current = [];
    if (pitches.length === 0 || !activeXmlRef.current) return;

    const effectiveStaff: 1 | 2 = clefMode === "bass" ? 2 : targetStaff;
    const res = insertStepMidiNotesIntoXml(activeXmlRef.current, {
      pitchesMidi: pitches,
      durationType: activeDuration,
      dotted: activeDotted,
      voice: activeVoice,
      staffNumber: effectiveStaff,
      cursorTarget: selectedTargetRef.current,
    });
    if (res) {
      onCommitXml(res.xml, res.nextCursorTarget);
    }
  }, [activeDuration, activeDotted, activeVoice, clefMode, onCommitXml, targetStaff]);

  const stopRecordingInternal = useCallback(
    (commit: boolean) => {
      metronomeEngine.stop();
      setCountingIn(false);
      setIsRecording(false);
      midiSynth.stopAllSustainedNotes();

      const nowSec = Math.max(0.05, (performance.now() - recStartPerfRef.current) / 1000);
      for (const [pitch, open] of recOpenNotesRef.current.entries()) {
        recCapturedRef.current.push({
          pitchMidi: pitch,
          velocity: open.velocity,
          onsetSec: open.onsetSec,
          offsetSec: Math.max(open.onsetSec + 0.08, nowSec),
        });
      }
      recOpenNotesRef.current.clear();

      if (commit && recCapturedRef.current.length > 0 && activeXmlRef.current) {
        const quantized = buildQuantizedRecordedNotes(recCapturedRef.current, {
          tempoBpm,
          snapMode,
          targetTrackIndex: 0,
        });
        const nextXml = mergeLiveMidiRecordingIntoXml(activeXmlRef.current, quantized, {
          tempoBpm,
          timeSignature,
          snapMode,
          clefMode,
        });
        if (nextXml) {
          onCommitXml(nextXml, null);
          setMidiStatusNote(`Recorded ${quantized.length} note${quantized.length === 1 ? "" : "s"} to staff.`);
        }
      }
      recCapturedRef.current = [];
    },
    [clefMode, onCommitXml, snapMode, tempoBpm, timeSignature],
  );

  const handleNoteOn = useCallback(
    (pitchMidi: number, velocity: number) => {
      if (!isActiveTab) return;
      if (monitorEnabled) {
        midiSynth.startSustainedNote(pitchMidi, velocity, 0.85, 0);
      }

      if (isRecording && !countingIn) {
        const onsetSec = Math.max(0, (performance.now() - recStartPerfRef.current) / 1000);
        if (recOpenNotesRef.current.has(pitchMidi)) {
          const prev = recOpenNotesRef.current.get(pitchMidi)!;
          recCapturedRef.current.push({
            pitchMidi,
            velocity: prev.velocity,
            onsetSec: prev.onsetSec,
            offsetSec: Math.max(prev.onsetSec + 0.05, onsetSec),
          });
        }
        recOpenNotesRef.current.set(pitchMidi, { onsetSec, velocity });
        return;
      }

      if (stepInputEnabled) {
        stepBufferRef.current.push(pitchMidi);
        if (stepTimerRef.current !== null) {
          window.clearTimeout(stepTimerRef.current);
        }
        stepTimerRef.current = window.setTimeout(flushStepChord, CHORD_WINDOW_MS);
      }
    },
    [countingIn, flushStepChord, isActiveTab, isRecording, monitorEnabled, stepInputEnabled],
  );

  const handleNoteOff = useCallback(
    (pitchMidi: number) => {
      if (!isActiveTab) return;
      if (monitorEnabled) {
        midiSynth.stopSustainedNote(pitchMidi);
      }
      if (isRecording && !countingIn && recOpenNotesRef.current.has(pitchMidi)) {
        const open = recOpenNotesRef.current.get(pitchMidi)!;
        recOpenNotesRef.current.delete(pitchMidi);
        const offsetSec = Math.max(open.onsetSec + 0.06, (performance.now() - recStartPerfRef.current) / 1000);
        recCapturedRef.current.push({
          pitchMidi,
          velocity: open.velocity,
          onsetSec: open.onsetSec,
          offsetSec,
        });
      }
    },
    [countingIn, isActiveTab, isRecording, monitorEnabled],
  );

  const handleControlChange = useCallback(
    (controller: number, value: number) => {
      if (!isActiveTab || !monitorEnabled) return;
      if (controller === 64) {
        midiSynth.setSustainPedal(value >= 64);
      }
    },
    [isActiveTab, monitorEnabled],
  );

  const webMidi = useWebMidi({
    onNoteOn: handleNoteOn,
    onNoteOff: handleNoteOff,
    onControlChange: handleControlChange,
    onDisconnect: () => {
      midiSynth.stopAllSustainedNotes();
    },
  });

  // Prevent duplicate listeners when user switches away from Sheet Music tab or unmounts
  useEffect(() => {
    if (!isActiveTab) {
      if (isRecording || countingIn) {
        stopRecordingInternal(false);
      }
      midiSynth.stopAllSustainedNotes();
    }
  }, [countingIn, isActiveTab, isRecording, stopRecordingInternal]);

  useEffect(() => {
    return () => {
      if (stepTimerRef.current !== null) window.clearTimeout(stepTimerRef.current);
      midiSynth.stopAllSustainedNotes();
      metronomeEngine.stop();
    };
  }, []);

  const startLiveRecording = () => {
    setMidiStatusNote(null);
    recOpenNotesRef.current.clear();
    recCapturedRef.current = [];
    const beginCapture = () => {
      setCountingIn(false);
      setIsRecording(true);
      recStartPerfRef.current = performance.now();
      if (metronomeSettings?.enabled) {
        metronomeEngine.startStandalone({
          bpm: tempoBpm,
          scoreTimeSignature: timeSignature,
          settings: metronomeSettings,
        });
      }
    };

    if (countInEnabled && metronomeSettings) {
      setCountingIn(true);
      setIsRecording(true);
      metronomeEngine.startCountIn({
        bars: 1,
        bpm: tempoBpm,
        scoreTimeSignature: timeSignature,
        settings: { ...metronomeSettings, enabled: true },
        onComplete: beginCapture,
      });
    } else {
      beginCapture();
    }
  };

  const toggleStandaloneMetronome = () => {
    if (!metronomeSettings || !onMetronomeSettingsChange) return;
    const nextEnabled = !metronomeSettings.enabled;
    const nextSettings = { ...metronomeSettings, enabled: nextEnabled };
    onMetronomeSettingsChange(nextSettings);
    if (!isRecording) {
      if (nextEnabled) {
        metronomeEngine.startStandalone({
          bpm: tempoBpm,
          scoreTimeSignature: timeSignature,
          settings: nextSettings,
        });
      } else {
        metronomeEngine.stop();
      }
    }
  };

  const activeDeviceName =
    webMidi.devices.find((d) => d.id === webMidi.selectedDeviceId)?.name || webMidi.devices[0]?.name;

  return (
    <div
      data-testid="notation-midi-bar"
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-300 bg-stone-50 px-3 py-2 text-xs dark:border-[#27273A] dark:bg-[#11111B]"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {webMidi.status === "connected" ? (
          <>
            <span
              data-testid="notation-midi-connected-pill"
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/50 bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-800 dark:text-emerald-300"
            >
              <Keyboard className="h-3.5 w-3.5" />
              {activeDeviceName || "MIDI Connected"}
            </span>
            <button
              type="button"
              onClick={() => {
                webMidi.disconnect();
                midiSynth.stopAllSustainedNotes();
              }}
              className="h-7 rounded-md border border-stone-300 bg-white px-2 text-[11px] font-medium text-stone-700 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#C4C4D4] dark:hover:text-white"
            >
              Disconnect MIDI
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="notation-connect-midi-btn"
            onClick={() => void webMidi.connect()}
            disabled={!webMidi.isSupported}
            title={
              webMidi.isSupported
                ? "Connect external MIDI keyboard (Web MIDI)"
                : "Web MIDI is unavailable in this browser"
            }
            className="inline-flex items-center gap-1.5 h-7 rounded-md border border-violet-400/50 bg-violet-50 px-2.5 text-[11px] font-semibold text-violet-900 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-200 dark:hover:bg-violet-500/25"
          >
            <Piano className="h-3.5 w-3.5" />
            Connect MIDI
          </button>
        )}

        <button
          type="button"
          aria-pressed={monitorEnabled}
          onClick={() => {
            const next = !monitorEnabled;
            setMonitorEnabled(next);
            saveMidiMonitorPreference(next);
            if (!next) midiSynth.stopAllSustainedNotes();
          }}
          className={`inline-flex items-center gap-1 h-7 rounded-md border px-2 text-[11px] font-medium transition-colors ${
            monitorEnabled
              ? "border-emerald-400/50 bg-emerald-50 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300"
              : "border-stone-300 bg-white text-stone-600 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#A1A1AA]"
          }`}
        >
          {monitorEnabled ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
          Monitor
        </button>

        <button
          type="button"
          data-testid="notation-step-input-btn"
          aria-pressed={stepInputEnabled}
          onClick={() => setStepInputEnabled((v) => !v)}
          className={`inline-flex items-center gap-1 h-7 rounded-md border px-2 text-[11px] font-medium transition-colors ${
            stepInputEnabled
              ? "border-violet-500 bg-violet-600 text-white dark:bg-violet-500 dark:border-violet-400"
              : "border-stone-300 bg-white text-stone-700 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#C4C4D4]"
          }`}
        >
          Step Input: {stepInputEnabled ? "ON" : "OFF"}
        </button>

        {isRecording ? (
          <button
            type="button"
            data-testid="notation-stop-record-btn"
            onClick={() => stopRecordingInternal(true)}
            className="inline-flex items-center gap-1 h-7 rounded-md border border-red-500 bg-red-600 px-2.5 text-[11px] font-semibold text-white hover:bg-red-700"
          >
            <Square className="h-3 w-3 fill-current" />
            {countingIn ? "Cancel Count-In" : "Stop & Apply"}
          </button>
        ) : (
          <button
            type="button"
            data-testid="notation-record-midi-btn"
            onClick={startLiveRecording}
            className="inline-flex items-center gap-1 h-7 rounded-md border border-rose-400/60 bg-rose-50 px-2.5 text-[11px] font-semibold text-rose-800 hover:bg-rose-100 dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-200 dark:hover:bg-rose-500/25"
          >
            <Circle className="h-2.5 w-2.5 fill-current" />
            Record MIDI
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {clefMode === "grand" && (
          <select
            aria-label="Step input target staff"
            value={targetStaff}
            onChange={(e) => setTargetStaff(e.target.value === "2" ? 2 : 1)}
            className="h-7 rounded-md border border-stone-300 bg-white px-2 text-[11px] text-stone-800 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#F5F3FF]"
          >
            <option value={1}>Staff 1 (Treble)</option>
            <option value={2}>Staff 2 (Bass)</option>
          </select>
        )}

        <label className="inline-flex items-center gap-1 text-[11px] text-stone-700 dark:text-[#A1A1AA]">
          Grid
          <select
            aria-label="Quantize grid"
            value={snapMode}
            onChange={(e) => setSnapMode(e.target.value as SnapGridMode)}
            className="h-7 rounded-md border border-stone-300 bg-white px-1.5 text-[11px] text-stone-900 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#F5F3FF]"
          >
            <option value="1/16">1/16</option>
            <option value="1/8">1/8</option>
            <option value="off">Free</option>
          </select>
        </label>

        <label className="inline-flex items-center gap-1 text-[11px] text-stone-700 dark:text-[#A1A1AA]">
          BPM
          <input
            type="number"
            aria-label="Notation tempo BPM"
            min={30}
            max={240}
            value={Math.round(tempoBpm)}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v >= 30 && v <= 240) onTempoChange?.(v);
            }}
            className="h-7 w-14 rounded-md border border-stone-300 bg-white px-1.5 text-[11px] text-stone-900 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#F5F3FF]"
          />
        </label>

        {metronomeSettings && onMetronomeSettingsChange && (
          <>
            <button
              type="button"
              aria-pressed={metronomeSettings.enabled}
              onClick={toggleStandaloneMetronome}
              className={`inline-flex items-center gap-1 h-7 rounded-md border px-2 text-[11px] font-medium ${
                metronomeSettings.enabled
                  ? "border-amber-400 bg-amber-100 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/20 dark:text-amber-200"
                  : "border-stone-300 bg-white text-stone-700 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#A1A1AA]"
              }`}
            >
              <Radio className="h-3 w-3" />
              Metronome
            </button>
            <label className="inline-flex items-center gap-1 text-[11px] text-stone-700 dark:text-[#A1A1AA]">
              <input
                type="checkbox"
                checked={countInEnabled}
                onChange={(e) => setCountInEnabled(e.target.checked)}
              />
              Count-in
            </label>
          </>
        )}
      </div>

      {(midiStatusNote || webMidi.errorMessage) && (
        <div className="w-full text-[11px] text-violet-800 dark:text-violet-300">
          {webMidi.errorMessage || midiStatusNote}
        </div>
      )}
    </div>
  );
}
