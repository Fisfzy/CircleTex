import { createHash, randomUUID } from "node:crypto";
import {
  adjacentEditableLatexRange,
  isEditableLatexBoundary,
  isEditableLatexTextRange,
  structuredCaretCandidates
} from "./latexProjection";
import {
  resolveRegionEditSourceRange,
  validateResolvedRegionEditRange
} from "./regionEditResolver";
import { SourceMapping } from "./types";

export type ManualEditKind = "insertBefore" | "insertAfter" | "delete" | "replace";
export type CaretDeleteDirection = "backward" | "forward";

export interface NormalizedManualEditRect {
  page?: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PendingManualEdit {
  id: string;
  kind: ManualEditKind;
  startOffset: number;
  endOffset: number;
  sourceText: string;
  insertedText: string;
  page: number;
  rects: NormalizedManualEditRect[];
  baseDocumentHash: string;
}

export interface ManualEditSourceRange {
  startOffset: number;
  endOffset: number;
  sourceText: string;
}

export class ManualEditAmbiguityError extends Error {
  public constructor(public readonly candidates: readonly ManualEditSourceRange[]) {
    super("PDF 文字在映射源码中存在重复片段，且上下文不足以确定唯一修改位置。");
    this.name = "ManualEditAmbiguityError";
  }
}

export class ManualEditCaretAmbiguityError extends Error {
  public constructor(public readonly candidates: readonly number[]) {
    super("光标位置对应多个候选边界，需要结合 PDF 位置进一步确认安全的 LaTeX 正文边界。");
    this.name = "ManualEditCaretAmbiguityError";
  }
}

interface ManualEditSelectionMatch {
  selected: CollapsedText;
  source: CollapsedText;
  sourceGraphemeStart: number;
  localStart: number;
  localEnd: number;
}

export interface ResolveCircleTeXRevisionsOptions {
  removePreamble?: boolean;
}

export const CIRCLETEX_REVISION_BLOCK_BEGIN = "% CIRCLETEX-REVISION-BEGIN";
export const CIRCLETEX_REVISION_BLOCK_END = "% CIRCLETEX-REVISION-END";

const ADDED_COMMAND = "\\CircleTeXAdded";
const DELETED_COMMAND = "\\CircleTeXDeleted";
const SOURCE_FORBIDDEN = /[\\{}$%&#_^~]/u;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;
const TRANSPARENT_LAYOUT_COMMAND_RE = /\\(?:hspace|vspace)\*?\{[^{}]*\}|\\(?:noindent|par|quad|qquad|enspace|thinspace|medspace|thickspace|smallskip|medskip|bigskip|newline|linebreak)\b/gu;
const GRAPHEME_SEGMENTER = new Intl.Segmenter("und", { granularity: "grapheme" });
class ManualEditCharacterMatchError extends Error {
  public constructor() {
    super("PDF 文字无法在映射源码中建立字符级匹配。");
    this.name = "ManualEditCharacterMatchError";
  }
}

/**
 * 将 PDF 可见文字唯一定位到 SyncTeX 给出的源码窗口，并返回文档绝对偏移。
 */
export function resolveManualEditSourceRange(mapping: SourceMapping): ManualEditSourceRange {
  if (mapping.selection.kind === "region") {
    return resolveRegionEditSourceRange(mapping);
  }
  const match = resolveManualEditSelectionMatch(mapping);
  return {
    startOffset: mapping.startOffset + match.localStart,
    endOffset: mapping.startOffset + match.localEnd,
    sourceText: mapping.sourceText.slice(match.localStart, match.localEnd)
  };
}

/**
 * 将 PDF 选区内的可见字符边界转换为文档绝对偏移。
 * caretVisibleOffset 按 NFKC 规范化、去空白后的 Unicode 字素簇计数。
 * 前端必须使用 normalizeManualEditVisibleGraphemes 的等价算法计算该偏移。
 */
export function resolveManualEditCaretOffset(
  mapping: SourceMapping,
  caretVisibleOffset: number
): number {
  const resolved = resolveManualEditCaret(mapping, caretVisibleOffset);
  return mapping.startOffset + resolved.localOffset;
}

function resolveManualEditSelectionMatch(mapping: SourceMapping): ManualEditSelectionMatch {
  if (
    !Number.isInteger(mapping.startOffset) ||
    !Number.isInteger(mapping.endOffset) ||
    mapping.startOffset < 0 ||
    mapping.endOffset < mapping.startOffset ||
    mapping.endOffset - mapping.startOffset !== mapping.sourceText.length
  ) {
    throw new Error("源码映射范围无效，无法建立手动修订。");
  }

  const selected = collapseVisibleText(mapping.selection.text);
  if (selected.text.length === 0) {
    throw new Error("PDF 选区不包含可定位文字。");
  }
  const source = collapseVisibleText(mapping.sourceText);
  const ranges: Array<{
    start: number;
    end: number;
    sourceGraphemeStart: number;
  }> = [];
  const seen = new Set<string>();
  for (
    let sourceGraphemeStart = 0;
    sourceGraphemeStart <= source.graphemes.length - selected.graphemes.length;
    sourceGraphemeStart += 1
  ) {
    const matches = selected.graphemes.every((grapheme, selectedIndex) =>
      source.graphemes[sourceGraphemeStart + selectedIndex] === grapheme
    );
    if (!matches) {
      continue;
    }
    const start = source.starts[sourceGraphemeStart];
    const end = source.ends[sourceGraphemeStart + selected.graphemes.length - 1];
    const key = `${start}:${end}`;
    if (!seen.has(key)) {
      seen.add(key);
      ranges.push({ start, end, sourceGraphemeStart });
    }
  }

  const safeRanges = ranges.filter((range) => {
    try {
      validateOrdinarySourceFragment(
        mapping.sourceText,
        range.start,
        mapping.sourceText.slice(range.start, range.end)
      );
      return true;
    } catch {
      return false;
    }
  });
  if (safeRanges.length === 0) {
    if (ranges.length > 0) {
      const first = ranges[0];
      validateOrdinarySourceFragment(
        mapping.sourceText,
        first.start,
        mapping.sourceText.slice(first.start, first.end)
      );
    }
    throw new ManualEditCharacterMatchError();
  }
  let range = safeRanges[0];
  if (safeRanges.length > 1) {
    const contextual = chooseCandidateByVisibleContext(mapping, source, selected, safeRanges);
    if (!contextual) {
      throw new ManualEditAmbiguityError(safeRanges.map((candidate) => ({
        startOffset: mapping.startOffset + candidate.start,
        endOffset: mapping.startOffset + candidate.end,
        sourceText: mapping.sourceText.slice(candidate.start, candidate.end)
      })));
    }
    range = contextual;
  }
  const sourceText = mapping.sourceText.slice(range.start, range.end);
  return {
    selected,
    source,
    sourceGraphemeStart: range.sourceGraphemeStart,
    localStart: range.start,
    localEnd: range.end
  };
}

function chooseCandidateByVisibleContext(
  mapping: SourceMapping,
  source: CollapsedText,
  selected: CollapsedText,
  ranges: readonly { start: number; end: number; sourceGraphemeStart: number }[]
): { start: number; end: number; sourceGraphemeStart: number } | undefined {
  if (mapping.selection.kind !== "text") {
    return undefined;
  }
  const before = collapseVisibleText(mapping.selection.contextBefore ?? "").graphemes.slice(-20);
  const after = collapseVisibleText(mapping.selection.contextAfter ?? "").graphemes.slice(0, 20);
  if (before.length + after.length < 4) {
    return undefined;
  }
  const scored = ranges.map((range) => {
    const beforeMatch = matchingContextLength(
      before,
      source.graphemes.slice(0, range.sourceGraphemeStart),
      true
    );
    const afterStart = range.sourceGraphemeStart + selected.graphemes.length;
    const afterMatch = matchingContextLength(
      after,
      source.graphemes.slice(afterStart),
      false
    );
    return { range, beforeMatch, afterMatch, score: beforeMatch + afterMatch };
  }).sort((left, right) => right.score - left.score);
  const best = scored[0];
  const runnerUp = scored[1];
  if (
    !best ||
    best.score < 4 ||
    Math.max(best.beforeMatch, best.afterMatch) < 3 ||
    (runnerUp && best.score - runnerUp.score < 2)
  ) {
    return undefined;
  }
  return best.range;
}

function matchingContextLength(wanted: readonly string[], available: readonly string[], fromEnd: boolean): number {
  const limit = Math.min(wanted.length, available.length);
  let matched = 0;
  for (let offset = 1; offset <= limit; offset += 1) {
    const wantedIndex = fromEnd ? wanted.length - offset : offset - 1;
    const availableIndex = fromEnd ? available.length - offset : offset - 1;
    if (wanted[wantedIndex] !== available[availableIndex]) {
      break;
    }
    matched += 1;
  }
  return matched;
}

function resolveManualEditCaret(
  mapping: SourceMapping,
  caretVisibleOffset: number
): { match: ManualEditSelectionMatch; localOffset: number } {
  const match = resolveManualEditSelectionMatch(mapping);
  const visibleLength = match.selected.graphemes.length;
  validateCaretVisibleOffset(caretVisibleOffset, visibleLength);
  if (caretVisibleOffset === 0) {
    return { match, localOffset: match.localStart };
  }
  if (caretVisibleOffset === visibleLength) {
    return { match, localOffset: match.localEnd };
  }

  const leftGrapheme = match.sourceGraphemeStart + caretVisibleOffset - 1;
  const rightGrapheme = leftGrapheme + 1;
  const leftEnd = match.source.ends[leftGrapheme];
  const rightStart = match.source.starts[rightGrapheme];
  if (leftEnd > rightStart) {
    throw new Error("光标位于 NFKC 规范化字符的内部，无法安全映射到源码边界。");
  }
  return { match, localOffset: rightStart };
}

function resolveManualEditInsertionOffset(mapping: SourceMapping, caretVisibleOffset: number): number {
  try {
    const strict = resolveManualEditCaret(mapping, caretVisibleOffset);
    return mapping.startOffset + strict.localOffset;
  } catch (error) {
    if (!(error instanceof ManualEditCharacterMatchError)) {
      throw error;
    }
  }

  const selected = collapseVisibleText(mapping.selection.text);
  const visibleLength = selected.graphemes.length;
  validateCaretVisibleOffset(caretVisibleOffset, visibleLength);
  const candidates = structuredCaretCandidates(
    mapping.sourceText,
    mapping.selection.text,
    caretVisibleOffset
  ).map((candidate) => mapping.startOffset + candidate.offset);
  if (candidates.length === 1) {
    validateOrdinaryInsertionPoint(mapping.sourceText, candidates[0] - mapping.startOffset);
    return candidates[0];
  }
  if (candidates.length > 1) {
    throw new ManualEditCaretAmbiguityError(candidates);
  }
  throw new Error("该 PDF 光标位于公式、引用或未知 LaTeX 结构内部，无法确定安全的普通正文边界。请单击结构前后，或拖选普通文字替换。");
}

function validateCaretVisibleOffset(caretVisibleOffset: number, visibleLength: number): void {
  if (
    !Number.isInteger(caretVisibleOffset) ||
    caretVisibleOffset < 0 ||
    caretVisibleOffset > visibleLength
  ) {
    throw new Error(`光标可见字符偏移必须位于 0 至 ${visibleLength} 之间。`);
  }
}

export function createPendingManualEdit(
  mapping: SourceMapping,
  kind: ManualEditKind,
  insertedText: string,
  rects: readonly NormalizedManualEditRect[],
  id: string = randomUUID(),
  resolvedRange?: ManualEditSourceRange
): PendingManualEdit {
  if (!isManualEditKind(kind)) {
    throw new Error("手动修订类型无效。");
  }
  if (typeof id !== "string" || id.trim().length === 0 || id.length > 200) {
    throw new Error("手动修订标识无效。");
  }
  if (!Number.isInteger(mapping.selection.page) || mapping.selection.page < 1) {
    throw new Error("手动修订页码无效。");
  }
  const normalizedRects = validateManualEditRects(rects);
  const range = resolvedRange
    ? validateResolvedManualEditRange(mapping, resolvedRange)
    : resolveManualEditSourceRange(mapping);
  validateInsertedTextForKind(kind, insertedText);
  return {
    id,
    kind,
    ...range,
    insertedText,
    page: mapping.selection.page,
    rects: normalizedRects,
    baseDocumentHash: mapping.documentHash
  };
}

function validateResolvedManualEditRange(
  mapping: SourceMapping,
  range: ManualEditSourceRange
): ManualEditSourceRange {
  if (mapping.selection.kind === "region") {
    return validateResolvedRegionEditRange(mapping, range);
  }
  const localStart = range.startOffset - mapping.startOffset;
  const localEnd = range.endOffset - mapping.startOffset;
  if (
    !Number.isInteger(localStart) ||
    !Number.isInteger(localEnd) ||
    localStart < 0 ||
    localEnd <= localStart ||
    localEnd > mapping.sourceText.length ||
    mapping.sourceText.slice(localStart, localEnd) !== range.sourceText
  ) {
    throw new Error("后端消歧返回的源码范围无效。");
  }
  validateOrdinarySourceFragment(mapping.sourceText, localStart, range.sourceText);
  return { ...range };
}

/**
 * 从 PDF 可见文字中的光标边界创建零宽插入，或创建相邻字符删除。
 */
export function createPendingCaretManualEdit(
  mapping: SourceMapping,
  kind: ManualEditKind,
  insertedText: string,
  caretVisibleOffset: number,
  rects: readonly NormalizedManualEditRect[],
  id: string = randomUUID(),
  deleteDirection?: CaretDeleteDirection,
  resolvedCaretOffset?: number
): PendingManualEdit {
  if (kind !== "insertBefore" && kind !== "insertAfter" && kind !== "delete") {
    throw new Error("光标手动编辑仅支持插入或相邻字符删除。");
  }
  if (typeof id !== "string" || id.trim().length === 0 || id.length > 200) {
    throw new Error("手动编辑标识无效。");
  }
  if (!Number.isInteger(mapping.selection.page) || mapping.selection.page < 1) {
    throw new Error("手动编辑页码无效。");
  }
  const normalizedRects = validateManualEditRects(rects);
  let startOffset: number;
  let endOffset: number;
  let sourceText = "";

  if (kind === "delete") {
    if (deleteDirection !== "backward" && deleteDirection !== "forward") {
      throw new Error("光标删除必须指定 backward 或 forward 方向。");
    }
    const visibleLength = collapseVisibleText(mapping.selection.text).graphemes.length;
    validateCaretVisibleOffset(caretVisibleOffset, visibleLength);
    if (deleteDirection === "backward" && caretVisibleOffset === 0) {
      throw new Error("光标前没有可删除的可见字符。");
    }
    if (deleteDirection === "forward" && caretVisibleOffset === visibleLength) {
      throw new Error("光标后没有可删除的可见字符。");
    }
    let localStart: number;
    let localEnd: number;
    try {
      const resolved = resolveManualEditCaret(mapping, caretVisibleOffset);
      const selectedGrapheme = resolved.match.sourceGraphemeStart + (
        deleteDirection === "backward" ? caretVisibleOffset - 1 : caretVisibleOffset
      );
      localStart = resolved.match.source.starts[selectedGrapheme];
      localEnd = resolved.match.source.ends[selectedGrapheme];
    } catch (error) {
      if (!(error instanceof ManualEditCharacterMatchError) && resolvedCaretOffset === undefined) throw error;
      const absoluteCaret = resolvedCaretOffset ?? resolveManualEditInsertionOffset(mapping, caretVisibleOffset);
      const localCaret = absoluteCaret - mapping.startOffset;
      const adjacent = adjacentEditableLatexRange(mapping.sourceText, localCaret, deleteDirection);
      if (!adjacent) {
        throw new Error("光标相邻位置是公式、引用或其他 LaTeX 结构，不能按单个 PDF 字符删除。请编辑源码或选择完整普通文字。");
      }
      ({ start: localStart, end: localEnd } = adjacent);
    }
    startOffset = mapping.startOffset + localStart;
    endOffset = mapping.startOffset + localEnd;
    sourceText = mapping.sourceText.slice(localStart, localEnd);
    validateOrdinarySourceFragment(mapping.sourceText, localStart, sourceText);
  } else {
    if (deleteDirection !== undefined) {
      throw new Error("光标插入不能指定删除方向。");
    }
    startOffset = resolvedCaretOffset ?? resolveManualEditInsertionOffset(mapping, caretVisibleOffset);
    const localOffset = startOffset - mapping.startOffset;
    if (localOffset < 0 || localOffset > mapping.sourceText.length) {
      throw new Error("后端消歧返回的光标边界超出源码范围。");
    }
    validateOrdinaryInsertionPoint(mapping.sourceText, localOffset);
    endOffset = startOffset;
  }

  validateInsertedTextForKind(kind, insertedText);
  return {
    id,
    kind,
    startOffset,
    endOffset,
    sourceText,
    insertedText,
    page: mapping.selection.page,
    rects: normalizedRects,
    baseDocumentHash: mapping.documentHash
  };
}

export function validateManualEditRects(
  rects: readonly NormalizedManualEditRect[]
): NormalizedManualEditRect[] {
  if (!Array.isArray(rects) || rects.length < 1 || rects.length > 256) {
    throw new Error("手动修订必须包含 1 至 256 个有效矩形。");
  }
  return rects.map((rect) => {
    if (!rect || typeof rect !== "object") {
      throw new Error("手动修订矩形无效。");
    }
    const values = [rect.x, rect.y, rect.width, rect.height];
    if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error("手动修订矩形坐标无效。");
    }
    const epsilon = 1e-9;
    if (
      rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 ||
      rect.x + rect.width > 1 + epsilon || rect.y + rect.height > 1 + epsilon
    ) {
      throw new Error("手动修订矩形必须使用 0 至 1 的归一化坐标。");
    }
    if (rect.page !== undefined && (!Number.isInteger(rect.page) || rect.page < 1 || rect.page > 100_000)) {
      throw new Error("手动修订矩形页码无效。");
    }
    return { ...(rect.page === undefined ? {} : { page: rect.page }), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

/** 校验用户输入并将其作为普通文字转义，而不是作为 LaTeX 指令执行。 */
export function escapeLatexPlainText(value: string): string {
  validatePlainText(value);
  const replacements: Record<string, string> = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    "$": "\\$",
    "&": "\\&",
    "#": "\\#",
    "_": "\\_",
    "%": "\\%",
    "^": "\\textasciicircum{}",
    "~": "\\textasciitilde{}"
  };
  return value.replace(/[\\{}$&%#_^~]/gu, (character) => replacements[character]);
}

function renderStruckSource(value: string): string {
  let result = "";
  let word = "";
  const flushWord = (): void => {
    if (word) {
      result += `\\CircleTeXStrikeUnit{${word}}`;
      word = "";
    }
  };
  for (const character of value) {
    if (/[A-Za-z0-9]/u.test(character)) {
      word += character;
      continue;
    }
    flushWord();
    if (/\s/u.test(character)) {
      result += character;
    } else {
      result += `\\CircleTeXStrikeUnit{${character}}\\allowbreak{}`;
    }
  }
  flushWord();
  return result;
}

export function validateNoOverlappingManualEdits(edits: readonly PendingManualEdit[]): void {
  const identifiers = new Set<string>();
  for (const edit of edits) {
    validatePendingEditShape(edit);
    if (identifiers.has(edit.id)) {
      throw new Error(`手动修订标识重复：${edit.id}`);
    }
    identifiers.add(edit.id);
  }
  const ordered = [...edits].sort((left, right) =>
    left.startOffset - right.startOffset || left.endOffset - right.endOffset
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.startOffset < previous.endOffset) {
      throw new Error(`手动修订范围重叠：${previous.id} 与 ${current.id}`);
    }
  }
}

export const assertNoOverlappingManualEdits = validateNoOverlappingManualEdits;

interface DirectManualEditPatch {
  startOffset: number;
  endOffset: number;
  replacement: string;
}

/**
 * 将待处理队列直接写成干净的 LaTeX 正文，不生成或注入 CircleTeX 修订宏。
 *
 * 所有偏移均以 baseText 为基准。插入被转换为零宽补丁；同一边界的多次
 * 插入按 edits 中的先后顺序合并，然后与删除、替换一起按偏移逆序应用。
 */
export function applyDirectManualEdits(
  baseText: string,
  edits: readonly PendingManualEdit[]
): string {
  if (typeof baseText !== "string") {
    throw new Error("手动编辑基线源码无效。");
  }
  if (hasCircleTeXRevisions(baseText)) {
    throw new Error("检测到尚未接受或拒绝的 CircleTeX 修订，不能执行直接编辑。");
  }
  if (edits.length === 0) {
    return baseText;
  }

  validateDirectManualEditBatch(baseText, edits);

  const insertions = new Map<number, string[]>();
  const replacements: DirectManualEditPatch[] = [];
  for (const edit of edits) {
    if (edit.kind === "insertBefore" || edit.kind === "insertAfter") {
      const position = edit.kind === "insertBefore" ? edit.startOffset : edit.endOffset;
      const values = insertions.get(position) ?? [];
      values.push(escapeLatexPlainText(edit.insertedText));
      insertions.set(position, values);
      continue;
    }
    replacements.push({
      startOffset: edit.startOffset,
      endOffset: edit.endOffset,
      replacement: edit.kind === "replace" ? escapeLatexPlainText(edit.insertedText) : ""
    });
  }

  const patches: DirectManualEditPatch[] = [
    ...replacements,
    ...[...insertions.entries()].map(([position, values]) => ({
      startOffset: position,
      endOffset: position,
      replacement: values.join("")
    }))
  ].sort((left, right) =>
    right.startOffset - left.startOffset ||
    right.endOffset - left.endOffset
  );

  let result = baseText;
  for (const patch of patches) {
    result = result.slice(0, patch.startOffset) + patch.replacement + result.slice(patch.endOffset);
  }
  return result;
}

/**
 * 所有偏移均以 baseText 为基准；逆序写入可避免前一项改变后一项的偏移。
 */
export function applyManualEdits(baseText: string, edits: readonly PendingManualEdit[]): string {
  if (typeof baseText !== "string") {
    throw new Error("手动修订基线源码无效。");
  }
  if (edits.length === 0) {
    return baseText;
  }
  validateNoOverlappingManualEdits(edits);
  const documentHash = hashDocument(baseText);
  for (const edit of edits) {
    if (edit.baseDocumentHash !== documentHash) {
      throw new Error(`手动修订 ${edit.id} 的基线源码校验失败。`);
    }
    if (edit.endOffset > baseText.length) {
      throw new Error(`手动修订 ${edit.id} 的源码范围越界。`);
    }
    if (baseText.slice(edit.startOffset, edit.endOffset) !== edit.sourceText) {
      throw new Error(`手动修订 ${edit.id} 的目标源码已发生变化。`);
    }
    if (edit.startOffset === edit.endOffset) {
      validateOrdinaryInsertionPoint(baseText, edit.startOffset);
    } else {
      validateOrdinarySourceFragment(baseText, edit.startOffset, edit.sourceText);
    }
    validateInsertedTextForKind(edit.kind, edit.insertedText);
  }

  const ordered = edits.map((edit, queueIndex) => ({ edit, queueIndex })).sort((left, right) => {
    const leftPosition = left.edit.kind === "insertAfter"
      ? left.edit.endOffset
      : left.edit.startOffset;
    const rightPosition = right.edit.kind === "insertAfter"
      ? right.edit.endOffset
      : right.edit.startOffset;
    return rightPosition - leftPosition ||
      right.edit.endOffset - left.edit.endOffset ||
      right.queueIndex - left.queueIndex;
  }).map(({ edit }) => edit);
  let result = baseText;
  for (const edit of ordered) {
    const selected = baseText.slice(edit.startOffset, edit.endOffset);
    const added = edit.insertedText.length > 0
      ? `${ADDED_COMMAND}{${escapeLatexPlainText(edit.insertedText)}}`
      : "";
    let replacement: string;
    switch (edit.kind) {
      case "insertBefore":
        replacement = `${added}${selected}`;
        break;
      case "insertAfter":
        replacement = `${selected}${added}`;
        break;
      case "delete":
        replacement = `${DELETED_COMMAND}{${selected}}{${renderStruckSource(selected)}}`;
        break;
      case "replace":
        replacement = `${DELETED_COMMAND}{${selected}}{${renderStruckSource(selected)}}${added}`;
        break;
    }
    result = result.slice(0, edit.startOffset) + replacement + result.slice(edit.endOffset);
  }
  return injectCircleTeXRevisionPreamble(result);
}

export function injectCircleTeXRevisionPreamble(source: string): string {
  const existing = locateRevisionBlock(source);
  if (existing) {
    validateExistingRevisionBlock(source, existing);
    return source;
  }
  const documentStart = findDocumentStart(source);
  if (documentStart < 0) {
    throw new Error("未找到有效的 \\begin{document}，无法注入 CircleTeX 修订宏。");
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const block = [
    CIRCLETEX_REVISION_BLOCK_BEGIN,
    "\\makeatletter",
    "\\@ifpackageloaded{xcolor}{}{\\RequirePackage{xcolor}}",
    "\\makeatother",
    "\\providecommand{\\CircleTeXAdded}[1]{{\\color{red}#1}}",
    "\\providecommand{\\CircleTeXStrikeUnit}[1]{\\begingroup\\setbox0=\\hbox{#1}\\leavevmode\\rlap{\\raisebox{.45ex}[0pt][0pt]{\\rule{\\wd0}{.45pt}}}\\box0\\endgroup}",
    "\\providecommand{\\CircleTeXDeleted}[2]{{\\color{red}#2}}",
    CIRCLETEX_REVISION_BLOCK_END,
    ""
  ].join(eol);
  return source.slice(0, documentStart) + block + source.slice(documentStart);
}

export function hasCircleTeXRevisions(source: string): boolean {
  const block = locateRevisionBlock(source);
  if (!block) {
    return false;
  }
  validateExistingRevisionBlock(source, block);
  return transformRevisionCalls(source, "detect").count > 0;
}

export function acceptAllCircleTeXRevisions(
  source: string,
  options: ResolveCircleTeXRevisionsOptions = {}
): string {
  return resolveAllCircleTeXRevisions(source, "accept", options);
}

export function rejectAllCircleTeXRevisions(
  source: string,
  options: ResolveCircleTeXRevisionsOptions = {}
): string {
  return resolveAllCircleTeXRevisions(source, "reject", options);
}

export function removeCircleTeXRevisionPreamble(source: string): string {
  const block = locateRevisionBlock(source);
  if (!block) {
    return source;
  }
  validateExistingRevisionBlock(source, block);
  let end = block.end;
  if (source.startsWith("\r\n", end)) {
    end += 2;
  } else if (source[end] === "\n" || source[end] === "\r") {
    end += 1;
  }
  return source.slice(0, block.start) + source.slice(end);
}

export function hashDocument(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function validateDirectManualEditBatch(
  baseText: string,
  edits: readonly PendingManualEdit[]
): void {
  const identifiers = new Set<string>();
  const documentHash = hashDocument(baseText);
  const destructiveRanges: Array<{ startOffset: number; endOffset: number; id: string }> = [];

  for (const edit of edits) {
    validatePendingEditShape(edit);
    if (identifiers.has(edit.id)) {
      throw new Error(`手动编辑标识重复：${edit.id}`);
    }
    identifiers.add(edit.id);
    if (edit.baseDocumentHash !== documentHash) {
      throw new Error(`手动编辑 ${edit.id} 的基线源码校验失败。`);
    }
    if (edit.endOffset > baseText.length) {
      throw new Error(`手动编辑 ${edit.id} 的源码范围越界。`);
    }
    if (baseText.slice(edit.startOffset, edit.endOffset) !== edit.sourceText) {
      throw new Error(`手动编辑 ${edit.id} 的目标源码已发生变化。`);
    }
    if (edit.startOffset === edit.endOffset) {
      validateOrdinaryInsertionPoint(baseText, edit.startOffset);
    } else {
      validateOrdinarySourceFragment(baseText, edit.startOffset, edit.sourceText);
    }
    validateInsertedTextForKind(edit.kind, edit.insertedText);
    if (edit.kind === "delete" || edit.kind === "replace") {
      destructiveRanges.push({
        startOffset: edit.startOffset,
        endOffset: edit.endOffset,
        id: edit.id
      });
    }
  }

  destructiveRanges.sort((left, right) =>
    left.startOffset - right.startOffset || left.endOffset - right.endOffset
  );
  for (let index = 1; index < destructiveRanges.length; index += 1) {
    const previous = destructiveRanges[index - 1];
    const current = destructiveRanges[index];
    if (current.startOffset < previous.endOffset) {
      throw new Error(`手动编辑范围重叠：${previous.id} 与 ${current.id}`);
    }
  }

  for (const edit of edits) {
    if (edit.kind !== "insertBefore" && edit.kind !== "insertAfter") {
      continue;
    }
    const position = edit.kind === "insertBefore" ? edit.startOffset : edit.endOffset;
    const containingRange = destructiveRanges.find((range) =>
      position > range.startOffset && position < range.endOffset
    );
    if (containingRange) {
      throw new Error(`手动编辑插入点 ${edit.id} 位于删除或替换范围 ${containingRange.id} 内部。`);
    }
  }
}

function resolveAllCircleTeXRevisions(
  source: string,
  mode: "accept" | "reject",
  options: ResolveCircleTeXRevisionsOptions
): string {
  const transformed = transformRevisionCalls(source, mode).text;
  if (options.removePreamble === false) {
    return transformed;
  }
  if (hasCircleTeXRevisions(transformed)) {
    throw new Error("CircleTeX 修订未能完整解析，已拒绝移除宏定义块。");
  }
  return removeCircleTeXRevisionPreamble(transformed);
}

function validateInsertedTextForKind(kind: ManualEditKind, insertedText: string): void {
  if (typeof insertedText !== "string") {
    throw new Error("手动修订的新增文字无效。");
  }
  if (kind === "delete") {
    if (insertedText.length !== 0) {
      throw new Error("删除修订不能同时包含新增文字。");
    }
    return;
  }
  validatePlainText(insertedText);
}

function validatePlainText(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new Error("新增或替换文字不能为空。");
  }
  if (value.length > 20_000) {
    throw new Error("新增或替换文字不能超过 20000 个字符。");
  }
  if (UNSAFE_TEXT_CONTROLS.test(value)) {
    throw new Error("新增或替换文字包含不安全的控制字符。");
  }
}

function validatePendingEditShape(edit: PendingManualEdit): void {
  if (!edit || typeof edit !== "object" || !isManualEditKind(edit.kind)) {
    throw new Error("手动修订数据无效。");
  }
  if (typeof edit.id !== "string" || edit.id.trim().length === 0) {
    throw new Error("手动修订标识无效。");
  }
  if (
    !Number.isInteger(edit.startOffset) || !Number.isInteger(edit.endOffset) ||
    edit.startOffset < 0 || edit.endOffset < edit.startOffset ||
    (edit.endOffset === edit.startOffset && edit.kind !== "insertBefore" && edit.kind !== "insertAfter")
  ) {
    throw new Error(`手动修订 ${edit.id} 的源码范围无效。`);
  }
  if (typeof edit.sourceText !== "string" || edit.sourceText.length !== edit.endOffset - edit.startOffset) {
    throw new Error(`手动修订 ${edit.id} 的源码文字与范围不一致。`);
  }
  if (!Number.isInteger(edit.page) || edit.page < 1) {
    throw new Error(`手动修订 ${edit.id} 的页码无效。`);
  }
  validateManualEditRects(edit.rects);
  if (!/^[a-f0-9]{64}$/u.test(edit.baseDocumentHash)) {
    throw new Error(`手动修订 ${edit.id} 的基线哈希无效。`);
  }
}

function validateOrdinaryInsertionPoint(source: string, offset: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    throw new Error("手动编辑插入点超出源码范围。");
  }
  if (
    !isGraphemeBoundary(source, offset) ||
    !isEditableLatexBoundary(source, offset) ||
    isInsideControlSequence(source, offset) ||
    source[offset - 1] === "\\"
  ) {
    throw new Error("手动编辑插入点位于 LaTeX 命令、注释、数学环境或字符内部。");
  }
}

function validateOrdinarySourceFragment(windowText: string, localStart: number, fragment: string): void {
  if (fragment.length === 0 || collapseVisibleText(fragment).text.length === 0) {
    throw new Error("手动修订目标不包含普通正文。");
  }
  const withoutLayout = fragment.replace(TRANSPARENT_LAYOUT_COMMAND_RE, "");
  if (SOURCE_FORBIDDEN.test(withoutLayout) || UNSAFE_TEXT_CONTROLS.test(fragment)) {
    throw new Error("手动修订目标包含 LaTeX 命令、数学或对齐控制字符。");
  }
  if (
    !isGraphemeBoundary(windowText, localStart) ||
    !isGraphemeBoundary(windowText, localStart + fragment.length)
  ) {
    throw new Error("手动修订目标截断了 Unicode 字素簇。");
  }
  if (
    isInsideControlSequence(windowText, localStart) ||
    !isEditableLatexTextRange(windowText, localStart, localStart + fragment.length) &&
    !(withoutLayout !== fragment && isLayoutOnlyEditableFragment(withoutLayout))
  ) {
    throw new Error("手动修订目标位于 LaTeX 命令、注释或数学环境中。");
  }
}

function isLayoutOnlyEditableFragment(value: string): boolean {
  return value.length > 0 && !SOURCE_FORBIDDEN.test(value) && !UNSAFE_TEXT_CONTROLS.test(value);
}

function isInsideControlSequence(source: string, start: number): boolean {
  let index = start;
  while (index > 0 && /[A-Za-z@]/u.test(source[index - 1])) {
    index -= 1;
  }
  return index > 0 && source[index - 1] === "\\";
}

interface CollapsedText {
  text: string;
  graphemes: string[];
  starts: number[];
  ends: number[];
}

function collapseVisibleText(value: string): CollapsedText {
  let text = "";
  const graphemes: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const sourceSegment of GRAPHEME_SEGMENTER.segment(value)) {
    const start = sourceSegment.index;
    const end = start + sourceSegment.segment.length;
    const normalized = sourceSegment.segment.normalize("NFKC").replace(/\s/gu, "");
    for (const normalizedSegment of GRAPHEME_SEGMENTER.segment(normalized)) {
      const grapheme = normalizedSegment.segment;
      if (grapheme.length > 0) {
        text += grapheme;
        graphemes.push(grapheme);
        starts.push(start);
        ends.push(end);
      }
    }
  }
  return { text, graphemes, starts, ends };
}

/**
 * 返回手动编辑可见偏移所使用的规范化字素序列。
 * 前端应对光标前的可见文字调用同一算法，并以返回数组长度作为 caretVisibleOffset。
 */
export function normalizeManualEditVisibleGraphemes(value: string): string[] {
  if (typeof value !== "string") {
    throw new Error("可见文字必须是字符串。");
  }
  return [...collapseVisibleText(value).graphemes];
}

function isGraphemeBoundary(value: string, offset: number): boolean {
  if (offset === 0 || offset === value.length) {
    return true;
  }
  for (const segment of GRAPHEME_SEGMENTER.segment(value)) {
    if (segment.index === offset) {
      return true;
    }
    if (segment.index > offset) {
      return false;
    }
  }
  return false;
}

interface RevisionBlockRange {
  start: number;
  end: number;
}

function locateRevisionBlock(source: string): RevisionBlockRange | undefined {
  const begins = allIndexesOf(source, CIRCLETEX_REVISION_BLOCK_BEGIN);
  const ends = allIndexesOf(source, CIRCLETEX_REVISION_BLOCK_END);
  if (begins.length === 0 && ends.length === 0) {
    return undefined;
  }
  if (begins.length !== 1 || ends.length !== 1 || begins[0] >= ends[0]) {
    throw new Error("CircleTeX 修订宏标记不完整或重复，已拒绝处理。");
  }
  const start = begins[0];
  const end = ends[0] + CIRCLETEX_REVISION_BLOCK_END.length;
  const beforeLine = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
  const nextNewline = source.indexOf("\n", end);
  const afterLine = source.slice(end, nextNewline < 0 ? source.length : nextNewline).replace(/\r$/u, "");
  if (beforeLine.trim().length > 0 || afterLine.trim().length > 0) {
    throw new Error("CircleTeX 修订宏标记必须独占一行。");
  }
  return { start, end };
}

function validateExistingRevisionBlock(source: string, block: RevisionBlockRange): void {
  const content = source.slice(block.start, block.end);
  if (
    !containsActiveCommandSignature(content, "\\providecommand{\\CircleTeXAdded}[1]") ||
    !containsActiveCommandSignature(content, "\\providecommand{\\CircleTeXStrikeUnit}[1]") ||
    !containsActiveCommandSignature(content, "\\providecommand{\\CircleTeXDeleted}[2]")
  ) {
    throw new Error("CircleTeX 修订宏定义块不完整，已拒绝覆盖。");
  }
  const documentStart = findDocumentStart(source);
  if (documentStart >= 0 && block.start > documentStart) {
    throw new Error("CircleTeX 修订宏定义块不在导言区，已拒绝处理。");
  }
}

function containsActiveCommandSignature(source: string, signature: string): boolean {
  for (let index = 0; index < source.length;) {
    if (source[index] === "%") {
      index = skipComment(source, index);
      continue;
    }
    if (source[index] !== "\\") {
      index += 1;
      continue;
    }
    if (source.startsWith("\\verb", index) && !/[A-Za-z@]/u.test(source[index + 5] ?? "")) {
      index = skipVerb(source, index);
      continue;
    }
    if (source.startsWith(signature, index)) {
      return true;
    }
    index = skipTexCommand(source, index);
  }
  return false;
}

function allIndexesOf(source: string, target: string): number[] {
  const indexes: number[] = [];
  let from = 0;
  while (from <= source.length - target.length) {
    const index = source.indexOf(target, from);
    if (index < 0) {
      break;
    }
    indexes.push(index);
    from = index + target.length;
  }
  return indexes;
}

function findDocumentStart(source: string): number {
  let braceDepth = 0;
  for (let index = 0; index < source.length;) {
    if (source[index] === "%") {
      index = skipComment(source, index);
      continue;
    }
    if (source[index] === "{") {
      braceDepth += 1;
      index += 1;
      continue;
    }
    if (source[index] === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) {
        return -1;
      }
      index += 1;
      continue;
    }
    if (source[index] !== "\\") {
      index += 1;
      continue;
    }
    if (source.startsWith("\\verb", index) && !/[A-Za-z@]/u.test(source[index + 5] ?? "")) {
      index = skipVerb(source, index);
      continue;
    }
    if (
      braceDepth === 0 &&
      source.startsWith("\\begin", index) &&
      !/[A-Za-z@]/u.test(source[index + 6] ?? "")
    ) {
      const groupStart = skipWhitespace(source, index + 6);
      if (source[groupStart] === "{") {
        const group = parseBalancedGroup(source, groupStart);
        if (group.content.trim() === "document") {
          return index;
        }
        index = group.end;
        continue;
      }
    }
    index = skipTexCommand(source, index);
  }
  return -1;
}

type RevisionTransformMode = "detect" | "accept" | "reject";

function transformRevisionCalls(
  source: string,
  mode: RevisionTransformMode
): { text: string; count: number } {
  let text = "";
  let count = 0;
  for (let index = 0; index < source.length;) {
    if (source[index] === "%") {
      const end = skipComment(source, index);
      text += source.slice(index, end);
      index = end;
      continue;
    }
    if (source[index] !== "\\") {
      text += source[index];
      index += 1;
      continue;
    }
    if (source.startsWith("\\verb", index) && !/[A-Za-z@]/u.test(source[index + 5] ?? "")) {
      const end = skipVerb(source, index);
      text += source.slice(index, end);
      index = end;
      continue;
    }
    const command = source.startsWith(ADDED_COMMAND, index)
      ? ADDED_COMMAND
      : source.startsWith(DELETED_COMMAND, index)
        ? DELETED_COMMAND
        : undefined;
    if (command && !/[A-Za-z@]/u.test(source[index + command.length] ?? "")) {
      const groupStart = skipWhitespace(source, index + command.length);
      if (source[groupStart] === "{") {
        const group = parseBalancedGroup(source, groupStart);
        let callEnd = group.end;
        if (command === DELETED_COMMAND) {
          const renderedStart = skipWhitespace(source, group.end);
          if (source[renderedStart] !== "{") {
            throw new Error("CircleTeX 删除修订缺少中划线显示参数。");
          }
          callEnd = parseBalancedGroup(source, renderedStart).end;
        }
        count += 1;
        if (mode === "detect") {
          text += source.slice(index, callEnd);
        } else {
          const keep = (mode === "accept" && command === ADDED_COMMAND) ||
            (mode === "reject" && command === DELETED_COMMAND);
          if (keep) {
            const nested = transformRevisionCalls(group.content, mode);
            text += nested.text;
            count += nested.count;
          }
        }
        index = callEnd;
        continue;
      }
    }
    const end = skipEscapedOrCommandPrefix(source, index);
    text += source.slice(index, end);
    index = end;
  }
  return { text, count };
}

function parseBalancedGroup(source: string, start: number): { content: string; end: number } {
  if (source[start] !== "{") {
    throw new Error("CircleTeX 修订参数缺少左花括号。");
  }
  let depth = 1;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      if (source.startsWith("\\verb", index) && !/[A-Za-z@]/u.test(source[index + 5] ?? "")) {
        index = skipVerb(source, index) - 1;
        continue;
      }
      index = Math.min(index + 1, source.length - 1);
      continue;
    }
    if (source[index] === "%") {
      index = skipComment(source, index) - 1;
      continue;
    }
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return { content: source.slice(start + 1, index), end: index + 1 };
      }
    }
  }
  throw new Error("CircleTeX 修订参数的花括号不平衡，已拒绝处理。");
}

function skipComment(source: string, start: number): number {
  const newline = source.indexOf("\n", start);
  return newline < 0 ? source.length : newline + 1;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/u.test(source[index])) {
    index += 1;
  }
  return index;
}

function skipVerb(source: string, start: number): number {
  let index = start + "\\verb".length;
  if (source[index] === "*") {
    index += 1;
  }
  const delimiter = source[index];
  if (!delimiter || /\s/u.test(delimiter)) {
    return skipTexCommand(source, start);
  }
  const end = source.indexOf(delimiter, index + 1);
  return end < 0 ? source.length : end + 1;
}

function skipTexCommand(source: string, start: number): number {
  if (source[start] !== "\\") {
    return start + 1;
  }
  let index = start + 1;
  if (/[A-Za-z@]/u.test(source[index] ?? "")) {
    while (/[A-Za-z@]/u.test(source[index] ?? "")) {
      index += 1;
    }
    return index;
  }
  return Math.min(source.length, index + 1);
}

function skipEscapedOrCommandPrefix(source: string, start: number): number {
  return skipTexCommand(source, start);
}

function isManualEditKind(value: unknown): value is ManualEditKind {
  return value === "insertBefore" || value === "insertAfter" || value === "delete" || value === "replace";
}
