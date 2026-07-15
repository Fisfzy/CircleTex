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
import { CircleTexStartProvider } from "./startView";
import { ProjectPaths } from "./types";

type ManualEditMode = "direct" | "tracked";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("CircleTeX");
  const compiler = new LatexCompiler();
  const previewProvider = new PreviewContentProvider();
  const startProvider = new CircleTexStartProvider();
  const settingsProvider = new CircleTexSettingsProvider();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.name = "CircleTeX";
  statusBar.text = "$(book) CircleTeX";
  statusBar.tooltip = "打开 CircleTeX PDF 论文审阅";
  statusBar.command = "circletex.openPdfReview";
  statusBar.show();
  let activePanel: ReviewPanel | undefined;
  void resolveProject(context).then((project) => {
    settingsProvider.setResource(project ? projectResource(project) : undefined);
  }, () => undefined);

  context.subscriptions.push(
    output,
    statusBar,
    previewProvider,
    vscode.window.createTreeView("circletex.start", { treeDataProvider: startProvider }),
    vscode.window.createTreeView("circletex.settings", { treeDataProvider: settingsProvider }),
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
      activePanel = new ReviewPanel(context, project, output, compiler, previewProvider);
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
