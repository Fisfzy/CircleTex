import * as vscode from "vscode";
import {
  AssistantId,
  assistantLabel,
  normalizeAssistantId,
  RevisionAdapter
} from "./assistantTypes";
import { CodexAdapter } from "./codex";
import { SnowAdapter } from "./snow";

export interface SelectedAssistant {
  id: AssistantId;
  name: string;
  adapter: RevisionAdapter;
}

export function selectedAssistantId(): AssistantId {
  const configured = vscode.workspace.getConfiguration("circletex").get<string>("aiAssistant", "codex");
  return normalizeAssistantId(configured);
}

export function createSelectedAssistant(): SelectedAssistant {
  const configuration = vscode.workspace.getConfiguration("circletex");
  const id = normalizeAssistantId(configuration.get<string>("aiAssistant", "codex"));
  const adapter = id === "snow"
    ? new SnowAdapter(configuration.get<string>("snowCommand", "snow"))
    : new CodexAdapter(configuration.get<string>("codexCommand", "codex"));
  return { id, name: assistantLabel(id), adapter };
}

export async function openAssistantSidebar(assistantId: AssistantId): Promise<boolean> {
  const command = assistantId === "snow" ? "snow-cli.focusSidebar" : "chatgpt.openSidebar";
  try {
    await vscode.commands.executeCommand(command);
    return true;
  } catch {
    return false;
  }
}
