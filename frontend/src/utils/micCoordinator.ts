/**
 * Lightweight exclusive microphone ownership coordinator.
 *
 * Ensures client-side Web Audio microphone workflows (such as the Studio
 * Instrument Tuner and Live Mic / Violin Input) do not open competing
 * getUserMedia streams simultaneously, and stopping one workflow never
 * tears down another active workflow's microphone resources.
 */

export type MicConsumerId = "tuner" | "live_mic_input";

interface MicOwnerEntry {
  id: MicConsumerId;
  release: () => void;
}

let activeOwner: MicOwnerEntry | null = null;

/**
 * Acquire exclusive microphone ownership for ``id``. If another consumer
 * currently holds the microphone, its release callback is invoked cleanly first.
 */
export function acquireExclusiveMic(id: MicConsumerId, release: () => void): void {
  if (activeOwner && activeOwner.id !== id) {
    const previous = activeOwner;
    activeOwner = null;
    try {
      previous.release();
    } catch {
      // Ignore cleanup errors from previous consumer
    }
  }
  activeOwner = { id, release };
}

/**
 * Release microphone ownership only if ``id`` is the current owner.
 */
export function releaseExclusiveMic(id: MicConsumerId): void {
  if (activeOwner?.id === id) {
    activeOwner = null;
  }
}

/**
 * Return the ID of the current microphone owner, if any.
 */
export function getActiveMicOwner(): MicConsumerId | null {
  return activeOwner?.id ?? null;
}

/**
 * Test helper to reset module-level microphone coordinator state between tests.
 */
export function resetMicCoordinatorForTests(): void {
  activeOwner = null;
}
