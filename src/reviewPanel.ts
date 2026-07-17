import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  hashNormalizedText,
  hasSameNormalizedText,
  normalizeLineEndings,
  resolveApplyRange,
  ResolvedApplyRange,
  RevisionSnapshot
} from "./applyRange";
import { createSelectedAssistant, openAssistantSidebar, selectedAssistantId } from "./assistant";
import { AssistantId, assistantLabel, AssistantUnavailableError } from "./assistantTypes";
import { CompileProgress, CompilePublishValidator, CompileResult, LatexCompiler } from "./compiler";
import {
  applyDirectDocumentEdits,
  isPendingImageEdit,
  PendingDocumentEdit,
  validateNoOverlappingDocumentEdits
} from "./documentEdits";
import { isFile } from "./fsUtils";
import {
  chooseImageCandidatesByMappedLines,
  createImageEditTarget,
  createPendingImageEdit,
  findImageEditCandidates,
  formatImageCandidateValue,
  ImageEditTarget,
  validateImageSelectionConsistency
} from "./imageEditResolver";
import {
  acceptAllCircleTeXRevisions,
  applyManualEdits,
  createPendingCaretManualEdit,
  createPendingManualEdit,
  hasCircleTeXRevisions,
  ManualEditCaretAmbiguityError,
  ManualEditKind,
  ManualEditAmbiguityError,
  NormalizedManualEditRect,
  PendingManualEdit,
  rejectAllCircleTeXRevisions,
} from "./manualEdits";
import { PreviewContentProvider } from "./previewProvider";
import { RegionEditAmbiguityError } from "./regionEditResolver";
import { parsePdfImageSelectionPayload, parsePdfSelectionPayload } from "./selectionPayload";
import { SkillRegistry } from "./skillRegistry";
import { SkillTaskService } from "./skillTask";
import { ImportedSkill, SkillTaskResult } from "./skillTypes";
import { buildSourceMapping, SyncTexLocator } from "./synctex";
import { computeLineStarts } from "./textRange";
import { ProjectPaths, RevisionCandidate, SourceMapping } from "./types";

type WebviewMessage = Record<string, unknown> & { type: string };
type ManualEditMode = "direct" | "tracked";

