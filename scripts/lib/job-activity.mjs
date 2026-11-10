import { patchJobState } from "./state.mjs";

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_MIN_GAP_MS = 5_000;

/**
 * Coalesce observed output and heartbeats through one write budget. The
 * synchronous runtime callbacks never leave a rejected write unhandled;
 * finish() drains that write before the caller commits a terminal state.
 *
 * @param {string} workspaceRoot the resolved workspace root
 * @param {string} jobId
 * @param {{ heartbeat?: boolean, now?: () => number, patch?: typeof patchJobState,
 *   setIntervalImpl?: typeof setInterval, clearIntervalImpl?: typeof clearInterval }} [options]
 * @returns {{ onText: () => void, setAgyIsAlive: (probe: () => boolean) => void,
 *   agyAliveFields: () => { agyAliveAt?: string }, finish: () => Promise<void> }}
 */
export function createJobActivityRecorder(workspaceRoot, jobId, {
  heartbeat = false,
  now = Date.now,
  patch = patchJobState,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let lastPatchAt = -Infinity;
  let progressAt = null;
  let pending = Promise.resolve();
  let writing = false;
  let failure;
  let stopped = false;
  let agyIsAlive = () => false;

  // libuv win/process.c retains the process handle until main-thread
  // endgame, after exit notification (Node 22.3.0:903, 25.8.1:884).
  // Windows reserves the PID while that handle exists. Sample in the same
  // synchronous step as the child-session check. A backwards system-clock
  // change between OS creation time and this reading invalidates the bound.
  function agyAliveFields() {
    return agyIsAlive() ? { agyAliveAt: new Date(now()).toISOString() } : {};
  }

  function record(output = false) {
    if (stopped) return;
    const time = now();
    if (output) progressAt = new Date(time).toISOString();
    if (writing || time - lastPatchAt < HEARTBEAT_MIN_GAP_MS) return;
    lastPatchAt = time;
    const fields = {
      ...(heartbeat ? { lastHeartbeatAt: new Date(time).toISOString() } : {}),
      ...(heartbeat ? agyAliveFields() : {}),
      ...(progressAt ? { lastProgressAt: progressAt, lastModelOutputAt: progressAt } : {}),
    };
    writing = true;
    pending = Promise.resolve().then(() => patch(workspaceRoot, jobId, fields))
      .catch((error) => { failure = error; })
      .finally(() => { writing = false; });
  }

  const timer = heartbeat ? setIntervalImpl(() => record(), HEARTBEAT_INTERVAL_MS) : null;
  timer?.unref();

  return {
    setAgyIsAlive: (probe) => { agyIsAlive = probe; },
    agyAliveFields,
    onText: () => record(true),
    async finish() {
      stopped = true;
      if (timer !== null) clearIntervalImpl(timer);
      await pending;
      if (failure) throw failure;
    },
  };
}
