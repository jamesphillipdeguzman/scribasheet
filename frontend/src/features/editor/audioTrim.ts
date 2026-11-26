export interface SilenceTrimOptions {
  thresholdDb?: number;
  windowMs?: number;
  hopMs?: number;
  minConsecutiveWindows?: number;
  leadingPaddingMs?: number;
  trailingPaddingMs?: number;
  minTrimGainSec?: number;
}

export interface SilenceTrimResult {
  changed: boolean;
  startSec: number;
  endSec: number;
  removedLeadingSec: number;
  removedTrailingSec: number;
  effectiveThresholdDb: number;
  reason: string;
}

export interface TrimValidationResult {
  valid: boolean;
  error?: string;
}

export interface SliceAudioResult {
  channels: Float32Array[];
  sampleRate: number;
  durationSec: number;
  frameCount: number;
  peakAmplitude: number;
}

/**
 * Parse a user-entered time value in seconds (`8.5`, `8.5s`) or clock notation (`mm:ss`, `mm:ss.d`, `hh:mm:ss.d`).
 * Returns null for empty or invalid values.
 */
export function parseTrimTimeInput(input: string): number | null {
  const cleaned = (input || "").trim().toLowerCase().replace(/s$/, "").trim();
  if (!cleaned) return null;

  if (!cleaned.includes(":")) {
    if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
    const val = Number(cleaned);
    return Number.isFinite(val) && val >= 0 ? val : null;
  }

  const parts = cleaned.split(":");
  if (parts.length < 2 || parts.length > 3) return null;

  if (parts.length === 2) {
    const [mStr, sStr] = parts;
    if (!/^\d+$/.test(mStr) || !/^\d+(?:\.\d+)?$/.test(sStr)) return null;
    const mins = Number(mStr);
    const secs = Number(sStr);
    if (!Number.isFinite(mins) || !Number.isFinite(secs) || secs >= 60) return null;
    return mins * 60 + secs;
  }

  const [hStr, mStr, sStr] = parts;
  if (!/^\d+$/.test(hStr) || !/^\d+$/.test(mStr) || !/^\d+(?:\.\d+)?$/.test(sStr)) return null;
  const hrs = Number(hStr);
  const mins = Number(mStr);
  const secs = Number(sStr);
  if (!Number.isFinite(hrs) || !Number.isFinite(mins) || !Number.isFinite(secs) || mins >= 60 || secs >= 60) {
    return null;
  }
  return hrs * 3600 + mins * 60 + secs;
}

export function formatTrimTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00.0";
  const roundedTenths = Math.round(seconds * 10) / 10;
  const hrs = Math.floor(roundedTenths / 3600);
  const remAfterHours = roundedTenths - hrs * 3600;
  const mins = Math.floor(remAfterHours / 60);
  const secs = Math.max(0, remAfterHours - mins * 60);
  const wholeSecs = Math.floor(secs);
  const tenths = Math.min(9, Math.round((secs - wholeSecs) * 10));
  const secStr = `${wholeSecs.toString().padStart(2, "0")}.${tenths}`;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secStr}`;
  }
  return `${mins.toString().padStart(2, "0")}:${secStr}`;
}

export function formatTrimSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  const rounded = Math.round(seconds * 100) / 100;
  const str = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${str}s`;
}

export function validateTrimBounds(startSec: number, endSec: number, durationSec: number): TrimValidationResult {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { valid: false, error: "Audio duration is unavailable for trimming." };
  }
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    return { valid: false, error: "Start time and end time must be valid numbers." };
  }
  if (startSec < 0) {
    return { valid: false, error: "Start time cannot be negative." };
  }
  if (endSec > durationSec + 0.05) {
    return { valid: false, error: `End time cannot exceed total duration (${formatTrimSeconds(durationSec)}).` };
  }
  const clampedEnd = Math.min(endSec, durationSec);
  if (startSec >= clampedEnd) {
    return { valid: false, error: "Start time must be earlier than end time." };
  }
  if (clampedEnd - startSec < 0.2) {
    return { valid: false, error: "Selected trim region must be at least 0.2s long." };
  }
  return { valid: true };
}

/**
 * Analyze decoded AudioBuffer windows in dBFS to locate leading and trailing silence
 * while protecting soft musical openings, sustained tails, and internal pauses/rests.
 */
