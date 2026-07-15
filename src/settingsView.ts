import * as vscode from "vscode";
import { AssistantId, assistantLabel, normalizeAssistantId } from "./assistantTypes";

interface SettingsItem {
  label: string;
  description?: string;
  command: string;
  icon: string;
  tooltip: string;
}

type ManualEditMode = "direct" | "tracked";

export class CircleTexSettingsProvider implements vscode.TreeDataProvider<SettingsItem> {
  private readonly changeEmitter = new vscode.EventEmitter<SettingsItem | undefined>();
  private resource?: vscode.Uri;
  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public setResource(resource: vscode.Uri | undefined): void {
    if (this.resource?.toString() === resource?.toString()) {
      return;
    }
    this.resource = resource;
    this.refresh();
  }

  public refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  public getTreeItem(setting: SettingsItem): vscode.TreeItem {
    const item = new vscode.TreeItem(setting.label, vscode.TreeItemCollapsibleState.None);
    item.description = setting.description;
    item.iconPath = new vscode.ThemeIcon(setting.icon);
    item.command = {
      command: setting.command,
      title: setting.label
    };
    item.tooltip = setting.tooltip;
    return item;
  }

  public getChildren(): SettingsItem[] {
    const configuration = vscode.workspace.getConfiguration("circletex", this.resource);
    const configured = configuration.get<string>("aiAssistant", "codex");
    const assistant: AssistantId = normalizeAssistantId(configured);
    const configuredManualMode = configuration.get<string>("manualEditMode", "direct");
    const manualMode: ManualEditMode = configuredManualMode === "tracked" ? "tracked" : "direct";
    return [
      {
        label: "AI 助手",
        description: assistantLabel(assistant),
        command: "circletex.selectAssistant",
        icon: "sparkle",
        tooltip: "选择 CircleTeX 使用的 AI 助手"
      },
      {
        label: "PDF 编辑模式",
        description: manualMode === "direct" ? "直接编辑" : "保留修订痕迹",
        command: "circletex.selectManualEditMode",
        icon: manualMode === "direct" ? "edit" : "diff",
        tooltip: manualMode === "direct"
          ? "直接写入干净 LaTeX，编译后的 PDF 不保留修订标记"
          : "使用红色新增和删除线保留 CircleTeX 修订痕迹"
      },
      {
        label: "查看编译日志",
        command: "circletex.showOutput",
        icon: "output",
        tooltip: "打开 CircleTeX 编译日志"
      }
    ];
  }
}
