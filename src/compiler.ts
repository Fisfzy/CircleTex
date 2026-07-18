import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isFile } from "./fsUtils";
import { findExecutable, runProcess } from "./processRunner";
import { ProjectPaths } from "./types";

export interface CompileResult {
  passes: number;
  warnings: string[];
}

export interface CompileProgress {
  percent: number;
  message: string;
  indeterminate?: boolean;
}

export type CompileProgressReporter = (progress: CompileProgress) => void;

export type CompilePublishValidator = () => void | Promise<void>;

export interface PublishBuildOptions {
  sourcePath: string;
  expectedSourceHash: string;
  validateBeforeCommit?: CompilePublishValidator;
}

export class LatexCompiler {
  private running = false;

  public async compile(
    project: ProjectPaths,
    passes: number,
    onOutput: (text: string) => void,
    validateBeforePublish?: CompilePublishValidator,
    onProgress: CompileProgressReporter = () => undefined
  ): Promise<CompileResult> {
    if (this.running) {
      throw new Error("已有编译任务正在运行。");
    }
    this.running = true;
    let buildDirectory: string | undefined;
    const compileStartedAt = Date.now();
    try {
      reportCompileProgress(onProgress, 8, "正在准备隔离构建目录");
      buildDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-build-"));
      await this.recoverInterruptedPublish(project.root, onOutput);
      const sourceHash = await hashFile(project.tex);
      const seedStartedAt = Date.now();
      const auxiliarySeed = await seedAuxiliaryFiles(project.root, buildDirectory);
      logDuration(onOutput, "辅助文件预热", seedStartedAt);
      const locateStartedAt = Date.now();
      const xelatex = await findExecutable("xelatex");
      logDuration(onOutput, "XeLaTeX 命令定位", locateStartedAt);
      if (!xelatex) {
        throw new Error("未找到 xelatex 命令。请检查 TeX 发行版安装。");
      }

      // 预检只读取源码与项目资源；与 XeLaTeX 并行执行可消除其在常规编译路径中的等待时间。
      // 错误先被接住，避免 XeLaTeX 仍在运行时出现未处理的 Promise 拒绝；发布前会重新抛出。
      let preflightError: unknown;
      const preflightStartedAt = Date.now();
      reportCompileProgress(onProgress, 8, "正在后台运行 LaTeX 预检", true);
      const preflight = this.runPreflight(project, onOutput).then(
        () => logDuration(onOutput, "LaTeX 预检（与 XeLaTeX 并行）", preflightStartedAt),
        (error) => {
          preflightError = error;
          logDuration(onOutput, "LaTeX 预检（与 XeLaTeX 并行）", preflightStartedAt);
        }
      );
      onOutput("LaTeX 预检已在后台并行执行，编译产物发布前仍会完成校验。\n");
      reportCompileProgress(onProgress, 15, "预检已启动，正在执行 XeLaTeX");

      let completedPasses = 0;
      for (let index = 1; index <= passes; index += 1) {
        if ((await hashFile(project.tex)) !== sourceHash) {
          throw new Error("main.tex 在编译期间发生了变化，已终止本次编译。");
        }
        onOutput(`\n执行 XeLaTeX：第 ${index}/${passes} 遍。\n`);
        const progressRange = compilePassProgress(index, passes);
        reportCompileProgress(onProgress, progressRange.start, `正在执行第 ${index} 遍 XeLaTeX`, true);
        const passStartedAt = Date.now();
        const result = await runProcess(xelatex, [
          "-synctex=1",
          "-interaction=nonstopmode",
          "-file-line-error",
          "-halt-on-error",
          `-output-directory=${buildDirectory}`,
          "main.tex"
        ], {
          cwd: project.root,
          timeoutMs: 5 * 60_000,
          onOutput
        });
        if (result.timedOut) {
          throw new Error(`XeLaTeX 第 ${index} 遍超过 5 分钟，已终止。`);
        }
        if (result.code !== 0) {
          throw new Error(`XeLaTeX 第 ${index} 遍失败，退出码 ${result.code ?? "未知"}。`);
        }
        completedPasses = index;
        logDuration(onOutput, `XeLaTeX 第 ${index} 遍`, passStartedAt);
        reportCompileProgress(onProgress, progressRange.end, `第 ${index} 遍 XeLaTeX 完成`);
        if ((await hashFile(project.tex)) !== sourceHash) {
          throw new Error("main.tex 在编译期间发生了变化，已取消发布本次 PDF。");
        }
        if (
          index === 1 &&
          passes === 2 &&
          auxiliarySeed.seededCount > 0 &&
          await auxiliaryFilesStable(buildDirectory, auxiliarySeed.hashes) &&
          !await logRequiresAnotherPass(buildDirectory)
        ) {
          onOutput("辅助文件稳定且日志未要求重跑，安全省略第 2 遍 XeLaTeX。\n");
          reportCompileProgress(onProgress, 88, "辅助文件稳定，已省略第 2 遍 XeLaTeX");
          break;
        }
        if (index === 1 && passes === 2) {
          reportCompileProgress(onProgress, 60, "辅助文件仍需更新，将继续第 2 遍 XeLaTeX");
        }
      }

      const builtPdf = path.join(buildDirectory, "main.pdf");
      const builtSyncTex = path.join(buildDirectory, "main.synctex.gz");
      if (!(await isFile(builtPdf)) || !(await isFile(builtSyncTex))) {
        throw new Error("编译结束但未同时生成 main.pdf 和 main.synctex.gz。");
      }
      if ((await hashFile(project.tex)) !== sourceHash) {
        throw new Error("main.tex 在编译期间发生了变化，已取消发布本次 PDF。");
      }
      await preflight;
      if (preflightError) {
        throw preflightError;
      }
      const warnings = await readLatexWarnings(buildDirectory);
      const publishStartedAt = Date.now();
      reportCompileProgress(onProgress, 88, "正在发布 PDF 与 SyncTeX", true);
      await publishBuild(project.root, buildDirectory, {
        sourcePath: project.tex,
        expectedSourceHash: sourceHash,
        validateBeforeCommit: validateBeforePublish
      });
      logDuration(onOutput, "编译产物发布", publishStartedAt);
      reportCompileProgress(onProgress, 94, "编译产物已发布，正在刷新 PDF");
      // 产物事务已提交，日志通道异常不应将成功编译反转为失败。
      try {
        onOutput("编译产物已发布，上一版文件保存在 backup/circletex-build。\n");
      } catch {
        // 输出面板可能已销毁。
      }
      return { passes: completedPasses, warnings };
    } finally {
      this.running = false;
      if (buildDirectory) {
        await fs.rm(buildDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      logDuration(onOutput, "本次编译总计", compileStartedAt);
    }
  }

  public async recoverInterruptedPublish(
    projectRoot: string,
    onOutput: (text: string) => void = () => undefined
  ): Promise<void> {
    await recoverPublishTransaction(projectRoot, onOutput);
  }

  private async runPreflight(project: ProjectPaths, onOutput: (text: string) => void): Promise<void> {
    const script = path.join(project.root, "skills", "pddo-midterm-report", "scripts", "preflight-tex.ps1");
    if (!(await isFile(script))) {
      onOutput("未找到项目预检脚本，跳过预检。\n");
      return;
    }
    const modernPowerShell = await findExecutable("pwsh");
    const powershell = modernPowerShell ?? await findExecutable("powershell.exe");
    if (!powershell) {
      throw new Error("未找到 PowerShell，无法运行论文预检脚本。");
    }
    let scriptToRun = script;
    let compatibilityDirectory: string | undefined;
    if (!modernPowerShell) {
      compatibilityDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-powershell-"));
      scriptToRun = path.join(compatibilityDirectory, "preflight-tex.ps1");
      const source = await fs.readFile(script, "utf8");
      await fs.writeFile(scriptToRun, `\uFEFF${source}`, "utf8");
    }
    onOutput("执行论文 LaTeX 预检。\n");
    try {
      const result = await runProcess(powershell, [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptToRun, "-ProjectRoot", project.root
      ], { cwd: project.root, timeoutMs: 60_000, onOutput });
      if (result.code !== 0) {
        throw new Error(`论文预检失败，退出码 ${result.code ?? "未知"}。`);
      }
    } finally {
      if (compatibilityDirectory) {
        await fs.rm(compatibilityDirectory, { recursive: true, force: true });
      }
    }
  }
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath, "utf8")).digest("hex");
}

