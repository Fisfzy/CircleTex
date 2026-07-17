import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NormalizedManualEditRect, validateManualEditRects } from "./manualEdits";
import { ImagePdfSelection, PdfRect, SyncTexRecord, SyncTexViewRecord } from "./types";

export type ImageSizeParameter = "width" | "height" | "scale" | "subfigureWidth";

export interface ImageEditCandidate {
  commandStartOffset: number;
  commandEndOffset: number;
  commandLine: number;
  imagePath: string;
  resolvedImagePath: string;
  parameter: ImageSizeParameter;
  startOffset: number;
  endOffset: number;
  sourceText: string;
  baseNumericValue: number;
  suffix: string;
  insertionPrefix: string;
  originalDisplay: string;
}

export interface ImageEditTarget extends ImageEditCandidate {
  id: string;
  page: number;
  rects: NormalizedManualEditRect[];
  baseDocumentHash: string;
}

export interface PendingImageEdit {
  editType: "image";
  id: string;
  kind: "imageResize";
  startOffset: number;
  endOffset: number;
  sourceText: string;
  replacementText: string;
  page: number;
  rects: NormalizedManualEditRect[];
  baseDocumentHash: string;
  imagePath: string;
  parameter: ImageSizeParameter;
  originalValue: string;
  candidateValue: string;
  factor: number;
}

export interface ImageSelectionConsistency {
  score: number;
  coordinateVariant: "xy" | "hv" | "xy-flipped" | "hv-flipped";
  syncTexBounds: NormalizedManualEditRect;
}

