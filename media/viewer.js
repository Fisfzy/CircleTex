const vscode = acquireVsCodeApi();
const config = JSON.parse(document.getElementById("circletex-config").textContent);
let activePdfFingerprint = config.pdfFingerprint;
let activePreviewKey = config.previewKey;
const pdfJsPromise = import(config.pdfJsUri);
const persisted = vscode.getState() ?? {};

const elements = {
  viewer: document.getElementById("viewer"),
  pages: document.getElementById("pages"),
  dockResizer: document.getElementById("dock-resize-handle"),
  dockToggle: document.getElementById("dock-toggle"),
  dockCollapsedProgress: document.getElementById("dock-collapsed-progress"),
  dockCollapsedProgressLabel: document.getElementById("dock-collapsed-progress-label"),
  dockCollapsedProgressValue: document.getElementById("dock-collapsed-progress-value"),
  dockCollapsedProgressTrack: document.getElementById("dock-collapsed-progress-track"),
  dockCollapsedProgressFill: document.getElementById("dock-collapsed-progress-fill"),
  loading: document.getElementById("loading"),
  loadingLabel: document.getElementById("loading-label"),
  loadingValue: document.getElementById("loading-value"),
  loadingTrack: document.getElementById("loading-track"),
  loadingFill: document.getElementById("loading-fill"),
  previousPage: document.getElementById("previous-page"),
  nextPage: document.getElementById("next-page"),
  pageNumber: document.getElementById("page-number"),
  pageCount: document.getElementById("page-count"),
  zoomOut: document.getElementById("zoom-out"),
  zoomIn: document.getElementById("zoom-in"),
  zoomValue: document.getElementById("zoom-value"),
  fitWidth: document.getElementById("fit-width"),
  regionSelect: document.getElementById("region-select"),
  clearSelection: document.getElementById("clear-selection"),
  compile: document.getElementById("compile"),
  manualEditBar: document.getElementById("manual-edit-bar"),
  manualText: document.getElementById("manual-text"),
  manualInsertBefore: document.getElementById("manual-insert-before"),
  manualInsertAfter: document.getElementById("manual-insert-after"),
  manualReplace: document.getElementById("manual-replace"),
  manualDelete: document.getElementById("manual-delete"),
  manualUndo: document.getElementById("manual-undo"),
  manualClear: document.getElementById("manual-clear"),
  manualAcceptAll: document.getElementById("manual-accept-all"),
  manualRejectAll: document.getElementById("manual-reject-all"),
  pendingEditCount: document.getElementById("pending-edit-count"),
  pendingEditsDetails: document.getElementById("pending-edits-details"),
  pendingEditsSummary: document.getElementById("pending-edits-summary"),
  pendingEditsList: document.getElementById("pending-edits-list"),
  selectionDetails: document.getElementById("selection-details"),
  selectionSummary: document.getElementById("selection-summary"),
  selectionText: document.getElementById("selection-text"),
  sourceDetails: document.getElementById("source-details"),
  sourceSummary: document.getElementById("source-summary"),
  sourceText: document.getElementById("source-text"),
  startLine: document.getElementById("start-line"),
  endLine: document.getElementById("end-line"),
  adjustRange: document.getElementById("adjust-range"),
  openSource: document.getElementById("open-source"),
  confirmRange: document.getElementById("confirm-range"),
  confidenceNote: document.getElementById("confidence-note"),
  taskMode: document.getElementById("task-mode"),
  taskScopeNote: document.getElementById("task-scope-note"),
  instruction: document.getElementById("instruction"),
  analyze: document.getElementById("analyze"),
  manualHandoff: document.getElementById("manual-handoff"),
  candidateActions: document.getElementById("candidate-actions"),
  candidateSummary: document.getElementById("candidate-summary"),
  showDiff: document.getElementById("show-diff"),
  apply: document.getElementById("apply"),
  discard: document.getElementById("discard"),
  skillProgress: document.getElementById("skill-progress"),
  skillProgressName: document.getElementById("skill-progress-name"),
  skillProgressState: document.getElementById("skill-progress-state"),
  skillProgressElapsed: document.getElementById("skill-progress-elapsed"),
  skillProgressValue: document.getElementById("skill-progress-value"),
  skillProgressTrack: document.getElementById("skill-progress-track"),
  skillProgressFill: document.getElementById("skill-progress-fill"),
  skillProgressStages: document.getElementById("skill-progress-stages"),
  skillProgressMessage: document.getElementById("skill-progress-message"),
  skillProgressDetails: document.getElementById("skill-progress-details"),
  skillProgressEvents: document.getElementById("skill-progress-events"),
  skillQualityGates: document.getElementById("skill-quality-gates"),
  skillQualityList: document.getElementById("skill-quality-list"),
  compileProgress: document.getElementById("compile-progress"),
  compileProgressLabel: document.getElementById("compile-progress-label"),
  compileProgressValue: document.getElementById("compile-progress-value"),
  compileProgressTrack: document.getElementById("compile-progress-track"),
  compileProgressFill: document.getElementById("compile-progress-fill"),
  skillArtifacts: document.getElementById("skill-artifacts"),
  promptBar: document.querySelector(".prompt-bar"),
  status: document.getElementById("status")
};
const immediateStartupPreview = showImmediateStartupPreview();
const pdfjs = await pdfJsPromise;
pdfjs.GlobalWorkerOptions.workerSrc = config.workerUri;
if (Number.isFinite(config.extensionCreatedAt)) {
  vscode.postMessage({
    type: "performance",
    label: "PDF Webview 启动",
    durationMs: Math.max(0, Date.now() - config.extensionCreatedAt)
  });
}

const interactionModeSwitch = document.createElement("div");
interactionModeSwitch.id = "interaction-mode";
interactionModeSwitch.className = "interaction-mode-switch";
interactionModeSwitch.setAttribute("role", "group");
interactionModeSwitch.setAttribute("aria-label", "选择处理方式");
const modeDirectButton = document.createElement("button");
modeDirectButton.id = "mode-direct";
modeDirectButton.type = "button";
modeDirectButton.textContent = "直编";
modeDirectButton.title = "直接编辑";
modeDirectButton.setAttribute("aria-pressed", "false");
const modeAgentButton = document.createElement("button");
modeAgentButton.id = "mode-agent";
modeAgentButton.type = "button";
modeAgentButton.textContent = "Agent";
modeAgentButton.title = "交给 Agent 处理";
modeAgentButton.setAttribute("aria-pressed", "false");
interactionModeSwitch.append(modeDirectButton, modeAgentButton);

const directEditButton = document.createElement("button");
directEditButton.id = "direct-edit";
directEditButton.className = "icon-button tool-toggle";
directEditButton.type = "button";
directEditButton.title = "文字或光标选择";
directEditButton.setAttribute("aria-label", "文字或光标选择");
directEditButton.setAttribute("aria-pressed", "false");
const directEditIcon = document.createElement("span");
directEditIcon.className = "direct-edit-icon";
directEditIcon.setAttribute("aria-hidden", "true");
directEditButton.append(directEditIcon);
elements.regionSelect.before(interactionModeSwitch, directEditButton);

const directEditInput = document.createElement("textarea");
directEditInput.id = "direct-edit-input";
directEditInput.className = "direct-edit-input";
directEditInput.rows = 1;
directEditInput.maxLength = 2_000;
directEditInput.hidden = true;
directEditInput.setAttribute("aria-label", "PDF 直接编辑输入");
document.body.append(directEditInput);
elements.directEdit = directEditButton;
elements.modeDirect = modeDirectButton;
elements.modeAgent = modeAgentButton;
elements.directInput = directEditInput;

const showManualEditsDiffButton = document.createElement("button");
showManualEditsDiffButton.id = "show-manual-edits-diff";
showManualEditsDiffButton.className = "secondary-button";
showManualEditsDiffButton.type = "button";
showManualEditsDiffButton.textContent = "查看改动";
showManualEditsDiffButton.title = "查看待编译编辑的源码差异";
showManualEditsDiffButton.setAttribute("aria-label", "查看待编译编辑的源码差异");
showManualEditsDiffButton.disabled = true;
elements.manualClear.after(showManualEditsDiffButton);
elements.showManualEditsDiff = showManualEditsDiffButton;

for (const [button, hint, shortcut] of [
  [elements.regionSelect, "区域框选：选择连续正文或图片", ""],
  [elements.directEdit, "文字或光标选择：建立直接编辑草稿", ""],
  [elements.clearSelection, "清除当前 PDF 选区", "Escape"],
  [elements.manualUndo, "撤销上一项待编译编辑", "Ctrl+Z"],
  [elements.manualClear, "放弃全部待编译编辑", ""],
  [elements.showManualEditsDiff, "查看待编译编辑的源码差异", ""]
]) {
  if (!button) continue;
  button.title = shortcut ? `${hint}（${shortcut}）` : hint;
  button.setAttribute("aria-label", shortcut ? `${hint}，快捷键 ${shortcut}` : hint);
  if (shortcut) button.setAttribute("aria-keyshortcuts", shortcut === "Ctrl+Z" ? "Control+Z Meta+Z" : shortcut);
}

const initialPageNumber = positivePage(persisted.pageNumber) || positivePage(config.preview?.page) || 1;
const state = {
  document: undefined,
  pageStates: [],
  loadGeneration: 0,
  pdfLoadSequence: 0,
  scale: clamp(Number(persisted.scale) || 1.25, 0.45, 3),
  fitMode: persisted.fitMode !== false,
  currentPage: initialPageNumber,
  renderQueue: [],
  queuedPages: new Set(),
  desiredPages: new Set(),
  activeRenders: 0,
  observer: undefined,
  selectedPage: undefined,
  selectedPages: new Set(),
  textSelectionDrag: undefined,
  selectionTool: ["none", "text", "region"].includes(persisted.selectionTool) ? persisted.selectionTool : "text",
  interactionMode: persisted.interactionMode === "direct" || persisted.directEditEnabled === true ? "direct" : "agent",
  interactionVersion: 0,
  directDraft: undefined,
  directCaptureSpec: undefined,
  directIgnoreNextSelectionCapture: false,
  directInputComposing: false,
  directQueueRequestId: undefined,
  selectionLabel: "文字选区",
  textSelection: undefined,
  regionDraft: undefined,
  regionSelection: undefined,
  imageEditDraft: undefined,
  imageLocateRequestId: undefined,
  imageQueueRequestId: undefined,
  sessionId: undefined,
  mappingId: undefined,
  candidateId: undefined,
  selectionRequestId: undefined,
  rangeRequestId: undefined,
  selectionDetailRequestId: undefined,
  sourceDetailRequestId: undefined,
  requiresConfirmation: false,
  rangeConfirmed: false,
  analyzing: false,
  busyAction: undefined,
  manualEditRequestId: undefined,
  pendingManualEdits: [],
  pendingManualEditCount: 0,
  manualEditQueueVersion: 0,
  canUndoManualEdit: false,
  canRedoManualEdit: false,
  manualEditMode: config.manualEditMode === "tracked" ? "tracked" : "direct",
  hasTrackedRevisions: false,
  assistantName: "AI 助手",
  skills: [],
  selectedTask: "revision",
  skillTaskRunning: false,
  skillProgressPercent: 0,
  skillProgressStartedAt: undefined,
  skillProgressElapsedSeconds: 0,
  skillProgressTimer: undefined,
  skillProgressStages: [],
  skillProgressEvents: [],
  scrollFrame: 0,
  imageControlFrame: 0,
  dockHeight: 0,
  dockCollapsed: false,
  dockResize: undefined,
  saveTimer: undefined,
  resizeTimer: undefined,
  wheelTimer: undefined,
  pendingWheelDelta: 0,
  pendingWheelAnchor: undefined,
  pageInputFocused: false,
  pdfRefreshInProgress: false,
  compileProgressActive: false,
  compileProgressPercent: 0,
  compileProgressHideTimer: undefined,
  preserveCompileStatus: false,
  loadingHideTimer: undefined,
  statusMessage: "请在 PDF 中划选需要修改的文字。",
  statusKind: "ready",
  cachedPreviewSignature: undefined,
  startupPreview: undefined,
  cachedPreviewPage: undefined,
  previewCacheTimer: undefined,
  primaryRenderPending: false
};

function boundedDockHeight(value) {
  const minimum = 168;
  const maximum = Math.max(minimum, window.innerHeight - 170);
  const fallback = Math.round(window.innerHeight * 0.38);
  return clamp(Number(value) || fallback, minimum, maximum);
}

function applyDockHeight(value) {
  state.dockHeight = boundedDockHeight(value);
  document.documentElement.style.setProperty("--circletex-dock-height", `${state.dockHeight}px`);
  elements.dockResizer?.setAttribute("aria-valuemin", "168");
  elements.dockResizer?.setAttribute("aria-valuemax", String(Math.max(168, window.innerHeight - 170)));
  elements.dockResizer?.setAttribute("aria-valuenow", String(Math.round(state.dockHeight)));
}

function applyDockCollapsed(value) {
  state.dockCollapsed = Boolean(value);
  document.documentElement.classList.toggle("dock-collapsed", state.dockCollapsed);
  if (elements.dockToggle) {
    elements.dockToggle.textContent = state.dockCollapsed ? "⌃" : "⌄";
    const label = state.dockCollapsed ? "展开审阅工具区" : "收起审阅工具区";
    elements.dockToggle.title = `${label}${state.dockCollapsed ? "，恢复编辑与确认模块" : "，扩大 PDF 阅读视窗"}`;
    elements.dockToggle.setAttribute("aria-label", label);
    elements.dockToggle.setAttribute("aria-expanded", String(!state.dockCollapsed));
  }
  updateCollapsedDockProgress();
}

function toggleDockCollapsed() {
  applyDockCollapsed(!state.dockCollapsed);
  updateVisiblePages();
  positionImageEditControls();
  scheduleStateSave();
}

function beginDockResize(event) {
  if (state.dockCollapsed || event.button !== 0 || !elements.dockResizer) return;
  event.preventDefault();
  state.dockResize = { pointerId: event.pointerId, startY: event.clientY, startHeight: state.dockHeight, frame: 0 };
  elements.dockResizer.setPointerCapture(event.pointerId);
  document.body.classList.add("is-resizing-dock");
}

function moveDockResize(event) {
  const resize = state.dockResize;
  if (!resize || event.pointerId !== resize.pointerId) return;
  const height = boundedDockHeight(resize.startHeight + resize.startY - event.clientY);
  if (resize.frame) cancelAnimationFrame(resize.frame);
  resize.frame = requestAnimationFrame(() => {
    resize.frame = 0;
    applyDockHeight(height);
    updateVisiblePages();
    positionImageEditControls();
  });
}

function endDockResize(event) {
  const resize = state.dockResize;
  if (!resize || event.pointerId !== resize.pointerId) return;
  if (resize.frame) cancelAnimationFrame(resize.frame);
  state.dockResize = undefined;
  document.body.classList.remove("is-resizing-dock");
  scheduleStateSave();
}

applyDockHeight(persisted.dockHeight);
applyDockCollapsed(persisted.dockCollapsed === true);

function showImmediateStartupPreview() {
  const preview = config.preview;
  const savedPage = positivePage(persisted.pageNumber);
  if (!preview || typeof preview.uri !== "string" || (savedPage && savedPage !== preview.page)) return undefined;
  const overlay = document.createElement("div");
  overlay.className = "startup-preview-overlay";
  const image = document.createElement("img");
  image.src = preview.uri;
  image.alt = `第 ${preview.page} 页缓存预览`;
  overlay.append(image);
  elements.viewer.append(overlay);
  return overlay;
}

async function loadPdf({ preservePosition = true } = {}) {
  const requestId = ++state.pdfLoadSequence;
  if (!state.compileProgressActive) {
    state.preserveCompileStatus = false;
  }
  state.pdfRefreshInProgress = true;
  try {
    await loadPdfCore({ preservePosition, requestId });
  } finally {
    if (requestId === state.pdfLoadSequence) {
      state.pdfRefreshInProgress = false;
    }
  }
}

async function loadPdfCore({ preservePosition = true, requestId }) {
  const loadStartedAt = performance.now();
  const restore = preservePosition && state.document ? captureViewState() : {
    pageNumber: positivePage(persisted.pageNumber) || state.currentPage,
    yRatio: clamp(Number(persisted.yRatio) || 0, 0, 1),
    xRatio: clamp(Number(persisted.xRatio) || 0, 0, 1),
    clientOffsetX: Number.isFinite(persisted.clientOffsetX) ? persisted.clientOffsetX : undefined,
    clientOffsetY: Number.isFinite(persisted.clientOffsetY) ? persisted.clientOffsetY : undefined,
    scale: state.scale,
    fitMode: state.fitMode
  };
  setLoading("正在读取 main.pdf……", 8);

  const readStartedAt = performance.now();
  if (state.compileProgressActive) {
    updateCompileProgress({ percent: 94, message: "正在读取新 PDF", indeterminate: true });
  }
  const response = await fetch(config.pdfUri, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`无法读取 main.pdf：${response.status}`);
  }
  const data = await readPdfResponse(response, (loaded, total) => {
    if (requestId !== state.pdfLoadSequence) return;
    const percent = total > 0 ? 10 + (loaded / total) * 42 : 28;
    setLoading(total > 0 ? "正在读取 main.pdf……" : "正在读取 main.pdf……", percent, total <= 0);
  });
  ensureCurrentPdfLoad(requestId);
  reportPerformance("PDF 文件读取", readStartedAt);
  setLoading("正在解析 PDF 文档……", 55, true);
  const workerStartedAt = performance.now();
  const loadingTask = pdfjs.getDocument({
    data,
    cMapUrl: config.cMapUri,
    cMapPacked: true,
    standardFontDataUrl: config.standardFontsUri
  });
  const nextDocument = await loadingTask.promise;
  ensureCurrentPdfLoad(requestId);
  reportPerformance("PDF Worker 解析", workerStartedAt);
  setLoading("正在读取当前页面信息……", 68);
  const restorePageNumber = clamp(restore.pageNumber, 1, nextDocument.numPages);
  let preferredMetadata;
  try {
    preferredMetadata = await readSinglePageMetadata(nextDocument, restorePageNumber);
  } catch (error) {
    await nextDocument.destroy();
    throw error;
  }
  ensureCurrentPdfLoad(requestId);

  const oldDocument = state.document;
  const refreshSnapshot = capturePageSnapshot(restore.pageNumber);
  state.loadGeneration += 1;
  if (state.scrollFrame) {
    cancelAnimationFrame(state.scrollFrame);
    state.scrollFrame = 0;
  }
  state.observer?.disconnect();
  disposeAllPages();
  state.document = nextDocument;
  state.pageStates = [];
  state.renderQueue = [];
  state.queuedPages.clear();
  elements.pages.replaceChildren();
  if (oldDocument) {
    void oldDocument.destroy().catch((error) => console.error(error));
  }

  state.fitMode = restore.fitMode !== false;
  state.scale = state.fitMode ? computeFitScale([preferredMetadata]) : clamp(restore.scale, 0.45, 3);
  const initialMetadata = Array.from({ length: nextDocument.numPages }, (_, index) => ({
    ...preferredMetadata,
    number: index + 1
  }));
  const shellsStartedAt = performance.now();
  setLoading("正在建立连续页面……", 76);
  buildPageShells(initialMetadata, false);
  elements.pageCount.textContent = `/ ${nextDocument.numPages}`;
  elements.pageNumber.max = String(nextDocument.numPages);
  elements.zoomValue.textContent = `${Math.round(state.scale * 100)}%`;
  state.currentPage = restorePageNumber;
  attachPageSnapshot(refreshSnapshot, state.pageStates[restorePageNumber - 1]);
  attachStartupPreview(state.pageStates[restorePageNumber - 1]);
  await nextFrame();
  await nextFrame();
  ensureCurrentPdfLoad(requestId);
  restoreViewState({ ...restore, pageNumber: restorePageNumber });
  fadeOutAndRemove(immediateStartupPreview);
  reportPerformance("PDF 首屏页面壳体", shellsStartedAt);
  state.desiredPages = new Set([restorePageNumber]);
  const generation = state.loadGeneration;
  const primaryRecord = state.pageStates[restorePageNumber - 1];
  primaryRecord.status = "previewing";
  let previewPromise = Promise.resolve();
  if (!refreshSnapshot && !state.startupPreview) {
    const previewStartedAt = performance.now();
    previewPromise = renderLowResolutionPreview(primaryRecord).then(() => {
      if (state.loadGeneration === generation) reportPerformance("PDF 首屏低清预览", previewStartedAt);
    });
  }
  setLoading("正在渲染当前页并准备文字选择……", 90, true);
  setStatus("PDF 页面已显示，正在准备清晰页面与文字选择……", "busy");
  state.pdfRefreshInProgress = false;
  if (state.compileProgressActive) {
    updateCompileProgress({ percent: 98, message: "正在后台补齐清晰页面与文字选择", indeterminate: true });
  }
  for (const record of state.pageStates) {
    state.observer.observe(record.shell);
  }
  state.primaryRenderPending = true;
  void (async () => {
    try {
      await previewPromise.catch((error) => console.error(error));
      if (state.loadGeneration !== generation) return;
      if (requestId !== state.pdfLoadSequence) return;
      setLoading("PDF 页面已显示，正在后台准备清晰文字层", 100);
      hideLoading();
      if (state.currentPage !== restorePageNumber) {
        primaryRecord.status = "idle";
        return;
      }
      const primaryRenderStartedAt = performance.now();
      await renderPageRecord(primaryRecord, { primary: true });
      if (state.loadGeneration !== generation) return;
      if (requestId !== state.pdfLoadSequence) return;
      reportPerformance("PDF 当前页渲染", primaryRenderStartedAt);
      reportPerformance("PDF 刷新总计", loadStartedAt);
    } finally {
      if (state.loadGeneration === generation) {
        state.primaryRenderPending = false;
        updateVisiblePages();
      }
    }
  })();
  const metadataStartedAt = performance.now();
  void readPageMetadata(nextDocument, restorePageNumber).then((metadata) => {
    if (state.loadGeneration !== generation) return;
    applyPageMetadata(metadata);
    reportPerformance("PDF 页面元数据扫描", metadataStartedAt);
  }, (error) => console.error(error));
  updateVisiblePages();
}

async function readPdfResponse(response, onProgress) {
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body?.getReader) {
    const data = new Uint8Array(await response.arrayBuffer());
    onProgress(data.byteLength, data.byteLength);
    return data;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.byteLength) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  }
  const data = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress(loaded, total || loaded);
  return data;
}

function ensureCurrentPdfLoad(requestId) {
  if (requestId !== state.pdfLoadSequence) {
    throw new DOMException("PDF 加载已被新的刷新请求替代。", "AbortError");
  }
}

