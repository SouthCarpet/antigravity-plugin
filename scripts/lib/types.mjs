/**
 * Shared JSDoc vocabulary for the antigravity-plugin scripts.
 *
 * Type-only module: every export below is a `@typedef`, none is a runtime
 * value. `export {}` marks the file as an ES module so `@import`-style
 * `import('./types.mjs').X` references resolve from other files.
 *
 * These typedefs describe the shapes already produced and consumed across
 * `job-helpers.mjs`, `_worker.mjs`, `job-control.mjs`, `state.mjs`,
 * `agent-runtime.mjs`, `render.mjs`, and `process.mjs`; they document the
 * existing contract, they do not add or rename a runtime field.
 */

/**
 * @typedef {"review" | "rescue" | "task" | "vision"} JobKind
 */

/**
 * @typedef {"queued" | "running" | "completed" | "failed" | "cancelled"} JobStatus
 */

/**
 * The job's diagnostic classification, either persisted (a terminal or
 * stuck-worker signal) or computed live by `job-control.mjs`'s runtime
 * health classifier.
 *
 * @typedef {"active" | "quiet" | "possibly_stalled" | "worker_missing" |
 *   "auth_required" | "failed" | "cancel_failed"} HealthStatus
 */

/**
 * The outcome `runAgyPrint` (agent-runtime.mjs) reports for one `agy`
 * invocation, mapped onto a persisted `JobStatus` by
 * `job-helpers.mjs#deriveJobStatus`.
 *
 * @typedef {"completed" | "failed" | "cancelled" | "auth_required" |
 *   "timeout"} RuntimeStatus
 */

/**
 * Token usage as agy reports it in its `--output-format json` result event.
 *
 * @typedef {object} AgyUsage
 * @property {number} [total_tokens]
 * @property {number} [input_tokens]
 * @property {number} [output_tokens]
 */

/**
 * The request payload persisted alongside a job (`state.mjs`'s per-job
 * `.json` file, `request` field) so a background worker can replay it.
 *
 * @typedef {object} JobRequest
 * @property {string} prompt
 * @property {"print" | "continue" | "conversation"} [mode]
 * @property {string} [conversationId]
 * @property {string[]} [addDirs]
 * @property {string[]} [extraArgs]
 * @property {string} [cwd]
 * @property {number} [timeoutMs] agy execution budget in ms (added T3, R1);
 *   legacy records without it fall back to `DEFAULT_AGY_TIMEOUT_MS`.
 * @property {string} [model] agy model id (076-T7 R3, additive on `task` and
 *   `rescue`; `vision` already had this field)
 */

/**
 * The `result` field persisted on a job record once a run reaches a
 * terminal state, built by `job-helpers.mjs#buildStoredResult` for both the
 * foreground and background (worker) paths.
 *
 * @typedef {object} JobResult
 * @property {string | null} rawOutput
 * @property {string | null} stderr
 * @property {RuntimeStatus} status
 * @property {number | null} exitCode
 * @property {string | null} oauthUrl
 * @property {AgyUsage | null} usage
 * @property {number | null} durationSeconds
 * @property {string | null} agyConversationId
 * @property {string[]} warnings
 */

