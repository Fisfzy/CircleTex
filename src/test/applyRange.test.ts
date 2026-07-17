import { createHash } from "node:crypto";
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasSameNormalizedText, normalizeLineEndings, resolveApplyRange, RevisionSnapshot } from "../applyRange";

function snapshot(baseText: string, target: string, requestedStart?: number): RevisionSnapshot {
  const startOffset = requestedStart ?? baseText.indexOf(target);
  assert.ok(startOffset >= 0);
  return {
    baseText,
    documentHash: createHash("sha256").update(baseText).digest("hex"),
    startOffset,
    endOffset: startOffset + target.length,
    startLine: baseText.slice(0, startOffset).split(/\r\n|\r|\n/).length,
    sourceText: target
  };
}

describe("候选修订目标定位", () => {
  const target = "目标第一行\r\n目标第二行\n";
  const base = `前文\r\n${target}后文\r\n`;

  it("原文未变化时直接使用原始范围", () => {
    const result = resolveApplyRange(snapshot(base, target), base);
    assert.equal(result.mode, "exact");
    assert.equal(base.slice(result.startOffset, result.endOffset), target);
  });

  it("允许目标范围之后发生变化", () => {
    const current = `${base}新增尾注\n`;
    const result = resolveApplyRange(snapshot(base, target), current);
    assert.equal(result.mode, "relocated");
    assert.equal(normalizeLineEndings(current.slice(result.startOffset, result.endOffset)), normalizeLineEndings(target));
  });

  it("目标范围之前插入内容时安全重定位", () => {
    const current = `新增前文\n${base}`;
    const result = resolveApplyRange(snapshot(base, target), current);
    assert.equal(result.mode, "relocated");
    assert.equal(normalizeLineEndings(current.slice(result.startOffset, result.endOffset)), normalizeLineEndings(target));
  });

  it("目标内容变化时拒绝应用", () => {
    const current = base.replace("目标第二行", "已被修改");
    assert.throws(() => resolveApplyRange(snapshot(base, target), current), /无法安全跟踪|目标源码内容/);
  });

  it("目标范围后新增相同文本时拒绝自动辨认", () => {
    const current = `${base}${target}`;
    assert.throws(() => resolveApplyRange(snapshot(base, target), current), /存在重复片段/);
  });

  it("原目标变化而别处保留相同文本时拒绝误替换", () => {
    const current = `${base.replace("目标第二行", "已被修改")}${target}`;
    assert.throws(() => resolveApplyRange(snapshot(base, target), current), /无法安全跟踪|目标源码内容/);
  });

  it("目标前后同时变化时保守拒绝", () => {
    const current = `新前文\n${base}新后文\n`;
    assert.throws(() => resolveApplyRange(snapshot(base, target), current), /无法安全跟踪/);
  });

  it("混合换行被 VS Code 统一后仍能精确定位", () => {
    const current = normalizeLineEndings(base);
    const result = resolveApplyRange(snapshot(base, target), current);
    assert.equal(result.mode, "eol-normalized");
    assert.equal(normalizeLineEndings(current.slice(result.startOffset, result.endOffset)), normalizeLineEndings(target));
  });

  it("换行统一且目标之前插入内容时仍能安全重定位", () => {
    const current = `新增前文\n${normalizeLineEndings(base)}`;
    const result = resolveApplyRange(snapshot(base, target), current);
    assert.equal(result.mode, "relocated");
    assert.equal(normalizeLineEndings(current.slice(result.startOffset, result.endOffset)), normalizeLineEndings(target));
  });

  it("目标之前插入相同片段时拒绝歧义位置", () => {
    const current = `前文\r\n${target}${target}后文\r\n`;
    assert.throws(() => resolveApplyRange(snapshot(base, target), current), /存在重复片段/);
  });

  it("目标前插入相同片段且修改后文时拒绝误选新副本", () => {
    const simpleTarget = "TARGET";
    const simpleBase = `L${simpleTarget}R`;
    const current = `L${simpleTarget}${simpleTarget}X`;
    assert.throws(() => resolveApplyRange(snapshot(simpleBase, simpleTarget), current), /存在重复片段/);
  });

  it("目标后插入相同片段且修改前文时拒绝误选新副本", () => {
    const simpleTarget = "TARGET";
    const simpleBase = `L${simpleTarget}R`;
    const current = `X${simpleTarget}${simpleTarget}R`;
    assert.throws(() => resolveApplyRange(snapshot(simpleBase, simpleTarget), current), /存在重复片段/);
  });

  it("删除连续重复目标中的一个时拒绝误认另一个", () => {
    const repeatedBase = `前文\n${target}${target}后文\n`;
    const firstStart = repeatedBase.indexOf(target);
    const secondStart = repeatedBase.indexOf(target, firstStart + target.length);
    const current = repeatedBase.slice(0, firstStart) + repeatedBase.slice(firstStart + target.length);
    assert.throws(() => resolveApplyRange(snapshot(repeatedBase, target, firstStart), current), /存在重复片段/);
    assert.throws(() => resolveApplyRange(snapshot(repeatedBase, target, secondStart), current), /存在重复片段/);
  });

  it("基线哈希不一致时拒绝候选", () => {
    const invalid = snapshot(base, target);
    invalid.documentHash = "0".repeat(64);
    assert.throws(() => resolveApplyRange(invalid, base), /基线源码校验失败/);
  });

  it("范围边界落在 CRLF 中间时拒绝候选", () => {
    const baseText = "甲\r\n乙";
    const invalid: RevisionSnapshot = {
      baseText,
      documentHash: createHash("sha256").update(baseText).digest("hex"),
      startOffset: 2,
      endOffset: baseText.length,
      startLine: 1,
      sourceText: "\n乙"
    };
    assert.throws(() => resolveApplyRange(invalid, baseText), /换行符中间/);
  });
});

describe("源码同步比较", () => {
  it("将不同换行符视为相同源码", () => {
    assert.equal(hasSameNormalizedText("第一行\r\n第二行\r\n", "第一行\n第二行\n"), true);
  });

  it("保留实际文本变化的检测能力", () => {
    assert.equal(hasSameNormalizedText("第一行\n第二行\n", "第一行\n已修改第二行\n"), false);
  });
});