export class ReviewPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly locator = new SyncTexLocator();
  private mapping?: SourceMapping;
  private candidate?: RevisionCandidate;
  private previewUri?: vscode.Uri;
  private manualPreviewUri?: vscode.Uri;
  private readonly pendingManualEdits: PendingDocumentEdit[] = [];
  private readonly redoManualEdits: PendingDocumentEdit[] = [];
  private imageEditTarget?: ImageEditTarget;
  private imageSelectionSequence = 0;
  private pendingManualEditMode?: ManualEditMode;
  private manualQueueVersion = 0;
  private manualTask?: string;
  private manualTaskMappingId?: string;
  private manualAssistantId?: AssistantId;
  private manualAssistantName?: string;
  private sessionId?: string;
  private selectionRequestId?: string;
  private rangeRequestId?: string;
  private confirmedMappingId?: string;
  private selectionSequence = 0;
  private rangeSequence = 0;
  private analysisSequence = 0;
  private activeAnalysisId?: number;
  private activeSkillTask?: { controller: AbortController; skillId: string };
  private lastSkillResult?: SkillTaskResult;
  private applying = false;
  private disposed = false;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly project: ProjectPaths,
    private readonly output: vscode.OutputChannel,
    private readonly compiler: LatexCompiler,
    private readonly previewProvider: PreviewContentProvider,
    private readonly skillRegistry: SkillRegistry,
    private readonly skillTaskService: SkillTaskService
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "circletex.pdfReview",
      "CircleTeX PDF 审阅",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
          vscode.Uri.file(path.dirname(project.pdf)),
          vscode.Uri.joinPath(context.globalStorageUri, "pdf-previews")
        ]
      }
    );
    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message), undefined, context.subscriptions);
    this.panel.onDidDispose(() => this.dispose(), undefined, context.subscriptions);
  }

  public reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  public get projectRoot(): string {
    return this.project.root;
  }

  public close(): void {
    if (!this.disposed) {
      this.panel.dispose();
    }
  }

  public updateAssistant(): void {
    const assistantId = selectedAssistantId();
    this.manualTask = undefined;
    this.manualTaskMappingId = undefined;
    this.manualAssistantId = undefined;
    this.manualAssistantName = undefined;
    this.post({ type: "assistantChanged", assistantName: assistantLabel(assistantId) });
  }

  public updateManualEditMode(): void {
    const configuredMode = this.configuredManualEditMode();
    const queueMode = this.manualEditModeForQueue();
    if (!this.applying && !this.hasManualEditHistory()) {
      this.clearManualPreview();
    }
    this.post({
      type: "manualEditModeChanged",
      manualEditMode: queueMode,
      configuredManualEditMode: configuredMode,
      modeLocked: this.hasManualEditHistory()
    });
    if (this.hasManualEditHistory() && configuredMode !== queueMode) {
      this.post({
        type: "notice",
        message: `当前队列仍按${queueMode === "direct" ? "直接编辑" : "保留修订痕迹"}模式处理；新设置将在队列清空后生效。`
      });
    }
    this.sendManualEditsState();
  }

  public updateSkills(): void {
    this.post({ type: "skillsChanged", skills: skillsForWebview(this.skillRegistry.list()) });
  }

  public async compileAndRefresh(fromApply = false): Promise<void> {
    this.requireTrustedWorkspace();
    if (this.activeSkillTask) {
      this.post({ type: "notice", message: "Skill 任务正在使用论文输入快照，请等待任务完成或先取消任务。无需为 Skill 任务编译论文。" });
      return;
    }
    if (this.applying && !fromApply) {
      throw new Error("正在应用修订，暂时不能启动编译。");
    }
    if (!fromApply && this.pendingManualEdits.length > 0) {
      if (await this.discardStaleManualEditsBeforeCompile()) {
        return;
      }
      try {
        await this.applyPendingManualEditsAndCompile();
      } catch (error) {
        const message = errorMessage(error);
        this.post({ type: "error", action: "compile", message });
        this.showCompileError(message);
      }
      return;
    }
    this.output.clear();
    this.postCompileProgress({ percent: 0, message: "正在校验论文源码" });
    this.post({ type: "busy", action: "compile", message: "正在预检并编译论文……" });
    try {
      await this.ensureSourceSaved();
      this.invalidateRevisionSession();
      const result = await this.runCompileCore(() => this.ensureSourceSaved());
      this.postCompiled(result.warnings);
      await this.sendTrackedRevisionState();
    } catch (error) {
      const message = errorMessage(error);
      this.post({ type: "error", action: "compile", message });
      this.showCompileError(message);
    }
  }

  /**
   * 手动修改 main.tex 后，旧 PDF 编辑不能安全重放；允许用户明确放弃队列后继续编译。
   */
  private async discardStaleManualEditsBeforeCompile(): Promise<boolean> {
    await this.ensureSourceSaved();
    const source = await fs.readFile(this.project.tex, "utf8");
    if (!this.pendingManualEdits.some((edit) => edit.baseDocumentHash !== sha256(source))) {
      return false;
    }
    const queueVersion = this.manualQueueVersion;
    const editCount = this.pendingManualEdits.length + this.redoManualEdits.length;
    const action = await vscode.window.showWarningMessage(
      "main.tex 已在 PDF 手动编辑建立后发生变化。为避免把旧选区写入错误位置，不能继续提交该队列。",
      { modal: true, detail: `可放弃 ${editCount} 项过期编辑，直接编译当前 main.tex。` },
      "放弃过期编辑并编译"
    );
    if (action !== "放弃过期编辑并编译") {
      this.sendManualEditsState();
      return true;
    }
    if (this.manualQueueVersion !== queueVersion) {
      throw new Error("手动编辑队列在确认期间发生了变化，未放弃过期队列。");
    }
    this.pendingManualEdits.splice(0);
    this.redoManualEdits.splice(0);
    this.releaseManualEditMode();
    this.manualQueueVersion += 1;
    this.clearManualPreview();
    this.post({
      type: "manualEditsCleared",
      edits: [],
      count: 0,
      queueVersion: this.manualQueueVersion,
      canUndo: false,
      canRedo: false,
      manualEditMode: this.manualEditModeForQueue(),
      configuredManualEditMode: this.configuredManualEditMode(),
      modeLocked: false
    });
    this.post({ type: "notice", message: "已放弃过期 PDF 手动编辑，正在编译当前 main.tex。" });
    return false;
  }

  private async runCompileCore(validateBeforePublish?: CompilePublishValidator): Promise<CompileResult> {
    const passes = this.projectConfiguration().get<number>("compilePasses", 2);
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "CircleTeX 正在编译论文" },
      () => this.compiler.compile(
        this.project,
        passes,
        (text) => this.output.append(text),
        validateBeforePublish,
        (progress) => this.postCompileProgress(progress)
      )
    );
  }

  private showCompileError(message: string): void {
    void vscode.window.showErrorMessage(`CircleTeX：${message}`, "查看日志").then((action) => {
      if (action === "查看日志") {
        this.output.show();
      }
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.analysisSequence += 1;
    this.activeSkillTask?.controller.abort();
    this.activeSkillTask = undefined;
    if (this.previewUri) {
      this.previewProvider.delete(this.previewUri);
    }
    if (this.manualPreviewUri) {
      this.previewProvider.delete(this.manualPreviewUri);
    }
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!isMessage(value)) {
      return;
    }
    try {
      if (value.type === "performance") {
        this.recordWebviewPerformance(value);
        return;
      }
      if (value.type === "cachePdfPreview") {
        try {
          await this.cachePdfPreview(value);
        } catch (error) {
          this.output.appendLine(`[PDF 预览缓存] ${errorMessage(error)}`);
        }
        return;
      }
      if (this.activeSkillTask && [
        "analyze",
        "apply",
        "compile",
        "queueManualEdit",
        "locateImage",
        "queueImageEdit",
        "undoManualEdit",
        "redoManualEdit",
        "removeManualEdit",
        "clearManualEdits",
        "resolveTrackedRevisions"
      ].includes(value.type)) {
        throw new Error("Skill 任务正在运行，请等待任务完成或先取消任务。");
      }
      if (this.applying) {
        throw new Error("正在应用修订，请等待当前操作完成。");
      }
      switch (value.type) {
        case "ready":
          this.post({ type: "project", root: this.project.root });
          this.updateAssistant();
          this.updateSkills();
          this.sendManualEditsState();
          await this.sendTrackedRevisionState();
          break;
        case "selection":
          await this.mapPdfSelection(value);
          break;
        case "clearSession":
          this.clearSessionFromWebview(value);
          break;
        case "requestSelectionDetail":
          this.sendSelectionDetail(value);
          break;
        case "requestSourceDetail":
          await this.sendSourceDetail(value);
          break;
        case "adjustRange":
          await this.adjustRange(value);
          break;
        case "confirmRange":
          await this.confirmRange(value);
          break;
        case "openSource":
          await this.openSource(value);
          break;
        case "analyze":
          await this.analyze(value);
          break;
        case "runSkillTask":
          await this.runSkillTask(value);
          break;
        case "cancelSkillTask":
          this.cancelSkillTask();
          break;
        case "openSkillArtifact":
          await this.openSkillArtifact(value);
          break;
        case "showDiff":
          await this.showDiff(value);
          break;
        case "apply":
          await this.applyCandidate(value);
          break;
        case "discard":
          this.discardCandidate(value);
          break;
        case "compile":
          if (this.pendingManualEdits.length > 0) {
            this.requireManualQueueVersion(value);
          }
          await this.compileAndRefresh();
          break;
        case "queueManualEdit":
          await this.queueManualEdit(value);
          break;
        case "locateImage":
          await this.locateImage(value);
          break;
        case "queueImageEdit":
          await this.queueImageEdit(value);
          break;
        case "undoManualEdit":
          this.undoManualEdit(value);
          break;
        case "redoManualEdit":
          this.redoManualEdit(value);
          break;
        case "removeManualEdit":
          this.removeManualEdit(value);
          break;
        case "showManualEditsDiff":
          await this.showPendingManualEditsDiff(value);
          break;
        case "clearManualEdits":
          await this.clearManualEdits(value);
          break;
        case "resolveTrackedRevisions":
          await this.resolveTrackedRevisions(value);
          break;
        case "manualHandoff":
          await this.manualHandoff(value);
          break;
      }
    } catch (error) {
      if (this.shouldReportError(value)) {
        this.post({
          type: "error",
          action: value.type,
          requestId: stringValue(value.requestId),
          sessionId: stringValue(value.sessionId),
          message: errorMessage(error)
        });
      }
    }
  }

  private async mapPdfSelection(message: WebviewMessage): Promise<void> {
    this.requireTrustedWorkspace();
    if (this.applying) {
      throw new Error("正在应用修订，暂时不能建立新选区。");
    }
    const requestId = boundedIdentifier(message.requestId, "选区请求");
    const sessionId = randomUUID();
    const sequence = ++this.selectionSequence;
    this.rangeSequence += 1;
    this.analysisSequence += 1;
    this.activeAnalysisId = undefined;
    this.clearCandidate();
    this.sessionId = sessionId;
    this.selectionRequestId = requestId;
    this.rangeRequestId = undefined;
    this.mapping = undefined;
    this.confirmedMappingId = undefined;
    this.manualTask = undefined;
    this.manualTaskMappingId = undefined;
    this.manualAssistantId = undefined;
    this.manualAssistantName = undefined;
    this.post({ type: "busy", action: "mapping", requestId, sessionId, message: "正在定位 LaTeX 源码……" });
    try {
      const selection = parsePdfSelectionPayload(message);
      await this.ensureArtifactsCurrent();
      await this.ensureSourceSaved();
      if (!this.isCurrentSession(sessionId, sequence)) {
        return;
      }
      const contextLines = this.projectConfiguration().get<number>("contextLines", 20);
      const mappingStartedAt = Date.now();
      const mapping = await this.locator.mapSelection(this.project, selection, contextLines);
      this.output.appendLine(`[耗时] SyncTeX 选区定位：${((Date.now() - mappingStartedAt) / 1_000).toFixed(2)} 秒。`);
      if (!this.isCurrentSession(sessionId, sequence)) {
        return;
      }
      this.mapping = mapping;
      this.postMapping(mapping, sessionId, requestId);
    } catch (error) {
      if (this.isCurrentSession(sessionId, sequence)) {
        throw error;
      }
    }
  }

  private async adjustRange(message: WebviewMessage): Promise<void> {
    const { sessionId, mapping } = this.requireActiveMapping(message);
    const sequence = this.selectionSequence;
    const requestId = boundedIdentifier(message.requestId, "范围调整请求");
    const rangeSequence = ++this.rangeSequence;
    this.rangeRequestId = requestId;
    this.analysisSequence += 1;
    this.activeAnalysisId = undefined;
    const startLine = positiveInteger(message.startLine, "起始行");
    const endLine = positiveInteger(message.endLine, "结束行");
    const contextLines = this.projectConfiguration().get<number>("contextLines", 20);
    const adjusted = await buildSourceMapping(
      this.project.tex,
      mapping.selection,
      startLine,
      endLine,
      contextLines
    );
    if (this.applying) {
      throw new Error("正在应用已有修订，已取消本次源码范围调整。");
    }
    if (
      !this.isCurrentSession(sessionId, sequence) ||
      this.mapping !== mapping ||
      this.rangeSequence !== rangeSequence ||
      this.rangeRequestId !== requestId
    ) {
      return;
    }
    adjusted.requiresConfirmation = true;
    adjusted.confidenceNote = "源码范围已手动调整，请核对并确认后再分析。";
    this.clearCandidate();
    this.mapping = adjusted;
    this.confirmedMappingId = undefined;
    this.manualTask = undefined;
    this.manualTaskMappingId = undefined;
    this.manualAssistantId = undefined;
    this.manualAssistantName = undefined;
    this.postMapping(adjusted, sessionId, requestId);
  }

  private sendSelectionDetail(message: WebviewMessage): void {
    const { sessionId, mapping } = this.requireActiveMapping(message);
    this.post({
      type: "selectionDetail",
      requestId: boundedIdentifier(message.requestId, "选区详情请求"),
      sessionId,
      mappingId: mapping.id,
      selectionKind: mapping.selection.kind,
      interactionMode: mapping.selection.interactionMode,
      interactionVersion: mapping.selection.interactionVersion,
      text: mapping.selection.text
    });
  }

  private async sendSourceDetail(message: WebviewMessage): Promise<void> {
    const { sessionId, mapping } = this.requireActiveMapping(message);
    await this.ensureMappingCurrent(mapping);
    if (this.sessionId !== sessionId || this.mapping !== mapping) {
      return;
    }
    this.post({
      type: "sourceDetail",
      requestId: boundedIdentifier(message.requestId, "源码详情请求"),
      sessionId,
      mappingId: mapping.id,
      startLine: mapping.startLine,
      endLine: mapping.endLine,
      sourceText: mapping.sourceText,
      requiresConfirmation: Boolean(mapping.requiresConfirmation),
      confidenceNote: mapping.confidenceNote
    });
  }

  private async confirmRange(message: WebviewMessage): Promise<void> {
    const { sessionId, mapping } = this.requireActiveMapping(message);
    await this.ensureMappingCurrent(mapping);
    if (this.sessionId !== sessionId || this.mapping !== mapping) {
      return;
    }
    this.confirmedMappingId = mapping.id;
    this.post({
      type: "rangeConfirmed",
      requestId: boundedIdentifier(message.requestId, "范围确认请求"),
      sessionId,
      mappingId: mapping.id
    });
  }

  private async queueManualEdit(message: WebviewMessage): Promise<void> {
    this.requireTrustedWorkspace();
    const { sessionId, mapping } = this.requireActiveMapping(message);
    const requestId = boundedIdentifier(message.requestId, "手动修订请求");
    const queueVersion = this.requireManualQueueVersion(message);
    const queueMode = this.manualEditModeForQueue();
    if (this.activeAnalysisId !== undefined) {
      throw new Error("AI 分析正在进行，暂时不能加入手动修订。");
    }
    if (this.candidate) {
      throw new Error("已有 AI 修订建议，请先应用或放弃后再加入手动修订。");
    }
    if (mapping.requiresConfirmation && this.confirmedMappingId !== mapping.id) {
      throw new Error("该源码范围需要核对，请先展开“源码范围”并确认。");
    }
    const kind = manualEditKind(message.kind);
    if (mapping.selection.kind === "region" && kind !== "replace" && kind !== "delete") {
      throw new Error("区域直接编辑只支持替换整个区域或删除整个区域。");
    }
    if (typeof message.text !== "string" || message.text.length > 2_000) {
      throw new Error("新增或替换文字不能超过 2000 个字符。");
    }
    const rects = manualEditRects(message.rects);
    await this.ensureSourceSaved();
    await this.ensureMappingCurrent(mapping);
    if (
      this.disposed ||
      this.sessionId !== sessionId ||
      this.mapping !== mapping ||
      this.manualQueueVersion !== queueVersion
    ) {
      throw new Error("选区或手动修订队列在定位期间发生了变化，请重试。");
    }
    if (
      queueMode === "direct" &&
      hasCircleTeXRevisions(await fs.readFile(this.project.tex, "utf8"))
    ) {
      throw new Error("main.tex 中仍有 CircleTeX 修订标记。请先接受或拒绝现有修订，再开始直接编辑。");
    }
    if (
      this.pendingManualEdits.length > 0 &&
      this.pendingManualEdits[0].baseDocumentHash !== mapping.documentHash
    ) {
      throw new Error("main.tex 已与待提交修订的基线不一致，请先清空旧修订并重新选择。");
    }
    const caretVisibleOffset = optionalCaretVisibleOffset(message.caretVisibleOffset);
    const caretDeleteDirection = optionalCaretDeleteDirection(message.caretDeleteDirection);
    if (mapping.selection.kind === "region" && (caretVisibleOffset !== undefined || caretDeleteDirection !== undefined)) {
      throw new Error("区域直接编辑不接受光标偏移或方向删除参数。");
    }
    let edit: PendingManualEdit;
    if (caretVisibleOffset !== undefined) {
      if (kind === "replace") {
        throw new Error("光标编辑不支持替换操作；请先划选需要替换的文字。");
      }
      if (kind === "delete" && !caretDeleteDirection) {
        throw new Error("光标删除必须指定向前删除或向后删除。");
      }
      if (kind !== "delete" && caretDeleteDirection) {
        throw new Error("只有光标删除操作可以指定删除方向。");
      }
      try {
        edit = createPendingCaretManualEdit(
          mapping,
          kind,
          message.text,
          caretVisibleOffset,
          rects,
          undefined,
          caretDeleteDirection
        );
      } catch (error) {
        if (!(error instanceof ManualEditCaretAmbiguityError)) throw error;
        const resolvedCaretOffset = await this.locator.disambiguateCaretOffset(
          this.project,
          mapping,
          error.candidates
        );
        edit = createPendingCaretManualEdit(
          mapping,
          kind,
          message.text,
          caretVisibleOffset,
          rects,
          undefined,
          caretDeleteDirection,
          resolvedCaretOffset
        );
      }
    } else {
      if (caretDeleteDirection) {
        throw new Error("缺少光标位置，不能执行方向删除。");
      }
      try {
        edit = createPendingManualEdit(mapping, kind, message.text, rects);
      } catch (error) {
        if (!(error instanceof ManualEditAmbiguityError) && !(error instanceof RegionEditAmbiguityError)) {
          throw error;
        }
        const resolvedRange = await this.locator.disambiguateManualEditRange(
          this.project,
          mapping,
          error.candidates
        );
        edit = createPendingManualEdit(mapping, kind, message.text, rects, undefined, resolvedRange);
      }
    }
    if (queueMode === "tracked" && edit.structuralFormula) {
      throw new Error("完整公式结构删除只支持直接编辑模式。请切换为直接编辑后重新框选，或交给 Agent 处理。");
    }
    validateNoOverlappingDocumentEdits([...this.pendingManualEdits, edit]);
    this.pendingManualEditMode ??= queueMode;
    this.pendingManualEdits.push(edit);
    this.redoManualEdits.splice(0);
    this.manualQueueVersion += 1;
    this.clearManualPreview();
    this.post({
      type: "manualEditQueued",
      requestId,
      edit: manualEditForWebview(edit),
      count: this.pendingManualEdits.length,
      queueVersion: this.manualQueueVersion,
      canUndo: true,
      canRedo: false,
      manualEditMode: this.manualEditModeForQueue()
    });
  }

  private async locateImage(message: WebviewMessage): Promise<void> {
    this.requireTrustedWorkspace();
    if (this.activeAnalysisId !== undefined || this.candidate) {
      throw new Error("AI 修订会话正在使用源码，请先结束后再调整图片。");
    }
    const requestId = boundedIdentifier(message.requestId, "图片定位请求");
    const sequence = ++this.imageSelectionSequence;
    this.imageEditTarget = undefined;
    const selection = parsePdfImageSelectionPayload(message);
    this.post({ type: "busy", action: "locateImage", requestId, message: "正在检查 PDF 与 SyncTeX 定位信息……" });
    await this.ensureArtifactsCurrent();
    await this.ensureSourceSaved();
    this.post({ type: "busy", action: "locateImage", requestId, message: "正在从图片主体反向定位源码……" });
    const records = await this.locator.mapImageSelection(this.project, selection);
    const source = await fs.readFile(this.project.tex, "utf8");
    this.post({ type: "busy", action: "locateImage", requestId, message: "正在筛选对应的图片命令……" });
    let candidates = chooseImageCandidatesByMappedLines(
      await findImageEditCandidates(source, this.project.root),
      records
    );
    if (candidates.length === 0) {
      throw new Error("框选区域附近没有找到受支持的图片命令。首版只支持普通 includegraphics 和简单 subfigure 尺寸。");
    }
    let candidate = candidates[0];
    if (candidates.length > 1) {
      this.post({ type: "busy", action: "locateImage", requestId, message: "检测到多个候选图片，正在按页面位置消歧……" });
      candidate = await this.locator.disambiguateImageCandidate(this.project, candidates, selection);
      candidates = [candidate];
    }
    this.post({ type: "busy", action: "locateImage", requestId, message: "正在生成图片尺寸调整候选……" });
    const forwardRecords = await this.locator.locateImageCandidateViews(this.project, candidate, selection.page);
    const consistency = validateImageSelectionConsistency(selection, forwardRecords);
    if (this.disposed || sequence !== this.imageSelectionSequence) return;
    const currentSource = await fs.readFile(this.project.tex, "utf8");
    if (currentSource !== source) {
      throw new Error("图片定位期间 main.tex 发生了变化，请重新框选图片。");
    }
    const target = createImageEditTarget(candidate, selection, source);
    this.imageEditTarget = target;
    this.post({
      type: "imageEditTarget",
      requestId,
      targetId: target.id,
      page: target.page,
      rects: target.rects,
      roughBounds: selection.roughBounds,
      snappedBounds: selection.bounds,
      pageWidth: selection.pageWidth,
      pageHeight: selection.pageHeight,
      imageObjectName: selection.imageObjectName,
      syncTexBounds: consistency?.syncTexBounds,
      consistencyScore: consistency?.score,
      imagePath: target.imagePath,
      parameter: target.parameter,
      originalValue: target.originalDisplay,
      candidateValue: formatImageCandidateValue(target, 1),
      factor: 1
    });
  }

  private async queueImageEdit(message: WebviewMessage): Promise<void> {
    this.requireTrustedWorkspace();
    const requestId = boundedIdentifier(message.requestId, "图片调整请求");
    const targetId = boundedIdentifier(message.targetId, "图片调整目标");
    const queueVersion = this.requireManualQueueVersion(message);
    const target = this.imageEditTarget;
    if (!target || target.id !== targetId) {
      throw new Error("图片调整目标已失效，请重新框选图片。");
    }
    if (this.pendingManualEditMode === "tracked") {
      throw new Error("图片尺寸调整不能与修订痕迹队列混合。请先应用或清空现有修订。");
    }
    await this.ensureSourceSaved();
    const source = await fs.readFile(this.project.tex, "utf8");
    if (target.baseDocumentHash !== sha256(source)) {
      throw new Error("图片命令在确认前发生了变化，请重新框选图片。");
    }
    if (this.manualQueueVersion !== queueVersion) {
      throw new Error("待编译队列在确认期间发生了变化，请重试。");
    }
    const factor = boundedImageScaleFactor(message.factor);
    const edit = createPendingImageEdit(target, factor);
    validateNoOverlappingDocumentEdits([...this.pendingManualEdits, edit]);
    this.pendingManualEditMode ??= "direct";
    this.pendingManualEdits.push(edit);
    this.redoManualEdits.splice(0);
    this.imageEditTarget = undefined;
    this.manualQueueVersion += 1;
    this.clearManualPreview();
    this.post({
      type: "imageEditQueued",
      requestId,
      edit: manualEditForWebview(edit),
      count: this.pendingManualEdits.length,
      queueVersion: this.manualQueueVersion,
      canUndo: true,
      canRedo: false,
      manualEditMode: this.manualEditModeForQueue()
    });
  }

  private undoManualEdit(message: WebviewMessage): void {
    this.requireManualQueueVersion(message);
    const removed = this.pendingManualEdits.pop();
    if (!removed) {
      this.sendManualEditsState();
      return;
    }
    this.redoManualEdits.push(removed);
    this.manualQueueVersion += 1;
    this.clearManualPreview();
    this.post({
      type: "manualEditRemoved",
      editId: removed.id,
      edits: this.pendingManualEdits.map(manualEditForWebview),
      count: this.pendingManualEdits.length,
      queueVersion: this.manualQueueVersion,
      canUndo: this.pendingManualEdits.length > 0,
      canRedo: true,
      manualEditMode: this.manualEditModeForQueue()
    });
  }

  private redoManualEdit(message: WebviewMessage): void {
    this.requireManualQueueVersion(message);
    const restored = this.redoManualEdits.at(-1);
    if (!restored) {
      this.sendManualEditsState();
      return;
    }
    validateNoOverlappingDocumentEdits([...this.pendingManualEdits, restored]);
    this.redoManualEdits.pop();
    this.pendingManualEdits.push(restored);
    this.manualQueueVersion += 1;
    this.clearManualPreview();
    this.post({
      type: "manualEditRestored",
      edit: manualEditForWebview(restored),
      edits: this.pendingManualEdits.map(manualEditForWebview),
      count: this.pendingManualEdits.length,
      queueVersion: this.manualQueueVersion,
      canUndo: true,
      canRedo: this.redoManualEdits.length > 0,
      manualEditMode: this.manualEditModeForQueue()
    });
  }

  private async clearManualEdits(message: WebviewMessage): Promise<void> {
    const queueVersion = this.requireManualQueueVersion(message);
    if (this.pendingManualEdits.length === 0 && this.redoManualEdits.length === 0) {
      this.sendManualEditsState();
      return;
    }
    const editCount = this.pendingManualEdits.length + this.redoManualEdits.length;
    const action = await vscode.window.showWarningMessage(
      `确认放弃 ${editCount} 项尚未写入 main.tex 的手动编辑及撤销记录？`,
      { modal: true },
      "全部放弃"
    );
    if (action !== "全部放弃") {
      this.sendManualEditsState();
      return;
    }
    if (this.manualQueueVersion !== queueVersion) {
      throw new Error("手动修订队列在确认期间发生了变化，未执行清空。");
    }
    this.pendingManualEdits.splice(0);
    this.redoManualEdits.splice(0);
    this.releaseManualEditMode();
    this.manualQueueVersion += 1;
    this.clearManualPreview();
    this.post({
      type: "manualEditsCleared",
      edits: [],
      count: 0,
      queueVersion: this.manualQueueVersion,
      canUndo: false,
      canRedo: false,
      manualEditMode: this.manualEditModeForQueue()
    });
  }

  private sendManualEditsState(): void {
    this.post({
      type: "manualEditsState",
      edits: this.pendingManualEdits.map(manualEditForWebview),
      count: this.pendingManualEdits.length,
      queueVersion: this.manualQueueVersion,
      canUndo: this.pendingManualEdits.length > 0,
      canRedo: this.redoManualEdits.length > 0,
      manualEditMode: this.manualEditModeForQueue(),
      configuredManualEditMode: this.configuredManualEditMode(),
      modeLocked: this.hasManualEditHistory()
    });
  }

  private hasManualEditHistory(): boolean {
    return this.pendingManualEdits.length > 0 || this.redoManualEdits.length > 0;
  }

  private configuredManualEditMode(): ManualEditMode {
    return currentManualEditMode(this.projectResource());
  }

  private manualEditModeForQueue(): ManualEditMode {
    return this.pendingManualEditMode ?? this.configuredManualEditMode();
  }

  private releaseManualEditMode(): void {
    if (this.hasManualEditHistory()) {
      return;
    }
    this.pendingManualEditMode = undefined;
    const configuredMode = this.configuredManualEditMode();
    this.post({
      type: "manualEditModeChanged",
      manualEditMode: configuredMode,
      configuredManualEditMode: configuredMode,
      modeLocked: false
    });
  }

  private projectResource(): vscode.Uri {
    return vscode.Uri.file(this.project.tex);
  }

  private projectConfiguration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("circletex", this.projectResource());
  }

  private async sendTrackedRevisionState(): Promise<void> {
    const source = await fs.readFile(this.project.tex, "utf8");
    this.post({ type: "trackedRevisionsState", hasTrackedRevisions: hasCircleTeXRevisions(source) });
  }

  private requireManualQueueVersion(message: WebviewMessage): number {
    if (
      typeof message.queueVersion !== "number" ||
      !Number.isInteger(message.queueVersion) ||
      message.queueVersion !== this.manualQueueVersion
    ) {
      throw new Error("手动修订队列版本已变化，请等待界面同步后重试。");
    }
    return message.queueVersion;
  }

  private async analyze(message: WebviewMessage): Promise<void> {
    this.requireTrustedWorkspace();
    const { sessionId, mapping } = this.requireActiveMapping(message);
    const requestId = boundedIdentifier(message.requestId, "分析请求");
    if (this.pendingManualEdits.length > 0) {
      throw new Error("已有待提交的 PDF 手动修订，请先应用并编译或清空后再请求 AI 分析。");
    }
    if (this.activeAnalysisId !== undefined) {
      throw new Error("已有 AI 分析正在进行，请等待当前请求结束。");
    }
    if (mapping.requiresConfirmation && this.confirmedMappingId !== mapping.id) {
      throw new Error("该源码范围需要核对，请展开“源码范围”并确认后再分析。");
    }
    const instruction = boundedString(message.instruction, 1, 4_000, "修改要求");
    const assistant = createSelectedAssistant();
    const analysisId = ++this.analysisSequence;
    this.activeAnalysisId = analysisId;
    try {
      await this.ensureSourceSaved();
      await this.ensureMappingCurrent(mapping);
      if (!this.isCurrentAnalysis(analysisId, sessionId, mapping)) {
        throw new Error("源码范围在分析启动前发生了变化，已取消过期请求。");
      }
      this.post({
        type: "busy",
        action: "analyze",
        requestId,
        sessionId,
        mappingId: mapping.id,
        message: `${assistant.name} 正在分析局部修订……`
      });
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `CircleTeX 正在请求 ${assistant.name}` },
        () => assistant.adapter.generateReplacement(
          this.project.root,
          mapping,
          instruction,
          (text) => this.output.append(text)
        )
      );
      if (!this.isCurrentAnalysis(analysisId, sessionId, mapping)) {
        throw new Error(`源码范围在 ${assistant.name} 分析期间发生了变化，已丢弃过期结果。`);
      }
      const fullText = await fs.readFile(this.project.tex, "utf8");
      if (
        sha256(fullText) !== mapping.documentHash ||
        hashNormalizedText(fullText) !== mapping.normalizedDocumentHash ||
        fullText.slice(mapping.startOffset, mapping.endOffset) !== mapping.sourceText
      ) {
        throw new Error(`main.tex 在 ${assistant.name} 分析期间发生了变化，已丢弃过期结果。`);
      }
      const replacement = preserveLineEnding(result.replacement, mapping.sourceText);
      const candidate: RevisionCandidate = {
        id: randomUUID(),
        mapping: { ...mapping },
        baseText: fullText,
        summary: `已生成 main.tex 第 ${mapping.startLine}--${mapping.endLine} 行的局部修订建议`,
        replacement,
        previewText: fullText.slice(0, mapping.startOffset) + replacement + fullText.slice(mapping.endOffset)
      };
      this.candidate = candidate;
      this.manualTask = undefined;
      this.manualTaskMappingId = undefined;
      this.manualAssistantId = undefined;
      this.manualAssistantName = undefined;
      this.post({
        type: "candidate",
        candidateId: candidate.id,
        sessionId,
        mappingId: candidate.mapping.id,
        summary: candidate.summary
      });
      await this.openCandidateDiff(candidate, true);
    } catch (error) {
      if (error instanceof AssistantUnavailableError) {
        if (!this.isCurrentAnalysis(analysisId, sessionId, mapping)) {
          throw new Error("源码范围在任务准备期间发生了变化，已丢弃过期任务。");
        }
        this.manualTask = error.taskText;
        this.manualTaskMappingId = mapping.id;
        this.manualAssistantId = error.assistantId;
        this.manualAssistantName = error.assistantName;
        this.post({
          type: "manualFallback",
          sessionId,
          mappingId: mapping.id,
          assistantName: error.assistantName,
          message: error.message
        });
        return;
      }
      throw error;
    } finally {
      if (this.activeAnalysisId === analysisId) {
        this.activeAnalysisId = undefined;
      }
    }
  }

  private removeManualEdit(message: WebviewMessage): void {
    this.requireManualQueueVersion(message);
    const editId = boundedIdentifier(message.editId, "待移除编辑");
    const index = this.pendingManualEdits.findIndex((edit) => edit.id === editId);
    if (index < 0) {
      this.sendManualEditsState();
      return;
    }
    this.pendingManualEdits.splice(index, 1);
    this.redoManualEdits.splice(0);
    this.releaseManualEditMode();
    this.manualQueueVersion += 1;
    this.clearManualPreview();
    this.post({
      type: "manualEditRemoved",
      editId,
      edits: this.pendingManualEdits.map(manualEditForWebview),
      count: this.pendingManualEdits.length,
      queueVersion: this.manualQueueVersion,
      canUndo: this.pendingManualEdits.length > 0,
      canRedo: false,
      manualEditMode: this.manualEditModeForQueue(),
      removedFromQueue: true
    });
  }

  private async runSkillTask(message: WebviewMessage): Promise<void> {
    this.requireTrustedWorkspace();
    if (this.activeSkillTask) {
      throw new Error("已有 Skill 任务正在执行，请等待或先取消当前任务。");
    }
    if (this.applying || this.activeAnalysisId !== undefined) {
      throw new Error("当前修订操作尚未完成，暂时不能启动 Skill 任务。");
    }
    if (this.pendingManualEdits.length > 0 || this.candidate) {
      throw new Error("请先应用或清空当前修订，再启动 Skill 任务。");
    }
    const skillId = boundedIdentifier(message.skillId, "Skill");
    const skill = this.skillRegistry.get(skillId);
    if (!skill || !skill.enabled) {
      throw new Error("所选 Skill 不存在或已停用，请刷新后重新选择。");
    }
    const instruction = boundedString(message.instruction, 1, 4_000, "任务提示词");
    const useSelection = booleanValue(message.useSelection);
    let selection;
    if (skill.permissions.scope === "selection" || useSelection) {
      if (!this.mapping || !this.sessionId) {
        throw new Error("该任务需要 PDF 选区，请先选择并定位内容。");
      }
      if (this.mapping.requiresConfirmation && this.confirmedMappingId !== this.mapping.id) {
        throw new Error("该 PDF 选区的源码范围需要先人工确认。");
      }
      selection = this.mapping.selection;
    }
    if (skill.permissions.scope === "document" && useSelection) {
      throw new Error("该 Skill 只支持整篇论文任务。");
    }
    if (!skill.permissions.agentIndependent && selectedAssistantId() !== "codex") {
      throw new Error("首版外部 Skill 任务仅支持 Codex。请在左侧设置中将 AI 助手切换为 Codex 后再执行。");
    }
    await this.ensureSourceSaved();
    if (!(await isFile(this.project.pdf))) {
      throw new Error("未找到 main.pdf，请先手动编译论文。");
    }
    const controller = new AbortController();
    this.activeSkillTask = { controller, skillId: skill.id };
    this.lastSkillResult = undefined;
    this.post({
      type: "skillTaskStarted",
      skillId: skill.id,
      skillName: skill.displayName,
      message: `正在准备 ${skill.displayName} 任务……`
    });
    try {
      const result = await this.skillTaskService.run({
        skill,
        project: this.project,
        prompt: instruction,
        selection,
        sourceRange: selection && this.mapping ? {
          startLine: this.mapping.startLine,
          endLine: this.mapping.endLine,
          sourceText: this.mapping.sourceText
        } : undefined,
        codexCommand: vscode.workspace.getConfiguration("circletex").get<string>("codexCommand", "codex"),
        signal: controller.signal,
        onProgress: (progress) => this.post({ type: "skillTaskProgress", ...progress }),
        onOutput: (text) => this.output.append(text)
      });
      this.lastSkillResult = result;
      if (result.status === "completed") {
        this.post({
          type: "skillTaskCompleted",
          summary: result.summary,
          warnings: result.warnings,
          qualityGates: result.qualityGates,
          publishedDirectory: result.publishedDirectory,
          artifacts: result.artifacts.map((artifact, index) => ({
            index,
            name: artifact.name,
            relativePath: artifact.relativePath,
            type: artifact.type,
            description: artifact.description,
            size: artifact.size
          }))
        });
      } else if (result.status === "cancelled") {
        this.post({ type: "skillTaskCancelled", message: result.summary });
      } else {
        this.post({ type: "skillTaskFailed", message: result.error || result.summary });
      }
    } finally {
      if (this.activeSkillTask?.controller === controller) {
        this.activeSkillTask = undefined;
      }
    }
  }

  private cancelSkillTask(): void {
    if (!this.activeSkillTask) {
      this.post({ type: "notice", message: "当前没有正在运行的 Skill 任务。" });
      return;
    }
    this.activeSkillTask.controller.abort();
    this.post({ type: "skillTaskCancelling", message: "正在取消 Skill 任务……" });
  }

  private async openSkillArtifact(message: WebviewMessage): Promise<void> {
    const index = nonNegativeInteger(message.index, "产物索引");
    const artifact = this.lastSkillResult?.status === "completed" ? this.lastSkillResult.artifacts[index] : undefined;
    if (!artifact) {
      throw new Error("所选 Skill 产物已失效，请从任务历史中查看。");
    }
    const action = stringValue(message.action);
    if (action === "reveal") {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(artifact.absolutePath));
      return;
    }
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(artifact.absolutePath), {
      preview: true,
      preserveFocus: false
    });
  }

  private async showDiff(message: WebviewMessage): Promise<void> {
    const candidate = this.requireCandidate(message);
    await this.openCandidateDiff(candidate, false);
  }

  private async openCandidateDiff(candidate: RevisionCandidate, preserveFocus: boolean): Promise<void> {
    if (this.previewUri) {
      this.previewProvider.delete(this.previewUri);
    }
    this.previewUri = this.previewProvider.set(candidate.id, candidate.previewText);
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.file(this.project.tex),
      this.previewUri,
      `CircleTeX 修订预览：main.tex 第 ${candidate.mapping.startLine}--${candidate.mapping.endLine} 行`,
      {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus
      }
    );
  }

  private async applyPendingManualEditsAndCompile(): Promise<void> {
    if (this.pendingManualEdits.length === 0) {
      return;
    }
    const mode = this.manualEditModeForQueue();
    const queueVersion = this.manualQueueVersion;
    const edits = [...this.pendingManualEdits];
    this.applying = true;
    try {
      const { document, sourceText: originalText } = await this.readSynchronizedSource();
      if (mode === "direct" && hasCircleTeXRevisions(originalText)) {
        throw new Error("main.tex 中仍有 CircleTeX 修订标记。直接编辑不会自动决定这些修订，请先选择“接受全部”或“拒绝全部”。");
      }
      const stagedText = mode === "direct"
        ? applyDirectDocumentEdits(originalText, edits)
        : applyManualEdits(originalText, textOnlyEdits(edits));
      if (mode === "tracked") {
        await this.openManualEditsDiff(stagedText, `修订痕迹预览（${edits.length} 项）`);
        const action = await vscode.window.showWarningMessage(
          `将 ${edits.length} 项带痕迹的 PDF 手动修订写入 main.tex，并立即编译新 PDF。`,
          { modal: true, detail: "新增内容将显示为红色，删除内容将显示为红色中划线。" },
          "应用修订并编译"
        );
        if (action !== "应用修订并编译") {
          this.post({ type: "notice", message: "已取消写入，待提交手动修订仍保留。" });
          return;
        }
      }
      if (
        this.manualQueueVersion !== queueVersion ||
        this.pendingManualEdits.length !== edits.length ||
        this.pendingManualEdits.some((edit, index) => edit.id !== edits[index].id)
      ) {
        throw new Error("手动修订队列在确认期间发生了变化，已取消本次写入。");
      }
      const result = await this.writeAndCompileWithRollback(document, originalText, stagedText);
      this.pendingManualEdits.splice(0);
      this.redoManualEdits.splice(0);
      this.releaseManualEditMode();
      this.manualQueueVersion += 1;
      this.clearManualPreview();
      this.post({
        type: "manualEditsCleared",
        edits: [],
        count: 0,
        queueVersion: this.manualQueueVersion,
        canUndo: false,
        canRedo: false,
        manualEditMode: this.manualEditModeForQueue(),
        configuredManualEditMode: this.configuredManualEditMode(),
        modeLocked: false
      });
      this.postCompiled(result.warnings);
      await this.sendTrackedRevisionState();
    } finally {
      this.applying = false;
    }
  }

  private async showPendingManualEditsDiff(message: WebviewMessage): Promise<void> {
    if (this.pendingManualEdits.length === 0) {
      throw new Error("当前没有待查看的 PDF 手动编辑。");
    }
    const mode = this.manualEditModeForQueue();
    const queueVersion = this.requireManualQueueVersion(message);
    const edits = [...this.pendingManualEdits];
    this.applying = true;
    try {
      const { document, sourceText: originalText } = await this.readSynchronizedSource();
      if (mode === "direct" && hasCircleTeXRevisions(originalText)) {
        throw new Error("main.tex 中仍有 CircleTeX 修订标记。请先接受或拒绝现有修订，再预览直接编辑。");
      }
      const stagedText = mode === "direct"
        ? applyDirectDocumentEdits(originalText, edits)
        : applyManualEdits(originalText, textOnlyEdits(edits));
      if (
        this.manualQueueVersion !== queueVersion ||
        this.pendingManualEdits.length !== edits.length ||
        this.pendingManualEdits.some((edit, index) => edit.id !== edits[index].id)
      ) {
        throw new Error("手动编辑队列在生成差异期间发生了变化，请重试。");
      }
      const title = mode === "direct"
        ? `直接编辑预览（${edits.length} 项，最终 PDF 无修订标记）`
        : `修订痕迹预览（${edits.length} 项）`;
      await this.openManualEditsDiff(stagedText, title);
    } finally {
      this.applying = false;
    }
  }

  private async resolveTrackedRevisions(message: WebviewMessage): Promise<void> {
    this.requireTrustedWorkspace();
    if (this.pendingManualEdits.length > 0) {
      throw new Error("请先应用或清空待提交的 PDF 手动修订。");
    }
    if (this.candidate || this.activeAnalysisId !== undefined) {
      throw new Error("AI 修订会话正在使用源码，请先结束该会话。");
    }
    const mode = message.mode === "accept" ? "accept" : message.mode === "reject" ? "reject" : undefined;
    if (!mode) {
      throw new Error("修订处理方式无效。");
    }
    this.applying = true;
    try {
      const { document, sourceText: originalText } = await this.readSynchronizedSource();
      if (!hasCircleTeXRevisions(originalText)) {
        throw new Error("main.tex 中没有可处理的 CircleTeX 修订标记。");
      }
      const stagedText = mode === "accept"
        ? acceptAllCircleTeXRevisions(originalText)
        : rejectAllCircleTeXRevisions(originalText);
      const label = mode === "accept" ? "接受全部 CircleTeX 修订" : "拒绝全部 CircleTeX 修订";
      await this.openManualEditsDiff(stagedText, label);
      const actionLabel = mode === "accept" ? "接受并编译" : "拒绝并编译";
      const action = await vscode.window.showWarningMessage(
        `${label}，随后重新编译 PDF。`,
        { modal: true },
        actionLabel
      );
      if (action !== actionLabel) {
        this.post({ type: "notice", message: "未处理现有修订标记。" });
        return;
      }
      const result = await this.writeAndCompileWithRollback(document, originalText, stagedText);
      if (this.redoManualEdits.length > 0) {
        this.redoManualEdits.splice(0);
        this.releaseManualEditMode();
        this.manualQueueVersion += 1;
        this.sendManualEditsState();
      }
      this.clearManualPreview();
      this.postCompiled(result.warnings);
      await this.sendTrackedRevisionState();
    } catch (error) {
      this.showCompileError(errorMessage(error));
      throw error;
    } finally {
      this.applying = false;
    }
  }

  private async openManualEditsDiff(previewText: string, title: string): Promise<void> {
    this.clearManualPreview();
    this.manualPreviewUri = this.previewProvider.set(`manual-${randomUUID()}`, previewText);
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.file(this.project.tex),
      this.manualPreviewUri,
      `CircleTeX：${title}`,
      { preview: true, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
    );
  }

  private clearManualPreview(): void {
    if (this.manualPreviewUri) {
      this.previewProvider.delete(this.manualPreviewUri);
      this.manualPreviewUri = undefined;
    }
  }

  private async writeAndCompileWithRollback(
    document: vscode.TextDocument,
    originalText: string,
    stagedText: string
  ): Promise<CompileResult> {
    this.postCompileProgress({ percent: 2, message: "正在创建 main.tex 备份" });
    const backupPath = await createTexBackup(this.project.root, originalText);
    const diskAfterBackup = await fs.readFile(this.project.tex, "utf8");
    if (
      this.disposed ||
      document.isDirty ||
      !hasSameNormalizedText(document.getText(), originalText) ||
      !hasSameNormalizedText(diskAfterBackup, originalText)
    ) {
      throw new Error("创建备份期间 main.tex 发生了变化，未写入手动修订。");
    }

    this.invalidateRevisionSession();
    this.output.clear();
    this.post({ type: "busy", action: "compile", message: "正在写入手动修订并编译论文……" });
    let sourceTouched = false;
    let committedResult: CompileResult | undefined;
    try {
      sourceTouched = true;
      this.postCompileProgress({ percent: 5, message: "正在写入已确认的编辑" });
      await replaceDocumentText(document, stagedText);
      const savedText = await fs.readFile(this.project.tex, "utf8");
      if (
        !hasSameNormalizedText(savedText, stagedText) ||
        !hasSameNormalizedText(document.getText(), stagedText) ||
        document.isDirty
      ) {
        throw new Error("main.tex 保存后的内容与手动修订预览不一致。");
      }
      this.postCompileProgress({ percent: 8, message: "编辑已写入，准备编译" });
      const result = await this.runCompileCore(async () => {
        const commitDiskText = await fs.readFile(this.project.tex, "utf8");
        if (
          this.disposed ||
          document.isDirty ||
          !hasSameNormalizedText(document.getText(), stagedText) ||
          !hasSameNormalizedText(commitDiskText, stagedText)
        ) {
          throw new Error("main.tex 在编译产物提交前发生了变化，已恢复上一版编译产物。");
        }
      });
      committedResult = result;
      let finalResult = result;
      let postCommitWarning: string | undefined;
      try {
        const finalDiskText = await fs.readFile(this.project.tex, "utf8");
        if (
          this.disposed ||
          document.isDirty ||
          !hasSameNormalizedText(document.getText(), stagedText) ||
          !hasSameNormalizedText(finalDiskText, stagedText)
        ) {
          postCommitWarning = "编译产物已提交后检测到 main.tex 又发生了变化；当前 PDF 可能早于源码，请保存源码并重新编译。";
        }
      } catch (error) {
        postCommitWarning = `编译产物已提交，但无法复核 main.tex：${errorMessage(error)} 请确认源码后重新编译。`;
      }
      if (postCommitWarning) {
        finalResult = withCompileWarning(result, postCommitWarning);
        this.reportPostCommitWarning(postCommitWarning);
      }
      try {
        this.output.appendLine(`已应用 PDF 手动修订，源码备份：${backupPath}`);
      } catch {
        // 编译产物已提交，输出面板异常不再触发源码回滚。
      }
      return finalResult;
    } catch (error) {
      if (committedResult) {
        const warning = `编译产物已提交，但提交后处理失败：${errorMessage(error)} 未回滚 main.tex，请保存并重新编译。`;
        this.reportPostCommitWarning(warning);
        return withCompileWarning(committedResult, warning);
      }
      const restored = sourceTouched && await restoreDocumentText(document, originalText, stagedText);
      const baseMessage = errorMessage(error);
      const message = restored
        ? `${baseMessage} main.tex 已恢复，待提交修订仍保留。`
        : `${baseMessage} 未自动覆盖当前源码，请使用备份核对：${backupPath}`;
      this.sendManualEditsState();
      await this.sendTrackedRevisionState().catch(() => undefined);
      throw new Error(message);
    }
  }

  private reportPostCommitWarning(message: string): void {
    try {
      this.output.appendLine(message);
    } catch {
      // 输出面板可能已销毁。
    }
    try {
      this.post({ type: "notice", message });
    } catch {
      // Webview 可能已销毁。
    }
  }

  private postCompileProgress(progress: CompileProgress): void {
    this.post({
      type: "compileProgress",
      percent: progress.percent,
      message: progress.message,
      indeterminate: Boolean(progress.indeterminate)
    });
  }

  private async applyCandidate(message: WebviewMessage): Promise<void> {
    this.requireTrustedWorkspace();
    if (this.applying) {
      throw new Error("修订建议正在应用，请勿重复提交。");
    }
    const candidate = this.requireCandidate(message);
    this.applying = true;
    try {
      await this.ensureSourceSaved();
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(this.project.tex));
      if (document.isDirty) {
        throw new Error("main.tex 存在未保存修改，请先保存后重试。");
      }
      const currentText = document.getText();
      const diskText = await fs.readFile(this.project.tex, "utf8");
      if (hashNormalizedText(diskText) !== hashNormalizedText(currentText)) {
        throw new Error("main.tex 的磁盘内容与编辑器内容不一致，请等待 VS Code 刷新或重新打开文件后重试。");
      }
      if (hashNormalizedText(candidate.baseText) !== candidate.mapping.normalizedDocumentHash) {
        throw new Error("修订建议的基线源码校验失败，请重新请求 AI 分析。");
      }

      const snapshot = revisionSnapshot(candidate);
      const editorRange = resolveApplyRange(snapshot, currentText);
      const diskRange = resolveApplyRange(snapshot, diskText);
      if (this.disposed || this.candidate !== candidate || this.sessionId !== message.sessionId) {
        throw new Error("修订会话在校验期间已结束，未应用本次修改。");
      }
      if (editorRange.mode === "relocated" || diskRange.mode === "relocated") {
        await this.refreshRelocatedCandidate(candidate, diskText, diskRange);
        return;
      }

      const version = document.version;
      const diskHash = sha256(diskText);
      const backupPath = await createTexBackup(this.project.root, diskText);
      const diskTextAfterBackup = await fs.readFile(this.project.tex, "utf8");
      if (
        document.version !== version ||
        document.isDirty ||
        this.disposed ||
        sha256(diskTextAfterBackup) !== diskHash ||
        this.candidate !== candidate ||
        this.sessionId !== message.sessionId ||
        this.mapping?.id !== candidate.mapping.id
      ) {
        throw new Error("创建备份期间 main.tex 或修订会话发生了变化，请重新核对建议。");
      }
      const range = new vscode.Range(
        document.positionAt(editorRange.startOffset),
        document.positionAt(editorRange.endOffset)
      );
      const edit = new vscode.WorkspaceEdit();
      const documentEol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
      const replacement = normalizeLineEndings(candidate.replacement, documentEol);
      const expectedText = currentText.slice(0, editorRange.startOffset) + replacement + currentText.slice(editorRange.endOffset);
      edit.replace(document.uri, range, replacement);
      if (!(await vscode.workspace.applyEdit(edit))) {
        throw new Error("VS Code 未能应用本次修改。");
      }
      const diskTextBeforeSave = await fs.readFile(this.project.tex, "utf8");
      const diskUnchanged = sha256(diskTextBeforeSave) === diskHash;
      const alreadySaved = !document.isDirty &&
        hashNormalizedText(diskTextBeforeSave) === hashNormalizedText(expectedText);
      if (
        document.getText() !== expectedText ||
        this.disposed ||
        this.candidate !== candidate ||
        this.sessionId !== message.sessionId ||
        this.mapping?.id !== candidate.mapping.id ||
        (!diskUnchanged && !alreadySaved)
      ) {
        throw new Error("修改已进入编辑器，但保存前检测到 main.tex 或修订会话发生了变化；请核对编辑器内容。");
      }
      if (!alreadySaved && !(await document.save())) {
        throw new Error("修改已进入编辑器，但 main.tex 保存失败。");
      }
      const savedText = await fs.readFile(this.project.tex, "utf8");
      if (hashNormalizedText(savedText) !== hashNormalizedText(expectedText)) {
        throw new Error("main.tex 保存后的内容与已确认修订不一致，请从备份核对文件。");
      }
      this.output.appendLine(`已应用局部修订，备份：${backupPath}`);
      this.post({ type: "applied", backupPath });
      this.clearCandidate();
      if (this.redoManualEdits.length > 0) {
        this.redoManualEdits.splice(0);
        this.releaseManualEditMode();
        this.manualQueueVersion += 1;
        this.sendManualEditsState();
      }

      const autoCompile = this.projectConfiguration().get<boolean>("autoCompile", true);
      if (autoCompile) {
        await this.compileAndRefresh(true);
      }
    } finally {
      this.applying = false;
    }
  }

  private async refreshRelocatedCandidate(
    candidate: RevisionCandidate,
    diskText: string,
    diskRange: ResolvedApplyRange
  ): Promise<void> {
    const contextLines = this.projectConfiguration().get<number>("contextLines", 20);
    const mapping = relocateMapping(candidate.mapping, diskText, diskRange, contextLines);
    const replacement = preserveLineEnding(candidate.replacement, mapping.sourceText);
    const refreshed: RevisionCandidate = {
      ...candidate,
      id: randomUUID(),
      mapping,
      baseText: diskText,
      replacement,
      summary: `目标外源码已变化，已刷新 main.tex 第 ${mapping.startLine}--${mapping.endLine} 行的修订预览，请再次确认`,
      previewText: diskText.slice(0, mapping.startOffset) + replacement + diskText.slice(mapping.endOffset)
    };
    this.mapping = mapping;
    this.candidate = refreshed;
    this.post({
      type: "candidate",
      candidateId: refreshed.id,
      sessionId: this.sessionId,
      mappingId: refreshed.mapping.id,
      summary: refreshed.summary
    });
    await this.openCandidateDiff(refreshed, true);
    this.post({ type: "notice", message: "检测到目标范围以外的源码变化，差异视图已刷新；请核对后再次点击“应用并保存”。" });
  }

  private async manualHandoff(message: WebviewMessage): Promise<void> {
    const { mapping } = this.requireActiveMapping(message);
    if (
      !this.manualTask ||
      this.manualTaskMappingId !== mapping.id ||
      !this.manualAssistantId ||
      !this.manualAssistantName
    ) {
      throw new Error("当前没有可交接的 AI 任务。");
    }
    await vscode.env.clipboard.writeText(this.manualTask);
    const opened = await openAssistantSidebar(this.manualAssistantId);
    this.post({
      type: "notice",
      message: opened
        ? `任务已复制到剪贴板，请在 ${this.manualAssistantName} 中粘贴发送。`
        : `任务已复制到剪贴板，但未能打开 ${this.manualAssistantName} 侧栏。`
    });
  }

  private async openSource(message: WebviewMessage): Promise<void> {
    const { mapping } = this.requireActiveMapping(message);
    const document = await vscode.workspace.openTextDocument(mapping.sourcePath);
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One, true);
    const range = new vscode.Range(
      new vscode.Position(mapping.startLine - 1, 0),
      document.lineAt(mapping.endLine - 1).range.end
    );
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  private postMapping(mapping: SourceMapping, sessionId: string, requestId: string): void {
    this.post({
      type: "mapping",
      requestId,
      sessionId,
      mappingId: mapping.id,
      selectionKind: mapping.selection.kind,
      page: mapping.selection.page,
      endPage: mapping.selection.kind === "text"
        ? mapping.selection.pageFragments?.at(-1)?.page ?? mapping.selection.page
        : mapping.selection.page,
      selectionLength: mapping.selection.text.length,
      startLine: mapping.startLine,
      endLine: mapping.endLine,
      requiresConfirmation: Boolean(mapping.requiresConfirmation),
      confidenceNote: mapping.confidenceNote
    });
  }

  private discardCandidate(message: WebviewMessage): void {
    this.requireCandidate(message);
    this.clearCandidate();
  }

  private clearSessionFromWebview(message: WebviewMessage): void {
    const requestedSession = stringValue(message.sessionId);
    if (requestedSession && requestedSession === this.sessionId) {
      this.invalidateRevisionSession();
    }
  }

  private clearCandidate(): void {
    const sessionId = this.sessionId;
    const mappingId = this.mapping?.id;
    const candidateId = this.candidate?.id;
    const hadPreview = Boolean(this.previewUri);
    this.candidate = undefined;
    if (this.previewUri) {
      this.previewProvider.delete(this.previewUri);
      this.previewUri = undefined;
    }
    if (candidateId || hadPreview) {
      this.post({ type: "candidateCleared", candidateId, sessionId, mappingId });
    }
  }

  private requireCandidate(message: WebviewMessage): RevisionCandidate {
    if (
      !this.candidate ||
      message.candidateId !== this.candidate.id ||
      message.mappingId !== this.candidate.mapping.id ||
      message.sessionId !== this.sessionId
    ) {
      throw new Error("修订建议已失效，请重新请求 AI 分析。");
    }
    return this.candidate;
  }

  private requireActiveMapping(message: WebviewMessage): { sessionId: string; mapping: SourceMapping } {
    const sessionId = boundedIdentifier(message.sessionId, "修订会话");
    const mappingId = boundedIdentifier(message.mappingId, "源码映射");
    if (sessionId !== this.sessionId || !this.mapping || mappingId !== this.mapping.id) {
      throw new Error("修订会话或源码范围已变化，请重新选择 PDF 文字。");
    }
    return { sessionId, mapping: this.mapping };
  }

  private isCurrentSession(sessionId: string, sequence: number): boolean {
    return !this.disposed && this.sessionId === sessionId && this.selectionSequence === sequence;
  }

  private isCurrentAnalysis(analysisId: number, sessionId: string, mapping: SourceMapping): boolean {
    return !this.disposed &&
      !this.applying &&
      this.activeAnalysisId === analysisId &&
      this.analysisSequence === analysisId &&
      this.sessionId === sessionId &&
      this.mapping === mapping;
  }

  private shouldReportError(message: WebviewMessage): boolean {
    if (message.type === "selection") {
      return Boolean(stringValue(message.requestId));
    }
    if (message.type === "adjustRange") {
      return Boolean(stringValue(message.requestId));
    }
    if (message.type === "queueManualEdit") {
      return Boolean(stringValue(message.requestId));
    }
    if (message.type === "locateImage" || message.type === "queueImageEdit") {
      return Boolean(stringValue(message.requestId));
    }
    const sessionId = stringValue(message.sessionId);
    return !sessionId || sessionId === this.sessionId;
  }

  private invalidateRevisionSession(): void {
    const sessionId = this.sessionId;
    const mappingId = this.mapping?.id;
    this.clearCandidate();
    this.selectionSequence += 1;
    this.rangeSequence += 1;
    this.analysisSequence += 1;
    this.imageSelectionSequence += 1;
    this.imageEditTarget = undefined;
    this.activeAnalysisId = undefined;
    this.sessionId = undefined;
    this.selectionRequestId = undefined;
    this.rangeRequestId = undefined;
    this.mapping = undefined;
    this.confirmedMappingId = undefined;
    this.manualTask = undefined;
    this.manualTaskMappingId = undefined;
    this.manualAssistantId = undefined;
    this.manualAssistantName = undefined;
    if (sessionId) {
      this.post({ type: "sessionCleared", sessionId, mappingId });
    }
  }

  private async ensureArtifactsCurrent(): Promise<void> {
    if (!(await isFile(this.project.pdf)) || !(await isFile(this.project.syncTex))) {
      throw new Error("PDF 或 SyncTeX 文件不存在，请先点击编译按钮。");
    }
    const [tex, pdf, sync] = await Promise.all([
      fs.stat(this.project.tex), fs.stat(this.project.pdf), fs.stat(this.project.syncTex)
    ]);
    if (
      pdf.mtimeMs + 1_000 < tex.mtimeMs ||
      sync.mtimeMs + 1_000 < tex.mtimeMs ||
      sync.mtimeMs + 1_000 < pdf.mtimeMs
    ) {
      throw new Error("PDF 定位信息早于 main.tex，请先重新编译论文。");
    }
  }

  private async ensureSourceSaved(): Promise<void> {
    const document = vscode.workspace.textDocuments.find((item) => sameFilePath(item.uri.fsPath, this.project.tex));
    if (document?.isDirty) {
      throw new Error("main.tex 存在未保存修改，请先保存并重新编译。");
    }
  }

  private async readSynchronizedSource(): Promise<{ document: vscode.TextDocument; sourceText: string }> {
    await this.ensureSourceSaved();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(this.project.tex));
    const sourceText = await fs.readFile(this.project.tex, "utf8");
    if (!hasSameNormalizedText(document.getText(), sourceText)) {
      throw new Error("main.tex 已被外部程序更新，编辑器内容尚未同步。请比较更改后关闭并重新打开该文件，再重新生成批量修订。");
    }
    return { document, sourceText };
  }

  private async ensureMappingCurrent(mapping: SourceMapping): Promise<void> {
    const current = await fs.readFile(this.project.tex, "utf8");
    if (sha256(current) !== mapping.documentHash) {
      throw new Error("main.tex 已发生变化，请重新选择 PDF 文字并定位源码。");
    }
  }

  private requireTrustedWorkspace(): void {
    if (!vscode.workspace.isTrusted) {
      throw new Error("当前工作区不受信任，CircleTeX 已禁用外部进程和文件写入。");
    }
  }

  private recordWebviewPerformance(message: WebviewMessage): void {
    const label = typeof message.label === "string" ? message.label : "";
    const durationMs = typeof message.durationMs === "number" ? message.durationMs : Number.NaN;
    const allowedLabels = new Set([
      "PDF Webview 启动",
      "PDF 文件读取",
      "PDF Worker 解析",
      "PDF 首屏页面壳体",
      "PDF 首屏低清预览",
      "PDF 首屏 Canvas",
      "PDF 首屏文字层",
      "PDF 页面元数据扫描",
      "PDF 当前页渲染",
      "PDF 刷新总计"
    ]);
    if (!allowedLabels.has(label) || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 10 * 60_000) {
      return;
    }
    this.output.appendLine(`[耗时] ${label}：${(durationMs / 1_000).toFixed(2)} 秒。`);
  }

  private async cachePdfPreview(message: WebviewMessage): Promise<void> {
    const key = boundedPreviewKey(message.key);
    if (key !== this.previewKeyFor(this.pdfFingerprint())) {
      return;
    }
    const dataUrl = boundedPreviewDataUrl(message.dataUrl);
    const page = positiveInteger(message.page, "预览页码");
    const widthPt = boundedDimension(message.widthPt, "预览页宽度");
    const heightPt = boundedDimension(message.heightPt, "预览页高度");
    const directory = vscode.Uri.joinPath(this.context.globalStorageUri, "pdf-previews").fsPath;
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, `${key}.jpg`);
    const staging = `${target}.tmp-${process.pid}-${Date.now()}`;
    const metadataTarget = path.join(directory, `${key}.json`);
    const metadataStaging = `${metadataTarget}.tmp-${process.pid}-${Date.now()}`;
    const decoded = Buffer.from(dataUrl.slice("data:image/jpeg;base64,".length), "base64");
    await fs.writeFile(staging, new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength));
    await fs.writeFile(metadataStaging, JSON.stringify({ page, widthPt, heightPt }), "utf8");
    try {
      await Promise.allSettled([fs.rm(target, { force: true }), fs.rm(metadataTarget, { force: true })]);
      await fs.rename(staging, target);
      await fs.rename(metadataStaging, metadataTarget);
    } catch (error) {
      await Promise.allSettled([fs.rm(staging, { force: true }), fs.rm(metadataStaging, { force: true })]);
      throw error;
    }
    void this.prunePdfPreviews(directory, key);
  }

  private async prunePdfPreviews(directory: string, currentKey: string): Promise<void> {
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const files = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jpg")).map(async (entry) => ({
        name: entry.name,
        mtimeMs: (await fs.stat(path.join(directory, entry.name))).mtimeMs
      })));
      for (const file of files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(12)) {
        if (file.name !== `${currentKey}.jpg`) {
          await fs.rm(path.join(directory, file.name), { force: true });
          await fs.rm(path.join(directory, file.name.replace(/\.jpg$/, ".json")), { force: true });
        }
      }
    } catch {
      // 预览缓存清理失败不影响 PDF 阅读。
    }
  }

  private postCompiled(warnings: readonly string[]): void {
    this.post({
      type: "compiled",
      token: Date.now(),
      warnings,
      pdfFingerprint: this.pdfFingerprint(),
      previewKey: this.previewKeyFor(this.pdfFingerprint())
    });
  }

  private pdfFingerprint(): string {
    const stat = fsSync.statSync(this.project.pdf, { throwIfNoEntry: false });
    return stat?.isFile() ? `${Math.trunc(stat.mtimeMs)}-${stat.size}` : "missing";
  }

  private previewKeyFor(fingerprint: string): string {
    return sha256(`${samePathKey(this.project.pdf)}\0${fingerprint}`).slice(0, 40);
  }

  private readPdfPreview(key: string): { uri: string; page: number; widthPt: number; heightPt: number } | undefined {
    try {
      const directory = vscode.Uri.joinPath(this.context.globalStorageUri, "pdf-previews");
      const imagePath = vscode.Uri.joinPath(directory, `${key}.jpg`).fsPath;
      const metadataPath = vscode.Uri.joinPath(directory, `${key}.json`).fsPath;
      if (!fsSync.statSync(imagePath, { throwIfNoEntry: false })?.isFile()) return undefined;
      const value = JSON.parse(fsSync.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
      const page = positiveInteger(value.page, "预览页码");
      const widthPt = boundedDimension(value.widthPt, "预览页宽度");
      const heightPt = boundedDimension(value.heightPt, "预览页高度");
      return { uri: this.panel.webview.asWebviewUri(vscode.Uri.file(imagePath)).toString(), page, widthPt, heightPt };
    } catch {
      return undefined;
    }
  }

  private post(message: Record<string, unknown>): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString("base64");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "viewer.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "viewer.css"));
    const pdfJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "pdfjs", "pdf.min.mjs"));
    const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "pdfjs", "pdf.worker.min.mjs"));
    const cMapUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "pdfjs", "cmaps"));
    const standardFontsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "pdfjs", "standard_fonts"));
    const pdfUri = webview.asWebviewUri(vscode.Uri.file(this.project.pdf));
    const pdfFingerprint = this.pdfFingerprint();
    const previewKey = this.previewKeyFor(pdfFingerprint);
    const preview = this.readPdfPreview(previewKey);
    const config = JSON.stringify({
      pdfUri: pdfUri.toString(),
      pdfJsUri: pdfJsUri.toString(),
      workerUri: workerUri.toString(),
      cMapUri: `${cMapUri.toString()}/`,
      standardFontsUri: `${standardFontsUri.toString()}/`,
      manualEditMode: this.configuredManualEditMode(),
      pdfFingerprint,
      previewKey,
      preview,
      extensionCreatedAt: Date.now()
    }).replace(/</g, "\\u003c");
    const source = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${source} data: blob:; font-src ${source}; style-src ${source}; script-src ${source} 'nonce-${nonce}'; worker-src ${source} blob:; connect-src ${source} blob:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>CircleTeX PDF 审阅</title>
