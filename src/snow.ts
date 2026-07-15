import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { AssistantUnavailableError, RevisionAdapter } from "./assistantTypes";
import { findExecutable } from "./processRunner";
import { buildRevisionTask, parseRevisionResponse, validateRevisionResult } from "./revisionTask";
import { CodexResult, SourceMapping } from "./types";

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
const MAX_GLOBAL_SETTINGS_BYTES = 1024 * 1024;

const DISABLED_BUILT_IN_SERVICES = [
  "filesystem",
  "terminal",
  "todo",
  "notebook",
  "ace",
  "websearch",
  "ide",
  "codebase",
  "askuser",
  "scheduler",
  "goal",
  "skill",
  "subagent",
  "team"
] as const;

export interface SnowAdapterOptions {
  timeoutMs?: number;
  tempRoot?: string;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface JsonRecord {
  [key: string]: unknown;
}

export class SnowAdapter implements RevisionAdapter {
  public constructor(
    private readonly command: string,
    private readonly options: SnowAdapterOptions = {}
  ) {}

  public async generateReplacement(
    _projectRoot: string,
    mapping: SourceMapping,
    instruction: string,
    onOutput?: (text: string) => void
  ): Promise<CodexResult> {
    const task = buildRevisionTask(mapping, instruction);
    const executable = await findExecutable(this.command);
    if (!executable) {
      throw new AssistantUnavailableError(task, "snow");
    }

    const tempRoot = this.options.tempRoot ?? os.tmpdir();
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDirectory = await fs.mkdtemp(path.join(tempRoot, "circletex-snow-"));
    let client: SnowAcpClient | undefined;
    try {
      await writeIsolatedSnowSettings(tempDirectory);
      client = new SnowAcpClient(executable, tempDirectory, onOutput);
      const response = await client.run(task, normalizeTimeout(this.options.timeoutMs));
      return validateRevisionResult(parseRevisionResponse(response), mapping.sourceText.length);
    } finally {
      await client?.stop();
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

class SnowAcpClient {
  private readonly child: childProcess.ChildProcessWithoutNullStreams;
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<number, PendingRequest>();
  private readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private stdoutBuffer = "";
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private responseText = "";
  private nextRequestId = 1;
  private sessionId?: string;
  private failure?: Error;
  private closing = false;

  public constructor(
    executable: string,
    private readonly cwd: string,
    private readonly onOutput?: (text: string) => void
  ) {
    const launch = commandLaunch(executable, ["--acp"]);
    this.child = childProcess.spawn(launch.command, launch.args, {
      cwd,
      env: isolatedEnvironment(cwd),
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.attachProcessListeners();
  }

  public async run(task: string, timeoutMs: number): Promise<string> {
    const timeout = setTimeout(() => {
      this.fail(new Error("Snow CLI 分析超过 10 分钟，已终止本次请求。"), true);
    }, timeoutMs);
    try {
      const initializeResult = requireRecord(await this.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        },
        clientInfo: { name: "circletex", title: "CircleTeX", version: "0.8.2" }
      }), "Snow ACP 初始化响应");
      if (initializeResult.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new Error("Snow CLI 返回了不兼容的 ACP 协议版本。");
      }

      const sessionResult = requireRecord(await this.request("session/new", {
        cwd: this.cwd,
        mcpServers: []
      }), "Snow ACP 会话响应");
      const sessionId = sessionResult.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256) {
        throw new Error("Snow CLI 未返回有效的 ACP 会话标识。");
      }
      this.sessionId = sessionId;

      const promptResult = requireRecord(await this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: task }]
      }), "Snow ACP 分析响应");
      if (promptResult.stopReason !== "end_turn") {
        throw new Error(`Snow CLI 分析未正常结束（${String(promptResult.stopReason ?? "未知原因")}）。`);
      }
      if (this.failure) {
        throw this.failure;
      }
      if (!this.responseText.trim()) {
        throw new Error("Snow CLI 未返回可用的修订建议。");
      }
      return this.responseText;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async stop(): Promise<void> {
    if (this.closing) {
      await this.closed;
      return;
    }
    this.closing = true;
    try {
      this.child.stdin.end();
    } catch {
      // 子进程可能已经结束。
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await Promise.race([this.closed, delay(250)]);
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      terminateProcessTree(this.child);
      await Promise.race([this.closed, delay(1_000)]);
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGKILL");
        await Promise.race([this.closed, delay(500)]);
      }
    }
  }

  private attachProcessListeners(): void {
    this.child.stdout.on("data", (data: Buffer) => this.acceptStdout(data));
    this.child.stdout.on("end", () => {
      const remaining = this.decoder.end();
      if (remaining) {
        this.stdoutBuffer += remaining;
      }
      if (this.stdoutBuffer.trim()) {
        if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_LINE_BYTES) {
          this.fail(new Error("Snow CLI ACP 返回了异常过长的 NDJSON 单行。"), true);
        } else {
          this.acceptLine(this.stdoutBuffer);
        }
        this.stdoutBuffer = "";
      }
    });
    this.child.stderr.on("data", (data: Buffer) => {
      this.stderrBytes += data.length;
      if (this.stderrBytes > MAX_STDERR_BYTES) {
        this.fail(new Error("Snow CLI 错误输出异常过长，已终止本次请求。"), true);
        return;
      }
      this.emitOutput(data.toString("utf8"));
    });
    this.child.on("error", (error) => {
      this.fail(new Error(`Snow CLI 进程启动失败：${error.message}`), false);
    });
    this.child.on("close", (code) => {
      this.resolveClosed();
      if (!this.closing && !this.failure) {
        this.fail(new Error(`Snow CLI ACP 进程在响应完成前退出（退出码 ${code ?? "未知"}）。`), false);
      }
    });
  }

  private acceptStdout(data: Buffer): void {
    if (this.failure) {
      return;
    }
    this.stdoutBytes += data.length;
    if (this.stdoutBytes > MAX_STDOUT_BYTES) {
      this.fail(new Error("Snow CLI ACP 标准输出异常过长，已终止本次请求。"), true);
      return;
    }
    this.stdoutBuffer += this.decoder.write(data);
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_LINE_BYTES && !this.stdoutBuffer.includes("\n")) {
      this.fail(new Error("Snow CLI ACP 返回了异常过长的 NDJSON 单行。"), true);
      return;
    }
    let lineEnd = this.stdoutBuffer.indexOf("\n");
    while (lineEnd >= 0 && !this.failure) {
      const line = this.stdoutBuffer.slice(0, lineEnd).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(lineEnd + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        this.fail(new Error("Snow CLI ACP 返回了异常过长的 NDJSON 单行。"), true);
        return;
      }
      if (line.trim()) {
        this.acceptLine(line);
      }
      lineEnd = this.stdoutBuffer.indexOf("\n");
    }
    if (!this.failure && Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_LINE_BYTES) {
      this.fail(new Error("Snow CLI ACP 返回了异常过长的 NDJSON 单行。"), true);
    }
  }

  private acceptLine(line: string): void {
    if (this.failure) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.fail(new Error("Snow CLI ACP 返回了非法 NDJSON。"), true);
      return;
    }
    if (!isRecord(value) || value.jsonrpc !== "2.0") {
      this.fail(new Error("Snow CLI ACP 返回了无效的 JSON-RPC 消息。"), true);
      return;
    }
    if (typeof value.method === "string") {
      if (Object.prototype.hasOwnProperty.call(value, "id")) {
        this.handleServerRequest(value);
      } else {
        this.handleNotification(value.method, value.params);
      }
      return;
    }
    this.handleResponse(value);
  }

  private handleResponse(message: JsonRecord): void {
    if (typeof message.id !== "number" || !Number.isInteger(message.id)) {
      this.fail(new Error("Snow CLI ACP 返回了无效的 JSON-RPC 响应标识。"), true);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.fail(new Error("Snow CLI ACP 返回了无法关联的 JSON-RPC 响应。"), true);
      return;
    }
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      const error = isRecord(message.error) && typeof message.error.message === "string"
        ? message.error.message
        : "未知 ACP 错误";
      pending.reject(new Error(`Snow CLI ACP 请求 ${pending.method} 失败：${error}`));
      return;
    }
    pending.resolve(message.result);
  }

  private handleServerRequest(message: JsonRecord): void {
    const method = message.method as string;
    if (method === "session/request_permission") {
      this.writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: { outcome: { outcome: "cancelled" } }
      });
      return;
    }
    this.writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "CircleTeX 只读分析不提供该 ACP 客户端能力。" }
    });
    const category = method.startsWith("fs/") || method.startsWith("terminal/")
      ? "文件或终端"
      : "无法识别的";
    this.fail(new Error(`Snow CLI 尝试发起${category} ACP 请求（${method}），已取消本次只读分析。`), true);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "session/update") {
      return;
    }
    if (!isRecord(params) || !isRecord(params.update)) {
      this.fail(new Error("Snow CLI ACP 返回了无效的会话更新。"), true);
      return;
    }
    if (!this.sessionId || params.sessionId !== this.sessionId) {
      this.fail(new Error("Snow CLI ACP 返回了不属于当前会话的内容分块。"), true);
      return;
    }
    const update = params.update;
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.fail(new Error("Snow CLI 尝试调用工具，已取消本次只读分析。"), true);
      return;
    }
    if (update.sessionUpdate !== "agent_message_chunk") {
      return;
    }
    if (!isRecord(update.content) || update.content.type !== "text" || typeof update.content.text !== "string") {
      this.fail(new Error("Snow CLI ACP 返回了无效的文本响应分块。"), true);
      return;
    }
    if (this.responseText.length + update.content.text.length > MAX_RESPONSE_CHARS) {
      this.fail(new Error("Snow CLI 返回的文本响应异常过长，已终止本次请求。"), true);
      return;
    }
    this.responseText += update.content.text;
  }

  private request(method: string, params: JsonRecord): Promise<unknown> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      if (!this.writeMessage({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id);
        reject(this.failure ?? new Error("Snow CLI ACP 标准输入不可用。"));
      }
    });
  }

  private fail(error: Error, cancel: boolean): void {
    if (this.failure) {
      return;
    }
    if (cancel && this.sessionId) {
      this.writeMessage({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: this.sessionId }
      });
    }
    this.failure = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private writeMessage(message: JsonRecord): boolean {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      return false;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8", (error) => {
        if (error && !this.closing) {
          this.fail(new Error(`Snow CLI ACP 标准输入写入失败：${error.message}`), false);
        }
      });
      return true;
    } catch (error) {
      if (!this.closing) {
        this.fail(new Error(`Snow CLI ACP 标准输入写入失败：${error instanceof Error ? error.message : String(error)}`), false);
      }
      return false;
    }
  }

  private emitOutput(text: string): void {
    try {
      this.onOutput?.(text);
    } catch {
      // 日志回调不影响 ACP 协议处理。
    }
  }
}

