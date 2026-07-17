import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import { findExecutable, runProcess } from "./processRunner";
import { isExecutableBinaryFile } from "./skillPackage";
import { SkillRegistry } from "./skillRegistry";
import {
  ImportedSkill,
  SkillProgressStage,
  SkillRunnerProgress,
  SkillTaskArtifact,
  SkillTaskHistoryEntry,
  SkillTaskProgress,
  SkillTaskQualityGate,
  SkillTaskResult
} from "./skillTypes";
import { PdfSelection, ProjectPaths } from "./types";

const MAX_INPUT_FILES = 1_000;
const MAX_INPUT_BYTES = 500 * 1024 * 1024;
const MAX_OUTPUT_FILES = 100;
const MAX_OUTPUT_BYTES = 500 * 1024 * 1024;
const FORBIDDEN_OUTPUT_EXTENSIONS = new Set([".exe", ".dll", ".com", ".msi", ".scr", ".sys", ".bat", ".cmd", ".ps1"]);
const RESOURCE_EXTENSIONS = new Set([".bib", ".cls", ".sty", ".bst", ".png", ".jpg", ".jpeg", ".pdf", ".svg", ".eps"]);
const MATHTYPE_PROG_ID = "Equation.DSMT4";

export interface SkillAgentResult {
  status: "success" | "failed";
  summary: string;
  artifacts: Array<{ path: string; type: string; description: string }>;
  warnings: string[];
  qualityGates?: SkillTaskQualityGate[];
}

export interface SkillAgentRunContext {
  taskRoot: string;
  inputRoot: string;
  skillRoot: string;
  workRoot?: string;
  outputRoot: string;
  schemaPath: string;
  responsePath: string;
  skill: ImportedSkill;
  signal: AbortSignal;
  onOutput?: (text: string) => void;
  onProgress?: (progress: SkillRunnerProgress) => void;
}

export interface SkillAgentRunner {
  readonly id: "codex" | "circletex";
  run(context: SkillAgentRunContext): Promise<SkillAgentResult>;
}

export class CodexSkillRunner implements SkillAgentRunner {
  public readonly id = "codex" as const;

  public constructor(private readonly command: string) {}

  public async run(context: SkillAgentRunContext): Promise<SkillAgentResult> {
    const executable = await findExecutable(this.command);
    if (!executable) {
      throw new Error("未找到 Codex CLI，无法执行 Skill 任务。");
    }
    const processResult = await runProcess(executable, [
      "-a", "never",
      "exec",
      "-s", "workspace-write",
      "-C", context.taskRoot,
      "--skip-git-repo-check",
      "--color", "never",
      "--json",
      "--output-schema", context.schemaPath,
      "--output-last-message", context.responsePath,
      "-"
    ], {
      cwd: context.taskRoot,
      input: buildSkillTaskPrompt(context.skill),
      timeoutMs: context.skill.permissions.timeoutMinutes * 60_000,
      onOutput: context.onOutput,
      signal: context.signal
    });
    ensureNotAborted(context.signal);
    if (processResult.timedOut) {
      throw new Error(`Skill 任务超过 ${context.skill.permissions.timeoutMinutes} 分钟，已终止。`);
    }
    if (processResult.code !== 0) {
      throw new Error(`Codex Skill 任务执行失败，退出码 ${processResult.code ?? "未知"}。`);
    }
    return parseAgentResult(await fs.readFile(context.responsePath, "utf8"));
  }
}

export interface RunSkillTaskOptions {
  skill: ImportedSkill;
  project: ProjectPaths;
  prompt: string;
  selection?: PdfSelection;
  sourceRange?: { startLine: number; endLine: number; sourceText: string };
  codexCommand: string;
  signal: AbortSignal;
  onProgress: (progress: SkillTaskProgress) => void;
  onOutput?: (text: string) => void;
}

export class SkillTaskService {
  public constructor(
    private readonly registry: SkillRegistry,
    private readonly createRunner: (command: string, skill: ImportedSkill) => SkillAgentRunner = (command) => new CodexSkillRunner(command)
  ) {}