export function detectSilenceTrimBounds(
  buffer: AudioBuffer,
  options: SilenceTrimOptions = {},
): SilenceTrimResult {
  const duration = Number.isFinite(buffer.duration) && buffer.duration > 0
    ? buffer.duration
    : buffer.length / Math.max(1, buffer.sampleRate);

  const unchanged = (reason: string, threshold = options.thresholdDb ?? -45): SilenceTrimResult => ({
    changed: false,
    startSec: 0,
    endSec: Math.round(duration * 1000) / 1000,
    removedLeadingSec: 0,
    removedTrailingSec: 0,
    effectiveThresholdDb: threshold,
    reason,
  });

  if (!buffer || buffer.length <= 0 || buffer.sampleRate <= 0 || duration < 0.4) {
    return unchanged("Audio is too short to auto-trim silence.");
  }

  const baseThresholdDb = options.thresholdDb ?? -45;
  const windowMs = Math.max(5, options.windowMs ?? 20);
  const hopMs = Math.max(2, options.hopMs ?? 10);
  const minConsecutive = Math.max(1, options.minConsecutiveWindows ?? 4);
  const leadingPaddingSec = Math.min(0.25, Math.max(0.15, (options.leadingPaddingMs ?? 200) / 1000));
  const trailingPaddingSec = Math.min(0.5, Math.max(0.3, (options.trailingPaddingMs ?? 400) / 1000));
  const minTrimGainSec = options.minTrimGainSec ?? 0.25;

  const sr = buffer.sampleRate;
  const winSamples = Math.max(1, Math.round((windowMs / 1000) * sr));
  const hopSamples = Math.max(1, Math.round((hopMs / 1000) * sr));
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  const windowDbs: number[] = [];
  const windowStartsSec: number[] = [];
  const totalSamples = buffer.length;

  if (totalSamples < winSamples) {
    return unchanged("Audio is too short for silence analysis.");
  }

  for (let pos = 0; pos + winSamples <= totalSamples; pos += hopSamples) {
    let maxRms = 0;
    for (let ch = 0; ch < channels.length; ch++) {
      const data = channels[ch];
      let sumSq = 0;
      for (let i = pos; i < pos + winSamples; i++) {
        const s = data[i];
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / winSamples);
      if (rms > maxRms) maxRms = rms;
    }
    const db = maxRms > 1e-8 ? 20 * Math.log10(maxRms) : -120;
    windowDbs.push(db);
    windowStartsSec.push(pos / sr);
  }

  if (windowDbs.length < minConsecutive) {
    return unchanged("Audio is too short for multi-window silence analysis.");
  }

  const sortedDbs = [...windowDbs].sort((a, b) => a - b);
  const peakWindowDb = sortedDbs[sortedDbs.length - 1];
  const p10WindowDb = sortedDbs[Math.floor((sortedDbs.length - 1) * 0.1)];

  if (peakWindowDb < -72) {
    return unchanged(
      "Audio level is too quiet or silent to detect clear start/end boundaries. Trim boundaries were left unchanged.",
      baseThresholdDb,
    );
  }

  // Adapt downwards for quiet recordings so soft opening/closing notes aren't clipped,
  // while staying comfortably above a steady low background floor.
  let effectiveThresholdDb = baseThresholdDb;
  if (peakWindowDb < -25) {
    effectiveThresholdDb = Math.max(-68, Math.min(baseThresholdDb, peakWindowDb - 18));
  }
  if (peakWindowDb - p10WindowDb >= 14 && p10WindowDb > -65) {
    effectiveThresholdDb = Math.max(effectiveThresholdDb, Math.min(peakWindowDb - 6, p10WindowDb + 6));
  }

  // Scan forward from start for sustained consecutive active windows (ignores isolated clicks)
  let firstActiveIdx = -1;
  let run = 0;
  for (let i = 0; i < windowDbs.length; i++) {
    if (windowDbs[i] >= effectiveThresholdDb) {
      run += 1;
      if (run >= minConsecutive) {
        firstActiveIdx = i - minConsecutive + 1;
        break;
      }
    } else {
      run = 0;
    }
  }

  // Scan backward from end for sustained consecutive active windows
  let lastActiveIdx = -1;
  run = 0;
  for (let i = windowDbs.length - 1; i >= 0; i--) {
    if (windowDbs[i] >= effectiveThresholdDb) {
      run += 1;
      if (run >= minConsecutive) {
        lastActiveIdx = i + minConsecutive - 1;
        break;
      }
    } else {
      run = 0;
    }
  }

  if (firstActiveIdx < 0 || lastActiveIdx < 0 || firstActiveIdx > lastActiveIdx) {
    return unchanged(
      "No reliable musical onset or ending was detected (only brief noise spikes). Trim boundaries were left unchanged.",
      effectiveThresholdDb,
    );
  }

  const onsetSec = windowStartsSec[firstActiveIdx];
  const offsetSec = Math.min(duration, windowStartsSec[lastActiveIdx] + windowMs / 1000);
  const startSec = Math.round(Math.max(0, onsetSec - leadingPaddingSec) * 1000) / 1000;
  const endSec = Math.round(Math.min(duration, offsetSec + trailingPaddingSec) * 1000) / 1000;

  if (endSec - startSec < 0.25) {
    return unchanged(
      "Detected active region was shorter than minimum usable duration. Trim boundaries were left unchanged.",
      effectiveThresholdDb,
    );
  }

  const removedLeadingSec = Math.max(0, startSec);
  const removedTrailingSec = Math.max(0, duration - endSec);

  if ((removedLeadingSec < 0.15 && removedTrailingSec < 0.15) || removedLeadingSec + removedTrailingSec < minTrimGainSec) {
    return unchanged(
      "No significant leading or trailing silence was detected. Trim boundaries were left unchanged.",
      effectiveThresholdDb,
    );
  }

  return {
    changed: true,
    startSec,
    endSec,
    removedLeadingSec: Math.round(removedLeadingSec * 100) / 100,
    removedTrailingSec: Math.round(removedTrailingSec * 100) / 100,
    effectiveThresholdDb: Math.round(effectiveThresholdDb * 10) / 10,
    reason: `Detected silence boundaries (threshold ${Math.round(effectiveThresholdDb)} dBFS): start at ${formatTrimSeconds(startSec)}, end at ${formatTrimSeconds(endSec)}.`,
  };
}

