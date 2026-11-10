"use strict";

// An empty write queues a barrier after earlier writes. Keep forced termination:
// foreground bridges, child handles and worker timers must not keep the CLI alive.
function flushStream(stream) {
  if (!stream.writableLength || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    // A closed reader is not a new command outcome. Do not emit a stack while exiting.
    stream.on("error", () => {});
    try { stream.write("", () => resolve()); } catch { resolve(); }
  });
}

function createProcessEnd(runtime = process) {
  let ending;
  return function endProcess(code = runtime.exitCode ?? 0) {
    if (ending) return ending;
    ending = Promise.all([flushStream(runtime.stdout), flushStream(runtime.stderr)])
      .then(() => runtime.exit(code));
    return ending;
  };
}

module.exports = { createProcessEnd, endProcess: createProcessEnd() };
