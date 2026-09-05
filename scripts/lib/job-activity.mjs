import { patchJobState } from "./state.mjs";

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_MIN_GAP_MS = 5_000;

/**
 * Coalesce observed output and heartbeats through one write budget. The
 * synchronous runtime callbacks never leave a rejected write unhandled;
 * finish() drains that write before the caller commits a terminal state.
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

  function record(output = false) {
    if (stopped) return;
    const time = now();
    if (output) progressAt = new Date(time).toISOString();
    if (writing || time - lastPatchAt < HEARTBEAT_MIN_GAP_MS) return;
    lastPatchAt = time;
    const fields = {
      ...(heartbeat ? { lastHeartbeatAt: new Date(time).toISOString() } : {}),
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
    onText: () => record(true),
    async finish() {
      stopped = true;
      if (timer !== null) clearIntervalImpl(timer);
      await pending;
      if (failure) throw failure;
    },
  };
}
