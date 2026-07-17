import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isFile } from "./fsUtils";
import { hashNormalizedText } from "./applyRange";
import { findExecutable, runProcess } from "./processRunner";
import { hasTextualOverlap } from "./selectionMatcher";
import type { ImageEditCandidate } from "./imageEditResolver";
import type { ManualEditSourceRange } from "./manualEdits";
import { parseSyncTexOutput, parseSyncTexViewOutput } from "./synctexParser";
import { computeLineStarts } from "./textRange";
import { ImagePdfSelection, PdfPoint, PdfSelection, ProjectPaths, SourceMapping, SyncTexRecord } from "./types";

export class SyncTexLocator {
  public async mapImageSelection(
    project: ProjectPaths,
    selection: ImagePdfSelection
  ): Promise<SyncTexRecord[]> {
    const executable = await this.requireCurrentArtifacts(project);
    const records = await mapWithConcurrency(selection.anchors.map((point) => ({ page: selection.page, point })), 4, (location) =>
      this.locatePoint(executable, project, location.page, location.point)
    );
    const mainPath = normalizePath(project.tex, project.root);
    const mainRecords = records.filter((record) => normalizePath(record.input, project.root) === mainPath);
    if (mainRecords.length < Math.ceil(selection.anchors.length * 0.6)) {
      throw new Error("图片区域的大部分定位点没有映射到 main.tex，请缩小选框并避开图注或相邻子图。");
    }
    return mainRecords;
  }

  public async mapSelection(
    project: ProjectPaths,
    selection: PdfSelection,
    contextLines: number
  ): Promise<SourceMapping> {
    if (!(await isFile(project.syncTex)) || !(await isFile(project.pdf))) {
      throw new Error("缺少 main.synctex.gz。请先使用 CircleTeX 编译论文。");
    }
    const [texStat, pdfStat, syncStat] = await Promise.all([
      fs.stat(project.tex), fs.stat(project.pdf), fs.stat(project.syncTex)
    ]);
    if (
      pdfStat.mtimeMs + 1_000 < texStat.mtimeMs ||
      syncStat.mtimeMs + 1_000 < texStat.mtimeMs ||
      syncStat.mtimeMs + 1_000 < pdfStat.mtimeMs
    ) {
      throw new Error("SyncTeX 定位信息已过期，请先重新编译论文。");
    }
    const executable = await findExecutable("synctex");
    if (!executable) {
      throw new Error("未找到 synctex 命令。请检查 TeX 发行版安装。");
    }

    const locations = selectionLocations(selection);
    const records = await mapWithConcurrency(locations, 3, (location) =>
      this.locatePoint(executable, project, location.page, location.point)
    );
    const mainPath = normalizePath(project.tex, project.root);
    if (records.some((record) => normalizePath(record.input, project.root) !== mainPath)) {
      throw new Error("该选区没有完整映射到 main.tex，当前版本不会修改其他源文件。");
    }
    const mappedLines = records.map((record) => record.line);
    if (
      (selection.kind === "region" || (selection.kind === "text" && (selection.pageFragments?.length ?? 0) > 1)) &&
      !hasMonotonicSourceOrder(mappedLines)
    ) {
      throw new Error("PDF 选区未形成连续递增的源码顺序，请缩小或重新选择范围。");
    }
    const startLine = Math.min(...mappedLines);
    const endLine = Math.max(...mappedLines);
    if (endLine - startLine + 1 > 120) {
      throw new Error("选区映射超过 120 行。请缩小 PDF 选区后重试。");
    }
    const mapping = await buildSourceMapping(project.tex, selection, startLine, endLine, contextLines);
    const hasOverlap = hasTextualOverlap(selection.text, mapping.sourceText);
    if (selection.kind === "region") {
      const directEdit = selection.interactionMode === "direct";
      mapping.confidenceNote = directEdit
        ? hasOverlap
          ? "区域框选已通过多点定位，提交时将再次校验连续且安全的源码范围。"
          : "区域文字与映射源码匹配较弱，提交时将执行严格校验并在不唯一时拒绝修改。"
        : hasOverlap
          ? "区域框选已通过多点定位，请核对连续源码范围后再分析。"
          : "区域文字与映射源码未形成稳定文本匹配，请手动调整并确认范围。";
      mapping.requiresConfirmation = !directEdit;
    } else if (!hasOverlap) {
      mapping.confidenceNote = "PDF 文字与映射源码未形成稳定文本匹配，请重点核对或手动调整行范围。";
      mapping.requiresConfirmation = true;
    }
    return mapping;
  }

