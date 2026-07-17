import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashDocument } from "../manualEdits";
import {
  RegionEditAmbiguityError,
  RegionEditDiscontinuousError,
  RegionEditUnsafeStructureError,
  resolveRegionEditSourceRange
} from "../regionEditResolver";
import { RegionTextFragment, SourceMapping } from "../types";

function fragment(text: string, lineIndex: number): RegionTextFragment {
  const y = 20 + lineIndex * 12;
  return {
    text,
    start: { x: 10, y },
    end: { x: 30, y },
    rects: [{ x: 9, y: y - 2, width: 22, height: 4 }],
    lineIndex
  };
}

function mapping(sourceText: string, texts: string[]): SourceMapping {
  const startOffset = 100;
  const base = `${"甲".repeat(startOffset)}${sourceText}`;
  const fragments = texts.map(fragment);
  return {
    id: "region-mapping",
    sourcePath: "main.tex",
    startLine: 1,
    endLine: 8,
    startOffset,
    endOffset: startOffset + sourceText.length,
    sourceText,
    contextText: sourceText,
    contextStartLine: 1,
    documentHash: hashDocument(base),
    normalizedDocumentHash: hashDocument(base),
    selection: {
      kind: "region",
      text: texts.join("\n"),
      page: 1,
      start: fragments[0].start,
      end: fragments.at(-1)!.end,
      bounds: { x: 5, y: 10, width: 40, height: 60 },
      anchors: fragments.map((item) => item.start),
      fragments
    }
  };
}

describe("区域框选到连续 LaTeX 正文范围", () => {
  it("解析单行和跨行连续正文", () => {
    const single = resolveRegionEditSourceRange(mapping("前文目标段落后文", ["目标段落"]));
    assert.equal(single.sourceText, "目标段落");

    const source = "第一行正文，\n第二行正文结束。";
    const multiple = resolveRegionEditSourceRange(mapping(source, ["第一行正文，", "第二行正文"]));
    assert.equal(multiple.sourceText, "第一行正文，\n第二行正文");
  });

  it("允许安全格式命令参数中的正文", () => {
    const source = "前文\\textbf{加粗正文}后文";
    const range = resolveRegionEditSourceRange(mapping(source, ["加粗正文"]));
    assert.equal(range.sourceText, "加粗正文");
  });

  it("允许附录目录中的纯排版命令跨行包围普通正文", () => {
    const source = "\\hspace*{2em}第一项\\par\n\\hspace*{2em}第二项";
    const range = resolveRegionEditSourceRange(mapping(source, ["第一项", "第二项"]));
    assert.equal(range.sourceText, "第一项\\par\n\\hspace*{2em}第二项");
  });

  it("拒绝跨公式、引用、未知命令和注释", () => {
    const unsafe = [
      ["公式前甲乙$K_I$丙丁公式后", ["甲乙", "丙丁"]],
      ["引用前甲乙\\cite{key}丙丁引用后", ["甲乙", "丙丁"]],
      ["命令前甲乙\\unknown{值}丙丁命令后", ["甲乙", "丙丁"]],
      ["正文甲乙% 注释\n丙丁正文", ["甲乙", "丙丁"]]
    ] as const;
    for (const [source, texts] of unsafe) {
      assert.throws(
        () => resolveRegionEditSourceRange(mapping(source, [...texts])),
        RegionEditUnsafeStructureError
      );
    }
  });

  it("拒绝视觉片段在源码中离散或顺序倒置", () => {
    assert.throws(
      () => resolveRegionEditSourceRange(mapping("甲乙中间未选内容丙丁", ["甲乙", "丙丁"])),
      RegionEditDiscontinuousError
    );
    assert.throws(
      () => resolveRegionEditSourceRange(mapping("甲乙随后丙丁", ["丙丁", "甲乙"])),
      RegionEditDiscontinuousError
    );
  });

  it("保留重复连续候选供 SyncTeX 空间消歧", () => {
    assert.throws(
      () => resolveRegionEditSourceRange(mapping("目标段落；目标段落。", ["目标段落"])),
      (error: unknown) => error instanceof RegionEditAmbiguityError && error.candidates.length === 2
    );
  });

  it("按 Unicode 字素和 NFKC 规范化匹配", () => {
    const range = resolveRegionEditSourceRange(mapping("前文ＡＢ👩‍🔬后文", ["AB👩‍🔬"]));
    assert.equal(range.sourceText, "ＡＢ👩‍🔬");
  });
});
