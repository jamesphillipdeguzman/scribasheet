// Temporary diagnostic instrumentation for tracing playhead startup latency.

interface DiagState {
  playStartMs: number;
  lastEventMs: number;
  loggedFirstScheduled: boolean;
  loggedFirstAudible: boolean;
  loggedFirstRaf: boolean;
  loggedFirstCursor: boolean;
}

const state: DiagState = {
  playStartMs: 0,
  lastEventMs: 0,
  loggedFirstScheduled: false,
  loggedFirstAudible: false,
  loggedFirstRaf: false,
  loggedFirstCursor: false,
};

export function diagMarkPlayInteraction(detail?: Record<string, unknown>): void {
  const now = performance.now();
  state.playStartMs = now;
  state.lastEventMs = now;
  state.loggedFirstScheduled = false;
  state.loggedFirstAudible = false;
  state.loggedFirstRaf = false;
  state.loggedFirstCursor = false;
  console.info("[PlaybackDiag] +0.0ms (+0.0ms) Play button interaction", detail ?? {});
}

export function diagLogEvent(label: string, detail?: Record<string, unknown>): void {
  const now = performance.now();
  const base = state.playStartMs > 0 ? state.playStartMs : now;
  const prev = state.lastEventMs > 0 ? state.lastEventMs : now;
  const totalMs = (now - base).toFixed(1);
  const deltaMs = (now - prev).toFixed(1);
  state.lastEventMs = now;
  console.info(`[PlaybackDiag] +${totalMs}ms (+${deltaMs}ms) ${label}`, detail ?? {});
}

export function diagLogOnce(
  key: "firstScheduled" | "firstAudible" | "firstRaf" | "firstCursor",
  label: string,
  detail?: Record<string, unknown>,
): void {
  if (key === "firstScheduled") {
    if (state.loggedFirstScheduled) return;
    state.loggedFirstScheduled = true;
  } else if (key === "firstAudible") {
    if (state.loggedFirstAudible) return;
    state.loggedFirstAudible = true;
  } else if (key === "firstRaf") {
    if (state.loggedFirstRaf) return;
    state.loggedFirstRaf = true;
  } else if (key === "firstCursor") {
    if (state.loggedFirstCursor) return;
    state.loggedFirstCursor = true;
  }
  diagLogEvent(label, detail);
}
