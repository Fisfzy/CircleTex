import { projectLatexSource } from "./latexProjection";
import { SourceMapping } from "./types";

export interface RegionEditSourceRange {
  startOffset: number;
  endOffset: number;
  sourceText: string;
}

export class RegionEditAmbiguityError extends Error {
  public constructor(public readonly candidates: readonly RegionEditSourceRange[]) {
    super("区域文字在映射源码中存在多个连续候选，无法确定唯一修改位置。");
    this.name = "RegionEditAmbiguityError";
  }
}

export class RegionEditDiscontinuousError extends Error {
  public constructor() {
    super("区域框选对应多个离散源码片段，不能安全地作为一个范围修改。请缩小或调整框选范围。");
    this.name = "RegionEditDiscontinuousError";
  }
}

export class RegionEditUnsafeStructureError extends Error {
  public constructor() {
    super("区域框选跨越公式、引用、未知命令或不完整的 LaTeX 格式结构，已拒绝修改。");
    this.name = "RegionEditUnsafeStructureError";
  }
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter("und", { granularity: "grapheme" });
const TRANSPARENT_COMMANDS = new Set([
  "textbf", "textit", "textsl", "textsc", "textrm", "textsf", "texttt",
  "emph", "underline", "uline", "sout", "mbox", "hbox",
  "MakeUppercase", "MakeLowercase"
]);

export function resolveRegionEditSourceRange(mapping: SourceMapping): RegionEditSourceRange {
  const candidates = regionEditSourceRangeCandidates(mapping);
  if (candidates.length > 1) {
    throw new RegionEditAmbiguityError(candidates);
  }
  return candidates[0];
}

export function validateResolvedRegionEditRange(
  mapping: SourceMapping,
  resolved: RegionEditSourceRange
): RegionEditSourceRange {
  const candidates = regionEditSourceRangeCandidates(mapping);
  const matched = candidates.find((candidate) =>
    candidate.startOffset === resolved.startOffset &&
    candidate.endOffset === resolved.endOffset &&
    candidate.sourceText === resolved.sourceText
  );
  if (!matched) {
    throw new Error("区域编辑消歧返回的源码范围无效。");
  }
  return matched;
}

export function regionEditSourceRangeCandidates(mapping: SourceMapping): RegionEditSourceRange[] {
  if (mapping.selection.kind !== "region") {
    throw new Error("只有区域框选可以使用区域源码解析器。");
  }
  if (mapping.selection.fragments.length === 0) {
    throw new Error("区域框选不包含可定位的文字片段。");
  }
  const wanted = mapping.selection.fragments.flatMap((fragment) => normalizedGraphemes(fragment.text));
  if (wanted.length === 0) {
    throw new Error("区域框选不包含可定位的普通正文。");
  }
  const projection = projectLatexSource(mapping.sourceText);
  const sequenceStarts = tokenSequenceStarts(projection.tokens, wanted);
  if (sequenceStarts.length === 0) {
    const everyFragmentExists = mapping.selection.fragments.every((fragment) =>
      tokenSequenceStarts(projection.tokens, normalizedGraphemes(fragment.text)).length > 0
    );
    if (everyFragmentExists) {
      throw new RegionEditDiscontinuousError();
    }
    throw new RegionEditUnsafeStructureError();
  }

  const candidates: RegionEditSourceRange[] = [];
  let unsafeMatch = false;
  for (const tokenStart of sequenceStarts) {
    const first = projection.tokens[tokenStart];
    const last = projection.tokens[tokenStart + wanted.length - 1];
    if (!isSafeTransparentRange(mapping.sourceText, first.start, last.end, projection.tokens)) {
      unsafeMatch = true;
      continue;
    }
    candidates.push({
      startOffset: mapping.startOffset + first.start,
      endOffset: mapping.startOffset + last.end,
      sourceText: mapping.sourceText.slice(first.start, last.end)
    });
  }
  if (candidates.length === 0) {
    if (unsafeMatch) throw new RegionEditUnsafeStructureError();
    throw new RegionEditDiscontinuousError();
  }
  return deduplicateRanges(candidates);
}

function isSafeTransparentRange(
  source: string,
  start: number,
  end: number,
  tokens: ReturnType<typeof projectLatexSource>["tokens"]
): boolean {
  const coveredTokens = tokens.filter((token) => token.start >= start && token.end <= end);
  const tokenSpans = [...new Map(coveredTokens.map((token) => [`${token.start}:${token.end}`, token])).values()];
  let structural = source.slice(start, end);
  for (const token of tokenSpans.sort((left, right) => right.start - left.start || right.end - left.end)) {
    const localStart = token.start - start;
    structural = `${structural.slice(0, localStart)}${" ".repeat(token.end - token.start)}${structural.slice(token.end - start)}`;
  }
  structural = structural.replace(/\s/gu, "");
  let index = 0;
  let depth = 0;
  while (index < structural.length) {
    if (structural[index] === "}") {
      if (depth === 0) return false;
      depth -= 1;
      index += 1;
      continue;
    }
    if (structural[index] !== "\\") return false;
    const match = /^\\([A-Za-z@]+\*?)\{/u.exec(structural.slice(index));
    if (!match || !TRANSPARENT_COMMANDS.has(match[1].replace(/\*$/u, ""))) return false;
    depth += 1;
    index += match[0].length;
  }
  return depth === 0;
}

function tokenSequenceStarts(
  tokens: ReturnType<typeof projectLatexSource>["tokens"],
  wanted: readonly string[]
): number[] {
  if (wanted.length === 0) return [];
  const starts: number[] = [];
  for (let index = 0; index <= tokens.length - wanted.length; index += 1) {
    if (wanted.every((value, offset) => tokens[index + offset].value === value)) starts.push(index);
  }
  return starts;
}

function normalizedGraphemes(value: string): string[] {
  const result: string[] = [];
  for (const sourceSegment of GRAPHEME_SEGMENTER.segment(value)) {
    const normalized = sourceSegment.segment.normalize("NFKC").replace(/\s/gu, "");
    for (const segment of GRAPHEME_SEGMENTER.segment(normalized)) {
      if (segment.segment) result.push(segment.segment);
    }
  }
  return result;
}

function deduplicateRanges(ranges: readonly RegionEditSourceRange[]): RegionEditSourceRange[] {
  const seen = new Set<string>();
  return ranges.filter((range) => {
    const key = `${range.startOffset}:${range.endOffset}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
