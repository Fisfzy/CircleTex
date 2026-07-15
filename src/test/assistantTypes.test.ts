import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AssistantUnavailableError,
  assistantLabel,
  normalizeAssistantId
} from "../assistantTypes";

describe("AI 助手配置", () => {
  it("识别 Snow，并将未知配置回退到 Codex", () => {
    assert.equal(normalizeAssistantId("snow"), "snow");
    assert.equal(normalizeAssistantId("codex"), "codex");
    assert.equal(normalizeAssistantId("unknown"), "codex");
    assert.equal(normalizeAssistantId(undefined), "codex");
  });

  it("提供稳定的助手名称和人工交接信息", () => {
    assert.equal(assistantLabel("codex"), "Codex CLI");
    assert.equal(assistantLabel("snow"), "Snow CLI");
    const error = new AssistantUnavailableError("局部任务", "snow");
    assert.equal(error.assistantId, "snow");
    assert.equal(error.assistantName, "Snow CLI");
    assert.equal(error.taskText, "局部任务");
  });
});
