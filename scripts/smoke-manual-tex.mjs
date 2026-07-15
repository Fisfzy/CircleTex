import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acceptAllCircleTeXRevisions,
  applyDirectManualEdits,
  applyManualEdits,
  hashDocument
} from "../out/manualEdits.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "circletex-manual-tex-"));
try {
  const source = [
    "\\documentclass{ctexart}",
    "\\begin{document}",
    "这是一段需要修订的普通文字。",
    "第一段需要跨行删除的文字，用于检查较长修订在页面边界内能够正常换行显示。",
    "",
    "第二段继续提供删除内容，用于检查修订宏能够接收自然段并完成编译。",
    "\\end{document}",
    ""
  ].join("\n");
  const target = "需要修订";
  const startOffset = source.indexOf(target);
  const paragraphTarget = [
    "第一段需要跨行删除的文字，用于检查较长修订在页面边界内能够正常换行显示。",
    "",
    "第二段继续提供删除内容，用于检查修订宏能够接收自然段并完成编译。"
  ].join("\n");
  const paragraphStart = source.indexOf(paragraphTarget);
  const edits = [{
    id: "smoke-replace",
    kind: "replace",
    startOffset,
    endOffset: startOffset + target.length,
    sourceText: target,
    insertedText: "已经修改",
    page: 1,
    rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }],
    baseDocumentHash: hashDocument(source)
  }, {
    id: "smoke-multiline-delete",
    kind: "delete",
    startOffset: paragraphStart,
    endOffset: paragraphStart + paragraphTarget.length,
    sourceText: paragraphTarget,
    insertedText: "",
    page: 1,
    rects: [{ x: 0.1, y: 0.2, width: 0.8, height: 0.2 }],
    baseDocumentHash: hashDocument(source)
  }];

  const direct = applyDirectManualEdits(source, edits);
  assert.doesNotMatch(direct, /CircleTeX|CIRCLETEX-REVISION/u);
  assert.match(direct, /已经修改/u);
  assert.doesNotMatch(direct, /第一段需要跨行删除/u);
  await compileTex(directory, "direct.tex", direct);

  const revised = applyManualEdits(source, edits);
  await compileTex(directory, "tracked.tex", revised);
  const accepted = acceptAllCircleTeXRevisions(revised);
  assert.doesNotMatch(accepted, /CircleTeXAdded|CircleTeXDeleted|CIRCLETEX-REVISION/u);
  assert.match(accepted, /已经修改/u);
  console.log("CircleTeX 直接编辑与修订兼容模式 XeLaTeX 烟测通过。");
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function compileTex(directory, fileName, source) {
  await writeFile(path.join(directory, fileName), source, "utf8");
  const result = spawnSync("xelatex", [
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    fileName
  ], {
    cwd: directory,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000
  });
  if (result.error) {
    throw result.error;
  }
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const pdfName = fileName.replace(/\.tex$/u, ".pdf");
  assert.ok(existsSync(path.join(directory, pdfName)), `${fileName} 未生成 PDF。`);
}
