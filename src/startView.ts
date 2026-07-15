import * as vscode from "vscode";

interface StartAction {
  label: string;
  description: string;
  command: string;
  icon: string;
}

export class CircleTexStartProvider implements vscode.TreeDataProvider<StartAction> {
  private readonly actions: StartAction[] = [
    {
      label: "打开 PDF 审阅",
      description: "划选文字并发起修订",
      command: "circletex.openPdfReview",
      icon: "open-preview"
    },
    {
      label: "编译论文",
      description: "预检并执行 XeLaTeX",
      command: "circletex.compileDocument",
      icon: "run-all"
    },
    {
      label: "选择论文项目",
      description: "关联 main.tex 所在目录",
      command: "circletex.configureProject",
      icon: "folder-opened"
    }
  ];

  public getTreeItem(action: StartAction): vscode.TreeItem {
    const item = new vscode.TreeItem(action.label, vscode.TreeItemCollapsibleState.None);
    item.description = action.description;
    item.iconPath = new vscode.ThemeIcon(action.icon);
    item.command = {
      command: action.command,
      title: action.label
    };
    item.tooltip = action.description;
    return item;
  }

  public getChildren(): StartAction[] {
    return this.actions;
  }
}
