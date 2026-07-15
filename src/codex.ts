import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AssistantUnavailableError, RevisionAdapter } from "./assistantTypes";
import { findExecutable, runProcess } from "./processRunner";
import { buildRevisionTask, parseRevisionResponse, validateRevisionResult } from "./revisionTask";
import { CodexResult, SourceMapping } from "./types";

export class CodexUnavailableError extends AssistantUnavailableError {
  public constructor(taskText: string) {
    super(taskText, "codex");
  }
}

export class CodexAdapter implements RevisionAdapter {
  public constructor(private readonly command: string) {}

  public async generateReplacement(
    projectRoot: string,
    mapping: SourceMapping,
    instruction: string,
    onOutput?: (text: string) => void
  ): Promise<CodexResult> {
    const task = buildCodexTask(mapping, instruction);
    const executable = await findExecutable(this.command);
    if (!executable) {
      throw new CodexUnavailableError(task);
    }

    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-"));
    const outputPath = path.join(tempDirectory, "result.json");
    const schemaPath = path.join(tempDirectory, "schema.json");
    try {
      await fs.writeFile(schemaPath, JSON.stringify({
        type: "object",
        additionalProperties: false,
        required: ["summary", "replacement"],
        properties: {
          summary: { type: "string", maxLength: 240 },
          replacement: { type: "string" }
        }
      }), "utf8");
      const args = [
        "-a", "never",
        "exec",
        "-s", "read-only",
        "-C", projectRoot,
        "--skip-git-repo-check",
        "--color", "never",
        "--json",
        "--output-schema", schemaPath,
        "--output-last-message", outputPath,
        "-"
      ];
      const result = await runProcess(executable, args, {
        cwd: projectRoot,
        input: task,
        timeoutMs: 10 * 60_000,
        onOutput
      });
      if (result.timedOut) {
        throw new Error("Codex 分析超过 10 分钟，已终止本次请求。");
      }
      if (result.code !== 0) {
        throw new Error(`Codex 执行失败（退出码 ${result.code ?? "未知"}），详细输出已写入 CircleTeX 日志。`);
      }

      let response = "";
      try {
        response = await fs.readFile(outputPath, "utf8");
      } catch {
        response = result.stdout;
      }
      return validateCodexResult(parseJsonResponse(response), mapping.sourceText.length);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

export function buildCodexTask(mapping: SourceMapping, instruction: string): string {
  return buildRevisionTask(mapping, instruction);
}

export function parseJsonResponse(response: string): unknown {
  return parseRevisionResponse(response);
}

export function validateCodexResult(value: unknown, originalLength: number): CodexResult {
  return validateRevisionResult(value, originalLength);
}