export async function publishBuild(
  projectRoot: string,
  buildDirectory: string,
  options: PublishBuildOptions
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDirectory = path.join(projectRoot, "backup", "circletex-build", timestamp);
  const names = BUILD_ARTIFACTS.filter((name) =>
    fsSync.statSync(path.join(buildDirectory, name), { throwIfNoEntry: false })?.isFile()
  );
  await fs.mkdir(backupDirectory, { recursive: true });
  const originallyExisting: string[] = [];
  for (const name of names) {
    const current = path.join(projectRoot, name);
    if (await isFile(current)) {
      originallyExisting.push(name);
      await fs.copyFile(current, path.join(backupDirectory, name));
    }
  }

  const staged: Array<{ next: string; target: string }> = [];
  try {
    for (const name of names) {
      const built = path.join(buildDirectory, name);
      if (!(await isFile(built))) {
        continue;
      }
      const target = path.join(projectRoot, name);
      const next = path.join(projectRoot, `.circletex-${timestamp}-${name}.tmp`);
      await fs.copyFile(built, next);
      staged.push({ next, target });
    }
    const transaction: PublishTransaction = {
      id: timestamp,
      backupDirectory,
      names,
      originallyExisting
    };
    await fs.writeFile(transactionPath(projectRoot), JSON.stringify(transaction), "utf8");
    for (const item of staged) {
      await fs.copyFile(item.next, item.target);
    }
    if ((await hashFile(options.sourcePath)) !== options.expectedSourceHash) {
      throw new Error("main.tex 在产物发布期间发生了变化，已拒绝提交本次编译产物。");
    }
    await options.validateBeforeCommit?.();
    if ((await hashFile(options.sourcePath)) !== options.expectedSourceHash) {
      throw new Error("main.tex 在产物发布期间发生了变化，已拒绝提交本次编译产物。");
    }
    await fs.rm(transactionPath(projectRoot), { force: true });
  } catch (error) {
    await recoverPublishTransaction(projectRoot);
    throw error;
  } finally {
    await Promise.allSettled(staged.map((item) => fs.rm(item.next, { force: true })));
  }
}

