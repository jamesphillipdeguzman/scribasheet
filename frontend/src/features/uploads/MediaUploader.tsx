import React, { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileAudio,
  FileText,
  FileVideo,
  Link2,
  Loader2,
  Mic,
  Monitor,
  Scissors,
  Square,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  checkDisplayAudioSupport,
  classifyDisplayMediaError,
  resolveAudioFormatFromMime,
  selectSupportedAudioMimeType,
  startTabAudioCapture,
  type TabAudioCaptureSession,
} from "@/features/uploads/tabAudioRecorder";
import {
  buildRecordedAudioFilename,
  formatBytes,
  formatDuration,
  isScoreMediaAsset,
  isVideoMediaAsset,
  sanitizeDownloadTitle,
} from "@/lib/utils";
import { api, ApiError } from "@/services/api";
import type { ExtractAudioResponse, MediaAsset } from "@/types/api";

const ACCEPTED_AUDIO_EXTENSIONS = [
  ".mp3",
  ".wav",
  ".flac",
  ".m4a",
  ".aac",
  ".ogg",
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
];
const SCORE_EXTENSIONS = [".pdf", ".mxl", ".musicxml"];
const ACCEPTED_EXTENSIONS = [...ACCEPTED_AUDIO_EXTENSIONS, ...SCORE_EXTENSIONS];
const MAX_SIZE_BYTES = 100 * 1024 * 1024;

export function getUploadedFormatBadge(asset: MediaAsset): { label: string; isScore: boolean } {
  const filename = (asset.original_filename || "").trim();
  const isScore = isScoreMediaAsset(asset);
  if (/^mic-recording-/i.test(filename)) {
    return { label: "MIC RECORDING", isScore: false };
  }
  if (/^tab-audio-/i.test(filename)) {
    return { label: "TAB AUDIO", isScore: false };
  }
  const extMatch = filename.match(/\.([a-z0-9]+)$/i);
  if (extMatch) {
    return { label: extMatch[1].toUpperCase(), isScore };
  }
  const mime = (asset.mime_type || "").toLowerCase();
  if (mime.includes("pdf")) return { label: "PDF", isScore: true };
  if (mime.includes("musicxml") || mime.includes("xml")) return { label: "MUSICXML", isScore: true };
  if (mime.includes("mpeg") || mime.includes("mp3")) return { label: "MP3", isScore: false };
  if (mime.includes("wav")) return { label: "WAV", isScore: false };
  if (mime.includes("flac")) return { label: "FLAC", isScore: false };
  if (mime.includes("matroska") || mime.includes("mkv")) return { label: "MKV", isScore: false };
  if (mime.includes("quicktime")) return { label: "MOV", isScore: false };
  if (mime.includes("mp4")) return { label: "MP4", isScore: false };
  if (mime.includes("webm")) return { label: "WEBM", isScore: false };
  const sub = mime.split("/")[1]?.split(";")[0]?.toUpperCase();
  return { label: sub || (isScore ? "SCORE" : "AUDIO"), isScore };
}

interface MediaUploaderProps {
  projectId: string;
  projectTitle?: string;
  existingAssets: MediaAsset[];
  onUploadComplete: (asset: MediaAsset) => void;
  onMediaRemoved?: (assetId: string) => void;
  selectedSourceAssetId?: string | null;
  onSelectSourceAsset?: (assetId: string) => void;
  onAudioExtracted?: () => void;
  hasScore?: boolean;
  isProcessing?: boolean;
  acceptPdf?: boolean;
}