async function readSinglePageMetadata(documentProxy, pageNumber) {
  const page = await documentProxy.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale: 1 });
    return {
      number: pageNumber,
      widthPt: viewport.width,
      heightPt: viewport.height,
      rotation: ((page.rotate % 360) + 360) % 360
    };
  } finally {
    page.cleanup();
  }
}

async function readPageMetadata(documentProxy, preferredPage) {
  const pageCount = documentProxy.numPages;
  const preferred = clamp(positivePage(preferredPage) || 1, 1, pageCount);
  const order = [];
  const seen = new Set();
  for (const offset of [0, -1, 1, -2, 2]) {
    const pageNumber = preferred + offset;
    if (pageNumber >= 1 && pageNumber <= pageCount && !seen.has(pageNumber)) {
      seen.add(pageNumber);
      order.push(pageNumber);
    }
  }
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    if (!seen.has(pageNumber)) {
      order.push(pageNumber);
    }
  }
  const metadata = new Array(pageCount);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < order.length) {
      const index = nextIndex;
      nextIndex += 1;
      const pageNumber = order[index];
      const page = await documentProxy.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        metadata[pageNumber - 1] = {
          number: pageNumber,
          widthPt: viewport.width,
          heightPt: viewport.height,
          rotation: ((page.rotate % 360) + 360) % 360
        };
      } finally {
        page.cleanup();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, pageCount) }, () => worker()));
  return metadata;
}

function capturePageSnapshot(pageNumber) {
  const record = state.pageStates[clamp(positivePage(pageNumber) || state.currentPage, 1, state.pageStates.length) - 1];
  if (!record?.canvas || record.canvas.width < 1 || record.canvas.height < 1) {
    return undefined;
  }
  const canvas = document.createElement("canvas");
  canvas.width = record.canvas.width;
  canvas.height = record.canvas.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    return undefined;
  }
  context.drawImage(record.canvas, 0, 0);
  return canvas;
}

function attachPageSnapshot(canvas, record) {
  if (!canvas || !record) {
    return;
  }
  const snapshot = document.createElement("div");
  snapshot.className = "page-refresh-snapshot";
  snapshot.append(canvas);
  record.shell.append(snapshot);
}

function fadeOutAndRemove(element) {
  if (!element?.isConnected) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    element.remove();
    return;
  }
  element.classList.add("is-fading-out");
  setTimeout(() => element.remove(), 220);
}

function attachStartupPreview(record) {
  const preview = config.preview;
  if (
    !record || !preview || preview.page !== record.number ||
    typeof preview.uri !== "string" || !Number.isFinite(preview.widthPt) || !Number.isFinite(preview.heightPt)
  ) return;
  record.widthPt = preview.widthPt;
  record.heightPt = preview.heightPt;
  updateShellSize(record);
  const snapshot = document.createElement("div");
  snapshot.className = "page-refresh-snapshot startup-preview";
  const image = document.createElement("img");
  image.src = preview.uri;
  image.alt = `第 ${record.number} 页缓存预览`;
  snapshot.append(image);
  record.shell.append(snapshot);
  state.startupPreview = snapshot;
}

async function renderLowResolutionPreview(record) {
  if (!record || record.shell.querySelector(":scope > .page-refresh-snapshot")) return;
  const documentProxy = state.document;
  const generation = state.loadGeneration;
  const page = await documentProxy.getPage(record.number);
  try {
    const viewport = page.getViewport({ scale: Math.min(state.scale, 0.55) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    if (state.loadGeneration !== generation || state.currentPage !== record.number) return;
    const snapshot = document.createElement("div");
    snapshot.className = "page-refresh-snapshot low-resolution-preview";
    snapshot.append(canvas);
    record.shell.append(snapshot);
    state.startupPreview = snapshot;
  } finally {
    page.cleanup();
  }
}

function reportPerformance(label, startedAt) {
  const durationMs = Math.max(0, performance.now() - startedAt);
  post("performance", { label, durationMs });
}

function buildPageShells(metadata, observe = true) {
  state.observer = new IntersectionObserver(() => scheduleVisibleUpdate(), {
    root: elements.viewer,
    rootMargin: "120% 0px",
    threshold: [0, 0.1, 0.5]
  });
  for (const item of metadata) {
    const shell = document.createElement("div");
    shell.className = "pdf-page";
    shell.dataset.pageNumber = String(item.number);
    const placeholder = document.createElement("div");
    placeholder.className = "page-placeholder";
    placeholder.textContent = `第 ${item.number} 页`;
    const label = document.createElement("div");
    label.className = "page-label";
    label.textContent = `${item.number}`;
    shell.append(placeholder, label);
    const record = {
      ...item,
      shell,
      placeholder,
      surface: undefined,
      canvas: undefined,
      textLayerElement: undefined,
      pageProxy: undefined,
      renderTask: undefined,
      textLayer: undefined,
      imageBoundaries: [],
      renderGeneration: 0,
      renderedScale: undefined,
      status: "idle",
      pendingRelease: false
    };
    state.pageStates.push(record);
    updateShellSize(record);
    elements.pages.append(shell);
    if (observe) {
      state.observer.observe(shell);
    }
  }
}

function updateShellSize(record) {
  const width = record.widthPt * state.scale;
  const height = record.heightPt * state.scale;
  record.shell.style.width = `${width}px`;
  record.shell.style.height = `${height}px`;
  record.shell.style.setProperty("--total-scale-factor", String(state.scale));
  if (record.surface) {
    record.surface.style.width = `${width}px`;
    record.surface.style.height = `${height}px`;
  }
  renderRegionSelection(record);
  renderManualEditOverlay(record);
  renderDirectDraft(record);
  if (state.imageEditDraft?.page === record.number) renderImageEditDraft();
}

function scheduleVisibleUpdate() {
  if (state.pdfRefreshInProgress || state.scrollFrame) {
    return;
  }
  state.scrollFrame = requestAnimationFrame(() => {
    state.scrollFrame = 0;
    updateVisiblePages();
    positionImageEditControls();
  });
}

function updateVisiblePages() {
  if (!state.document || state.pageStates.length === 0) {
    return;
  }
  const viewerRect = elements.viewer.getBoundingClientRect();
  let bestPage = state.currentPage;
  let bestArea = -1;
  for (const record of state.pageStates) {
    const rect = record.shell.getBoundingClientRect();
    const overlapWidth = Math.max(0, Math.min(rect.right, viewerRect.right) - Math.max(rect.left, viewerRect.left));
    const overlapHeight = Math.max(0, Math.min(rect.bottom, viewerRect.bottom) - Math.max(rect.top, viewerRect.top));
    const area = overlapWidth * overlapHeight;
    if (area > bestArea) {
      bestArea = area;
      bestPage = record.number;
    }
  }
  state.currentPage = bestPage;
  if (state.cachedPreviewPage !== bestPage) {
    clearTimeout(state.previewCacheTimer);
    state.previewCacheTimer = setTimeout(() => {
      const record = state.pageStates[bestPage - 1];
      if (state.currentPage === bestPage && record?.canvas) schedulePreviewCache(record);
    }, 900);
  }
  if (!state.pageInputFocused) {
    elements.pageNumber.value = String(bestPage);
  }
  elements.previousPage.disabled = bestPage <= 1;
  elements.nextPage.disabled = bestPage >= state.pageStates.length;

  const budget = state.primaryRenderPending ? 1 : state.scale > 2.1 ? 3 : 5;
  const desired = new Set();
  for (const pageNumber of state.selectedPages) desired.add(pageNumber);
  if (state.selectedPage) desired.add(state.selectedPage);
  const offsets = [0, -1, 1, -2, 2, -3, 3];
  for (const offset of offsets) {
    const pageNumber = bestPage + offset;
    if (pageNumber >= 1 && pageNumber <= state.pageStates.length && desired.size < budget) {
      desired.add(pageNumber);
    }
  }
  state.desiredPages = desired;
  for (const pageNumber of desired) {
    enqueuePage(state.pageStates[pageNumber - 1]);
  }
  for (const record of state.pageStates) {
    if (!desired.has(record.number) && ["canvas", "rendered", "rendering"].includes(record.status)) {
      releasePage(record);
    }
  }
  state.renderQueue.sort((left, right) =>
    Math.abs(left.number - bestPage) - Math.abs(right.number - bestPage)
  );
  pumpRenderQueue();
  scheduleStateSave();
}

function enqueuePage(record) {
  if (!record || state.queuedPages.has(record.number)) {
    return;
  }
  if (["canvas", "rendered"].includes(record.status) && record.renderedScale === state.scale) {
    return;
  }
  if (record.status === "previewing" || record.status === "rendering") {
    return;
  }
  state.queuedPages.add(record.number);
  state.renderQueue.push(record);
}

function pumpRenderQueue() {
  while (state.activeRenders < 2 && state.renderQueue.length > 0) {
    const record = state.renderQueue.shift();
    state.queuedPages.delete(record.number);
    if (!state.desiredPages.has(record.number)) {
      continue;
    }
    state.activeRenders += 1;
    void renderPageRecord(record).finally(() => {
      state.activeRenders -= 1;
      pumpRenderQueue();
    });
  }
}

async function renderPageRecord(record, { primary = false } = {}) {
  const documentProxy = state.document;
  const documentGeneration = state.loadGeneration;
  const scale = state.scale;
  const renderGeneration = ++record.renderGeneration;
  record.status = "rendering";
  record.pendingRelease = false;
  try {
    const page = await documentProxy.getPage(record.number);
    if (isRenderStale(record, documentGeneration, renderGeneration, scale)) {
      page.cleanup();
      return;
    }
    record.pageProxy = page;
    const viewport = page.getViewport({ scale });
    const surface = document.createElement("div");
    surface.className = "page-surface is-pending";
    surface.style.width = `${viewport.width}px`;
    surface.style.height = `${viewport.height}px`;
    const canvas = document.createElement("canvas");
    const textLayerElement = document.createElement("div");
    textLayerElement.className = "textLayer";
    textLayerElement.dataset.pageNumber = String(record.number);
    const outputScale = computeOutputScale(viewport.width, viewport.height);
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    surface.append(canvas, textLayerElement);
    record.shell.append(surface);
    record.surface = surface;
    record.canvas = canvas;
    record.textLayerElement = textLayerElement;
    record.textLayerReady = false;
    const canvasContext = canvas.getContext("2d", { alpha: false });
    if (!canvasContext) {
      throw new Error(`第 ${record.number} 页无法创建 Canvas 绘图上下文。`);
    }
    canvasContext.fillStyle = "#ffffff";
    canvasContext.fillRect(0, 0, canvas.width, canvas.height);
    record.renderTask = page.render({
      canvasContext,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
    });
    const canvasStartedAt = primary ? performance.now() : 0;
    await record.renderTask.promise;
    if (isRenderStale(record, documentGeneration, renderGeneration, scale)) {
      return;
    }
    record.placeholder.hidden = true;
    record.renderedScale = scale;
    record.status = "canvas";
    record.shell.dataset.renderStage = "canvas";
    surface.classList.replace("is-pending", "is-ready");
    fadeOutAndRemove(record.shell.querySelector(":scope > .page-refresh-snapshot"));
    scheduleImageBoundaryCache(record, page, viewport, documentGeneration, renderGeneration, scale, primary);
    state.startupPreview = undefined;
    if (primary) {
      reportPerformance("PDF 首屏 Canvas", canvasStartedAt);
      if (!state.preserveCompileStatus) setStatus("PDF 页面已显示，正在准备文字选择……", "busy");
      schedulePreviewCache(record, 120);
    }
    const textLayerStartedAt = primary ? performance.now() : 0;
    try {
      const textContent = await page.getTextContent();
      if (isRenderStale(record, documentGeneration, renderGeneration, scale)) return;
      record.textLayer = new pdfjs.TextLayer({
        textContentSource: textContent,
        container: textLayerElement,
        viewport
      });
      await record.textLayer.render();
      if (isRenderStale(record, documentGeneration, renderGeneration, scale)) return;
      record.textLayerReady = true;
      record.status = "rendered";
      record.shell.dataset.renderStage = "text";
      if (primary) {
        reportPerformance("PDF 首屏文字层", textLayerStartedAt);
      }
      if (record.number === state.currentPage && !state.preserveCompileStatus) setStatus("PDF 已就绪。", "ready");
    } catch (error) {
      if (isCancellation(error) || isRenderStale(record, documentGeneration, renderGeneration, scale)) return;
      record.textLayerElement?.remove();
      record.textLayerElement = undefined;
      record.textLayer = undefined;
      record.status = "canvas";
      console.error(error);
      if (record.number === state.currentPage) setStatus("PDF 页面已显示，但文字选择层加载失败；请重新打开审阅窗口后重试。", "warning");
    }
  } catch (error) {
    if (!isCancellation(error)) {
      record.shell.querySelector(":scope > .page-refresh-snapshot")?.remove();
      disposeSurface(record);
      record.placeholder.textContent = `第 ${record.number} 页渲染失败`;
      record.status = "error";
      console.error(error);
    }
  } finally {
    record.renderTask = undefined;
    if (record.pendingRelease || isRenderStale(record, documentGeneration, renderGeneration, scale)) {
      disposeSurface(record);
    }
    if (
      state.pageStates[record.number - 1] === record &&
      state.desiredPages.has(record.number) &&
      record.status === "idle"
    ) {
      enqueuePage(record);
    }
  }
}

function schedulePreviewCache(record, delay = 0) {
  if (!record?.canvas || !activePreviewKey) return;
  const cache = () => {
    try {
      if (!record.canvas || record.status === "idle" || record.number !== state.currentPage) return;
      const ratio = Math.min(1, 900 / record.canvas.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(record.canvas.width * ratio));
      canvas.height = Math.max(1, Math.round(record.canvas.height * ratio));
      canvas.getContext("2d", { alpha: false })?.drawImage(record.canvas, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
      canvas.width = 0;
      canvas.height = 0;
      post("cachePdfPreview", {
        key: activePreviewKey,
        page: record.number,
        widthPt: record.widthPt,
        heightPt: record.heightPt,
        dataUrl
      });
      state.cachedPreviewSignature = activePreviewKey;
      state.cachedPreviewPage = record.number;
    } catch (error) {
      console.error(error);
    }
  };
  setTimeout(cache, delay);
}

function computeOutputScale(width, height) {
  const deviceScale = Math.min(window.devicePixelRatio || 1, 2);
  const maxPixels = state.scale > 2.1 ? 8_000_000 : 12_000_000;
  const pixelScale = Math.sqrt(maxPixels / Math.max(1, width * height));
  return Math.max(1, Math.min(deviceScale, pixelScale));
}

function isRenderStale(record, documentGeneration, renderGeneration, scale) {
  return state.loadGeneration !== documentGeneration ||
    record.renderGeneration !== renderGeneration ||
    state.scale !== scale ||
    record.pendingRelease;
}

function releasePage(record, force = false) {
  if (!force && (record.number === state.selectedPage || state.selectedPages.has(record.number))) {
    return;
  }
  record.pendingRelease = true;
  record.renderGeneration += 1;
  record.renderTask?.cancel();
  record.textLayer?.cancel();
  if (record.status !== "rendering") {
    disposeSurface(record);
  }
}

function disposeSurface(record) {
  record.renderTask?.cancel();
  record.textLayer?.cancel();
  if (record.canvas) {
    record.canvas.width = 0;
    record.canvas.height = 0;
  }
  record.surface?.remove();
  record.pageProxy?.cleanup();
  record.surface = undefined;
  record.canvas = undefined;
  record.textLayerElement = undefined;
  record.imageBoundaries = [];
  delete record.shell.dataset.imageCount;
  delete record.shell.dataset.imageBoundaries;
  record.pageProxy = undefined;
  delete record.shell.dataset.renderStage;
  record.renderTask = undefined;
  record.textLayer = undefined;
  record.renderedScale = undefined;
  record.pendingRelease = false;
  record.status = "idle";
  record.placeholder.hidden = false;
  record.placeholder.textContent = `第 ${record.number} 页`;
}

function disposeAllPages() {
  for (const record of state.pageStates) {
    releasePage(record, true);
    disposeSurface(record);
  }
  state.pageStates = [];
  state.renderQueue = [];
  state.queuedPages.clear();
  state.desiredPages.clear();
}

function computeFitScale(metadata = state.pageStates) {
  const maximumWidth = Math.max(...metadata.map((item) => item.widthPt), 595);
  const available = Math.max(280, elements.viewer.clientWidth - 52);
  return clamp(available / maximumWidth, 0.45, 2.5);
}

async function setScale(nextScale, anchor = captureScaleAnchor(), fitMode = false) {
  if (!state.document) {
    return;
  }
  const next = clamp(nextScale, 0.45, 3);
  state.fitMode = fitMode;
  if (Math.abs(next - state.scale) < 0.001) {
    return;
  }
  state.scale = next;
  elements.zoomValue.textContent = `${Math.round(next * 100)}%`;
  for (const record of state.pageStates) {
    releasePage(record, true);
    updateShellSize(record);
  }
  await nextFrame();
  restoreScaleAnchor(anchor);
  updateVisiblePages();
}

function captureScaleAnchor(clientX, clientY) {
  const viewerRect = elements.viewer.getBoundingClientRect();
  const x = Number.isFinite(clientX) ? clientX : viewerRect.left + viewerRect.width / 2;
  const y = Number.isFinite(clientY) ? clientY : viewerRect.top + viewerRect.height / 2;
  const target = document.elementFromPoint(x, y)?.closest?.(".pdf-page");
  const record = target
    ? state.pageStates[Number(target.dataset.pageNumber) - 1]
    : state.pageStates[state.currentPage - 1];
  if (!record) {
    return { pageNumber: 1, xRatio: 0.5, yRatio: 0, clientOffsetX: x - viewerRect.left, clientOffsetY: y - viewerRect.top };
  }
  const rect = record.shell.getBoundingClientRect();
  return {
    pageNumber: record.number,
    xRatio: clamp((x - rect.left) / Math.max(1, rect.width), 0, 1),
    yRatio: clamp((y - rect.top) / Math.max(1, rect.height), 0, 1),
    clientOffsetX: x - viewerRect.left,
    clientOffsetY: y - viewerRect.top
  };
}

function restoreScaleAnchor(anchor) {
  const record = state.pageStates[clamp(anchor.pageNumber, 1, state.pageStates.length) - 1];
  if (!record) {
    return;
  }
  elements.viewer.scrollTop = record.shell.offsetTop + anchor.yRatio * record.shell.offsetHeight - anchor.clientOffsetY;
  elements.viewer.scrollLeft = record.shell.offsetLeft + anchor.xRatio * record.shell.offsetWidth - anchor.clientOffsetX;
}

function captureViewState() {
  return {
    ...captureScaleAnchor(),
    scale: state.scale,
    fitMode: state.fitMode,
    selectionTool: state.selectionTool,
    interactionMode: state.interactionMode,
    directEditEnabled: state.interactionMode === "direct",
    dockHeight: state.dockHeight,
    dockCollapsed: state.dockCollapsed
  };
}

function restoreViewState(saved) {
  const record = state.pageStates[clamp(saved.pageNumber, 1, state.pageStates.length) - 1];
  if (!record) {
    return;
  }
  const yRatio = clamp(saved.yRatio, 0, 1);
  const xRatio = clamp(saved.xRatio, 0, 1);
  const clientOffsetY = Number.isFinite(saved.clientOffsetY) ? saved.clientOffsetY : 0;
  elements.viewer.scrollTop = record.shell.offsetTop + yRatio * record.shell.offsetHeight - clientOffsetY;
  if (Number.isFinite(saved.clientOffsetX)) {
    elements.viewer.scrollLeft = record.shell.offsetLeft + xRatio * record.shell.offsetWidth - saved.clientOffsetX;
  } else {
    const horizontalRange = Math.max(0, elements.viewer.scrollWidth - elements.viewer.clientWidth);
    elements.viewer.scrollLeft = xRatio * horizontalRange;
  }
}

function scheduleStateSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => vscode.setState(captureViewState()), 180);
}

function scrollToPage(pageNumber, behavior = "smooth") {
  const record = state.pageStates[clamp(pageNumber, 1, state.pageStates.length) - 1];
  if (!record) {
    return;
  }
  elements.viewer.scrollTo({ top: Math.max(0, record.shell.offsetTop - 12), behavior });
}

function updateSelectionToolUi() {
  elements.viewer.dataset.selectionTool = state.selectionTool;
  elements.viewer.dataset.directEdit = String(state.interactionMode === "direct");
  elements.viewer.dataset.interactionMode = state.interactionMode;
  elements.regionSelect.setAttribute("aria-pressed", String(state.selectionTool === "region"));
  elements.directEdit.setAttribute("aria-pressed", String(state.selectionTool === "text"));
  elements.modeDirect.setAttribute("aria-pressed", String(state.interactionMode === "direct"));
  elements.modeAgent.setAttribute("aria-pressed", String(state.interactionMode === "agent"));
  elements.promptBar.hidden = state.interactionMode !== "agent";
  elements.manualEditBar.hidden = state.interactionMode !== "direct";
  updateClearSelectionAvailability();
  updateManualEditAvailability();
}

function updateClearSelectionAvailability() {
  elements.clearSelection.disabled = isWriteInteractionBusy() || !(
    state.regionDraft ||
    state.regionSelection ||
    state.imageEditDraft ||
    state.directDraft ||
    state.selectionRequestId ||
    state.sessionId ||
    state.mappingId
  );
}

function setSelectionTool(tool) {
  if (isWriteInteractionBusy()) {
    return;
  }
  const requestedTool = tool === "region" ? "region" : "text";
  const nextTool = requestedTool === state.selectionTool ? "none" : requestedTool;
  if (state.imageEditDraft || state.directDraft?.text?.length > 0) {
    if (state.imageEditDraft) {
      setStatus("当前图片尺寸候选尚未确认，请先确认或取消。", "warning");
      return;
    }
    setStatus("当前直接编辑草稿已有内容，请先提交或按 Esc 取消。", "warning");
    elements.directInput.focus({ preventScroll: true });
    return;
  }
  discardDirectDraft();
  state.selectionTool = nextTool;
  if (state.selectionTool !== "region") {
    cancelRegionDraft();
  }
  updateSelectionToolUi();
  scheduleStateSave();
  setStatus(
    state.selectionTool === "region"
      ? "已启用区域框选工具；再次单击可关闭。"
      : state.selectionTool === "text"
        ? "已启用文字或光标工具；再次单击可关闭。"
        : "选择工具已关闭，可正常阅读和复制 PDF 文字。",
    "ready"
  );
}

function setInteractionMode(mode) {
  if (isWriteInteractionBusy()) {
    return;
  }
  const nextMode = mode === "direct" ? "direct" : "agent";
  if (nextMode === state.interactionMode) {
    return;
  }
  if (state.selectionRequestId) {
    setStatus("正在定位当前选区，请等待定位完成后再切换处理方式。", "warning");
    return;
  }
  if (state.imageEditDraft || state.directDraft?.text?.length > 0) {
    if (state.imageEditDraft) {
      setStatus("当前图片尺寸候选尚未确认，请先确认或取消。", "warning");
      return;
    }
    setStatus("当前直接编辑草稿已有内容，请先提交或按 Esc 取消。", "warning");
    elements.directInput.focus({ preventScroll: true });
    return;
  }
  discardDirectDraft();
  state.interactionMode = nextMode;
  state.interactionVersion += 1;
  updateSelectionToolUi();
  scheduleStateSave();
  setStatus(
    state.interactionMode === "direct"
      ? "直接编辑模式：文字和区域框选均可替换或删除；文字工具还支持光标插入。"
      : "Agent 模式：使用当前选择工具建立选区后输入任务要求。",
    "ready"
  );
}

function beginRegionDraft(event) {
  if (state.selectionTool !== "region" || event.button !== 0 || isWriteInteractionBusy()) {
    return;
  }
  const shell = event.target.closest?.(".pdf-page");
  const pageNumber = Number(shell?.dataset.pageNumber);
  const record = state.pageStates[pageNumber - 1];
  if (!record) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (record.rotation !== 0) {
    setStatus("当前版本暂不支持旋转页面的区域框选。", "error");
    return;
  }
  if (record.status !== "rendered" || !record.textLayerElement) {
    setStatus("当前页面文字尚未完成渲染。", "warning");
    enqueuePage(record);
    pumpRenderQueue();
    return;
  }

  window.getSelection()?.removeAllRanges();
  clearLocalSession(true);
  const point = clientPointToPdf(record, event.clientX, event.clientY);
  state.regionDraft = {
    pointerId: event.pointerId,
    pageNumber,
    start: point,
    current: point,
    element: undefined
  };
  try {
    elements.pages.setPointerCapture(event.pointerId);
  } catch {
    // Webview 中的指针捕获仅作尽力处理。
  }
  renderRegionDraft();
  updateClearSelectionAvailability();
  setStatus("区域框选中。", "ready");
}

function moveRegionDraft(event) {
  const draft = state.regionDraft;
  if (!draft || event.pointerId !== draft.pointerId) {
    return;
  }
  const record = state.pageStates[draft.pageNumber - 1];
  if (!record) {
    cancelRegionDraft();
    return;
  }
  event.preventDefault();
  draft.current = clientPointToPdf(record, event.clientX, event.clientY);
  renderRegionDraft();
}

function finishRegionDraft(event) {
  const draft = state.regionDraft;
  if (!draft || event.pointerId !== draft.pointerId) {
    return;
  }
  event.preventDefault();
  const record = state.pageStates[draft.pageNumber - 1];
  if (!record) {
    cancelRegionDraft();
    return;
  }
  draft.current = clientPointToPdf(record, event.clientX, event.clientY);
  const bounds = normalizePdfRect(draft.start, draft.current);
  releaseRegionPointer(draft.pointerId);
  draft.element?.remove();
  state.regionDraft = undefined;

  if (bounds.width * state.scale < 6 || bounds.height * state.scale < 6) {
    updateClearSelectionAvailability();
    setStatus("未形成有效的区域选区。", "warning");
    return;
  }

  try {
    const extracted = extractRegionContent(record, bounds);
    if (!extracted.text || isPredominantlyGraphicRegion(record, bounds, extracted)) {
      if (state.interactionMode !== "direct") {
        updateClearSelectionAvailability();
        setStatus("该区域没有可提取的 PDF 文字。图片尺寸调整请切换到直编。", "warning");
        return;
      }
      beginImageEditLocation(record, bounds);
      return;
    }
    if (extracted.text.length > 10_000) {
      updateClearSelectionAvailability();
      setStatus("区域内文字超过 10000 字，请缩小选区。", "warning");
      return;
    }

    state.regionSelection = {
      pageNumber: record.number,
      bounds,
      highlights: extracted.highlights,
      element: undefined
    };
    renderRegionSelection(record);
    beginLocalSelection(record.number, extracted.text.length, "区域框选");
    state.selectedPages = new Set([record.number]);
    state.selectedPage = record.number;
    const requestId = createId();
    state.selectionRequestId = requestId;
    const interactionVersion = state.interactionVersion;
    post("selection", {
      requestId,
      selectionKind: "region",
      interactionMode: state.interactionMode,
      interactionVersion,
      text: extracted.text,
      page: record.number,
      start: extracted.start,
      end: extracted.end,
      bounds,
      anchors: extracted.anchors,
      fragments: extracted.fragments
    });
    if (state.interactionMode === "direct") {
      const normalizedRects = extracted.highlights.map((rect) => ({
        page: record.number,
        x: rect.x / record.widthPt,
        y: rect.y / record.heightPt,
        width: rect.width / record.widthPt,
        height: rect.height / record.heightPt
      }));
      state.textSelection = { pageNumber: record.number, rects: normalizedRects };
      state.directDraft = {
        page: record.number,
        rects: normalizedRects,
        selectionRects: normalizedRects,
        backwardRects: [],
        forwardRects: [],
        selectionKind: "region",
        baseKind: "replace",
        kind: "replace",
        text: "",
        selectionRequestId: requestId,
        interactionVersion,
        mapped: false,
        commitRequested: false
      };
      renderAllDirectDraftOverlays(record.number);
      setStatus("区域直接编辑草稿已建立，输入文字替换整个区域，或按 Delete 删除。", "ready");
    }
    updateVisiblePages();
    updateClearSelectionAvailability();
  } catch (error) {
    clearRegionSelection();
    updateClearSelectionAvailability();
    setStatus(error.message || String(error), "error");
  }
}

function cancelRegionDraft() {
  const draft = state.regionDraft;
  if (!draft) {
    return;
  }
  releaseRegionPointer(draft.pointerId);
  draft.element?.remove();
  state.regionDraft = undefined;
  updateClearSelectionAvailability();
}

function releaseRegionPointer(pointerId) {
  try {
    if (elements.pages.hasPointerCapture(pointerId)) {
      elements.pages.releasePointerCapture(pointerId);
    }
  } catch {
    // 浏览器可能已经释放该指针。
  }
}

function clearRegionSelection() {
  cancelRegionDraft();
  state.regionSelection?.element?.remove();
  state.regionSelection = undefined;
}

function buildImageAnchors(bounds) {
  const insetX = Math.min(bounds.width * 0.12, 8);
  const insetY = Math.min(bounds.height * 0.12, 8);
  const left = bounds.x + insetX;
  const right = bounds.x + bounds.width - insetX;
  const top = bounds.y + insetY;
  const bottom = bounds.y + bounds.height - insetY;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return [
    { x: centerX, y: centerY },
    { x: left, y: top }, { x: right, y: top },
    { x: left, y: bottom }, { x: right, y: bottom },
    { x: centerX, y: top }, { x: centerX, y: bottom },
    { x: left, y: centerY }, { x: right, y: centerY }
  ];
}

async function cachePageImageBoundaries(record, page, viewport, documentGeneration, renderGeneration, scale) {
  try {
    const operatorList = await page.getOperatorList();
    if (isRenderStale(record, documentGeneration, renderGeneration, scale)) return;
    record.imageBoundaries = extractPdfImageBoundaries(operatorList, viewport, record.widthPt, record.heightPt);
    record.shell.dataset.imageCount = String(record.imageBoundaries.length);
    record.shell.dataset.imageBoundaries = JSON.stringify(record.imageBoundaries);
  } catch (error) {
    record.imageBoundaries = [];
    record.shell.dataset.imageCount = "0";
    delete record.shell.dataset.imageBoundaries;
    console.error(error);
  }
}

function scheduleImageBoundaryCache(record, page, viewport, documentGeneration, renderGeneration, scale, primary) {
  const run = () => void cachePageImageBoundaries(record, page, viewport, documentGeneration, renderGeneration, scale);
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: primary ? 450 : 1_200 });
  } else {
    setTimeout(run, primary ? 50 : 180);
  }
}

