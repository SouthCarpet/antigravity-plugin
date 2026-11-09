/**
 * A slow `powershell.exe` stand-in for tests (Windows only).
 *
 * On Windows the plugin reads a process start time with PowerShell
 * (`readProcessStartTime` in scripts/lib/process.mjs). Under load that query
 * can take seconds. This helper makes the delay deterministic: it writes a
 * `powershell.exe` into a directory of the caller, which waits `delayMs` and
 * then runs the real PowerShell with the same arguments, streams and exit
 * code. Put that directory first on the `PATH` of the process under test.
 *
 * The stand-in is one small C# program, compiled once through the cache of
 * tests/helpers/fake-agy.mjs and copied per call. It reads its delay and the
 * real PowerShell path from a sibling `powershell.exe.control.txt`.
 */
import fs from "node:fs";
import path from "node:path";

import { compileCsharpExe } from "./fake-agy.mjs";

const CSHARP_SOURCE = `using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

class Program {
    static string Quote(string arg) {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\\t', '"' }) < 0) return arg;
        return "\\"" + arg.Replace("\\"", "\\\\\\"") + "\\"";
    }

    static int Main(string[] args) {
        string exePath = Process.GetCurrentProcess().MainModule.FileName;
        int delayMs = 0;
        string real = "";
        foreach (var line in File.ReadAllLines(exePath + ".control.txt")) {
            int eq = line.IndexOf('=');
            if (eq < 0) continue;
            string key = line.Substring(0, eq);
            string val = line.Substring(eq + 1);
            if (key == "DELAYMS") delayMs = int.Parse(val);
            if (key == "REAL") real = val;
        }
        Thread.Sleep(delayMs);
        // The child inherits this process's streams, so its output reaches the caller.
        var start = new ProcessStartInfo(real, string.Join(" ", Array.ConvertAll(args, Quote)));
        start.UseShellExecute = false;
        using (var child = Process.Start(start)) {
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
`;

/** The PowerShell that Windows ships, by its full path (never a PATH lookup). */
function realPowerShellPath() {
  const windir = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.join(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Write a slow `powershell.exe` into `dir` and return `dir`.
 *
 * @param {string} dir directory of the caller (a test temp directory)
 * @param {number} delayMs how long each call waits before the real query runs
 * @returns {string} the directory to put first on `PATH`
 */
export function writeSlowPowerShell(dir, delayMs) {
  if (process.platform !== "win32") throw new Error("writeSlowPowerShell: Windows only");
  const exePath = path.join(dir, "powershell.exe");
  fs.copyFileSync(compileCsharpExe(CSHARP_SOURCE), exePath);
  fs.writeFileSync(`${exePath}.control.txt`, `DELAYMS=${delayMs}\nREAL=${realPowerShellPath()}\n`, "utf8");
  return dir;
}

/**
 * A copy of `env` with `dir` first on the search path. Windows spells the
 * variable `Path`; the existing key is reused so that the copy holds one.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} dir
 * @returns {NodeJS.ProcessEnv}
 */
export function withPathFirst(env, dir) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  return { ...env, [key]: `${dir}${path.delimiter}${env[key] ?? ""}` };
}
