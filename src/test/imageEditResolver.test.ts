import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyDirectDocumentEdits, validateNoOverlappingDocumentEdits } from "../documentEdits";
import { hashDocument, PendingManualEdit } from "../manualEdits";
import {
  chooseImageCandidatesByMappedLines,
  createImageEditTarget,
  createPendingImageEdit,
  findImageEditCandidates,
  validateImageSelectionConsistency
} from "../imageEditResolver";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(source: string, files: string[]): Promise<{ root: string; source: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-image-"));
  roots.push(root);
  for (const file of files) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "fixture");
  }
  return { root, source };
}

function selection() {
  const bounds = { x: 100, y: 200, width: 300, height: 180 };
  return {
    page: 3,
    bounds,
    roughBounds: { ...bounds },
    imageObjectName: "img_fixture_1",
    anchors: [
      { x: 250, y: 290 }, { x: 110, y: 210 }, { x: 390, y: 210 },
      { x: 110, y: 370 }, { x: 390, y: 370 }
    ],
    pageWidth: 600,
    pageHeight: 800
  };
}

describe("图片命令解析与安全调整", () => {
  it("解析 width、height、scale 与 graphicspath，并应用 5% 调整", async () => {
    const value = await fixture(String.raw`\graphicspath{{figures/}}
\includegraphics[width=0.58\textwidth]{Fig01.png}
\includegraphics[height=0.17\textheight,keepaspectratio]{Fig02.png}
\includegraphics[scale=1.2]{figures/Fig03.png}`, [
      "figures/Fig01.png", "figures/Fig02.png", "figures/Fig03.png"
    ]);
    const candidates = await findImageEditCandidates(value.source, value.root);
    assert.equal(candidates.length, 3);
    assert.deepEqual(candidates.map((candidate) => candidate.parameter), ["width", "height", "scale"]);
    assert.equal(candidates[1].originalDisplay, String.raw`height=0.17\textheight`);
    const target = createImageEditTarget(candidates[0], selection(), value.source, "target");
    const edit = createPendingImageEdit(target, 1.05, "edit");
    assert.equal(edit.candidateValue, String.raw`width=0.609\textwidth`);
    assert.match(applyDirectDocumentEdits(value.source, [edit]), /width=0\.609\\textwidth/u);
  });

  it("无尺寸参数时增加估算 width，且必须调整后才能确认", async () => {
    const value = await fixture(String.raw`\includegraphics{figure.png}`, ["figure.png"]);
    const [candidate] = await findImageEditCandidates(value.source, value.root);
    const target = createImageEditTarget(candidate, selection(), value.source, "target");
    assert.throws(() => createPendingImageEdit(target, 1));
    const edit = createPendingImageEdit(target, 0.95, "edit");
    assert.match(applyDirectDocumentEdits(value.source, [edit]), /\\includegraphics\[width=0\.5938\\linewidth\]\{figure\.png\}/u);
  });

  it("简单子图优先调整外层宽度", async () => {
    const source = String.raw`\begin{subfigure}[t]{0.485\textwidth}
\includegraphics[width=\linewidth]{sub.png}
\end{subfigure}`;
    const value = await fixture(source, ["sub.png"]);
    const [candidate] = await findImageEditCandidates(source, value.root);
    assert.equal(candidate.parameter, "subfigureWidth");
    const edit = createPendingImageEdit(createImageEditTarget(candidate, selection(), source), 0.95);
    const result = applyDirectDocumentEdits(source, [edit]);
    assert.match(result, /\{0\.4607\\textwidth\}/u);
    assert.match(result, /width=\\linewidth/u);
  });

  it("拒绝复杂尺寸、多重尺寸、缺失文件与重叠修改", async () => {
    const source = String.raw`\includegraphics[width=\dimexpr\linewidth-1cm\relax]{a.png}
\includegraphics[width=2cm,height=3cm]{b.png}
\includegraphics[width=0.5\linewidth]{missing.png}`;
    const value = await fixture(source, ["a.png", "b.png"]);
    assert.deepEqual(await findImageEditCandidates(source, value.root), []);

    const simple = String.raw`\includegraphics[width=0.5\linewidth]{a.png}`;
    const [candidate] = await findImageEditCandidates(simple, value.root);
    const target = createImageEditTarget(candidate, selection(), simple);
    const first = createPendingImageEdit(target, 1.05, "same");
    const second = createPendingImageEdit(target, 0.95, "same");
    assert.throws(() => validateNoOverlappingDocumentEdits([first, second]));
  });

  it("保留同一普通正文边界的连续文字插入兼容性", () => {
    const baseText = "普通正文";
    const edits: PendingManualEdit[] = ["甲", "乙"].map((insertedText, index) => ({
      id: `text-${index}`,
      kind: "insertBefore",
      startOffset: 2,
      endOffset: 2,
      sourceText: "",
      insertedText,
      page: 1,
      rects: [{ page: 1, x: 0.1, y: 0.1, width: 0.1, height: 0.03 }],
      baseDocumentHash: hashDocument(baseText)
    }));
    assert.doesNotThrow(() => validateNoOverlappingDocumentEdits(edits));
    assert.equal(applyDirectDocumentEdits(baseText, edits), "普通甲乙正文");
  });

  it("按多点映射行选择唯一图片候选，不唯一时保留候选给空间消歧", async () => {
    const value = await fixture(String.raw`\includegraphics[width=0.5\linewidth]{a.png}


\includegraphics[width=0.5\linewidth]{b.png}`, ["a.png", "b.png"]);
    const candidates = await findImageEditCandidates(value.source, value.root);
    assert.equal(chooseImageCandidatesByMappedLines(candidates, [
      { input: "main.tex", line: 4 }, { input: "main.tex", line: 5 }
    ]).length, 1);
    assert.equal(chooseImageCandidatesByMappedLines(candidates, [
      { input: "main.tex", line: 3 }
    ]).length, 2);
  });

  it("使用 SyncTeX 正向矩形复核 PDF.js 吸附边界", () => {
    const value = selection();
    assert.doesNotThrow(() => validateImageSelectionConsistency(value, []));
    assert.doesNotThrow(() => validateImageSelectionConsistency(value, [{
      page: 3,
      x: 100,
      y: 200,
      width: 300,
      height: 180
    }]));
    assert.throws(() => validateImageSelectionConsistency(value, [{
      page: 3,
      x: 450,
      y: 500,
      width: 80,
      height: 60
    }]), /不一致/u);
  });
});