function extractPdfImageBoundaries(operatorList, viewport, pageWidth, pageHeight) {
  const boundaries = [];
  const stack = [];
  let transform = [1, 0, 0, 1, 0, 0];
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] ?? [];
    if (operation === pdfjs.OPS.save) {
      stack.push(transform.slice());
    } else if (operation === pdfjs.OPS.restore) {
      transform = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (operation === pdfjs.OPS.transform && args.length >= 6) {
      transform = multiplyPdfTransform(transform, args.slice(0, 6));
    } else if ([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject].includes(operation)) {
      const corners = [
        applyPdfTransform(viewport.transform, applyPdfTransform(transform, [0, 0])),
        applyPdfTransform(viewport.transform, applyPdfTransform(transform, [1, 0])),
        applyPdfTransform(viewport.transform, applyPdfTransform(transform, [0, 1])),
        applyPdfTransform(viewport.transform, applyPdfTransform(transform, [1, 1]))
      ];
      const xs = corners.map((point) => point[0] / viewport.scale);
      const ys = corners.map((point) => point[1] / viewport.scale);
      const x = clamp(Math.min(...xs), 0, pageWidth);
      const y = clamp(Math.min(...ys), 0, pageHeight);
      const right = clamp(Math.max(...xs), 0, pageWidth);
      const bottom = clamp(Math.max(...ys), 0, pageHeight);
      const width = right - x;
      const height = bottom - y;
      if (width >= 8 && height >= 8 && width * height >= 400) {
        boundaries.push({
          x, y, width, height,
          objectName: typeof args[0] === "string" ? args[0] : `inline-${index}`,
          pixelWidth: Number.isFinite(args[1]) ? args[1] : undefined,
          pixelHeight: Number.isFinite(args[2]) ? args[2] : undefined
        });
      }
    }
  }
  return deduplicateImageBoundaries(boundaries);
}

function multiplyPdfTransform(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]
  ];
}

function applyPdfTransform(transform, point) {
  return [
    transform[0] * point[0] + transform[2] * point[1] + transform[4],
    transform[1] * point[0] + transform[3] * point[1] + transform[5]
  ];
}

function deduplicateImageBoundaries(boundaries) {
  return boundaries.filter((boundary, index) => !boundaries.some((other, otherIndex) => otherIndex < index &&
    Math.abs(boundary.x - other.x) < 0.5 && Math.abs(boundary.y - other.y) < 0.5 &&
    Math.abs(boundary.width - other.width) < 0.5 && Math.abs(boundary.height - other.height) < 0.5
  ));
}

function selectSnappedImageBoundary(bounds, boundaries) {
  const selectionArea = bounds.width * bounds.height;
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const matches = boundaries.map((boundary) => {
    const intersectionWidth = Math.max(0, Math.min(bounds.x + bounds.width, boundary.x + boundary.width) - Math.max(bounds.x, boundary.x));
    const intersectionHeight = Math.max(0, Math.min(bounds.y + bounds.height, boundary.y + boundary.height) - Math.max(bounds.y, boundary.y));
    const intersection = intersectionWidth * intersectionHeight;
    const imageArea = boundary.width * boundary.height;
    const intersectionOverSelection = intersection / selectionArea;
    const intersectionOverImage = intersection / imageArea;
    const centerInside = center.x >= boundary.x && center.x <= boundary.x + boundary.width &&
      center.y >= boundary.y && center.y <= boundary.y + boundary.height;
    const imageCenter = { x: boundary.x + boundary.width / 2, y: boundary.y + boundary.height / 2 };
    const centerScore = Math.max(0, 1 - Math.hypot(center.x - imageCenter.x, center.y - imageCenter.y) /
      Math.max(1, Math.hypot(bounds.width, bounds.height)));
    return {
      boundary,
      centerInside,
      intersectionOverSelection,
      intersectionOverImage,
      score: intersectionOverSelection * 0.3 + intersectionOverImage * 0.45 + centerScore * 0.1 + (centerInside ? 0.15 : 0)
    };
  }).filter((match) => match.intersectionOverSelection >= 0.06 && match.intersectionOverImage >= 0.12)
    .sort((left, right) => right.score - left.score);
  const best = matches[0];
  if (!best || best.score < 0.34) throw new Error("粗选区域没有覆盖可识别的嵌入图片，请扩大选框使其覆盖图片主体。");
  const runnerUp = matches[1];
  if (runnerUp && best.score - runnerUp.score < 0.1 && (runnerUp.centerInside === best.centerInside || runnerUp.score >= best.score * 0.86)) {
    throw new Error("粗选区域同时覆盖多张图片，无法确定唯一目标。请缩小选框，只覆盖一张图片主体。");
  }
  return best.boundary;
}

function beginImageEditLocation(record, bounds) {
  const snapped = selectSnappedImageBoundary(bounds, record.imageBoundaries ?? []);
  const requestId = createId();
  state.imageLocateRequestId = requestId;
  state.regionSelection = {
    pageNumber: record.number,
    bounds: snapped,
    roughBounds: bounds,
    highlights: [],
    element: undefined,
    image: true
  };
  renderRegionSelection(record);
  state.busyAction = "locateImage";
  updateManualEditAvailability();
  updateClearSelectionAvailability();
  setStatus("正在定位框选图片对应的 LaTeX 命令……", "busy");
  post("locateImage", {
    requestId,
    interactionVersion: state.interactionVersion,
    page: record.number,
    pageWidth: record.widthPt,
    pageHeight: record.heightPt,
    bounds: snapped,
    roughBounds: bounds,
    imageObjectName: snapped.objectName,
    anchors: buildImageAnchors(snapped)
  });
}

function clearImageEditDraft() {
  state.imageEditDraft = undefined;
  state.imageLocateRequestId = undefined;
  state.imageQueueRequestId = undefined;
  for (const overlay of document.querySelectorAll(".image-edit-draft-overlay")) overlay.remove();
  document.querySelector(".image-edit-floating-controls")?.remove();
}

function adjustImageEditDraft(direction) {
  const draft = state.imageEditDraft;
  if (!draft || isWriteInteractionBusy()) return;
  const step = direction > 0 ? 0.05 : -0.05;
  draft.factor = clamp(Number((draft.factor + step).toFixed(2)), 0.25, 3);
  renderImageEditDraft();
  updateClearSelectionAvailability();
}

function queueImageEditDraft() {
  const draft = state.imageEditDraft;
  if (!draft || isWriteInteractionBusy()) return;
  if (Math.abs(draft.factor - 1) < 0.0001) {
    setStatus("图片尺寸尚未调整，请先单击放大或缩小。", "warning");
    return;
  }
  const requestId = createId();
  state.imageQueueRequestId = requestId;
  state.busyAction = "queueImageEdit";
  updateManualEditAvailability();
  setStatus("正在加入图片尺寸调整……", "busy");
  post("queueImageEdit", {
    requestId,
    targetId: draft.targetId,
    factor: draft.factor,
    queueVersion: state.manualEditQueueVersion
  });
}

function requestCompile() {
  if (isWriteInteractionBusy()) return;
  if (state.imageEditDraft || state.directDraft) {
    setStatus("请先使用 Ctrl+Enter 暂存当前编辑，或按 Esc 取消。", "warning");
    return;
  }
  state.busyAction = "compile";
  elements.compile.disabled = true;
  updateManualEditAvailability();
  post("compile", { queueVersion: state.manualEditQueueVersion });
}

function cancelImageEditDraft() {
  if (!state.imageEditDraft && !state.imageLocateRequestId) return false;
  clearImageEditDraft();
  clearRegionSelection();
  state.busyAction = undefined;
  updateManualEditAvailability();
  updateClearSelectionAvailability();
  setStatus("已取消图片尺寸调整。", "ready");
  return true;
}

function renderImageEditDraft() {
  for (const overlay of document.querySelectorAll(".image-edit-draft-overlay")) overlay.remove();
  document.querySelector(".image-edit-floating-controls")?.remove();
  const draft = state.imageEditDraft;
  const record = draft ? state.pageStates[draft.page - 1] : undefined;
  const rect = draft?.rects?.[0];
  if (!draft || !record || !rect) return;
  const overlay = document.createElement("div");
  overlay.className = "image-edit-draft-overlay";
  const preview = document.createElement("div");
  preview.className = "image-edit-preview";
  const original = document.createElement("div");
  original.className = "image-edit-original";
  applyNormalizedRectStyle(original, rect);
  const syncTex = draft.syncTexBounds;
  if (syncTex && Number.isFinite(syncTex.x) && Number.isFinite(syncTex.y) &&
    Number.isFinite(syncTex.width) && Number.isFinite(syncTex.height)) {
    const diagnostic = document.createElement("div");
    diagnostic.className = "image-edit-synctex";
    diagnostic.title = "SyncTeX 源码命令定位范围";
    applyNormalizedRectStyle(diagnostic, syncTex);
    overlay.append(diagnostic);
  }
  const scaledWidth = clamp(rect.width * draft.factor, 0.01, 1);
  const scaledHeight = clamp(rect.height * draft.factor, 0.01, 1);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  applyNormalizedRectStyle(preview, {
    x: clamp(centerX - scaledWidth / 2, 0, 1 - scaledWidth),
    y: clamp(centerY - scaledHeight / 2, 0, 1 - scaledHeight),
    width: scaledWidth,
    height: scaledHeight
  });
  const controls = document.createElement("div");
  controls.className = "image-edit-floating-controls";
  controls.addEventListener("pointerdown", (event) => event.stopPropagation());
  controls.addEventListener("pointerup", (event) => event.stopPropagation());
  controls.addEventListener("click", (event) => event.stopPropagation());
  const enlarge = document.createElement("button");
  enlarge.type = "button";
  enlarge.textContent = "↑";
  enlarge.title = "图片放大 5%";
  enlarge.setAttribute("aria-label", "图片放大 5%");
  enlarge.addEventListener("click", () => adjustImageEditDraft(1));
  const shrink = document.createElement("button");
  shrink.type = "button";
  shrink.textContent = "↓";
  shrink.title = "图片缩小 5%";
  shrink.setAttribute("aria-label", "图片缩小 5%");
  shrink.addEventListener("click", () => adjustImageEditDraft(-1));
  const value = document.createElement("span");
  value.className = "image-edit-value";
  value.textContent = `${draft.originalValue} → ${Math.round(draft.factor * 100)}%`;
  value.title = draft.imagePath;
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.textContent = "确认";
  confirm.title = "暂存图片尺寸调整（Ctrl+Enter）";
  confirm.setAttribute("aria-label", "暂存图片尺寸调整，快捷键 Ctrl+Enter");
  confirm.setAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
  confirm.disabled = Math.abs(draft.factor - 1) < 0.0001;
  confirm.addEventListener("click", queueImageEditDraft);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  cancel.addEventListener("click", cancelImageEditDraft);
  controls.append(enlarge, shrink, value, confirm, cancel);
  overlay.append(original, preview);
  record.shell.append(overlay);
  document.body.append(controls);
  requestAnimationFrame(positionImageEditControls);
}

function positionImageEditControls() {
  const controls = document.querySelector(".image-edit-floating-controls");
  const draft = state.imageEditDraft;
  const record = draft ? state.pageStates[draft.page - 1] : undefined;
  const rect = draft?.rects?.[0];
  if (!controls || !record || !rect) return;
  const viewerRect = elements.viewer.getBoundingClientRect();
  const pageRect = record.shell.getBoundingClientRect();
  const imageRect = {
    left: pageRect.left + rect.x * pageRect.width,
    top: pageRect.top + rect.y * pageRect.height,
    right: pageRect.left + (rect.x + rect.width) * pageRect.width,
    bottom: pageRect.top + (rect.y + rect.height) * pageRect.height
  };
  const visible = imageRect.right > viewerRect.left && imageRect.left < viewerRect.right &&
    imageRect.bottom > viewerRect.top && imageRect.top < viewerRect.bottom;
  controls.hidden = !visible;
  if (!visible) return;
  const margin = 8;
  controls.style.maxWidth = `${Math.max(120, Math.floor(viewerRect.width - margin * 2))}px`;
  controls.style.visibility = "hidden";
  controls.style.left = "0px";
  controls.style.top = "0px";
  controls.hidden = false;
  const controlRect = controls.getBoundingClientRect();
  const centerY = imageRect.top + (imageRect.bottom - imageRect.top) / 2;
  const centerX = imageRect.left + (imageRect.right - imageRect.left) / 2;
  let left;
  let top;
  if (viewerRect.right - imageRect.right >= controlRect.width + margin) {
    left = imageRect.right + margin;
    top = centerY - controlRect.height / 2;
  } else if (imageRect.left - viewerRect.left >= controlRect.width + margin) {
    left = imageRect.left - controlRect.width - margin;
    top = centerY - controlRect.height / 2;
  } else if (viewerRect.bottom - imageRect.bottom >= controlRect.height + margin) {
    left = centerX - controlRect.width / 2;
    top = imageRect.bottom + margin;
  } else {
    left = centerX - controlRect.width / 2;
    top = imageRect.top - controlRect.height - margin;
  }
  const minimumLeft = viewerRect.left + margin;
  const minimumTop = viewerRect.top + margin;
  const maximumLeft = Math.max(minimumLeft, viewerRect.right - controlRect.width - margin);
  const maximumTop = Math.max(minimumTop, viewerRect.bottom - controlRect.height - margin);
  controls.style.left = `${Math.round(clamp(left, minimumLeft, maximumLeft))}px`;
  controls.style.top = `${Math.round(clamp(top, minimumTop, maximumTop))}px`;
  controls.style.visibility = "visible";
}

function renderRegionDraft() {
  const draft = state.regionDraft;
  const record = draft ? state.pageStates[draft.pageNumber - 1] : undefined;
  if (!draft || !record) {
    return;
  }
  if (!draft.element || draft.element.parentElement !== record.shell) {
    draft.element?.remove();
    draft.element = document.createElement("div");
    draft.element.className = "region-selection-draft";
    record.shell.append(draft.element);
  }
  applyPdfRectStyle(draft.element, normalizePdfRect(draft.start, draft.current));
}

function renderRegionSelection(record) {
  const selection = state.regionSelection;
  if (!selection || selection.pageNumber !== record.number) {
    return;
  }
  selection.element?.remove();
  const overlay = document.createElement("div");
  overlay.className = "region-selection-overlay";
  const outline = document.createElement("div");
  outline.className = `region-selection-outline${selection.image ? " region-selection-outline-image" : ""}`;
  applyPdfRectStyle(outline, selection.bounds);
  overlay.append(outline);
  if (selection.image && selection.roughBounds) {
    const rough = document.createElement("div");
    rough.className = "region-selection-rough";
    applyPdfRectStyle(rough, selection.roughBounds);
    overlay.append(rough);
  }
  for (const rect of selection.highlights) {
    const hit = document.createElement("div");
    hit.className = "region-selection-hit";
    applyPdfRectStyle(hit, rect);
    overlay.append(hit);
  }
  record.shell.append(overlay);
  selection.element = overlay;
}

