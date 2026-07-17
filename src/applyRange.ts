import { createHash } from "node:crypto";

export interface RevisionSnapshot {
  baseText: string;
  documentHash: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  sourceText: string;
}

export interface ResolvedApplyRange {
  startOffset: number;
  endOffset: number;
  mode: "exact" | "eol-normalized" | "relocated";
}

export function resolveApplyRange(snapshot: RevisionSnapshot, currentText: string): ResolvedApplyRange {
  if (
    !Number.isInteger(snapshot.startOffset) ||
    !Number.isInteger(snapshot.endOffset) ||
    !Number.isInteger(snapshot.startLine) ||
    snapshot.startOffset < 0 ||
    snapshot.endOffset < snapshot.startOffset ||
    snapshot.endOffset > snapshot.baseText.length ||
    snapshot.startLine < 1 ||
    !snapshot.sourceText
  ) {
    throw new Error("候选修订的原始范围无效，请重新生成建议。");
  }

  if (sha256(snapshot.baseText) !== snapshot.documentHash) {
    throw new Error("候选修订的基线源码校验失败，请重新生成建议。");
  }
  if (
    isInsideCrLf(snapshot.baseText, snapshot.startOffset) ||
    isInsideCrLf(snapshot.baseText, snapshot.endOffset)
  ) {
    throw new Error("候选修订的范围落在换行符中间，请重新生成建议。");
  }
  if (snapshot.baseText.slice(snapshot.startOffset, snapshot.endOffset) !== snapshot.sourceText) {
    throw new Error("候选修订与基线源码范围不一致，请重新生成建议。");
  }

  if (
    sha256(currentText) === snapshot.documentHash &&
    currentText.slice(snapshot.startOffset, snapshot.endOffset) === snapshot.sourceText
  ) {
    return {
      startOffset: snapshot.startOffset,
      endOffset: snapshot.endOffset,
      mode: "exact"
    };
  }

  const base = normalizeLineEndings(snapshot.baseText);
  const current = normalizeWithOffsetMap(currentText);
  const target = normalizeLineEndings(snapshot.sourceText);
  if (!target) {
    throw new Error("候选修订的目标源码为空，请重新生成建议。");
  }

  const normalizedStart = normalizeLineEndings(snapshot.baseText.slice(0, snapshot.startOffset)).length;
  const normalizedEnd = normalizedStart + target.length;
  if (base.slice(normalizedStart, normalizedEnd) !== target) {
    throw new Error("候选修订的规范化范围无效，请重新生成建议。");
  }

  if (base === current.text) {
    return mapNormalizedRange(current.offsets, normalizedStart, target.length, "eol-normalized");
  }

  if (hasMultipleOccurrences(base, target) || hasMultipleOccurrences(current.text, target)) {
    throw new Error("目标源码存在重复片段，文档变化后无法安全辨认原范围，请重新生成建议。");
  }

  const prefixLength = commonPrefixLength(base, current.text);
  const candidates: number[] = [];
  if (normalizedEnd <= prefixLength) {
    candidates.push(normalizedStart);
  }
  const suffixLength = commonSuffixLength(base, current.text);
  if (normalizedStart >= base.length - suffixLength) {
    candidates.push(current.text.length - (base.length - normalizedStart));
  }
  const distinctCandidates = [...new Set(candidates)].filter((candidate) =>
    candidate >= 0 && current.text.slice(candidate, candidate + target.length) === target
  );
  if (distinctCandidates.length > 1) {
    throw new Error("文档变化后出现多个可能的目标源码位置，无法安全辨认原范围，请重新生成建议。");
  }
  if (distinctCandidates.length === 1) {
    return verifiedRelocatedRange(current, distinctCandidates[0], target);
  }
  throw new Error("目标源码或其两侧上下文在建议生成后发生了变化，无法安全跟踪原范围，请重新生成建议。");
}

export function normalizeLineEndings(value: string, eol = "\n"): string {
  return value.replace(/\r\n|\r|\n/g, eol);
}

export function hashNormalizedText(value: string): string {
  return sha256(normalizeLineEndings(value));
}

export function hasSameNormalizedText(left: string, right: string): boolean {
  return hashNormalizedText(left) === hashNormalizedText(right);
}

function normalizeWithOffsetMap(value: string): { text: string; offsets: number[] } {
  let text = "";
  const offsets = [0];
  let index = 0;
  while (index < value.length) {
    if (value.charCodeAt(index) === 13) {
      index += value.charCodeAt(index + 1) === 10 ? 2 : 1;
      text += "\n";
      offsets.push(index);
      continue;
    }
    text += value[index];
    index += 1;
    offsets.push(index);
  }
  return { text, offsets };
}

function commonPrefixLength(left: string, right: string): number {
  const maximum = Math.min(left.length, right.length);
  let index = 0;
  while (index < maximum && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(left: string, right: string): number {
  const maximum = Math.min(left.length, right.length);
  let length = 0;
  while (
    length < maximum &&
    left[left.length - 1 - length] === right[right.length - 1 - length]
  ) {
    length += 1;
  }
  return length;
}

function hasMultipleOccurrences(value: string, target: string): boolean {
  const first = value.indexOf(target);
  return first >= 0 && value.indexOf(target, first + 1) >= 0;
}

function isInsideCrLf(value: string, offset: number): boolean {
  return offset > 0 && offset < value.length && value[offset - 1] === "\r" && value[offset] === "\n";
}

function verifiedRelocatedRange(
  current: { text: string; offsets: number[] },
  normalizedStart: number,
  target: string
): ResolvedApplyRange {
  if (normalizedStart < 0 || current.text.slice(normalizedStart, normalizedStart + target.length) !== target) {
    throw new Error("目标源码内容在建议生成后发生了变化，已拒绝应用过期修改。");
  }
  return mapNormalizedRange(current.offsets, normalizedStart, target.length, "relocated");
}

function mapNormalizedRange(
  offsets: number[],
  normalizedStart: number,
  length: number,
  mode: ResolvedApplyRange["mode"]
): ResolvedApplyRange {
  const startOffset = offsets[normalizedStart];
  const endOffset = offsets[normalizedStart + length];
  if (startOffset === undefined || endOffset === undefined) {
    throw new Error("候选修订无法映射到当前文档位置，请重新生成建议。");
  }
  return { startOffset, endOffset, mode };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
