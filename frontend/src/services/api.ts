import type {
  ExportRecord,
  MediaAsset,
  Project,
  ProjectListResponse,
  ProjectScoreResponse,
  ScoreData,
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
  retryDelayBaseMs: number = BASE_RETRY_DELAY_MS
): Promise<T> {
  const { accessToken, refreshToken } = getStoredTokens();
  const headers = new Headers(init.headers);
  if (accessToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  if (!(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response | null = null;
  let lastNetworkError: unknown = null;
  let totalWaitMs = 0;

  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      const result = await fetchWithTimeout(`${API_BASE_URL}${path}`, { ...init, headers });
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

  if (res.status === 401 && retryAuth && refreshToken) {
    const { response: refRes } = await fetchWithTimeout(`${API_BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (refRes.ok) {
      const tokens: TokenResponse = await refRes.json();
      setStoredTokens(tokens.access_token, tokens.refresh_token);
      return request<T>(path, init, false, retryDelayBaseMs);
    }
    clearStoredTokens();
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
    signal?: AbortSignal
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
      fd.append("file", file);
      xhr.send(fd);
    });
  },
  checkExternalUrl: (url: string) =>
    request<{ supported: boolean; reason: string }>("/uploads/url-check", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  getSignedMediaUrl: (uploadId: string) =>
    request<{ url: string; expires_in: number }>(`/uploads/${uploadId}/signed-url`),

  // Transcription Jobs
  startTranscription: (projectId: string, sourceAssetId: string | null, settings: TranscriptionSettings) =>
    request<TranscriptionJob>(`/projects/${projectId}/transcriptions`, {
      method: "POST",
      body: JSON.stringify({ source_asset_id: sourceAssetId, settings }),
    }),
  listTranscriptions: (projectId: string) =>
    request<TranscriptionJob[]>(`/projects/${projectId}/transcriptions`),
  getJob: (jobId: string) => request<TranscriptionJob>(`/transcriptions/${jobId}`),
  cancelJob: (jobId: string) => request<TranscriptionJob>(`/transcriptions/${jobId}/cancel`, { method: "POST" }),
  retryJob: (jobId: string) => request<TranscriptionJob>(`/transcriptions/${jobId}/retry`, { method: "POST" }),

  // Score & Editor
  getScore: (projectId: string) => request<ProjectScoreResponse>(`/projects/${projectId}/score`),
  saveScore: (projectId: string, score_json: ScoreData, expected_version?: number) =>
    request<ProjectScoreResponse>(`/projects/${projectId}/score`, {
      method: "PUT",
      body: JSON.stringify({ score_json, expected_version }),
    }),
  regenerateArrangement: (
    projectId: string,
    data: { arrangement_detail: "simple" | "balanced" | "detailed"; quantization?: string; mode?: string },
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
  exportSatbAudio: async (
    projectId: string,
    payload: {
      part: "soprano" | "alto" | "tenor" | "bass" | "combined";
      format: "mp3" | "wav";
      volumes?: Record<string, number>;
      instruments?: Record<string, number>;
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
    format: "midi" | "musicxml" | "pdf" | "wav",
    options?: { include_chords?: boolean },
  ) =>
    request<ExportRecord>(`/projects/${projectId}/exports`, {
      method: "POST",
      body: JSON.stringify({
        format,
        ...(options?.include_chords !== undefined ? { include_chords: options.include_chords } : {}),
      }),
    }),
  downloadExportBlob: async (downloadUrl: string, filename: string) => {
    const { accessToken } = getStoredTokens();
    const fullUrl = downloadUrl.startsWith("http")
      ? downloadUrl
      : `${API_BASE_URL.replace(/\/api\/v1$/, "")}${downloadUrl}`;
    const res = await fetch(fullUrl, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, "Failed to download export.");
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

  // Billing & Worker
  getPlans: () => request<{ billing_active: boolean; plans: Array<{ id: string; name: string; description: string; features: string[] }> }>("/billing/plans"),
  getWorkerStatus: () => request<WorkerStatus>("/worker/status"),
  deleteMediaAsset: (projectId: string, assetId: string) =>
    request<void>(`/projects/${projectId}/media/${assetId}`, { method: "DELETE" }),
};