  public async run(options: RunSkillTaskOptions): Promise<SkillTaskResult> {
    const taskId = randomUUID();
    const startedAt = new Date().toISOString();
    const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), `circletex-skill-${taskId}-`));
    const inputRoot = path.join(taskRoot, "input");
    const skillRoot = path.join(taskRoot, "skill");
    const workRoot = options.skill.permissions.writableWorkDirectory ? path.join(taskRoot, "work") : undefined;
    const outputRoot = path.join(taskRoot, "output");
    let runnerId: SkillAgentRunner["id"] = "codex";
    let result: SkillTaskResult;
    try {
      ensureNotAborted(options.signal);
      validateTaskRequest(options);
      options.onProgress({ stage: "preparing", percent: 4, message: "正在准备论文输入快照" });
      await Promise.all([fs.mkdir(inputRoot), fs.mkdir(skillRoot), fs.mkdir(outputRoot), ...(workRoot ? [fs.mkdir(workRoot)] : [])]);
      const inputFiles = await copyProjectSnapshot(options.project, inputRoot, options.skill.permissions.inputPreset);
      if (workRoot) {
        await copyDirectoryStrict(inputRoot, workRoot, MAX_INPUT_FILES, MAX_INPUT_BYTES);
      }
      options.onProgress({ stage: "preparing", percent: 12, message: "正在复制并核验 Skill 快照" });
      const registeredSnapshot = this.registry.snapshotPath(options.skill);
      const snapshotInspection = await this.registry.inspect(registeredSnapshot);
      if (snapshotInspection.hash !== options.skill.hash || snapshotInspection.binaryFiles.length > 0) {
        throw new Error("Skill 快照与注册表记录不一致，请重新导入并确认权限。");
      }
      await copyDirectoryStrict(registeredSnapshot, skillRoot, 1000, 100 * 1024 * 1024);
      const taskManifest = {
        taskId,
        skill: { id: options.skill.id, name: options.skill.displayName, hash: options.skill.hash },
        taskType: options.skill.permissions.taskType,
        scope: options.skill.permissions.scope,
        userPrompt: options.prompt,
        selection: options.selection ? {
          ...selectionManifest(options.selection),
          source: options.sourceRange
        } : undefined,
        inputs: inputFiles,
        outputExtensions: options.skill.permissions.outputExtensions,
        declaredCommands: options.skill.permissions.declaredCommands,
        rules: {
          mustReadSkillCompletely: true,
          mayModifyInput: false,
          mayModifySkill: false,
          mayModifyWork: Boolean(workRoot),
          mayWriteOutsideOutput: false,
          network: false
        }
      };
      await fs.writeFile(path.join(taskRoot, "task.json"), JSON.stringify(taskManifest, null, 2), "utf8");
      const schemaPath = path.join(taskRoot, "result-schema.json");
      const responsePath = path.join(taskRoot, "agent-result.json");
      await fs.writeFile(schemaPath, JSON.stringify(agentResultSchema(), null, 2), "utf8");
      const immutableBefore = await hashImmutableTaskFiles([inputRoot, skillRoot], [
        path.join(taskRoot, "task.json"),
        schemaPath
      ]);

      ensureNotAborted(options.signal);
      const runner = this.createRunner(options.codexCommand, options.skill);
      runnerId = runner.id;
      if (runner.id !== "codex" && !(runner.id === "circletex" && options.skill.id === "tex-to-mathtype-word")) {
        throw new Error("首版 CircleTeX Skill 任务仅支持 Codex Runner。");
      }
      const runnerLabel = runner.id === "circletex" ? "CircleTeX" : "Codex";
      let lastRunnerPercent = 20;
      options.onProgress({
        stage: "running",
        percent: lastRunnerPercent,
        message: `${runnerLabel} 正在执行 ${options.skill.displayName}`,
        indeterminate: runner.id === "codex"
      });
      const agentResult = validateAgentResult(await runner.run({
        taskRoot,
        inputRoot,
        skillRoot,
        outputRoot,
        workRoot,
        schemaPath,
        responsePath,
        skill: options.skill,
        signal: options.signal,
        onOutput: options.onOutput,
        onProgress: (progress) => {
          const mapped = Math.round(20 + clamp(progress.percent, 0, 100) * 0.6);
          lastRunnerPercent = Math.max(lastRunnerPercent, mapped);
          options.onProgress({
            stage: "running",
            percent: lastRunnerPercent,
            message: boundedText(progress.message, 200) || `${runnerLabel} 正在执行 ${options.skill.displayName}`,
            detail: progress.detail,
            elapsedSeconds: progress.elapsedSeconds,
            estimatedRemainingSeconds: progress.estimatedRemainingSeconds,
            metrics: progress.metrics
          });
        }
      }));
      ensureNotAborted(options.signal);
      await validateTaskRoot(taskRoot, Boolean(workRoot));
      const immutableAfter = await hashImmutableTaskFiles([inputRoot, skillRoot], [
        path.join(taskRoot, "task.json"),
        schemaPath
      ]);
      if (immutableAfter !== immutableBefore) {
        throw new Error("Agent 修改了只读输入、Skill 快照或任务清单，已拒绝发布产物。");
      }
      options.onProgress({ stage: "validating", percent: 82, message: "正在验证 Skill 任务产物" });
      if (agentResult.status !== "success") {
        throw new Error(agentResult.summary || "Agent 报告 Skill 任务失败。");
      }
      const artifacts = await validateArtifacts(outputRoot, options.skill, agentResult);
      ensureNotAborted(options.signal);
      options.onProgress({ stage: "publishing", percent: 92, message: "正在发布 Skill 任务产物" });
      const published = await publishArtifacts(options.project.root, options.skill, taskId, artifacts, {
        taskId,
        skillId: options.skill.id,
        skillName: options.skill.displayName,
        skillHash: options.skill.hash,
        agent: runner.id,
        prompt: options.prompt.trim(),
        startedAt,
        inputFiles,
        warnings: agentResult.warnings
      });
      result = {
        taskId,
        skillId: options.skill.id,
        skillName: options.skill.displayName,
        status: "completed",
        summary: agentResult.summary,
        warnings: agentResult.warnings,
        qualityGates: agentResult.qualityGates,
        artifacts: published.artifacts,
        publishedDirectory: published.directory,
        startedAt,
        finishedAt: new Date().toISOString()
      };
    } catch (error) {
      const cancelled = options.signal.aborted;
      result = {
        taskId,
        skillId: options.skill.id,
        skillName: options.skill.displayName,
        status: cancelled ? "cancelled" : "failed",
        summary: cancelled ? "Skill 任务已取消。" : "Skill 任务执行失败。",
        warnings: [],
        artifacts: [],
        startedAt,
        finishedAt: new Date().toISOString(),
        error: cancelled ? undefined : errorMessage(error)
      };
    } finally {
      await fs.rm(taskRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    try {
      await this.registry.addHistory(toHistory(result, options.skill, options.prompt.trim(), runnerId));
    } catch (error) {
      const warning = `任务结果已生成，但历史记录保存失败：${errorMessage(error)}`;
      result.warnings = [...result.warnings, warning];
      options.onOutput?.(`${warning}\n`);
    }
    return result;
  }
}

