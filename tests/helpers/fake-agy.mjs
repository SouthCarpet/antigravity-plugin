/**
 * Cross-platform fake-binary factory for tests that spawn a stand-in `agy`.
 *
 * Node's `child_process.spawn()` cannot run a POSIX `#!/bin/sh` script on
 * Windows (no shebang support — CreateProcess only launches genuine PE
 * executables), so the old approach (a `#!/bin/sh` file with no extension,
 * chmod 0o755) silently produced an empty child on Windows: no `data`
 * event ever fires, so `stdout`/`stderr` stay `''`.
 *
 * A `.cmd`/`.bat` stub is not a fix either: as of the CVE-2024-27980
 * hardening, `spawn()` throws `EINVAL` for a `.bat`/`.cmd` target unless the
 * caller passes `{ shell: true }` — and `agent-runtime.mjs` deliberately
 * does not (Node itself deprecates combining `shell: true` with an argv
 * array — DEP0190 — because the array is concatenated into the shell
 * command line unescaped, which is exactly the injection risk the CVE fix
 * targeted; `addDirs`/`conversationId` values are not fully trusted, so
 * this file must not push that risk into the production spawn calls).
 *
 * So on win32 this factory instead compiles ONE tiny native C# console app
 * (via the `csc.exe` that ships with every .NET Framework install — no new
 * dependency) once, caches it by content hash under `os.tmpdir()`, and
 * copies that compiled `.exe` per stub name. Each copy reads its OWN
 * behaviour (stdout/stderr/exit code/delay/echo-argv) from a sibling
 * `<name>.exe.control.txt` file at startup — a real, directly spawnable
 * executable, so it exercises the exact same `spawn(bin, args)` path
 * (no shell) that production code uses.
 *
 * On POSIX this still writes the classic `#!/bin/sh` script + chmod, from
 * the same structured description, so both platforms are generated from
 * one call site.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CSHARP_SOURCE = `using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

class Program {
    static int Main(string[] args) {
        string exePath = Process.GetCurrentProcess().MainModule.FileName;
        string controlPath = exePath + ".control.txt";
        string stdout = "", stderr = "";
        int exitCode = 0, delayMs = 0;
        bool echoArgs = false, echoArgsStderr = false;
        if (File.Exists(controlPath)) {
            foreach (var line in File.ReadAllLines(controlPath)) {
                int eq = line.IndexOf('=');
                if (eq < 0) continue;
                string key = line.Substring(0, eq);
                string val = line.Substring(eq + 1);
                switch (key) {
                    case "EXITCODE": exitCode = int.Parse(val); break;
                    case "DELAYMS": delayMs = int.Parse(val); break;
                    case "ECHOARGS": echoArgs = val == "1"; break;
                    case "ECHOARGS_STDERR": echoArgsStderr = val == "1"; break;
                    case "STDOUT_B64": stdout = Encoding.UTF8.GetString(Convert.FromBase64String(val)); break;
                    case "STDERR_B64": stderr = Encoding.UTF8.GetString(Convert.FromBase64String(val)); break;
                }
            }
        }
        if (echoArgs) {
            foreach (var a in args) Console.Out.WriteLine("arg=" + a);
        }
        if (echoArgsStderr) {
            foreach (var a in args) Console.Error.WriteLine("arg=" + a);
        }
        if (stdout.Length > 0) Console.Out.Write(stdout);
        Console.Out.Flush();
        if (stderr.Length > 0) Console.Error.Write(stderr);
        Console.Error.Flush();
        if (delayMs > 0) Thread.Sleep(delayMs);
        return exitCode;
    }
}
`;

function resolveCsc() {
  const windir = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
  const candidates = [
    path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "csc"; // last resort: hope it's on PATH
}

let cachedTemplatePath = null;

/** Compile (or reuse a cached compile of) the fake-agy template exe. */
function ensureTemplateExe() {
  if (cachedTemplatePath && fs.existsSync(cachedTemplatePath)) return cachedTemplatePath;

  const hash = createHash("sha256").update(CSHARP_SOURCE).digest("hex").slice(0, 16);
  const cacheDir = path.join(os.tmpdir(), "antigravity-fake-agy-template");
  const exePath = path.join(cacheDir, `template-${hash}.exe`);
  if (fs.existsSync(exePath)) {
    cachedTemplatePath = exePath;
    return exePath;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const srcPath = path.join(cacheDir, `template-${hash}.cs`);
  fs.writeFileSync(srcPath, CSHARP_SOURCE, "utf8");
  execFileSync(resolveCsc(), ["/nologo", `/out:${exePath}`, srcPath], { stdio: "pipe" });
  cachedTemplatePath = exePath;
  return exePath;
}

function writeWindowsStub(dir, name, { stdout, stderr, exitCode, delayMs, echoArgs, echoArgsStderr }) {
  const template = ensureTemplateExe();
  const exePath = path.join(dir, `${name}.exe`);
  fs.copyFileSync(template, exePath);
  const lines = [
    `EXITCODE=${exitCode}`,
    `DELAYMS=${delayMs}`,
    `ECHOARGS=${echoArgs ? 1 : 0}`,
    `ECHOARGS_STDERR=${echoArgsStderr ? 1 : 0}`,
    `STDOUT_B64=${Buffer.from(stdout, "utf8").toString("base64")}`,
    `STDERR_B64=${Buffer.from(stderr, "utf8").toString("base64")}`,
  ];
  fs.writeFileSync(`${exePath}.control.txt`, `${lines.join("\n")}\n`, "utf8");
  return exePath;
}

/** Single-quote a value for POSIX sh, escaping embedded single quotes. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writePosixStub(dir, name, { stdout, stderr, exitCode, delayMs, echoArgs, echoArgsStderr }) {
  const lines = ["#!/bin/sh"];
  if (echoArgs) {
    lines.push('for a in "$@"; do echo arg=$a; done');
  }
  if (echoArgsStderr) {
    lines.push('for a in "$@"; do echo arg=$a 1>&2; done');
  }
  if (stdout) lines.push(`printf '%s\\n' ${shQuote(stdout)}`);
  if (stderr) lines.push(`printf '%s\\n' ${shQuote(stderr)} 1>&2`);
  if (delayMs > 0) lines.push(`sleep ${delayMs / 1000}`);
  lines.push(`exit ${exitCode}`);
  const p = path.join(dir, name);
  fs.writeFileSync(p, `${lines.join("\n")}\n`, { mode: 0o755 });
  return p;
}

/**
 * Write a fake `agy` binary and return its spawnable path.
 *
 * @param {string} dir directory to write the stub into (caller-owned tmpdir)
 * @param {string} name base name (no extension — one is added per platform)
 * @param {{
 *   stdout?: string,
 *   stderr?: string,
 *   exitCode?: number,
 *   delayMs?: number,
 *   echoArgs?: boolean,
 *   echoArgsStderr?: boolean,
 * }} [opts] `echoArgs` prints one `arg=<value>` line per argv entry to
 *   stdout; `echoArgsStderr` does the same to stderr (useful when a verb
 *   only surfaces the child's stderr, i.e. on failure).
 * @returns {string} absolute path to the spawnable stub
 */
export function writeFakeAgy(dir, name, opts = {}) {
  const {
    stdout = "", stderr = "", exitCode = 0, delayMs = 0, echoArgs = false, echoArgsStderr = false,
  } = opts;
  const normalized = { stdout, stderr, exitCode, delayMs, echoArgs, echoArgsStderr };
  return process.platform === "win32"
    ? writeWindowsStub(dir, name, normalized)
    : writePosixStub(dir, name, normalized);
}