const INCLUDE_GRAPHICS = /\\includegraphics\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}/gu;
const SIZE_OPTION = /^(width|height|scale)\s*=\s*(.+)$/u;
const DIMENSION_VALUE = /^([0-9]+(?:\.[0-9]+)?|\.[0-9]+)?(\\(?:linewidth|textwidth|columnwidth|paperwidth|textheight|paperheight)|cm|mm|in|pt|bp|pc|em|ex)$/u;
const SCALE_VALUE = /^([0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/u;
const GRAPHIC_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".eps"];

export async function findImageEditCandidates(source: string, projectRoot: string): Promise<ImageEditCandidate[]> {
  if (typeof source !== "string" || source.length > 5_000_000) {
    throw new Error("LaTeX 源码无效或过大，无法安全查找图片命令。");
  }
  const candidates: ImageEditCandidate[] = [];
  const graphicDirectories = parseGraphicDirectories(source);
  INCLUDE_GRAPHICS.lastIndex = 0;
  for (let match = INCLUDE_GRAPHICS.exec(source); match; match = INCLUDE_GRAPHICS.exec(source)) {
    if (isCommented(source, match.index)) continue;
    const imagePath = match[2].trim();
    const resolvedImagePath = await resolveGraphicPath(projectRoot, imagePath, graphicDirectories);
    if (!resolvedImagePath) continue;
    const commandText = match[0];
    const commandEndOffset = match.index + commandText.length;
    const commandLine = lineAtOffset(source, match.index);
    const optionText = match[1];
    const options = optionText === undefined ? [] : splitOptions(optionText);
    const sizeOptions = options.map((option) => ({ option, parsed: SIZE_OPTION.exec(option.trim()) }))
      .filter((item): item is { option: string; parsed: RegExpExecArray } => Boolean(item.parsed));
    if (sizeOptions.length > 1) continue;

    if (sizeOptions.length === 0) {
      const braceOffset = commandText.indexOf("{");
      const insertionOffset = optionText === undefined
        ? match.index + braceOffset
        : match.index + commandText.indexOf("]");
      const estimated = estimateLinewidth(selectionIndependentEstimate());
      candidates.push({
        commandStartOffset: match.index,
        commandEndOffset,
        commandLine,
        imagePath,
        resolvedImagePath,
        parameter: "width",
        startOffset: insertionOffset,
        endOffset: insertionOffset,
        sourceText: "",
        baseNumericValue: estimated,
        suffix: "\\linewidth",
        insertionPrefix: optionText === undefined ? "[width=" : `${optionText.trim().length > 0 ? "," : ""}width=`,
        originalDisplay: "未显式设置尺寸"
      });
      continue;
    }

    const parsedOption = sizeOptions[0].parsed;
    const parameter = parsedOption[1] as "width" | "height" | "scale";
    const rawValue = parsedOption[2].trim();
    const value = parseSimpleSizeValue(parameter, rawValue);
    if (!value) continue;
    const optionGroupStart = match.index + commandText.indexOf("[") + 1;
    const valueIndexInOption = sizeOptions[0].option.indexOf(parsedOption[2]);
    const optionIndex = optionText!.indexOf(sizeOptions[0].option);
    const startOffset = optionGroupStart + optionIndex + valueIndexInOption;
    let candidate: ImageEditCandidate = {
      commandStartOffset: match.index,
      commandEndOffset,
      commandLine,
      imagePath,
      resolvedImagePath,
      parameter,
      startOffset,
      endOffset: startOffset + parsedOption[2].length,
      sourceText: parsedOption[2],
      baseNumericValue: value.numeric,
      suffix: value.suffix,
      insertionPrefix: "",
      originalDisplay: `${parameter}=${rawValue}`
    };
    const subfigure = parameter === "width" && value.numeric === 1 && value.suffix === "\\linewidth"
      ? enclosingSimpleSubfigure(source, match.index, commandEndOffset)
      : undefined;
    if (subfigure) {
      candidate = { ...candidate, ...subfigure, originalDisplay: `subfigure width=${subfigure.sourceText.trim()}` };
    }
    candidates.push(candidate);
  }
  return candidates;
}

export function chooseImageCandidatesByMappedLines(
  candidates: readonly ImageEditCandidate[],
  records: readonly SyncTexRecord[]
): ImageEditCandidate[] {
  if (candidates.length === 0 || records.length === 0) return [];
  const scored = candidates.map((candidate) => {
    const distances = records.map((record) => Math.abs(record.line - candidate.commandLine));
    return {
      candidate,
      maximum: Math.max(...distances),
      total: distances.reduce((sum, value) => sum + value, 0)
    };
  }).filter((item) => item.maximum <= 18)
    .sort((left, right) => left.maximum - right.maximum || left.total - right.total);
  const best = scored[0];
  if (!best) return [];
  const plausible = scored.filter((item) => item.maximum <= best.maximum + 2 && item.total <= best.total + records.length * 2);
  return plausible.map((item) => item.candidate);
}

export function createImageEditTarget(
  candidate: ImageEditCandidate,
  selection: ImagePdfSelection,
  documentText: string,
  id: string = randomUUID()
): ImageEditTarget {
  const rects = validateManualEditRects([{
    page: selection.page,
    x: selection.bounds.x / selection.pageWidth,
    y: selection.bounds.y / selection.pageHeight,
    width: selection.bounds.width / selection.pageWidth,
    height: selection.bounds.height / selection.pageHeight
  }]);
  const baseNumericValue = candidate.sourceText.length === 0
    ? estimateLinewidth(selection.bounds.width / selection.pageWidth)
    : candidate.baseNumericValue;
  return {
    ...candidate,
    id,
    page: selection.page,
    rects,
    baseNumericValue,
    baseDocumentHash: hashDocument(documentText)
  };
}

export function validateImageSelectionConsistency(
  selection: ImagePdfSelection,
  forwardRecords: readonly SyncTexViewRecord[]
): ImageSelectionConsistency | undefined {
  if (forwardRecords.length === 0) {
    return undefined;
  }
  const matchingPage = forwardRecords.filter((record) => record.page === selection.page);
  if (!matchingPage.some((record) => Number.isFinite(record.width) && Number.isFinite(record.height))) {
    return undefined;
  }
  const comparisons = matchingPage.flatMap((record) => syncTexRecordRects(record, selection.pageHeight).map((item) => {
    const normalized = normalizePdfRect(item.rect, selection.pageWidth, selection.pageHeight);
    return {
      ...item,
      normalized,
      score: scoreImageRectMatch(normalizePdfRect(selection.bounds, selection.pageWidth, selection.pageHeight), normalized)
    };
  })).filter((item, index, all) => !all.slice(0, index).some((other) =>
    Math.abs(other.normalized.x - item.normalized.x) < 0.0001 &&
    Math.abs(other.normalized.y - item.normalized.y) < 0.0001 &&
    Math.abs(other.normalized.width - item.normalized.width) < 0.0001 &&
    Math.abs(other.normalized.height - item.normalized.height) < 0.0001
  )).sort((left, right) => right.score - left.score);
  const best = comparisons[0];
  const runnerUp = comparisons[1];
  const hasClearWinner = !runnerUp || best.score >= runnerUp.score + 0.08;
  if (!best || best.score < 0.56 || !hasClearWinner) {
    // SyncTeX view 对部分 \includegraphics 只返回外层行盒或图注节点；
    // 图片命令已经由多点 SyncTeX edit 和源码行消歧确定，此处仅提供可用的可视化复核。
    return undefined;
  }
  return {
    score: best.score,
    coordinateVariant: best.coordinateVariant,
    syncTexBounds: { page: selection.page, ...best.normalized }
  };
}

export function createPendingImageEdit(
  target: ImageEditTarget,
  factor: number,
  id: string = randomUUID()
): PendingImageEdit {
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0.25 || factor > 3) {
    throw new Error("图片缩放比例必须位于 25% 至 300% 之间。");
  }
  if (Math.abs(factor - 1) < 0.0001) {
    throw new Error("图片尺寸尚未调整，请先单击放大或缩小。");
  }
  const formatted = formatSizeValue(target.baseNumericValue * factor, target.suffix);
  const candidateValue = target.parameter === "subfigureWidth"
    ? `subfigure width=${formatted}`
    : `${target.parameter}=${formatted}`;
  let replacementText = formatted;
  if (target.sourceText.length === 0) {
    replacementText = target.insertionPrefix + formatted + (target.insertionPrefix.startsWith("[") ? "]" : "");
  }
  return {
    editType: "image",
    id,
    kind: "imageResize",
    startOffset: target.startOffset,
    endOffset: target.endOffset,
    sourceText: target.sourceText,
    replacementText,
    page: target.page,
    rects: target.rects,
    baseDocumentHash: target.baseDocumentHash,
    imagePath: target.imagePath,
    parameter: target.parameter,
    originalValue: target.originalDisplay,
    candidateValue,
    factor
  };
}

