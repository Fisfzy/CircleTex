import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SnowAdapter } from "../snow";
import { SourceMapping } from "../types";

const mapping: SourceMapping = {
  id: "mapping-1",
  sourcePath: "main.tex",
  startLine: 10,
  endLine: 10,
  startOffset: 100,
  endOffset: 104,
  sourceText: "原文\n",
  contextText: "上下文\n原文\n",
  contextStartLine: 9,
  documentHash: "hash",
  normalizedDocumentHash: "normalized-hash",
  selection: {
    kind: "text",
    text: "原文",
    page: 1,
    start: { x: 1, y: 1 },
    end: { x: 2, y: 2 }
  }
};

describe("Snow ACP 只读适配器", () => {
  it("合并分块响应并校验隔离设置", async () => {
    await withFakeSnow("normal", async ({ command, tempRoot }) => {
      const adapter = new SnowAdapter(command, { tempRoot, timeoutMs: 5_000 });
      const result = await adapter.generateReplacement(
        "SHOULD_NOT_REACH_SNOW",
        mapping,
        "压缩表述"
      );
      assert.deepEqual(result, { summary: "压缩表述", replacement: "替换正文\n" });
    });
  });

  it("对权限请求回复取消后仍可接收纯文本结果", async () => {
    await withFakeSnow("permission", async ({ command, tempRoot }) => {
      const adapter = new SnowAdapter(command, { tempRoot, timeoutMs: 5_000 });
      const result = await adapter.generateReplacement("ignored", mapping, "修改");
      assert.equal(result.replacement, "替换正文\n");
    });
  });

  it("检测到工具调用时取消并拒绝结果", async () => {
    await withFakeSnow("tool", async ({ command, tempRoot }) => {
      const adapter = new SnowAdapter(command, { tempRoot, timeoutMs: 5_000 });
      await assert.rejects(
        adapter.generateReplacement("ignored", mapping, "修改"),
        /尝试调用工具/
      );
    });
  });

  it("拒绝非法 NDJSON", async () => {
    await withFakeSnow("invalid", async ({ command, tempRoot }) => {
      const adapter = new SnowAdapter(command, { tempRoot, timeoutMs: 5_000 });
      await assert.rejects(
        adapter.generateReplacement("ignored", mapping, "修改"),
        /非法 NDJSON/
      );
    });
  });

  it("拒绝非 end_turn 结束原因", async () => {
    await withFakeSnow("non-end", async ({ command, tempRoot }) => {
      const adapter = new SnowAdapter(command, { tempRoot, timeoutMs: 5_000 });
      await assert.rejects(
        adapter.generateReplacement("ignored", mapping, "修改"),
        /未正常结束/
      );
    });
  });

  it("拒绝其他会话的响应分块", async () => {
    await withFakeSnow("wrong-session", async ({ command, tempRoot }) => {
      const adapter = new SnowAdapter(command, { tempRoot, timeoutMs: 5_000 });
      await assert.rejects(
        adapter.generateReplacement("ignored", mapping, "修改"),
        /不属于当前会话/
      );
    });
  });

  it("报告 ACP 子进程提前退出", async () => {
    await withFakeSnow("early-exit", async ({ command, tempRoot }) => {
      const adapter = new SnowAdapter(command, { tempRoot, timeoutMs: 5_000 });
      await assert.rejects(
        adapter.generateReplacement("ignored", mapping, "修改"),
        /响应完成前退出/
      );
    });
  });

  it("超时后取消会话并终止子进程", async () => {
    await withFakeSnow("timeout", async ({ command, tempRoot }) => {
      const adapter = new SnowAdapter(command, { tempRoot, timeoutMs: 100 });
      await assert.rejects(
        adapter.generateReplacement("ignored", mapping, "修改"),
        /分析超过 10 分钟/
      );
    });
  });

  it("拒绝服务端文件请求", async () => {
    await withFakeSnow("file-request", async ({ command, tempRoot }) => {
      const adapter = new SnowAdapter(command, { tempRoot, timeoutMs: 5_000 });
      await assert.rejects(
        adapter.generateReplacement("ignored", mapping, "修改"),
        /文件或终端 ACP 请求/
      );
    });
  });
});