</head>
<body>
  <header class="toolbar">
    <button id="previous-page" class="icon-button" title="上一页" aria-label="上一页">‹</button>
    <label class="page-control"><input id="page-number" type="number" min="1" value="1" aria-label="页码"><span id="page-count">/ …</span></label>
    <button id="next-page" class="icon-button" title="下一页" aria-label="下一页">›</button>
    <span class="separator"></span>
    <button id="zoom-out" class="icon-button" title="缩小" aria-label="缩小">−</button>
    <span id="zoom-value" class="zoom-value">125%</span>
    <button id="zoom-in" class="icon-button" title="放大" aria-label="放大">＋</button>
    <button id="fit-width" class="toolbar-button">适合宽度</button>
    <span class="separator"></span>
    <button id="region-select" class="icon-button tool-toggle" title="区域框选" aria-label="区域框选" aria-pressed="false"><span class="region-select-icon" aria-hidden="true"></span></button>
    <button id="clear-selection" class="icon-button" title="清除选区" aria-label="清除选区" disabled>×</button>
    <span class="toolbar-spacer"></span>
    <button id="compile" class="toolbar-button">编译</button>
  </header>
  <main class="layout">
    <section id="viewer" class="viewer" aria-label="连续 PDF 页面">
      <div id="loading" class="loading" aria-live="polite">
        <div class="loading-meta"><span id="loading-label">正在初始化 PDF 审阅……</span><span id="loading-value">0%</span></div>
        <div id="loading-track" class="loading-track" role="progressbar" aria-label="PDF 打开进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div id="loading-fill" class="loading-fill"></div>
        </div>
      </div>
      <div id="pages" class="pages"></div>
    </section>
    <div class="dock-resizer">
      <div id="dock-resize-handle" class="dock-resize-handle" role="separator" aria-label="调整审阅工具区高度" aria-orientation="horizontal" tabindex="0"></div>
      <div id="dock-collapsed-progress" class="dock-collapsed-progress" role="status" aria-live="polite" data-kind="ready" data-has-progress="false">
        <span id="dock-collapsed-progress-label">工具区已收起</span>
        <span id="dock-collapsed-progress-value"></span>
        <div id="dock-collapsed-progress-track" class="dock-collapsed-progress-track" role="progressbar" aria-label="后台任务进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div id="dock-collapsed-progress-fill" class="dock-collapsed-progress-fill"></div>
        </div>
      </div>
      <button id="dock-toggle" class="dock-toggle" type="button" aria-expanded="true" aria-label="收起审阅工具区" title="收起审阅工具区，扩大 PDF 阅读视窗">⌄</button>
    </div>
    <section class="revision-dock" aria-label="论文修改工具">
      <div class="detail-bands">
        <details id="selection-details" class="detail-band" hidden>
          <summary><span>PDF 选区</span><span id="selection-summary" class="detail-summary"></span></summary>
          <div class="detail-content"><pre id="selection-text" tabindex="0">展开后加载选区文字。</pre></div>
        </details>
        <details id="source-details" class="detail-band" hidden>
          <summary><span>源码范围</span><span id="source-summary" class="detail-summary"></span></summary>
          <div class="detail-content">
            <div class="source-tools">
              <label>起始行<input id="start-line" type="number" min="1"></label>
              <label>结束行<input id="end-line" type="number" min="1"></label>
              <button id="adjust-range" class="secondary-button">更新范围</button>
              <button id="open-source" class="secondary-button">在编辑器中打开</button>
              <button id="confirm-range" class="primary-button" hidden>确认此范围</button>
            </div>
            <div id="confidence-note" class="confidence-note" hidden></div>
            <pre id="source-text" tabindex="0">展开后加载源码。</pre>
          </div>
        </details>
      </div>
      <div id="manual-edit-bar" class="manual-edit-bar" aria-label="PDF 手动编辑">
        <input id="manual-text" type="text" maxlength="2000" disabled placeholder="选择普通正文后输入新增或替换文字">
        <div class="manual-edit-actions" role="group" aria-label="手动编辑操作">
          <button id="manual-insert-before" class="secondary-button" disabled>前插</button>
          <button id="manual-insert-after" class="secondary-button" disabled>后插</button>
          <button id="manual-replace" class="secondary-button" disabled>替换</button>
          <button id="manual-delete" class="secondary-button danger-button" disabled>删除</button>
        </div>
        <div class="manual-edit-history">
          <span id="pending-edit-count">待提交 0</span>
          <button id="manual-accept-all" class="secondary-button" hidden>接受全部</button>
          <button id="manual-reject-all" class="secondary-button" hidden>拒绝全部</button>
          <button id="manual-undo" class="icon-button" title="撤销上一项编辑" aria-label="撤销上一项编辑" disabled>↶</button>
          <button id="manual-clear" class="icon-button" title="清空待编译编辑" aria-label="清空待编译编辑" disabled>×</button>
        </div>
      </div>
      <details id="pending-edits-details" class="pending-edits-details" hidden>
        <summary><span>待编译编辑</span><span id="pending-edits-summary" class="detail-summary"></span></summary>
        <ol id="pending-edits-list" class="pending-edits-list"></ol>
      </details>
      <div class="prompt-bar">
        <div class="task-selector-row">
          <label for="task-mode">任务</label>
          <select id="task-mode" aria-label="选择局部修订或外部 Skill">
            <option value="revision">局部修订</option>
          </select>
          <span id="task-scope-note">需要 PDF 选区</span>
        </div>
        <div class="analysis-row">
          <textarea id="instruction" maxlength="4000" disabled placeholder="先在 PDF 中划选内容，再输入修改要求。"></textarea>
          <button id="analyze" class="primary-button" disabled>交给 AI 助手分析</button>
        </div>
        <div class="prompt-actions">
          <button id="manual-handoff" class="secondary-button" hidden>复制任务并打开 AI 助手</button>
          <div id="candidate-actions" class="candidate-actions" hidden>
            <button id="show-diff" class="secondary-button">查看差异</button>
            <button id="apply" class="primary-button">应用并保存</button>
            <button id="discard" class="secondary-button">放弃</button>
          </div>
        </div>
      </div>
      <section id="skill-progress" class="skill-progress" hidden aria-live="polite" aria-label="Skill 任务进度">
        <div class="skill-progress-header">
          <div class="skill-progress-identity">
            <strong id="skill-progress-name">Skill 任务</strong>
            <span id="skill-progress-state" class="skill-progress-state" data-state="pending">等待</span>
          </div>
          <div class="skill-progress-meta">
            <span id="skill-progress-elapsed">00:00</span>
            <span id="skill-progress-value">0%</span>
          </div>
        </div>
        <div id="skill-progress-track" class="skill-progress-track" role="progressbar" aria-label="Skill 总进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div id="skill-progress-fill" class="skill-progress-fill"></div>
        </div>
        <ol id="skill-progress-stages" class="skill-progress-stages"></ol>
        <div id="skill-progress-message" class="skill-progress-message"></div>
        <details id="skill-progress-details" class="skill-progress-details">
          <summary>详细信息</summary>
          <div id="skill-progress-events" class="skill-progress-events"></div>
        </details>
        <div id="skill-quality-gates" class="skill-quality-gates" hidden>
          <div class="skill-quality-title">质量门禁</div>
          <div id="skill-quality-list" class="skill-quality-list"></div>
        </div>
      </section>
      <div id="skill-artifacts" class="skill-artifacts" hidden aria-live="polite"></div>
      <div id="compile-progress" class="compile-progress" hidden aria-live="polite">
        <div class="compile-progress-meta"><span id="compile-progress-label">准备编译</span><span id="compile-progress-value">0%</span></div>
        <div id="compile-progress-track" class="compile-progress-track" role="progressbar" aria-label="论文编译进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div id="compile-progress-fill" class="compile-progress-fill"></div>
        </div>
      </div>
      <div class="status-line"><span id="candidate-summary" hidden></span><span id="status" role="status">请在 PDF 中划选需要修改的文字。</span></div>
    </section>
  </main>
  <script id="circletex-config" type="application/json" nonce="${nonce}">${config}</script>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function revisionSnapshot(candidate: RevisionCandidate): RevisionSnapshot {
  return {
    baseText: candidate.baseText,
    documentHash: candidate.mapping.documentHash,
    startOffset: candidate.mapping.startOffset,
    endOffset: candidate.mapping.endOffset,
    startLine: candidate.mapping.startLine,
    sourceText: candidate.mapping.sourceText
  };
}