export class DeterministicSkillRunner implements SkillAgentRunner {
  public readonly id = "circletex" as const;

  public constructor(
    private readonly locateExecutable: typeof findExecutable = findExecutable,
    private readonly executeProcess: typeof runProcess = runProcess
  ) {}

  public async run(context: SkillAgentRunContext): Promise<SkillAgentResult> {
    if (context.skill.id !== "tex-to-mathtype-word" || !context.workRoot) {
      throw new Error("该 Skill 不支持 CircleTeX 确定性执行器。");
    }
    const executable = await this.locateExecutable("pwsh");
    if (!executable) throw new Error("未找到 PowerShell 7（pwsh），无法执行 MathType Word 导出。");
    const script = path.join(context.skillRoot, "scripts", "export_mathtype_word.ps1");
    const progress = new StructuredProgressDecoder(context.onProgress);
    const result = await this.executeProcess(executable, [
      "-NoProfile", "-STA", "-File", script,
      "-ProjectDir", context.workRoot,
      "-OutputDir", context.outputRoot
    ], {
      cwd: context.taskRoot,
      timeoutMs: context.skill.permissions.timeoutMinutes * 60_000,
      onOutput: (text) => {
        context.onOutput?.(text);
        progress.push(text);
      },
      signal: context.signal
    });
    progress.finish();
    ensureNotAborted(context.signal);
    if (result.timedOut) throw new Error(`MathType Word 导出超过 ${context.skill.permissions.timeoutMinutes} 分钟，已终止。`);
    if (result.code !== 0) throw new Error(`MathType Word 导出失败，退出码 ${result.code ?? "未知"}。`);
    const report = validateMathTypeReport(JSON.parse(
      await fs.readFile(path.join(context.outputRoot, "conversion-report.json"), "utf8")
    ));
    return {
      status: "success",
      summary: `已生成保留版式的 MathType Word，共 ${report.layout.pageCount} 页、${report.formulaCount} 个 MathType 公式和 ${report.wordTextCount} 个普通数学文本，OMML 为 0。`,
      artifacts: [
        { path: "main_mathtype.docx", type: "docx", description: "保留封面、目录、分节和学校格式；明确公式为 MathType，简单数学片段为普通 Word 文本的正式 Word" },
        { path: "conversion-report.json", type: "json", description: "公式完整性与 Word 版式结构机器校验报告" },
        { path: "conversion-report.md", type: "markdown", description: "公式和版式转换验收摘要" }
      ],
      warnings: report.warnings,
      qualityGates: reportQualityGates(report)
    };
  }
}

class StructuredProgressDecoder {
  private pending = "";
  private lastPercent = 0;

  public constructor(private readonly emit?: (progress: SkillRunnerProgress) => void) {}

  public push(chunk: string): void {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/u);
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.consume(line);
  }

  public finish(): void {
    if (this.pending) this.consume(this.pending);
    this.pending = "";
  }

  private consume(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line.replace(/^\uFEFF/u, "").trim());
    } catch {
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const item = value as Record<string, unknown>;
    if (item.type !== "progress" || typeof item.percent !== "number" || !Number.isFinite(item.percent)) {
      return;
    }
    const message = boundedText(item.message, 200);
    if (!message) return;
    this.lastPercent = Math.max(this.lastPercent, clamp(item.percent, 0, 100));
    const detail = sanitizeProgressStage(item.detail ?? (typeof item.stage === "object" ? item.stage : undefined));
    const elapsedSeconds = boundedInteger(item.elapsedSeconds, 0, 7 * 24 * 60 * 60);
    const estimatedRemainingSeconds = boundedInteger(item.estimatedRemainingSeconds, 0, 7 * 24 * 60 * 60);
    const metrics = sanitizeProgressMetrics(item.metrics);
    this.emit?.({
      percent: this.lastPercent,
      message,
      ...(detail ? { detail } : {}),
      ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}),
      ...(estimatedRemainingSeconds !== undefined ? { estimatedRemainingSeconds } : {}),
      ...(metrics ? { metrics } : {})
    });
  }
}