interface PublishTransaction {
  id: string;
  backupDirectory: string;
  names: string[];
  originallyExisting: string[];
}

const BUILD_ARTIFACTS = ["main.pdf", "main.synctex.gz", "main.aux", "main.log", "main.out", "main.toc"];
const AUXILIARY_ARTIFACTS = ["main.aux", "main.out", "main.toc"];
const TRANSACTION_FILE = ".circletex-build-transaction.json";

interface AuxiliarySeed {
  hashes: Map<string, string | undefined>;
  seededCount: number;
}

async function seedAuxiliaryFiles(projectRoot: string, buildDirectory: string): Promise<AuxiliarySeed> {
  const hashes = new Map<string, string | undefined>();
  let seededCount = 0;
  for (const name of AUXILIARY_ARTIFACTS) {
    const source = path.join(projectRoot, name);
    const destination = path.join(buildDirectory, name);
    if (await isFile(source)) {
      await fs.copyFile(source, destination);
      hashes.set(name, await hashBinaryFile(destination));
      seededCount += 1;
    } else {
      hashes.set(name, undefined);
    }
  }
  return { hashes, seededCount };
}

async function auxiliaryFilesStable(
  buildDirectory: string,
  before: Map<string, string | undefined>
): Promise<boolean> {
  for (const name of AUXILIARY_ARTIFACTS) {
    const filePath = path.join(buildDirectory, name);
    const after = await isFile(filePath) ? await hashBinaryFile(filePath) : undefined;
    if (after !== before.get(name)) {
      return false;
    }
  }
  return true;
}

async function logRequiresAnotherPass(buildDirectory: string): Promise<boolean> {
  let log: string;
  try {
    log = await fs.readFile(path.join(buildDirectory, "main.log"), "utf8");
  } catch {
    return true;
  }
  return latexLogRequiresAnotherPass(log);
}

export function latexLogRequiresAnotherPass(log: string): boolean {
  return /(?:Rerun to get|Please (?:re)?run|run (?:LaTeX|Biber) again|Label\(s\) may have changed|There were undefined references|(?:Citation|Reference) [`'].+?[`'].*undefined|Package rerunfilecheck Warning)/i.test(log);
}

async function hashBinaryFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath, "utf8")).digest("hex");
}