function relocateMapping(
  mapping: SourceMapping,
  diskText: string,
  range: ResolvedApplyRange,
  contextLines: number
): SourceMapping {
  const lineStarts = computeLineStarts(diskText);
  const sourceText = diskText.slice(range.startOffset, range.endOffset);
  const startLine = lineNumberAtOffset(lineStarts, range.startOffset);
  const lineBreaks = sourceText.match(/\n/g)?.length ?? 0;
  const endLine = Math.max(startLine, startLine + lineBreaks - (sourceText.endsWith("\n") ? 1 : 0));
  const contextStartLine = Math.max(1, startLine - contextLines);
  const contextEndLine = Math.min(lineStarts.length, endLine + contextLines);
  const contextStartOffset = lineStarts[contextStartLine - 1];
  const contextEndOffset = contextEndLine < lineStarts.length ? lineStarts[contextEndLine] : diskText.length;
  return {
    ...mapping,
    startLine,
    endLine,
    startOffset: range.startOffset,
    endOffset: range.endOffset,
    sourceText,
    contextText: diskText.slice(contextStartOffset, contextEndOffset),
    contextStartLine,
    documentHash: sha256(diskText),
    normalizedDocumentHash: hashNormalizedText(diskText)
  };
}

function lineNumberAtOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return Math.max(1, high + 1);
}

