import { useEffect, useSyncExternalStore } from "react";

export interface WorkerConnectionState {
  isConnecting: boolean;
  justConnected: boolean;
  timedOut: boolean;
  exitedEarly: boolean;
  progress: number;
  action: "start" | "restart" | null;
}

const CONNECT_TIMEOUT_MS = 20_000;
const PROGRESS_RAMP_MS = 10_000;
const TICK_INTERVAL_MS = 200;
const COMPLETION_HOLD_MS = 900;

let state: WorkerConnectionState = {
  isConnecting: false,
  justConnected: false,
  timedOut: false,
  exitedEarly: false,
  progress: 0,
  action: null,
};

const listeners = new Set<() => void>();
let startedAtMs = 0;
let tickTimerId: number | null = null;
let completionTimerId: number | null = null;

function emit() {
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

function clearTimers() {
  if (tickTimerId !== null && typeof window !== "undefined") {
    window.clearInterval(tickTimerId);
    tickTimerId = null;
  }
  if (completionTimerId !== null && typeof window !== "undefined") {
    window.clearTimeout(completionTimerId);
    completionTimerId = null;
  }
}

export function resetWorkerConnectionState() {
  clearTimers();
  state = {
    isConnecting: false,
    justConnected: false,
    timedOut: false,
    exitedEarly: false,
    progress: 0,
    action: null,
  };
  emit();
}

export function beginWorkerConnecting(action: "start" | "restart") {
  clearTimers();
  startedAtMs = Date.now();
  state = {
    isConnecting: true,
    justConnected: false,
    timedOut: false,
    exitedEarly: false,
    progress: 10,
    action,
  };
  emit();

  if (typeof window !== "undefined") {
    tickTimerId = window.setInterval(() => {
      if (!state.isConnecting) {
        clearTimers();
        return;
      }
      const elapsed = Date.now() - startedAtMs;
      if (elapsed >= CONNECT_TIMEOUT_MS) {
        clearTimers();
        state = {
          ...state,
          isConnecting: false,
          justConnected: false,
          timedOut: true,
          progress: 0,
        };
        emit();
        return;
      }
      const nextProgress = Math.min(92, Math.round(10 + 82 * Math.min(1, elapsed / PROGRESS_RAMP_MS)));
      if (nextProgress !== state.progress) {
        state = { ...state, progress: nextProgress };
        emit();
      }
    }, TICK_INTERVAL_MS);
  }
}

export function confirmWorkerConnected() {
  if (!state.isConnecting) return;
  clearTimers();
  state = {
    ...state,
    isConnecting: false,
    justConnected: true,
    timedOut: false,
    exitedEarly: false,
    progress: 100,
  };
  emit();

  if (typeof window !== "undefined") {
    completionTimerId = window.setTimeout(() => {
      state = {
        ...state,
        justConnected: false,
        progress: 0,
      };
      emit();
    }, COMPLETION_HOLD_MS);
  }
}

export function markWorkerExitedDuringStartup() {
  if (!state.isConnecting) return;
  // Give controller status 1500ms after Start/Restart before treating stopped as early exit
  if (Date.now() - startedAtMs < 1500) return;
  clearTimers();
  state = {
    ...state,
    isConnecting: false,
    justConnected: false,
    timedOut: false,
    exitedEarly: true,
    progress: 0,
  };
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): WorkerConnectionState {
  return state;
}

export function useWorkerConnection(
  railwayOnline?: boolean,
  localRunning?: boolean,
): WorkerConnectionState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (snapshot.isConnecting && railwayOnline === true) {
      confirmWorkerConnected();
    }
  }, [snapshot.isConnecting, railwayOnline]);

  useEffect(() => {
    if (snapshot.isConnecting && localRunning === false) {
      markWorkerExitedDuringStartup();
    }
  }, [snapshot.isConnecting, localRunning]);

  return snapshot;
}