interface MathTypeConversionReport {
  mathSegmentCount: number;
  formulaCount: number;
  wordTextCount: number;
  uniqueFormulaCount: number;
  payloadPassCount: number;
  semanticVerifiedCount: number;
  reopenStableCount: number;
  mathTypeObjectCount: number;
  ommlCount: number;
  unresolvedPlaceholderCount: number;
  formulaTextFallbackCount: number;
  layout: {
    pageCount: number;
    sectionCount: number;
    expectedSectionCount: number;
    tableOfContentsCount: number;
    pageBreakCount: number;
    expectedPageBreakCount: number;
  };
  warnings: string[];
}

function validateMathTypeReport(value: unknown): MathTypeConversionReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MathType Word 转换报告格式无效。");
  }
  const report = value as Record<string, unknown>;
  const integer = (key: string): number => {
    const candidate = report[key];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw new Error(`MathType Word 转换报告中的 ${key} 无效。`);
    }
    return candidate;
  };
  const mathSegmentCount = integer("mathSegmentCount");
  const formulaCount = integer("formulaCount");
  const wordTextCount = integer("wordTextCount");
  const uniqueFormulaCount = integer("uniqueFormulaCount");
  const payloadPassCount = integer("payloadPassCount");
  const semanticVerifiedCount = integer("semanticVerifiedCount");
  const reopenStableCount = integer("reopenStableCount");
  const mathTypeObjectCount = integer("mathTypeObjectCount");
  const ommlCount = integer("ommlCount");
  const unresolvedPlaceholderCount = integer("unresolvedPlaceholderCount");
  const formulaTextFallbackCount = integer("formulaTextFallbackCount");
  if (report.version !== 3 || !report.layoutAudit || typeof report.layoutAudit !== "object" || Array.isArray(report.layoutAudit)) {
    throw new Error("MathType Word 转换报告缺少新版版式验收结果。");
  }
  const layoutAudit = report.layoutAudit as Record<string, unknown>;
  const layoutGate = (key: string): Record<string, unknown> => {
    const candidate = layoutAudit[key];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
        (candidate as Record<string, unknown>).status !== true) {
      throw new Error(`MathType Word 未通过${key}版式门禁。`);
    }
    return candidate as Record<string, unknown>;
  };
  const count = (source: Record<string, unknown>, key: string, label: string): number => {
    const candidate = source[key];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw new Error(`MathType Word 转换报告中的${label}无效。`);
    }
    return candidate;
  };
  layoutGate("pageSetup");
  const sections = layoutGate("sectionStructure");
  layoutGate("pageNumbering");
  const tableOfContents = layoutGate("tableOfContents");
  layoutGate("headingCoverage");
  const pageBreaks = layoutGate("pageBreaks");
  const pageCount = count(layoutAudit, "pageCount", "Word 页数");
  if (pageCount < 1) throw new Error("MathType Word 转换报告中的 Word 页数无效。");
  if (
    report.status !== "success" || mathSegmentCount < formulaCount || mathSegmentCount !== formulaCount + wordTextCount || formulaCount < 1 || uniqueFormulaCount < 1 ||
    payloadPassCount !== uniqueFormulaCount || semanticVerifiedCount !== uniqueFormulaCount ||
    reopenStableCount !== formulaCount || mathTypeObjectCount !== formulaCount ||
    ommlCount !== 0 || unresolvedPlaceholderCount !== 0 || formulaTextFallbackCount !== 0
  ) {
    throw new Error("MathType Word 未通过数学片段分类、公式数量、零 OMML、零占位符和零降级门禁。");
  }
  const warnings = Array.isArray(report.warnings)
    ? report.warnings.filter((item): item is string => typeof item === "string").map((item) => boundedText(item, 1000))
    : [];
  return {
    mathSegmentCount,
    formulaCount,
    wordTextCount,
    uniqueFormulaCount,
    payloadPassCount,
    semanticVerifiedCount,
    reopenStableCount,
    mathTypeObjectCount,
    ommlCount,
    unresolvedPlaceholderCount,
    formulaTextFallbackCount,
    layout: {
      pageCount,
      sectionCount: count(sections, "current", "分节数"),
      expectedSectionCount: count(sections, "expected", "预期分节数"),
      tableOfContentsCount: count(tableOfContents, "current", "目录数"),
      pageBreakCount: count(pageBreaks, "current", "分页符数"),
      expectedPageBreakCount: count(pageBreaks, "expected", "预期分页符数")
    },
    warnings
  };
}

function reportQualityGates(report: MathTypeConversionReport): SkillTaskQualityGate[] {
  return [
    { id: "math-segments", label: "数学片段分类", status: "passed", value: `${report.mathSegmentCount}（文本 ${report.wordTextCount}）` },
    { id: "mathtype-objects", label: "MathType 对象", status: "passed", value: `${report.mathTypeObjectCount}/${report.formulaCount}` },
    { id: "omml", label: "OMML", status: "passed", value: String(report.ommlCount) },
    { id: "placeholders", label: "残留占位符", status: "passed", value: String(report.unresolvedPlaceholderCount) },
    { id: "fallbacks", label: "公式降级", status: "passed", value: String(report.formulaTextFallbackCount) },
    { id: "reopen", label: "Word 重开校验", status: "passed", value: "通过" },
    { id: "page-setup", label: "A4 页面与页边距", status: "passed", value: "通过" },
    { id: "sections", label: "封面、目录与正文分节", status: "passed", value: `${report.layout.sectionCount}/${report.layout.expectedSectionCount}` },
    { id: "page-numbering", label: "目录与正文页码", status: "passed", value: "罗马/阿拉伯" },
    { id: "toc", label: "Word 自动目录", status: "passed", value: String(report.layout.tableOfContentsCount) },
    { id: "headings", label: "标题结构覆盖", status: "passed", value: "通过" },
    { id: "page-breaks", label: "LaTeX 强制分页", status: "passed", value: `${report.layout.pageBreakCount}/${report.layout.expectedPageBreakCount}` }
  ];
}