async function createTexBackup(projectRoot: string, content: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(projectRoot, "backup", "circletex");
  const backupPath = path.join(directory, `main-${timestamp}.tex`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(backupPath, content, "utf8");
  return backupPath;
}

function preserveLineEnding(replacement: string, original: string): string {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  let normalized = replacement.replace(/\r\n|\r|\n/g, eol);
  const originalHasEol = original.endsWith("\n") || original.endsWith("\r");
  const replacementHasEol = normalized.endsWith("\n") || normalized.endsWith("\r");
  if (originalHasEol && !replacementHasEol) {
    normalized += eol;
  } else if (!originalHasEol && replacementHasEol) {
    normalized = normalized.replace(/(?:\r\n|\r|\n)+$/, "");
  }
  return normalized;
}

function manualEditKind(value: unknown): ManualEditKind {
  if (value === "insertBefore" || value === "insertAfter" || value === "delete" || value === "replace") {
    return value;
  }
  throw new Error("手动修订类型无效。");
}

function optionalCaretVisibleOffset(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000) {
    throw new Error("光标可见字符位置无效。");
  }
  return value;
}

function optionalCaretDeleteDirection(value: unknown): "backward" | "forward" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "backward" || value === "forward") {
    return value;
  }
  throw new Error("光标删除方向无效。");
}

