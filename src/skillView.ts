import * as path from "node:path";
import * as vscode from "vscode";
import { SkillRegistry } from "./skillRegistry";
import {
  ImportedSkill,
  SkillInputPreset,
  SkillPackageInspection,
  SkillPermissionProfile,
  SkillScope,
  SkillTaskHistoryEntry,
  SkillTaskType
} from "./skillTypes";

export class CircleTexSkillProvider implements vscode.TreeDataProvider<ImportedSkill> {
  private readonly changeEmitter = new vscode.EventEmitter<ImportedSkill | undefined>();
  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly registry: SkillRegistry) {}

  public refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  public getTreeItem(skill: ImportedSkill): vscode.TreeItem {
    const item = new vscode.TreeItem(skill.displayName, vscode.TreeItemCollapsibleState.None);
    item.id = skill.id;
    item.description = `${skill.enabled ? "已启用" : "已停用"} · ${taskTypeLabel(skill.permissions.taskType)}`;
    item.iconPath = new vscode.ThemeIcon(skill.enabled ? "extensions" : "circle-slash");
    item.contextValue = skill.enabled ? "circletexSkillEnabled" : "circletexSkillDisabled";
    item.tooltip = new vscode.MarkdownString(skillTooltip(skill));
    item.command = {
      command: "circletex.showSkillDetails",
      title: "查看 Skill 详情",
      arguments: [skill]
    };
    return item;
  }

  public getChildren(): ImportedSkill[] {
    return this.registry.list();
  }
}

export async function chooseSkillDirectory(defaultUri?: vscode.Uri): Promise<string | undefined> {
  const selected = await vscode.window.showOpenDialog({
    title: "CircleTeX：选择包含 SKILL.md 的文件夹",
    defaultUri,
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "检查 Skill"
  });
  return selected?.[0]?.fsPath;
}

export async function configureAndConfirmSkill(
  inspection: SkillPackageInspection,
  previous?: SkillPermissionProfile,
  replacing?: ImportedSkill
): Promise<SkillPermissionProfile | undefined> {
  const taskType = await pickValue<SkillTaskType>(
    "CircleTeX：选择 Skill 任务类型",
    "首版仅允许生成分析报告或独立产物，不能修改论文正文。",
    [
      { value: "artifact", label: "生成产物", detail: "生成 DOCX、Markdown、JSON 等独立文件" },
      { value: "analysis", label: "分析任务", detail: "生成论文审阅、检查或分析报告" }
    ],
    previous?.taskType
  );
  if (!taskType) return undefined;

  const scope = await pickValue<SkillScope>(
    "CircleTeX：选择任务范围",
    "决定执行时是否需要 PDF 选区。",
    [
      { value: "document", label: "整篇论文", detail: "无需 PDF 选区，只使用论文输入快照" },
      { value: "selection", label: "PDF 选区", detail: "必须先在 PDF 中选择内容" },
      { value: "either", label: "整篇或选区", detail: "执行时可根据当前选区决定范围" }
    ],
    previous?.scope
  );
  if (!scope) return undefined;

  const inputPreset = await pickValue<SkillInputPreset>(
    "CircleTeX：选择输入快照",
    "CircleTeX 只会复制所选输入，不会向 Agent 暴露真实论文目录。",
    [
      { value: "document", label: "正文与 PDF", detail: "只复制 main.tex 和 main.pdf" },
      { value: "document-resources", label: "正文、PDF 与资源", detail: "再复制 figures 及根目录中的参考文献、样式和图片" }
    ],
    previous?.inputPreset
  );
  if (!inputPreset) return undefined;

  const extensionText = await vscode.window.showInputBox({
    title: "CircleTeX：批准输出类型",
    prompt: "输入允许发布的文件扩展名，以逗号分隔。",
    value: (previous?.outputExtensions ?? defaultExtensions(taskType)).join(", "),
    placeHolder: ".md, .docx, .json",
    ignoreFocusOut: true,
    validateInput: (value) => validateExtensionInput(value)
  });
  if (extensionText === undefined) return undefined;
  const outputExtensions = parseExtensions(extensionText);

  const commandText = await vscode.window.showInputBox({
    title: "CircleTeX：声明外部命令",
    prompt: "列出 Skill 可能调用的命令，以逗号分隔；不需要命令时留空。",
    value: previous?.declaredCommands.join(", ") ?? "",
    placeHolder: "pandoc, python",
    ignoreFocusOut: true,
    validateInput: validateCommandInput
  });
  if (commandText === undefined) return undefined;
  const declaredCommands = splitList(commandText);

  const timeoutText = await vscode.window.showInputBox({
    title: "CircleTeX：设置任务超时",
    prompt: "输入 1 至 60 分钟。",
    value: String(previous?.timeoutMinutes ?? 15),
    ignoreFocusOut: true,
    validateInput: (value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= 1 && parsed <= 60 ? undefined : "请输入 1 至 60 之间的整数。";
    }
  });
  if (timeoutText === undefined) return undefined;

  const permissions: SkillPermissionProfile = {
    taskType,
    scope,
    inputPreset,
    outputExtensions,
    declaredCommands,
    network: false,
    supportedAgents: ["codex"],
    timeoutMinutes: Number(timeoutText)
  };
  const changed = replacing && (replacing.hash !== inspection.hash || !samePermissions(replacing.permissions, permissions));
  const action = await vscode.window.showWarningMessage(
    replacing ? `确认更新外部 Skill“${inspection.displayName}”？` : `确认导入外部 Skill“${inspection.displayName}”？`,
    {
      modal: true,
      detail: permissionSummary(inspection, permissions, Boolean(changed))
    },
    replacing ? "确认更新并授权" : "确认导入并授权"
  );
  const expected = replacing ? "确认更新并授权" : "确认导入并授权";
  return action === expected ? permissions : undefined;
}