function renderManualEditOverlay(record) {
  record.shell.querySelector(":scope > .manual-edit-overlay")?.remove();
  const edits = state.pendingManualEdits.filter((edit) =>
    edit.rects.some((rect) => (rect.page ?? edit.page) === record.number)
  );
  if (edits.length === 0) {
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "manual-edit-overlay";
  overlay.dataset.pageNumber = String(record.number);
  for (const edit of edits) {
    const group = document.createElement("div");
    group.className = `manual-edit manual-edit-${edit.kind}`;
    group.dataset.editId = edit.id;
    if (edit.editType === "image") {
      for (const rect of edit.rects.filter((item) => (item.page ?? edit.page) === record.number)) {
        const image = document.createElement("div");
        image.className = "manual-edit-image";
        image.title = `${edit.originalValue} → ${edit.candidateValue}`;
        applyNormalizedRectStyle(image, rect);
        group.append(image);
      }
    } else if (edit.kind === "delete" || edit.kind === "replace") {
      for (const rect of edit.rects.filter((item) => (item.page ?? edit.page) === record.number)) {
        const deletion = document.createElement("div");
        deletion.className = "manual-edit-deletion";
        applyNormalizedRectStyle(deletion, rect);
        group.append(deletion);
      }
    }

    if (edit.kind !== "delete" && edit.insertedText) {
      const pageRects = edit.rects.filter((item) => (item.page ?? edit.page) === record.number);
      const anchorPage = edit.kind === "insertAfter"
        ? Math.max(...edit.rects.map((item) => item.page ?? edit.page))
        : Math.min(...edit.rects.map((item) => item.page ?? edit.page));
      const anchor = record.number === anchorPage
        ? edit.kind === "insertAfter" ? pageRects.at(-1) : pageRects[0]
        : undefined;
      if (anchor) {
        const insertion = document.createElement("span");
        insertion.className = `manual-edit-insertion manual-edit-insertion-${edit.kind}`;
        insertion.textContent = edit.insertedText;
        insertion.title = edit.insertedText;
        const anchorX = edit.kind === "insertAfter" ? anchor.x + anchor.width : anchor.x;
        const anchorY = edit.kind === "insertAfter" ? anchor.y + anchor.height : anchor.y;
        insertion.style.left = `${clamp(anchorX, 0, 1) * 100}%`;
        insertion.style.top = `${clamp(anchorY, 0, 1) * 100}%`;
        const marker = document.createElement("span");
        marker.className = `manual-edit-insertion-marker manual-edit-insertion-marker-${edit.kind}`;
        marker.style.left = `${clamp(anchorX, 0, 1) * 100}%`;
        marker.style.top = `${clamp(anchor.y, 0, 1) * 100}%`;
        marker.style.height = `${Math.max(anchor.height, 0.008) * 100}%`;
        const lead = document.createElement("span");
        lead.className = `manual-edit-insertion-lead manual-edit-insertion-lead-${edit.kind}`;
        lead.style.left = `${clamp(anchorX, 0, 1) * 100}%`;
        lead.style.top = `${clamp(anchorY, 0, 1) * 100}%`;
        group.append(marker, lead, insertion);
      }
    }
    overlay.append(group);
  }
  record.shell.append(overlay);
}

function applyNormalizedRectStyle(element, rect) {
  element.style.left = `${rect.x * 100}%`;
  element.style.top = `${rect.y * 100}%`;
  element.style.width = `${rect.width * 100}%`;
  element.style.height = `${rect.height * 100}%`;
}

function renderAllManualEditOverlays() {
  for (const record of state.pageStates) {
    renderManualEditOverlay(record);
  }
}

function parkDirectInput() {
  if (elements.directInput.parentElement !== document.body) {
    document.body.append(elements.directInput);
  }
  elements.directInput.hidden = true;
}

function discardDirectDraft() {
  parkDirectInput();
  for (const overlay of document.querySelectorAll(".direct-edit-draft-overlay")) {
    overlay.remove();
  }
  state.directDraft = undefined;
  state.directCaptureSpec = undefined;
  state.directInputComposing = false;
  state.directQueueRequestId = undefined;
}

function renderDirectDraft(record, focusInput = false) {
  const existing = record.shell.querySelector(":scope > .direct-edit-draft-overlay");
  if (existing?.contains(elements.directInput)) {
    parkDirectInput();
  }
  existing?.remove();
  const draft = state.directDraft;
  const pageRects = draft?.rects.filter((rect) => (rect.page ?? draft.page) === record.number) ?? [];
  if (!draft || pageRects.length === 0) {
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "direct-edit-draft-overlay";
  overlay.dataset.kind = draft.kind;
  overlay.dataset.pageNumber = String(record.number);
  for (const rect of pageRects) {
    const target = document.createElement("div");
    target.className = "direct-edit-draft-target";
    applyNormalizedRectStyle(target, rect);
    overlay.append(target);
  }

  const first = pageRects[0];
  const last = pageRects.at(-1) ?? first;
  if (!first || !last) {
    return;
  }
  const anchorX = draft.caretRect
    ? draft.caretRect.x
    : draft.kind === "insertAfter" ? last.x + last.width : first.x;
  const anchorY = draft.caretRect
    ? draft.caretRect.y
    : draft.kind === "insertAfter" ? last.y + last.height : first.y;
  const caret = document.createElement("div");
  caret.className = "direct-edit-caret";
  caret.style.left = `${clamp(anchorX, 0, 1) * 100}%`;
  caret.style.top = `${clamp(anchorY, 0, 1) * 100}%`;
  caret.style.height = `${Math.max(0.012, draft.caretRect?.height ?? first.height) * 100}%`;
  overlay.append(caret);

  const inputPage = Math.max(...draft.rects.map((rect) => rect.page ?? draft.page));
  if (record.number !== inputPage) {
    record.shell.append(overlay);
    return;
  }

  elements.directInput.hidden = false;
  elements.directInput.dataset.kind = draft.kind;
  elements.directInput.placeholder = draft.kind === "delete"
    ? draft.caretVisibleOffset !== undefined
      ? "删除相邻一个字素；批量删除请拖选"
      : "删除所选文字，Ctrl+Enter 提交"
    : draft.caretVisibleOffset !== undefined
      ? "输入插入文字，Ctrl+Enter 提交"
      : "输入替换文字，Ctrl+Enter 提交";
  if (!state.directInputComposing && elements.directInput.value !== draft.text) {
    elements.directInput.value = draft.text;
  }
  const shellRect = record.shell.getBoundingClientRect();
  const projectedAnchorX = shellRect.left + clamp(anchorX, 0, 1) * shellRect.width;
  const projectedAnchorY = shellRect.top + clamp(anchorY, 0, 1) * shellRect.height;
  const inputWidth = Math.min(
    Math.max(180, window.innerWidth * 0.34),
    360,
    Math.max(80, window.innerWidth - 24)
  );
  const alignRight = projectedAnchorX + inputWidth > window.innerWidth - 12;
  const inputClientX = alignRight
    ? clamp(projectedAnchorX, 12 + inputWidth, window.innerWidth - 12)
    : clamp(projectedAnchorX, 12, window.innerWidth - inputWidth - 12);
  const inputAnchorX = clamp((inputClientX - shellRect.left) / Math.max(1, shellRect.width), 0.001, 0.999);
  elements.directInput.style.left = `${inputAnchorX * 100}%`;
  elements.directInput.style.top = `${clamp(anchorY, 0.01, 0.99) * 100}%`;
  elements.directInput.classList.toggle("direct-edit-input-below", projectedAnchorY < 88);
  elements.directInput.classList.toggle("direct-edit-input-right", alignRight);
  overlay.append(elements.directInput);
  record.shell.append(overlay);
  updateDirectDraftPresentation();
  if (focusInput) {
    requestAnimationFrame(() => {
      if (state.directDraft === draft && !elements.directInput.hidden) {
        elements.directInput.focus({ preventScroll: true });
        elements.directInput.setSelectionRange(elements.directInput.value.length, elements.directInput.value.length);
      }
    });
  }
}

function beginTextSelectionDrag(event) {
  if (state.selectionTool !== "text" || event.button !== 0 || isWriteInteractionBusy()) return;
  const page = Number(event.target.closest?.(".pdf-page")?.dataset.pageNumber);
  if (!positivePage(page)) return;
  state.textSelectionDrag = { startPage: page, endPage: page };
  state.selectedPages = new Set([page]);
}

function moveTextSelectionDrag(event) {
  const drag = state.textSelectionDrag;
  if (!drag || (event.buttons & 1) === 0) return;
  const page = Number(document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".pdf-page")?.dataset.pageNumber);
  if (!positivePage(page)) return;
  const start = Math.min(drag.startPage, page);
  const end = Math.max(drag.startPage, page);
  if (end - start + 1 > 12) return;
  drag.endPage = page;
  state.selectedPages = new Set(Array.from({ length: end - start + 1 }, (_, index) => start + index));
  updateVisiblePages();
}

function finishTextSelectionDrag() {
  if (!state.textSelectionDrag) return;
  state.textSelectionDrag = undefined;
  if (!state.textSelection && !state.selectionRequestId && !state.sessionId) {
    state.selectedPages = new Set();
    updateVisiblePages();
  }
}

function renderAllDirectDraftOverlays(focusPage) {
  for (const record of state.pageStates) {
    renderDirectDraft(record, record.number === focusPage);
  }
}

function updateDirectDraftPresentation() {
  const draft = state.directDraft;
  const overlays = document.querySelectorAll(".direct-edit-draft-overlay");
  if (!draft || overlays.length === 0) {
    return;
  }
  for (const overlay of overlays) overlay.dataset.kind = draft.kind;
  elements.directInput.dataset.kind = draft.kind;
  elements.directInput.placeholder = draft.kind === "delete"
    ? draft.caretVisibleOffset !== undefined
      ? "删除相邻一个字素；批量删除请拖选"
      : "删除所选文字，Ctrl+Enter 提交"
    : draft.caretVisibleOffset !== undefined
      ? "输入插入文字，Ctrl+Enter 提交"
      : "输入替换文字，Ctrl+Enter 提交";
}

function applyPdfRectStyle(element, rect) {
  element.style.left = `${rect.x * state.scale}px`;
  element.style.top = `${rect.y * state.scale}px`;
  element.style.width = `${Math.max(1, rect.width * state.scale)}px`;
  element.style.height = `${Math.max(1, rect.height * state.scale)}px`;
}

function normalizePdfRect(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}

function clientPointToPdf(record, clientX, clientY) {
  const rect = record.shell.getBoundingClientRect();
  return {
    x: clamp((clientX - rect.left) * record.widthPt / Math.max(1, rect.width), 0, record.widthPt),
    y: clamp((clientY - rect.top) * record.heightPt / Math.max(1, rect.height), 0, record.heightPt)
  };
}

function extractRegionContent(record, bounds) {
  const layer = record.textLayerElement;
  if (!layer || record.status !== "rendered") {
    throw new Error("当前页面文字层不可用，请稍后重试。");
  }
  const pageRect = record.shell.getBoundingClientRect();
  const regionRect = {
    left: pageRect.left + bounds.x * pageRect.width / record.widthPt,
    top: pageRect.top + bounds.y * pageRect.height / record.heightPt,
    right: pageRect.left + (bounds.x + bounds.width) * pageRect.width / record.widthPt,
    bottom: pageRect.top + (bounds.y + bounds.height) * pageRect.height / record.heightPt
  };
  const units = collectRegionTextUnits(layer, pageRect, regionRect);
  if (units.length === 0) {
    return { text: "", highlights: [] };
  }
  const lines = groupRegionTextUnits(units);
  const fragments = buildRegionFragments(lines, pageRect, record, bounds);
  const textLines = fragments.map((fragment) => fragment.text);
  if (textLines.length === 0) {
    return { text: "", highlights: [] };
  }
  const orderedUnits = lines.flatMap((line) => line.units).filter((unit) => !/^\s+$/u.test(unit.symbol));
  const first = orderedUnits[0];
  const last = orderedUnits.at(-1);
  return {
    text: textLines.join("\n").trim(),
    start: clientRectCenterToPdf(first, pageRect, record),
    end: clientRectCenterToPdf(last, pageRect, record),
    anchors: buildRegionAnchors(lines, pageRect, record),
    highlights: buildRegionHighlights(lines, pageRect, record),
    fragments
  };
}

function isPredominantlyGraphicRegion(record, bounds, extracted) {
  if (!extracted.text) return true;
  const regionArea = Math.max(1, bounds.width * bounds.height);
  const textArea = extracted.highlights.reduce((sum, rect) => sum + rect.width * rect.height, 0);
  const pageRatio = regionArea / Math.max(1, record.widthPt * record.heightPt);
  const textCoverage = textArea / regionArea;
  return pageRatio >= 0.025 && textCoverage < 0.09 && extracted.text.replace(/\s/gu, "").length < 160;
}

function buildRegionFragments(lines, pageRect, record, bounds) {
  const fragments = [];
  lines.forEach((line, lineIndex) => {
    const visibleUnits = line.units.filter((unit) => !/^\s+$/u.test(unit.symbol));
    for (const cluster of splitRegionLineClusters(visibleUnits, pageRect.width)) {
      const text = buildRegionLineText(cluster);
      if (!text) continue;
      const first = cluster[0];
      const last = cluster.at(-1);
      fragments.push({
        text,
        start: clientRectCenterToPdf(first, pageRect, record),
        end: clientRectCenterToPdf(last, pageRect, record),
        rects: sampleRegionRects(buildRegionHighlights([{ units: cluster }], pageRect, record)
          .map((rect) => intersectPdfRect(rect, bounds))
          .filter((rect) => rect.width > 0 && rect.height > 0)),
        lineIndex
      });
    }
  });
  return fragments;
}

function sampleRegionRects(rects) {
  if (rects.length <= 32) return rects;
  return Array.from({ length: 32 }, (_, index) =>
    rects[Math.round(index * (rects.length - 1) / 31)]
  );
}

function intersectPdfRect(rect, bounds) {
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function buildRegionAnchors(lines, pageRect, record) {
  const anchors = [];
  for (const line of lines) {
    const units = line.units.filter((unit) => !/^\s+$/u.test(unit.symbol));
    for (const cluster of splitRegionLineClusters(units, pageRect.width)) {
      anchors.push(clientRectCenterToPdf(cluster[Math.floor(cluster.length / 2)], pageRect, record));
    }
  }
  if (anchors.length <= 16) {
    return anchors;
  }
  const sampled = [];
  for (let index = 0; index < 16; index += 1) {
    sampled.push(anchors[Math.round(index * (anchors.length - 1) / 15)]);
  }
  return sampled;
}

function splitRegionLineClusters(units, pageWidth) {
  if (units.length === 0) {
    return [];
  }
  const clusters = [[units[0]]];
  for (const unit of units.slice(1)) {
    const cluster = clusters.at(-1);
    const previous = cluster.at(-1);
    const gap = unit.left - previous.right;
    const threshold = Math.max(pageWidth * 0.04, Math.min(previous.height, unit.height) * 2);
    if (gap > threshold) {
      clusters.push([unit]);
    } else {
      cluster.push(unit);
    }
  }
  return clusters;
}

function collectRegionTextUnits(layer, pageRect, regionRect) {
  const units = [];
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.textContent?.length > 0
      ? NodeFilter.FILTER_ACCEPT
      : NodeFilter.FILTER_REJECT
  });
  const range = document.createRange();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    let offset = 0;
    for (const symbol of node.textContent) {
      const nextOffset = offset + symbol.length;
      try {
        range.setStart(node, offset);
        range.setEnd(node, nextOffset);
      } catch {
        offset = nextOffset;
        continue;
      }
      const rect = unionClientRects([...range.getClientRects()], pageRect);
      offset = nextOffset;
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const centerX = (rect.left + rect.right) / 2;
      const centerY = (rect.top + rect.bottom) / 2;
      if (
        centerX < regionRect.left || centerX > regionRect.right ||
        centerY < regionRect.top || centerY > regionRect.bottom
      ) {
        continue;
      }
      units.push({
        symbol,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        centerX,
        centerY
      });
    }
  }
  return units;
}

function unionClientRects(rects, pageRect) {
  const usable = rects.filter((rect) =>
    rect.width > 0 && rect.height > 0 &&
    rect.right > pageRect.left && rect.left < pageRect.right &&
    rect.bottom > pageRect.top && rect.top < pageRect.bottom
  );
  if (usable.length === 0) {
    return undefined;
  }
  const left = Math.max(pageRect.left, Math.min(...usable.map((rect) => rect.left)));
  const top = Math.max(pageRect.top, Math.min(...usable.map((rect) => rect.top)));
  const right = Math.min(pageRect.right, Math.max(...usable.map((rect) => rect.right)));
  const bottom = Math.min(pageRect.bottom, Math.max(...usable.map((rect) => rect.bottom)));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function groupRegionTextUnits(units) {
  const sorted = [...units].sort((left, right) =>
    left.centerY - right.centerY || left.left - right.left
  );
  const lines = [];
  for (const unit of sorted) {
    let line = lines.at(-1);
    const threshold = line ? Math.max(line.averageHeight, unit.height) * 0.65 : 0;
    if (!line || Math.abs(unit.centerY - line.centerY) > threshold) {
      line = { units: [], centerY: unit.centerY, averageHeight: unit.height };
      lines.push(line);
    }
    line.units.push(unit);
    const count = line.units.length;
    line.centerY = ((line.centerY * (count - 1)) + unit.centerY) / count;
    line.averageHeight = ((line.averageHeight * (count - 1)) + unit.height) / count;
  }
  for (const line of lines) {
    line.units.sort((left, right) => left.left - right.left || left.centerY - right.centerY);
  }
  return lines;
}

function buildRegionLineText(units) {
  let result = "";
  let previous;
  for (const unit of units) {
    if (/^\s+$/u.test(unit.symbol)) {
      if (result && !result.endsWith(" ")) result += " ";
      previous = unit;
      continue;
    }
    if (previous && shouldInsertRegionSpace(previous, unit, result)) {
      result += " ";
    }
    result += unit.symbol;
    previous = unit;
  }
  return result.trim();
}

function shouldInsertRegionSpace(previous, current, currentText) {
  if (!currentText || currentText.endsWith(" ") || /^\s+$/u.test(previous.symbol)) {
    return false;
  }
  const gap = current.left - previous.right;
  const threshold = Math.max(1.5, Math.min(previous.height, current.height) * 0.22);
  return gap > threshold && /[A-Za-z0-9]$/u.test(previous.symbol) && /^[A-Za-z0-9]/u.test(current.symbol);
}

function buildRegionHighlights(lines, pageRect, record) {
  const highlights = [];
  for (const line of lines) {
    const visibleUnits = line.units.filter((unit) => !/^\s+$/u.test(unit.symbol));
    let segment;
    for (const unit of visibleUnits) {
      if (!segment) {
        segment = { ...unit };
        continue;
      }
      const gap = unit.left - segment.right;
      const threshold = Math.max(3, Math.min(segment.height, unit.height) * 0.75);
      if (gap <= threshold) {
        segment.left = Math.min(segment.left, unit.left);
        segment.right = Math.max(segment.right, unit.right);
        segment.top = Math.min(segment.top, unit.top);
        segment.bottom = Math.max(segment.bottom, unit.bottom);
        segment.width = segment.right - segment.left;
        segment.height = segment.bottom - segment.top;
      } else {
        highlights.push(clientRectToPdf(segment, pageRect, record));
        segment = { ...unit };
      }
    }
    if (segment) {
      highlights.push(clientRectToPdf(segment, pageRect, record));
    }
  }
  return highlights;
}

function clientRectCenterToPdf(rect, pageRect, record) {
  return {
    x: clamp(((rect.left + rect.right) / 2 - pageRect.left) * record.widthPt / Math.max(1, pageRect.width), 0.5, record.widthPt - 0.5),
    y: clamp(((rect.top + rect.bottom) / 2 - pageRect.top) * record.heightPt / Math.max(1, pageRect.height), 0.5, record.heightPt - 0.5)
  };
}

function clientRectToPdf(rect, pageRect, record) {
  const x = clamp((rect.left - pageRect.left) * record.widthPt / Math.max(1, pageRect.width), 0, record.widthPt);
  const y = clamp((rect.top - pageRect.top) * record.heightPt / Math.max(1, pageRect.height), 0, record.heightPt);
  const right = clamp((rect.right - pageRect.left) * record.widthPt / Math.max(1, pageRect.width), x, record.widthPt);
  const bottom = clamp((rect.bottom - pageRect.top) * record.heightPt / Math.max(1, pageRect.height), y, record.heightPt);
  return { x, y, width: right - x, height: bottom - y };
}

function normalizeTextSelectionRects(rects, pageRect) {
  const normalized = rects.map((rect) => {
    const left = clamp(Math.max(rect.left, pageRect.left), pageRect.left, pageRect.right);
    const top = clamp(Math.max(rect.top, pageRect.top), pageRect.top, pageRect.bottom);
    const right = clamp(Math.min(rect.right, pageRect.right), left, pageRect.right);
    const bottom = clamp(Math.min(rect.bottom, pageRect.bottom), top, pageRect.bottom);
    return {
      x: clamp((left - pageRect.left) / Math.max(1, pageRect.width), 0, 1),
      y: clamp((top - pageRect.top) / Math.max(1, pageRect.height), 0, 1),
      width: clamp((right - left) / Math.max(1, pageRect.width), 0, 1),
      height: clamp((bottom - top) / Math.max(1, pageRect.height), 0, 1)
    };
  }).filter((rect) => rect.width > 0 && rect.height > 0);
  if (normalized.length <= 64) {
    return normalized;
  }
  return Array.from({ length: 64 }, (_, index) =>
    normalized[Math.round(index * (normalized.length - 1) / 63)]
  );
}

const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("und", { granularity: "grapheme" })
  : undefined;

function hangulGraphemeType(character) {
  const codePoint = character.codePointAt(0);
  if ((codePoint >= 0x1100 && codePoint <= 0x115f) || (codePoint >= 0xa960 && codePoint <= 0xa97c)) return "L";
  if ((codePoint >= 0x1160 && codePoint <= 0x11a7) || (codePoint >= 0xd7b0 && codePoint <= 0xd7c6)) return "V";
  if ((codePoint >= 0x11a8 && codePoint <= 0x11ff) || (codePoint >= 0xd7cb && codePoint <= 0xd7fb)) return "T";
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return (codePoint - 0xac00) % 28 === 0 ? "LV" : "LVT";
  return "";
}

function isGraphemeExtension(character) {
  const codePoint = character.codePointAt(0);
  return /^\p{Mark}$/u.test(character) ||
    codePoint === 0x200c ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
    (codePoint >= 0xe0020 && codePoint <= 0xe007f);
}

function shouldJoinFallbackGrapheme(segment, character) {
  const previousCharacters = Array.from(segment);
  const previous = previousCharacters.at(-1);
  if (previous === "\r" && character === "\n") return true;
  if (isGraphemeExtension(character) || character === "\u200d" || previous === "\u200d") return true;
  const previousHangul = hangulGraphemeType(previous);
  const currentHangul = hangulGraphemeType(character);
  if (previousHangul === "L" && ["L", "V", "LV", "LVT"].includes(currentHangul)) return true;
  if (["LV", "V"].includes(previousHangul) && ["V", "T"].includes(currentHangul)) return true;
  if (["LVT", "T"].includes(previousHangul) && currentHangul === "T") return true;
  const isRegionalIndicator = (value) => {
    const codePoint = value.codePointAt(0);
    return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
  };
  return isRegionalIndicator(previous) && isRegionalIndicator(character) &&
    previousCharacters.filter(isRegionalIndicator).length % 2 === 1;
}

function segmentGraphemes(value) {
  const text = String(value);
  if (graphemeSegmenter) {
    return [...graphemeSegmenter.segment(text)].map(({ segment, index }) => ({ segment, index }));
  }
  const segments = [];
  let offset = 0;
  for (const character of text) {
    const previous = segments.at(-1);
    if (previous && shouldJoinFallbackGrapheme(previous.segment, character)) {
      previous.segment += character;
    } else {
      segments.push({ segment: character, index: offset });
    }
    offset += character.length;
  }
  return segments;
}

function visibleTextLength(value) {
  let length = 0;
  for (const source of segmentGraphemes(value)) {
    const normalized = source.segment.normalize("NFKC").replace(/\s/gu, "");
    length += segmentGraphemes(normalized).filter(({ segment }) => segment.length > 0).length;
  }
  return length;
}

function textNodesInLayer(layer) {
  const nodes = [];
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.textContent.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
  });
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }
  return nodes;
}