interface FakeHarness {
  command: string;
  tempRoot: string;
}

async function withFakeSnow(
  scenario: string,
  action: (harness: FakeHarness) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-snow-test-"));
  const tempRoot = path.join(root, "adapter-temp");
  await fs.mkdir(tempRoot, { recursive: true });
  const command = await createFakeSnowCommand(root, scenario);
  try {
    await action({ command, tempRoot });
    assert.deepEqual(await fs.readdir(tempRoot), [], "Snow 临时目录应在请求后清理");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function createFakeSnowCommand(root: string, scenario: string): Promise<string> {
  const scriptPath = path.join(root, "fake-snow.cjs");
  await fs.writeFile(scriptPath, fakeSnowSource(scenario), "utf8");
  if (process.platform === "win32") {
    const commandPath = path.join(root, "fake-snow.cmd");
    await fs.writeFile(
      commandPath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      "utf8"
    );
    return commandPath;
  }
  const commandPath = path.join(root, "fake-snow");
  await fs.writeFile(
    commandPath,
    `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    "utf8"
  );
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

function fakeSnowSource(scenario: string): string {
  return `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const scenario = ${JSON.stringify(scenario)};
const sessionId = "fake-session";
let promptId;
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const responseText = JSON.stringify({ summary: "压缩表述", replacement: "替换正文\\n" });

function sendResult(id, stopReason = "end_turn") {
  const middle = Math.floor(responseText.length / 2);
  for (const text of [responseText.slice(0, middle), responseText.slice(middle)]) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
      }
    });
  }
  send({ jsonrpc: "2.0", id, result: { stopReason } });
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    return;
  }
  if (message.method === "session/new") {
    const settingsPath = path.join(message.params.cwd, ".snow", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const required = ["filesystem", "terminal", "todo", "subagent", "team"];
    const isolatedEnvironment = ["PWD", "OLDPWD", "INIT_CWD", "VSCODE_CWD"]
      .every((name) => process.env[name] === message.params.cwd);
    if (!message.params.cwd.includes("circletex-snow-") ||
        !required.every((name) => settings.disabledBuiltInServices.includes(name)) ||
        settings.toolSearchEnabled !== false || settings.teamMode !== false ||
        !isolatedEnvironment) {
      process.exit(11);
    }
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    const task = message.params.prompt[0].text;
    if (task.includes("SHOULD_NOT_REACH_SNOW")) process.exit(12);
    if (scenario === "normal") return sendResult(promptId);
    if (scenario === "permission") {
      send({
        jsonrpc: "2.0",
        id: "permission-1",
        method: "session/request_permission",
        params: { sessionId, options: [{ optionId: "reject_once", kind: "reject_once", name: "拒绝" }] }
      });
      return;
    }
    if (scenario === "tool") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "filesystem-read" } }
      });
      return;
    }
    if (scenario === "invalid") return process.stdout.write("{broken\\n");
    if (scenario === "non-end") return sendResult(promptId, "max_tokens");
    if (scenario === "wrong-session") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "other-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: responseText } }
        }
      });
      return;
    }
    if (scenario === "early-exit") return process.exit(3);
    if (scenario === "file-request") {
      send({
        jsonrpc: "2.0",
        id: "file-1",
        method: "fs/read_text_file",
        params: { sessionId, path: "main.tex" }
      });
      return;
    }
    return;
  }
  if (message.id === "permission-1") {
    if (!message.result || !message.result.outcome || message.result.outcome.outcome !== "cancelled") {
      process.exit(13);
    }
    sendResult(promptId);
    return;
  }
  if (message.method === "session/cancel") process.exit(0);
});
`;
}
