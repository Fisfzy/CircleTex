import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CIRCLETEX_REVISION_BLOCK_BEGIN,
  NormalizedManualEditRect,
  PendingManualEdit,
  acceptAllCircleTeXRevisions,
  applyDirectManualEdits,
  applyManualEdits,
  createPendingCaretManualEdit,
  createPendingManualEdit,
  escapeLatexPlainText,
  hasCircleTeXRevisions,
  hashDocument,
  injectCircleTeXRevisionPreamble,
  normalizeManualEditVisibleGraphemes,
  rejectAllCircleTeXRevisions,
  resolveManualEditCaretOffset,
  resolveManualEditSourceRange,
  validateNoOverlappingManualEdits
} from "../manualEdits";
import { SourceMapping } from "../types";

const rects: NormalizedManualEditRect[] = [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }];

function mapping(sourceText: string, selectedText: string, startOffset = 100): SourceMapping {
  const base = `${"甲".repeat(startOffset)}${sourceText}`;
  return {
    id: "mapping-1",
    sourcePath: "main.tex",
    startLine: 1,
    endLine: 2,
    startOffset,
    endOffset: startOffset + sourceText.length,
    sourceText,
    contextText: sourceText,
    contextStartLine: 1,
    documentHash: hashDocument(base),
    normalizedDocumentHash: hashDocument(base),
    selection: {
      kind: "text",
      text: selectedText,
      page: 2,
      start: { x: 1, y: 2 },
      end: { x: 3, y: 4 }
    }
  };
}

function mappingWithContext(
  sourceText: string,
  selectedText: string,
  contextBefore: string,
  contextAfter: string
): SourceMapping {
  const value = mapping(sourceText, selectedText);
  if (value.selection.kind === "text") {
    value.selection.contextBefore = contextBefore;
    value.selection.contextAfter = contextAfter;
  }
  return value;
}

function edit(
  baseText: string,
  id: string,
  kind: PendingManualEdit["kind"],
  target: string,
  insertedText = ""
): PendingManualEdit {
  const startOffset = baseText.indexOf(target);
  assert.ok(startOffset >= 0);
  return {
    id,
    kind,
    startOffset,
    endOffset: startOffset + target.length,
    sourceText: target,
    insertedText,
    page: 1,
    rects,
    baseDocumentHash: hashDocument(baseText)
  };
}