/**
 * Slice a decoded AudioBuffer between [startSec, endSec] while preserving
 * sample rate and channel count, verifying audible signal exists.
 */
export function sliceAudioBuffer(buffer: AudioBuffer, startSec: number, endSec: number): SliceAudioResult {
  const sr = buffer.sampleRate;
  const totalDuration = buffer.length / Math.max(1, sr);
  const validation = validateTrimBounds(startSec, endSec, totalDuration);
  if (!validation.valid) {
    throw new Error(validation.error || "Invalid trim boundaries.");
  }

  const startSample = Math.max(0, Math.min(buffer.length - 1, Math.floor(startSec * sr)));
  const endSample = Math.max(startSample + 1, Math.min(buffer.length, Math.ceil(endSec * sr)));
  const frameCount = endSample - startSample;
  if (frameCount <= 0) {
    throw new Error("Selected trim region contains zero audio frames.");
  }

  const channels: Float32Array[] = [];
  let peakAmplitude = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const slice = buffer.getChannelData(ch).slice(startSample, endSample);
    for (let i = 0; i < slice.length; i++) {
      const a = Math.abs(slice[i]);
      if (a > peakAmplitude) peakAmplitude = a;
    }
    channels.push(slice);
  }

  if (peakAmplitude <= 1e-6) {
    throw new Error("Selected trim region is completely silent and contains no audio to transcribe.");
  }

  return {
    channels,
    sampleRate: sr,
    durationSec: frameCount / sr,
    frameCount,
    peakAmplitude,
  };
}