function normalizeCaretBoundary(node, offset, layer) {
  if (node?.nodeType === Node.TEXT_NODE && layer.contains(node)) {
    return { node, offset: clamp(offset, 0, node.textContent.length) };
  }
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  if (!element || !layer.contains(element)) {
    return undefined;
  }
  const nodes = textNodesInLayer(element);
  if (nodes.length === 0) {
    return undefined;
  }
  return offset <= 0
    ? { node: nodes[0], offset: 0 }
    : { node: nodes.at(-1), offset: nodes.at(-1).textContent.length };
}

function caretBoundaryFromPoint(clientX, clientY, layer) {
  const caretPosition = document.caretPositionFromPoint?.(clientX, clientY);
  const caretRange = caretPosition ? undefined : document.caretRangeFromPoint?.(clientX, clientY);
  return normalizeCaretBoundary(
    caretPosition?.offsetNode ?? caretRange?.startContainer,
    caretPosition?.offset ?? caretRange?.startOffset ?? 0,
    layer
  );
}

function layerTextModel(layer, boundary) {
  const nodes = textNodesInLayer(layer);
  let text = "";
  let boundaryOffset;
  const starts = new Map();
  for (const node of nodes) {
    starts.set(node, text.length);
    if (node === boundary.node) {
      boundaryOffset = text.length + clamp(boundary.offset, 0, node.textContent.length);
    }
    text += node.textContent;
  }
  if (boundaryOffset === undefined) {
    return undefined;
  }
  const positionAt = (rawOffset) => {
    const wanted = clamp(rawOffset, 0, text.length);
    for (const node of nodes) {
      const start = starts.get(node);
      const end = start + node.textContent.length;
      if (wanted <= end) {
        return { node, offset: wanted - start };
      }
    }
    const last = nodes.at(-1);
    return last ? { node: last, offset: last.textContent.length } : undefined;
  };
  return { text, boundaryOffset, positionAt };
}

function graphemeSlices(text) {
  return segmentGraphemes(text).map(({ segment, index }) => ({
    character: segment,
    start: index,
    end: index + segment.length,
    visibleLength: visibleTextLength(segment)
  }));
}

function nearestVisibleSlice(slices, boundaryOffset, direction) {
  const candidates = direction < 0 ? [...slices].reverse() : slices;
  return candidates.find((slice) =>
    slice.visibleLength > 0 && (direction < 0 ? slice.end <= boundaryOffset : slice.start >= boundaryOffset)
  );
}

function characterRange(model, slice) {
  if (!slice) {
    return undefined;
  }
  const start = model.positionAt(slice.start);
  const end = model.positionAt(slice.end);
  if (!start || !end) {
    return undefined;
  }
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

function normalizedRangeRects(range, layer, record) {
  if (!range) {
    return [];
  }
  const layerRect = layer.getBoundingClientRect();
  const pageRect = record.shell.getBoundingClientRect();
  const rects = [...range.getClientRects()].filter((rect) =>
    rect.width > 0 && rect.height > 0 &&
    rect.right > layerRect.left && rect.left < layerRect.right &&
    rect.bottom > layerRect.top && rect.top < layerRect.bottom
  );
  return normalizeTextSelectionRects(rects, pageRect);
}

function buildCaretCapture(event) {
  const layer = event.target.closest?.(".textLayer");
  if (!layer) {
    return undefined;
  }
  const pageNumber = Number(layer.dataset.pageNumber);
  const record = state.pageStates[pageNumber - 1];
  if (!record || record.rotation !== 0) {
    return undefined;
  }
  const boundary = caretBoundaryFromPoint(event.clientX, event.clientY, layer);
  const model = boundary ? layerTextModel(layer, boundary) : undefined;
  if (!model) {
    return undefined;
  }
  const slices = graphemeSlices(model.text);
  let boundaryOffset = model.boundaryOffset;
  const containingSlice = slices.find((slice) => slice.start < boundaryOffset && boundaryOffset < slice.end);
  if (containingSlice) {
    boundaryOffset = boundaryOffset - containingSlice.start < containingSlice.end - boundaryOffset
      ? containingSlice.start
      : containingSlice.end;
  }
  const before = nearestVisibleSlice(slices, boundaryOffset, -1);
  const after = nearestVisibleSlice(slices, boundaryOffset, 1);
  if (!before && !after) {
    return undefined;
  }

  let startOffset = boundaryOffset;
  let endOffset = boundaryOffset;
  let visibleBefore = 0;
  let visibleAfter = 0;
  for (let index = slices.length - 1; index >= 0 && visibleBefore < 12; index -= 1) {
    const slice = slices[index];
    if (slice.end > boundaryOffset) continue;
    startOffset = slice.start;
    visibleBefore += slice.visibleLength;
  }
  for (const slice of slices) {
    if (slice.start < boundaryOffset || visibleAfter >= 12) continue;
    endOffset = slice.end;
    visibleAfter += slice.visibleLength;
  }
  if (startOffset === endOffset) {
    const fallback = before ?? after;
    startOffset = fallback.start;
    endOffset = fallback.end;
  }
  const start = model.positionAt(startOffset);
  const end = model.positionAt(endOffset);
  if (!start || !end) {
    return undefined;
  }
  const anchorRange = document.createRange();
  anchorRange.setStart(start.node, start.offset);
  anchorRange.setEnd(end.node, end.offset);

  const beforeRange = characterRange(model, before);
  const afterRange = characterRange(model, after);
  const beforeClientRect = beforeRange ? [...beforeRange.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).at(-1) : undefined;
  const afterClientRect = afterRange ? [...afterRange.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0)[0] : undefined;
  const beforeRects = normalizedRangeRects(beforeRange, layer, record);
  const afterRects = normalizedRangeRects(afterRange, layer, record);
  const beforeRect = beforeRects.at(-1);
  const afterRect = afterRects[0];
  const distanceToEdge = (rect, edgeX) => {
    if (!rect) return Number.POSITIVE_INFINITY;
    const verticalDistance = event.clientY < rect.top
      ? rect.top - event.clientY
      : event.clientY > rect.bottom
        ? event.clientY - rect.bottom
        : 0;
    return Math.hypot(event.clientX - edgeX, verticalDistance);
  };
  const beforeDistance = distanceToEdge(beforeClientRect, beforeClientRect?.right);
  const afterDistance = distanceToEdge(afterClientRect, afterClientRect?.left);
  const useBeforeEdge = beforeRect && (!afterRect || beforeDistance <= afterDistance);
  const reference = useBeforeEdge ? beforeRect : afterRect ?? beforeRect;
  if (!reference) {
    return undefined;
  }
  const caretX = useBeforeEdge ? beforeRect.x + beforeRect.width : reference.x;
  const caretRect = {
    x: clamp(caretX, 0, 0.9995),
    y: reference.y,
    width: Math.max(0.0005, 1 / Math.max(1, record.shell.clientWidth)),
    height: reference.height
  };
  return {
    range: anchorRange,
    spec: {
      kind: useBeforeEdge ? "insertAfter" : "insertBefore",
      caretRawOffset: boundaryOffset - startOffset,
      caretPoint: {
        x: clamp(caretX, 0, 1) * record.widthPt,
        y: clamp(reference.y + reference.height / 2, 0, 1) * record.heightPt
      },
      caretRect,
      backwardRects: beforeRects,
      forwardRects: afterRects
    }
  };
}

function handleDirectEditClick(event) {
  if (state.interactionMode !== "direct" || state.selectionTool !== "text" || isWriteInteractionBusy()) {
    return;
  }
  const selection = window.getSelection();
  if (!selection?.isCollapsed || !event.target.closest?.(".textLayer")) {
    return;
  }
  const capture = buildCaretCapture(event);
  if (!capture) {
    setStatus("未能在该位置建立文字光标，请单击正文字符附近。", "warning");
    return;
  }
  selection.removeAllRanges();
  selection.addRange(capture.range);
  state.directCaptureSpec = capture.spec;
  captureSelection();
  state.directIgnoreNextSelectionCapture = true;
  setTimeout(() => { state.directIgnoreNextSelectionCapture = false; }, 80);
}

function captureSelection() {
  if (state.directIgnoreNextSelectionCapture) {
    state.directIgnoreNextSelectionCapture = false;
    return;
  }
  if (state.selectionTool !== "text" || isWriteInteractionBusy()) {
    return;
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
    return;
  }
  const range = selection.getRangeAt(0);
  const startLayer = closestTextLayer(range.startContainer);
  const endLayer = closestTextLayer(range.endContainer);
  if (!startLayer || !endLayer) {
    return;
  }
  const startPage = Number(startLayer.dataset.pageNumber);
  const endPage = Number(endLayer.dataset.pageNumber);
  if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || endPage < startPage) {
    return;
  }
  if (endPage - startPage + 1 > 12) {
    clearLocalSession(true);
    setStatus("跨页文字选区最多支持连续 12 页，请缩小范围。", "warning");
    return;
  }
  const selectedRecords = state.pageStates.slice(startPage - 1, endPage);
  if (selectedRecords.some((record) => record?.rotation !== 0)) {
    clearLocalSession(true);
    setStatus("当前版本暂不支持旋转页面的 SyncTeX 定位。", "error");
    return;
  }
  let pageFragments;
  try {
    pageFragments = buildTextPageFragments(range, startPage, endPage);
  } catch (error) {
    clearLocalSession(true);
    setStatus(error.message || String(error), "warning");
    return;
  }
  const text = pageFragments.map((fragment) => fragment.text).join("\n").trim();
  if (!text) {
    return;
  }

  const directCaptureSpec = state.directCaptureSpec;
  const selectionContext = captureTextSelectionContext(startLayer, endLayer, range);
  state.directCaptureSpec = undefined;
  discardDirectDraft();
  clearRegionSelection();
  const pageLabel = startPage === endPage ? startPage : `${startPage}--${endPage}`;
  beginLocalSelection(pageLabel, text.length, startPage === endPage ? "文字选区" : "跨页文字选区");
  const normalizedRects = sampleCrossPageRects(pageFragments, 64);
  state.textSelection = { pageNumber: startPage, endPageNumber: endPage, rects: normalizedRects };
  state.selectedPages = new Set(pageFragments.map((fragment) => fragment.page));
  state.selectedPage = startPage;
  const requestId = createId();
  state.selectionRequestId = requestId;
  post("selection", {
    requestId,
    selectionKind: "text",
    interactionMode: state.interactionMode,
    interactionVersion: state.interactionVersion,
    text,
    page: startPage,
    start: pageFragments[0].start,
    end: pageFragments.at(-1).end,
    pageFragments: pageFragments.map(({ page, text: fragmentText, start, end }) => ({
      page,
      text: fragmentText,
      start,
      end
    })),
    contextBefore: selectionContext.before,
    contextAfter: selectionContext.after,
    ...(directCaptureSpec?.caretPoint ? { caretPoint: directCaptureSpec.caretPoint } : {})
  });
  if (state.interactionMode === "direct") {
    const spec = directCaptureSpec;
    const leadingTrimLength = text.length - text.trimStart().length;
    const caretRawOffset = spec?.caretRawOffset;
    const caretVisibleOffset = Number.isInteger(caretRawOffset)
      ? visibleTextLength(text.slice(leadingTrimLength, clamp(caretRawOffset, leadingTrimLength, leadingTrimLength + text.length)))
      : undefined;
    const kind = spec?.kind ?? "replace";
    state.directDraft = {
      page: startPage,
      endPage,
      rects: spec?.caretRect ? [{ ...spec.caretRect, page: startPage }] : normalizedRects,
      selectionRects: normalizedRects,
      caretRect: spec?.caretRect ? { ...spec.caretRect, page: startPage } : undefined,
      backwardRects: (spec?.backwardRects ?? []).map((rect) => ({ ...rect, page: startPage })),
      forwardRects: (spec?.forwardRects ?? []).map((rect) => ({ ...rect, page: startPage })),
      caretVisibleOffset,
      baseKind: kind,
      kind,
      text: "",
      selectionRequestId: requestId,
      interactionVersion: state.interactionVersion,
      mapped: false,
      commitRequested: false
    };
    renderAllDirectDraftOverlays(endPage);
    setStatus("直接编辑草稿已建立，输入文字后按 Ctrl+Enter 提交，Esc 取消。", "ready");
  } else {
    state.directCaptureSpec = undefined;
  }
  updateManualEditAvailability();
  updateVisiblePages();
}

function captureTextSelectionContext(startLayer, endLayer, range) {
  const startBoundary = normalizeCaretBoundary(range.startContainer, range.startOffset, startLayer);
  const endBoundary = normalizeCaretBoundary(range.endContainer, range.endOffset, endLayer);
  if (!startBoundary || !endBoundary) {
    return { before: "", after: "" };
  }
  if (startLayer !== endLayer) {
    return {
      before: textBeforeBoundary(startLayer, startBoundary).slice(-256),
      after: textAfterBoundary(endLayer, endBoundary).slice(0, 256)
    };
  }
  const nodes = textNodesInLayer(startLayer);
  let text = "";
  let startOffset;
  let endOffset;
  for (const node of nodes) {
    if (node === startBoundary.node) {
      startOffset = text.length + clamp(startBoundary.offset, 0, node.textContent.length);
    }
    if (node === endBoundary.node) {
      endOffset = text.length + clamp(endBoundary.offset, 0, node.textContent.length);
    }
    text += node.textContent;
  }
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) {
    return { before: "", after: "" };
  }
  const slices = graphemeSlices(text);
  const before = [];
  for (let index = slices.length - 1; index >= 0 && visibleTextLength(before.join("")) < 20; index -= 1) {
    const slice = slices[index];
    if (slice.end <= startOffset) {
      before.unshift(slice.character);
    }
  }
  const after = [];
  for (const slice of slices) {
    if (slice.start >= endOffset && visibleTextLength(after.join("")) < 20) {
      after.push(slice.character);
    }
  }
  return {
    before: before.join("").slice(-256),
    after: after.join("").slice(0, 256)
  };
}

function closestTextLayer(node) {
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return element?.closest?.(".textLayer");
}

function beginLocalSelection(pageNumber, textLength, label = "文字选区") {
  state.sessionId = undefined;
  state.mappingId = undefined;
  state.candidateId = undefined;
  state.requiresConfirmation = false;
  state.rangeConfirmed = false;
  state.analyzing = false;
  state.selectionDetailRequestId = undefined;
  state.sourceDetailRequestId = undefined;
  state.rangeRequestId = undefined;
  state.selectionLabel = label;
  state.textSelection = undefined;
  state.selectedPages = new Set();
  elements.selectionDetails.hidden = false;
  elements.selectionDetails.open = false;
  elements.selectionSummary.textContent = `第 ${pageNumber} 页 · ${label} · ${textLength} 字 · 定位中`;
  elements.selectionText.textContent = "展开后加载选区文字。";
  elements.sourceDetails.hidden = true;
  elements.sourceDetails.open = false;
  elements.sourceText.textContent = "展开后加载源码。";
  elements.instruction.value = "";
  elements.instruction.disabled = true;
  elements.manualText.value = "";
  elements.candidateActions.hidden = true;
  elements.candidateSummary.hidden = true;
  elements.manualHandoff.hidden = true;
  elements.adjustRange.disabled = false;
  updateAnalyzeAvailability();
  updateManualEditAvailability();
  setStatus("正在定位所选文字对应的 LaTeX 源码……", "busy");
}

function clearLocalSession(notifyBackend = false) {
  if (notifyBackend && state.sessionId) {
    post("clearSession", { sessionId: state.sessionId });
  }
  discardDirectDraft();
  clearImageEditDraft();
  window.getSelection()?.removeAllRanges();
  clearRegionSelection();
  state.sessionId = undefined;
  state.mappingId = undefined;
  state.candidateId = undefined;
  state.selectionRequestId = undefined;
  state.rangeRequestId = undefined;
  state.requiresConfirmation = false;
  state.rangeConfirmed = false;
  state.selectedPage = undefined;
  state.selectedPages = new Set();
  state.textSelectionDrag = undefined;
  state.analyzing = false;
  state.selectionLabel = "文字选区";
  state.textSelection = undefined;
  elements.selectionDetails.hidden = true;
  elements.selectionDetails.open = false;
  elements.sourceDetails.hidden = true;
  elements.sourceDetails.open = false;
  elements.selectionText.textContent = "";
  elements.sourceText.textContent = "";
  elements.instruction.value = "";
  elements.instruction.disabled = true;
  elements.candidateActions.hidden = true;
  elements.candidateSummary.hidden = true;
  elements.manualHandoff.hidden = true;
  elements.adjustRange.disabled = false;
  updateAnalyzeAvailability();
  updateManualEditAvailability();
  updateVisiblePages();
  updateClearSelectionAvailability();
}

function requestSelectionDetail() {
  if (!state.sessionId || !state.mappingId || !elements.selectionDetails.open) {
    return;
  }
  const requestId = createId();
  state.selectionDetailRequestId = requestId;
  elements.selectionText.textContent = "正在加载选区文字……";
  post("requestSelectionDetail", {
    requestId,
    sessionId: state.sessionId,
    mappingId: state.mappingId
  });
}

function requestSourceDetail() {
  if (!state.sessionId || !state.mappingId || !elements.sourceDetails.open) {
    return;
  }
  const requestId = createId();
  state.sourceDetailRequestId = requestId;
  elements.sourceText.textContent = "正在加载源码……";
  post("requestSourceDetail", {
    requestId,
    sessionId: state.sessionId,
    mappingId: state.mappingId
  });
}

function updateAnalyzeAvailability() {
  const hasInstruction = elements.instruction.value.trim().length > 0;
  const confirmed = !state.requiresConfirmation || state.rangeConfirmed;
  const skill = selectedSkill();
  const requiresSelection = state.selectedTask === "revision" || skill?.scope === "selection";
  const usesSelection = requiresSelection || Boolean(skill && skill.scope === "either" && state.mappingId);
  const readyForScope = !usesSelection || Boolean(state.mappingId && confirmed);
  elements.instruction.disabled = state.selectedTask === "revision" ? !state.mappingId : !skill;
  elements.analyze.disabled = state.skillTaskRunning ? false : !hasInstruction || !readyForScope ||
    (state.selectedTask !== "revision" && !skill) || state.analyzing || state.pendingManualEditCount > 0 ||
    Boolean(state.directDraft) || Boolean(state.candidateId) || isWriteInteractionBusy();
  updateTaskUi();
}

function textBeforeBoundary(layer, boundary) {
  let text = "";
  for (const node of textNodesInLayer(layer)) {
    if (node === boundary.node) {
      text += node.textContent.slice(0, clamp(boundary.offset, 0, node.textContent.length));
      break;
    }
    text += node.textContent;
  }
  return text;
}

function textAfterBoundary(layer, boundary) {
  let text = "";
  let started = false;
  for (const node of textNodesInLayer(layer)) {
    if (node === boundary.node) {
      text += node.textContent.slice(clamp(boundary.offset, 0, node.textContent.length));
      started = true;
      continue;
    }
    if (started) text += node.textContent;
  }
  return text;
}

function buildTextPageFragments(range, startPage, endPage) {
  const fragments = [];
  for (let page = startPage; page <= endPage; page += 1) {
    const record = state.pageStates[page - 1];
    const layer = record?.textLayerElement;
    if (!record || !layer || record.status !== "rendered") {
      throw new Error(`第 ${page} 页文字层尚未就绪，请稍后重试跨页选择。`);
    }
    const pageRange = document.createRange();
    pageRange.selectNodeContents(layer);
    if (page === startPage) pageRange.setStart(range.startContainer, range.startOffset);
    if (page === endPage) pageRange.setEnd(range.endContainer, range.endOffset);
    const pageRect = record.shell.getBoundingClientRect();
    const rawRects = [...pageRange.getClientRects()].filter((rect) =>
      rect.width > 0 && rect.height > 0 &&
      rect.right > pageRect.left && rect.left < pageRect.right &&
      rect.bottom > pageRect.top && rect.top < pageRect.bottom
    );
    const trimMargins = startPage !== endPage;
    const rects = rawRects.filter((rect) => {
      if (!trimMargins) return true;
      const centerRatio = (rect.top + rect.height / 2 - pageRect.top) / Math.max(1, pageRect.height);
      return centerRatio >= 0.07 && centerRatio <= 0.93;
    });
    const text = extractSelectedLayerText(pageRange, layer, pageRect, trimMargins).trim();
    const normalized = sampleNormalizedPageRects(normalizeTextSelectionRects(rects, pageRect), page);
    if (!text || normalized.length === 0) continue;
    const first = rects[0];
    const last = rects.at(-1);
    fragments.push({
      page,
      text,
      start: textRectPoint(first, record, false),
      end: textRectPoint(last, record, true),
      rects: normalized
    });
  }
  if (fragments.length === 0 || fragments[0].page !== startPage || fragments.at(-1).page !== endPage) {
    throw new Error("跨页选区在起止页没有形成有效正文，请避开页眉、页脚后重试。");
  }
  return fragments;
}

