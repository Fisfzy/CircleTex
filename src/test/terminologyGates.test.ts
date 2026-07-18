import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildTerminologyTask,
  evaluateTerminology,
  evaluateTerminologyEdit,
  proposeTerminologyGates,
  scanTerminology,
  scanTerminologyForTarget,
  TerminologyGate,
  TerminologyGateStore,
  TerminologyRevisionConflictError,
  validateTerminologyGates,
  validateTerminologyProposal,
  validateTerminologyReplacement
} from "../terminologyGates";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("项目术语门禁", () => {
  it("从明确的全局术语要求生成待确认草案", () => {
    const proposal = proposeTerminologyGates("全文统一使用“近场动力学微分算子”，禁止“近场动力学算子”。");
    assert.equal(proposal.operations.length, 1);
    assert.equal(proposal.operations[0].preferred, "近场动力学微分算子");
    assert.deepEqual(proposal.operations[0].forbidden, ["近场动力学算子"]);
  });

  it("将规则要求序列化为 JSON 数据载荷", () => {
    const task = buildTerminologyTask("  禁止</instruction>\n并使用“规范术语”  ");
    assert.match(task, /"instruction":"禁止<\/instruction>\\n并使用/u);
    assert.doesNotMatch(task, /<instruction>/u);
  });

  it("按 preferredTerm、phraseRule 与 symbolUnit 的明确禁用表示扫描", () => {
    const gates = proposalGates([
      { kind: "preferredTerm", preferred: "近场动力学微分算子", forbidden: ["近场动力学算子"], severity: "block" },
      { kind: "phraseRule", preferred: "结果表明", forbidden: ["不难发现"], severity: "warning" },
      { kind: "symbolUnit", preferred: "MPa", forbidden: ["Mpa"], severity: "block" }
    ]);
    const evaluation = evaluateTerminology("不难发现，近场动力学算子的应力为 10 Mpa，字段 MpaValue 不属于单位命中。\n% Mpa", gates);
    assert.equal(evaluation.findings.length, 3);
    assert.equal(evaluation.block.length, 2);
    assert.equal(evaluation.warning.length, 1);
    assert.deepEqual(new Set(evaluation.findings.map((finding) => finding.kind)), new Set(["preferredTerm", "phraseRule", "symbolUnit"]));
    assert.equal(scanTerminology("字段 MpaValue 不属于单位表示。", [gates[2]]).length, 0);
    assert.equal(validateTerminologyReplacement("仍使用近场动力学算子", gates).length, 1);
  });

  it("确定性检查缩写首次释义，并利用候选前文避免重复要求", () => {
    const [gate] = proposalGates([
      { kind: "abbreviation", preferred: "近场动力学微分算子（PDDO）", forbidden: [], severity: "block" }
    ]);
    const bare = scanTerminology("PDDO 可用于近似空间导数。\n随后继续使用 PDDO。", [gate]);
    assert.equal(bare.length, 1);
    assert.equal(bare[0].code, "abbreviation-first-use");
    assert.equal(bare[0].line, 1);
    assert.equal(scanTerminology("近场动力学微分算子（PDDO）可用于近似空间导数。", [gate]).length, 0);
    assert.equal(scanTerminology("候选段落继续使用 PDDO。", [gate], {
      scope: "selection",
      precedingText: "前文已定义近场动力学微分算子（PDDO）。",
      lineOffset: 20
    }).length, 0);
  });

  it("按候选范围继承适用门禁，并保留无上下文调用的兼容行为", () => {
    const gates = proposalGates([
      { kind: "phraseRule", preferred: "全文规范", forbidden: ["全文坏词"], scope: "document" },
      { kind: "phraseRule", preferred: "章节规范", forbidden: ["章节坏词"], scope: "chapter" },
      { kind: "phraseRule", preferred: "选区规范", forbidden: ["选区坏词"], scope: "selection" }
    ]);
    const source = "全文坏词、章节坏词、选区坏词";
    assert.equal(scanTerminology(source, gates).length, 3);
    assert.equal(scanTerminology(source, gates, "document").length, 1);
    assert.equal(scanTerminology(source, gates, { scope: "chapter", lineOffset: 8 }).length, 2);
    assert.ok(scanTerminology(source, gates, { scope: "chapter", lineOffset: 8 }).every((finding) => finding.line === 9));
    assert.equal(scanTerminology(source, gates, "selection").length, 3);
  });

  it("按规则自身作用域扫描当前目标，未提供目标时只执行全文规则", () => {
    const gates = proposalGates([
      { kind: "phraseRule", preferred: "全文规范", forbidden: ["全文坏词"], scope: "document" },
      { kind: "phraseRule", preferred: "章节规范", forbidden: ["章节坏词"], scope: "chapter" },
      { kind: "phraseRule", preferred: "选区规范", forbidden: ["选区坏词"], scope: "selection" }
    ]);
    const source = "全文坏词\n\\chapter{第一章}\n章节坏词\n选区坏词\n\\chapter{第二章}\n章节坏词";
    const selected = "章节坏词\n选区坏词";
    const startOffset = source.indexOf(selected);
    assert.equal(scanTerminologyForTarget(source, gates).length, 1);
    const findings = scanTerminologyForTarget(source, gates, { startOffset, endOffset: startOffset + selected.length });
    assert.deepEqual(new Set(findings.map((finding) => finding.term)), new Set(["全文坏词", "章节坏词", "选区坏词"]));
    assert.equal(findings.filter((finding) => finding.term === "章节坏词").length, 1);
  });

  it("比较编辑前后全文，阻止删除缩写首次释义并避免同一行边界误报", () => {
    const [gate] = proposalGates([
      { kind: "abbreviation", preferred: "近场动力学微分算子（PDDO）", forbidden: [], scope: "document", severity: "block" }
    ]);
    const source = "近场动力学微分算子（PDDO）用于空间离散。\n后文继续使用 PDDO。";
    const definition = "近场动力学微分算子（PDDO）";
    const definitionStart = source.indexOf(definition);
    const removed = evaluateTerminologyEdit(source, {
      startOffset: definitionStart,
      endOffset: definitionStart + definition.length
    }, "", [gate]);
    assert.equal(removed.block.length, 1);
    assert.equal(removed.block[0].code, "abbreviation-first-use");

    const abbreviationStart = source.indexOf("PDDO");
    const unchanged = evaluateTerminologyEdit(source, {
      startOffset: abbreviationStart,
      endOffset: abbreviationStart + "PDDO".length
    }, "PDDO", [gate]);
    assert.equal(unchanged.block.length, 0);

    const [selectionGate] = proposalGates([
      { kind: "abbreviation", preferred: "近场动力学微分算子（PDDO）", forbidden: [], scope: "selection", severity: "block" }
    ]);
    assert.equal(evaluateTerminologyEdit(source, {
      startOffset: abbreviationStart,
      endOffset: abbreviationStart + "PDDO".length
    }, "PDDO", [selectionGate]).block.length, 0);

    const invalidSource = "PDDO 尚未释义。\n后续段落。";
    const insertion = invalidSource.length;
    assert.equal(evaluateTerminologyEdit(invalidSource, {
      startOffset: insertion,
      endOffset: insertion
    }, "新增裸缩写 PDDO。", [gate]).block.length, 1);

    const validSource = "近场动力学微分算子（PDDO）已规范释义。\n后续段落。";
    assert.equal(evaluateTerminologyEdit(validSource, {
      startOffset: validSource.length,
      endOffset: validSource.length
    }, "继续使用 PDDO。", [gate]).block.length, 0);

    const [chapterGate] = proposalGates([
      { kind: "abbreviation", preferred: "近场动力学微分算子（PDDO）", forbidden: [], scope: "chapter", severity: "block" }
    ]);
    const chapterSource = [
      "\\section{第一节}",
      "近场动力学微分算子（PDDO）已规范释义。",
      "第一节后续段落。",
      "\\section{第二节}",
      "第二节正文。"
    ].join("\n");
    const firstChapterInsertion = chapterSource.indexOf("第一节后续段落") + "第一节后续段落。".length;
    assert.equal(evaluateTerminologyEdit(chapterSource, {
      startOffset: firstChapterInsertion,
      endOffset: firstChapterInsertion
    }, "继续使用 PDDO。", [chapterGate]).block.length, 0);
    assert.equal(evaluateTerminologyEdit(chapterSource, {
      startOffset: chapterSource.length,
      endOffset: chapterSource.length
    }, "第二节使用 PDDO。", [chapterGate]).block.length, 1);

    const boundaryAbbreviationSource = "PDXDO";
    const boundaryAbbreviationMarker = boundaryAbbreviationSource.indexOf("X");
    assert.equal(evaluateTerminologyEdit(boundaryAbbreviationSource, {
      startOffset: boundaryAbbreviationMarker,
      endOffset: boundaryAbbreviationMarker + 1
    }, "", [selectionGate]).block.length, 1);

    const [selectionVariantGate] = proposalGates([
      {
        kind: "abbreviation",
        preferred: "近场动力学微分算子（PDDO）",
        forbidden: ["PDD0"],
        scope: "selection",
        severity: "block"
      }
    ]);
    const boundaryVariantSource = "PDDX0";
    const boundaryVariantMarker = boundaryVariantSource.indexOf("X");
    const boundaryVariant = evaluateTerminologyEdit(boundaryVariantSource, {
      startOffset: boundaryVariantMarker,
      endOffset: boundaryVariantMarker + 1
    }, "", [selectionVariantGate]);
    assert.equal(boundaryVariant.block.length, 1);
    assert.equal(boundaryVariant.block[0].code, "forbidden-term");

    assert.equal(evaluateTerminologyEdit("% 占位", {
      startOffset: 2,
      endOffset: 4
    }, "PDDO", [gate]).block.length, 0);
    assert.equal(evaluateTerminologyEdit("Value", {
      startOffset: 0,
      endOffset: 0
    }, "PDDO", [gate]).block.length, 0);
  });

  it("识别跨编辑边界新形成的禁用表达，但不阻断无关的既有违规", () => {
    const [gate] = proposalGates([
      { kind: "phraseRule", preferred: "结果表明", forbidden: ["不难发现"], scope: "document", severity: "block" }
    ]);
    const boundarySource = "不难X发现该结果。";
    const marker = boundarySource.indexOf("X");
    assert.equal(evaluateTerminologyEdit(boundarySource, {
      startOffset: marker,
      endOffset: marker + 1
    }, "", [gate]).block.length, 1);

    const existingSource = "不难发现既有问题。\n普通段落。";
    const unchangedInside = existingSource.indexOf("难发");
    assert.equal(evaluateTerminologyEdit(existingSource, {
      startOffset: unchangedInside,
      endOffset: unchangedInside + "难发".length
    }, "难发", [gate]).block.length, 0);

    const paragraphStart = existingSource.indexOf("普通段落");
    assert.equal(evaluateTerminologyEdit(existingSource, {
      startOffset: paragraphStart,
      endOffset: paragraphStart + "普通段落".length
    }, "修改后的段落", [gate]).block.length, 0);

    const sameLineSource = "不难发现，普通段落。";
    const normalStart = sameLineSource.indexOf("普通段落");
    assert.equal(evaluateTerminologyEdit(sameLineSource, {
      startOffset: normalStart,
      endOffset: normalStart + "普通段落".length
    }, "修改段落", [gate]).block.length, 0);

    const filler = "甲".repeat(200);
    const longSource = `不难发现${filler}不难X发现`;
    const markerEnd = longSource.indexOf("X") + 1;
    assert.equal(evaluateTerminologyEdit(longSource, {
      startOffset: 0,
      endOffset: markerEnd
    }, `${filler}不难`, [gate]).block.length, 1);

    assert.equal(evaluateTerminologyEdit("% 占位\n正文", {
      startOffset: 2,
      endOffset: 4
    }, "不难发现", [gate]).block.length, 0);

    const [selectionGate] = proposalGates([
      { kind: "phraseRule", preferred: "结果表明", forbidden: ["不难发现"], scope: "selection", severity: "block" }
    ]);
    const selectionBoundarySource = "不难X发现";
    const selectionBoundaryMarker = selectionBoundarySource.indexOf("X");
    assert.equal(evaluateTerminologyEdit(selectionBoundarySource, {
      startOffset: selectionBoundaryMarker,
      endOffset: selectionBoundaryMarker + 1
    }, "", [selectionGate]).block.length, 1);

    const overlappingSource = "不难发现原文";
    const overlappingStart = overlappingSource.indexOf("难");
    assert.equal(evaluateTerminologyEdit(overlappingSource, {
      startOffset: overlappingStart,
      endOffset: overlappingSource.length
    }, "难发现修改", [gate]).block.length, 0);

    const crossLineExisting = "不难\n发现";
    const crossLineBreak = crossLineExisting.indexOf("\n");
    assert.equal(evaluateTerminologyEdit(crossLineExisting, {
      startOffset: crossLineBreak,
      endOffset: crossLineBreak + 1
    }, "", [gate]).block.length, 0);

    const [unitGate] = proposalGates([
      { kind: "symbolUnit", preferred: "MPa", forbidden: ["Mpa"], scope: "document", severity: "block" }
    ]);
    assert.equal(evaluateTerminologyEdit("Value", { startOffset: 0, endOffset: 0 }, "Mpa", [unitGate]).block.length, 0);
  });

  it("识别跨单个源码换行的禁用表达，但不跨越空行", () => {
    const [gate] = proposalGates([
      { kind: "phraseRule", preferred: "结果表明", forbidden: ["不难发现"], scope: "document", severity: "block" }
    ]);
    const crossLine = scanTerminology("由此不难\n发现该结果。", [gate]);
    assert.equal(crossLine.length, 1);
    assert.equal(crossLine[0].term, "不难发现");
    assert.equal(crossLine[0].line, 1);
    assert.equal(scanTerminology("由此不难\n\n发现该结果。", [gate]).length, 0);
  });

  it("忽略注释伪章节，并对跨章目标逐章检查缩写首次释义", () => {
    const [gate] = proposalGates([
      { kind: "abbreviation", preferred: "近场动力学微分算子（PDDO）", forbidden: [], scope: "chapter", severity: "block" }
    ]);
    const source = [
      "\\chapter{第一章}",
      "近场动力学微分算子（PDDO）已定义。",
      "% \\chapter{伪章节}",
      "继续使用 PDDO。",
      "\\chapter*{第二章}",
      "本章直接使用 PDDO。"
    ].join("\n");
    const firstUse = source.indexOf("继续使用 PDDO");
    assert.equal(scanTerminologyForTarget(source, [gate], {
      startOffset: firstUse,
      endOffset: firstUse + "继续使用 PDDO".length
    }).length, 0);
    const crossStart = source.indexOf("近场动力学微分算子");
    const crossEnd = source.indexOf("本章直接使用 PDDO") + "本章直接使用 PDDO".length;
    const crossFindings = scanTerminologyForTarget(source, [gate], { startOffset: crossStart, endOffset: crossEnd });
    assert.equal(crossFindings.length, 1);
    assert.match(crossFindings[0].context, /本章直接使用/u);
  });

  it("没有 chapter 时将 section 作为章节作用域边界", () => {
    const [gate] = proposalGates([
      { kind: "phraseRule", preferred: "规范表述", forbidden: ["章节坏词"], scope: "chapter", severity: "block" }
    ]);
    const source = [
      "\\section{第一节}",
      "第一节出现章节坏词。",
      "% \\section{伪分节}",
      "第一节后续正文。",
      "\\section*{第二节}",
      "第二节也出现章节坏词。"
    ].join("\n");
    const firstTarget = source.indexOf("第一节后续正文");
    const firstFindings = scanTerminologyForTarget(source, [gate], {
      startOffset: firstTarget,
      endOffset: firstTarget + "第一节后续正文".length
    });
    assert.equal(firstFindings.length, 1);
    assert.match(firstFindings[0].context, /第一节出现/u);

    const secondTarget = source.indexOf("第二节也出现");
    const secondFindings = scanTerminologyForTarget(source, [gate], {
      startOffset: secondTarget,
      endOffset: secondTarget + "第二节也出现章节坏词".length
    });
    assert.equal(secondFindings.length, 1);
    assert.match(secondFindings[0].context, /第二节也出现/u);
  });

  it("拒绝规则内部重复、跨规则冲突、语义重复与循环替换", () => {
    assert.throws(() => proposalGates([
      { kind: "preferredTerm", preferred: "A", forbidden: ["B", "B"] }
    ]), /重复/u);
    assert.throws(() => proposalGates([
      { kind: "preferredTerm", preferred: "A", forbidden: ["B"] },
      { kind: "preferredTerm", preferred: "C", forbidden: ["B"] }
    ]), /冲突/u);
    assert.throws(() => proposalGates([
      { kind: "preferredTerm", preferred: "A", forbidden: ["B"] },
      { kind: "preferredTerm", preferred: "A", forbidden: ["B"] }
    ]), /重复/u);
    assert.throws(() => proposalGates([
      { kind: "preferredTerm", preferred: "A", forbidden: ["B"] },
      { kind: "preferredTerm", preferred: "B", forbidden: ["A"] }
    ]), /循环替换/u);
  });

  it("对损坏或部分无效的规则文件采用 fail-closed 读取", async () => {
    const root = await makeTemporaryProject();
    const gateDirectory = path.join(root, ".circletex");
    await fs.mkdir(gateDirectory, { recursive: true });
    await fs.writeFile(path.join(gateDirectory, "terminology-gates.json"), JSON.stringify({
      version: 2,
      revision: 3,
      gates: [{ id: "broken", preferred: "A" }]
    }), "utf8");
    const store = new TerminologyGateStore(root);
    await assert.rejects(store.list(), /格式无效/u);
    const after = await fs.readFile(path.join(gateDirectory, "terminology-gates.json"), "utf8");
    assert.match(after, /"broken"/u);
  });

  it("迁移读取 v1，并以原子 v2 快照、递增版本和完整历史保存", async () => {
    const root = await makeTemporaryProject();
    const directory = path.join(root, ".circletex");
    await fs.mkdir(directory, { recursive: true });
    const [legacyGate] = proposalGates([{ kind: "phraseRule", preferred: "规范甲", forbidden: ["禁用甲"] }]);
    await fs.writeFile(path.join(directory, "terminology-gates.json"), JSON.stringify({ version: 1, gates: [legacyGate] }), "utf8");
    const store = new TerminologyGateStore(root);
    assert.equal((await store.getSnapshot()).revision, 0);
    const [newGate] = proposalGates([{ kind: "symbolUnit", preferred: "MPa", forbidden: ["Mpa"] }]);
    await store.add([newGate], 0);
    const snapshot = await store.getSnapshot();
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.gates.length, 2);
    const persisted = JSON.parse(await fs.readFile(path.join(directory, "terminology-gates.json"), "utf8")) as Record<string, unknown>;
    assert.equal(persisted.version, 2);
    assert.equal(persisted.revision, 1);
    const historyLines = (await fs.readFile(path.join(directory, "terminology-gates.history.jsonl"), "utf8")).trim().split(/\r?\n/u);
    assert.equal(historyLines.length, 1);
    const history = JSON.parse(historyLines[0]) as { before: { gates: unknown[] }; after: { gates: unknown[] }; previousRevision: number; revision: number };
    assert.equal(history.previousRevision, 0);
    assert.equal(history.revision, 1);
    assert.equal(history.before.gates.length, 1);
    assert.equal(history.after.gates.length, 2);
    assert.deepEqual(await fs.readdir(directory).then((files) => files.filter((file) => file.endsWith(".tmp"))), []);
  });

  it("跨 Store 实例串行化并发添加，并用 expectedRevision 拒绝陈旧写入", async () => {
    const root = await makeTemporaryProject();
    const firstStore = new TerminologyGateStore(root);
    const secondStore = new TerminologyGateStore(root);
    const [first] = proposalGates([{ kind: "phraseRule", preferred: "规范甲", forbidden: ["禁用甲"] }]);
    const [second] = proposalGates([{ kind: "phraseRule", preferred: "规范乙", forbidden: ["禁用乙"] }]);
    await Promise.all([firstStore.add([first]), secondStore.add([second])]);
    const snapshot = await firstStore.getSnapshot();
    assert.equal(snapshot.revision, 2);
    assert.equal(snapshot.gates.length, 2);
    await assert.rejects(firstStore.remove(first.id, 1), TerminologyRevisionConflictError);
    assert.equal((await firstStore.getSnapshot()).revision, 2);
  });

  it("拒绝无行为的非缩写规则和畸形 Agent 草案", () => {
    assert.throws(() => validateTerminologyProposal({
      intent: "规则",
      operations: [{ kind: "symbolUnit", preferred: "MPa", forbidden: [], scope: "document", severity: "block" }]
    }), /至少一个明确/u);
    assert.throws(() => validateTerminologyGates([{}]), /id/u);
  });
});

interface ProposalGateInput {
  kind: TerminologyGate["kind"];
  preferred: string;
  forbidden: string[];
  scope?: TerminologyGate["scope"];
  severity?: TerminologyGate["severity"];
}

function proposalGates(values: readonly ProposalGateInput[]): TerminologyGate[] {
  return validateTerminologyProposal({
    intent: "测试规则",
    operations: values.map((value) => ({ scope: "document", severity: "block", ...value })),
    note: "测试"
  }).operations;
}

async function makeTemporaryProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-terminology-"));
  temporaryDirectories.push(root);
  return root;
}