export interface WavHeaderInfo {
  audioFormat: number;
  numChannels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

export interface DecodeAudioOptions {
  signal?: AbortSignal;
  preferredSampleRate?: number | null;
}

/**
 * Parse RIFF/WAVE fmt and data chunk headers safely.
 */
export function parseWavHeader(arrayBuffer: ArrayBuffer): WavHeaderInfo | null {
  if (!arrayBuffer || arrayBuffer.byteLength < 44) return null;
  const view = new DataView(arrayBuffer);
  const readFourCC = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  if (readFourCC(0) !== "RIFF" || readFourCC(8) !== "WAVE") return null;

  let pos = 12;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let hasFmt = false;
  let dataOffset = -1;
  let dataSize = 0;

  while (pos + 8 <= arrayBuffer.byteLength) {
    const chunkId = readFourCC(pos);
    const chunkSize = view.getUint32(pos + 4, true);
    const payloadOffset = pos + 8;
    if (payloadOffset + chunkSize > arrayBuffer.byteLength && chunkId !== "data") {
      break;
    }

    if (chunkId === "fmt " && chunkSize >= 16 && payloadOffset + 16 <= arrayBuffer.byteLength) {
      audioFormat = view.getUint16(payloadOffset, true);
      numChannels = view.getUint16(payloadOffset + 2, true);
      sampleRate = view.getUint32(payloadOffset + 4, true);
      byteRate = view.getUint32(payloadOffset + 8, true);
      blockAlign = view.getUint16(payloadOffset + 12, true);
      bitsPerSample = view.getUint16(payloadOffset + 14, true);
      hasFmt = true;
    } else if (chunkId === "data") {
      dataOffset = payloadOffset;
      dataSize = Math.min(chunkSize, Math.max(0, arrayBuffer.byteLength - payloadOffset));
      break;
    }

    // RIFF chunks are word-aligned (padded to even byte boundary)
    pos = payloadOffset + chunkSize + (chunkSize % 2);
  }

  if (!hasFmt || dataOffset < 0 || numChannels <= 0 || sampleRate <= 0 || blockAlign <= 0 || bitsPerSample <= 0) {
    return null;
  }

  return {
    audioFormat,
    numChannels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    dataOffset,
    dataSize,
  };
}

/**
 * Decode uncompressed RIFF/WAVE (PCM 8/16/24/32-bit or IEEE float32) directly in JS
 * so browser AudioContext output resampling never alters the WAV's native sample rate.
 */
export function tryDecodePcmWavArrayBuffer(arrayBuffer: ArrayBuffer): AudioBuffer | null {
  const hdr = parseWavHeader(arrayBuffer);
  if (!hdr) return null;

  const isPcm = hdr.audioFormat === 1 && [8, 16, 24, 32].includes(hdr.bitsPerSample);
  const isFloat32 = hdr.audioFormat === 3 && hdr.bitsPerSample === 32;
  if (!isPcm && !isFloat32) return null;

  const bytesPerSample = hdr.bitsPerSample / 8;
  if (hdr.blockAlign < hdr.numChannels * bytesPerSample) return null;

  const frameCount = Math.floor(hdr.dataSize / hdr.blockAlign);
  if (frameCount <= 0) return null;

  const view = new DataView(arrayBuffer);
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < hdr.numChannels; ch++) {
    channels.push(new Float32Array(frameCount));
  }

  for (let i = 0; i < frameCount; i++) {
    const frameOffset = hdr.dataOffset + i * hdr.blockAlign;
    for (let ch = 0; ch < hdr.numChannels; ch++) {
      const sampleOffset = frameOffset + ch * bytesPerSample;
      let val = 0;
      if (isFloat32) {
        val = view.getFloat32(sampleOffset, true);
      } else if (hdr.bitsPerSample === 8) {
        val = (view.getUint8(sampleOffset) - 128) / 128;
      } else if (hdr.bitsPerSample === 16) {
        val = view.getInt16(sampleOffset, true) / 32768;
      } else if (hdr.bitsPerSample === 24) {
        const b0 = view.getUint8(sampleOffset);
        const b1 = view.getUint8(sampleOffset + 1);
        const b2 = view.getInt8(sampleOffset + 2);
        const raw = (b2 << 16) | (b1 << 8) | b0;
        val = raw / 8388608;
      } else if (hdr.bitsPerSample === 32) {
        val = view.getInt32(sampleOffset, true) / 2147483648;
      }
      channels[ch][i] = Number.isFinite(val) ? Math.max(-1, Math.min(1, val)) : 0;
    }
  }

  return {
    sampleRate: hdr.sampleRate,
    length: frameCount,
    duration: frameCount / hdr.sampleRate,
    numberOfChannels: hdr.numChannels,
    getChannelData: (ch: number) => {
      if (ch < 0 || ch >= channels.length) {
        throw new RangeError(`Channel index ${ch} out of range`);
      }
      return channels[ch];
    },
    copyFromChannel: (dest: Float32Array, ch: number, startInChannel = 0) => {
      const src = channels[ch];
      if (!src) throw new RangeError(`Channel index ${ch} out of range`);
      dest.set(src.subarray(startInChannel, startInChannel + dest.length));
    },
    copyToChannel: (src: Float32Array, ch: number, startInChannel = 0) => {
      const dst = channels[ch];
      if (!dst) throw new RangeError(`Channel index ${ch} out of range`);
      dst.set(src.subarray(0, Math.max(0, dst.length - startInChannel)), startInChannel);
    },
  } as unknown as AudioBuffer;
}

