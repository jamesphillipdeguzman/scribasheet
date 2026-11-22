import React, { useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileAudio, Link2, Loader2, Mic, Square, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatBytes, formatDuration } from "@/lib/utils";
import { api, ApiError } from "@/services/api";
import type { MediaAsset } from "@/types/api";

const ACCEPTED_AUDIO_EXTENSIONS = [".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".mp4", ".mov", ".webm"];
const SCORE_EXTENSIONS = [".pdf", ".mxl", ".musicxml"];
const ACCEPTED_EXTENSIONS = [...ACCEPTED_AUDIO_EXTENSIONS, ...SCORE_EXTENSIONS];
const MAX_SIZE_BYTES = 100 * 1024 * 1024;

interface MediaUploaderProps {
  projectId: string;
  existingAssets: MediaAsset[];
  onUploadComplete: (asset: MediaAsset) => void;
  onMediaRemoved?: (assetId: string) => void;
  hasScore?: boolean;
  isProcessing?: boolean;
  acceptPdf?: boolean;
}

export function MediaUploader({
  projectId,
  existingAssets,
  onUploadComplete,
  onMediaRemoved,
  hasScore = false,
  isProcessing = false,
  acceptPdf = false,
}: MediaUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [dragActive, setDragActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSec, setRecordingSec] = useState(0);
  const [externalUrl, setExternalUrl] = useState("");
  const [urlNotice, setUrlNotice] = useState<string | null>(null);
  const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null);
  const [confirmingAssetId, setConfirmingAssetId] = useState<string | null>(null);

  const timerRef = useRef<number | null>(null);

  const performDeleteAsset = async (assetId: string) => {
    setError(null);
    setSelectedFile(null);
    setDeletingAssetId(assetId);
    setConfirmingAssetId(null);
    try {
      await api.deleteMediaAsset(projectId, assetId);
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
    if (isProcessing || uploadProgress !== null || deletingAssetId !== null) return;
    if (hasScore) {
      setConfirmingAssetId(assetId);
      return;
    }
    void performDeleteAsset(assetId);
  };

  const validateAndUpload = async (file: File) => {
    setError(null);
    const ext = "." + (file.name.split(".").pop() || "").toLowerCase();
    const allowed = acceptPdf ? SCORE_EXTENSIONS : ACCEPTED_EXTENSIONS;
    if (!allowed.includes(ext)) {
      setError(
        acceptPdf
          ? `Unsupported file type (${ext}). Supported score formats: .pdf, .mxl, .musicxml.`
          : `Unsupported file type (${ext}). Supported: MP3, WAV, FLAC, M4A, AAC, MP4, MOV, WEBM, PDF, MXL, MUSICXML.`,
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
    const file = e.dataTransfer.files?.[0];
    if (file) validateAndUpload(file);
  };

  const startRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) clearInterval(timerRef.current);
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const recordedFile = new File([blob], `mic-recording-${Date.now()}.webm`, { type: "audio/webm" });
        validateAndUpload(recordedFile);
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

  const originalAssets = existingAssets.filter((a) => a.asset_type === "original");

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
          accept={acceptPdf ? ".pdf,.mxl,.musicxml,application/pdf,application/vnd.recordare.musicxml+xml" : ACCEPTED_EXTENSIONS.join(",")}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) validateAndUpload(f);
            e.target.value = "";
          }}
        />
        <Upload className="mx-auto h-8 w-8 text-[#A78BFA]" />
        <h3 className="mt-3 text-sm font-semibold text-[#F5F3FF]">
          {acceptPdf ? "Drag & drop SATB score (PDF, MXL, MusicXML), or browse" : "Drag & drop audio, video, or sheet music, or browse"}
        </h3>
        <p className="mt-1 text-xs text-[#A1A1AA]">
          {acceptPdf ? "PDF, MXL, MusicXML • Up to 100 MB" : "MP3, WAV, FLAC, M4A, MP4, PDF, MXL, MusicXML • Up to 100 MB"}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()}>
            Choose File
          </Button>
          {!isRecording ? (
            <Button size="sm" variant="outline" onClick={startRecording}>
              <Mic className="h-3.5 w-3.5 text-red-400" />
              Record Microphone
            </Button>
          ) : (
            <Button size="sm" variant="danger" onClick={stopRecording}>
              <Square className="h-3.5 w-3.5" />
              Stop Recording ({formatDuration(recordingSec)})
            </Button>
          )}
        </div>
      </div>

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
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p>{error}</p>
            {selectedFile && (
              <button
                type="button"
                onClick={() => validateAndUpload(selectedFile)}
                className="mt-1 underline text-[#F5F3FF]"
              >
                Retry Upload
              </button>
            )}
          </div>
        </div>
      )}

      {originalAssets.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-[#A1A1AA]">Uploaded Media</div>
          {originalAssets.map((a) => {
            const isDeleting = deletingAssetId === a.id;
            const removeDisabled = isProcessing || uploadProgress !== null || deletingAssetId !== null;
            return (
              <div key={a.id} className="space-y-2">
                <div className="flex items-center justify-between gap-2 rounded-lg border border-[#27273A] bg-[#11111B] px-3 py-2 text-xs">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FileAudio className="h-4 w-4 text-[#A78BFA] shrink-0" />
                    <div className="truncate">
                      <div className="font-medium text-[#F5F3FF] truncate">{a.original_filename}</div>
                      <div className="text-[#A1A1AA]">
                        {formatBytes(a.size_bytes)} • {formatDuration(a.duration_seconds)} • {a.sample_rate ? `${a.sample_rate} Hz` : a.mime_type}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                    <button
                      type="button"
                      aria-label="Remove uploaded media"
                      title="Remove file"
                      disabled={removeDisabled}
                      onClick={() => handleRemoveClick(a.id)}
                      className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-lg text-[#A1A1AA] transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isDeleting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <X className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
                {confirmingAssetId === a.id && (
                  <div
                    role="alertdialog"
                    aria-label="Confirm audio removal"
                    className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200 space-y-2"
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
          <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5">
            {urlNotice}
          </p>
        )}
      </form>
    </div>
  );
}
