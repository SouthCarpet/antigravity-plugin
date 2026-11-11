import { appendJobLog, readJobFile, resolveStateDir, patchJobStateUnlocked } from './state.mjs';
import { withWorkspaceMutex } from './atomic-state.mjs';
import { safeFailureReason, removeOAuthUrlsDeep } from './safe-reason.mjs';
import { redactBypassFlag } from './render.mjs';

/** Record a safe fatal reason without replacing a finished job.
 * @param {string} workspaceRoot
 * @param {string} jobId
 * @param {unknown} error
 * @returns {Promise<void>}
 */
export async function recordWorkerFatal(workspaceRoot, jobId, error) {
  const normalized = safeFailureReason(redactBypassFlag(removeOAuthUrlsDeep(String(error?.message ?? error)))) ?? 'Worker failed.';
  const reason = redactBypassFlag(removeOAuthUrlsDeep(normalized));
  try { appendJobLog(workspaceRoot, jobId, `[worker] fatal: ${reason}`); } catch { /* Storage can be unavailable. */ }
  await withWorkspaceMutex(resolveStateDir(workspaceRoot), () => {
    const job = readJobFile(workspaceRoot, jobId, { strict: true });
    if (!job || !['running', 'queued'].includes(job.status)) return;
    const workerPid = Number(job.workerPid ?? job.pid);
    if (workerPid > 0 && workerPid !== process.pid) return;
    patchJobStateUnlocked(workspaceRoot, jobId, {
      status: 'failed', phase: 'failed', completedAt: new Date().toISOString(),
      errorMessage: reason, healthStatus: 'failed',
    });
  });
}