function sanitizeProgressStage(value: unknown): SkillProgressStage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const id = boundedText(item.id, 48);
  const label = boundedText(item.label, 80);
  if (!id || !/^[a-z0-9][a-z0-9-]*$/u.test(id) || !label ||
      !["pending", "running", "completed", "failed"].includes(String(item.state))) {
    return undefined;
  }
  const current = item.current === undefined ? undefined : boundedInteger(item.current, 0, 1_000_000_000);
  const total = item.total === undefined ? undefined : boundedInteger(item.total, 0, 1_000_000_000);
  if ((item.current !== undefined && current === undefined) || (item.total !== undefined && total === undefined) ||
      (current !== undefined && total !== undefined && current > total)) {
    return undefined;
  }
  const unit = item.unit === undefined ? undefined : boundedText(item.unit, 40);
  if (item.unit !== undefined && !unit) return undefined;
  return {
    id,
    label,
    state: item.state as SkillProgressStage["state"],
    ...(current !== undefined ? { current } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(unit ? { unit } : {})
  };
}

function sanitizeProgressMetrics(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 20) return undefined;
  const result: Record<string, number> = {};
  for (const [key, metric] of entries) {
    if (!/^[a-z][a-zA-Z0-9]{0,39}$/u.test(key) || typeof metric !== "number" ||
        !Number.isSafeInteger(metric) || metric < 0 || metric > 1_000_000_000_000) {
      return undefined;
    }
    result[key] = metric;
  }
  return result;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

async function copyProjectSnapshot(
  project: ProjectPaths,
  inputRoot: string,
  preset: ImportedSkill["permissions"]["inputPreset"]
): Promise<Array<{ path: string; size: number; sha256: string }>> {
  const sources: Array<{ source: string; relative: string }> = [
    { source: project.tex, relative: "main.tex" },
    { source: project.pdf, relative: "main.pdf" }
  ];
  if (preset === "document-resources" || preset === "document-workspace") {
    const entries = await fs.readdir(project.root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory() && entry.name === "figures") {
        const figureFiles = await listFilesStrict(path.join(project.root, entry.name), MAX_INPUT_FILES, MAX_INPUT_BYTES);
        sources.push(...figureFiles.map((file) => ({
          source: file.absolutePath,
          relative: path.posix.join("figures", file.relativePath)
        })));
      } else if (entry.isFile() && RESOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !["main.pdf"].includes(entry.name)) {
        sources.push({ source: path.join(project.root, entry.name), relative: entry.name });
      }
    }
    if (preset === "document-workspace") {
      const tex = await fs.readFile(project.tex, "utf8");
      for (const relative of referencedProjectFiles(tex)) {
        const source = safeJoin(project.root, relative);
        if (await fs.stat(source).then((stat) => stat.isFile(), () => false)) {
          sources.push({ source, relative });
        }
      }
    }
  }
  const uniqueSources = [...new Map(sources.map((item) => [item.relative.replace(/\\/g, "/"), item])).values()];
  if (uniqueSources.length > MAX_INPUT_FILES) {
    throw new Error("论文输入快照超过 1000 个文件的限制。");
  }
  const results: Array<{ path: string; size: number; sha256: string }> = [];
  let totalBytes = 0;
  for (const item of uniqueSources) {
    const stat = await fs.lstat(item.source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`论文输入不是普通文件：${item.relative}`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_INPUT_BYTES) {
      throw new Error("论文输入快照超过 500 MB 的限制。");
    }
    const destination = safeJoin(inputRoot, item.relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(item.source, destination);
    results.push({ path: item.relative.replace(/\\/g, "/"), size: stat.size, sha256: await hashFile(destination) });
  }
  return results;
}