export function validatePendingImageEdit(baseText: string, edit: PendingImageEdit): void {
  if (edit.editType !== "image" || edit.kind !== "imageResize") {
    throw new Error("图片尺寸调整类型无效。");
  }
  if (edit.baseDocumentHash !== hashDocument(baseText)) {
    throw new Error(`图片尺寸调整 ${edit.id} 的基线源码校验失败。`);
  }
  if (edit.startOffset < 0 || edit.endOffset < edit.startOffset || edit.endOffset > baseText.length) {
    throw new Error(`图片尺寸调整 ${edit.id} 的源码范围越界。`);
  }
  if (baseText.slice(edit.startOffset, edit.endOffset) !== edit.sourceText) {
    throw new Error(`图片尺寸调整 ${edit.id} 的目标命令已发生变化。`);
  }
  if (!Number.isFinite(edit.factor) || edit.factor < 0.25 || edit.factor > 3 || Math.abs(edit.factor - 1) < 0.0001) {
    throw new Error(`图片尺寸调整 ${edit.id} 的缩放比例无效。`);
  }
  if (!edit.replacementText || edit.replacementText.length > 200 || /[\r\n%{}]/u.test(edit.replacementText)) {
    throw new Error(`图片尺寸调整 ${edit.id} 的候选参数无效。`);
  }
  validateManualEditRects(edit.rects);
}

export function formatImageCandidateValue(target: ImageEditTarget, factor: number): string {
  const formatted = formatSizeValue(target.baseNumericValue * factor, target.suffix);
  return target.parameter === "subfigureWidth"
    ? `subfigure width=${formatted}`
    : `${target.parameter}=${formatted}`;
}

function parseSimpleSizeValue(parameter: "width" | "height" | "scale", raw: string): { numeric: number; suffix: string } | undefined {
  const match = parameter === "scale" ? SCALE_VALUE.exec(raw) : DIMENSION_VALUE.exec(raw);
  if (!match) return undefined;
  const numeric = parameter === "scale" ? Number(match[1]) : Number(match[1] || 1);
  const suffix = parameter === "scale" ? "" : match[2];
  return Number.isFinite(numeric) && numeric > 0 ? { numeric, suffix } : undefined;
}

function syncTexRecordRects(
  record: SyncTexViewRecord,
  pageHeight: number
): Array<{ rect: PdfRect; coordinateVariant: ImageSelectionConsistency["coordinateVariant"] }> {
  const results: Array<{ rect: PdfRect; coordinateVariant: ImageSelectionConsistency["coordinateVariant"] }> = [];
  if (Number.isFinite(record.width) && Number.isFinite(record.height) && record.width! > 0 && record.height! > 0) {
    addSyncTexRectVariants(results, record.x, record.y, record.width!, record.height!, pageHeight, "xy");
    if (Number.isFinite(record.h) && Number.isFinite(record.v)) {
      addSyncTexRectVariants(results, record.h!, record.v!, record.width!, record.height!, pageHeight, "hv");
    }
  }
  return results;
}

function addSyncTexRectVariants(
  results: Array<{ rect: PdfRect; coordinateVariant: ImageSelectionConsistency["coordinateVariant"] }>,
  x: number,
  y: number,
  width: number,
  height: number,
  pageHeight: number,
  coordinateVariant: "xy" | "hv"
): void {
  results.push({ rect: { x, y, width, height }, coordinateVariant });
  results.push({
    rect: { x, y: pageHeight - y - height, width, height },
    coordinateVariant: `${coordinateVariant}-flipped` as ImageSelectionConsistency["coordinateVariant"]
  });
}

function normalizePdfRect(rect: PdfRect, pageWidth: number, pageHeight: number): PdfRect {
  return {
    x: clamp(rect.x / pageWidth, 0, 1),
    y: clamp(rect.y / pageHeight, 0, 1),
    width: clamp(rect.width / pageWidth, 0, 1),
    height: clamp(rect.height / pageHeight, 0, 1)
  };
}

