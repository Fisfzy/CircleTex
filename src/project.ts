import * as path from "node:path";
import * as vscode from "vscode";
import { isFile } from "./fsUtils";
import { ProjectPaths } from "./types";

export { isFile } from "./fsUtils";

export async function resolveProject(
  context: vscode.ExtensionContext
): Promise<ProjectPaths | undefined> {
  const configured = vscode.workspace.getConfiguration("circletex").get<string>("projectRoot")?.trim();
  const workspaceRoots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const candidates = uniquePaths([
    configured,
    ...workspaceRoots,
    ...workspaceRoots.map((root) => path.dirname(root)),
    path.dirname(context.extensionUri.fsPath)
  ]);

  for (const root of candidates) {
    if (await isFile(path.join(root, "main.tex"))) {
      return projectPaths(root);
    }
  }
  return undefined;
}

export function projectPaths(root: string): ProjectPaths {
  return {
    root,
    tex: path.join(root, "main.tex"),
    pdf: path.join(root, "main.pdf"),
    syncTex: path.join(root, "main.synctex.gz")
  };
}

export async function chooseProjectRoot(): Promise<string | undefined> {
  const selection = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "选择包含 main.tex 的目录"
  });
  return selection?.[0]?.fsPath;
}

function uniquePaths(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    const resolved = path.resolve(value);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(resolved);
    }
  }
  return result;
}