function currentManualEditMode(resource?: vscode.Uri): ManualEditMode {
  const configured = vscode.workspace.getConfiguration("circletex", resource).get<string>("manualEditMode", "direct");
  return configured === "tracked" ? "tracked" : "direct";
}

function manualEditRects(value: unknown): NormalizedManualEditRect[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error("手动修订选区必须包含 1 至 64 个有效矩形。");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("手动修订矩形无效。");
    }
    const rect = item as Record<string, unknown>;
    const x = normalizedCoordinate(rect.x, "横坐标");
    const y = normalizedCoordinate(rect.y, "纵坐标");
    const width = normalizedCoordinate(rect.width, "宽度", false);
    const height = normalizedCoordinate(rect.height, "高度", false);
    if (x + width > 1.000001 || y + height > 1.000001) {
      throw new Error("手动修订矩形超出 PDF 页面范围。");
    }
    const page = rect.page === undefined ? undefined : positiveInteger(rect.page, "手动修订矩形页码");
    return { ...(page === undefined ? {} : { page }), x, y, width, height };
  });
}

function normalizedCoordinate(value: unknown, name: string, allowZero = true): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1 ||
    (!allowZero && value === 0)
  ) {
    throw new Error(`手动修订矩形${name}无效。`);
  }
  return value;
}