function extractSelectedLayerText(selectionRange, layer, pageRect, trimMargins) {
  const pieces = [];
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent) continue;
    if (!selectionRange.intersectsNode(node)) continue;
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(node);
    const slice = nodeRange.cloneRange();
    if (node === selectionRange.startContainer) {
      slice.setStart(selectionRange.startContainer, selectionRange.startOffset);
    }
    if (node === selectionRange.endContainer) {
      slice.setEnd(selectionRange.endContainer, selectionRange.endOffset);
    }
    const rects = [...slice.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) continue;
    if (trimMargins) {
      const centerRatio = (rects[0].top + rects[0].height / 2 - pageRect.top) / Math.max(1, pageRect.height);
      if (centerRatio < 0.07 || centerRatio > 0.93) continue;
    }
    pieces.push(slice.toString());
  }
  return pieces.join("");
}

function textRectPoint(rect, record, useRight) {
  const pageRect = record.shell.getBoundingClientRect();
  const inset = Math.min(rect.width * 0.2, 3);
  return {
    x: clamp(((useRight ? rect.right - inset : rect.left + inset) - pageRect.left) * record.widthPt / Math.max(1, pageRect.width), 0.5, record.widthPt - 0.5),
    y: clamp((rect.top + rect.height / 2 - pageRect.top) * record.heightPt / Math.max(1, pageRect.height), 0.5, record.heightPt - 0.5)
  };
}

function sampleNormalizedPageRects(rects, page) {
  const sampled = rects.length <= 64 ? rects : Array.from({ length: 64 }, (_, index) =>
    rects[Math.round(index * (rects.length - 1) / 63)]
  );
  return sampled.map((rect) => ({ ...rect, page }));
}

function sampleCrossPageRects(fragments, maximum) {
  const perPage = Math.max(1, Math.floor(maximum / Math.max(1, fragments.length)));
  return fragments.flatMap((fragment) => {
    const rects = fragment.rects;
    if (rects.length <= perPage) return rects;
    return Array.from({ length: perPage }, (_, index) =>
      rects[Math.round(index * (rects.length - 1) / Math.max(1, perPage - 1))]
    );
  });
}

function applyPageMetadata(metadata) {
  const anchor = captureViewState();
  for (const item of metadata) {
    const record = state.pageStates[item.number - 1];
    if (!record) continue;
    record.widthPt = item.widthPt;
    record.heightPt = item.heightPt;
    record.rotation = item.rotation;
    updateShellSize(record);
  }
  requestAnimationFrame(() => restoreViewState(anchor));
}

function isWriteInteractionBusy() {
  return Boolean(state.manualEditRequestId) || Boolean(state.imageQueueRequestId) || Boolean(state.rangeRequestId) || [
    "analyze",
    "skillTask",
    "apply",
    "compile",
    "queueManualEdit",
    "locateImage",
    "queueImageEdit",
    "undoManualEdit",
    "redoManualEdit",
    "removeManualEdit",
    "clearManualEdits",
    "showManualEditsDiff",
    "resolveTrackedRevisions"
  ].includes(state.busyAction);
}

function manualEditUnavailableReason(allowDirectDraft = false) {
  if (state.interactionMode !== "direct") {
    return "请先切换到直接编辑模式。";
  }
  if (state.manualEditMode === "direct" && state.hasTrackedRevisions) {
    return "请先接受全部或拒绝全部旧版修订痕迹。";
  }
  if (state.directDraft && !allowDirectDraft) {
    return "请先提交或取消当前直接编辑草稿。";
  }
  if (state.imageEditDraft) {
    return "请先确认或取消当前图片尺寸候选。";
  }
  if (!state.textSelection || !state.sessionId || !state.mappingId) {
    return "请先在 PDF 中划选并定位文字。";
  }
  if (state.requiresConfirmation && !state.rangeConfirmed) {
    return "请先确认当前选区对应的源码范围。";
  }
  if (state.candidateId) {
    return "请先应用或放弃当前 AI 修订建议。";
  }
  if (state.analyzing || isWriteInteractionBusy()) {
    return "当前操作完成后才能添加手动修订。";
  }
  return "";
}

function updateManualEditAvailability() {
  const reason = manualEditUnavailableReason();
  const hasText = elements.manualText.value.trim().length > 0;
  const baseDisabled = Boolean(reason);
  const historyBusy = state.analyzing || isWriteInteractionBusy();
  const pendingCount = state.pendingManualEditCount;
  updateCollapsedDockProgress();

  elements.manualText.disabled = baseDisabled;
  const regionEdit = state.selectionLabel === "区域框选";
  elements.manualText.placeholder = regionEdit
    ? "输入替换整个区域的文字；留空时可删除。"
    : state.mappingId
      ? "输入需要新增或替换的文字。"
      : "请先在 PDF 中划选普通文字。";
  elements.manualInsertBefore.disabled = baseDisabled || !hasText || regionEdit;
  elements.manualInsertAfter.disabled = baseDisabled || !hasText || regionEdit;
  elements.manualReplace.disabled = baseDisabled || !hasText;
  elements.manualDelete.disabled = baseDisabled;
  for (const button of [
    elements.manualInsertBefore,
    elements.manualInsertAfter,
    elements.manualReplace,
    elements.manualDelete
  ]) {
    const action = button === elements.manualInsertBefore ? "在选区前插入文字" :
      button === elements.manualInsertAfter ? "在选区后插入文字" :
        button === elements.manualReplace ? "替换选区文字" : "删除选区文字";
    button.title = reason || action;
  }
  elements.manualUndo.disabled = !state.canUndoManualEdit || historyBusy;
  elements.manualClear.disabled = (pendingCount === 0 && !state.canRedoManualEdit) || historyBusy;
  elements.showManualEditsDiff.disabled = pendingCount === 0 || historyBusy;
  elements.manualAcceptAll.hidden = !state.hasTrackedRevisions;
  elements.manualRejectAll.hidden = !state.hasTrackedRevisions;
  elements.manualAcceptAll.disabled = historyBusy || pendingCount > 0;
  elements.manualRejectAll.disabled = historyBusy || pendingCount > 0;
  elements.pendingEditCount.textContent = state.manualEditMode === "tracked"
    ? `${pendingCount} 项待提交修订`
    : `${pendingCount} 项待编译`;
  elements.pendingEditCount.title = pendingCount > 0
    ? `有 ${pendingCount} 项编辑将在下次编译时写入 main.tex。`
    : "当前没有待编译编辑。";
  elements.compile.textContent = pendingCount > 0 ? `应用 ${pendingCount} 项并编译` : "编译";
  const compileHint = pendingCount > 0 ? `应用 ${pendingCount} 项待编译编辑并编译论文` : "编译当前论文";
  elements.compile.title = `${compileHint}（Ctrl+Enter）`;
  elements.compile.setAttribute("aria-label", `${compileHint}，快捷键 Ctrl+Enter`);
  elements.compile.setAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
  renderPendingManualEditList();

  const pendingBlocksAi = pendingCount > 0;
  elements.compile.disabled = historyBusy || Boolean(state.directDraft);
  elements.regionSelect.disabled = historyBusy;
  elements.directEdit.disabled = historyBusy;
  elements.modeDirect.disabled = historyBusy;
  elements.modeAgent.disabled = historyBusy;
  elements.manualHandoff.disabled = pendingBlocksAi || historyBusy;
  elements.adjustRange.disabled = !state.mappingId || Boolean(state.rangeRequestId) || historyBusy;
  elements.apply.disabled = pendingBlocksAi || state.busyAction === "apply" || state.busyAction === "compile";
  elements.showDiff.disabled = state.busyAction === "apply" || state.busyAction === "compile";
  elements.discard.disabled = state.busyAction === "apply" || state.busyAction === "compile";
  updateClearSelectionAvailability();
  updateAnalyzeAvailability();
}

function normalizePendingEdit(raw) {
  const imageEdit = raw?.editType === "image" && raw?.kind === "imageResize";
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" ||
      (!imageEdit && !["insertBefore", "insertAfter", "replace", "delete"].includes(raw.kind))) {
    return undefined;
  }
  const page = positivePage(raw.page);
  if (!page || !Array.isArray(raw.rects)) {
    return undefined;
  }
  const rects = raw.rects.slice(0, 64).map((rect) => {
    if (!rect || typeof rect !== "object") {
      return undefined;
    }
    const x = clamp(rect.x, 0, 1);
    const y = clamp(rect.y, 0, 1);
    const width = clamp(rect.width, 0, 1 - x);
    const height = clamp(rect.height, 0, 1 - y);
    const rectPage = positivePage(rect.page) ?? page;
    return width > 0 && height > 0 ? { page: rectPage, x, y, width, height } : undefined;
  }).filter(Boolean);
  if (rects.length === 0) {
    return undefined;
  }
  return {
    ...(imageEdit ? { editType: "image" } : {}),
    id: raw.id,
    kind: raw.kind,
    page,
    rects,
    insertedText: typeof raw.insertedText === "string" ? raw.insertedText : "",
    structuralFormula: raw.structuralFormula === true,
    ...(imageEdit ? {
      imagePath: typeof raw.imagePath === "string" ? raw.imagePath : "",
      originalValue: typeof raw.originalValue === "string" ? raw.originalValue : "原尺寸",
      candidateValue: typeof raw.candidateValue === "string" ? raw.candidateValue : "候选尺寸",
      factor: Number.isFinite(raw.factor) ? raw.factor : 1
    } : {})
  };
}

function updateManualEditMode(value) {
  if (value === "direct" || value === "tracked") {
    state.manualEditMode = value;
  }
  updateManualEditAvailability();
}

function setPendingManualEdits(rawEdits, rawCount, history = {}) {
  const edits = Array.isArray(rawEdits)
    ? rawEdits.map(normalizePendingEdit).filter(Boolean)
    : state.pendingManualEdits;
  state.pendingManualEdits = edits;
  const count = Number(rawCount);
  state.pendingManualEditCount = Number.isInteger(count) && count >= 0 ? count : edits.length;
  state.canUndoManualEdit = typeof history.canUndo === "boolean"
    ? history.canUndo
    : state.pendingManualEditCount > 0;
  state.canRedoManualEdit = typeof history.canRedo === "boolean"
    ? history.canRedo
    : false;
  if (history.manualEditMode === "direct" || history.manualEditMode === "tracked") {
    state.manualEditMode = history.manualEditMode;
  }
  renderAllManualEditOverlays();
  renderPendingManualEditList();
  updateManualEditAvailability();
}

function renderPendingManualEditList() {
  const edits = state.pendingManualEdits;
  elements.pendingEditsDetails.hidden = edits.length === 0;
  if (edits.length === 0) {
    elements.pendingEditsDetails.open = false;
    elements.pendingEditsSummary.textContent = "";
    elements.pendingEditsList.replaceChildren();
    return;
  }
  elements.pendingEditsSummary.textContent = `${edits.length} 项`;
  const items = edits.map((edit) => {
    const item = document.createElement("li");
    item.className = "pending-edit-item";
    const label = document.createElement("span");
    label.className = "pending-edit-label";
    label.textContent = pendingEditLabel(edit);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.textContent = "×";
    remove.title = "移除此项待编译编辑";
    remove.setAttribute("aria-label", "移除此项待编译编辑");
    remove.disabled = isWriteInteractionBusy();
    remove.addEventListener("click", () => removePendingManualEdit(edit.id));
    item.append(label, remove);
    return item;
  });
  elements.pendingEditsList.replaceChildren(...items);
}

function pendingEditLabel(edit) {
  const page = `第 ${edit.page} 页`;
  if (edit.editType === "image") {
    const delta = Math.round((edit.factor - 1) * 100);
    return `${page} 图片${delta >= 0 ? "放大" : "缩小"} ${Math.abs(delta)}%`;
  }
  if (edit.structuralFormula) return `${page} 删除完整公式结构`;
  const labels = { insertBefore: "前插", insertAfter: "后插", replace: "替换", delete: "删除" };
  const text = typeof edit.insertedText === "string" ? edit.insertedText.replace(/\s+/gu, " ").trim() : "";
  return text ? `${page} ${labels[edit.kind] ?? "编辑"}：${text.slice(0, 48)}` : `${page} ${labels[edit.kind] ?? "编辑"}`;
}

function removePendingManualEdit(editId) {
  if (!editId || isWriteInteractionBusy()) return;
  state.busyAction = "removeManualEdit";
  updateManualEditAvailability();
  setStatus("正在移除待编译编辑……", "busy");
  post("removeManualEdit", { editId, queueVersion: state.manualEditQueueVersion });
}

function updateManualEditQueueVersion(value) {
  if (Number.isInteger(value) && value >= 0) {
    state.manualEditQueueVersion = value;
  }
}

function queueManualEdit(kind, options = {}) {
  const text = kind === "delete" ? "" : options.text ?? elements.manualText.value;
  if (manualEditUnavailableReason(Boolean(options.direct)) || (kind !== "delete" && text.trim().length === 0)) {
    updateManualEditAvailability();
    return;
  }
  const selection = state.textSelection;
  if (!selection || !state.sessionId || !state.mappingId) {
    return;
  }
  const requestId = createId();
  state.manualEditRequestId = requestId;
  if (options.direct) {
    state.directQueueRequestId = requestId;
  }
  state.busyAction = "queueManualEdit";
  updateManualEditAvailability();
  setStatus("正在加入待提交修订……", "busy");
  post("queueManualEdit", {
    requestId,
    sessionId: state.sessionId,
    mappingId: state.mappingId,
    kind,
    text,
    rects: (options.rects ?? selection.rects).map((rect) => ({ ...rect })),
    queueVersion: state.manualEditQueueVersion,
    ...(Number.isInteger(options.caretVisibleOffset) ? { caretVisibleOffset: options.caretVisibleOffset } : {}),
    ...(options.caretDeleteDirection ? { caretDeleteDirection: options.caretDeleteDirection } : {})
  });
}

function directDraftBaseRects(draft) {
  return draft.caretRect ? [draft.caretRect] : draft.selectionRects;
}

function setDirectDraftDeletion(direction) {
  const draft = state.directDraft;
  if (!draft || isWriteInteractionBusy()) {
    return;
  }
  let rects = draft.selectionRects;
  let caretDeleteDirection;
  if (draft.selectionKind !== "region" && draft.caretVisibleOffset !== undefined) {
    rects = direction === "backward" ? draft.backwardRects : draft.forwardRects;
    if (rects.length === 0) {
      setStatus(direction === "backward" ? "光标前没有可删除文字。" : "光标后没有可删除文字。", "warning");
      return;
    }
    caretDeleteDirection = direction;
  }
  draft.kind = "delete";
  draft.text = "";
  draft.rects = rects;
  draft.caretDeleteDirection = caretDeleteDirection;
  elements.directInput.value = "";
  const focusPage = Math.max(...draft.rects.map((rect) => rect.page ?? draft.page));
  renderAllDirectDraftOverlays(focusPage);
  setStatus(
    draft.caretVisibleOffset !== undefined
      ? "将删除光标旁的一个字素；批量删除请先拖选文字。按 Ctrl+Enter 提交。"
      : "删除所选文字的草稿已建立，按 Ctrl+Enter 提交，Esc 取消。",
    "ready"
  );
}

function commitDirectDraft() {
  const draft = state.directDraft;
  if (!draft || isWriteInteractionBusy()) {
    return;
  }
  const unavailable = manualEditUnavailableReason(true);
  if (unavailable && draft.mapped) {
    setStatus(unavailable, "warning");
    return;
  }
  if (!draft.mapped || !state.sessionId || !state.mappingId) {
    draft.commitRequested = true;
    setStatus("正在定位源码，定位完成后将提交此编辑。", "busy");
    return;
  }
  if (state.requiresConfirmation && !state.rangeConfirmed) {
    draft.commitRequested = false;
    setStatus("该位置的源码范围需要核对，请先确认源码范围。", "warning");
    return;
  }
  const text = draft.kind === "delete" ? "" : draft.text;
  if (draft.kind !== "delete" && text.trim().length === 0) {
    setStatus("请先输入需要插入或替换的文字。", "warning");
    elements.directInput.focus({ preventScroll: true });
    return;
  }
  draft.commitRequested = false;
  queueManualEdit(draft.kind, {
    direct: true,
    text,
    rects: draft.rects,
    caretVisibleOffset: draft.caretVisibleOffset,
    caretDeleteDirection: draft.caretDeleteDirection
  });
}

function cancelDirectDraft() {
  if (!state.directDraft) {
    return false;
  }
  clearLocalSession(true);
  setStatus("已取消当前直接编辑草稿。", "ready");
  return true;
}

function requestManualHistory(action) {
  const canRun = action === "undoManualEdit" ? state.canUndoManualEdit : state.canRedoManualEdit;
  if (!canRun || isWriteInteractionBusy()) {
    if (action === "redoManualEdit" && !state.canRedoManualEdit) {
      setStatus("当前没有可重做的待编译编辑。", "ready");
    }
    return;
  }
  state.busyAction = action;
  updateManualEditAvailability();
  post(action, { queueVersion: state.manualEditQueueVersion });
}

function updateAssistantName(value) {
  const name = typeof value === "string" && value.length > 0 && value.length <= 80
    ? value
    : "AI 助手";
  state.assistantName = name;
  updateTaskUi();
  elements.manualHandoff.textContent = `复制任务并打开 ${name}`;
}

function selectedSkill() {
  return state.skills.find((skill) => `skill:${skill.id}` === state.selectedTask);
}

function updateTaskUi() {
  const skill = selectedSkill();
  if (state.skillTaskRunning) {
    elements.analyze.textContent = "取消 Skill 任务";
    elements.taskMode.disabled = true;
    return;
  }
  elements.taskMode.disabled = false;
  if (!skill) {
    elements.analyze.textContent = `交给 ${state.assistantName} 分析`;
    elements.taskScopeNote.textContent = "需要 PDF 选区";
    elements.instruction.placeholder = state.mappingId ? "输入对所选内容的修改要求。" : "先在 PDF 中划选内容，再输入修改要求。";
    return;
  }
  elements.analyze.textContent = `交给 ${state.assistantName} 执行`;
  elements.taskScopeNote.textContent = skill.scope === "document"
    ? "整篇论文"
    : skill.scope === "selection"
      ? "需要 PDF 选区"
      : state.mappingId ? "将使用当前选区" : "整篇论文";
  elements.instruction.placeholder = `输入交给 ${skill.name} 的任务要求。`;
}

function updateSkills(skills) {
  const previous = state.selectedTask;
  state.skills = Array.isArray(skills) ? skills.filter((skill) =>
    skill && typeof skill.id === "string" && typeof skill.name === "string" &&
    ["document", "selection", "either"].includes(skill.scope)
  ) : [];
  elements.taskMode.replaceChildren();
  const revision = document.createElement("option");
  revision.value = "revision";
  revision.textContent = "局部修订";
  elements.taskMode.append(revision);
  for (const skill of state.skills) {
    const option = document.createElement("option");
    option.value = `skill:${skill.id}`;
    option.textContent = `Skill：${skill.name}`;
    elements.taskMode.append(option);
  }
  state.selectedTask = [...elements.taskMode.options].some((option) => option.value === previous) ? previous : "revision";
  elements.taskMode.value = state.selectedTask;
  updateAnalyzeAvailability();
}

function clearSkillArtifacts() {
  elements.skillArtifacts.replaceChildren();
  elements.skillArtifacts.hidden = true;
}

const WORD_SKILL_STAGES = [
  { id: "prepare-copy", label: "准备副本" },
  { id: "parse-formulas", label: "解析公式" },
  { id: "build-word", label: "生成基础 Word" },
  { id: "create-mathtype", label: "创建 MathType" },
  { id: "assemble-formulas", label: "装配公式" },
  { id: "apply-styles", label: "设置样式" },
  { id: "validate-integrity", label: "完整性验收" },
  { id: "publish", label: "发布" }
];

const GENERIC_SKILL_STAGES = [
  { id: "prepare-copy", label: "准备副本" },
  { id: "run-skill", label: "执行 Skill" },
  { id: "validate-integrity", label: "验证产物" },
  { id: "publish", label: "发布" }
];

function initialSkillStages(skillId) {
  const definitions = skillId === "tex-to-mathtype-word" ? WORD_SKILL_STAGES : GENERIC_SKILL_STAGES;
  return definitions.map((stage) => ({ ...stage, state: "pending", count: "" }));
}

function startSkillProgress(message) {
  clearInterval(state.skillProgressTimer);
  state.skillProgressPercent = 0;
  state.skillProgressStartedAt = Date.now();
  state.skillProgressElapsedSeconds = 0;
  state.skillProgressStages = initialSkillStages(message.skillId);
  state.skillProgressEvents = [];
  elements.skillProgress.hidden = false;
  elements.skillProgress.dataset.state = "running";
  elements.skillProgress.classList.remove("is-indeterminate");
  elements.skillProgressName.textContent = boundedUiText(message.skillName, 80) || "Skill 任务";
  elements.skillProgressState.textContent = "运行";
  elements.skillProgressState.dataset.state = "running";
  elements.skillProgressDetails.open = false;
  elements.skillProgressEvents.replaceChildren();
  elements.skillQualityList.replaceChildren();
  elements.skillQualityGates.hidden = true;
  renderSkillStages();
  updateSkillElapsed();
  state.skillProgressTimer = setInterval(updateSkillElapsed, 1_000);
  updateSkillProgress({
    stage: "preparing",
    percent: 2,
    message: boundedUiText(message.message, 200) || "正在准备 Skill 任务"
  });
}

function updateSkillProgress(message) {
  if (elements.skillProgress.hidden) {
    startSkillProgress({ skillId: "", skillName: "Skill 任务", message: message.message });
  }
  const incomingPercent = Number(message.percent);
  if (Number.isFinite(incomingPercent)) {
    state.skillProgressPercent = Math.max(state.skillProgressPercent, clamp(incomingPercent, 0, 100));
  }
  if (Number.isSafeInteger(message.elapsedSeconds) && message.elapsedSeconds >= 0) {
    state.skillProgressElapsedSeconds = Math.max(state.skillProgressElapsedSeconds, message.elapsedSeconds);
  }
  const progressMessage = boundedUiText(message.message, 200) || "正在执行 Skill 任务";
  const detail = normalizedSkillStage(message.detail ?? (typeof message.stage === "object" ? message.stage : undefined));
  if (detail) {
    applySkillStage(detail);
  } else {
    applyLegacySkillStage(typeof message.stage === "string" ? message.stage : "running");
  }
  elements.skillProgress.dataset.state = "running";
  elements.skillProgress.classList.toggle("is-indeterminate", Boolean(message.indeterminate));
  elements.skillProgressState.textContent = "运行";
  elements.skillProgressState.dataset.state = "running";
  elements.skillProgressMessage.textContent = progressMessage;
  elements.skillProgressValue.textContent = `${Math.round(state.skillProgressPercent)}%`;
  elements.skillProgressFill.style.width = `${state.skillProgressPercent}%`;
  elements.skillProgressTrack.setAttribute("aria-valuenow", String(Math.round(state.skillProgressPercent)));
  appendSkillProgressEvent(progressMessage, detail);
  updateSkillElapsed();
  renderSkillStages();
  updateCollapsedDockProgress();
}

