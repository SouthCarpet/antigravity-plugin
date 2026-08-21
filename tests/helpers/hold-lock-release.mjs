/**
 * Child-only preload for the lifecycle cancellation regression.
 *
 * The worker's startup state update is normally too brief for a parent test
 * to observe without racing its release. Pause the worker immediately before
 * that release while leaving owner.json unchanged. Cancellation then reaps
 * the lock as if the injected process-tree termination had killed the worker;
 * once the lock disappears, exit before the still-live test worker can write
 * a later terminal result over the cancelled state.
 */
import fs from "node:fs";
import path from "node:path";

const lockPath = process.env.ANTIGRAVITY_TEST_HOLD_LOCK_PATH;
const markerPath = process.env.ANTIGRAVITY_TEST_HOLD_LOCK_MARKER;
const startGatePath = process.env.ANTIGRAVITY_TEST_WORKER_START_GATE;

if (lockPath && markerPath && startGatePath) {
  const startupDeadline = Date.now() + 30_000;
  while (!fs.existsSync(startGatePath) && Date.now() < startupDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!fs.existsSync(startGatePath)) process.exit(85);

  const resolvedLockPath = path.resolve(lockPath);
  const originalRmSync = fs.rmSync.bind(fs);

  fs.rmSync = (targetPath, options) => {
    if (path.resolve(String(targetPath)) !== resolvedLockPath) {
      return originalRmSync(targetPath, options);
    }

    fs.writeFileSync(markerPath, String(process.pid), "utf8");
    const deadline = Date.now() + 30_000;
    while (fs.existsSync(resolvedLockPath) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }

    // This worker models the process that the injected terminator reports as
    // killed. Do not let it resume and overwrite the cancellation outcome.
    process.exit(fs.existsSync(resolvedLockPath) ? 86 : 0);
  };
}
