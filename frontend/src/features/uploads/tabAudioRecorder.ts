export const NO_AUDIO_TRACK_GUIDANCE =
  "No audio track detected. Please try again and enable Share tab audio or Share system audio in the browser prompt.";

export const PREFERRED_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

export interface DisplayAudioSupportResult {
  supported: boolean;
  reason?: string;
}

export function checkDisplayAudioSupport(): DisplayAudioSupportResult {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getDisplayMedia !== "function"
  ) {
    return {
      supported: false,
      reason:
        "Tab / system audio recording is not supported in this browser or context. Use a desktop Chromium browser (Chrome or Edge) or Firefox over HTTPS or localhost, or upload an audio/video file instead.",
    };
  }
  if (typeof MediaRecorder === "undefined") {
    return {
      supported: false,
      reason:
        "MediaRecorder is unavailable in this browser, so live tab/system audio recording cannot run. Please upload an audio or video file instead.",
    };
  }
  return { supported: true };
}

export function selectSupportedAudioMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  for (const candidate of PREFERRED_AUDIO_MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore browser-specific MIME probe errors
    }
  }
  return "";
}

export function resolveAudioFormatFromMime(rawMime: string | null | undefined): {
  mimeType: string;
  extension: string;
} {
  const cleaned = (rawMime || "").trim();
  const lower = cleaned.toLowerCase();

  if (lower.includes("webm")) {
    const normalized = lower.startsWith("video/webm")
      ? `audio/webm${cleaned.slice("video/webm".length)}`
      : cleaned || "audio/webm";
    return { mimeType: normalized, extension: "webm" };
  }
  if (lower.includes("ogg")) {
    const normalized = lower.startsWith("video/ogg")
      ? `audio/ogg${cleaned.slice("video/ogg".length)}`
      : cleaned || "audio/ogg";
    return { mimeType: normalized, extension: "ogg" };
  }
  if (lower.includes("mp4") || lower.includes("aac")) {
    const normalized = lower.startsWith("video/mp4")
      ? `audio/mp4${cleaned.slice("video/mp4".length)}`
      : cleaned || "audio/mp4";
    return { mimeType: normalized, extension: "m4a" };
  }
  if (lower.includes("wav")) {
    return { mimeType: "audio/wav", extension: "wav" };
  }
  return { mimeType: "audio/webm", extension: "webm" };
}

export function classifyDisplayMediaError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : "";
  if (message === NO_AUDIO_TRACK_GUIDANCE) {
    return NO_AUDIO_TRACK_GUIDANCE;
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Screen or tab sharing permission was denied. Please allow sharing and enable Share tab audio or Share system audio to record.";
  }
  if (name === "AbortError" || name === "NotFoundError") {
    return "Tab or system audio capture was cancelled before starting.";
  }
  if (name === "NotSupportedError") {
    return "This browser does not support capturing tab or system audio.";
  }
  if (name === "NotReadableError") {
    return "Could not access the selected tab or system audio source. Please try again.";
  }
  return message || "Unable to start tab or system audio capture. Please check browser permissions and try again.";
}

export function encodeAudioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = numFrames * blockAlign;
  const wavBuffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(wavBuffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([wavBuffer], { type: "audio/wav" });
}

export async function decodeBlobToWav(blob: Blob): Promise<Blob> {
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("Web Audio API is unavailable to convert recording to WAV.");
  }
  const ctx = new AudioCtx();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    return encodeAudioBufferToWav(audioBuffer);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

export interface TabAudioCaptureCallbacks {
  onLevel?: (level: number) => void;
  onComplete: (file: File, info: { mimeType: string; extension: string }) => void;
  onError: (message: string) => void;
}

export interface TabAudioCaptureSession {
  mimeType: string;
  hasLevelMeter: boolean;
  stop: () => void;
  dispose: () => void;
}

