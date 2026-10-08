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
 * One headless denial (plan 085 T2), from either agy 1.1.27's structured
 * `result.denied_actions` JSON list or the stderr auto-denial sentinel
 * (`agent-runtime.mjs#mergeDeniedActions`). `source` names which one
 * produced it. `displayName` is `null` when the source did not carry one
 * (always for `source: "stderr"`). `target` (additive, plan 086 T3) is the
 * denied tool-parameter value agy's `step_update` error message named,
 * joined onto the JSON-sourced member by action name
 * (`agent-runtime.mjs#joinDeniedActionTargets`); `null` when no matching
 * `step_update` was seen (always for `source: "stderr"`, which predates the
 * step-update join).
 *
 * @typedef {object} DeniedAction
 * @property {string} action agy tool id (e.g. "read_file", "read_url")
 * @property {string | null} displayName
 * @property {string | null} [target]
 * @property {'json' | 'stderr'} source
 */

/**
 * A {@link DeniedAction} projected with its remedy
 * (`job-helpers.mjs#deniedActionsWithRemedy`) — the shape every output path
 * (foreground envelope, single-job status/result `--json`, and their
 * markdown) renders under `deniedActions`.
 *
 * @typedef {object} DeniedActionWithRemedy
 * @property {string} action
 * @property {string | null} displayName
 * @property {string | null} target additive, plan 086 T3; `null` when unknown
 * @property {string} remedy
 */

/**
 * agy's print-timeout truncation marker (plan 086 T1,
 * `agent-runtime.mjs#detectPrintTimeoutTruncation`), riding through
 * `RuntimeResult`, `JobResult`, and the job record unchanged. `null`/absent
 * when the run's stderr carried no such marker.
 *
 * @typedef {object} AgyPrintTimeout
 * @property {string | null} limit the duration agy named (e.g. `"25s"`), or
 *   `null` when the marker line carried none
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
 * @property {string} [effort] agy reasoning effort: one of `AGY_EFFORTS`, or
 *   the `AGY_DEFAULT_EFFORT` sentinel meaning "send no `--effort` flag"
 *   (`job-helpers.mjs`) (plan 085 T3, additive on `task` and `rescue`; plan
 *   086 T2 added the `medium` default when the caller passes none; plan 086
 *   T5i added the sentinel). Records written before 086 T2 have no
 *   `request.effort` field.
 * @property {string} [requestId] the caller's `--request-id` (Senate R12,
 *   2026-09, background `task`/`rescue` only); absent without the flag
 * @property {string} [requestFingerprint] sha256 hex over the request's
 *   canonical JSON (`request-id.mjs#requestFingerprint`); present exactly
 *   when `requestId` is
 * @property {true} [findingsJson] `review --findings-json` (Senate R7,
 *   2026-09); absent without the flag. The worker forwards `--json-schema`
 *   for it and fails a job whose stored value is not a boolean.
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
 * @property {DeniedAction[] | null} [deniedActions] additive (plan 085 T2);
 *   `null`/absent on legacy records and on a run with no denial
 * @property {AgyPrintTimeout | null} [agyPrintTimeout] additive (plan 086
 *   T1); `null`/absent on legacy records and on a run with no print-timeout
 *   marker
 * @property {string | null} [reportedModel] additive (plan 103 T2, "Senate
 *   R11", 2026-09): the model agy's own `result` event named, when that
 *   event carries a model field. Measured against agy 1.2.11/1.2.12 it never
 *   does, so this is always `null` today; never derived from the model the
 *   caller requested. `null`/absent on legacy records.
 * @property {string | null} [structuredRaw] additive (Senate R7, 2026-09):
 *   agy's `structured_output` as JSON text, `null` when agy sent none (every
 *   run without `review --findings-json`); absent on legacy records.
 */

