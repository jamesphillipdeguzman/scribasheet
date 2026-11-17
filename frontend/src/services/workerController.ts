export const CONTROLLER_BASE_URL =
  import.meta.env.VITE_WORKER_CONTROLLER_URL || "http://127.0.0.1:47832";

const CONTROLLER_TOKEN_KEY = "scribasheet_controller_token";

export interface ControllerHealth {
  controller_online: boolean;
  requires_pairing: boolean;
  host?: string;
}

export interface ControllerStatus {
  controller_online: boolean;
  worker_running: boolean;
  managed_by_controller: boolean;
  external_worker_detected: boolean;
  pid: number | null;
  started_at: string | null;
  last_exit_code: number | null;
  last_error: string | null;
  log_path: string;
  log_tail: string[];
  ok?: boolean;
  message?: string;
}

export class ControllerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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

  const res = await fetch(`${CONTROLLER_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  if (!res.ok) {
    let message = `Controller request failed (${res.status})`;
    try {
      const err = await res.json();
      message = err.detail || err.message || message;
    } catch {
      // ignore non-json error body
    }
    throw new ControllerError(res.status, message);
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