function manualEditForWebview(edit: PendingDocumentEdit): Record<string, unknown> {
  if (isPendingImageEdit(edit)) {
    return {
      editType: "image",
      id: edit.id,
      kind: edit.kind,
      page: edit.page,
      rects: edit.rects,
      imagePath: edit.imagePath,
      originalValue: edit.originalValue,
      candidateValue: edit.candidateValue,
      factor: edit.factor
    };
  }
  return {
    id: edit.id,
    kind: edit.kind,
    page: edit.page,
    rects: edit.rects,
    insertedText: edit.insertedText,
    ...(edit.structuralFormula ? { structuralFormula: true } : {})
  };
}

function textOnlyEdits(edits: readonly PendingDocumentEdit[]): PendingManualEdit[] {
  if (edits.some(isPendingImageEdit)) {
    throw new Error("图片尺寸调整只支持直接编辑模式，不能写入修订痕迹。");
  }
  return edits as PendingManualEdit[];
}

function boundedImageScaleFactor(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.25 || value > 3) {
    throw new Error("图片缩放比例必须位于 25% 至 300% 之间。");
  }
  return value;
}

async function replaceDocumentText(document: vscode.TextDocument, value: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
    value
  );
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error("VS Code 未能写入批量手动修订。");
  }
  if (!hasSameNormalizedText(document.getText(), value)) {
    throw new Error("编辑器中的批量手动修订结果与预览不一致。");
  }
  if (!(await document.save())) {
    throw new Error("批量手动修订已进入编辑器，但 main.tex 保存失败。");
  }
}

