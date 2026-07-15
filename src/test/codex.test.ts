import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCodexTask, parseJsonResponse, validateCodexResult } from "../codex";
import { SourceMapping } from "../types";

describe("Codex 结构化返回", () => {
  it("解析纯 JSON 和代码围栏", () => {
    assert.deepEqual(parseJsonResponse('{"summary":"压缩表述","replacement":"正文\\n"}'), {
      summary: "压缩表述",
      replacement: "正文\n"
    });
    assert.deepEqual(parseJsonResponse('```json\n{"summary":"修改","replacement":"文本"}\n```'), {
      summary: "修改",
      replacement: "文本"
    });
  });

  it("拒绝字段缺失、空字符和异常长文本", () => {
    assert.throws(() => validateCodexResult({ summary: "说明" }, 10));
    assert.throws(() => validateCodexResult({ summary: "说明", replacement: "a\0b" }, 10));
    assert.throws(() => validateCodexResult({ summary: "说明", replacement: "x".repeat(20_001) }, 10));
    assert.throws(() => validateCodexResult({ summary: "x".repeat(241), replacement: "正文" }, 10));
    assert.throws(() => validateCodexResult({ summary: "无效\0摘要", replacement: "正文" }, 10));
  });

  it("将摘要压缩为单行", () => {
    assert.deepEqual(validateCodexResult({ summary: "压缩  \n 表述", replacement: "正文" }, 10), {
      summary: "压缩 表述",
      replacement: "正文"
    });
  });

  it("提示词不会在只读上下文中重复选中源码", () => {
    const mapping = {
      startLine: 2,
      endLine: 2,
      contextStartLine: 1,
      sourceText: "选中正文\n",
      contextText: "前文\n选中正文\n后文\n",
      selection: { page: 1, text: "选中正文" }
    } as SourceMapping;
    const task = buildCodexTask(mapping, "压缩表述");
    assert.match(task, /<selected_source>\n选中正文\n+<\/selected_source>/);
    assert.match(task, /<context_before>\n前文\n/);
    assert.match(task, /<context_after>\n后文\n/);
    assert.doesNotMatch(task.match(/<context_before>[\s\S]*?<\/context_before>/)?.[0] ?? "", /选中正文/);
    assert.doesNotMatch(task.match(/<context_after>[\s\S]*?<\/context_after>/)?.[0] ?? "", /选中正文/);
  });
});