function normalizedSkillStage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const id = boundedUiText(value.id, 48);
  const label = boundedUiText(value.label, 80);
  const stageState = ["pending", "running", "completed", "failed"].includes(value.state) ? value.state : "running";
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return undefined;
  }
  const current = Number.isSafeInteger(value.current) && value.current >= 0 ? value.current : undefined;
  const total = Number.isSafeInteger(value.total) && value.total >= 0 ? value.total : undefined;
  const unit = boundedUiText(value.unit, 40);
  return {
    id,
    label: label || id,
    state: stageState,
    current: current !== undefined && total !== undefined ? Math.min(current, total) : current,
    total,
    unit
  };
}

function applySkillStage(detail) {
  let index = state.skillProgressStages.findIndex((stage) => stage.id === detail.id);
  if (index < 0 && state.skillProgressStages.length < 12) {
    state.skillProgressStages.push({ id: detail.id, label: detail.label, state: "pending", count: "" });
    index = state.skillProgressStages.length - 1;
  }
  if (index < 0) {
    return;
  }
  if (detail.state === "running" || detail.state === "completed") {
    for (let item = 0; item < index; item += 1) {
      if (state.skillProgressStages[item].state !== "failed") {
        state.skillProgressStages[item].state = "completed";
      }
    }
  }
  for (const [item, stage] of state.skillProgressStages.entries()) {
    if (item !== index && stage.state === "running") {
      stage.state = item < index ? "completed" : "pending";
    }
  }
  const target = state.skillProgressStages[index];
  target.label = detail.label || target.label;
  target.state = detail.state;
  target.count = skillStageCount(detail);
}

function applyLegacySkillStage(stage) {
  const generic = !state.skillProgressStages.some((item) => item.id === "parse-formulas");
  const id = stage === "preparing"
    ? "prepare-copy"
    : stage === "validating"
      ? "validate-integrity"
      : stage === "publishing"
        ? "publish"
        : generic ? "run-skill" : "parse-formulas";
  const target = state.skillProgressStages.find((item) => item.id === id);
  if (target) {
    applySkillStage({ id, label: target.label, state: "running", current: undefined, total: undefined, unit: "" });
  }
}

function skillStageCount(detail) {
  if (detail.current === undefined) {
    return "";
  }
  const count = detail.total === undefined ? String(detail.current) : `${detail.current}/${detail.total}`;
  return detail.unit ? `${count} ${detail.unit}` : count;
}

function renderSkillStages() {
  elements.skillProgressStages.replaceChildren();
  for (const stage of state.skillProgressStages) {
    const item = document.createElement("li");
    item.className = "skill-progress-stage";
    item.dataset.state = stage.state;
    const status = document.createElement("span");
    status.className = "skill-stage-status";
    status.textContent = stage.state === "completed" ? "完成" : stage.state === "running" ? "运行" : stage.state === "failed" ? "失败" : "等待";
    const content = document.createElement("span");
    content.className = "skill-stage-content";
    const label = document.createElement("span");
    label.className = "skill-stage-label";
    label.textContent = stage.label;
    content.append(label);
    if (stage.count) {
      const count = document.createElement("span");
      count.className = "skill-stage-count";
      count.textContent = stage.count;
      content.append(count);
    }
    item.append(status, content);
    elements.skillProgressStages.append(item);
  }
}

function appendSkillProgressEvent(message, detail) {
  const count = detail ? skillStageCount(detail) : "";
  const text = count ? `${message}（${count}）` : message;
  if (state.skillProgressEvents.at(-1)?.text === text) {
    return;
  }
  const elapsed = currentSkillElapsedSeconds();
  state.skillProgressEvents.push({ elapsed, text });
  if (state.skillProgressEvents.length > 40) {
    state.skillProgressEvents.shift();
  }
  elements.skillProgressEvents.replaceChildren(...state.skillProgressEvents.map((event) => {
    const row = document.createElement("div");
    row.className = "skill-progress-event";
    const time = document.createElement("time");
    time.textContent = formatElapsed(event.elapsed);
    const label = document.createElement("span");
    label.textContent = event.text;
    row.append(time, label);
    return row;
  }));
}

function finishSkillProgress(message, kind, qualityGates) {
  clearInterval(state.skillProgressTimer);
  state.skillProgressTimer = undefined;
  state.skillProgressElapsedSeconds = currentSkillElapsedSeconds();
  const success = kind === "completed";
  if (success) {
    state.skillProgressPercent = 100;
    for (const stage of state.skillProgressStages) {
      stage.state = "completed";
    }
  } else {
    const running = state.skillProgressStages.find((stage) => stage.state === "running");
    if (running) {
      running.state = "failed";
    }
  }
  elements.skillProgress.dataset.state = success ? "completed" : "failed";
  elements.skillProgress.classList.remove("is-indeterminate");
  elements.skillProgressState.textContent = success ? "完成" : kind === "cancelled" ? "已取消" : "失败";
  elements.skillProgressState.dataset.state = success ? "completed" : "failed";
  elements.skillProgressMessage.textContent = message;
  elements.skillProgressValue.textContent = `${Math.round(state.skillProgressPercent)}%`;
  elements.skillProgressFill.style.width = `${state.skillProgressPercent}%`;
  elements.skillProgressTrack.setAttribute("aria-valuenow", String(Math.round(state.skillProgressPercent)));
  appendSkillProgressEvent(message);
  showSkillQualityGates(qualityGates);
  updateSkillElapsed();
  renderSkillStages();
  updateCollapsedDockProgress();
}

function showSkillQualityGates(gates) {
  elements.skillQualityList.replaceChildren();
  if (!Array.isArray(gates) || gates.length === 0) {
    elements.skillQualityGates.hidden = true;
    return;
  }
  for (const gate of gates.slice(0, 12)) {
    if (!gate || typeof gate !== "object") {
      continue;
    }
    const label = boundedUiText(gate.label, 80);
    const value = boundedUiText(gate.value, 80);
    if (!label || !["passed", "failed"].includes(gate.status)) {
      continue;
    }
    const item = document.createElement("div");
    item.className = "skill-quality-item";
    item.dataset.status = gate.status;
    const name = document.createElement("span");
    name.textContent = label;
    const result = document.createElement("span");
    result.textContent = value || (gate.status === "passed" ? "通过" : "失败");
    item.append(name, result);
    elements.skillQualityList.append(item);
  }
  elements.skillQualityGates.hidden = elements.skillQualityList.childElementCount === 0;
}

function currentSkillElapsedSeconds() {
  const local = state.skillProgressStartedAt ? Math.floor((Date.now() - state.skillProgressStartedAt) / 1_000) : 0;
  return Math.max(local, state.skillProgressElapsedSeconds);
}

function updateSkillElapsed() {
  elements.skillProgressElapsed.textContent = formatElapsed(currentSkillElapsedSeconds());
}

function formatElapsed(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3_600);
  const minutes = Math.floor((value % 3_600) / 60);
  const remaining = value % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function boundedUiText(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function showSkillArtifacts(message) {
  clearSkillArtifacts();
  const title = document.createElement("div");
  title.className = "skill-artifacts-title";
  title.textContent = message.summary || "Skill 任务已完成";
  elements.skillArtifacts.append(title);
  for (const artifact of Array.isArray(message.artifacts) ? message.artifacts : []) {
    const row = document.createElement("div");
    row.className = "skill-artifact-row";
    const text = document.createElement("span");
    text.textContent = `${artifact.name} · ${artifact.description || artifact.type || "产物"}`;
    const open = document.createElement("button");
    open.className = "secondary-button";
    open.textContent = "打开";
    open.addEventListener("click", () => post("openSkillArtifact", { index: artifact.index, action: "open" }));
    const reveal = document.createElement("button");
    reveal.className = "secondary-button";
    reveal.textContent = "显示位置";
    reveal.addEventListener("click", () => post("openSkillArtifact", { index: artifact.index, action: "reveal" }));
    row.append(text, open, reveal);
    elements.skillArtifacts.append(row);
  }
  elements.skillArtifacts.hidden = false;
}

function setStatus(message, kind = "ready") {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
  state.statusMessage = typeof message === "string" ? message : "";
  state.statusKind = kind;
  updateCollapsedDockProgress();
}

function updateCollapsedDockProgress() {
  if (!elements.dockCollapsedProgress) return;
  let label = "";
  let percent = 0;
  let kind = "ready";
  let hasProgress = false;

  if (state.compileProgressActive || !elements.compileProgress.hidden) {
    percent = state.compileProgressPercent;
    const phase = elements.compileProgressLabel.textContent?.trim() || "正在编译";
    const progressKind = elements.compileProgress.dataset.kind;
    label = `编译 · ${phase}`;
    kind = progressKind === "error" ? "error" : progressKind === "success" ? "success" : "busy";
    hasProgress = true;
  } else if (state.dockCollapsed && state.candidateId && !elements.apply.disabled) {
    label = "待确认修订建议 · Ctrl+Enter 应用";
    kind = "warning";
  } else if (state.dockCollapsed && state.requiresConfirmation && !state.rangeConfirmed && !elements.confirmRange.disabled) {
    label = "待确认源码范围 · Ctrl+Enter 确认";
    kind = "warning";
  } else if (!elements.skillProgress.hidden) {
    percent = state.skillProgressPercent;
    const name = elements.skillProgressName.textContent?.trim() || "Skill 任务";
    const phase = elements.skillProgressMessage.textContent?.trim() || "正在执行";
    const progressState = elements.skillProgress.dataset.state;
    label = `${name} · ${phase}`;
    kind = progressState === "failed" ? "error" : progressState === "completed" ? "success" : "busy";
    hasProgress = true;
  } else if (state.pendingManualEditCount > 0) {
    label = `工具区已收起 · ${state.pendingManualEditCount} 项待编译`;
    kind = "warning";
  } else {
    label = state.statusMessage || "工具区已收起";
    kind = state.statusKind || "ready";
  }

  elements.dockCollapsedProgress.dataset.kind = kind;
  elements.dockCollapsedProgress.dataset.hasProgress = String(hasProgress);
  elements.dockCollapsedProgressLabel.textContent = label;
  elements.dockCollapsedProgressValue.textContent = hasProgress ? `${Math.round(percent)}%` : "";
  elements.dockCollapsedProgressFill.style.width = `${percent}%`;
  elements.dockCollapsedProgressTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
}

function updateCompileProgress(message) {
  const percent = clamp(Number(message.percent), 0, 100);
  clearTimeout(state.compileProgressHideTimer);
  state.preserveCompileStatus = false;
  state.compileProgressActive = true;
  state.compileProgressPercent = percent;
  elements.compileProgress.hidden = false;
  elements.compileProgress.dataset.kind = "active";
  elements.compileProgress.classList.toggle("is-indeterminate", Boolean(message.indeterminate));
  elements.compileProgressLabel.textContent = typeof message.message === "string" ? message.message : "正在编译";
  elements.compileProgressValue.textContent = `${Math.round(percent)}%`;
  elements.compileProgressFill.style.width = `${percent}%`;
  elements.compileProgressTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
  updateCollapsedDockProgress();
}

function finishCompileProgress(message, kind = "success") {
  updateCompileProgress({ percent: kind === "success" ? 100 : state.compileProgressPercent, message, indeterminate: false });
  elements.compileProgress.dataset.kind = kind;
  state.compileProgressActive = false;
  updateCollapsedDockProgress();
  if (kind === "success") {
    state.preserveCompileStatus = true;
    state.compileProgressHideTimer = setTimeout(() => {
      elements.compileProgress.hidden = true;
      updateCollapsedDockProgress();
    }, 2_500);
  }
}

function setLoading(message, percent = 0, indeterminate = false) {
  clearTimeout(state.loadingHideTimer);
  elements.loading.classList.remove("is-fading-out");
  const value = clamp(percent, 0, 100);
  elements.loadingLabel.textContent = message;
  elements.loadingValue.textContent = `${Math.round(value)}%`;
  elements.loadingFill.style.width = `${value}%`;
  elements.loadingTrack.setAttribute("aria-valuenow", String(Math.round(value)));
  elements.loading.classList.toggle("is-indeterminate", Boolean(indeterminate));
  elements.loading.hidden = false;
}

function hideLoading() {
  if (elements.loading.hidden) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    elements.loading.hidden = true;
    return;
  }
  elements.loading.classList.add("is-fading-out");
  state.loadingHideTimer = setTimeout(() => {
    elements.loading.hidden = true;
    elements.loading.classList.remove("is-fading-out");
  }, 160);
}

function post(type, data = {}) {
  vscode.postMessage({ type, ...data });
}

function handleBusy(message) {
  if (message.action === "mapping") {
    if (message.requestId !== state.selectionRequestId) {
      return;
    }
    state.sessionId = message.sessionId;
  } else if (message.action === "analyze") {
    if (!isCurrentIdentity(message)) {
      return;
    }
  } else if (message.sessionId && message.sessionId !== state.sessionId) {
    return;
  }
  state.analyzing = message.action === "analyze";
  if (["analyze", "apply", "compile", "resolveTrackedRevisions"].includes(message.action)) {
    state.busyAction = message.action;
  }
  elements.compile.disabled = message.action === "compile";
  elements.apply.disabled = message.action === "compile";
  updateAnalyzeAvailability();
  updateManualEditAvailability();
  setStatus(message.message, "busy");
}

function handleMapping(message) {
  if (Number.isInteger(message.interactionVersion) && message.interactionVersion !== state.interactionVersion) {
    return;
  }
  const initialMapping = message.requestId === state.selectionRequestId &&
    (!state.sessionId || message.sessionId === state.sessionId);
  const adjustedMapping = message.requestId === state.rangeRequestId && message.sessionId === state.sessionId;
  if (!initialMapping && !adjustedMapping) {
    return;
  }
  const directDraft = initialMapping && state.directDraft?.selectionRequestId === message.requestId
    ? state.directDraft
    : undefined;
  state.sessionId = message.sessionId;
  state.mappingId = message.mappingId;
  state.selectionRequestId = undefined;
  state.rangeRequestId = undefined;
  state.requiresConfirmation = Boolean(message.requiresConfirmation);
  state.rangeConfirmed = !state.requiresConfirmation;
  state.candidateId = undefined;
  state.analyzing = false;
  if (state.busyAction === "analyze") {
    state.busyAction = undefined;
  }
  elements.adjustRange.disabled = false;
  if (message.selectionKind === "region") {
    state.selectionLabel = "区域框选";
  }
  elements.selectionDetails.hidden = false;
  const mappedPageLabel = Number(message.endPage) > Number(message.page)
    ? `${message.page}--${message.endPage}`
    : message.page;
  elements.selectionSummary.textContent = `第 ${mappedPageLabel} 页 · ${state.selectionLabel} · ${message.selectionLength} 字`;
  elements.sourceDetails.hidden = false;
  elements.sourceDetails.dataset.kind = state.requiresConfirmation ? "warning" : "ready";
  elements.sourceSummary.textContent = `main.tex 第 ${message.startLine}--${message.endLine} 行${state.requiresConfirmation ? " · 需要核对" : ""}`;
  elements.startLine.value = String(message.startLine);
  elements.endLine.value = String(message.endLine);
  elements.confidenceNote.textContent = message.confidenceNote ?? "";
  elements.confidenceNote.hidden = !message.confidenceNote;
  elements.confirmRange.hidden = !state.requiresConfirmation;
  elements.instruction.disabled = false;
  elements.instruction.placeholder = "输入对所选内容的修改要求。";
  elements.candidateActions.hidden = true;
  elements.candidateSummary.hidden = true;
  elements.manualHandoff.hidden = true;
  if (elements.selectionDetails.open) requestSelectionDetail();
  if (elements.sourceDetails.open) requestSourceDetail();
  updateAnalyzeAvailability();
  updateManualEditAvailability();
  updateClearSelectionAvailability();
  setStatus(
    directDraft
      ? state.requiresConfirmation
        ? "直接编辑位置已定位，但需要先确认源码范围。"
        : "直接编辑位置已定位，按 Ctrl+Enter 提交。"
      : state.selectionLabel === "区域框选"
      ? state.interactionMode === "direct"
        ? `${message.confidenceNote ? `${message.confidenceNote} ` : ""}区域已定位，可替换或删除整个区域。`
        : `${message.confidenceNote ? `${message.confidenceNote} ` : ""}区域框选可用于 Agent 分析。`
      : message.confidenceNote || "选区已定位，可输入修改要求。",
    message.confidenceNote ? "warning" : "ready"
  );
  if (directDraft) {
    directDraft.mapped = true;
    if (directDraft.commitRequested) {
      commitDirectDraft();
    }
  }
}

function isCurrentIdentity(message) {
  return message.sessionId === state.sessionId && message.mappingId === state.mappingId;
}

elements.viewer.addEventListener("scroll", scheduleVisibleUpdate, { passive: true });
elements.pages.addEventListener("pointerdown", beginRegionDraft);
elements.pages.addEventListener("pointerdown", beginTextSelectionDrag);
elements.pages.addEventListener("pointermove", moveRegionDraft);
elements.pages.addEventListener("pointermove", moveTextSelectionDrag);
elements.pages.addEventListener("pointerup", finishRegionDraft);
elements.pages.addEventListener("pointercancel", (event) => {
  if (state.regionDraft?.pointerId === event.pointerId) {
    cancelRegionDraft();
    setStatus("区域框选已取消。", "ready");
  }
  finishTextSelectionDrag();
});
function scheduleSelectionCaptureFromEvent(event) {
  if (event.target?.closest?.("input, textarea, button, .direct-edit-draft-overlay")) {
    return;
  }
  setTimeout(() => {
    captureSelection();
    finishTextSelectionDrag();
  }, 0);
}
elements.pages.addEventListener("mouseup", scheduleSelectionCaptureFromEvent);
elements.pages.addEventListener("keyup", scheduleSelectionCaptureFromEvent);
elements.pages.addEventListener("click", handleDirectEditClick);
elements.dockResizer?.addEventListener("pointerdown", beginDockResize);
elements.dockResizer?.addEventListener("pointermove", moveDockResize);
elements.dockResizer?.addEventListener("pointerup", endDockResize);
elements.dockResizer?.addEventListener("pointercancel", endDockResize);
elements.dockToggle?.addEventListener("click", toggleDockCollapsed);
elements.dockResizer?.addEventListener("keydown", (event) => {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const minimum = 168;
  const maximum = Math.max(minimum, window.innerHeight - 170);
  const next = event.key === "Home" ? minimum : event.key === "End" ? maximum :
    state.dockHeight + (event.key === "ArrowUp" ? 24 : -24);
  applyDockHeight(next);
  updateVisiblePages();
  positionImageEditControls();
  scheduleStateSave();
});
elements.viewer.addEventListener("wheel", (event) => {
  if (!event.ctrlKey && !event.metaKey) {
    return;
  }
  event.preventDefault();
  state.pendingWheelDelta += event.deltaY;
  state.pendingWheelAnchor = captureScaleAnchor(event.clientX, event.clientY);
  clearTimeout(state.wheelTimer);
  state.wheelTimer = setTimeout(() => {
    const factor = state.pendingWheelDelta < 0 ? 1.12 : 0.89;
    const anchor = state.pendingWheelAnchor;
    state.pendingWheelDelta = 0;
    state.pendingWheelAnchor = undefined;
    void setScale(state.scale * factor, anchor, false);
  }, 90);
}, { passive: false });

elements.previousPage.addEventListener("click", () => scrollToPage(state.currentPage - 1));
elements.nextPage.addEventListener("click", () => scrollToPage(state.currentPage + 1));
elements.pageNumber.addEventListener("focus", () => { state.pageInputFocused = true; });
elements.pageNumber.addEventListener("blur", () => { state.pageInputFocused = false; });
elements.pageNumber.addEventListener("change", () => {
  scrollToPage(Number(elements.pageNumber.value) || 1);
  state.pageInputFocused = false;
});
elements.zoomOut.addEventListener("click", () => void setScale(state.scale - 0.15, captureScaleAnchor(), false));
elements.zoomIn.addEventListener("click", () => void setScale(state.scale + 0.15, captureScaleAnchor(), false));
elements.fitWidth.addEventListener("click", () => void setScale(computeFitScale(), captureScaleAnchor(), true));
elements.modeDirect.addEventListener("click", () => setInteractionMode("direct"));
elements.modeAgent.addEventListener("click", () => setInteractionMode("agent"));
elements.directEdit.addEventListener("click", () => setSelectionTool("text"));
elements.regionSelect.addEventListener("click", () => setSelectionTool("region"));
elements.clearSelection.addEventListener("click", () => {
  if (isWriteInteractionBusy()) return;
  clearLocalSession(true);
  setStatus("选区已清除。", "ready");
});
elements.compile.addEventListener("click", requestCompile);
elements.instruction.addEventListener("input", updateAnalyzeAvailability);
elements.taskMode.addEventListener("change", () => {
  if (state.skillTaskRunning) return;
  state.selectedTask = elements.taskMode.value;
  clearSkillArtifacts();
  updateAnalyzeAvailability();
});
elements.manualText.addEventListener("input", updateManualEditAvailability);
elements.directInput.addEventListener("compositionstart", () => {
  state.directInputComposing = true;
});
elements.directInput.addEventListener("compositionend", () => {
  state.directInputComposing = false;
  if (state.directDraft) {
    state.directDraft.text = elements.directInput.value;
    if (state.directDraft.kind === "delete" && state.directDraft.text.length > 0) {
      state.directDraft.kind = state.directDraft.baseKind;
      state.directDraft.rects = directDraftBaseRects(state.directDraft);
      state.directDraft.caretDeleteDirection = undefined;
      updateDirectDraftPresentation();
    }
  }
});
elements.directInput.addEventListener("input", () => {
  const draft = state.directDraft;
  if (!draft) return;
  draft.text = elements.directInput.value;
  if (draft.text.length > 0 && draft.kind === "delete") {
    draft.kind = draft.baseKind;
    draft.rects = directDraftBaseRects(draft);
    draft.caretDeleteDirection = undefined;
    updateDirectDraftPresentation();
  }
});
elements.directInput.addEventListener("keydown", (event) => {
  if (event.isComposing || state.directInputComposing || event.keyCode === 229) {
    return;
  }
  if (!state.directDraft) return;
  const modifier = event.ctrlKey || event.metaKey;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelDirectDraft();
    return;
  }
  if (modifier && event.key === "Enter" && !event.isComposing && !state.directInputComposing) {
    event.preventDefault();
    event.stopPropagation();
    commitDirectDraft();
    return;
  }
  if (!modifier && !event.altKey && elements.directInput.value.length === 0 &&
      (event.key === "Backspace" || event.key === "Delete")) {
    event.preventDefault();
    event.stopPropagation();
    setDirectDraftDeletion(event.key === "Backspace" ? "backward" : "forward");
  }
});
elements.manualInsertBefore.addEventListener("click", () => queueManualEdit("insertBefore"));
elements.manualInsertAfter.addEventListener("click", () => queueManualEdit("insertAfter"));
elements.manualReplace.addEventListener("click", () => queueManualEdit("replace"));
elements.manualDelete.addEventListener("click", () => queueManualEdit("delete"));
elements.manualUndo.addEventListener("click", () => {
  requestManualHistory("undoManualEdit");
});
elements.manualClear.addEventListener("click", () => {
  if ((state.pendingManualEditCount === 0 && !state.canRedoManualEdit) || isWriteInteractionBusy()) return;
  state.busyAction = "clearManualEdits";
  updateManualEditAvailability();
  post("clearManualEdits", { queueVersion: state.manualEditQueueVersion });
});
elements.showManualEditsDiff.addEventListener("click", () => {
  if (state.pendingManualEditCount === 0 || isWriteInteractionBusy()) return;
  state.busyAction = "showManualEditsDiff";
  updateManualEditAvailability();
  post("showManualEditsDiff", { queueVersion: state.manualEditQueueVersion });
});
for (const [button, mode] of [
  [elements.manualAcceptAll, "accept"],
  [elements.manualRejectAll, "reject"]
]) {
  button.addEventListener("click", () => {
    if (!state.hasTrackedRevisions || isWriteInteractionBusy()) return;
    state.busyAction = "resolveTrackedRevisions";
    updateManualEditAvailability();
    post("resolveTrackedRevisions", { mode });
  });
}