async function validateArtifacts(
  outputRoot: string,
  skill: ImportedSkill,
  agentResult: SkillAgentResult
): Promise<Array<{ source: string; relativePath: string; description: string; type: string; size: number; sha256: string }>> {
  const declared = new Map<string, SkillAgentResult["artifacts"][number]>();
  for (const artifact of agentResult.artifacts) {
    const declaredPath = normalizeOutputPath(artifact.path);
    if (declared.has(declaredPath)) {
      throw new Error(`Agent 重复声明了同一产物：${declaredPath}`);
    }
    declared.set(declaredPath, artifact);
  }
  const files = await listFilesStrict(outputRoot, MAX_OUTPUT_FILES, MAX_OUTPUT_BYTES);
  if (files.length === 0) {
    throw new Error("Skill 任务没有在 output 目录生成产物。");
  }
  const results: Array<{
    source: string;
    relativePath: string;
    description: string;
    type: string;
    size: number;
    sha256: string;
  }> = [];
  for (const file of files) {
    const relativePath = normalizeOutputPath(file.relativePath);
    const extension = path.extname(relativePath).toLowerCase();
    if (FORBIDDEN_OUTPUT_EXTENSIONS.has(extension) || !skill.permissions.outputExtensions.includes(extension)) {
      throw new Error(`Skill 生成了未获批准的产物类型：${relativePath}`);
    }
    if (await isExecutableBinaryFile(file.absolutePath)) {
      throw new Error(`Skill 生成了伪装成普通文件的可执行二进制：${relativePath}`);
    }
    const declaration = declared.get(relativePath);
    if (!declaration) {
      throw new Error(`Agent 未在结构化结果中声明产物：${relativePath}`);
    }
    if (extension === ".docx") {
      await validateDocx(file.absolutePath);
      if (skill.id === "tex-to-mathtype-word") {
        await validateMathTypeDocx(file.absolutePath);
      }
    }
    results.push({
      source: file.absolutePath,
      relativePath,
      description: boundedText(declaration.description, 500) || "Skill 任务产物",
      type: boundedText(declaration.type, 80) || extension.slice(1),
      size: file.size,
      sha256: await hashFile(file.absolutePath)
    });
  }
  if (declared.size !== results.length) {
    const missing = [...declared.keys()].filter((item) => !results.some((result) => result.relativePath === item));
    throw new Error(`Agent 声明了不存在的产物：${missing.join("、")}`);
  }
  return results;
}

async function publishArtifacts(
  projectRoot: string,
  skill: ImportedSkill,
  taskId: string,
  artifacts: Array<{ source: string; relativePath: string; description: string; type: string; size: number; sha256: string }>,
  run: Record<string, unknown>
): Promise<{ directory: string; artifacts: SkillTaskArtifact[] }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(projectRoot, "exports", "circletex", skill.id);
  const staging = path.join(root, `.tmp-${taskId}`);
  const target = path.join(root, `${timestamp}-${taskId.slice(0, 8)}`);
  await fs.mkdir(staging, { recursive: true });
  try {
    const published: SkillTaskArtifact[] = [];
    for (const artifact of artifacts) {
      const destination = safeJoin(staging, artifact.relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(artifact.source, destination);
      published.push({
        name: path.basename(artifact.relativePath),
        relativePath: artifact.relativePath,
        absolutePath: safeJoin(target, artifact.relativePath),
        type: artifact.type,
        description: artifact.description,
        size: artifact.size,
        sha256: artifact.sha256
      });
    }
    await fs.writeFile(path.join(staging, "run.json"), JSON.stringify({ ...run, artifacts: published }, null, 2), "utf8");
    await fs.rename(staging, target);
    return { directory: target, artifacts: published };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function buildSkillTaskPrompt(skill: ImportedSkill): string {
  return `你正在执行 CircleTeX 隔离 Skill 任务。

必须严格遵守：
1. 首先完整读取 skill/SKILL.md；按其中的相对引用继续读取 skill/ 内必要资源。
2. 完整读取 task.json，按照其中的用户提示和任务范围执行。
3. input/ 和 skill/ 是只读快照，不得修改、删除或重命名。
4. ${skill.permissions.writableWorkDirectory ? "work/ 是允许修改的隔离论文副本，可用于生成中间文件；最终产物仍必须复制到 output/。" : "只允许把最终产物写入 output/；不得在任务根目录或其他目录创建业务产物。"}
5. 不得访问任务目录之外的文件，不得使用网络，不得请求额外权限。
6. 只执行本任务需要的命令。导入时声明的外部命令为：${skill.permissions.declaredCommands.join("、") || "无"}。
7. 输出类型只能是：${skill.permissions.outputExtensions.join("、")}。
8. 最终回答必须符合给定 JSON Schema，并列出 output/ 中的每个产物。
9. 如果无法遵守 Skill 或缺少依赖，返回 status=failed，不得伪造成功或产物。`;
}

function agentResultSchema(): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "summary", "artifacts", "warnings"],
    properties: {
      status: { type: "string", enum: ["success", "failed"] },
      summary: { type: "string", maxLength: 2000 },
      artifacts: {
        type: "array",
        maxItems: MAX_OUTPUT_FILES,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "type", "description"],
          properties: {
            path: { type: "string", maxLength: 500 },
            type: { type: "string", maxLength: 80 },
            description: { type: "string", maxLength: 500 }
          }
        }
      },
      warnings: { type: "array", maxItems: 100, items: { type: "string", maxLength: 1000 } }
    }
  };
}

function parseAgentResult(text: string): SkillAgentResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Agent 未返回合法的 Skill 任务 JSON 结果。");
  }
  return validateAgentResult(value);
}

