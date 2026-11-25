import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, RotateCcw, Scissors, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  buildTrimmedAudioFilename,
  decodeAudioBufferFromUrl,
  detectSilenceTrimBounds,
  encodePcm16Wav,
  formatTrimSeconds,
  formatTrimTime,
  parseTrimTimeInput,
  sliceAudioBuffer,
  validateTrimBounds,
} from "@/features/editor/audioTrim";
import { api, ApiError } from "@/services/api";
import type { MediaAsset } from "@/types/api";

interface AudioTrimPanelProps {
  projectId: string;
  projectTitle?: string;
  mediaAsset: MediaAsset;
  signedAudioUrl: string | null;
  decodedAudioBuffer: AudioBuffer | null;
  durationSec: number;
  playheadSec: number;
  trimStartSec: number;
  trimEndSec: number;
  isProcessing?: boolean;
  onTrimChange: (startSec: number, endSec: number) => void;
  onSeek?: (sec: number) => void;
  onTrimApplied: (newAsset: MediaAsset, replacedAssetId: string | null) => void;
}

export function AudioTrimPanel({
  projectId,
  projectTitle,
  mediaAsset,
  signedAudioUrl,
  decodedAudioBuffer,
  durationSec,
  playheadSec,
  trimStartSec,
  trimEndSec,
  isProcessing = false,
  onTrimChange,
  onSeek,
  onTrimApplied,
}: AudioTrimPanelProps) {
  const [startText, setStartText] = useState(() => formatTrimTime(trimStartSec));
  const [endText, setEndText] = useState(() => formatTrimTime(trimEndSec));
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const applyingRef = useRef(false);
  const bufferCacheRef = useRef<{ assetId: string; buffer: AudioBuffer } | null>(null);

  useEffect(() => {
    setStartText(formatTrimTime(trimStartSec));
  }, [trimStartSec]);

  useEffect(() => {
    setEndText(formatTrimTime(trimEndSec));
  }, [trimEndSec]);

  useEffect(() => {
    if (decodedAudioBuffer && mediaAsset?.id) {
      bufferCacheRef.current = { assetId: mediaAsset.id, buffer: decodedAudioBuffer };
    }
  }, [decodedAudioBuffer, mediaAsset?.id]);

  useEffect(() => {
    setErrorMessage(null);
    setStatusMessage(null);
    setUploadProgress(null);
  }, [mediaAsset.id]);

  const effectiveDuration =
    (bufferCacheRef.current?.assetId === mediaAsset.id ? bufferCacheRef.current.buffer.duration : 0) ||
    durationSec ||
    mediaAsset.duration_seconds ||
    0;

  const selectedDuration = Math.max(0, trimEndSec - trimStartSec);
  const isDefaultBounds =
    trimStartSec <= 0.05 && Math.abs(trimEndSec - effectiveDuration) <= 0.05;
  const busy = isApplying || isAutoDetecting || isProcessing;

  const ensureDecodedAudio = async (): Promise<AudioBuffer> => {
    if (decodedAudioBuffer) {
      bufferCacheRef.current = { assetId: mediaAsset.id, buffer: decodedAudioBuffer };
      return decodedAudioBuffer;
    }
    if (bufferCacheRef.current?.assetId === mediaAsset.id) {
      return bufferCacheRef.current.buffer;
    }
    const resolvedUrl =
      signedAudioUrl ||
      (await api.getSignedMediaUrl(mediaAsset.id).then((res) => res.url));
    if (!resolvedUrl) {
      throw new Error("Audio stream URL is not available yet. Please wait a moment and try again.");
    }
    const decoded = await decodeAudioBufferFromUrl(resolvedUrl);
    bufferCacheRef.current = { assetId: mediaAsset.id, buffer: decoded };
    return decoded;
  };

  const commitStartInput = () => {
    setErrorMessage(null);
    const parsed = parseTrimTimeInput(startText);
    if (parsed === null) {
      setErrorMessage("Enter Start Time in seconds (e.g. 8.5) or mm:ss (e.g. 00:08.5).");
      return;
    }
    const check = validateTrimBounds(parsed, trimEndSec, effectiveDuration);
    if (!check.valid) {
      setErrorMessage(check.error || "Invalid start time.");
      return;
    }
    const rounded = Math.round(parsed * 100) / 100;
    onTrimChange(rounded, trimEndSec);
    onSeek?.(rounded);
  };

  const commitEndInput = () => {
    setErrorMessage(null);
    const parsed = parseTrimTimeInput(endText);
    if (parsed === null) {
      setErrorMessage("Enter End Time in seconds (e.g. 45.2) or mm:ss (e.g. 00:45.2).");
      return;
    }
    const clampedEnd = Math.min(effectiveDuration, parsed);
    const check = validateTrimBounds(trimStartSec, clampedEnd, effectiveDuration);
    if (!check.valid) {
      setErrorMessage(check.error || "Invalid end time.");
      return;
    }
    const rounded = Math.round(clampedEnd * 100) / 100;
    onTrimChange(trimStartSec, rounded);
  };

  const handleSetStartPlayhead = () => {
    setErrorMessage(null);
    setStatusMessage(null);
    const candidate = Math.max(0, Math.round(playheadSec * 100) / 100);
    const check = validateTrimBounds(candidate, trimEndSec, effectiveDuration);
    if (!check.valid) {
      setErrorMessage(check.error || "Cannot set Start Time after End Time.");
      return;
    }
    onTrimChange(candidate, trimEndSec);
  };

  const handleSetEndPlayhead = () => {
    setErrorMessage(null);
    setStatusMessage(null);
    const candidate = Math.min(effectiveDuration, Math.round(playheadSec * 100) / 100);
    const check = validateTrimBounds(trimStartSec, candidate, effectiveDuration);
    if (!check.valid) {
      setErrorMessage(check.error || "Cannot set End Time before Start Time.");
      return;
    }
    onTrimChange(trimStartSec, candidate);
  };

  const handleAutoTrimSilence = async () => {
    if (busy) return;
    setErrorMessage(null);
    setStatusMessage(null);
    setIsAutoDetecting(true);
    try {
      const buffer = await ensureDecodedAudio();
      const result = detectSilenceTrimBounds(buffer);
      if (result.changed) {
        onTrimChange(result.startSec, result.endSec);
        onSeek?.(result.startSec);
      }
      setStatusMessage(result.reason);
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Unable to analyze audio for silence removal. Original recording is preserved.",
      );
    } finally {
      setIsAutoDetecting(false);
    }
  };

  const handleResetTrim = () => {
    setErrorMessage(null);
    setStatusMessage(null);
    onTrimChange(0, Math.round(effectiveDuration * 1000) / 1000);
  };

  const handleApplyTrim = async () => {
    if (applyingRef.current || busy) return;
    setErrorMessage(null);
    setStatusMessage(null);

    const parsedStart = parseTrimTimeInput(startText);
    const parsedEnd = parseTrimTimeInput(endText);
    const nextStart = parsedStart !== null ? parsedStart : trimStartSec;
    const nextEnd = parsedEnd !== null ? Math.min(effectiveDuration, parsedEnd) : trimEndSec;

    if (parsedStart === null || parsedEnd === null) {
      setErrorMessage("Please enter valid Start and End times before applying trim.");
      return;
    }

    applyingRef.current = true;
    setIsApplying(true);
    setUploadProgress(0);
    try {
      const buffer = await ensureDecodedAudio();
      const bufferDur = buffer.duration || buffer.length / Math.max(1, buffer.sampleRate);
      const check = validateTrimBounds(nextStart, nextEnd, bufferDur);
      if (!check.valid) {
        throw new Error(check.error || "Invalid trim boundaries.");
      }

      const sliced = sliceAudioBuffer(buffer, nextStart, nextEnd);
      const wavBlob = encodePcm16Wav(sliced.channels, sliced.sampleRate);
      const outName = buildTrimmedAudioFilename(mediaAsset.original_filename, projectTitle);
      const trimmedFile = new File([wavBlob], outName, { type: "audio/wav" });

      const newAsset = await api.uploadMedia(
        projectId,
        trimmedFile,
        (pct) => setUploadProgress(pct),
        undefined,
        mediaAsset.id,
      );

      onTrimApplied(newAsset, mediaAsset.id);
      setStatusMessage("Audio trimmed successfully. Ready to transcribe.");
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to trim audio.";
      setErrorMessage(
        msg.toLowerCase().includes("preserved")
          ? msg
          : `${msg} Your original recording was kept intact.`,
      );
    } finally {
      applyingRef.current = false;
      setIsApplying(false);
      setUploadProgress(null);
    }
  };

  return (
    <div
      data-testid="audio-trim-panel"
      className="rounded-xl border border-stone-200 bg-stone-50/90 p-3 sm:p-4 space-y-3 text-xs dark:border-[#27273A] dark:bg-[#11111B]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Scissors className="h-4 w-4 text-violet-600 dark:text-[#A78BFA] shrink-0" />
          <h3 className="text-sm font-semibold text-stone-900 dark:text-[#F5F3FF]">Audio Trim</h3>
          <span className="text-[11px] text-stone-600 dark:text-[#A1A1AA]">
            Trim leading/trailing silence before transcribing
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-stone-600 dark:text-[#A1A1AA]">Selected Duration:</span>
          <span
            data-testid="trim-selected-duration"
            className="font-mono font-semibold tabular-nums text-violet-700 dark:text-[#A78BFA]"
          >
            {formatTrimTime(selectedDuration)} ({formatTrimSeconds(selectedDuration)})
          </span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {/* Start Time */}
        <div className="space-y-1.5 min-w-0">
          <label
            htmlFor="trim-start-input"
            className="block text-xs font-medium text-stone-700 dark:text-[#A1A1AA]"
          >
            Start Time (sec or mm:ss)
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="trim-start-input"
              aria-label="Start Time"
              type="text"
              value={startText}
              disabled={busy}
              onChange={(e) => setStartText(e.target.value)}
              onBlur={commitStartInput}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitStartInput();
                }
              }}
              placeholder="00:00.0 or 8.5"
              className="min-w-0 flex-1 h-9 rounded-lg border border-stone-300 bg-white px-2.5 font-mono text-xs text-stone-900 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/20 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || effectiveDuration <= 0}
              onClick={handleSetStartPlayhead}
            >
              Set Start to Playhead
            </Button>
          </div>
        </div>

        {/* End Time */}
        <div className="space-y-1.5 min-w-0">
          <label
            htmlFor="trim-end-input"
            className="block text-xs font-medium text-stone-700 dark:text-[#A1A1AA]"
          >
            End Time (sec or mm:ss)
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="trim-end-input"
              aria-label="End Time"
              type="text"
              value={endText}
              disabled={busy}
              onChange={(e) => setEndText(e.target.value)}
              onBlur={commitEndInput}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEndInput();
                }
              }}
              placeholder="00:30.0 or 30.0"
              className="min-w-0 flex-1 h-9 rounded-lg border border-stone-300 bg-white px-2.5 font-mono text-xs text-stone-900 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/20 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || effectiveDuration <= 0}
              onClick={handleSetEndPlayhead}
            >
              Set End to Playhead
            </Button>
          </div>
        </div>
      </div>

      {/* Action Row */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || effectiveDuration <= 0}
            onClick={() => void handleAutoTrimSilence()}
          >
            {isAutoDetecting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 text-violet-600 dark:text-[#A78BFA]" />
            )}
            {isAutoDetecting ? "Analyzing Silence..." : "Auto-Trim Silence"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy || isDefaultBounds}
            onClick={handleResetTrim}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset Trim
          </Button>
        </div>

        <Button
          type="button"
          size="sm"
          disabled={busy || effectiveDuration <= 0}
          onClick={() => void handleApplyTrim()}
        >
          {isApplying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Scissors className="h-3.5 w-3.5" />
          )}
          {isApplying
            ? uploadProgress !== null
              ? `Applying Trim (${uploadProgress}%)...`
              : "Applying Trim..."
            : "Apply Trim"}
        </Button>
      </div>

      {statusMessage && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-2.5 text-xs text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
          <span>{statusMessage}</span>
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-2.5 text-xs text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
          <span>{errorMessage}</span>
        </div>
      )}
    </div>
  );
}
