import * as path from "node:path";
import * as vscode from "vscode";
import { selectedAssistantId } from "./assistant";
import { AssistantId, assistantLabel } from "./assistantTypes";
import { LatexCompiler } from "./compiler";
import { PreviewContentProvider } from "./previewProvider";
import { clearExecutableCache } from "./processRunner";
import { chooseProjectRoot, isFile, projectPaths, resolveProject } from "./project";
import { ReviewPanel } from "./reviewPanel";
import { CircleTexSettingsProvider } from "./settingsView";
import { SkillRegistry } from "./skillRegistry";
import { readSkillPermissionManifest } from "./skillManifest";
import { CodexSkillRunner, DeterministicSkillRunner, SkillTaskService } from "./skillTask";
import {
  chooseSkillDirectory,
  CircleTexSkillProvider,
  configureAndConfirmSkill,
  showSkillDetails,
  showSkillHistory,
  sourceDirectoryUri
} from "./skillView";
import { ImportedSkill } from "./skillTypes";
import { CircleTexStartProvider } from "./startView";
import { ProjectPaths } from "./types";

type ManualEditMode = "direct" | "tracked";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("CircleTeX");
  const compiler = new LatexCompiler();
  const previewProvider = new PreviewContentProvider();
  const startProvider = new CircleTexStartProvider();
  const settingsProvider = new CircleTexSettingsProvider();
  const skillRegistry = new SkillRegistry(path.join(context.globalStorageUri.fsPath, "skill-registry"));
  const skillTaskService = new SkillTaskService(
    skillRegistry,
    (command, skill) => skill.id === "tex-to-mathtype-word"
      ? new DeterministicSkillRunner()
      : new CodexSkillRunner(command)
  );
  const skillProvider = new CircleTexSkillProvider(skillRegistry);
  let activePanel: ReviewPanel | undefined;
  let skillInitializationError: unknown;
  const skillReady = skillRegistry.initialize().then(
    async () => {
      await installBundledSkills(context, skillRegistry, output);
      skillProvider.refresh();
      activePanel?.updateSkills();
    },
    (error) => {
      skillInitializationError = error;
      output.appendLine(`[Skill] 初始化失败：${errorMessage(error)}`);
    }
  );
  const skillsAvailable = async (): Promise<boolean> => {
    await skillReady;
    if (!skillInitializationError) return true;
    void vscode.window.showErrorMessage(`CircleTeX Skill 管理器不可用：${errorMessage(skillInitializationError)}`);
    return false;
  };
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.name = "CircleTeX";
  statusBar.text = "$(book) CircleTeX";
  statusBar.tooltip = "打开 CircleTeX PDF 论文审阅";
  statusBar.command = "circletex.openPdfReview";
  statusBar.show();
  void resolveProject(context).then((project) => {
    settingsProvider.setResource(project ? projectResource(project) : undefined);
  }, () => undefined);

  context.subscriptions.push(
    output,
    statusBar,
    previewProvider,
    vscode.window.createTreeView("circletex.start", { treeDataProvider: startProvider }),
    vscode.window.createTreeView("circletex.settings", { treeDataProvider: settingsProvider }),
    vscode.window.createTreeView("circletex.skills", { treeDataProvider: skillProvider }),
    vscode.workspace.registerTextDocumentContentProvider("circletex-preview", previewProvider),
    vscode.commands.registerCommand("circletex.selectAssistant", async () => {
      const current = selectedAssistantId();
      const picks: Array<vscode.QuickPickItem & { id: AssistantId }> = [
        {
          id: "codex",
          label: "Codex CLI",
          description: current === "codex" ? "当前使用" : undefined,
          detail: "通过只读沙箱生成结构化局部修订建议"
        },
        {
          id: "snow",
          label: "Snow CLI",
          description: current === "snow" ? "当前使用" : undefined,
          detail: "通过隔离 ACP 会话生成结构化局部修订建议"
        }
      ];
      const selected = await vscode.window.showQuickPick(picks, {
        title: "CircleTeX：选择 AI 助手",
        placeHolder: "选择用于分析局部修订的 AI 助手"
      });
      if (!selected || selected.id === current) {
        return;
      }
      await vscode.workspace.getConfiguration("circletex").update(
        "aiAssistant",
        selected.id,
        vscode.ConfigurationTarget.Global
      );
      settingsProvider.refresh();
      activePanel?.updateAssistant();
      vscode.window.setStatusBarMessage(`CircleTeX 已切换到 ${assistantLabel(selected.id)}`, 4_000);
    }),
    vscode.commands.registerCommand("circletex.selectManualEditMode", async () => {
      const project = activePanel && !activePanel.isDisposed
        ? projectPaths(activePanel.projectRoot)
        : await resolveProject(context);
      const resource = project ? projectResource(project) : undefined;
      settingsProvider.setResource(resource);
      const configuration = vscode.workspace.getConfiguration("circletex", resource);
      const configured = configuration.get<string>("manualEditMode", "direct");
      const current: ManualEditMode = configured === "tracked" ? "tracked" : "direct";
      const picks: Array<vscode.QuickPickItem & { id: ManualEditMode }> = [
        {
          id: "direct",
          label: "直接编辑",
          description: current === "direct" ? "当前使用" : undefined,
          detail: "编译前显示临时提示，写入干净 LaTeX，最终 PDF 不保留红色或删除线"
        },
        {
          id: "tracked",
          label: "保留修订痕迹",
          description: current === "tracked" ? "当前使用" : undefined,
          detail: "写入 CircleTeX 修订宏，随后可接受或拒绝全部修订"
        }
      ];
      const selected = await vscode.window.showQuickPick(picks, {
        title: "CircleTeX：选择 PDF 编辑模式",
        placeHolder: "选择手动编辑写入 main.tex 的方式"
      });
      if (!selected || selected.id === current) {
        return;
      }
      await configuration.update("manualEditMode", selected.id, configurationTargetForResource(resource));
      vscode.window.setStatusBarMessage(
        `CircleTeX 已切换到${selected.id === "direct" ? "直接编辑" : "保留修订痕迹"}模式`,
        4_000
      );
    }),
    vscode.commands.registerCommand("circletex.showOutput", () => output.show()),
    vscode.commands.registerCommand("circletex.importSkill", async () => {
      if (!(await skillsAvailable())) return;
      const source = await chooseSkillDirectory();
      if (!source) return;
      try {
        const inspection = await skillRegistry.inspect(source);
        const existing = skillRegistry.get(inspection.id);
        const permissions = await configureAndConfirmSkill(inspection, existing?.permissions, existing);
        if (!permissions) return;
        const imported = await skillRegistry.import(inspection, permissions);
        skillProvider.refresh();
        activePanel?.updateSkills();
        void vscode.window.showInformationMessage(`CircleTeX 已导入 Skill：${imported.displayName}`);
      } catch (error) {
        void vscode.window.showErrorMessage(`CircleTeX：${errorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand("circletex.updateSkill", async (value?: ImportedSkill) => {
      if (!(await skillsAvailable())) return;
      const skill = await resolveSkillArgument(skillRegistry, value);
      if (!skill) return;
      const source = await chooseSkillDirectory(sourceDirectoryUri(skill));
      if (!source) return;
      try {
        const inspection = await skillRegistry.inspect(source);
        if (inspection.id !== skill.id) {
          throw new Error(`所选 Skill 标识为 ${inspection.id}，与待更新的 ${skill.id} 不一致。`);
        }
        const permissions = await configureAndConfirmSkill(inspection, skill.permissions, skill);
        if (!permissions) return;
        const updated = await skillRegistry.import(inspection, permissions);
        skillProvider.refresh();
        activePanel?.updateSkills();
        void vscode.window.showInformationMessage(`CircleTeX 已更新 Skill：${updated.displayName}`);
      } catch (error) {
        void vscode.window.showErrorMessage(`CircleTeX：${errorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand("circletex.toggleSkill", async (value?: ImportedSkill) => {
      if (!(await skillsAvailable())) return;
      const skill = await resolveSkillArgument(skillRegistry, value);
      if (!skill) return;
      await skillRegistry.setEnabled(skill.id, !skill.enabled);
      skillProvider.refresh();
      activePanel?.updateSkills();
      vscode.window.setStatusBarMessage(`CircleTeX 已${skill.enabled ? "停用" : "启用"} ${skill.displayName}`, 4_000);
    }),
    vscode.commands.registerCommand("circletex.removeSkill", async (value?: ImportedSkill) => {
      if (!(await skillsAvailable())) return;
      const skill = await resolveSkillArgument(skillRegistry, value);
      if (!skill) return;
      const action = await vscode.window.showWarningMessage(
        `确认从 CircleTeX 移除 Skill“${skill.displayName}”？`,
        { modal: true, detail: "将删除 CircleTeX 管理的 Skill 快照；原始外部目录和已有任务产物不受影响。" },
        "确认移除"
      );
      if (action !== "确认移除") return;
      await skillRegistry.remove(skill.id);
      skillProvider.refresh();
      activePanel?.updateSkills();
    }),
    vscode.commands.registerCommand("circletex.showSkillDetails", async (value?: ImportedSkill) => {
      if (!(await skillsAvailable())) return;
      const skill = await resolveSkillArgument(skillRegistry, value);
      if (skill) await showSkillDetails(skill);
    }),
    vscode.commands.registerCommand("circletex.showSkillHistory", async (value?: ImportedSkill) => {
      if (!(await skillsAvailable())) return;
      const skill = value && typeof value.id === "string" ? skillRegistry.get(value.id) : undefined;
      await showSkillHistory(skillRegistry, skill?.id);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("circletex.aiAssistant")) {
        settingsProvider.refresh();
        activePanel?.updateAssistant();
      }
      const activeResource = activePanel && !activePanel.isDisposed
        ? vscode.Uri.file(path.join(activePanel.projectRoot, "main.tex"))
        : undefined;
      if (event.affectsConfiguration("circletex.manualEditMode", activeResource)) {
        settingsProvider.refresh();
        activePanel?.updateManualEditMode();
      }
      if (
        event.affectsConfiguration("circletex.codexCommand") ||
        event.affectsConfiguration("circletex.snowCommand")
      ) {
        clearExecutableCache();
      }
    }),
    vscode.commands.registerCommand("circletex.configureProject", async () => {
      const root = await chooseProjectRoot();
      if (!root) {
        return;
      }
      const project = projectPaths(root);
      if (!(await isFile(project.tex))) {
        void vscode.window.showErrorMessage("所选目录不包含 main.tex。");
        return;
      }
      const resource = projectResource(project);
      await vscode.workspace.getConfiguration("circletex", resource).update(
        "projectRoot",
        root,
        configurationTargetForResource(resource)
      );
      settingsProvider.setResource(resource);
      if (activePanel && !samePath(activePanel.projectRoot, root)) {
        activePanel.close();
        activePanel = undefined;
      }
      void vscode.window.showInformationMessage(`CircleTeX 已关联论文项目：${root}`);
    }),
    vscode.commands.registerCommand("circletex.openPdfReview", async () => {
      const openStartedAt = Date.now();
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showErrorMessage("当前工作区不受信任，CircleTeX 不会打开本地论文或运行工具。");
        return;
      }
      const project = await requireProject(context);
      if (!project) {
        return;
      }
      settingsProvider.setResource(projectResource(project));
      try {
        await compiler.recoverInterruptedPublish(project.root, (text) => output.append(text));
      } catch (error) {
        void vscode.window.showErrorMessage(`CircleTeX：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!(await isFile(project.pdf))) {
        const action = await vscode.window.showWarningMessage("未找到 main.pdf。是否现在编译论文？", "编译");
        if (action !== "编译" || !(await compileWithoutPanel(project, compiler, output))) {
          return;
        }
      }
      if (activePanel && !activePanel.isDisposed && samePath(activePanel.projectRoot, project.root)) {
        activePanel.reveal();
        return;
      }
      activePanel?.close();
      activePanel = new ReviewPanel(
        context,
        project,
        output,
        compiler,
        previewProvider,
        skillRegistry,
        skillTaskService
      );
      output.appendLine(`[耗时] PDF 审阅窗口创建：${((Date.now() - openStartedAt) / 1_000).toFixed(2)} 秒。`);
      context.subscriptions.push(activePanel);
    }),
    vscode.commands.registerCommand("circletex.compileDocument", async () => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showErrorMessage("当前工作区不受信任，CircleTeX 已禁用外部编译命令。");
        return;
      }
      const project = await requireProject(context);
      if (!project) {
        return;
      }
      settingsProvider.setResource(projectResource(project));
      if (activePanel && !activePanel.isDisposed && samePath(activePanel.projectRoot, project.root)) {
        await activePanel.compileAndRefresh();
      } else {
        await compileWithoutPanel(project, compiler, output);
      }
    })
  );
}

async function resolveSkillArgument(registry: SkillRegistry, value?: ImportedSkill): Promise<ImportedSkill | undefined> {
  if (value && typeof value.id === "string") {
    return registry.get(value.id);
  }
  const skills = registry.list();
  if (skills.length === 0) {
    void vscode.window.showErrorMessage("CircleTeX：尚未导入外部 Skill。");
    return undefined;
  }
  const selected = await vscode.window.showQuickPick(
    skills.map((skill) => ({
      label: skill.displayName,
      description: skill.enabled ? "已启用" : "已停用",
      detail: skill.description,
      skill
    })),
    { title: "CircleTeX：选择 Skill", placeHolder: "选择要操作的 Skill" }
  );
  return selected?.skill;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/\\/g, "/");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function projectResource(project: ProjectPaths): vscode.Uri {
  return vscode.Uri.file(project.tex);
}

function configurationTargetForResource(resource: vscode.Uri | undefined): vscode.ConfigurationTarget {
  if (resource && vscode.workspace.getWorkspaceFolder(resource)) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  return vscode.workspace.workspaceFolders
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

async function requireProject(context: vscode.ExtensionContext): Promise<ProjectPaths | undefined> {
  const project = await resolveProject(context);
  if (!project) {
    const action = await vscode.window.showErrorMessage(
      "未找到包含 main.tex 的论文项目。",
      "选择项目目录"
    );
    if (action === "选择项目目录") {
      await vscode.commands.executeCommand("circletex.configureProject");
    }
    return undefined;
  }
  return project;
}

async function compileWithoutPanel(
  project: ProjectPaths,
  compiler: LatexCompiler,
  output: vscode.OutputChannel
): Promise<boolean> {
  const passes = vscode.workspace.getConfiguration("circletex", projectResource(project)).get<number>("compilePasses", 2);
  output.clear();
  try {
    const ensureSourceSaved = (): void => {
      const document = vscode.workspace.textDocuments.find((item) => samePath(item.uri.fsPath, project.tex));
      if (document?.isDirty) {
        throw new Error("main.tex 存在未保存修改，请先保存并重新编译。");
      }
    };
    ensureSourceSaved();
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "CircleTeX 正在编译论文" },
      () => compiler.compile(project, passes, (text) => output.append(text), ensureSourceSaved)
    );
    const warningText = result.warnings.length ? `，发现 ${result.warnings.length} 项警告` : "";
    vscode.window.setStatusBarMessage(`CircleTeX：${result.passes} 遍编译完成${warningText}`, 5_000);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`CircleTeX：${message}`, "查看日志").then((action) => {
      if (action === "查看日志") {
        output.show();
      }
    });
    return false;
  }
}

export function deactivate(): void {}

async function installBundledSkills(
  context: vscode.ExtensionContext,
  registry: SkillRegistry,
  output: vscode.OutputChannel
): Promise<void> {
  const root = vscode.Uri.joinPath(context.extensionUri, "bundled-skills").fsPath;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await import("node:fs/promises").then((fs) => fs.readdir(root, { withFileTypes: true }));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(root, entry.name);
    const permissions = await readSkillPermissionManifest(source);
    if (!permissions) continue;
    const inspection = await registry.inspect(source);
    const existing = registry.get(inspection.id);
    if (!existing || existing.hash !== inspection.hash || JSON.stringify(existing.permissions) !== JSON.stringify(permissions)) {
      await registry.import(inspection, permissions);
      output.appendLine(`[Skill] 已安装内置 Skill：${inspection.displayName}`);
    }
  }
}