/**
 * A job's safe-provenance record (plan 103 T2, "Senate R11", 2026-09),
 * built once at job creation (`job-helpers.mjs#createTrackedJob`) and
 * retained on the job's index entry (top-level, so `state.mjs`'s
 * `jobIndexProjection` keeps it — it is not one of the stripped
 * `request`/`result`/`stdout` detail fields). Deliberately excludes the
 * prompt, workspace path, image paths, `extraArgs` content, and tool list:
 * enough to reproduce the run's settings, nothing free-text the caller gave
 * the model.
 *
 * @typedef {object} JobProvenance
 * @property {string | null} pluginVersion this plugin's own running version
 *   (`scripts/lib/update.mjs#readRunningVersion`); `null` only when the
 *   plugin's own `package.json` could not be read
 * @property {string | null} agyVersion the version the verb's own
 *   `agy --version` probe reported (`job-helpers.mjs#probeAgyForVerb`);
 *   `null` when the probe failed (the verb would already have exited before
 *   creating the job) or was never run
 * @property {string | null} model the resolved `--model` value, including
 *   the `agy-default` sentinel where applicable; `null` for a verb with no
 *   model concept (`review`)
 * @property {string | null} effort the resolved `--effort` value, including
 *   the `agy-default` sentinel; `null` for a verb with no effort flag
 *   (`review`, `vision`)
 * @property {"print" | "continue" | "conversation"} mode
 * @property {number} addDirCount the count of `--add-dir` values only, never
 *   the paths themselves
 * @property {string} requestedAt ISO timestamp, the same instant as the
 *   job's own `createdAt`
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
 * @property {string | null} [workerProcessStartedAt] the OS start time of
 *   `workerPid` (ISO), read once right after launch and never updated;
 *   `cancel` and the vanished-worker cleanup signal the PID only while its
 *   current start time matches; additive, `null`/absent on legacy records
 * @property {string | null} [agyProcessStartedAt] the same for `agyPid`
 * @property {string | null} [conversationId] the id the *caller* passed via
 *   `--conversation`; `null`/absent when the run started fresh or continued
 * @property {string | null} [agyConversationId] the id *agy itself reported*
 *   for the run, present whenever agy reported one — including a failed or
 *   denied run — so a host can resume it even when the caller passed none
 *   (plan 086 T5k F1); additive, `null`/absent on legacy records
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
 * @property {DeniedAction[] | null} [deniedActions] raw (no remedy) headless
 *   denials from the terminal run, set at job finish (plan 085 T2);
 *   additive, `null`/absent on legacy records and a run with no denial
 * @property {number} [deniedActionsCount] `deniedActions?.length ?? 0`, set
 *   at job finish so a status list can show a marker without the full array
 *   (plan 085 T2); additive, absent on legacy records
 * @property {AgyPrintTimeout | null} [agyPrintTimeout] agy's print-timeout
 *   truncation marker from the terminal run, set at job finish (plan 086
 *   T1); additive, `null`/absent on legacy records and a run with no marker
 * @property {JobProvenance | null} [provenance] additive (plan 103 T2,
 *   "Senate R11", 2026-09), set once at job creation
 *   (`job-helpers.mjs#createTrackedJob`); `null`/absent on legacy records
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
 * @property {string | null} [oauthUrl] always null: no OAuth URL is shown
 * @property {string} stdout
 * @property {string} [rawStdout]
 * @property {AgyUsage | null} usage
 * @property {number | null} durationSeconds
 * @property {string | null} agyConversationId
 * @property {string[]} warnings
 * @property {{ tool: string, line: string } | null} [denial]
 * @property {DeniedAction[] | null} [deniedActions] additive (plan 085 T2);
 *   see `agent-runtime.mjs#mergeDeniedActions`
 * @property {AgyPrintTimeout | null} [agyPrintTimeout] additive (plan 086
 *   T1); see `agent-runtime.mjs#detectPrintTimeoutTruncation`
 * @property {unknown} [structured] additive (Senate R7, 2026-09): the
 *   `result` event's `structured_output` as agy sent it (object or string),
 *   `null` when absent
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
 * @property {AgyPrintTimeout} [details.agyPrintTimeout] additive (plan 086
 *   T1): present on a completed foreground envelope and on `result <id>
 *   --json` when agy's print timeout truncated the answer;
 *   `details.job.agyPrintTimeout` carries the same shape on `status <id>
 *   --json`. Distinct from `details.truncated` above on purpose — that key
 *   already means the `--head`/`--tail` display cut.
 * @property {JsonErrorDetail} [details.error] additive (plan 103 T3, "Senate
 *   R1", 2026-09; `render.mjs#createErrorEnvelope`): present on an expected
 *   failure once `--json` was accepted by the parser — `answer` is `null` on
 *   every envelope that carries this, except `result <id>` on a stored
 *   failed job, which keeps its stored answer and adds this key alongside
 *   it. Absent on every completed/queued/no_changes envelope.
 */

/**
 * The `details.error` shape a Task 3 failure envelope always carries
 * (`render.mjs#createErrorEnvelope`, `render.mjs#ERROR_CODES` for the full
 * `code` enum). `message` is the plugin's own one-line reason: never a
 * token, an OAuth URL, or the full upstream stderr.
 *
 * @typedef {object} JsonErrorDetail
 * @property {string} code snake_case, one of `render.mjs#ERROR_CODES`
 * @property {"validate" | "collect" | "probe" | "run" | "wait" | "state"} phase
 * @property {string} message
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
 * @property {string} [effort] agy reasoning effort, one of `AGY_EFFORTS`
 *   (`job-helpers.mjs`); additive (plan 085 T3), forwarded only when given
 * @property {string[]} [extraArgs]
 * @property {string} [jsonSchemaPath] forwarded as `--json-schema <path>`
 *   right before `--print-timeout` (Senate R7, 2026-09)
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
