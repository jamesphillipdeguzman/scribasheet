import { sanitizeDownloadTitle } from "@/lib/utils";
import type {
  ArchiveSummary,
  ArchiveValidationPreview,
  ExportRecord,
  ExtractAudioResponse,
  LyricsData,
  MediaAsset,
  OmrApplyFixesResponse,
  OmrVerificationStatusResponse,
  Project,
  ProjectListResponse,
  ProjectScoreResponse,
  ScoreData,
  ScoreRecoverResponse,
  TokenResponse,
  TranscriptionJob,
  TranscriptionSettings,
  UsageSummary,
  User,
  WorkerStatus,
} from "@/types/api";

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api/v1";
export const API_ORIGIN_URL = API_BASE_URL.replace(/\/api\/v1\/?$/, "") || "";
export const WS_BASE_URL =
  import.meta.env.VITE_WS_BASE_URL ||
  `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/v1`;

const ACCESS_TOKEN_KEY = "scribasheet_access_token";
const REFRESH_TOKEN_KEY = "scribasheet_refresh_token";
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const WAKEUP_TIMEOUT_MS = 30_000;
const MAX_TRANSIENT_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 800;
const MAX_TOTAL_RETRY_WAIT_MS = 8_000;

export function getStoredTokens() {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return { accessToken: null, refreshToken: null };
  }
  return {
    accessToken: window.localStorage.getItem(ACCESS_TOKEN_KEY),
    refreshToken: window.localStorage.getItem(REFRESH_TOKEN_KEY),
  };
}

export function setStoredTokens(access: string, refresh: string) {
  localStorage.setItem(ACCESS_TOKEN_KEY, access);
  localStorage.setItem(REFRESH_TOKEN_KEY, refresh);
}

export function clearStoredTokens() {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  isTransient: boolean;
  constructor(status: number, message: string, isTransient = false) {
    super(message);
    this.status = status;
    this.isTransient = isTransient;
  }
}

export function isAuthError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status === 401 || err.status === 403;
  }
  if (typeof err === "object" && err !== null && "status" in err) {
    const statusVal = (err as { status?: unknown }).status;
    return statusVal === 401 || statusVal === 403;
  }
  return false;
}

const SESSION_EXPIRED_MSG = "Your session has expired. Please sign in again.";
const sessionExpiredListeners = new Set<(message: string) => void>();
let inFlightRefresh: Promise<string | null> | null = null;

export function onAuthSessionExpired(listener: (message: string) => void): () => void {
  sessionExpiredListeners.add(listener);
  return () => {
    sessionExpiredListeners.delete(listener);
  };
}

export function resetAuthRefreshStateForTests(): void {
  inFlightRefresh = null;
  sessionExpiredListeners.clear();
}

function emitSessionExpired(message: string): void {
  for (const listener of Array.from(sessionExpiredListeners)) {
    listener(message);
  }
}

function isJwtExpiringSoon(token: string | null, skewSec = 45): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return false;
    }
    return payload.exp <= Math.floor(Date.now() / 1000) + skewSec;
  } catch {
    return false;
  }
}

function isAuthPublicPath(path: string): boolean {
  const clean = path.split("?")[0];
  return (
    clean === "/auth/login" ||
    clean === "/auth/register" ||
    clean === "/auth/refresh" ||
    clean === "/auth/forgot-password" ||
    clean === "/auth/reset-password" ||
    clean.startsWith("/playlists/shared/")
  );
}