  public async disambiguateManualEditRange(
    project: ProjectPaths,
    mapping: SourceMapping,
    candidates: readonly ManualEditSourceRange[]
  ): Promise<ManualEditSourceRange> {
    if (candidates.length < 2) {
      throw new Error("重复片段缺少可用于 PDF 位置消歧的数据。");
    }
    const executable = await findExecutable("synctex");
    if (!executable) {
      throw new Error("未找到 synctex 命令，无法区分重复源码片段。");
    }
    const positions = candidates.map((candidate) => sourceLineColumn(mapping, candidate.startOffset));
    const outputs = await mapWithConcurrency(positions, 2, async (position) => {
      const input = `${position.line}:${position.column}:${project.tex}`;
      const result = await runProcess(executable, ["view", "-i", input, "-o", project.pdf], {
        cwd: project.root,
        timeoutMs: 15_000
      });
      if (result.code !== 0) {
        return [];
      }
      return parseSyncTexViewOutput(result.stdout).filter((record) => record.page === mapping.selection.page);
    });
    const target = mapping.selection.start;
    const chosenIndex = chooseSyncTexSpatialCandidate(outputs, target);
    if (chosenIndex === undefined) {
      throw new Error("重复片段的上下文和 PDF 位置仍无法形成唯一结果，已拒绝猜测修改位置。");
    }
    return candidates[chosenIndex];
  }

  public async disambiguateCaretOffset(
    project: ProjectPaths,
    mapping: SourceMapping,
    candidates: readonly number[]
  ): Promise<number> {
    const target = mapping.selection.kind === "text" ? mapping.selection.caretPoint : undefined;
    if (!target || candidates.length < 2) {
      throw new Error("光标边界缺少可用于 PDF 空间消歧的数据。");
    }
    const executable = await findExecutable("synctex");
    if (!executable) {
      throw new Error("未找到 synctex 命令，无法区分多个光标源码边界。");
    }
    const positions = candidates.map((candidate) => sourceLineColumn(mapping, candidate));
    const outputs = await mapWithConcurrency(positions, 2, async (position) => {
      const input = `${position.line}:${position.column}:${project.tex}`;
      const result = await runProcess(executable, ["view", "-i", input, "-o", project.pdf], {
        cwd: project.root,
        timeoutMs: 15_000
      });
      if (result.code !== 0) return [];
      return parseSyncTexViewOutput(result.stdout).filter((record) => record.page === mapping.selection.page);
    });
    const chosenIndex = chooseSyncTexSpatialCandidate(outputs, target);
    if (chosenIndex === undefined) {
      throw new Error("公式或引用附近存在多个源码边界，且 PDF 位置仍无法唯一确认。请单击结构另一侧或拖选普通文字替换。");
    }
    return candidates[chosenIndex];
  }

  public async disambiguateImageCandidate(
    project: ProjectPaths,
    candidates: readonly ImageEditCandidate[],
    selection: ImagePdfSelection
  ): Promise<ImageEditCandidate> {
    if (candidates.length < 2) {
      throw new Error("图片候选不足，无法执行空间消歧。");
    }
    const executable = await findExecutable("synctex");
    if (!executable) {
      throw new Error("未找到 synctex 命令，无法区分相邻图片。");
    }
    const outputs = await mapWithConcurrency([...candidates], 2, async (candidate) => {
      const input = `${candidate.commandLine}:1:${project.tex}`;
      const result = await runProcess(executable, ["view", "-i", input, "-o", project.pdf], {
        cwd: project.root,
        timeoutMs: 15_000
      });
      if (result.code !== 0) return [];
      return parseSyncTexViewOutput(result.stdout).filter((record) => record.page === selection.page);
    });
    const target = {
      x: selection.bounds.x + selection.bounds.width / 2,
      y: selection.bounds.y + selection.bounds.height / 2
    };
    const chosenIndex = chooseSyncTexSpatialCandidate(outputs, target);
    if (chosenIndex === undefined) {
      throw new Error("框选区域对应多个图片命令，SyncTeX 仍无法唯一确认。请缩小选框，只覆盖一张图片主体。");
    }
    return candidates[chosenIndex];
  }

