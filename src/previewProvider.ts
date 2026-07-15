import * as vscode from "vscode";

export class PreviewContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly content = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.emitter.event;

  public set(id: string, value: string): vscode.Uri {
    const uri = vscode.Uri.parse(`circletex-preview:/main.tex?id=${encodeURIComponent(id)}`);
    this.content.set(uri.toString(), value);
    this.emitter.fire(uri);
    return uri;
  }

  public delete(uri: vscode.Uri): void {
    this.content.delete(uri.toString());
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? "";
  }

  public dispose(): void {
    this.content.clear();
    this.emitter.dispose();
  }
}