export async function startTabAudioCapture(
  callbacks: TabAudioCaptureCallbacks,
): Promise<TabAudioCaptureSession> {
  const support = checkDisplayAudioSupport();
  if (!support.supported) {
    throw new Error(support.reason || "Tab / system audio recording is not supported in this browser.");
  }

  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });

  const audioTracks = displayStream.getAudioTracks();
  if (audioTracks.length === 0) {
    displayStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // ignore cleanup error
      }
    });
    throw new Error(NO_AUDIO_TRACK_GUIDANCE);
  }

  const audioOnlyStream = new MediaStream(audioTracks);
  const selectedMime = selectSupportedAudioMimeType();

  let recorder: MediaRecorder;
  try {
    recorder = selectedMime
      ? new MediaRecorder(audioOnlyStream, { mimeType: selectedMime })
      : new MediaRecorder(audioOnlyStream);
  } catch {
    try {
      recorder = new MediaRecorder(audioOnlyStream);
    } catch (err) {
      displayStream.getTracks().forEach((t) => t.stop());
      throw err;
    }
  }

  const chunks: Blob[] = [];
  let stopRequested = false;
  let disposed = false;
  let errored = false;
  let rafId: number | null = null;
  let audioCtx: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let hasLevelMeter = false;

  const trackEndedHandlers: Array<{ track: MediaStreamTrack; handler: () => void }> = [];

  const cleanupResources = () => {
    if (rafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    for (const { track, handler } of trackEndedHandlers) {
      track.removeEventListener?.("ended", handler);
    }
    trackEndedHandlers.length = 0;

    try {
      sourceNode?.disconnect();
    } catch {
      // ignore
    }
    try {
      analyser?.disconnect();
    } catch {
      // ignore
    }
    sourceNode = null;
    analyser = null;

    if (audioCtx) {
      void audioCtx.close().catch(() => undefined);
      audioCtx = null;
    }

    audioOnlyStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // ignore
      }
    });
    displayStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // ignore
      }
    });
  };

  try {
    const AudioCtx =
      typeof window !== "undefined"
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (AudioCtx && typeof AudioCtx === "function") {
      audioCtx = new AudioCtx();
      if (typeof audioCtx.createMediaStreamSource === "function" && typeof audioCtx.createAnalyser === "function") {
        sourceNode = audioCtx.createMediaStreamSource(audioOnlyStream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        sourceNode.connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        hasLevelMeter = true;
        const tick = () => {
          if (disposed || stopRequested || !analyser) return;
          analyser.getByteTimeDomainData(samples);
          let sumSq = 0;
          for (let i = 0; i < samples.length; i++) {
            const norm = (samples[i] - 128) / 128;
            sumSq += norm * norm;
          }
          const rms = Math.sqrt(sumSq / samples.length);
          const scaled = Math.min(1, rms * 3.5);
          callbacks.onLevel?.(scaled);
          if (typeof requestAnimationFrame === "function") {
            rafId = requestAnimationFrame(tick);
          }
        };
        if (typeof requestAnimationFrame === "function") {
          rafId = requestAnimationFrame(tick);
        }
      }
    }
  } catch {
    hasLevelMeter = false;
  }

  const stop = () => {
    if (stopRequested) return;
    stopRequested = true;
    try {
      if (recorder.state !== "inactive") {
        recorder.stop();
      } else {
        cleanupResources();
      }
    } catch {
      cleanupResources();
    }
  };

  const dispose = () => {
    disposed = true;
    stopRequested = true;
    try {
      if (recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.stop();
      }
    } catch {
      // ignore
    }
    cleanupResources();
  };

  displayStream.getTracks().forEach((track) => {
    const onEnded = () => {
      stop();
    };
    track.addEventListener?.("ended", onEnded);
    trackEndedHandlers.push({ track, handler: onEnded });
  });

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  recorder.onerror = () => {
    errored = true;
    cleanupResources();
    if (!disposed) {
      callbacks.onError("Recording stopped due to an audio encoding error. Please try again.");
    }
  };

  recorder.onstop = () => {
    cleanupResources();
    if (disposed || errored) return;
    const totalBytes = chunks.reduce((acc, c) => acc + c.size, 0);
    if (totalBytes <= 0) {
      callbacks.onError("No audio data was captured. Ensure audio is playing in the shared tab and try again.");
      return;
    }
    const rawMime = recorder.mimeType || chunks[0]?.type || selectedMime || "audio/webm";
    const { mimeType, extension } = resolveAudioFormatFromMime(rawMime);
    const blob = new Blob(chunks, { type: mimeType });
    const recordedFile = new File([blob], `tab-audio-${Date.now()}.${extension}`, { type: mimeType });
    callbacks.onComplete(recordedFile, { mimeType, extension });
  };

  recorder.start(250);

  return {
    mimeType: recorder.mimeType || selectedMime || "audio/webm",
    hasLevelMeter,
    stop,
    dispose,
  };
}