export function showSkillDetails(skill: ImportedSkill): Thenable<string | undefined> {
  return vscode.window.showInformationMessage(
    `CircleTeX Skill：${skill.displayName}`,
    {
      modal: true,
      detail: [
        skill.description,
        "",
        `状态：${skill.enabled ? "已启用" : "已停用"}`,
        `任务类型：${taskTypeLabel(skill.permissions.taskType)}`,
        `任务范围：${scopeLabel(skill.permissions.scope)}`,
        `输入快照：${inputPresetLabel(skill.permissions.inputPreset)}`,
        `输出类型：${skill.permissions.outputExtensions.join("、")}`,
        `声明命令：${skill.permissions.declaredCommands.join("、") || "无"}`,
        "网络：禁止",
        "Agent：仅 Codex",
        `超时：${skill.permissions.timeoutMinutes} 分钟`,
        `Skill 文件：${skill.inspection.fileCount} 个，${formatBytes(skill.inspection.totalBytes)}`,
        `内容哈希：${skill.hash}`,
        `来源：${skill.sourcePath}`
      ].join("\n")
    },
    "关闭"
  );
}

export async function showSkillHistory(registry: SkillRegistry, skillId?: string): Promise<void> {
  const history = registry.recentHistory().filter((entry) => !skillId || entry.skillId === skillId);
  if (history.length === 0) {
    void vscode.window.showInformationMessage("CircleTeX：当前没有 Skill 任务记录。");
    return;
  }
  const picks = history.map((entry) => historyPick(entry));
  const selected = await vscode.window.showQuickPick(picks, {
    title: "CircleTeX：Skill 任务历史",
    placeHolder: "选择记录查看详情",
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!selected) return;
  const entry = selected.entry;
  const action = await vscode.window.showInformationMessage(
    `${entry.skillName}：${statusLabel(entry.status)}`,
    {
      modal: true,
      detail: [
        `开始时间：${formatDate(entry.startedAt)}`,
        `完成时间：${formatDate(entry.finishedAt)}`,
        `Agent：${entry.agent}`,
        `摘要：${entry.summary}`,
        entry.error ? `错误：${entry.error}` : "",
        `产物：${entry.artifacts.map((item) => item.relativePath).join("、") || "无"}`,
        `提示词：${entry.prompt}`
      ].filter(Boolean).join("\n")
    },
    ...(entry.publishedDirectory ? ["在资源管理器中显示"] : [])
  );
  if (action === "在资源管理器中显示" && entry.publishedDirectory) {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(entry.publishedDirectory));
  }
}