export function MediaUploader({
  projectId,
  projectTitle,
  existingAssets,
  onUploadComplete,
  onMediaRemoved,
  selectedSourceAssetId,
  onSelectSourceAsset,
  onAudioExtracted,
  hasScore = false,
  isProcessing = false,
  acceptPdf = false,
}: MediaUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tabSessionRef = useRef<TabAudioCaptureSession | null>(null);
  const tabTimerRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const extractingRef = useRef<boolean>(false);
  const startingTabRef = useRef<boolean>(false);

  const [dragActive, setDragActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [recordingSec, setRecordingSec] = useState(0);

  const [isRequestingTabAudio, setIsRequestingTabAudio] = useState(false);
  const [isRecordingTabAudio, setIsRecordingTabAudio] = useState(false);
  const [tabRecordingSec, setTabRecordingSec] = useState(0);
  const [tabInputLevel, setTabInputLevel] = useState(0);
  const [tabHasLevelMeter, setTabHasLevelMeter] = useState(false);

  const [extractingAssetId, setExtractingAssetId] = useState<string | null>(null);
  const [extractionError, setExtractionError] = useState<string | null>(null);
  const [extractedResults, setExtractedResults] = useState<Record<string, ExtractAudioResponse>>({});
  const [downloadingAssetId, setDownloadingAssetId] = useState<string | null>(null);

  const [externalUrl, setExternalUrl] = useState("");
  const [urlNotice, setUrlNotice] = useState<string | null>(null);
  const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null);
  const [confirmingAssetId, setConfirmingAssetId] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (tabTimerRef.current) clearInterval(tabTimerRef.current);
      tabSessionRef.current?.dispose();
      tabSessionRef.current = null;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        try {
          mediaRecorderRef.current.ondataavailable = null;
          mediaRecorderRef.current.onstop = null;
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    };
  }, []);

  const performDeleteAsset = async (assetId: string) => {
    setError(null);
    setExtractionError(null);
    setSelectedFile(null);
    setDeletingAssetId(assetId);
    setConfirmingAssetId(null);
    try {
      await api.deleteMediaAsset(projectId, assetId);
      setExtractedResults((prev) => {
        if (!(assetId in prev)) return prev;
        const copy = { ...prev };
        delete copy[assetId];
        return copy;
      });
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      onMediaRemoved?.(assetId);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Failed to remove audio file. Please try again.");
      }
    } finally {
      setDeletingAssetId(null);
    }
  };

  const handleRemoveClick = (assetId: string) => {
    if (isProcessing || uploadProgress !== null || deletingAssetId !== null || extractingAssetId !== null) return;
    if (hasScore) {
      setConfirmingAssetId(assetId);
      return;
    }
    void performDeleteAsset(assetId);
  };

  const validateAndUpload = async (file: File) => {
    setError(null);
    setExtractionError(null);
    const ext = "." + (file.name.split(".").pop() || "").toLowerCase();
    const allowed = acceptPdf ? SCORE_EXTENSIONS : ACCEPTED_EXTENSIONS;
    if (!allowed.includes(ext)) {
      setError(
        acceptPdf
          ? `Unsupported file type (${ext}). Supported score formats: .pdf, .mxl, .musicxml.`
          : `Unsupported file type (${ext}). Supported: MP3, WAV, FLAC, M4A, AAC, OGG, MP4, MOV, WEBM, MKV, PDF, MXL, MUSICXML.`,
      );
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError("File exceeds 100 MB upload limit.");
      return;
    }

    setSelectedFile(file);
    setUploadProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const asset = await api.uploadMedia(projectId, file, setUploadProgress, controller.signal);
      setUploadProgress(null);
      setSelectedFile(null);
      onUploadComplete(asset);
    } catch (err) {
      setUploadProgress(null);
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Upload failed. You can retry with the same file.");
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (isRecording || isRecordingTabAudio || isRequestingTabAudio || uploadProgress !== null) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void validateAndUpload(file);
  };

  const startRecording = async () => {
    if (isRecording || isRecordingTabAudio || isRequestingTabAudio || uploadProgress !== null) return;
    setError(null);
    try {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
        setError("Microphone access is unavailable in this browser.");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const preferredMime = selectSupportedAudioMimeType();
      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
        if (timerRef.current) clearInterval(timerRef.current);
        setIsRecording(false);
        const totalBytes = chunksRef.current.reduce((sum, b) => sum + b.size, 0);
        if (totalBytes <= 0) {
          setError("No microphone audio was captured. Please try again.");
          return;
        }
        const rawMime = recorder.mimeType || chunksRef.current[0]?.type || preferredMime || "audio/webm";
        const { mimeType, extension } = resolveAudioFormatFromMime(rawMime);
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const recordedFile = new File(
          [blob],
          buildRecordedAudioFilename("mic", projectTitle, extension),
          { type: mimeType },
        );
        void validateAndUpload(recordedFile);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setRecordingSec(0);
      timerRef.current = window.setInterval(() => setRecordingSec((s) => s + 1), 1000);
    } catch {
      setError("Microphone access was denied or is unavailable in this browser.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const finishTabRecordingUi = () => {
    if (tabTimerRef.current) {
      clearInterval(tabTimerRef.current);
      tabTimerRef.current = null;
    }
    tabSessionRef.current = null;
    setIsRecordingTabAudio(false);
    setTabInputLevel(0);
    setTabHasLevelMeter(false);
  };

  const startTabRecording = async () => {
    if (
      startingTabRef.current ||
      isRequestingTabAudio ||
      isRecordingTabAudio ||
      isRecording ||
      uploadProgress !== null
    ) {
      return;
    }

    setError(null);
    const support = checkDisplayAudioSupport();
    if (!support.supported) {
      setError(support.reason || "Tab / system audio recording is not supported in this browser.");
      return;
    }

    startingTabRef.current = true;
    setIsRequestingTabAudio(true);

    try {
      const session = await startTabAudioCapture({
        projectTitle,
        onLevel: (level) => setTabInputLevel(level),
        onComplete: (recordedFile) => {
          finishTabRecordingUi();
          void validateAndUpload(recordedFile);
        },
        onError: (msg) => {
          finishTabRecordingUi();
          setError(msg);
        },
      });
      tabSessionRef.current = session;
      setTabHasLevelMeter(session.hasLevelMeter);
      setIsRecordingTabAudio(true);
      setTabRecordingSec(0);
      setTabInputLevel(0);
      tabTimerRef.current = window.setInterval(() => setTabRecordingSec((s) => s + 1), 1000);
    } catch (err) {
      finishTabRecordingUi();
      setError(classifyDisplayMediaError(err));
    } finally {
      startingTabRef.current = false;
      setIsRequestingTabAudio(false);
    }
  };

  const stopTabRecording = () => {
    if (!tabSessionRef.current) return;
    tabSessionRef.current.stop();
  };

  const handleExtractAudio = async (videoAssetId: string) => {
    if (extractingRef.current || extractingAssetId !== null || isProcessing || uploadProgress !== null) return;
    extractingRef.current = true;
    setExtractionError(null);
    setExtractingAssetId(videoAssetId);
    try {
      const res = await api.extractVideoAudio(projectId, videoAssetId, ["mp3", "wav"]);
      setExtractedResults((prev) => ({ ...prev, [videoAssetId]: res }));
      const preferredId = res.wav?.id || res.mp3?.id;
      if (preferredId) {
        onSelectSourceAsset?.(preferredId);
      }
      onAudioExtracted?.();
    } catch (err) {
      if (err instanceof ApiError) {
        setExtractionError(err.message);
      } else if (err instanceof Error && err.message) {
        setExtractionError(err.message);
      } else {
        setExtractionError("Failed to extract audio from this video file.");
      }
    } finally {
      extractingRef.current = false;
      setExtractingAssetId(null);
    }
  };

  const handleDownloadAsset = async (assetId: string, filename: string) => {
    if (downloadingAssetId) return;
    setError(null);
    setExtractionError(null);
    setDownloadingAssetId(assetId);
    try {
      await api.downloadMediaAsset(assetId, filename);
    } catch (err) {
      setExtractionError(err instanceof ApiError ? err.message : "Failed to download audio file.");
    } finally {
      setDownloadingAssetId(null);
    }
  };

  const handleUrlCheck = async (e: React.FormEvent) => {
    e.preventDefault();
    setUrlNotice(null);
    if (!externalUrl.trim()) return;
    try {
      const res = await api.checkExternalUrl(externalUrl.trim());
      if (res.is_youtube && res.title) {
        setUrlNotice(`YouTube video: "${res.title}"${res.author_name ? ` (${res.author_name})` : ""} — ${res.reason}`);
      } else {
        setUrlNotice(res.reason);
      }
    } catch (err) {
      setUrlNotice(err instanceof ApiError ? err.message : "Could not check URL.");
    }
  };

  const originalAssets = [...existingAssets]
    .filter((a) => a.asset_type === "original")
    .sort((a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || ""));
  const extractedAssets = existingAssets.filter((a) => a.asset_type === "extracted_audio");

  const hasScoreAsset = originalAssets.some((a) => isScoreMediaAsset(a));
  const selectedIsScore = Boolean(
    selectedFile && isScoreMediaAsset({ original_filename: selectedFile.name, mime_type: selectedFile.type }),
  );
  const isScoreMode = acceptPdf || hasScoreAsset || selectedIsScore;
  const anyRecordingActive = isRecording || isRecordingTabAudio || isRequestingTabAudio;
  const titleBase = sanitizeDownloadTitle(projectTitle);

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
          dragActive ? "border-[#A78BFA] bg-[#A78BFA]/10" : "border-[#27273A] bg-[#09090F]"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={
            acceptPdf
              ? ".pdf,.mxl,.musicxml,application/pdf,application/vnd.recordare.musicxml+xml"
              : ACCEPTED_EXTENSIONS.join(",")
          }
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void validateAndUpload(f);
            e.target.value = "";
          }}
        />
        <Upload className="mx-auto h-8 w-8 text-[#A78BFA]" />
        <h3 className="mt-3 text-sm font-semibold text-[#F5F3FF]">
          {acceptPdf
            ? "Drag & drop SATB score (PDF, MXL, MusicXML), or browse"
            : "Drag & drop audio, video, or sheet music, or browse"}
        </h3>
        <p className="mt-1 text-xs text-[#A1A1AA]">
          {acceptPdf
            ? "PDF, MXL, MusicXML • Up to 100 MB"
            : "MP3, WAV, FLAC, M4A, MP4, MOV, WEBM, MKV, PDF, MXL, MusicXML • Up to 100 MB"}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={anyRecordingActive || uploadProgress !== null}
            onClick={() => fileInputRef.current?.click()}
          >
            Choose File
          </Button>
          {!isScoreMode &&
            (!isRecording ? (
              <Button
                size="sm"
                variant="outline"
                disabled={isRecordingTabAudio || isRequestingTabAudio || uploadProgress !== null}
                onClick={startRecording}
              >
                <Mic className="h-3.5 w-3.5 text-red-500 dark:text-red-400" />
                Record Microphone
              </Button>
            ) : (
              <Button size="sm" variant="danger" onClick={stopRecording}>
                <Square className="h-3.5 w-3.5" />
                Stop Recording ({formatDuration(recordingSec)})
              </Button>
            ))}
          {!isScoreMode &&
            (!isRecordingTabAudio ? (
              <Button
                size="sm"
                variant="outline"
                disabled={isRecording || isRequestingTabAudio || uploadProgress !== null}
                onClick={startTabRecording}
              >
                {isRequestingTabAudio ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#A78BFA]" />
                ) : (
                  <Monitor className="h-3.5 w-3.5 text-[#A78BFA]" />
                )}
                {isRequestingTabAudio ? "Waiting for Browser Prompt..." : "Record Tab / System Audio"}
              </Button>
            ) : (
              <Button size="sm" variant="danger" onClick={stopTabRecording}>
                <Square className="h-3.5 w-3.5" />
                Stop Recording
              </Button>
            ))}
        </div>
      </div>

      {isRequestingTabAudio && (
        <div
          role="status"
          className="rounded-lg border border-violet-300 bg-violet-50 p-3 text-xs text-violet-950 font-medium dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200"
        >
          Select a browser tab or screen in the browser prompt and enable <strong>Share tab audio</strong> or{" "}
          <strong>Share system audio</strong>.
        </div>
      )}

      {isRecordingTabAudio && (
        <div
          data-testid="tab-audio-recording-panel"
          className="rounded-lg border border-red-300 bg-red-50 p-3 space-y-2.5 text-xs dark:border-red-500/40 dark:bg-red-500/10"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold text-red-900 dark:text-red-200">
              <span
                data-testid="tab-audio-recording-indicator"
                aria-hidden="true"
                className="h-2.5 w-2.5 rounded-full bg-red-600 dark:bg-red-400 animate-pulse"
              />
              <span>Recording Tab / System Audio</span>
            </div>
            <span
              data-testid="tab-audio-elapsed"
              className="font-mono font-semibold tabular-nums text-red-900 dark:text-red-200"
            >
              {formatDuration(tabRecordingSec)}
            </span>
          </div>

          {tabHasLevelMeter && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-red-800 dark:text-red-300">
                <span>Input Level</span>
                <span className="font-mono tabular-nums">{Math.round(tabInputLevel * 100)}%</span>
              </div>
              <div
                role="meter"
                aria-label="Audio input level"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(tabInputLevel * 100)}
                className="h-2 w-full rounded-full bg-red-200/80 dark:bg-red-950/70 overflow-hidden"
              >
                <div
                  className="h-full rounded-full bg-red-600 dark:bg-red-400 transition-all duration-75"
                  style={{ width: `${Math.max(4, Math.round(tabInputLevel * 100))}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <Button size="sm" variant="danger" onClick={stopTabRecording}>
              <Square className="h-3.5 w-3.5" />
              Stop Recording
            </Button>
          </div>
        </div>
      )}

      {uploadProgress !== null && (
        <div className="rounded-lg border border-[#27273A] bg-[#11111B] p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="truncate">{selectedFile?.name || "Uploading..."}</span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[#A78BFA]">{uploadProgress}%</span>
              <button
                type="button"
                aria-label="Cancel upload"
                onClick={() => abortRef.current?.abort()}
                className="text-[#A1A1AA] hover:text-red-400"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="h-1.5 w-full rounded-full bg-[#181825] overflow-hidden">
            <div className="h-full bg-[#8B5CF6] transition-all" style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}

      {error && (
        <div
          className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-900 font-medium dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
          role="alert"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p>{error}</p>
            {selectedFile && (
              <button
                type="button"
                onClick={() => void validateAndUpload(selectedFile)}
                className="mt-1 underline text-red-950 dark:text-[#F5F3FF]"
              >
                Retry Upload
              </button>
            )}
          </div>
        </div>
      )}

      {originalAssets.length > 0 && (
        <div className="space-y-2">
          {(() => {
            const primaryBadge = getUploadedFormatBadge(originalAssets[0]);
            return (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-[#A1A1AA]">
                  {hasScoreAsset ? "Uploaded Score" : "Uploaded Media"}
                </span>
                <span
                  data-testid="uploaded-format-badge"
                  className={`border font-semibold text-[11px] px-2 py-0.5 rounded-full uppercase tracking-wide ${
                    primaryBadge.isScore
                      ? "bg-sky-100 text-sky-900 border-sky-300 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/35"
                      : "bg-violet-100 text-violet-900 border-violet-300 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/35"
                  }`}
                >
                  {primaryBadge.label}
                </span>
              </div>
            );
          })()}
          {originalAssets.map((a, idx) => {
            const isDeleting = deletingAssetId === a.id;
            const isExtractingThis = extractingAssetId === a.id;
            const removeDisabled =
              isProcessing || uploadProgress !== null || deletingAssetId !== null || extractingAssetId !== null;
            const assetIsScore = isScoreMediaAsset(a);
            const assetIsVideo = isVideoMediaAsset(a);

            const cachedRes = extractedResults[a.id];
            const matchingMp3 =
              extractedAssets.find(
                (ex) =>
                  (ex.mime_type === "audio/mpeg" || ex.original_filename.toLowerCase().endsWith(".mp3")) &&
                  (cachedRes?.mp3?.id === ex.id || idx === 0),
              ) || null;
            const matchingWav =
              extractedAssets.find(
                (ex) =>
                  (ex.mime_type === "audio/wav" || ex.original_filename.toLowerCase().endsWith(".wav")) &&
                  (cachedRes?.wav?.id === ex.id || idx === 0),
              ) || null;

            const mp3Target = cachedRes?.mp3
              ? { id: cachedRes.mp3.id, filename: cachedRes.mp3.filename }
              : matchingMp3
                ? { id: matchingMp3.id, filename: `${titleBase}.mp3` }
                : null;
            const wavTarget = cachedRes?.wav
              ? { id: cachedRes.wav.id, filename: cachedRes.wav.filename }
              : matchingWav
                ? { id: matchingWav.id, filename: `${titleBase}.wav` }
                : null;

            const hasExtractedOutputs = Boolean(mp3Target || wavTarget);
            const preferredExtractedId = wavTarget?.id || mp3Target?.id || null;
            const usingExtractedForTranscription = Boolean(
              selectedSourceAssetId &&
                (selectedSourceAssetId === wavTarget?.id || selectedSourceAssetId === mp3Target?.id),
            );

            return (
              <div key={a.id} className="space-y-2">
                <div className="flex items-center justify-between gap-2 rounded-lg border border-[#27273A] bg-[#11111B] px-3 py-2 text-xs">
                  <div className="flex items-center gap-2.5 min-w-0">
                    {assetIsScore ? (
                      <FileText className="h-4 w-4 text-[#A78BFA] shrink-0" />
                    ) : assetIsVideo ? (
                      <FileVideo className="h-4 w-4 text-[#A78BFA] shrink-0" />
                    ) : (
                      <FileAudio className="h-4 w-4 text-[#A78BFA] shrink-0" />
                    )}
                    <div className="truncate">
                      <div className="font-medium text-[#F5F3FF] truncate">{a.original_filename}</div>
                      <div className="text-[#A1A1AA]">
                        {formatBytes(a.size_bytes)}
                        {!assetIsScore && a.duration_seconds != null ? ` • ${formatDuration(a.duration_seconds)}` : ""}
                        {" • "}
                        {a.sample_rate ? `${a.sample_rate} Hz` : a.mime_type}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span
                      data-testid="uploaded-media-checkmark"
                      className="inline-flex items-center justify-center rounded-full border border-emerald-300 bg-emerald-50 p-0.5 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-400 shrink-0"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.25} />
                    </span>
                    {!assetIsScore && (
                      <button
                        type="button"
                        aria-label="Download uploaded media"
                        title="Download original file"
                        disabled={downloadingAssetId !== null}
                        onClick={() => void handleDownloadAsset(a.id, a.original_filename)}
                        className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-lg text-[#A1A1AA] transition-colors hover:bg-[#181825] hover:text-[#F5F3FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A78BFA] disabled:opacity-50"
                      >
                        {downloadingAssetId === a.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label="Remove uploaded media"
                      title="Remove file"
                      disabled={removeDisabled}
                      onClick={() => handleRemoveClick(a.id)}
                      className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-lg text-[#A1A1AA] transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {assetIsVideo && (
                  <div
                    data-testid="video-audio-extraction-card"
                    className="rounded-lg border border-[#27273A] bg-[#09090F] p-3 space-y-2.5 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-medium text-[#F5F3FF]">Video Audio Extraction</div>
                        <p className="text-[11px] text-[#A1A1AA]">
                          Extract MP3 (192 kbps) &amp; 16-bit WAV while keeping your original video intact.
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={extractingAssetId !== null || isProcessing || uploadProgress !== null}
                        onClick={() => void handleExtractAudio(a.id)}
                      >
                        {isExtractingThis ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Scissors className="h-3.5 w-3.5 text-[#A78BFA]" />
                        )}
                        {isExtractingThis ? "Extracting Audio..." : "Extract Audio"}
                      </Button>
                    </div>

                    {isExtractingThis && (
                      <div
                        role="status"
                        className="flex items-center gap-2 rounded-md border border-violet-300 bg-violet-50 px-2.5 py-2 text-[11px] text-violet-950 font-medium dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200"
                      >
                        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                        <span>Extracting MP3 and 16-bit PCM WAV via FFmpeg...</span>
                      </div>
                    )}

                    {extractionError && (
                      <div
                        role="alert"
                        className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-2.5 py-2 text-[11px] text-red-900 font-medium dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
                      >
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        <span>{extractionError}</span>
                      </div>
                    )}

                    {hasExtractedOutputs && (
                      <div className="space-y-2 border-t border-[#27273A] pt-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {mp3Target && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={downloadingAssetId !== null}
                              onClick={() => void handleDownloadAsset(mp3Target.id, mp3Target.filename)}
                            >
                              {downloadingAssetId === mp3Target.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Download className="h-3.5 w-3.5" />
                              )}
                              Download MP3
                            </Button>
                          )}
                          {wavTarget && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={downloadingAssetId !== null}
                              onClick={() => void handleDownloadAsset(wavTarget.id, wavTarget.filename)}
                            >
                              {downloadingAssetId === wavTarget.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Download className="h-3.5 w-3.5" />
                              )}
                              Download WAV
                            </Button>
                          )}
                        </div>

                        {onSelectSourceAsset && preferredExtractedId && (
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                            {usingExtractedForTranscription ? (
                              <>
                                <span className="font-medium text-emerald-700 dark:text-emerald-400">
                                  Ready for transcription (using extracted audio)
                                </span>
                                <button
                                  type="button"
                                  onClick={() => onSelectSourceAsset(a.id)}
                                  className="underline text-[#A1A1AA] hover:text-[#F5F3FF]"
                                >
                                  Use original video instead
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => onSelectSourceAsset(preferredExtractedId)}
                                className="underline font-medium text-violet-700 hover:text-violet-900 dark:text-[#A78BFA] dark:hover:text-violet-300"
                              >
                                Use Extracted Audio for Transcription
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {confirmingAssetId === a.id && (
                  <div
                    role="alertdialog"
                    aria-label="Confirm audio removal"
                    className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 space-y-2 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                  >
                    <p>Remove this audio file? Your existing sheet music and transcription results will remain available.</p>
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmingAssetId(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        onClick={() => void performDeleteAsset(a.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* External Video URL Check */}
      {!isScoreMode && (
        <form onSubmit={handleUrlCheck} className="pt-2 border-t border-[#27273A] space-y-2">
          <label className="block text-xs font-medium text-[#A1A1AA]">External Media URL (Optional Check)</label>
          <div className="flex gap-2">
            <input
              type="url"
              placeholder="https://..."
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
              className="flex-1 h-9 rounded-lg border border-[#27273A] bg-[#09090F] px-3 text-xs text-[#F5F3FF] placeholder:text-[#52526B]"
            />
            <Button type="submit" size="sm" variant="outline">
              <Link2 className="h-3.5 w-3.5" />
              Check
            </Button>
          </div>
          {urlNotice && (
            <p className="text-xs text-amber-950 bg-amber-50 border border-amber-300 rounded-lg p-2.5 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/20">
              {urlNotice}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