function logDuration(onOutput: (text: string) => void, label: string, startedAt: number): void {
  try {
    onOutput(`[耗时] ${label}：${((Date.now() - startedAt) / 1_000).toFixed(2)} 秒。\n`);
  } catch {
    // 日志通道异常不影响编译流程。
  }
}

function compilePassProgress(index: number, passes: number): { start: number; end: number } {
  if (passes === 2) {
    return index === 1 ? { start: 15, end: 55 } : { start: 60, end: 88 };
  }
  const span = 73 / Math.max(1, passes);
  return {
    start: Math.round(15 + span * (index - 1)),
    end: Math.round(15 + span * index)
  };
}

function reportCompileProgress(
  reporter: CompileProgressReporter,
  percent: number,
  message: string,
  indeterminate = false
): void {
  try {
    reporter({ percent: Math.max(0, Math.min(100, Math.round(percent))), message, indeterminate });
  } catch {
    // 进度展示异常不影响编译事务。
  }
}

async function recoverPublishTransaction(
  projectRoot: string,
  onOutput: (text: string) => void = () => undefined
): Promise<void> {
  const marker = transactionPath(projectRoot);
  if (!(await isFile(marker))) {
    await removeOrphanedStages(projectRoot);
    return;
  }
  let transaction: PublishTransaction;
  try {
    transaction = JSON.parse(await fs.readFile(marker, "utf8")) as PublishTransaction;
  } catch {
    throw new Error(`构建事务标记损坏，请人工检查：${marker}`);
  }
  validateTransaction(projectRoot, transaction);
  for (const name of transaction.names) {
    const target = path.join(projectRoot, name);
    const backup = path.join(transaction.backupDirectory, name);
    if (transaction.originallyExisting.includes(name)) {
      if (!(await isFile(backup))) {
        throw new Error(`无法恢复上一版编译产物，缺少备份：${backup}`);
      }
      await fs.copyFile(backup, target);
    } else {
      await fs.rm(target, { force: true });
    }
  }
  await fs.rm(marker, { force: true });
  await removeOrphanedStages(projectRoot);
  onOutput("检测到上次未完成的产物发布，已恢复上一版 PDF 与同步文件。\n");
}

function validateTransaction(projectRoot: string, transaction: PublishTransaction): void {
  if (
    !transaction ||
    typeof transaction.id !== "string" ||
    typeof transaction.backupDirectory !== "string" ||
    !Array.isArray(transaction.names) ||
    !Array.isArray(transaction.originallyExisting) ||
    transaction.names.some((name) => !BUILD_ARTIFACTS.includes(name)) ||
    transaction.originallyExisting.some((name) => !transaction.names.includes(name))
  ) {
    throw new Error("构建事务标记包含无效字段，已停止自动恢复。");
  }
  const allowedBackupRoot = path.resolve(projectRoot, "backup", "circletex-build");
  const actualBackup = path.resolve(transaction.backupDirectory);
  const relative = path.relative(allowedBackupRoot, actualBackup);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("构建事务备份目录超出项目允许范围，已停止自动恢复。");
  }
}

async function removeOrphanedStages(projectRoot: string): Promise<void> {
  const entries = await fs.readdir(projectRoot, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^\.circletex-.*\.tmp$/.test(entry.name))
    .map((entry) => fs.rm(path.join(projectRoot, entry.name), { force: true })));
}

function transactionPath(projectRoot: string): string {
  return path.join(projectRoot, TRANSACTION_FILE);
}

async function readLatexWarnings(root: string): Promise<string[]> {
  let log = "";
  try {
    log = await fs.readFile(path.join(root, "main.log"), "utf8");
  } catch {
    return [];
  }
  const patterns = [
    /LaTeX Warning: There were undefined references\./g,
    /LaTeX Warning: Reference `[^']+' on page \d+ undefined/g,
    /LaTeX Warning: Citation `[^']+' on page \d+ undefined/g,
    /LaTeX Warning: Label\(s\) may have changed\./g
  ];
  const warnings = new Set<string>();
  for (const pattern of patterns) {
    for (const match of log.matchAll(pattern)) {
      warnings.add(match[0]);
    }
  }
  return [...warnings];
}