elements.selectionDetails.addEventListener("toggle", () => {
  if (elements.selectionDetails.open) {
    requestSelectionDetail();
  } else {
    state.selectionDetailRequestId = undefined;
    elements.selectionText.textContent = "";
  }
});
elements.sourceDetails.addEventListener("toggle", () => {
  if (elements.sourceDetails.open) {
    requestSourceDetail();
  } else {
    state.sourceDetailRequestId = undefined;
    elements.sourceText.textContent = "";
  }
});
elements.adjustRange.addEventListener("click", () => {
  if (!state.sessionId || !state.mappingId || isWriteInteractionBusy()) return;
  const requestId = createId();
  state.rangeRequestId = requestId;
  elements.adjustRange.disabled = true;
  updateManualEditAvailability();
  setStatus("正在更新源码范围……", "busy");
  post("adjustRange", {
    requestId,
    sessionId: state.sessionId,
    mappingId: state.mappingId,
    startLine: Number(elements.startLine.value),
    endLine: Number(elements.endLine.value)
  });
});
elements.openSource.addEventListener("click", () => {
  if (state.sessionId && state.mappingId) {
    post("openSource", { sessionId: state.sessionId, mappingId: state.mappingId });
  }
});
elements.confirmRange.addEventListener("click", () => {
  if (!state.sessionId || !state.mappingId) return;
  post("confirmRange", {
    requestId: createId(),
    sessionId: state.sessionId,
    mappingId: state.mappingId
  });
});
elements.analyze.addEventListener("click", () => {
  if (state.skillTaskRunning) {
    post("cancelSkillTask");
    setStatus("正在取消 Skill 任务……", "busy");
    return;
  }
  if (state.pendingManualEditCount > 0) return;
  const skill = selectedSkill();
  if (skill) {
    const useSelection = skill.scope === "selection" || (skill.scope === "either" && Boolean(state.mappingId));
    if (useSelection && (!state.sessionId || !state.mappingId)) return;
    state.skillTaskRunning = true;
    state.busyAction = "skillTask";
    clearSkillArtifacts();
    updateAnalyzeAvailability();
    updateManualEditAvailability();
    post("runSkillTask", {
      skillId: skill.id,
      instruction: elements.instruction.value,
      useSelection
    });
    return;
  }
  if (!state.sessionId || !state.mappingId) return;
  state.analyzing = true;
  state.busyAction = "analyze";
  updateAnalyzeAvailability();
  updateManualEditAvailability();
  post("analyze", {
    requestId: createId(),
    sessionId: state.sessionId,
    mappingId: state.mappingId,
    instruction: elements.instruction.value
  });
});
elements.manualHandoff.addEventListener("click", () => {
  if (state.sessionId && state.mappingId && state.pendingManualEditCount === 0 && !isWriteInteractionBusy()) {
    post("manualHandoff", { sessionId: state.sessionId, mappingId: state.mappingId });
  }
});
elements.showDiff.addEventListener("click", () => postCandidateAction("showDiff"));
elements.apply.addEventListener("click", () => postCandidateAction("apply"));
elements.discard.addEventListener("click", () => postCandidateAction("discard"));

function postCandidateAction(type) {
  if (!state.candidateId || !state.sessionId || !state.mappingId) return;
  if (type === "apply") {
    if (state.pendingManualEditCount > 0) return;
    state.busyAction = "apply";
    updateManualEditAvailability();
  }
  post(type, {
    sessionId: state.sessionId,
    mappingId: state.mappingId,
    candidateId: state.candidateId
  });
}

function confirmCollapsedDockAction() {
  if (!state.dockCollapsed) return false;
  if (state.candidateId && state.sessionId && state.mappingId && !elements.apply.disabled) {
    postCandidateAction("apply");
    return true;
  }
  if (state.requiresConfirmation && !state.rangeConfirmed && !elements.confirmRange.disabled) {
    elements.confirmRange.click();
    return true;
  }
  return false;
}

window.addEventListener("resize", () => {
  clearTimeout(state.resizeTimer);
  state.resizeTimer = setTimeout(() => {
    applyDockHeight(state.dockHeight);
    if (state.fitMode && state.document) {
      void setScale(computeFitScale(), captureScaleAnchor(), true);
    } else {
      updateVisiblePages();
    }
    positionImageEditControls();
  }, 180);
});

function isEditableKeyboardTarget(target) {
  const element = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  return Boolean(element?.closest?.("input, textarea, [contenteditable]:not([contenteditable=\"false\"])")) ||
    Boolean(element?.isContentEditable);
}

window.addEventListener("keydown", (event) => {
  const modifier = event.ctrlKey || event.metaKey;
  if (
    modifier && !event.altKey && event.key === "Enter" && !event.isComposing && event.keyCode !== 229 &&
    !isEditableKeyboardTarget(event.target)
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (state.imageEditDraft) {
      queueImageEditDraft();
    } else if (state.directDraft) {
      commitDirectDraft();
    } else if (confirmCollapsedDockAction()) {
      // 收起工具区后优先确认当前待确认事项。
    } else {
      requestCompile();
    }
    return;
  }
  if (state.interactionMode === "direct" && modifier && !event.altKey && !isEditableKeyboardTarget(event.target)) {
    const key = event.key.toLowerCase();
    if (key === "y" || (key === "z" && event.shiftKey)) {
      event.preventDefault();
      requestManualHistory("redoManualEdit");
      return;
    }
    if (key === "z") {
      event.preventDefault();
      requestManualHistory("undoManualEdit");
      return;
    }
  }
  if (event.key !== "Escape" || event.target?.matches?.("input, textarea")) {
    return;
  }
  if (cancelImageEditDraft()) {
    return;
  }
  if (cancelDirectDraft()) {
    return;
  }
  if (state.regionDraft) {
    cancelRegionDraft();
    setStatus("区域框选已取消。", "ready");
    return;
  }
  if (state.regionSelection) {
    clearLocalSession(true);
    setStatus("选区已清除。", "ready");
  }
});

window.addEventListener("message", async (event) => {
  const message = event.data;
  if (!message || typeof message.type !== "string") {
    return;
  }
  switch (message.type) {
    case "skillsChanged":
      updateSkills(message.skills);
      break;
    case "skillTaskStarted":
      state.skillTaskRunning = true;
      state.busyAction = "skillTask";
      elements.compile.disabled = true;
      clearSkillArtifacts();
      startSkillProgress(message);
      updateAnalyzeAvailability();
      updateManualEditAvailability();
      setStatus(message.message, "busy");
      break;
    case "skillTaskProgress":
      updateSkillProgress(message);
      setStatus(message.message, "busy");
      break;
    case "skillTaskCancelling":
      setStatus(message.message, "busy");
      break;
    case "skillTaskCompleted": {
      state.skillTaskRunning = false;
      state.busyAction = undefined;
      elements.compile.disabled = false;
      finishSkillProgress(message.summary || "Skill 任务完成", "completed", message.qualityGates);
      showSkillArtifacts(message);
      updateAnalyzeAvailability();
      updateManualEditAvailability();
      const warningCount = Array.isArray(message.warnings) ? message.warnings.length : 0;
      setStatus(warningCount ? `Skill 任务完成，包含 ${warningCount} 项提示。` : "Skill 任务完成，产物已列出。", warningCount ? "warning" : "ready");
      break;
    }
    case "skillTaskCancelled":
      state.skillTaskRunning = false;
      state.busyAction = undefined;
      elements.compile.disabled = false;
      finishSkillProgress(message.message || "Skill 任务已取消", "cancelled");
      updateAnalyzeAvailability();
      updateManualEditAvailability();
      setStatus(message.message || "Skill 任务已取消。", "ready");
      break;
    case "skillTaskFailed":
      state.skillTaskRunning = false;
      state.busyAction = undefined;
      elements.compile.disabled = false;
      finishSkillProgress(message.message || "Skill 任务失败", "failed", message.qualityGates);
      updateAnalyzeAvailability();
      updateManualEditAvailability();
      setStatus(message.message || "Skill 任务失败。", "error");
      break;
    case "compileProgress":
      updateCompileProgress(message);
      break;
    case "busy":
      handleBusy(message);
      break;
    case "mapping":
      handleMapping(message);
      break;
    case "selectionDetail":
      if (isCurrentIdentity(message) && message.requestId === state.selectionDetailRequestId && elements.selectionDetails.open) {
        elements.selectionText.textContent = message.text;
      }
      break;
    case "sourceDetail":
      if (isCurrentIdentity(message) && message.requestId === state.sourceDetailRequestId && elements.sourceDetails.open) {
        elements.startLine.value = String(message.startLine);
        elements.endLine.value = String(message.endLine);
        elements.sourceText.textContent = message.sourceText;
        elements.confidenceNote.textContent = message.confidenceNote ?? "";
        elements.confidenceNote.hidden = !message.confidenceNote;
        elements.confirmRange.hidden = !message.requiresConfirmation || state.rangeConfirmed;
      }
      break;
    case "rangeConfirmed":
      if (isCurrentIdentity(message)) {
        state.rangeConfirmed = true;
        elements.confirmRange.hidden = true;
        elements.sourceDetails.dataset.kind = "ready";
        elements.sourceSummary.textContent = `main.tex 第 ${elements.startLine.value}--${elements.endLine.value} 行 · 已确认`;
        updateAnalyzeAvailability();
        updateManualEditAvailability();
        setStatus(`源码范围已确认，可交给 ${state.assistantName} 分析。`, "ready");
      }
      break;
    case "candidate":
      if (isCurrentIdentity(message)) {
        state.candidateId = message.candidateId;
        state.analyzing = false;
        if (state.busyAction === "analyze") {
          state.busyAction = undefined;
        }
        elements.candidateActions.hidden = false;
        elements.candidateSummary.hidden = false;
        elements.candidateSummary.textContent = message.summary;
        updateAnalyzeAvailability();
        updateManualEditAvailability();
        setStatus("修订建议已在差异视图中打开，尚未修改文件。", "ready");
      }
      break;
    case "candidateCleared":
      if (
        isCurrentIdentity(message) &&
        (!message.candidateId || message.candidateId === state.candidateId)
      ) {
        state.candidateId = undefined;
        state.analyzing = false;
        elements.candidateActions.hidden = true;
        elements.candidateSummary.hidden = true;
        updateAnalyzeAvailability();
        updateManualEditAvailability();
      }
      break;
    case "imageEditTarget": {
      if (message.requestId !== state.imageLocateRequestId) break;
      state.imageLocateRequestId = undefined;
      state.busyAction = undefined;
      const page = positivePage(message.page);
      const rects = Array.isArray(message.rects) ? message.rects.map((rect) => ({ ...rect })).filter((rect) =>
        Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height)
      ) : [];
      if (!page || rects.length === 0 || typeof message.targetId !== "string") {
        setStatus("后端返回的图片定位数据无效，请重试。", "error");
        break;
      }
      state.imageEditDraft = {
        targetId: message.targetId,
        page,
        rects,
        imagePath: typeof message.imagePath === "string" ? message.imagePath : "",
        originalValue: typeof message.originalValue === "string" ? message.originalValue : "原尺寸",
        roughBounds: message.roughBounds,
        snappedBounds: message.snappedBounds,
        syncTexBounds: message.syncTexBounds,
        pageWidth: message.pageWidth,
        pageHeight: message.pageHeight,
        factor: 1
      };
      clearRegionSelection();
      renderImageEditDraft();
      updateManualEditAvailability();
      updateClearSelectionAvailability();
      setStatus("图片已定位。使用上下箭头调整候选尺寸，按 Ctrl+Enter 暂存后再编译。", "ready");
      break;
    }
    case "imageEditQueued": {
      if (message.requestId !== state.imageQueueRequestId) break;
      const edit = normalizePendingEdit(message.edit);
      updateManualEditQueueVersion(message.queueVersion);
      state.imageQueueRequestId = undefined;
      state.busyAction = undefined;
      if (!edit) {
        updateManualEditAvailability();
        setStatus("后端返回的图片调整数据无效，请重试。", "error");
        break;
      }
      const edits = state.pendingManualEdits.filter((item) => item.id !== edit.id);
      edits.push(edit);
      setPendingManualEdits(edits, message.count, message);
      clearImageEditDraft();
      clearRegionSelection();
      updateClearSelectionAvailability();
      setStatus(`图片尺寸调整已暂存，共 ${state.pendingManualEditCount} 项待编译。`, "success");
      break;
    }
    case "manualEditQueued": {
      if (message.requestId && message.requestId !== state.manualEditRequestId) break;
      const directQueued = message.requestId && message.requestId === state.directQueueRequestId;
      const edit = normalizePendingEdit(message.edit);
      updateManualEditQueueVersion(message.queueVersion);
      state.manualEditRequestId = undefined;
      state.busyAction = undefined;
      if (!edit) {
        updateManualEditAvailability();
        setStatus("后端返回的手动修订数据无效，请重试。", "error");
        break;
      }
      const edits = state.pendingManualEdits.filter((item) => item.id !== edit.id);
      edits.push(edit);
      setPendingManualEdits(edits, message.count, message);
      if (edit.kind !== "delete") {
        elements.manualText.value = "";
        updateManualEditAvailability();
      }
      if (directQueued) {
        clearLocalSession(true);
      }
      setStatus(
        edit.structuralFormula
          ? `完整公式结构已暂存，共 ${state.pendingManualEditCount} 项待编译。`
          : state.manualEditMode === "tracked"
          ? `已加入待提交修订，共 ${state.pendingManualEditCount} 项。`
          : `编辑已暂存，共 ${state.pendingManualEditCount} 项待编译。`,
        "success"
      );
      break;
    }
    case "manualEditsState":
      updateManualEditQueueVersion(message.queueVersion);
      if (["undoManualEdit", "redoManualEdit", "removeManualEdit", "clearManualEdits"].includes(state.busyAction)) {
        state.busyAction = undefined;
      }
      setPendingManualEdits(message.edits, message.count, message);
      break;
    case "manualEditRemoved": {
      updateManualEditQueueVersion(message.queueVersion);
      state.busyAction = undefined;
      if (Array.isArray(message.edits)) {
        setPendingManualEdits(message.edits, message.count, message);
      } else {
        const editId = message.editId ?? message.id ?? message.edit?.id;
        const edits = typeof editId === "string"
          ? state.pendingManualEdits.filter((edit) => edit.id !== editId)
          : state.pendingManualEdits.slice(0, -1);
        setPendingManualEdits(edits, message.count, message);
      }
      setStatus(message.removedFromQueue
        ? `已移除该项编辑，剩余 ${state.pendingManualEditCount} 项待编译。`
        : `已撤销最近一项编辑，剩余 ${state.pendingManualEditCount} 项待编译。`, "ready");
      break;
    }
    case "manualEditRestored": {
      updateManualEditQueueVersion(message.queueVersion);
      state.busyAction = undefined;
      setPendingManualEdits(message.edits, message.count, message);
      setStatus(`已重做最近一项编辑，共 ${state.pendingManualEditCount} 项待编译。`, "ready");
      break;
    }
    case "manualEditsCleared":
      updateManualEditQueueVersion(message.queueVersion);
      state.manualEditRequestId = undefined;
      state.busyAction = undefined;
      setPendingManualEdits([], 0, message);
      setStatus("待编译编辑已清空。", "ready");
      break;
    case "manualEditModeChanged":
      updateManualEditMode(message.manualEditMode);
      setStatus(state.manualEditMode === "tracked" ? "已切换为修订痕迹模式。" : "已切换为直接编辑模式。", "ready");
      break;
    case "trackedRevisionsState":
      state.hasTrackedRevisions = Boolean(message.hasTrackedRevisions);
      if (state.busyAction === "resolveTrackedRevisions") {
        state.busyAction = undefined;
      }
      updateManualEditAvailability();
      if (state.hasTrackedRevisions && state.manualEditMode === "direct") {
        setStatus("检测到旧版修订痕迹，请先接受全部或拒绝全部，再进行直接编辑。", "warning");
      }
      break;
    case "manualFallback":
      if (isCurrentIdentity(message)) {
        state.analyzing = false;
        if (state.busyAction === "analyze") {
          state.busyAction = undefined;
        }
        updateAssistantName(message.assistantName);
        elements.manualHandoff.hidden = false;
        updateAnalyzeAvailability();
        updateManualEditAvailability();
        setStatus(message.message, "warning");
      }
      break;
    case "assistantChanged":
      updateAssistantName(message.assistantName);
      elements.manualHandoff.hidden = true;
      break;
    case "sessionCleared":
      if (message.sessionId && message.sessionId === state.sessionId) {
        clearLocalSession(false);
      }
      break;
    case "applied":
      if (state.busyAction === "apply") {
        state.busyAction = undefined;
      }
      updateManualEditAvailability();
      setStatus("修改已保存，正在按配置执行后续步骤。", "ready");
      break;
    case "compiled": {
      state.busyAction = undefined;
      elements.compile.disabled = false;
      elements.apply.disabled = false;
      const warningCount = Array.isArray(message.warnings) ? message.warnings.length : 0;
      try {
        activePdfFingerprint = message.pdfFingerprint || activePdfFingerprint;
        activePreviewKey = message.previewKey || activePreviewKey;
        state.cachedPreviewSignature = undefined;
        config.preview = undefined;
        await loadPdf({ preservePosition: true });
        finishCompileProgress("编译完成，PDF 已刷新");
        updateManualEditAvailability();
        setStatus(warningCount ? `编译完成，日志中有 ${warningCount} 项警告。` : "编译完成，PDF 已刷新。", warningCount ? "warning" : "success");
      } catch (error) {
        finishCompileProgress("PDF 刷新失败", "error");
        setStatus(error.message || String(error), "error");
      }
      break;
    }
    case "notice":
      if (["compile", "undoManualEdit", "redoManualEdit", "removeManualEdit", "clearManualEdits", "showManualEditsDiff", "resolveTrackedRevisions"].includes(state.busyAction)) {
        state.busyAction = undefined;
        updateManualEditAvailability();
      }
      setStatus(message.message, "ready");
      break;
    case "error":
      if (message.action === "locateImage" && message.requestId !== state.imageLocateRequestId) break;
      if (message.action === "queueImageEdit" && message.requestId !== state.imageQueueRequestId) break;
      if (message.action === "queueManualEdit" && message.requestId && message.requestId !== state.manualEditRequestId) break;
      if (message.action === "adjustRange" && message.requestId !== state.rangeRequestId) break;
      if (!["queueManualEdit", "adjustRange"].includes(message.action) && message.sessionId && message.sessionId !== state.sessionId) break;
      if (message.action === "selection" && message.requestId !== state.selectionRequestId) break;
      if (message.action === "adjustRange") {
        state.rangeRequestId = undefined;
        elements.adjustRange.disabled = false;
      }
      if (message.action === "queueManualEdit") {
        state.manualEditRequestId = undefined;
        if (message.requestId === state.directQueueRequestId) {
          state.directQueueRequestId = undefined;
          requestAnimationFrame(() => elements.directInput.focus({ preventScroll: true }));
        }
      }
      if (message.action === "selection") {
        state.selectionRequestId = undefined;
        if (state.directDraft?.selectionRequestId === message.requestId) {
          state.directDraft.commitRequested = false;
          state.directDraft.mapped = false;
        }
      }
      if (message.action === "locateImage") {
        state.imageLocateRequestId = undefined;
        clearImageEditDraft();
      }
      if (message.action === "queueImageEdit") {
        state.imageQueueRequestId = undefined;
      }
      if (message.action === "runSkillTask") {
        state.skillTaskRunning = false;
        elements.compile.disabled = false;
      }
      state.analyzing = false;
      if (!message.action || message.action === state.busyAction || [
        "analyze",
        "runSkillTask",
        "apply",
        "compile",
        "queueManualEdit",
        "locateImage",
        "queueImageEdit",
        "undoManualEdit",
        "redoManualEdit",
        "removeManualEdit",
        "clearManualEdits",
        "showManualEditsDiff",
        "resolveTrackedRevisions"
      ].includes(message.action)) {
        state.busyAction = undefined;
      }
      elements.compile.disabled = false;
      elements.apply.disabled = false;
      if (message.action === "compile" || state.compileProgressActive) {
        finishCompileProgress(message.action === "runSkillTask" ? "Skill 任务未启动" : "编译失败，请查看错误信息", "error");
      }
      updateAnalyzeAvailability();
      updateManualEditAvailability();
      setStatus(message.message, "error");
      break;
  }
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function positivePage(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function createId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function isCancellation(error) {
  return error?.name === "RenderingCancelledException" || /cancel/i.test(error?.message ?? "");
}

updateSelectionToolUi();
post("ready");
loadPdf({ preservePosition: false }).catch((error) => {
  hideLoading();
  setStatus(error.message || String(error), "error");
});