function validateAgentResult(value: unknown): SkillAgentResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent Skill 任务结果格式无效。");
  }
  const result = value as Record<string, unknown>;
  if (
    !["success", "failed"].includes(String(result.status)) ||
    typeof result.summary !== "string" || result.summary.length > 2000 ||
    !Array.isArray(result.artifacts) || result.artifacts.length > MAX_OUTPUT_FILES ||
    result.artifacts.some((artifact) => !artifact || typeof artifact !== "object" || Array.isArray(artifact) ||
      typeof artifact.path !== "string" || artifact.path.length > 500 ||
      typeof artifact.type !== "string" || artifact.type.length > 80 ||
      typeof artifact.description !== "string" || artifact.description.length > 500) ||
    !Array.isArray(result.warnings) || result.warnings.length > 100 ||
    result.warnings.some((warning) => typeof warning !== "string" || warning.length > 1000) ||
    !validQualityGates(result.qualityGates)
  ) {
    throw new Error("Agent Skill 任务结果缺少必需字段。");
  }
  return result as unknown as SkillAgentResult;
}

function validQualityGates(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= 12 && value.every((gate) =>
    gate && typeof gate === "object" && !Array.isArray(gate) &&
    /^[a-z0-9][a-z0-9-]{0,47}$/u.test(String((gate as Record<string, unknown>).id)) &&
    boundedText((gate as Record<string, unknown>).label, 80).length > 0 &&
    ["passed", "failed"].includes(String((gate as Record<string, unknown>).status)) &&
    boundedText((gate as Record<string, unknown>).value, 80).length > 0
  );
}

async function validateDocx(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath);
  if (stat.size < 100 || stat.size > MAX_OUTPUT_BYTES) {
    throw new Error("DOCX 产物大小异常。");
  }
  const buffer = await fs.readFile(filePath);
  if (buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("DOCX 产物不是有效的 ZIP 容器。");
  }
  const entries = zipCentralDirectoryEntries(buffer);
  if (!entries.has("[Content_Types].xml") || !entries.has("word/document.xml")) {
    throw new Error("DOCX 产物缺少必要的 Word 文档部件。");
  }
}

async function validateMathTypeDocx(filePath: string): Promise<void> {
  const buffer = await fs.readFile(filePath);
  const entries = zipCentralDirectoryEntryRecords(buffer);
  let mathTypeCount = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith("word/") || !entry.name.endsWith(".xml")) continue;
    const xml = inflateZipEntry(buffer, entry).toString("utf8");
    if (/<m:oMath(?:Para)?(?:\s|>)/u.test(xml)) {
      throw new Error("MathType Word 产物包含禁止的 OMML 公式。");
    }
    if (/CIRCLETEX(?:MATH|EQNUM)\d{6}/u.test(xml)) {
      throw new Error("MathType Word 产物仍包含未替换的公式占位符。");
    }
    mathTypeCount += xml.split(`ProgID=\"${MATHTYPE_PROG_ID}\"`).length - 1;
  }
  if (mathTypeCount < 1) {
    throw new Error("MathType Word 产物没有检测到 Equation.DSMT4 可编辑对象。");
  }
}

function zipCentralDirectoryEntries(buffer: Buffer): Set<string> {
  return new Set(zipCentralDirectoryEntryRecords(buffer).map((entry) => entry.name));
}

