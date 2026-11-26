export const CONTROLLER_BASE_URL =
  import.meta.env.VITE_WORKER_CONTROLLER_URL || "http://127.0.0.1:47832";

const CONTROLLER_TOKEN_KEY = "scribasheet_controller_token";

export interface ControllerHealth {
  controller_online: boolean;
  requires_pairing: boolean;
  host?: string;
  token_file_exists?: boolean;
}

export interface ControllerStatus {
  controller_online: boolean;
  worker_running: boolean;
  managed_by_controller: boolean;
  external_worker_detected: boolean;
  external_manageable?: boolean;
  pid: number | null;
  pids?: number[];
  started_at: string | null;
  last_exit_code: number | null;
  last_error: string | null;
  log_path: string;
  log_tail: string[];
  ok?: boolean;
  message?: string;
}

export type ControllerErrorCode =
  | "http_error"
  | "auth_required"
  | "pna_blocked"
  | "unreachable_remote_https"
  | "network_offline";

export type BrowserFamily = "brave" | "edge" | "chrome" | "other";
export type LocalNetworkPermissionState = PermissionState | "unknown";

export const PNA_BLOCKED_MESSAGE =
  "Your browser blocked access to the local worker controller at 127.0.0.1:47832. Allow Local Network Access for this site in your browser's site settings, then click Retry Connection or reload.";

export class ControllerError extends Error {
  status: number;
  code: ControllerErrorCode;
  constructor(status: number, message: string, code?: ControllerErrorCode) {
    super(message);
    this.name = "ControllerError";
    this.status = status;
    this.code = code ?? (status === 401 ? "auth_required" : "http_error");
  }
}

export function getControllerToken(): string {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return "";
  }
  return window.localStorage.getItem(CONTROLLER_TOKEN_KEY) || "";
}

export function setControllerToken(token: string): void {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }
  window.localStorage.setItem(CONTROLLER_TOKEN_KEY, token.trim());
}

export function clearControllerToken(): void {
  if (typeof window === "undefined" || typeof window.localStorage?.removeItem !== "function") {
    return;
  }
  window.localStorage.removeItem(CONTROLLER_TOKEN_KEY);
}

export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function isLoopbackPageOrigin(): boolean {
  if (typeof window === "undefined" || !window.location) return false;
  const host = window.location.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function detectBrowserFamily(): BrowserFamily {
  if (typeof navigator === "undefined") return "other";
  const nav = navigator as Navigator & { brave?: unknown };
  const ua = navigator.userAgent || "";
  if (nav.brave || /\bBrave\b/i.test(ua)) return "brave";
  if (/\bEdg\b/i.test(ua)) return "edge";
  if (/\b(Chrome|Chromium)\b/i.test(ua)) return "chrome";
  return "other";
}

export async function queryLocalNetworkPermissionState(): Promise<LocalNetworkPermissionState> {
  if (typeof navigator === "undefined" || typeof navigator.permissions?.query !== "function") {
    return "unknown";
  }
  const queryPerm = navigator.permissions.query.bind(navigator.permissions) as (
    desc: { name: string },
  ) => Promise<PermissionStatus>;
  for (const name of ["local-network-access", "loopback-network"]) {
    try {
      const status = await queryPerm({ name });
      if (status?.state === "denied" || status?.state === "prompt" || status?.state === "granted") {
        return status.state;
      }
    } catch {
      // Unsupported permission descriptor in this browser; try the next one.
    }
  }
  return "unknown";
}

async function controllerRequest<T>(path: string, init: RequestInit = {}, includeAuth = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (includeAuth) {
    const token = getControllerToken();
    if (token) {
      headers.set("X-Controller-Token", token);
    }
  }
  if (init.method === "POST") {
    headers.set("Content-Type", "application/json");
    headers.set("X-Requested-With", "ScribaSheet");
  }

  let res: Response;
  try {
    res = await fetch(`${CONTROLLER_BASE_URL}${path}`, {
      ...init,
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers,
    });
  } catch (err) {
    if (err instanceof ControllerError) {
      throw err;
    }
    const rawMessage = err instanceof Error ? err.message : String(err ?? "");
    const pnaPattern = /loopback|private network|local network|pna|permission.*denied/i;
    const permState = await queryLocalNetworkPermissionState();

    if (permState === "denied" || pnaPattern.test(rawMessage)) {
      throw new ControllerError(0, PNA_BLOCKED_MESSAGE, "pna_blocked");
    }
    if (!isLoopbackPageOrigin() && typeof window !== "undefined" && window.location?.protocol === "https:") {
      if (permState === "granted") {
        throw new ControllerError(
          0,
          "Local controller is unreachable at 127.0.0.1:47832. Make sure ScribaSheetWorkerController is running on this PC.",
          "network_offline",
        );
      }
      throw new ControllerError(
        0,
        "Could not reach the local worker controller at 127.0.0.1:47832 from this HTTPS site. Either the controller is not running or your browser blocked Local Network Access.",
        "unreachable_remote_https",
      );
    }
    throw new ControllerError(
      0,
      rawMessage || "Local worker controller is not reachable on 127.0.0.1:47832.",
      "network_offline",
    );
  }

  if (!res.ok) {
    let message = `Controller request failed (${res.status})`;
    try {
      const err = await res.json();
      message = err.detail || err.message || message;
    } catch {
      // ignore non-json error body
    }
    throw new ControllerError(res.status, message, res.status === 401 ? "auth_required" : "http_error");
  }
  return res.json() as Promise<T>;
}

export const workerController = {
  checkHealth: () => controllerRequest<ControllerHealth>("/health", { method: "GET" }, false),
  getStatus: () => controllerRequest<ControllerStatus>("/status", { method: "GET" }, true),
  startWorker: () => controllerRequest<ControllerStatus>("/worker/start", { method: "POST", body: "{}" }, true),
  stopWorker: () => controllerRequest<ControllerStatus>("/worker/stop", { method: "POST", body: "{}" }, true),
  restartWorker: () => controllerRequest<ControllerStatus>("/worker/restart", { method: "POST", body: "{}" }, true),
};