describe("PDF 文字到普通正文的字符级定位", () => {
  it("定位中文文字并返回文档绝对偏移", () => {
    const result = resolveManualEditSourceRange(mapping("前文，目标段落。后文", "目标段落"));
    assert.deepEqual(result, {
      startOffset: 103,
      endOffset: 107,
      sourceText: "目标段落"
    });
  });

  it("允许 PDF 与源码存在空格和换行差异", () => {
    const source = "前文\n目标 第一行\r\n第二行 结束。";
    const result = resolveManualEditSourceRange(mapping(source, "目标第一行 第二行结束"));
    assert.equal(result.sourceText, "目标 第一行\r\n第二行 结束");
    assert.equal(result.startOffset, 103);
    assert.equal(result.endOffset, 103 + result.sourceText.length);
  });

  it("拒绝重复命中和不存在的文字", () => {
    assert.throws(
      () => resolveManualEditSourceRange(mapping("相同文字，随后又是相同文字。", "相同文字")),
      /重复片段/
    );
    assert.throws(
      () => resolveManualEditSourceRange(mapping("只有正文", "其他文字")),
      /无法.*匹配/
    );
  });

  it("使用 PDF 左右可见上下文消歧重复短语", () => {
    const source = "第一处之前相同文字第一处之后；第二处之前相同文字第二处之后。";
    const second = resolveManualEditSourceRange(mappingWithContext(
      source,
      "相同文字",
      "；第二处之前",
      "第二处之后。"
    ));
    assert.equal(second.startOffset, 100 + source.lastIndexOf("相同文字"));
    assert.equal(second.sourceText, "相同文字");
  });

  it("允许同一句中的两个相同短语分别暂存后一起删除", () => {
    const source = "第一处之前相同文字第一处之后；第二处之前相同文字第二处之后。";
    const base = `${"甲".repeat(100)}${source}`;
    const first = createPendingManualEdit(mappingWithContext(
      source,
      "相同文字",
      "第一处之前",
      "第一处之后；"
    ), "delete", "", rects, "delete-first");
    const second = createPendingManualEdit(mappingWithContext(
      source,
      "相同文字",
      "；第二处之前",
      "第二处之后。"
    ), "delete", "", rects, "delete-second");
    validateNoOverlappingManualEdits([first, second]);
    const result = applyDirectManualEdits(base, [first, second]);
    assert.equal(result.includes("相同文字"), false);
    assert.match(result, /第一处之前第一处之后；第二处之前第二处之后。/);
  });

  it("上下文并列或过短时仍拒绝猜测重复位置", () => {
    assert.throws(
      () => resolveManualEditSourceRange(mappingWithContext(
        "甲相同文字乙；甲相同文字乙。",
        "相同文字",
        "甲",
        "乙"
      )),
      /上下文不足/
    );
    assert.throws(
      () => resolveManualEditSourceRange(mappingWithContext(
        "前文相同文字后文；前文相同文字后文。",
        "相同文字",
        "前文",
        "后文"
      )),
      /上下文不足/
    );
  });

  it("拒绝 LaTeX 命令、花括号、数学、注释和对齐片段", () => {
    const invalidCases = [
      ["前文 \\textbf{目标} 后文", "textbf"],
      ["前文 {目标} 后文", "{目标}"],
      ["前文 $目标$ 后文", "$目标$"],
      ["前文 % 目标注释", "目标注释"],
      ["前文 甲 & 乙 后文", "甲&乙"]
    ];
    for (const [source, selected] of invalidCases) {
      assert.throws(() => resolveManualEditSourceRange(mapping(source, selected)), /LaTeX|匹配/);
    }
  });

  it("按规范化、去空白后的 Unicode 字素簇解析光标边界", () => {
    const source = "前文甲 😀 乙后文";
    const value = mapping(source, "甲😀乙");
    assert.equal(resolveManualEditCaretOffset(value, 0), 102);
    assert.equal(resolveManualEditCaretOffset(value, 2), 107);
    assert.equal(resolveManualEditCaretOffset(value, 3), 108);
    assert.throws(() => resolveManualEditCaretOffset(value, 4), /0 至 3/);
  });

  it("拒绝落在 NFKC 字符展开结果内部的光标", () => {
    const value = mapping("前文ﬁ后文", "ﬁ");
    assert.throws(() => resolveManualEditCaretOffset(value, 1), /NFKC.*内部/);
  });

  it("将组合重音和 Hangul Jamo 规范化后映射回完整源码字素", () => {
    const decomposedAccent = "e\u0301";
    const accentMapping = mapping(`前文${decomposedAccent}后文`, "é");
    assert.deepEqual(resolveManualEditSourceRange(accentMapping), {
      startOffset: 102,
      endOffset: 104,
      sourceText: decomposedAccent
    });
    assert.equal(resolveManualEditCaretOffset(accentMapping, 1), 104);

    const hangulJamo = "\u1100\u1161";
    const hangulMapping = mapping(`前文${hangulJamo}后文`, "가");
    assert.deepEqual(resolveManualEditSourceRange(hangulMapping), {
      startOffset: 102,
      endOffset: 104,
      sourceText: hangulJamo
    });
  });

  it("把变体选择符和 ZWJ 序列分别视为单个可见字素", () => {
    const airplane = "✈️";
    const scientist = "👩‍🔬";
    assert.deepEqual(
      normalizeManualEditVisibleGraphemes(` ${airplane} ${scientist} `),
      [airplane, scientist]
    );

    const value = mapping(`前文${scientist}后文`, scientist);
    assert.equal(resolveManualEditCaretOffset(value, 0), 102);
    assert.equal(resolveManualEditCaretOffset(value, 1), 102 + scientist.length);
    assert.throws(() => resolveManualEditCaretOffset(value, 2), /0 至 1/);
  });

  it("拒绝数学、表格、逐字环境和 verb 内容中的普通文字", () => {
    const environments = [
      "equation", "align*", "gather", "multline", "displaymath", "math", "eqnarray",
      "tabular", "array", "verbatim", "lstlisting", "minted"
    ];
    for (const environment of environments) {
      const source = `前文\\begin{${environment}}\n目标\n\\end{${environment}}后文`;
      assert.throws(
        () => resolveManualEditSourceRange(mapping(source, "目标")),
        /LaTeX|环境/,
        environment
      );
    }
    assert.throws(
      () => resolveManualEditSourceRange(mapping("前文\\verb|目标|后文", "目标")),
      /LaTeX|环境/
    );
  });

  it("离开受限环境或 verb 后恢复普通正文编辑，并允许列表正文", () => {
    const afterEquation = "\\begin{equation}x\\end{equation}目标";
    assert.equal(resolveManualEditSourceRange(mapping(afterEquation, "目标")).sourceText, "目标");

    const afterVerb = "\\verb|%| 目标";
    assert.equal(resolveManualEditSourceRange(mapping(afterVerb, "目标")).sourceText, "目标");

    const itemize = "\\begin{itemize}\\item 目标\\end{itemize}";
    assert.equal(resolveManualEditSourceRange(mapping(itemize, "目标")).sourceText, "目标");
  });
});