/**
 * One entry in `state.json`'s `jobs` index — a `JobRecord` with the
 * detail-only fields (`request`, `result`, `stdout`) stripped
 * (`state.mjs`'s `jobIndexProjection`).
 *
 * @typedef {object} JobIndexEntry
 * @property {string} id
 * @property {JobKind} kind
 * @property {string | null} title
 * @property {JobStatus} status
 * @property {string} [phase]
 * @property {string | null} [sessionId]
 * @property {number | null} [pid]
 * @property {number | null} [workerPid]
 * @property {number | null} [agyPid]
 * @property {string | null} [conversationId]
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} [startedAt]
 * @property {string | null} [completedAt]
 * @property {string} [logFile]
 * @property {HealthStatus | null} [healthStatus]
 * @property {string | null} [healthMessage]
 * @property {string | null} [recommendedAction]
 * @property {string | null} [errorMessage]
 * @property {string | null} [summary]
 * @property {string | null} [lastHeartbeatAt] observed worker heartbeat (T4)
 * @property {string | null} [lastProgressAt] observed model/tool output (T4)
 * @property {string | null} [lastModelOutputAt] observed model text (T4)
 * @property {string | null} [lastDiagnosticAt] observed diagnostic event (T4)
 * @property {number | null} [answerBytes] UTF-8 byte length of the stored
 *   answer, set at job finish (076-T7 R1); additive, `null` on legacy records
 * @property {number | null} [answerLines] line count of the stored answer, a
 *   trailing newline does not add a line (076-T7 R1); additive, `null` on
 *   legacy records
 */

/**
 * The full per-job detail record persisted at
 * `<stateDir>/jobs/<job-id>.json` — a `JobIndexEntry` plus the request that
 * produced it and its terminal result, once known.
 *
 * @typedef {JobIndexEntry & { request?: JobRequest | null, result?: JobResult | null }} JobRecord
 */

/**
 * The raw object `runAgyPrint` (agent-runtime.mjs) resolves with — the
 * source `job-helpers.mjs#buildStoredResult` and `#deriveJobStatus` project
 * onto a `JobResult` and a persisted `JobStatus`.
 *
 * @typedef {object} RuntimeResult
 * @property {RuntimeStatus} status
 * @property {string} stderr
 * @property {string | null} errorMessage
 * @property {number | null} exitCode
 * @property {string} [oauthUrl]
 * @property {string} stdout
 * @property {string} [rawStdout]
 * @property {AgyUsage | null} usage
 * @property {number | null} durationSeconds
 * @property {string | null} agyConversationId
 * @property {string[]} warnings
 * @property {{ tool: string, line: string } | null} [denial]
 * @property {string | null} [spawnError]
 */

/**
 * The stable `--json` outer envelope (docs/COMPATIBILITY.md, "Output
 * contract") every verb emits under `--json`, built by
 * `render.mjs#createJsonEnvelope`. `model` and `imagePaths` are additional
 * top-level fields `vision` alone promises.
 *
 * @typedef {object} JsonEnvelopeV1
 * @property {1} schemaVersion
 * @property {"review" | "rescue" | "task" | "vision" | "status" | "result" | "cancel"} command
 * @property {string} status
 * @property {string | null} jobId
 * @property {string | null} answer
 * @property {object} details
 * @property {string} [model] vision only
 * @property {string[]} [imagePaths] vision only
 * @property {boolean} [details.truncated] `result` only, additive (076-T7
 *   R1): set when `--head`/`--tail` cut the stored answer
 */

/**
 * The outcome `process.mjs#terminateProcessTree` resolves with after
 * attempting to stop a process tree.
 *
 * @typedef {object} TerminationResult
 * @property {"killed" | "not_found" | "denied" | "failed"} outcome
 * @property {boolean} killed
 * @property {number} pid
 * @property {number | null} status
 * @property {object[]} attempts
 * @property {string} message
 */

/**
 * Options accepted by `agent-runtime.mjs#runAgyPrint` / `#spawnAgy` — one
 * `agy --print` invocation.
 *
 * @typedef {object} ProcessRequest
 * @property {string} prompt
 * @property {"print" | "continue" | "conversation"} [mode]
 * @property {string} [conversationId]
 * @property {string} [cwd]
 * @property {string[]} [addDirs]
 * @property {string} [model]
 * @property {string[]} [extraArgs]
 * @property {string} [bin]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {number} [timeoutMs]
 * @property {"text" | "json"} [outputFormat]
 * @property {(chunk: string) => void} [onStdout]
 * @property {(chunk: string) => void} [onStderr]
 * @property {(delta: string) => void} [onText]
 * @property {(info: { pid: number | undefined }) => void | Promise<void>} [onSpawn]
 */

export {};