function permissionSummary(
  inspection: SkillPackageInspection,
  permissions: SkillPermissionProfile,
  changed: boolean
): string {
  return [
    inspection.description,
    "",
    changed ? "检测到 Skill 内容或权限变化，需要重新授权。" : "请核对下列权限后再导入。",
    `任务类型：${taskTypeLabel(permissions.taskType)}`,
    `任务范围：${scopeLabel(permissions.scope)}`,
    `输入快照：${inputPresetLabel(permissions.inputPreset)}`,
    `允许输出：${permissions.outputExtensions.join("、")}`,
    `声明命令：${permissions.declaredCommands.join("、") || "无"}`,
    "网络访问：禁止",
    "支持 Agent：仅 Codex",
    `超时：${permissions.timeoutMinutes} 分钟`,
    `文件：${inspection.fileCount} 个，${formatBytes(inspection.totalBytes)}`,
    `脚本：${inspection.scriptFiles.join("、") || "无"}`,
    "",
    "Skill 将复制到 CircleTeX 扩展存储。执行时使用论文副本，不允许直接修改或编译真实 main.tex/main.pdf。"
  ].join("\n");
}

function skillTooltip(skill: ImportedSkill): string {
  return [
    `**${skill.displayName}**`,
    "",
    skill.description,
    "",
    `任务范围：${scopeLabel(skill.permissions.scope)}`,
    `输出：${skill.permissions.outputExtensions.join("、")}`,
    `来源：${skill.sourcePath}`
  ].join("\n\n");
}

async function pickValue<T extends string>(
  title: string,
  placeHolder: string,
  options: Array<{ value: T; label: string; detail: string }>,
  current?: T
): Promise<T | undefined> {
  const selected = await vscode.window.showQuickPick(
    options.map((option) => ({
      ...option,
      description: option.value === current ? "当前授权" : undefined
    })),
    { title, placeHolder, ignoreFocusOut: true }
  );
  return selected?.value;
}

function parseExtensions(value: string): string[] {
  return [...new Set(splitList(value).map((item) => item.toLowerCase()).map((item) => item.startsWith(".") ? item : `.${item}`))];
}

function validateExtensionInput(value: string): string | undefined {
  const parsed = parseExtensions(value);
  if (parsed.length < 1 || parsed.length > 16) return "请输入 1 至 16 个扩展名。";
  return parsed.every((item) => /^\.[a-z0-9]{1,12}$/.test(item)) ? undefined : "扩展名只能包含小写字母和数字，例如 .md、.docx。";
}

function validateCommandInput(value: string): string | undefined {
  const parsed = splitList(value);
  if (parsed.length > 32) return "最多声明 32 个命令。";
  return parsed.every((item) => /^[A-Za-z0-9._+-]{1,80}$/.test(item)) ? undefined : "命令名只能包含字母、数字、点、下划线、加号和连字符。";
}

function splitList(value: string): string[] {
  return [...new Set(value.split(/[,，;；\n]/).map((item) => item.trim()).filter(Boolean))];
}

function defaultExtensions(taskType: SkillTaskType): string[] {
  return taskType === "analysis" ? [".md"] : [".md", ".docx"];
}

function samePermissions(left: SkillPermissionProfile, right: SkillPermissionProfile): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function taskTypeLabel(value: SkillTaskType): string {
  return value === "analysis" ? "分析任务" : "生成产物";
}

function scopeLabel(value: SkillScope): string {
  return value === "document" ? "整篇论文" : value === "selection" ? "PDF 选区" : "整篇或选区";
}

function inputPresetLabel(value: SkillInputPreset): string {
  return value === "document" ? "main.tex 与 main.pdf" : "正文、PDF 与论文资源";
}

function statusLabel(value: SkillTaskHistoryEntry["status"]): string {
  return value === "completed" ? "已完成" : value === "cancelled" ? "已取消" : "失败";
}

function historyPick(entry: SkillTaskHistoryEntry): vscode.QuickPickItem & { entry: SkillTaskHistoryEntry } {
  return {
    entry,
    label: `$(${entry.status === "completed" ? "pass" : entry.status === "cancelled" ? "circle-slash" : "error"}) ${entry.skillName}`,
    description: `${statusLabel(entry.status)} · ${formatDate(entry.finishedAt)}`,
    detail: entry.error || entry.summary
  };
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function sourceDirectoryUri(skill: ImportedSkill): vscode.Uri {
  return vscode.Uri.file(path.dirname(path.join(skill.sourcePath, "SKILL.md")));
}
