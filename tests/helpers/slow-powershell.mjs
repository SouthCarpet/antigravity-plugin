/**
 * A slow `powershell.exe` stand-in for tests (Windows only).
 *
 * On Windows the plugin reads a process start time with PowerShell
 * (`readProcessStartTime` in scripts/lib/process.mjs). Under load that query
 * can take seconds. This helper makes the delay deterministic: it writes a
 * `powershell.exe` into a directory of the caller. Put that directory first
 * on the `PATH` of the process under test.
 *
 * The stand-in waits `delayMs` and then answers the start-time query by
 * itself: it takes the PID from the `-Id <pid>` text of the command, reads
 * the start time of that process from the OS, and prints it in the format
 * of the real query. For a process that is gone it prints an error and
 * exits 1, as the real query does. It starts no PowerShell, so its answer
 * time is the delay plus a few milliseconds, also under load.
 *
 * The stand-in is one small C# program, compiled once through the cache of
 * tests/helpers/fake-agy.mjs and copied per call. It reads its delay from a
 * sibling `powershell.exe.control.txt`.
 */
import fs from "node:fs";
import path from "node:path";

import { compileCsharpExe } from "./fake-agy.mjs";

const CSHARP_SOURCE = `using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;

class Program {
    static int Main(string[] args) {
        string exePath = Process.GetCurrentProcess().MainModule.FileName;
        int delayMs = 0;
        foreach (var line in File.ReadAllLines(exePath + ".control.txt")) {
            if (line.StartsWith("DELAYMS=")) delayMs = int.Parse(line.Substring(8));
        }
        Thread.Sleep(delayMs);
        Match id = Regex.Match(string.Join(" ", args), @"-Id (\\d+)");
        if (!id.Success) {
            Console.Error.WriteLine("slow-powershell: only the start-time query is supported");
            return 2;
        }
        try {
            DateTime started = Process.GetProcessById(int.Parse(id.Groups[1].Value)).StartTime;
            Console.Out.WriteLine(started.ToUniversalTime().ToString("o"));
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine("Get-Process : " + error.Message);
            return 1;
        }
    }
}
`;

/**
 * Write a slow `powershell.exe` into `dir` and return `dir`.
 *
 * @param {string} dir directory of the caller (a test temp directory)
 * @param {number} delayMs how long each call waits before it answers
 * @returns {string} the directory to put first on `PATH`
 */
export function writeSlowPowerShell(dir, delayMs) {
  if (process.platform !== "win32") throw new Error("writeSlowPowerShell: Windows only");
  const exePath = path.join(dir, "powershell.exe");
  fs.copyFileSync(compileCsharpExe(CSHARP_SOURCE), exePath);
  fs.writeFileSync(`${exePath}.control.txt`, `DELAYMS=${delayMs}\n`, "utf8");
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
