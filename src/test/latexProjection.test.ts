import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adjacentEditableLatexRange,
  isEditableLatexBoundary,
  isEditableLatexTextRange,
  projectLatexSource,
  structuredCaretCandidates
} from "../latexProjection";

describe("LaTeX 可见结构投影", () => {
  it("区分普通正文、行内公式、引用和格式命令正文", () => {
    const source = "前文\\textbf{加粗正文}，结果为$K_I$，见\\cite{ref21}后文";
    const projection = projectLatexSource(source);
    assert.equal(projection.tokens.map((token) => token.value).join(""), "前文加粗正文,结果为,见后文");
    assert.ok(projection.opaqueSpans.some((span) => source.slice(span.start, span.end) === "$K_I$"));
    assert.ok(projection.opaqueSpans.some((span) => source.slice(span.start, span.end) === "\\cite{ref21}"));
    const formattedStart = source.indexOf("加粗正文");
    assert.equal(isEditableLatexTextRange(source, formattedStart, formattedStart + "加粗正文".length), true);
    assert.equal(isEditableLatexTextRange(source, source.indexOf("K_I"), source.indexOf("K_I") + 3), false);
  });

  it("只开放公式和引用整体结构前后的边界", () => {
    const source = "前文$K_I$后文\\cite{ref21}结束";
    const formulaStart = source.indexOf("$K_I$");
    const formulaEnd = formulaStart + "$K_I$".length;
    const citationStart = source.indexOf("\\cite");
    const citationEnd = citationStart + "\\cite{ref21}".length;
    assert.equal(isEditableLatexBoundary(source, formulaStart), true);
    assert.equal(isEditableLatexBoundary(source, formulaEnd), true);
    assert.equal(isEditableLatexBoundary(source, formulaStart + 2), false);
    assert.equal(isEditableLatexBoundary(source, citationStart), true);
    assert.equal(isEditableLatexBoundary(source, citationEnd), true);
    assert.equal(isEditableLatexBoundary(source, citationStart + 7), false);
  });

  it("将注释、数学环境、表格、逐字内容和未知宏保持为不透明结构", () => {
    const cases = [
      "正文% 注释中的目标\n后文",
      "正文\\begin{align}a&=b\\end{align}后文",
      "正文\\begin{tabular}{cc}甲&乙\\end{tabular}后文",
      "正文\\verb|目标|后文",
      "正文\\unknown{目标}后文",
      "正文{目标}后文"
    ];
    for (const source of cases) {
      const target = source.indexOf("目标");
      if (target >= 0) assert.equal(isEditableLatexTextRange(source, target, target + 2), false, source);
    }
    const comment = cases[0];
    assert.equal(isEditableLatexBoundary(comment, comment.indexOf("\n")), false);
    assert.equal(isEditableLatexBoundary(comment, comment.indexOf("\n") + 1), true);
  });

  it("在公式和引用前后生成唯一边界，公式内部不生成边界", () => {
    const formulaSource = "结果为$K_I$，随后甲乙丙丁戊己";
    const formulaPdf = "结果为KI，随后甲乙丙丁戊己";
    assert.deepEqual(
      structuredCaretCandidates(formulaSource, formulaPdf, "结果为".length).map((item) => item.offset),
      [formulaSource.indexOf("$K_I$")]
    );
    assert.deepEqual(
      structuredCaretCandidates(formulaSource, formulaPdf, "结果为KI".length).map((item) => item.offset),
      [formulaSource.indexOf("，")]
    );
    assert.deepEqual(structuredCaretCandidates(formulaSource, formulaPdf, "结果为K".length), []);

    const citationSource = "甲乙丙丁\\cite{ref21}戊己庚辛壬癸";
    const citationPdf = "甲乙丙丁[21]戊己庚辛壬癸";
    assert.deepEqual(
      structuredCaretCandidates(citationSource, citationPdf, "甲乙丙丁[21]".length).map((item) => item.offset),
      [citationSource.indexOf("戊")]
    );
  });

  it("相同普通正文保留多个候选，并阻止方向删除跨过公式", () => {
    const repeated = "前文$K$相同正文；后文$G$相同正文";
    const candidates = structuredCaretCandidates(repeated, "前文K相同正文", "前文K".length);
    assert.ok(candidates.length >= 2);

    const formulaEnd = repeated.indexOf("$K$") + "$K$".length;
    assert.equal(adjacentEditableLatexRange(repeated, formulaEnd, "backward"), undefined);
    assert.deepEqual(adjacentEditableLatexRange(repeated, formulaEnd, "forward"), {
      start: repeated.indexOf("相同正文"),
      end: repeated.indexOf("相同正文") + 1
    });
  });
});