/**
 * Encode Float32 PCM channel arrays to a standard 16-bit signed integer RIFF/WAVE Blob
 * preserving original sampleRate and channelCount.
 */
export function encodePcm16Wav(channels: Float32Array[], sampleRate: number): Blob {
  const numChannels = channels.length;
  const sr = Math.round(sampleRate);
  if (numChannels <= 0 || !Number.isFinite(sr) || sr <= 0) {
    throw new Error("Cannot encode WAV: missing audio channels or invalid sample rate.");
  }
  const frameCount = channels[0].length;
  if (frameCount <= 0) {
    throw new Error("Cannot encode WAV: selected region is empty.");
  }

  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sr * blockAlign;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format = 1
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // 16-bit
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frameCount; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i] ?? 0));
      const intSample = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
      view.setInt16(offset, Math.max(-32768, Math.min(32767, intSample)), true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export async function decodeAudioBufferFromUrl(
  url: string,
  optionsOrSignal?: AbortSignal | DecodeAudioOptions,
): Promise<AudioBuffer> {
  const signal =
    optionsOrSignal && "aborted" in optionsOrSignal
      ? optionsOrSignal
      : optionsOrSignal?.signal;
  const preferredSampleRate =
    optionsOrSignal && !("aborted" in optionsOrSignal)
      ? optionsOrSignal.preferredSampleRate
      : undefined;

  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Failed to fetch audio for trimming (HTTP ${res.status}).`);
  }
  const arrayBuffer = await res.arrayBuffer();
  if (!arrayBuffer || arrayBuffer.byteLength === 0) {
    throw new Error("Audio file is empty or unreadable.");
  }

  // Directly decode uncompressed WAV to preserve exact source sample rate without OS/WebAudio resampling.
  const directWav = tryDecodePcmWavArrayBuffer(arrayBuffer);
  if (directWav) {
    return directWav;
  }

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("Web Audio API is not supported in this browser.");
  }

  const validPrefSr =
    typeof preferredSampleRate === "number" &&
    Number.isFinite(preferredSampleRate) &&
    preferredSampleRate >= 8000 &&
    preferredSampleRate <= 192000
      ? Math.round(preferredSampleRate)
      : null;

  let ctx: AudioContext;
  if (validPrefSr !== null) {
    try {
      ctx = new AudioCtx({ sampleRate: validPrefSr });
    } catch {
      ctx = new AudioCtx();
    }
  } else {
    ctx = new AudioCtx();
  }

  try {
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch (err) {
    const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
    throw new Error(
      `Unable to decode this audio file in your browser${detail}. Original recording is preserved.`,
    );
  } finally {
    try {
      await ctx.close();
    } catch {
      // Ignore cleanup errors
    }
  }
}

import { slugifyProjectTitle } from "@/lib/utils";

export function buildTrimmedAudioFilename(originalFilename?: string | null, projectTitle?: string | null): string {
  const name = (originalFilename || "").trim();
  const baseNoExt = name.replace(/\.[^.]+$/, "");
  if (/^tab-audio-/i.test(baseNoExt)) {
    const stem = baseNoExt.endsWith("-trimmed") ? baseNoExt : `${baseNoExt}-trimmed`;
    return `${stem}.wav`;
  }
  if (/^mic-recording-/i.test(baseNoExt)) {
    const stem = baseNoExt.endsWith("-trimmed") ? baseNoExt : `${baseNoExt}-trimmed`;
    return `${stem}.wav`;
  }
  const fallbackBase = slugifyProjectTitle(projectTitle || "") || "audio";
  const cleanBase = (baseNoExt || fallbackBase)
    .replace(/[<>:"/\\|?*;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const stem = cleanBase.endsWith("-trimmed") ? cleanBase : `${cleanBase}-trimmed`;
  return `${stem || "audio-trimmed"}.wav`;
}
