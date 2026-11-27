import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Circle, Keyboard, Mic, MicOff, Piano, Radio, Square, Volume2, VolumeX } from "lucide-react";
import { clampKeyFifths, spellMidiPitch } from "@/lib/keySignature";
import { createLivePitchNoteTracker, type LivePitchFrameResult } from "@/utils/livePitchNoteTracker";
import { acquireExclusiveMic, releaseExclusiveMic } from "@/utils/micCoordinator";
import { DEFAULT_TUNER_FFT_SIZE } from "@/utils/pitchTuner";
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
import { extractScoreStructure, getBeatUnitQuarters } from "@/features/editor/musicXmlStructure";
import {
  loadAutoSlursTiesPreference,
  loadMidiMonitorPreference,
  saveAutoSlursTiesPreference,
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
  restInputMode?: boolean;
  selectedTarget: XmlNoteTarget | null;
  metronomeSettings?: MetronomeSettings;
  onMetronomeSettingsChange?: (next: MetronomeSettings) => void;
  onTempoChange?: (nextBpm: number) => void;
  onCommitXml: (nextXml: string, nextTarget?: XmlNoteTarget | null) => void;
}

const CHORD_WINDOW_MS = 45;
const MIC_UI_UPDATE_INTERVAL_MS = 45;

type MicInputStatus = "idle" | "requesting" | "listening" | "error";

interface AudioInputDeviceOption {
  deviceId: string;
  label: string;
}

function extractKeyFifthsFromXml(xml: string | null | undefined): number {
  if (!xml) return 0;
  const match = xml.match(/<fifths>\s*(-?\d+)\s*<\/fifths>/);
  if (!match) return 0;
  return clampKeyFifths(Number.parseInt(match[1], 10));
}

function formatLiveMicError(err: unknown): string {
  const errName =
    err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  if (errName === "NotAllowedError" || errName === "PermissionDeniedError") {
    return "Microphone permission was denied. Allow microphone access in your browser to use Live Mic / Violin Input.";
  }
  if (errName === "NotFoundError" || errName === "DevicesNotFoundError" || errName === "OverconstrainedError") {
    return "No compatible microphone / audio input device was found.";
  }
  if (errName === "NotReadableError" || errName === "TrackStartError") {
    return "Audio input device is currently in use by another application.";
  }
  return err instanceof Error && err.message
    ? err.message
    : "Unable to start microphone audio input in this browser.";
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return win.AudioContext || win.webkitAudioContext || null;
}