describe("新增文字与队列校验", () => {
  it("保留跨页预览矩形的所属页码", () => {
    const edit = createPendingManualEdit(
      mapping("前文目标后文", "目标"),
      "replace",
      "替换",
      [
        { page: 2, x: 0.1, y: 0.8, width: 0.3, height: 0.04 },
        { page: 3, x: 0.1, y: 0.1, width: 0.3, height: 0.04 }
      ]
    );
    assert.deepEqual(edit.rects.map((rect) => rect.page), [2, 3]);
  });
  it("将所有 LaTeX 特殊字符作为纯文本转义", () => {
    assert.equal(
      escapeLatexPlainText("50%_a & {b} #1 $x$ \\ ^ ~"),
      "50\\%\\_a \\& \\{b\\} \\#1 \\$x\\$ \\textbackslash{} \\textasciicircum{} \\textasciitilde{}"
    );
    assert.equal(escapeLatexPlainText("中文\n第二行"), "中文\n第二行");
  });

  it("拒绝空文字、危险控制字符和非法矩形", () => {
    assert.throws(() => escapeLatexPlainText(" \n "), /不能为空/);
    assert.throws(() => escapeLatexPlainText("正常\u0000恶意"), /控制字符/);
    assert.throws(
      () => createPendingManualEdit(mapping("普通正文", "正文"), "replace", "新文", [
        { x: 0.9, y: 0.1, width: 0.2, height: 0.1 }
      ]),
      /归一化/
    );
  });

  it("创建修订时保留纯文本，执行阶段再转义", () => {
    const item = createPendingManualEdit(mapping("前文目标后文", "目标"), "replace", "50%", rects, "edit-1");
    assert.equal(item.id, "edit-1");
    assert.equal(item.insertedText, "50%");
    assert.equal(item.sourceText, "目标");
    assert.equal(item.page, 2);
  });

  it("创建零宽光标插入和前后相邻字符删除", () => {
    const value = mapping("前文甲乙后文", "甲乙");
    const inserted = createPendingCaretManualEdit(
      value, "insertAfter", "新增", 1, rects, "caret-insert"
    );
    assert.equal(inserted.startOffset, 103);
    assert.equal(inserted.endOffset, 103);
    assert.equal(inserted.sourceText, "");

    const backward = createPendingCaretManualEdit(
      value, "delete", "", 1, rects, "caret-backward", "backward"
    );
    assert.equal(backward.sourceText, "甲");
    assert.equal(backward.startOffset, 102);
    assert.equal(backward.endOffset, 103);

    const forward = createPendingCaretManualEdit(
      value, "delete", "", 1, rects, "caret-forward", "forward"
    );
    assert.equal(forward.sourceText, "乙");
    assert.equal(forward.startOffset, 103);
    assert.equal(forward.endOffset, 104);
  });

  it("光标插入可缩短双侧锚点并避开附近的 LaTeX 渲染差异", () => {
    const cases = [
      {
        source: "引文\\cite{ref21}之后甲乙丙丁戊己这里庚辛壬癸结束",
        visible: "引文[21]之后甲乙丙丁戊己这里庚辛壬癸结束",
        prefix: "引文[21]之后甲乙丙丁戊己"
      },
      {
        source: "比例为20\\%，随后甲乙丙丁戊己这里庚辛壬癸结束",
        visible: "比例为20%，随后甲乙丙丁戊己这里庚辛壬癸结束",
        prefix: "比例为20%，随后甲乙丙丁戊己"
      },
      {
        source: "结果为$K_I$，随后甲乙丙丁戊己这里庚辛壬癸结束",
        visible: "结果为KI，随后甲乙丙丁戊己这里庚辛壬癸结束",
        prefix: "结果为KI，随后甲乙丙丁戊己"
      }
    ];
    for (const value of cases) {
      const caret = normalizeManualEditVisibleGraphemes(value.prefix).length;
      const inserted = createPendingCaretManualEdit(
        mapping(value.source, value.visible), "insertBefore", "新增", caret, rects
      );
      assert.equal(inserted.startOffset, 100 + value.source.indexOf("这里"));
      assert.equal(inserted.endOffset, inserted.startOffset);
      const base = `${"甲".repeat(100)}${value.source}`;
      assert.equal(
        applyDirectManualEdits(base, [inserted]),
        `${base.slice(0, inserted.startOffset)}新增${base.slice(inserted.startOffset)}`
      );
    }
  });

  it("结构感知锚点支持引用后插入，并仍拒绝重复位置和公式内部", () => {
    const commandSource = "甲乙丙丁\\cite{ref21}戊己庚辛壬癸";
    const commandVisible = "甲乙丙丁[21]戊己庚辛壬癸";
    const afterCitation = createPendingCaretManualEdit(
      mapping(commandSource, commandVisible),
      "insertAfter",
      "新增",
      normalizeManualEditVisibleGraphemes("甲乙丙丁[21]").length,
      rects
    );
    assert.equal(afterCitation.startOffset, 100 + commandSource.indexOf("戊"));

    const repeatedSource = "前导\\cite{a}甲乙丙丁戊己庚辛壬癸。另处甲乙丙丁戊己庚辛壬癸";
    const repeatedVisible = "前导[1]甲乙丙丁戊己庚辛壬癸";
    assert.throws(
      () => createPendingCaretManualEdit(
        mapping(repeatedSource, repeatedVisible),
        "insertBefore",
        "新增",
        normalizeManualEditVisibleGraphemes("前导[1]甲乙丙丁戊己").length,
        rects
      ),
      /多个候选边界/
    );

    const formulaSource = "结果为$K_I$，随后甲乙丙丁戊己";
    const formulaVisible = "结果为KI，随后甲乙丙丁戊己";
    assert.throws(
      () => createPendingCaretManualEdit(
        mapping(formulaSource, formulaVisible),
        "insertBefore",
        "新增",
        normalizeManualEditVisibleGraphemes("结果为K").length,
        rects
      ),
      /公式、引用|安全的普通正文/
    );
  });

  it("允许替换格式命令参数中的普通正文", () => {
    const source = "前文\\textbf{目标正文}后文";
    const item = createPendingManualEdit(mapping(source, "目标正文"), "replace", "替换正文", rects);
    assert.equal(item.sourceText, "目标正文");
    assert.equal(item.startOffset, 100 + source.indexOf("目标正文"));
  });

  it("结构感知光标删除只删除引用后的普通文字", () => {
    const source = "引文\\cite{ref21}之后甲乙丙丁戊己这里庚辛壬癸结束";
    const visible = "引文[21]之后甲乙丙丁戊己这里庚辛壬癸结束";
    const deletion = createPendingCaretManualEdit(
      mapping(source, visible),
      "delete",
      "",
      normalizeManualEditVisibleGraphemes("引文[21]之后甲乙丙丁戊己").length,
      rects,
      "structured-delete",
      "backward"
    );
    assert.equal(deletion.sourceText, "己");
    assert.equal(deletion.startOffset, 100 + source.indexOf("己"));
  });

  it("允许在行内公式前后及格式命令正文中插入", () => {
    const formulaSource = "结果为$K_I$，随后甲乙丙丁戊己";
    const formulaVisible = "结果为KI，随后甲乙丙丁戊己";
    const before = createPendingCaretManualEdit(
      mapping(formulaSource, formulaVisible), "insertBefore", "新增",
      normalizeManualEditVisibleGraphemes("结果为").length, rects
    );
    const after = createPendingCaretManualEdit(
      mapping(formulaSource, formulaVisible), "insertAfter", "新增",
      normalizeManualEditVisibleGraphemes("结果为KI").length, rects
    );
    assert.equal(before.startOffset, 100 + formulaSource.indexOf("$K_I$"));
    assert.equal(after.startOffset, 100 + formulaSource.indexOf("，"));

    const formattedSource = "前导\\textbf{甲乙丙丁戊己庚辛壬癸}后文";
    const formattedVisible = "前导甲乙丙丁戊己庚辛壬癸后文";
    const formatted = createPendingCaretManualEdit(
      mapping(formattedSource, formattedVisible), "insertBefore", "新增",
      normalizeManualEditVisibleGraphemes("前导甲乙丙丁戊己").length, rects
    );
    assert.equal(formatted.startOffset, 100 + formattedSource.indexOf("庚"));
  });

  it("光标删除一次移除完整组合字素或 ZWJ 字素", () => {
    const decomposedAccent = "e\u0301";
    const accent = createPendingCaretManualEdit(
      mapping(`前文${decomposedAccent}后文`, "é"),
      "delete", "", 1, rects, "delete-accent", "backward"
    );
    assert.equal(accent.sourceText, decomposedAccent);

    const scientist = "👩‍🔬";
    const emoji = createPendingCaretManualEdit(
      mapping(`前文${scientist}后文`, scientist),
      "delete", "", 0, rects, "delete-emoji", "forward"
    );
    assert.equal(emoji.sourceText, scientist);
    assert.equal(emoji.endOffset - emoji.startOffset, scientist.length);
  });

  it("拒绝光标删除越过选区边界或缺少方向", () => {
    const value = mapping("前文甲乙后文", "甲乙");
    assert.throws(
      () => createPendingCaretManualEdit(value, "delete", "", 0, rects, "back", "backward"),
      /光标前没有/
    );
    assert.throws(
      () => createPendingCaretManualEdit(value, "delete", "", 2, rects, "forward", "forward"),
      /光标后没有/
    );
    assert.throws(
      () => createPendingCaretManualEdit(value, "delete", "", 1, rects, "missing"),
      /必须指定/
    );
  });

  it("拒绝范围重叠、重复标识，允许首尾相接的范围", () => {
    const base = "\\documentclass{article}\n\\begin{document}\n甲乙丙丁\n\\end{document}\n";
    const first = edit(base, "first", "delete", "甲乙");
    const overlap = { ...edit(base, "second", "replace", "乙丙", "新文") };
    assert.throws(() => validateNoOverlappingManualEdits([first, overlap]), /重叠/);
    assert.throws(() => validateNoOverlappingManualEdits([first, { ...first }]), /标识重复/);
    assert.doesNotThrow(() => validateNoOverlappingManualEdits([
      first,
      edit(base, "second", "delete", "丙丁")
    ]));
  });
});