async function writeIsolatedSnowSettings(tempDirectory: string): Promise<void> {
  const snowDirectory = path.join(tempDirectory, ".snow");
  await fs.mkdir(snowDirectory, { recursive: true });
  const mcpServers = Object.fromEntries(
    (await readGlobalMcpNames()).map((name) => [name, { enabled: false }])
  );
  const settings = {
    disabledBuiltInServices: [...DISABLED_BUILT_IN_SERVICES],
    toolSearchEnabled: false,
    teamMode: false,
    ultraTodoEnabled: false,
    telemetry: { enabled: false, captureContent: false },
    mcpServers
  };
  await Promise.all([
    fs.writeFile(path.join(snowDirectory, "settings.json"), JSON.stringify(settings, null, 2), "utf8"),
    fs.writeFile(path.join(snowDirectory, "permissions.json"), JSON.stringify({ alwaysApprovedTools: [] }, null, 2), "utf8")
  ]);
}

async function readGlobalMcpNames(): Promise<string[]> {
  const settingsPath = path.join(os.homedir(), ".snow", "settings.json");
  let stat;
  try {
    stat = await fs.stat(settingsPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw new Error("CircleTeX 无法只读检查 Snow CLI 全局设置，已取消自动分析。");
  }
  if (!stat.isFile() || stat.size > MAX_GLOBAL_SETTINGS_BYTES) {
    throw new Error("Snow CLI 全局设置文件异常，无法建立隔离的自动分析环境。");
  }
  try {
    const value: unknown = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    if (!isRecord(value)) {
      throw new Error("顶层设置格式无效");
    }
    if (value.mcpServers === undefined) {
      return [];
    }
    if (!isRecord(value.mcpServers)) {
      throw new Error("mcpServers 格式无效");
    }
    const names = Object.keys(value.mcpServers);
    if (names.length > 256 || names.some((name) => name.length === 0 || name.length > 200)) {
      throw new Error("mcpServers 列表异常");
    }
    return names;
  } catch (error) {
    throw new Error(`Snow CLI 全局设置无法安全解析：${error instanceof Error ? error.message : String(error)}`);
  }
}

function commandLaunch(
  command: string,
  args: string[]
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args };
  }
  const commandLine = [command, ...args].map(quoteCmdArgument).join(" ");
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}

function isolatedEnvironment(cwd: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  const isolatedKeys = new Set(["PWD", "OLDPWD", "INIT_CWD", "VSCODE_CWD"]);
  for (const key of Object.keys(environment)) {
    if (isolatedKeys.has(key.toUpperCase())) {
      delete environment[key];
    }
  }
  for (const key of isolatedKeys) {
    environment[key] = cwd;
  }
  return environment;
}

function quoteCmdArgument(value: string): string {
  return `"${value.replace(/(["^&|<>%!])/g, "^$1")}"`;
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

function normalizeTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_MS;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${label}格式无效。`);
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