export function NotationMidiBar({
  isActiveTab,
  activeXml,
  tempoBpm,
  timeSignature,
  clefMode = "grand",
  activeDuration,
  activeDotted,
  activeVoice,
  restInputMode = false,
  selectedTarget,
  metronomeSettings,
  onMetronomeSettingsChange,
  onTempoChange,
  onCommitXml,
}: NotationMidiBarProps) {
  const [monitorEnabled, setMonitorEnabled] = useState<boolean>(() => loadMidiMonitorPreference());
  const [autoSlursTies, setAutoSlursTies] = useState<boolean>(() => loadAutoSlursTiesPreference());
  const autoSlursTiesRef = useRef(autoSlursTies);
  autoSlursTiesRef.current = autoSlursTies;
  const [stepInputEnabled, setStepInputEnabled] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [countInEnabled, setCountInEnabled] = useState<boolean>(false);
  const [countingIn, setCountingIn] = useState<boolean>(false);
  const [snapMode, setSnapMode] = useState<SnapGridMode>("1/16");
  const [targetStaff, setTargetStaff] = useState<1 | 2>(1);
  const [midiStatusNote, setMidiStatusNote] = useState<string | null>(null);

  // Live Mic / Violin input state
  const [micStatus, setMicStatus] = useState<MicInputStatus>("idle");
  const [micError, setMicError] = useState<string | null>(null);
  const [micDevices, setMicDevices] = useState<AudioInputDeviceOption[]>([]);
  const [selectedMicDeviceId, setSelectedMicDeviceId] = useState<string>("");
  const [micConfidenceThreshold, setMicConfidenceThreshold] = useState<number>(0.8);
  const [micFrame, setMicFrame] = useState<LivePitchFrameResult | null>(null);
  const [micAcceptedLabel, setMicAcceptedLabel] = useState<string | null>(null);

  const micActive = micStatus === "requesting" || micStatus === "listening";
  const micActiveRef = useRef(micActive);
  micActiveRef.current = micActive;
  const recordingUsedMicRef = useRef(false);

  const keyFifths = useMemo(() => extractKeyFifthsFromXml(activeXml), [activeXml]);
  const keyFifthsRef = useRef(keyFifths);
  keyFifthsRef.current = keyFifths;

  const activeXmlRef = useRef(activeXml);
  activeXmlRef.current = activeXml;
  const selectedTargetRef = useRef(selectedTarget);
  selectedTargetRef.current = selectedTarget;
  const onCommitXmlRef = useRef(onCommitXml);
  onCommitXmlRef.current = onCommitXml;
  const stepInputEnabledRef = useRef(stepInputEnabled);
  stepInputEnabledRef.current = stepInputEnabled;
  const isRecordingRef = useRef(isRecording);
  isRecordingRef.current = isRecording;
  const countingInRef = useRef(countingIn);
  countingInRef.current = countingIn;
  const activeDurationRef = useRef(activeDuration);
  activeDurationRef.current = activeDuration;
  const activeDottedRef = useRef(activeDotted);
  activeDottedRef.current = activeDotted;
  const activeVoiceRef = useRef(activeVoice);
  activeVoiceRef.current = activeVoice;
  const restInputModeRef = useRef(restInputMode);
  restInputModeRef.current = restInputMode;
  const monitorEnabledRef = useRef(monitorEnabled);
  monitorEnabledRef.current = monitorEnabled;

  const stepBufferRef = useRef<number[]>([]);
  const stepTimerRef = useRef<number | null>(null);

  const recStartPerfRef = useRef<number>(0);
  const recOpenNotesRef = useRef<Map<number, { onsetSec: number; velocity: number }>>(new Map());
  const recCapturedRef = useRef<RecordedRawNote[]>([]);

  const micSessionTokenRef = useRef(0);
  const micResourcesRef = useRef<{
    audioCtx: AudioContext | null;
    stream: MediaStream | null;
    sourceNode: MediaStreamAudioSourceNode | null;
    analyser: AnalyserNode | null;
    rafId: number | null;
  }>({
    audioCtx: null,
    stream: null,
    sourceNode: null,
    analyser: null,
    rafId: null,
  });
  const micAcceptedTimerRef = useRef<number | null>(null);
  const pitchTrackerRef = useRef(createLivePitchNoteTracker({ confidenceThreshold: 0.8 }));

  useEffect(() => {
    pitchTrackerRef.current.updateConfig({ confidenceThreshold: micConfidenceThreshold });
  }, [micConfidenceThreshold]);

  const flushStepChord = useCallback(() => {
    stepTimerRef.current = null;
    const pitches = Array.from(new Set(stepBufferRef.current));
    stepBufferRef.current = [];
    if (pitches.length === 0 || !activeXmlRef.current) return;

    const effectiveStaff: 1 | 2 = clefMode === "bass" ? 2 : targetStaff;
    const res = insertStepMidiNotesIntoXml(activeXmlRef.current, {
      pitchesMidi: restInputMode ? [] : pitches,
      durationType: activeDuration,
      dotted: activeDotted,
      isRest: restInputMode,
      voice: activeVoice,
      staffNumber: effectiveStaff,
      cursorTarget: selectedTargetRef.current,
    });
    if (res) {
      onCommitXml(res.xml, res.nextCursorTarget);
    }
  }, [activeDuration, activeDotted, activeVoice, clefMode, onCommitXml, restInputMode, targetStaff]);

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
        const effectiveClefMode: PlaygroundClefMode =
          micActiveRef.current || recordingUsedMicRef.current ? "treble" : clefMode;
        const nextXml = mergeLiveMidiRecordingIntoXml(activeXmlRef.current, quantized, {
          tempoBpm,
          timeSignature,
          snapMode,
          clefMode: effectiveClefMode,
          autoSlursTies: autoSlursTiesRef.current,
        });
        if (nextXml) {
          onCommitXml(nextXml, null);
          setMidiStatusNote(`Recorded ${quantized.length} note${quantized.length === 1 ? "" : "s"} to staff.`);
        }
      }
      recordingUsedMicRef.current = false;
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

  const handleNoteOnRef = useRef(handleNoteOn);
  handleNoteOnRef.current = handleNoteOn;
  const handleNoteOffRef = useRef(handleNoteOff);
  handleNoteOffRef.current = handleNoteOff;

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

  const handleMicFrame = useCallback((frame: LivePitchFrameResult) => {
    for (const ev of frame.events) {
      if (ev.type === "noteOn") {
        const spelled = spellMidiPitch(ev.midi, keyFifthsRef.current);
        setMicAcceptedLabel(spelled.label);
        if (micAcceptedTimerRef.current !== null && typeof window !== "undefined") {
          window.clearTimeout(micAcceptedTimerRef.current);
        }
        if (typeof window !== "undefined") {
          micAcceptedTimerRef.current = window.setTimeout(() => {
            setMicAcceptedLabel(null);
          }, 900);
        }

        if (isRecordingRef.current && !countingInRef.current) {
          recordingUsedMicRef.current = true;
          handleNoteOnRef.current(ev.midi, ev.velocity);
        } else if (stepInputEnabledRef.current && activeXmlRef.current) {
          if (monitorEnabledRef.current) {
            midiSynth.startSustainedNote(ev.midi, ev.velocity, 0.85, 0);
          }
          const res = insertStepMidiNotesIntoXml(activeXmlRef.current, {
            pitchesMidi: restInputModeRef.current ? [] : [ev.midi],
            durationType: activeDurationRef.current,
            dotted: activeDottedRef.current,
            isRest: restInputModeRef.current,
            voice: activeVoiceRef.current,
            staffNumber: 1,
            cursorTarget: selectedTargetRef.current,
          });
          if (res) {
            onCommitXmlRef.current(res.xml, res.nextCursorTarget);
          }
        } else if (monitorEnabledRef.current) {
          midiSynth.startSustainedNote(ev.midi, ev.velocity, 0.85, 0);
        }
      } else if (ev.type === "noteOff") {
        handleNoteOffRef.current(ev.midi);
      }
    }
  }, []);

  const stopMicInput = useCallback((keepError = false) => {
    micSessionTokenRef.current += 1;
    const res = micResourcesRef.current;

    if (res.rafId !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(res.rafId);
      res.rafId = null;
    }

    const flushed = pitchTrackerRef.current.flush(
      typeof performance !== "undefined" ? performance.now() : Date.now(),
    );
    for (const ev of flushed) {
      if (ev.type === "noteOff") {
        handleNoteOffRef.current(ev.midi);
      }
    }
    pitchTrackerRef.current.reset();

    if (res.sourceNode) {
      try {
        res.sourceNode.disconnect();
      } catch {
        // Ignore disconnect error
      }
      res.sourceNode = null;
    }
    if (res.analyser) {
      try {
        res.analyser.disconnect();
      } catch {
        // Ignore disconnect error
      }
      res.analyser = null;
    }
    if (res.stream) {
      for (const track of res.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore track stop error
        }
      }
      res.stream = null;
    }
    if (res.audioCtx) {
      const ctx = res.audioCtx;
      res.audioCtx = null;
      if (ctx.state !== "closed" && typeof ctx.close === "function") {
        try {
          void Promise.resolve(ctx.close()).catch(() => undefined);
        } catch {
          // Ignore close error
        }
      }
    }

    setMicFrame(null);
    setMicAcceptedLabel(null);
    if (!keepError) {
      setMicError(null);
      setMicStatus("idle");
    }
    releaseExclusiveMic("live_mic_input");
  }, []);

  const startMicInput = useCallback(
    async (deviceIdOverride?: string) => {
      stopMicInput(false);
      const myToken = micSessionTokenRef.current;
      setMicError(null);

      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== "function"
      ) {
        setMicStatus("error");
        setMicError(
          "Microphone capture is not supported in this browser. Connect a MIDI controller instead.",
        );
        return;
      }

      const CtxCtor = getAudioContextCtor();
      if (!CtxCtor) {
        setMicStatus("error");
        setMicError("Web Audio API is unavailable in this browser.");
        return;
      }

      acquireExclusiveMic("live_mic_input", () => {
        stopMicInput(false);
      });

      setMicStatus("requesting");
      const targetDeviceId = deviceIdOverride !== undefined ? deviceIdOverride : selectedMicDeviceId;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(targetDeviceId ? { deviceId: { exact: targetDeviceId } } : {}),
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          video: false,
        });
      } catch (err) {
        if (micSessionTokenRef.current !== myToken) return;
        releaseExclusiveMic("live_mic_input");
        setMicStatus("error");
        setMicError(formatLiveMicError(err));
        return;
      }

      if (micSessionTokenRef.current !== myToken) {
        for (const track of stream.getTracks()) {
          try {
            track.stop();
          } catch {
            // Ignore
          }
        }
        return;
      }

      // Refresh audio input device list now that permission has been granted
      if (typeof navigator.mediaDevices.enumerateDevices === "function") {
        try {
          const allDevices = await navigator.mediaDevices.enumerateDevices();
          if (micSessionTokenRef.current === myToken) {
            const audioInputs = allDevices
              .filter((d) => d.kind === "audioinput")
              .map((d, idx) => ({
                deviceId: d.deviceId,
                label: d.label || `Microphone ${idx + 1}`,
              }));
            setMicDevices(audioInputs);
          }
        } catch {
          // Device enumeration failure should not block active mic capture
        }
      }

      try {
        const audioCtx = new CtxCtor();
        if (audioCtx.state === "suspended" && typeof audioCtx.resume === "function") {
          await Promise.resolve(audioCtx.resume()).catch(() => undefined);
        }

        if (micSessionTokenRef.current !== myToken) {
          for (const track of stream.getTracks()) {
            try {
              track.stop();
            } catch {
              // Ignore
            }
          }
          if (audioCtx.state !== "closed" && typeof audioCtx.close === "function") {
            void Promise.resolve(audioCtx.close()).catch(() => undefined);
          }
          return;
        }

        const sourceNode = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = DEFAULT_TUNER_FFT_SIZE;
        analyser.smoothingTimeConstant = 0;
        sourceNode.connect(analyser);

        micResourcesRef.current = {
          audioCtx,
          stream,
          sourceNode,
          analyser,
          rafId: null,
        };
        pitchTrackerRef.current.reset();
        setMicStatus("listening");

        const sampleBuffer = new Float32Array(analyser.fftSize);
        let lastUiUpdateMs = -Infinity;

        const tick = (rafNowMs: number) => {
          if (micSessionTokenRef.current !== myToken) return;
          const activeAnalyser = micResourcesRef.current.analyser;
          const activeCtx = micResourcesRef.current.audioCtx;
          if (!activeAnalyser || !activeCtx) return;

          activeAnalyser.getFloatTimeDomainData(sampleBuffer);
          const nowTs = typeof performance !== "undefined" ? performance.now() : rafNowMs;
          const frame = pitchTrackerRef.current.processSamples(
            sampleBuffer,
            activeCtx.sampleRate,
            nowTs,
          );
          if (frame.events.length > 0) {
            handleMicFrame(frame);
            setMicFrame(frame);
            lastUiUpdateMs = rafNowMs;
          } else if (rafNowMs - lastUiUpdateMs >= MIC_UI_UPDATE_INTERVAL_MS) {
            setMicFrame(frame);
            lastUiUpdateMs = rafNowMs;
          }

          if (micSessionTokenRef.current === myToken) {
            micResourcesRef.current.rafId = window.requestAnimationFrame(tick);
          }
        };

        micResourcesRef.current.rafId = window.requestAnimationFrame(tick);
      } catch (err) {
        for (const track of stream.getTracks()) {
          try {
            track.stop();
          } catch {
            // Ignore
          }
        }
        if (micSessionTokenRef.current !== myToken) return;
        releaseExclusiveMic("live_mic_input");
        setMicStatus("error");
        setMicError(formatLiveMicError(err));
      }
    },
    [handleMicFrame, selectedMicDeviceId, stopMicInput],
  );

  // Prevent duplicate listeners when user switches away from Sheet Music tab or unmounts
  useEffect(() => {
    if (!isActiveTab) {
      if (isRecording || countingIn) {
        stopRecordingInternal(false);
      }
      if (micActiveRef.current) {
        stopMicInput(false);
      }
      midiSynth.stopAllSustainedNotes();
    }
  }, [countingIn, isActiveTab, isRecording, stopMicInput, stopRecordingInternal]);

  useEffect(() => {
    return () => {
      if (stepTimerRef.current !== null) window.clearTimeout(stepTimerRef.current);
      if (micAcceptedTimerRef.current !== null) window.clearTimeout(micAcceptedTimerRef.current);
      stopMicInput(false);
      midiSynth.stopAllSustainedNotes();
      metronomeEngine.stop();
    };
  }, [stopMicInput]);

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
      const structure = extractScoreStructure(activeXmlRef.current, timeSignature);
      metronomeEngine.startCountIn({
        bars: 1,
        bpm: tempoBpm,
        scoreTimeSignature: timeSignature,
        pickupBeats: structure.hasPickup ? structure.pickupBeatsInUnit : 0,
        beatUnitQuarters: getBeatUnitQuarters(structure.baseBeatType),
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
          data-testid="notation-mic-input-btn"
          aria-pressed={micActive}
          title={
            micActive
              ? "Stop Live Mic / Violin Input"
              : "Use acoustic microphone for live Violin-to-Staff input (G3–E7, Treble)"
          }
          onClick={() => {
            if (micActive) {
              stopMicInput(false);
            } else {
              void startMicInput();
            }
          }}
          className={`inline-flex items-center gap-1.5 h-7 rounded-md border px-2.5 text-[11px] font-semibold transition-colors ${
            micActive
              ? "border-emerald-500 bg-emerald-600 text-white hover:bg-emerald-700 dark:border-emerald-400 dark:bg-emerald-600"
              : "border-sky-400/50 bg-sky-50 text-sky-900 hover:bg-sky-100 dark:border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-200 dark:hover:bg-sky-500/25"
          }`}
        >
          {micActive ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          {micActive ? "Stop Mic" : "Mic / Violin Input"}
        </button>

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

        <button
          type="button"
          data-testid="notation-auto-slurs-ties-btn"
          aria-label="Toggle automatic slurs and ties for MIDI recording"
          aria-pressed={autoSlursTies}
          title="When enabled, MIDI recording splits sustained notes across barlines with ties and adds slurs to legato melodic phrases"
          onClick={() => {
            const next = !autoSlursTies;
            setAutoSlursTies(next);
            autoSlursTiesRef.current = next;
            saveAutoSlursTiesPreference(next);
          }}
          className={`inline-flex items-center gap-1 h-7 rounded-md border px-2 text-[11px] font-medium transition-colors ${
            autoSlursTies
              ? "border-violet-400/60 bg-violet-50 text-violet-900 dark:border-violet-500/40 dark:bg-violet-500/20 dark:text-violet-200"
              : "border-stone-300 bg-white text-stone-600 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#A1A1AA]"
          }`}
        >
          Auto Slurs/Ties: {autoSlursTies ? "ON" : "OFF"}
        </button>

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

      {(micActive || micError) && (
        <div
          data-testid="notation-mic-panel"
          className="w-full flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-300/70 bg-sky-50/70 px-2.5 py-1.5 text-[11px] text-sky-950 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100"
        >
          {micError ? (
            <div className="flex w-full items-center justify-between gap-2">
              <span data-testid="notation-mic-error" className="font-medium text-red-700 dark:text-red-300">
                {micError}
              </span>
              <button
                type="button"
                onClick={() => {
                  setMicError(null);
                  setMicStatus("idle");
                }}
                className="h-6 rounded border border-stone-300 bg-white px-2 text-[10px] font-medium text-stone-700 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#C4C4D4]"
              >
                Dismiss
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 font-semibold">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      micStatus === "listening"
                        ? "bg-emerald-500 animate-pulse"
                        : "bg-amber-400 animate-pulse"
                    }`}
                  />
                  {micAcceptedLabel
                    ? `Note Accepted (${micAcceptedLabel})`
                    : micFrame?.state === "stabilizing"
                      ? "Stabilizing..."
                      : micStatus === "requesting"
                        ? "Requesting Mic..."
                        : "Listening (Violin G3–E7 · Treble)"}
                </span>

                <span
                  data-testid="notation-mic-detected-pitch"
                  className="rounded border border-sky-300/80 bg-white/90 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-stone-900 dark:border-sky-500/30 dark:bg-[#181825] dark:text-sky-100"
                >
                  {micFrame?.detectedMidi !== null && micFrame?.detectedMidi !== undefined
                    ? `${spellMidiPitch(micFrame.detectedMidi, keyFifths).label}${
                        micFrame.detectedHz ? ` · ${micFrame.detectedHz.toFixed(1)} Hz` : ""
                      }`
                    : "—"}
                </span>

                <span className="text-[10px] text-sky-900/80 dark:text-sky-200/80">
                  Conf {Math.round((micFrame?.confidence ?? 0) * 100)}%
                </span>

                <span
                  aria-label="Microphone signal level"
                  className="inline-flex h-2 w-14 overflow-hidden rounded-full bg-stone-200 dark:bg-[#27273A]"
                >
                  <span
                    className="h-full bg-emerald-500 transition-all duration-75"
                    style={{
                      width: `${Math.min(100, Math.round((micFrame?.rms ?? 0) * 450))}%`,
                    }}
                  />
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {micDevices.length > 0 && (
                  <select
                    data-testid="notation-mic-device-select"
                    aria-label="Audio input device"
                    value={selectedMicDeviceId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setSelectedMicDeviceId(nextId);
                      if (micActive) {
                        void startMicInput(nextId);
                      }
                    }}
                    className="h-6 max-w-[170px] rounded border border-stone-300 bg-white px-1.5 text-[11px] text-stone-800 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#F5F3FF]"
                  >
                    <option value="">Default Microphone</option>
                    {micDevices.map((dev) => (
                      <option key={dev.deviceId} value={dev.deviceId}>
                        {dev.label}
                      </option>
                    ))}
                  </select>
                )}

                <label className="inline-flex items-center gap-1 text-[10px] text-sky-900/80 dark:text-sky-200/80">
                  Sensitivity
                  <select
                    aria-label="Pitch detection sensitivity"
                    value={String(micConfidenceThreshold)}
                    onChange={(e) => {
                      const nextVal = Number.parseFloat(e.target.value);
                      if (Number.isFinite(nextVal)) {
                        setMicConfidenceThreshold(nextVal);
                      }
                    }}
                    className="h-6 rounded border border-stone-300 bg-white px-1 text-[11px] text-stone-800 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#F5F3FF]"
                  >
                    <option value="0.7">Sensitive (70%)</option>
                    <option value="0.8">Balanced (80%)</option>
                    <option value="0.88">Strict (88%)</option>
                  </select>
                </label>

                <button
                  type="button"
                  data-testid="notation-mic-stop-btn"
                  onClick={() => stopMicInput(false)}
                  className="h-6 rounded border border-red-400/60 bg-red-50 px-2 text-[10px] font-semibold text-red-800 hover:bg-red-100 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-200"
                >
                  Stop Mic
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {(midiStatusNote || webMidi.errorMessage) && (
        <div className="w-full text-[11px] text-violet-800 dark:text-violet-300">
          {webMidi.errorMessage || midiStatusNote}
        </div>
      )}
    </div>
  );
}