export async function refreshAccessToken(failedAccessToken?: string | null): Promise<string | null> {
  const { accessToken: currentAccess } = getStoredTokens();
  if (
    currentAccess &&
    failedAccessToken &&
    currentAccess !== failedAccessToken &&
    !isJwtExpiringSoon(currentAccess, 10)
  ) {
    return currentAccess;
  }

  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  inFlightRefresh = (async (): Promise<string | null> => {
    const { refreshToken } = getStoredTokens();
    if (!refreshToken) {
      clearStoredTokens();
      emitSessionExpired(SESSION_EXPIRED_MSG);
      return null;
    }

    let refRes: Response | null = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const result = await fetchWithTimeout(`${API_BASE_URL}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        refRes = result.response;
        if (!TRANSIENT_STATUSES.has(refRes.status) || attempt === 1) {
          break;
        }
      } catch {
        if (attempt === 1) {
          throw new ApiError(
            503,
            "Unable to refresh session due to a temporary connection issue. Retrying shortly.",
            true,
          );
        }
      }
      await sleep(BASE_RETRY_DELAY_MS);
    }

    if (!refRes) {
      throw new ApiError(
        503,
        "Unable to refresh session due to a temporary connection issue. Retrying shortly.",
        true,
      );
    }

    if (refRes.ok) {
      const tokens: TokenResponse = await refRes.json();
      setStoredTokens(tokens.access_token, tokens.refresh_token);
      return tokens.access_token;
    }

    if (refRes.status === 401 || refRes.status === 403) {
      clearStoredTokens();
      emitSessionExpired(SESSION_EXPIRED_MSG);
      return null;
    }

    if (TRANSIENT_STATUSES.has(refRes.status)) {
      throw new ApiError(
        503,
        "Unable to refresh session due to a temporary connection issue. Retrying shortly.",
        true,
      );
    }

    clearStoredTokens();
    emitSessionExpired(SESSION_EXPIRED_MSG);
    return null;
  })().finally(() => {
    inFlightRefresh = null;
  });

  return inFlightRefresh;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return (err instanceof DOMException && err.name === "AbortError") || (err instanceof Error && err.name === "AbortError");
}

function isTransientNetworkError(err: unknown, callerAborted: boolean): boolean {
  if (callerAborted) return false;
  if (err instanceof TypeError) return true;
  return isAbortError(err);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<{ response: Response; timedOut: () => boolean }> {
  const controller = new AbortController();
  let didTimeout = false;
  const externalSignal = init.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, timedOut: () => didTimeout };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

let inFlightWakeUp: Promise<boolean> | null = null;

async function wakeUpBackend(): Promise<boolean> {
  if (inFlightWakeUp) return inFlightWakeUp;
  const healthUrl = `${API_ORIGIN_URL}/health`;
  inFlightWakeUp = fetchWithTimeout(healthUrl, { method: "GET" }, WAKEUP_TIMEOUT_MS)
    .then(({ response }) => response.ok)
    .catch(() => false)
    .finally(() => {
      inFlightWakeUp = null;
    });
  return inFlightWakeUp;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  retryAuth = true,
  retryDelayBaseMs: number = BASE_RETRY_DELAY_MS,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<T> {
  const publicAuthRoute = isAuthPublicPath(path);
  let { accessToken } = getStoredTokens();
  const { refreshToken } = getStoredTokens();
  if (retryAuth && !publicAuthRoute && accessToken && refreshToken && isJwtExpiringSoon(accessToken)) {
    const refreshed = await refreshAccessToken(accessToken);
    if (refreshed) {
      accessToken = refreshed;
    } else {
      accessToken = getStoredTokens().accessToken;
    }
  }

  const latestTokens = getStoredTokens();
  const usedAccessToken = accessToken || latestTokens.accessToken;
  const headers = new Headers(init.headers);
  if (usedAccessToken && (!headers.has("Authorization") || !retryAuth)) {
    headers.set("Authorization", `Bearer ${usedAccessToken}`);
  }
  if (!(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response | null = null;
  let lastNetworkError: unknown = null;
  let totalWaitMs = 0;

  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      const result = await fetchWithTimeout(`${API_BASE_URL}${path}`, { ...init, headers }, timeoutMs);
      res = result.response;
      lastNetworkError = null;
      if (!TRANSIENT_STATUSES.has(res.status) || attempt === MAX_TRANSIENT_RETRIES) {
        break;
      }
    } catch (err) {
      lastNetworkError = err;
      const callerAborted = Boolean(init.signal?.aborted);
      if (callerAborted) {
        throw err;
      }
      if (!isTransientNetworkError(err, callerAborted) || attempt === MAX_TRANSIENT_RETRIES) {
        if (isAbortError(err)) {
          throw new ApiError(504, "The server took too long to respond. Please try again.", true);
        }
        throw new ApiError(
          503,
          "Backend is waking up or temporarily unreachable. Please try again in a moment.",
          true
        );
      }
    }

    const delayMs = Math.min(
      retryDelayBaseMs * Math.pow(2, attempt),
      Math.max(0, MAX_TOTAL_RETRY_WAIT_MS - totalWaitMs)
    );
    if (delayMs <= 0) break;
    totalWaitMs += delayMs;
    await sleep(delayMs);
  }

  if (!res) {
    throw new ApiError(
      503,
      lastNetworkError instanceof Error
        ? "Backend is waking up or temporarily unreachable. Please try again in a moment."
        : "Unable to reach ScribaSheet API.",
      true
    );
  }

  if (res.status === 401 && retryAuth && !publicAuthRoute) {
    const refreshed = await refreshAccessToken(usedAccessToken);
    if (refreshed) {
      const retryHeaders = new Headers(init.headers);
      retryHeaders.delete("Authorization");
      return request<T>(path, { ...init, headers: retryHeaders }, false, retryDelayBaseMs, timeoutMs);
    }
    throw new ApiError(401, SESSION_EXPIRED_MSG);
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const err = await res.json();
      message = err.detail || err.message || message;
    } catch {
      // ignore non-json error body
    }
    throw new ApiError(res.status, message, TRANSIENT_STATUSES.has(res.status));
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export const api = {
  wakeUpBackend,
  // Auth & Users
  register: (data: { email: string; password: string; display_name: string }) =>
    request<TokenResponse>("/auth/register", { method: "POST", body: JSON.stringify(data) }),
  login: (data: { email: string; password: string }) =>
    request<TokenResponse>("/auth/login", { method: "POST", body: JSON.stringify(data) }),
  forgotPassword: (email: string) =>
    request<{ message: string }>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) }),
  resetPassword: (token: string, new_password: string) =>
    request<{ message: string }>("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, new_password }) }),
  getMe: () => request<User>("/users/me"),
  updateMe: (data: { display_name: string }) =>
    request<User>("/users/me", { method: "PATCH", body: JSON.stringify(data) }),
  deleteMe: () => request<void>("/users/me", { method: "DELETE" }),
  getUsage: () => request<UsageSummary>("/users/me/usage"),

  // Projects
  listProjects: (params: { search?: string; status?: string; sort_by?: string; sort_dir?: string; page?: number; page_size?: number } = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    });
    return request<ProjectListResponse>(`/projects?${qs.toString()}`);
  },
  createProject: (data: { title: string; description?: string; instrument?: string; transcription_mode?: string }) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify(data) }),
  createPlaygroundProject: (data?: {
    title?: string;
    description?: string;
    key_signature?: string;
    time_signature?: string;
    tempo_bpm?: number;
    clef_mode?: "grand" | "treble" | "bass";
    measures?: number;
  }) => request<Project>("/projects/playground", { method: "POST", body: JSON.stringify(data || {}) }),
  createPlaygroundCopy: (id: string, data?: { title?: string }) =>
    request<Project>(`/projects/${id}/playground-copy`, { method: "POST", body: JSON.stringify(data || {}) }),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  updateProject: (id: string, data: Partial<Pick<Project, "title" | "description" | "instrument" | "transcription_mode">>) =>
    request<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  duplicateProject: (id: string) => request<Project>(`/projects/${id}/duplicate`, { method: "POST" }),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: "DELETE" }),

  // Uploads with progress & cancellation
  uploadMedia: (
    projectId: string,
    file: File,
    onProgress?: (pct: number) => void,
    signal?: AbortSignal,
    replaceAssetId?: string | null,
  ): Promise<MediaAsset> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE_URL}/uploads`);
      const { accessToken } = getStoredTokens();
      if (accessToken) xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && onProgress) {
          onProgress(Math.round((ev.loaded / ev.total) * 100));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          let msg = `Upload failed (${xhr.status})`;
          try {
            msg = JSON.parse(xhr.responseText).detail || msg;
          } catch {
            // ignore
          }
          reject(new ApiError(xhr.status, msg));
        }
      };

      xhr.onerror = () => reject(new ApiError(0, "Network error during upload."));
      xhr.onabort = () => reject(new ApiError(0, "Upload cancelled."));

      if (signal) {
        signal.addEventListener("abort", () => xhr.abort());
      }

      const fd = new FormData();
      fd.append("project_id", projectId);
      if (replaceAssetId) {
        fd.append("replace_asset_id", replaceAssetId);
      }
      fd.append("file", file);
      xhr.send(fd);
    });
  },
  checkExternalUrl: (url: string) =>
    request<{
      supported: boolean;
      reason: string;
      is_youtube?: boolean;
      video_id?: string | null;
      title?: string | null;
      author_name?: string | null;
      thumbnail_url?: string | null;
    }>("/uploads/url-check", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  getSignedMediaUrl: (uploadId: string) =>
    request<{ url: string; expires_in: number }>(`/uploads/${uploadId}/signed-url`),
  extractVideoAudio: (
    projectId: string,
    assetId: string,
    formats: Array<"mp3" | "wav"> = ["mp3", "wav"],
  ) =>
    request<ExtractAudioResponse>(
      `/projects/${projectId}/media/${assetId}/extract-audio`,
      {
        method: "POST",
        body: JSON.stringify({ formats }),
      },
      true,
      BASE_RETRY_DELAY_MS,
      120_000,
    ),
  downloadMediaAsset: (assetId: string, filename: string) =>
    api.downloadExportBlob(`${API_BASE_URL}/uploads/${assetId}/download`, filename),

  // Transcription Jobs
  startTranscription: (
    projectId: string,
    sourceAssetId: string | null,
    settings: TranscriptionSettings,
    sourceAssetIds?: string[] | null,
  ) =>
    request<TranscriptionJob>(`/projects/${projectId}/transcriptions`, {
      method: "POST",
      body: JSON.stringify({
        source_asset_id: sourceAssetId,
        ...(sourceAssetIds && sourceAssetIds.length > 0 ? { source_asset_ids: sourceAssetIds } : {}),
        settings,
      }),
    }),
  listTranscriptions: (projectId: string) =>
    request<TranscriptionJob[]>(`/projects/${projectId}/transcriptions`),
  getJob: (jobId: string) => request<TranscriptionJob>(`/transcriptions/${jobId}`),
  cancelJob: (jobId: string) => request<TranscriptionJob>(`/transcriptions/${jobId}/cancel`, { method: "POST" }),
  retryJob: (jobId: string) => request<TranscriptionJob>(`/transcriptions/${jobId}/retry`, { method: "POST" }),

  // Score & Editor
  getScore: (projectId: string) => request<ProjectScoreResponse>(`/projects/${projectId}/score`),
  saveScore: (
    projectId: string,
    score_json: ScoreData,
    expected_version?: number,
    musicxml?: string | null,
  ) =>
    request<ProjectScoreResponse>(`/projects/${projectId}/score`, {
      method: "PUT",
      body: JSON.stringify({
        score_json,
        expected_version,
        ...(musicxml ? { musicxml } : {}),
      }),
    }),
  regenerateArrangement: (
    projectId: string,
    data: {
      arrangement_detail: "simple" | "balanced" | "detailed";
      playability_smoothing?: "original" | "standard" | "simplified";
      quantization?: string;
      mode?: string;
    },
  ) =>
    request<ProjectScoreResponse>(`/projects/${projectId}/score/regenerate`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateSatbAssignments: (
    projectId: string,
    data: { assignments: Record<number, string>; instruments?: Record<number, number> },
  ) =>
    request<ProjectScoreResponse>(`/projects/${projectId}/score/satb-assignments`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  getOmrVerification: (projectId: string) =>
    request<OmrVerificationStatusResponse>(`/projects/${projectId}/score/omr-verification`),
  runOmrVisionVerify: (projectId: string, force = false) =>
    request<OmrVerificationStatusResponse>(
      `/projects/${projectId}/score/omr-verify`,
      {
        method: "POST",
        body: JSON.stringify({ force }),
      },
      true,
      BASE_RETRY_DELAY_MS,
      90_000,
    ),
  applyOmrFixes: (projectId: string, findingIds: string[]) =>
    request<OmrApplyFixesResponse>(`/projects/${projectId}/score/omr-apply-fixes`, {
      method: "POST",
      body: JSON.stringify({ finding_ids: findingIds }),
    }),
  revertOmrFixes: (projectId: string) =>
    request<ProjectScoreResponse>(`/projects/${projectId}/score/omr-revert`, {
      method: "POST",
    }),
  restorePreviousScore: (projectId: string) =>
    request<ProjectScoreResponse>(`/projects/${projectId}/score/restore-previous`, {
      method: "POST",
    }),
  recoverScore: (
    projectId: string,
    options?: { create_blank_if_empty?: boolean; expected_version?: number },
  ) =>
    request<ScoreRecoverResponse>(`/projects/${projectId}/score/recover`, {
      method: "POST",
      body: JSON.stringify({
        create_blank_if_empty: Boolean(options?.create_blank_if_empty),
        ...(options?.expected_version !== undefined
          ? { expected_version: options.expected_version }
          : {}),
      }),
    }),

  // Lyrics
  getLyrics: (projectId: string) => request<LyricsData>(`/projects/${projectId}/lyrics`),
  updateLyrics: (
    projectId: string,
    data: { text: string; segments?: LyricsData["segments"]; language?: string | null },
  ) =>
    request<LyricsData>(`/projects/${projectId}/lyrics`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  transcribeLyrics: (
    projectId: string,
    data: {
      enable_source_separation?: boolean;
      whisper_model?: string;
      language?: string | null;
      force_overwrite?: boolean;
    },
  ) =>
    request<TranscriptionJob>(`/projects/${projectId}/lyrics/transcribe`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  exportLyrics: async (projectId: string, format: "txt" | "timestamped_txt" | "srt", filename: string) => {
    const { accessToken } = getStoredTokens();
    const res = await fetch(
      `${API_BASE_URL}/projects/${projectId}/lyrics/export?format=${encodeURIComponent(format)}`,
      {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      },
    );
    if (!res.ok) {
      throw new ApiError(res.status, "Failed to export lyrics.");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  exportSatbAudio: async (
    projectId: string,
    payload: {
      part: "soprano" | "alto" | "tenor" | "bass" | "combined";
      format: "mp3" | "wav";
      volumes?: Record<string, number>;
      instruments?: Record<string, number>;
      voice_assignments?: Record<number, string>;
      tempo_bpm?: number;
      start_measure?: number;
      end_measure?: number;
    },
    filename: string,
  ) => {
    const { accessToken } = getStoredTokens();
    const res = await fetch(`${API_BASE_URL}/projects/${projectId}/exports/satb`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new ApiError(res.status, "Failed to export SATB audio.");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // Exports
  listExports: (projectId: string) => request<ExportRecord[]>(`/projects/${projectId}/exports`),
  createExport: (
    projectId: string,
    format:
      | "midi"
      | "musicxml"
      | "mxl"
      | "pdf"
      | "wav"
      | "mp3"
      | "soprano_mp3"
      | "alto_mp3"
      | "tenor_mp3"
      | "bass_mp3"
      | "extracted_mp3"
      | "extracted_wav",
    options?: {
      include_chords?: boolean;
      transcribed_by?: string | null;
      include_transcribed_by?: boolean;
    },
  ) =>
    request<ExportRecord>(
      `/projects/${projectId}/exports`,
      {
        method: "POST",
        body: JSON.stringify({
          format,
          ...(options?.include_chords !== undefined ? { include_chords: options.include_chords } : {}),
          ...(options?.transcribed_by !== undefined ? { transcribed_by: options.transcribed_by } : {}),
          ...(options?.include_transcribed_by !== undefined
            ? { include_transcribed_by: options.include_transcribed_by }
            : {}),
        }),
      },
      true,
      BASE_RETRY_DELAY_MS,
      format === "extracted_mp3" || format === "extracted_wav" ? 120_000 : DEFAULT_REQUEST_TIMEOUT_MS,
    ),
  fetchExportBlob: async (downloadUrl: string): Promise<Blob> => {
    const { accessToken } = getStoredTokens();
    const fullUrl = downloadUrl.startsWith("http")
      ? downloadUrl
      : `${API_BASE_URL.replace(/\/api\/v1$/, "")}${downloadUrl}`;
    const res = await fetch(fullUrl, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, "Failed to download export.");
    return res.blob();
  },
  downloadExportBlob: async (downloadUrl: string, filename: string) => {
    const blob = await api.fetchExportBlob(downloadUrl);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  generateScorePdfBlob: async (
    projectId: string,
    options?: {
      include_chords?: boolean;
      transcribed_by?: string | null;
      include_transcribed_by?: boolean;
    },
  ): Promise<{ record: ExportRecord; blob: Blob }> => {
    const record = await api.createExport(projectId, "pdf", options);
    if (!record.download_url) {
      throw new ApiError(500, "PDF export completed without a download URL.");
    }
    const blob = await api.fetchExportBlob(record.download_url);
    return { record, blob };
  },

  // Project Archives (.scribasheet)
  getProjectArchiveSummary: (projectId: string, includeAudio = true) =>
    request<ArchiveSummary>(`/projects/${projectId}/archive/summary?include_audio=${includeAudio ? "true" : "false"}`),

  downloadProjectArchive: async (
    projectId: string,
    projectTitle: string,
    includeAudio = true,
  ): Promise<{ filename: string; sizeBytes: number; includedMedia: boolean }> => {
    const { accessToken } = getStoredTokens();
    const res = await fetch(
      `${API_BASE_URL}/projects/${projectId}/archive?include_audio=${includeAudio ? "true" : "false"}`,
      {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      },
    );
    if (!res.ok) {
      let detail = `Failed to export project archive (${res.status})`;
      try {
        const body = await res.json();
        detail = body.detail || detail;
      } catch {
        // ignore
      }
      throw new ApiError(res.status, detail);
    }
    const blob = await res.blob();
    const safeTitle = sanitizeDownloadTitle(projectTitle, "ScribaSheet-Project").replace(/\s+/g, "-") || "ScribaSheet-Project";
    const filename = `${safeTitle}.scribasheet`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return {
      filename,
      sizeBytes: blob.size,
      includedMedia: res.headers.get("X-Archive-Included-Media") !== "false" && includeAudio,
    };
  },

  validateArchive: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<ArchiveValidationPreview>(
      "/archives/validate",
      { method: "POST", body: fd },
      true,
      BASE_RETRY_DELAY_MS,
      120_000,
    );
  },

  importArchive: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<Project>(
      "/archives/import",
      { method: "POST", body: fd },
      true,
      BASE_RETRY_DELAY_MS,
      120_000,
    );
  },

  // Billing & Worker
  getPlans: () => request<{ billing_active: boolean; plans: Array<{ id: string; name: string; description: string; features: string[] }> }>("/billing/plans"),
  getWorkerStatus: () => request<WorkerStatus>("/worker/status"),
  deleteMediaAsset: (projectId: string, assetId: string) =>
    request<void>(`/projects/${projectId}/media/${assetId}`, { method: "DELETE" }),

  // Optional Playlists Neon Sync
  getPlaylistLibrary: () =>
    request<{
      schemaVersion: number;
      updatedAt: string;
      categories: Array<{ id: string; name: string; isDefault: boolean }>;
      playlists: Array<Record<string, unknown>>;
      preferences: Record<string, unknown>;
    }>("/playlists"),
  syncPlaylistLibrary: (payload: {
    schemaVersion: number;
    categories: Array<{ id: string; name: string; isDefault: boolean }>;
    playlists: unknown[];
    preferences: Record<string, unknown>;
  }) =>
    request<{
      schemaVersion: number;
      updatedAt: string;
      categories: Array<{ id: string; name: string; isDefault: boolean }>;
      playlists: Array<Record<string, unknown>>;
      preferences: Record<string, unknown>;
    }>("/playlists/sync", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  createRemotePlaylist: (payload: {
    id?: string;
    title: string;
    categoryId: string;
    tracks: unknown[];
  }) =>
    request<Record<string, unknown>>("/playlists", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateRemotePlaylist: (
    playlistId: string,
    payload: { title?: string; categoryId?: string; position?: number; tracks?: unknown[] },
  ) =>
    request<Record<string, unknown>>(`/playlists/${playlistId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteRemotePlaylist: (playlistId: string) =>
    request<void>(`/playlists/${playlistId}`, { method: "DELETE" }),
  enablePlaylistShare: (playlistId: string) =>
    request<{
      playlistId: string;
      serverId: string;
      isShared: boolean;
      shareToken: string | null;
      sharedAt: string | null;
    }>(`/playlists/${encodeURIComponent(playlistId)}/share`, { method: "POST" }),
  regeneratePlaylistShare: (playlistId: string) =>
    request<{
      playlistId: string;
      serverId: string;
      isShared: boolean;
      shareToken: string | null;
      sharedAt: string | null;
    }>(`/playlists/${encodeURIComponent(playlistId)}/share/regenerate`, { method: "POST" }),
  disablePlaylistShare: (playlistId: string) =>
    request<{
      playlistId: string;
      serverId: string;
      isShared: boolean;
      shareToken: string | null;
      sharedAt: string | null;
    }>(`/playlists/${encodeURIComponent(playlistId)}/share`, { method: "DELETE" }),
  getPublicSharedPlaylist: async (shareToken: string) => {
    const res = await fetch(
      `${API_BASE_URL}/playlists/shared/${encodeURIComponent(shareToken)}`,
      { method: "GET" },
    );
    if (!res.ok) {
      let detail = `Shared playlist unavailable (${res.status})`;
      try {
        const body = await res.json();
        detail = body.detail || detail;
      } catch {
        // ignore non-json error body
      }
      throw new ApiError(res.status, detail);
    }
    return res.json() as Promise<{
      title: string;
      description: string;
      categoryName: string;
      sharedAt: string | null;
      updatedAt: string;
      tracks: Array<{
        position: number;
        title: string;
        artist: string;
        sourceType: "youtube" | "project_audio";
        thumbnailUrl: string | null;
        practiceNotes: string;
        loop: { aSec: number | null; bSec: number | null };
        youtubeVideoId?: string | null;
        youtubeUrl?: string | null;
        playablePublicly: boolean;
        unavailableReason?: string | null;
      }>;
    }>;
  },
};