async function restoreDocumentText(
  document: vscode.TextDocument,
  originalText: string,
  stagedText: string
): Promise<boolean> {
  try {
    const diskText = await fs.readFile(document.uri.fsPath, "utf8");
    const editorText = document.getText();
    if (
      ![originalText, stagedText].some((expected) => hasSameNormalizedText(diskText, expected)) ||
      ![originalText, stagedText].some((expected) => hasSameNormalizedText(editorText, expected))
    ) {
      return false;
    }
    if (editorText !== originalText || document.isDirty) {
      await replaceDocumentText(document, originalText);
    } else if (diskText !== originalText) {
      await fs.writeFile(document.uri.fsPath, originalText, "utf8");
    }
    const restoredDisk = await fs.readFile(document.uri.fsPath, "utf8");
    return hasSameNormalizedText(restoredDisk, originalText) &&
      hasSameNormalizedText(document.getText(), originalText) &&
      !document.isDirty;
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error(`${name}无效。`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000) {
    throw new Error(`${name}无效。`);
  }
  return value;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function boundedString(value: unknown, minimum: number, maximum: number, name: string): string {
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) {
    throw new Error(`${name}长度无效。`);
  }
  return value;
}

function boundedIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${name}标识无效。`);
  }
  return value;
}

function boundedPreviewKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error("PDF 预览缓存标识无效。");
  }
  return value;
}

function boundedPreviewDataUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 100 ||
    value.length > 1_500_000 ||
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(value)
  ) {
    throw new Error("PDF 预览缓存数据无效。");
  }
  return value;
}

function boundedDimension(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 100 || value > 5_000) {
    throw new Error(`${name}无效。`);
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isMessage(value: unknown): value is WebviewMessage {
  return Boolean(value && typeof value === "object" && typeof (value as Record<string, unknown>).type === "string");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameFilePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left).replace(/\\/g, "/");
  const normalizedRight = path.resolve(right).replace(/\\/g, "/");
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function withCompileWarning(result: CompileResult, warning: string): CompileResult {
  return result.warnings.includes(warning)
    ? result
    : { ...result, warnings: [...result.warnings, warning] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePathKey(value: string): string {
  const resolved = path.resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function skillsForWebview(skills: ImportedSkill[]): Array<Record<string, unknown>> {
  return skills.filter((skill) => skill.enabled).map((skill) => ({
    id: skill.id,
    name: skill.displayName,
    description: skill.description,
    taskType: skill.permissions.taskType,
    scope: skill.permissions.scope,
    inputPreset: skill.permissions.inputPreset,
    outputExtensions: skill.permissions.outputExtensions
  }));
}