  public async locateImageCandidateViews(
    project: ProjectPaths,
    candidate: ImageEditCandidate,
    page: number
  ): Promise<import("./types").SyncTexViewRecord[]> {
    const executable = await findExecutable("synctex");
    if (!executable) {
      throw new Error("未找到 synctex 命令，无法复核图片边界。");
    }
    const input = `${candidate.commandLine}:1:${project.tex}`;
    const result = await runProcess(executable, ["view", "-i", input, "-o", project.pdf], {
      cwd: project.root,
      timeoutMs: 15_000
    });
    if (result.code !== 0) {
      throw new Error(`SyncTeX 图片正向定位失败：${(result.stderr || result.stdout).trim()}`);
    }
    return parseSyncTexViewOutput(result.stdout).filter((record) => record.page === page);
  }

  private async requireCurrentArtifacts(project: ProjectPaths): Promise<string> {
    if (!(await isFile(project.syncTex)) || !(await isFile(project.pdf))) {
      throw new Error("缺少 main.synctex.gz。请先使用 CircleTeX 编译论文。");
    }
    const [texStat, pdfStat, syncStat] = await Promise.all([
      fs.stat(project.tex), fs.stat(project.pdf), fs.stat(project.syncTex)
    ]);
    if (
      pdfStat.mtimeMs + 1_000 < texStat.mtimeMs ||
      syncStat.mtimeMs + 1_000 < texStat.mtimeMs ||
      syncStat.mtimeMs + 1_000 < pdfStat.mtimeMs
    ) {
      throw new Error("SyncTeX 定位信息已过期，请先重新编译论文。");
    }
    const executable = await findExecutable("synctex");
    if (!executable) {
      throw new Error("未找到 synctex 命令。请检查 TeX 发行版安装。");
    }
    return executable;
  }

  private async locatePoint(
    executable: string,
    project: ProjectPaths,
    page: number,
    point: PdfPoint
  ): Promise<SyncTexRecord> {
    const coordinate = `${page}:${point.x.toFixed(3)}:${point.y.toFixed(3)}:${project.pdf}`;
    const result = await runProcess(executable, ["edit", "-o", coordinate], {
      cwd: project.root,
      timeoutMs: 15_000
    });
    if (result.code !== 0) {
      throw new Error(`SyncTeX 定位失败：${(result.stderr || result.stdout).trim()}`);
    }
    const records = parseSyncTexOutput(result.stdout);
    const best = records[0];
    if (!best) {
      throw new Error("SyncTeX 未返回有效位置。");
    }
    return best;
  }
}

export function selectionLocations(selection: PdfSelection): Array<{ page: number; point: PdfPoint }> {
  if (selection.kind === "region") {
    const locations = uniqueLocations([selection.start, ...selection.anchors, selection.end].map((point) => ({
      page: selection.page,
      point
    })));
    return evenlySampleLocations(locations, 6);
  }
  if (selection.pageFragments?.length) {
    return uniqueLocations(selection.pageFragments.flatMap((fragment) => [
      { page: fragment.page, point: fragment.start },
      { page: fragment.page, point: fragment.end }
    ]));
  }
  return uniqueLocations([selection.start, selection.end].map((point) => ({ page: selection.page, point })));
}

function evenlySampleLocations<T>(items: readonly T[], maximum: number): T[] {
  if (items.length <= maximum) return [...items];
  const selected: T[] = [];
  const indexes = new Set<number>();
  for (let index = 0; index < maximum; index += 1) {
    indexes.add(Math.round(index * (items.length - 1) / (maximum - 1)));
  }
  for (const index of [...indexes].sort((left, right) => left - right)) {
    selected.push(items[index]);
  }
  return selected;
}