describe("修订模式 TeX 生成", () => {
  const base = [
    "\\documentclass{article}",
    "\\begin{document}",
    "甲段。乙段。丙段。丁段。",
    "\\end{document}",
    ""
  ].join("\n");

  it("支持前插、后插、删除和替换，并按基线偏移逆序应用", () => {
    const edits = [
      edit(base, "before", "insertBefore", "甲段", "新增%"),
      edit(base, "after", "insertAfter", "乙段", "补充"),
      edit(base, "delete", "delete", "丙段"),
      edit(base, "replace", "replace", "丁段", "替代")
    ];
    const result = applyManualEdits(base, edits);
    assert.match(result, /\\CircleTeXAdded\{新增\\%\}甲段/);
    assert.match(result, /乙段\\CircleTeXAdded\{补充\}/);
    assert.match(result, /\\CircleTeXDeleted\{丙段\}/);
    const deletedIndex = result.indexOf("\\CircleTeXDeleted{丁段}{");
    const addedIndex = result.indexOf("\\CircleTeXAdded{替代}", deletedIndex);
    assert.ok(deletedIndex >= 0 && addedIndex > deletedIndex);
    assert.ok(result.indexOf(CIRCLETEX_REVISION_BLOCK_BEGIN) < result.indexOf("\\begin{document}"));
  });

  it("宏定义块条件加载依赖且重复注入保持幂等", () => {
    const once = injectCircleTeXRevisionPreamble(base);
    const twice = injectCircleTeXRevisionPreamble(once);
    assert.equal(twice, once);
    assert.equal(once.match(/CIRCLETEX-REVISION-BEGIN/gu)?.length, 1);
    assert.match(once, /@ifpackageloaded\{xcolor\}/);
    assert.doesNotMatch(once, /RequirePackage\[normalem\]\{ulem\}/);
    assert.match(once, /CircleTeXStrikeUnit/);
  });

  it("忽略注释、逐字内容和宏参数中的伪文档起点", () => {
    const guarded = [
      "\\documentclass{article}",
      "% \\begin{document}",
      "\\verb|\\begin{document}|",
      "\\newcommand{\\sample}{\\begin{document}}",
      "\\begin{document}",
      "正文",
      "\\end{document}",
      ""
    ].join("\n");
    const result = injectCircleTeXRevisionPreamble(guarded);
    const actualDocumentStart = result.lastIndexOf("\\begin{document}");
    assert.ok(result.indexOf(CIRCLETEX_REVISION_BLOCK_BEGIN) < actualDocumentStart);
    assert.ok(result.indexOf(CIRCLETEX_REVISION_BLOCK_BEGIN) > result.indexOf("\\newcommand"));
  });

  it("拒绝过期基线、源码变化和残缺宏块", () => {
    const stale = { ...edit(base, "stale", "delete", "甲段"), baseDocumentHash: "0".repeat(64) };
    assert.throws(() => applyManualEdits(base, [stale]), /基线源码校验失败/);
    const changed = { ...edit(base, "changed", "delete", "甲段"), sourceText: "其他" };
    assert.throws(() => applyManualEdits(base, [changed]), /源码文字与范围不一致|目标源码/);
    const partial = `${CIRCLETEX_REVISION_BLOCK_BEGIN}\n${base}`;
    assert.throws(() => injectCircleTeXRevisionPreamble(partial), /不完整/);
  });
});