interface ZipEntryRecord {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function zipCentralDirectoryEntryRecords(buffer: Buffer): ZipEntryRecord[] {
  const minimum = Math.max(0, buffer.length - 65_557);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error("DOCX 产物缺少 ZIP 中央目录。");
  }
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const directorySize = buffer.readUInt32LE(endOffset + 12);
  const directoryOffset = buffer.readUInt32LE(endOffset + 16);
  if (entryCount > 10_000 || directoryOffset + directorySize > endOffset) {
    throw new Error("DOCX 产物的 ZIP 中央目录无效。");
  }
  const entries: ZipEntryRecord[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("DOCX 产物的 ZIP 条目无效。");
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) {
      throw new Error("DOCX 产物的 ZIP 条目名称无效。");
    }
    entries.push({
      name: buffer.subarray(nameStart, nameEnd).toString("utf8").replace(/\\/g, "/"),
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localOffset: buffer.readUInt32LE(offset + 42)
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function inflateZipEntry(buffer: Buffer, entry: ZipEntryRecord): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error("DOCX 产物的 ZIP 本地条目无效。");
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) throw new Error("DOCX 产物的 ZIP 数据越界。");
  const data = buffer.subarray(dataStart, dataEnd);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error("DOCX 产物包含不支持的 ZIP 压缩方法。");
  const inflated = inflateRawSync(Uint8Array.from(data));
  if (inflated.length !== entry.uncompressedSize) throw new Error("DOCX 产物的 ZIP 解压长度异常。");
  return inflated;
}

async function copyDirectoryStrict(source: string, target: string, maxFiles: number, maxBytes: number): Promise<void> {
  const files = await listFilesStrict(source, maxFiles, maxBytes);
  for (const file of files) {
    const destination = safeJoin(target, file.relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(file.absolutePath, destination);
  }
}

async function listFilesStrict(
  root: string,
  maxFiles: number,
  maxBytes: number
): Promise<Array<{ relativePath: string; absolutePath: string; size: number }>> {
  const files: Array<{ relativePath: string; absolutePath: string; size: number }> = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(`任务目录包含不允许的符号链接或重解析点：${entry.name}`);
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const stat = await fs.lstat(absolutePath);
        totalBytes += stat.size;
        files.push({
          relativePath: normalizeOutputPath(path.relative(root, absolutePath)),
          absolutePath,
          size: stat.size
        });
        if (files.length > maxFiles || totalBytes > maxBytes) {
          throw new Error("任务文件数量或总大小超过限制。");
        }
      } else {
        throw new Error("任务目录包含不支持的文件类型。");
      }
    }
  };
  await visit(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function hashImmutableTaskFiles(roots: readonly string[], files: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const root of roots) {
    for (const file of await listFilesStrict(root, 2000, 1024 * 1024 * 1024)) {
      hash.update(path.basename(root));
      hash.update("\0");
      hash.update(file.relativePath);
      hash.update("\0");
      hash.update(new Uint8Array(await fs.readFile(file.absolutePath)));
      hash.update("\0");
    }
  }
  for (const filePath of files) {
    hash.update(path.basename(filePath));
    hash.update("\0");
    hash.update(new Uint8Array(await fs.readFile(filePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function validateTaskRoot(taskRoot: string, allowWork: boolean): Promise<void> {
  const allowed = new Set(["input", "skill", "output", "task.json", "result-schema.json", "agent-result.json"]);
  if (allowWork) allowed.add("work");
  const entries = await fs.readdir(taskRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!allowed.has(entry.name)) {
      throw new Error(`Agent 在 output 目录之外创建了未获批准的文件：${entry.name}`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`任务根目录包含不允许的符号链接或重解析点：${entry.name}`);
    }
  }
}

function referencedProjectFiles(tex: string): string[] {
  const files = new Set<string>();
  const patterns = [
    /\\includegraphics(?:\[[^\]]*\])?\{([^{}]+)\}/gu,
    /\\(?:input|include)\{([^{}]+)\}/gu,
    /\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\{([^{}]+)\}/gu
  ];
  for (const pattern of patterns) {
    for (const match of tex.matchAll(pattern)) {
      const value = match[1].trim().replace(/\\/g, "/");
      if (!value || value.includes("\0") || path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) continue;
      const candidates = pattern.source.includes("includegraphics") && !path.posix.extname(value)
        ? [".png", ".jpg", ".jpeg", ".pdf", ".svg", ".eps"].map((extension) => `${value}${extension}`)
        : [value];
      for (const candidate of candidates) {
        const normalized = path.posix.normalize(candidate);
        if (normalized !== candidate || candidate.startsWith("../")) continue;
        files.add(normalized);
        if (!candidate.startsWith("figures/")) files.add(path.posix.join("figures", normalized));
      }
    }
  }
  return [...files];
}

function selectionManifest(selection: PdfSelection): object {
  return {
    kind: selection.kind,
    text: selection.text,
    page: selection.page,
    start: selection.start,
    end: selection.end,
    ...(selection.kind === "text" && selection.pageFragments
      ? { pageFragments: selection.pageFragments }
      : {})
  };
}

function normalizeOutputPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  const withoutOutput = normalized.startsWith("output/") ? normalized.slice("output/".length) : normalized;
  const canonical = path.posix.normalize(withoutOutput);
  if (
    !withoutOutput || canonical !== withoutOutput || withoutOutput.startsWith("../") ||
    path.posix.isAbsolute(withoutOutput) || /^[A-Za-z]:\//.test(withoutOutput) || withoutOutput.includes("\0")
  ) {
    throw new Error("Agent 返回了越界产物路径。");
  }
  return withoutOutput;
}

function safeJoin(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("任务文件路径超出允许目录。");
  }
  return target;
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(new Uint8Array(await fs.readFile(filePath))).digest("hex");
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Skill 任务已取消。");
  }
}

function validateTaskRequest(options: RunSkillTaskOptions): void {
  if (!options.skill.enabled) {
    throw new Error("该 Skill 已停用，不能执行任务。");
  }
  if (options.prompt.trim().length < 1 || options.prompt.length > 4_000) {
    throw new Error("Skill 任务提示词必须为 1 至 4000 个字符。");
  }
  if (options.skill.permissions.scope === "selection" && !options.selection) {
    throw new Error("该 Skill 仅支持 PDF 选区任务，请先选择内容。");
  }
  if (options.selection && !options.sourceRange) {
    throw new Error("PDF 选区任务缺少经确认的源码范围。");
  }
  if (options.skill.permissions.scope === "document" && options.selection) {
    throw new Error("该 Skill 仅支持整篇文档任务，不能附带 PDF 选区。");
  }
}

function boundedText(value: unknown, maximum: number): string {
  return typeof value === "string" && value.length <= maximum ? value.trim() : "";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toHistory(
  result: SkillTaskResult,
  skill: ImportedSkill,
  prompt: string,
  agent: SkillAgentRunner["id"]
): SkillTaskHistoryEntry {
  return {
    ...result,
    artifacts: result.artifacts.map((artifact) => ({ ...artifact })),
    agent,
    skillHash: skill.hash,
    prompt
  };
}
