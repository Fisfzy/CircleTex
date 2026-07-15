import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasTextualOverlap } from "../selectionMatcher";
import { parseSyncTexOutput, parseSyncTexViewOutput } from "../synctexParser";
import { computeLineStarts } from "../textRange";

describe("SyncTeX 输出解析", () => {
  it("解析中文路径、多结果和负列号", () => {
    const output = `SyncTeX result begin
Output:C:/论文/main.pdf
Input:C:/论文/main.tex
Line:128
Column:-1
SyncTeX result end
SyncTeX result begin
Input:C:/论文/hrbeu.cls
Line:42
Column:3
SyncTeX result end`;
    assert.deepEqual(parseSyncTexOutput(output), [
      { input: "C:/论文/main.tex", line: 128, column: -1 },
      { input: "C:/论文/hrbeu.cls", line: 42, column: 3 }
    ]);
  });

  it("忽略缺少有效行号的结果", () => {
    assert.deepEqual(parseSyncTexOutput("Input:main.tex\nLine:0\nSyncTeX result end"), []);
  });

  it("解析 SyncTeX 正向定位的页码和空间矩形", () => {
    assert.deepEqual(parseSyncTexViewOutput(`SyncTeX result begin
Page:5
x:115.525200
y:531.309326
h:89.858223
v:533.934326
W:415.559174
H:11.279297
SyncTeX result end`), [{
      page: 5,
      x: 115.5252,
      y: 531.309326,
      h: 89.858223,
      v: 533.934326,
      width: 415.559174,
      height: 11.279297
    }]);
  });
});

describe("TeX 行偏移", () => {
  it("正确处理中文与 CRLF", () => {
    assert.deepEqual(computeLineStarts("第一行\r\n第二行\r\n第三行"), [0, 5, 10]);
  });

  it("末尾换行不产生不存在的额外源码行", () => {
    assert.deepEqual(computeLineStarts("a\nb\n"), [0, 2]);
  });
});

describe("PDF 与 TeX 文本复核", () => {
  it("忽略 LaTeX 命令并识别连续中文文本", () => {
    assert.equal(
      hasTextualOverlap("层合板变形响应分析", "层合板\\textbf{变形响应}分析\\cite{ref1}。"),
      true
    );
  });

  it("短选区或不相关文本返回低置信度", () => {
    assert.equal(hasTextualOverlap("公式", "其他正文"), false);
    assert.equal(hasTextualOverlap("裂纹扩展分析", "层合板变形响应"), false);
  });
});