describe("直接编辑模式 TeX 生成", () => {
  const base = [
    "\\documentclass{article}",
    "\\begin{document}",
    "甲段。乙段。丙段。丁段。",
    "\\end{document}",
    ""
  ].join("\n");

  it("直接执行前插、后插、删除和替换，并保持干净正文", () => {
    const result = applyDirectManualEdits(base, [
      edit(base, "before", "insertBefore", "甲段", "新增"),
      edit(base, "after", "insertAfter", "乙段", "补充"),
      edit(base, "delete", "delete", "丙段"),
      edit(base, "replace", "replace", "丁段", "替代")
    ]);

    assert.match(result, /新增甲段。乙段补充。。替代。/);
    assert.doesNotMatch(result, /CircleTeX|CIRCLETEX-REVISION/);
    assert.equal(result.indexOf("\\begin{document}"), base.indexOf("\\begin{document}"));
  });

  it("将新增内容作为普通 LaTeX 文本转义且不注入修订宏", () => {
    const insertedText = "50%_a & {b} #1 $x$ \\ ^ ~";
    const result = applyDirectManualEdits(base, [
      edit(base, "replace", "replace", "甲段", insertedText)
    ]);

    assert.ok(result.includes(escapeLatexPlainText(insertedText)));
    assert.doesNotMatch(result, /CircleTeX|CIRCLETEX-REVISION/);
  });

  it("同一边界的连续插入按队列顺序合并", () => {
    const left = edit(base, "left-1", "insertAfter", "甲段", "先");
    const leftAgain = { ...left, id: "left-2", insertedText: "后" };
    const right = edit(base, "right", "insertBefore", "乙段", "再");
    const result = applyDirectManualEdits(base, [left, leftAgain, right]);

    assert.match(result, /甲段先后。再乙段/);
  });

  it("支持同一源码边界的零宽连续插入，修订模式同样保持队列顺序", () => {
    const position = base.indexOf("乙段");
    const first: PendingManualEdit = {
      ...edit(base, "zero-1", "insertBefore", "乙段", "先"),
      startOffset: position,
      endOffset: position,
      sourceText: ""
    };
    const second = { ...first, id: "zero-2", insertedText: "后" };

    const direct = applyDirectManualEdits(base, [first, second]);
    assert.match(direct, /甲段。先后乙段/);

    const revised = applyManualEdits(base, [first, second]);
    assert.match(revised, /甲段。\\CircleTeXAdded\{先\}\\CircleTeXAdded\{后\}乙段/);
  });

  it("允许在普通正文与后续 LaTeX 命令的边界直接插入", () => {
    const commandBase = [
      "\\documentclass{article}",
      "\\begin{document}",
      "正文\\cite{sample}。",
      "\\end{document}",
      ""
    ].join("\n");
    const position = commandBase.indexOf("\\cite");
    const item: PendingManualEdit = {
      ...edit(commandBase, "before-command", "insertAfter", "正文", "新增"),
      startOffset: position,
      endOffset: position,
      sourceText: ""
    };
    assert.match(applyDirectManualEdits(commandBase, [item]), /正文新增\\cite/);
  });

  it("拒绝手工构造的字素内部插入点", () => {
    const decomposedAccent = "e\u0301";
    const graphemeBase = [
      "\\documentclass{article}",
      "\\begin{document}",
      `甲${decomposedAccent}乙`,
      "\\end{document}",
      ""
    ].join("\n");
    const position = graphemeBase.indexOf(decomposedAccent) + 1;
    const item: PendingManualEdit = {
      ...edit(graphemeBase, "inside-grapheme", "insertBefore", decomposedAccent, "新增"),
      startOffset: position,
      endOffset: position,
      sourceText: ""
    };
    assert.throws(() => applyDirectManualEdits(graphemeBase, [item]), /字素|字符内部/);
  });

  it("在替换范围两侧稳定应用零宽插入", () => {
    const start = base.indexOf("乙段");
    const end = start + "乙段".length;
    const replacement = edit(base, "replace-middle", "replace", "乙段", "替代");
    const before: PendingManualEdit = {
      ...edit(base, "at-start", "insertBefore", "乙段", "前"),
      startOffset: start,
      endOffset: start,
      sourceText: ""
    };
    const after: PendingManualEdit = {
      ...edit(base, "at-end", "insertAfter", "乙段", "后"),
      startOffset: end,
      endOffset: end,
      sourceText: ""
    };

    const result = applyDirectManualEdits(base, [after, replacement, before]);
    assert.match(result, /甲段。前替代后。丙段/);
  });

  it("存在未处理的 CircleTeX 修订时拒绝直接编辑", () => {
    const revised = applyManualEdits(base, [edit(base, "old-revision", "replace", "甲段", "旧修订")]);
    assert.equal(hasCircleTeXRevisions(revised), true);
    assert.throws(
      () => applyDirectManualEdits(revised, [edit(revised, "direct", "replace", "乙段", "直接")]),
      /尚未接受或拒绝.*CircleTeX/
    );
  });

  it("拒绝过期基线、变化的目标和相互重叠的替换范围", () => {
    const stale = { ...edit(base, "stale", "delete", "甲段"), baseDocumentHash: "0".repeat(64) };
    assert.throws(() => applyDirectManualEdits(base, [stale]), /基线源码校验失败/);

    const changed = { ...edit(base, "changed", "delete", "甲段"), sourceText: "其他" };
    assert.throws(
      () => applyDirectManualEdits(base, [changed]),
      /源码文字与范围不一致|目标源码/
    );

    const first = edit(base, "first", "delete", "甲段。乙段");
    const second = edit(base, "second", "replace", "乙段。丙段", "替换");
    assert.throws(() => applyDirectManualEdits(base, [first, second]), /范围重叠/);
  });

  it("拒绝位于删除或替换范围内部的插入点", () => {
    const replace = edit(base, "replace", "replace", "甲段。乙段", "替换");
    const insert = edit(base, "insert", "insertAfter", "甲段", "插入");
    assert.throws(() => applyDirectManualEdits(base, [replace, insert]), /插入点.*内部/);
  });
});

