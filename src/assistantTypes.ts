import { CodexResult, SourceMapping } from "./types";

export type AssistantId = "codex" | "snow";

export function assistantLabel(assistantId: AssistantId): string {
  return assistantId === "snow" ? "Snow CLI" : "Codex CLI";
}

export function normalizeAssistantId(value: unknown): AssistantId {
  return value === "snow" ? "snow" : "codex";
}

export interface RevisionAdapter {
  generateReplacement(
    projectRoot: string,
    mapping: SourceMapping,
    instruction: string,
    onOutput?: (text: string) => void
  ): Promise<CodexResult>;
  generateTerminologyProposal?(
    projectRoot: string,
    instruction: string,
    onOutput?: (text: string) => void
  ): Promise<unknown>;
}

export class AssistantUnavailableError extends Error {
  public readonly assistantName: string;

  public constructor(
    public readonly taskText: string,
    public readonly assistantId: AssistantId
  ) {
    const assistantName = assistantLabel(assistantId);
    super(`未检测到可调用的 ${assistantName}。修改任务已准备好，可复制到相应的 AI 助手中执行。`);
    this.name = "AssistantUnavailableError";
    this.assistantName = assistantName;
  }
}