function uniqueLocations(
  locations: readonly { page: number; point: PdfPoint }[]
): Array<{ page: number; point: PdfPoint }> {
  const seen = new Set<string>();
  return locations.filter(({ page, point }) => {
    const key = `${page}:${point.x.toFixed(3)}:${point.y.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceLineColumn(mapping: SourceMapping, absoluteOffset: number): { line: number; column: number } {
  const localOffset = clamp(absoluteOffset - mapping.startOffset, 0, mapping.sourceText.length);
  const before = mapping.sourceText.slice(0, localOffset);
  const lines = before.split(/\r\n|\r|\n/);
  return {
    line: mapping.startLine + lines.length - 1,
    column: Math.max(1, (lines.at(-1)?.length ?? 0) + 1)
  };
}

function syncTexViewDistance(record: import("./types").SyncTexViewRecord, target: PdfPoint): number {
  const points = [
    { x: record.x, y: record.y },
    Number.isFinite(record.h) && Number.isFinite(record.v) ? { x: record.h!, y: record.v! } : undefined
  ].filter((point): point is PdfPoint => Boolean(point));
  return Math.min(...points.map((point) => Math.hypot(point.x - target.x, point.y - target.y)));
}

export function chooseSyncTexSpatialCandidate(
  candidates: readonly (readonly import("./types").SyncTexViewRecord[])[],
  target: PdfPoint
): number | undefined {
  const scored = candidates.map((records, index) => ({
    index,
    score: records.reduce((best, record) => Math.min(best, syncTexViewDistance(record, target)), Number.POSITIVE_INFINITY)
  })).sort((left, right) => left.score - right.score);
  const best = scored[0];
  const runnerUp = scored[1];
  return best && runnerUp && Number.isFinite(best.score) && best.score <= 72 && best.score + 8 <= runnerUp.score
    ? best.index
    : undefined;
}

export async function buildSourceMapping(
  sourcePath: string,
  selection: PdfSelection,
  requestedStartLine: number,
  requestedEndLine: number,
  contextLines: number
): Promise<SourceMapping> {
  const fullText = await fs.readFile(sourcePath, "utf8");
  const lineStarts = computeLineStarts(fullText);
  const lineCount = lineStarts.length;
  const startLine = clamp(Math.min(requestedStartLine, requestedEndLine), 1, lineCount);
  const endLine = clamp(Math.max(requestedStartLine, requestedEndLine), startLine, lineCount);
  if (endLine - startLine + 1 > 120) {
    throw new Error("源码范围不能超过 120 行。");
  }
  const startOffset = lineStarts[startLine - 1];
  const endOffset = endLine < lineCount ? lineStarts[endLine] : fullText.length;
  if (endOffset - startOffset > 40_000) {
    throw new Error("源码范围超过 40000 字符，请缩小选区。");
  }
  const contextStartLine = Math.max(1, startLine - contextLines);
  const contextEndLine = Math.min(lineCount, endLine + contextLines);
  const contextStartOffset = lineStarts[contextStartLine - 1];
  const contextEndOffset = contextEndLine < lineCount ? lineStarts[contextEndLine] : fullText.length;
  return {
    id: randomUUID(),
    sourcePath,
    startLine,
    endLine,
    startOffset,
    endOffset,
    sourceText: fullText.slice(startOffset, endOffset),
    contextText: fullText.slice(contextStartOffset, contextEndOffset),
    contextStartLine,
    documentHash: createHash("sha256").update(fullText).digest("hex"),
    normalizedDocumentHash: hashNormalizedText(fullText),
    selection
  };
}

function uniquePoints(points: PdfPoint[]): PdfPoint[] {
  const seen = new Set<string>();
  return points.filter((point) => {
    const key = `${point.x.toFixed(3)}:${point.y.toFixed(3)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function hasMonotonicSourceOrder(lines: number[]): boolean {
  return lines.every((line, index) => index === 0 || line >= lines[index - 1]);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  maximum: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(maximum, items.length) }, () => run()));
  return results;
}

function normalizePath(value: string, baseDirectory: string): string {
  const resolved = path.resolve(baseDirectory, value).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