describe("接受或拒绝全部修订", () => {
  const base = [
    "\\documentclass{article}",
    "\\begin{document}",
    "旧文和原文。",
    "\\end{document}",
    ""
  ].join("\n");

  function revised(): string {
    return applyManualEdits(base, [edit(base, "replace", "replace", "旧文", "新{文}%")]);
  }

  it("检测修订，并在接受时保留 Added、去掉 Deleted", () => {
    const source = revised();
    assert.equal(hasCircleTeXRevisions(source), true);
    const accepted = acceptAllCircleTeXRevisions(source);
    assert.match(accepted, /新\\\{文\\\}\\%和原文/);
    assert.doesNotMatch(accepted, /CircleTeXAdded|CircleTeXDeleted|CIRCLETEX-REVISION/);
    assert.equal(hasCircleTeXRevisions(accepted), false);
  });

  it("拒绝时保留 Deleted、去掉 Added，也可选择保留宏块", () => {
    const source = revised();
    const rejected = rejectAllCircleTeXRevisions(source);
    assert.match(rejected, /旧文和原文/);
    assert.doesNotMatch(rejected, /CircleTeXAdded|CircleTeXDeleted|CIRCLETEX-REVISION/);

    const kept = rejectAllCircleTeXRevisions(source, { removePreamble: false });
    assert.match(kept, /CIRCLETEX-REVISION-BEGIN/);
    assert.doesNotMatch(kept.slice(kept.indexOf("\\begin{document}")), /CircleTeXAdded|CircleTeXDeleted/);
  });

  it("使用平衡花括号解析嵌套内容，不处理注释、转义文本与 verb 内容", () => {
    const source = [
      "前文",
      "\\CircleTeXAdded{外层{内层}文字}",
      "% \\CircleTeXDeleted{注释内容}",
      "\\verb|\\CircleTeXDeleted{逐字内容}|",
      "\\\\CircleTeXDeleted{普通文字}",
      "后文"
    ].join("\n");
    const accepted = acceptAllCircleTeXRevisions(source, { removePreamble: false });
    assert.match(accepted, /外层\{内层\}文字/);
    assert.match(accepted, /% \\CircleTeXDeleted\{注释内容\}/);
    assert.match(accepted, /\\verb\|\\CircleTeXDeleted\{逐字内容\}\|/);
    assert.match(accepted, /\\\\CircleTeXDeleted\{普通文字\}/);
  });

  it("忽略修订参数内 verb 的分隔内容", () => {
    const source = "\\CircleTeXAdded{\\verb|}|尾部}";
    assert.equal(
      acceptAllCircleTeXRevisions(source, { removePreamble: false }),
      "\\verb|}|尾部"
    );
  });

  it("拒绝注释伪造的宏定义块，并在没有宏块时返回无修订", () => {
    const commentedBlock = [
      CIRCLETEX_REVISION_BLOCK_BEGIN,
      "% \\providecommand{\\CircleTeXAdded}[1]{#1}",
      "% \\providecommand{\\CircleTeXStrikeUnit}[1]{#1}",
      "% \\providecommand{\\CircleTeXDeleted}[2]{#2}",
      "% CIRCLETEX-REVISION-END",
      "\\begin{document}",
      "\\CircleTeXAdded{伪修订}",
      "\\end{document}"
    ].join("\n");
    assert.throws(() => hasCircleTeXRevisions(commentedBlock), /宏定义块不完整/);
    assert.equal(hasCircleTeXRevisions("正文 \\CircleTeXAdded{未受管修订}"), false);
  });

  it("拒绝恶意的不平衡修订参数和伪造宏标记", () => {
    assert.throws(() => acceptAllCircleTeXRevisions("前文 \\CircleTeXAdded{未闭合"), /花括号不平衡/);
    assert.throws(() => acceptAllCircleTeXRevisions("\\CircleTeXDeleted{旧文}"), /缺少中划线显示参数/);
    assert.throws(() => rejectAllCircleTeXRevisions("\\CircleTeXDeleted{旧文}{未闭合"), /花括号不平衡/);
    assert.throws(
      () => rejectAllCircleTeXRevisions(`${CIRCLETEX_REVISION_BLOCK_BEGIN}\n伪造内容\n% CIRCLETEX-REVISION-END\n正文`),
      /宏定义块不完整/
    );
  });
});