function scoreImageRectMatch(left: PdfRect, right: PdfRect): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = width * height;
  const leftArea = Math.max(0.000001, left.width * left.height);
  const rightArea = Math.max(0.000001, right.width * right.height);
  const coverage = intersection / Math.min(leftArea, rightArea);
  const leftCenter = { x: left.x + left.width / 2, y: left.y + left.height / 2 };
  const rightCenter = { x: right.x + right.width / 2, y: right.y + right.height / 2 };
  const centerDistance = Math.hypot(leftCenter.x - rightCenter.x, leftCenter.y - rightCenter.y);
  const centerScore = Math.max(0, 1 - centerDistance / 0.32);
  const aspectScore = Math.min(left.width / Math.max(right.width, 0.000001), right.width / Math.max(left.width, 0.000001)) *
    Math.min(left.height / Math.max(right.height, 0.000001), right.height / Math.max(left.height, 0.000001));
  return coverage * 0.56 + centerScore * 0.34 + aspectScore * 0.10;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function enclosingSimpleSubfigure(
  source: string,
  commandStart: number,
  commandEnd: number
): Pick<ImageEditCandidate, "parameter" | "startOffset" | "endOffset" | "sourceText" | "baseNumericValue" | "suffix" | "insertionPrefix"> | undefined {
  const before = source.slice(0, commandStart);
  const beginPattern = /\\begin\{subfigure\}(?:\[[^\]]*\])?\s*\{([^{}]+)\}/gu;
  let last: RegExpExecArray | undefined;
  for (let match = beginPattern.exec(before); match; match = beginPattern.exec(before)) last = match;
  if (!last || before.lastIndexOf("\\end{subfigure}") > last.index) return undefined;
  const endIndex = source.indexOf("\\end{subfigure}", commandEnd);
  if (endIndex < 0) return undefined;
  const rawValue = last[1];
  const parsed = parseSimpleSizeValue("width", rawValue.trim());
  if (!parsed) return undefined;
  const groupStart = last.index + last[0].lastIndexOf("{") + 1;
  return {
    parameter: "subfigureWidth",
    startOffset: groupStart,
    endOffset: groupStart + rawValue.length,
    sourceText: rawValue,
    baseNumericValue: parsed.numeric,
    suffix: parsed.suffix,
    insertionPrefix: ""
  };
}

async function resolveGraphicPath(
  projectRoot: string,
  graphicPath: string,
  graphicDirectories: readonly string[]
): Promise<string | undefined> {
  if (!graphicPath || /[\\{}#$%]/u.test(graphicPath) || path.isAbsolute(graphicPath)) return undefined;
  const normalizedRoot = path.resolve(projectRoot);
  const basePaths = ["", ...graphicDirectories].map((directory) =>
    path.resolve(normalizedRoot, directory, graphicPath.replace(/\//g, path.sep))
  ).filter((base) => {
    const relative = path.relative(normalizedRoot, base);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  const candidates = basePaths.flatMap((base) => path.extname(base) ? [base] : GRAPHIC_EXTENSIONS.map((extension) => `${base}${extension}`));
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // 继续尝试 LaTeX 常用图片扩展名。
    }
  }
  return undefined;
}

function parseGraphicDirectories(source: string): string[] {
  const directories: string[] = [];
  const pattern = /\\graphicspath\s*\{((?:\{[^{}]+\}\s*)+)\}/gu;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const directoryPattern = /\{([^{}]+)\}/gu;
    for (let item = directoryPattern.exec(match[1]); item; item = directoryPattern.exec(match[1])) {
      const value = item[1].trim().replace(/[\\/]+$/u, "");
      if (value && !path.isAbsolute(value) && !value.split(/[\\/]/u).includes("..")) directories.push(value);
    }
  }
  return [...new Set(directories)];
}

function splitOptions(value: string): string[] {
  if (/[{}\[\]]/u.test(value)) return [value];
  return value.split(",");
}

function lineAtOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source[index] === "\n") line += 1;
  return line;
}

function isCommented(source: string, offset: number): boolean {
  const lineStart = Math.max(source.lastIndexOf("\n", offset - 1), source.lastIndexOf("\r", offset - 1)) + 1;
  const prefix = source.slice(lineStart, offset);
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== "%") continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && prefix[cursor] === "\\"; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0) return true;
  }
  return false;
}

function formatSizeValue(value: number, suffix: string): string {
  const rounded = Number(value.toFixed(4));
  return `${rounded}${suffix}`;
}

function estimateLinewidth(pageRatio: number): number {
  return Math.min(1.2, Math.max(0.1, Number((pageRatio / 0.8).toFixed(3))));
}

function selectionIndependentEstimate(): number {
  return 0.64;
}

function hashDocument(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
