import * as childProcess from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ProcessResult } from "./types";

interface RunOptions {
  cwd: string;
  input?: string;
  timeoutMs?: number;
  onOutput?: (text: string) => void;
  signal?: AbortSignal;
}

const executableCache = new Map<string, string>();
const executableLookups = new Map<string, Promise<string | undefined>>();
let executableCacheGeneration = 0;

export async function findExecutable(command: string): Promise<string | undefined> {
  const cleaned = command.trim().replace(/^"|"$/g, "");
  if (!cleaned || /[\r\n]/.test(cleaned)) {
    return undefined;
  }
  const cacheKey = executableCacheKey(cleaned);
  const cached = executableCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const pending = executableLookups.get(cacheKey);
  if (pending) {
    return pending;
  }
  const generation = executableCacheGeneration;
  const lookup = locateExecutable(cleaned).then((resolved) => {
    if (resolved && generation === executableCacheGeneration) {
      executableCache.set(cacheKey, resolved);
    }
    return resolved;
  }).finally(() => {
    executableLookups.delete(cacheKey);
  });
  executableLookups.set(cacheKey, lookup);
  return lookup;
}

export function clearExecutableCache(command?: string): void {
  executableCacheGeneration += 1;
  if (!command) {
    executableCache.clear();
    executableLookups.clear();
    return;
  }
  const cleaned = command.trim().replace(/^"|"$/g, "");
  if (!cleaned) {
    return;
  }
  const cacheKey = executableCacheKey(cleaned);
  executableCache.delete(cacheKey);
  executableLookups.delete(cacheKey);
}

async function locateExecutable(cleaned: string): Promise<string | undefined> {
  if (path.isAbsolute(cleaned)) {
    try {
      await fs.access(cleaned);
      return cleaned;
    } catch {
      return undefined;
    }
  }

  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = await runProcess(locator, [cleaned], { cwd: process.cwd(), timeoutMs: 10_000 });
  if (result.code !== 0) {
    return undefined;
  }
  const matches = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (process.platform === "win32") {
    return matches.find((item) => /\.(?:exe|cmd|bat|com)$/i.test(item)) ?? matches[0];
  }
  return matches[0];
}

function executableCacheKey(command: string): string {
  return process.platform === "win32" ? command.toLowerCase() : command;
}

export function runProcess(command: string, args: string[], options: RunOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const launch = windowsLaunch(command, args);
    const child = childProcess.spawn(launch.command, launch.args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forcedSettlement: NodeJS.Timeout | undefined;
    const abort = (): void => {
      terminateProcessTree(child);
      forcedSettlement ??= setTimeout(() => {
        finish({ code: null, stdout, stderr, timedOut: false });
      }, 5_000);
    };
    const finish = (result: ProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forcedSettlement) {
        clearTimeout(forcedSettlement);
      }
      options.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
      forcedSettlement = setTimeout(() => {
        finish({ code: null, stdout, stderr, timedOut: true });
      }, 5_000);
    }, options.timeoutMs ?? 60_000);

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      options.onOutput?.(text);
    });
    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      options.onOutput?.(text);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        if (forcedSettlement) {
          clearTimeout(forcedSettlement);
        }
        options.signal?.removeEventListener("abort", abort);
        reject(error);
      }
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut });
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
        stderr += `\n标准输入写入失败：${error.message}`;
      }
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

function terminateProcessTree(child: childProcess.ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    const killer = childProcess.spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.unref();
    return;
  }
  child.kill("SIGTERM");
}

function windowsLaunch(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args };
  }
  const codexEntry = path.join(path.dirname(command), "node_modules", "@openai", "codex", "bin", "codex.js");
  if (/codex\.cmd$/i.test(command) && fsSync.existsSync(codexEntry)) {
    const nodeExecutable = resolveNodeExecutable(path.dirname(command));
    if (nodeExecutable) {
      return { command: nodeExecutable, args: [codexEntry, ...args] };
    }
  }
  const commandLine = [command, ...args].map(quoteCmdArgument).join(" ");
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", commandLine]
  };
}

function resolveNodeExecutable(npmDirectory: string): string | undefined {
  const adjacent = path.join(npmDirectory, "node.exe");
  if (fsSync.existsSync(adjacent)) {
    return adjacent;
  }
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, "node.exe");
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function quoteCmdArgument(value: string): string {
  return `"${value.replace(/(["^&|<>%!])/g, "^$1")}"`;
}
