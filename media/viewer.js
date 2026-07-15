const vscode = acquireVsCodeApi();
const config = JSON.parse(document.getElementById("circletex-config").textContent);
const pdfjs = await import(config.pdfJsUri);
pdfjs.GlobalWorkerOptions.workerSrc = config.workerUri;

const elements = {
  viewer: document.getElementById("viewer"),
  pages: document.getElementById("pages"),
  loading: document.getElementById("loading"),
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
  instruction: document.getElementById("instruction"),
  analyze: document.getElementById("analyze"),
  manualHandoff: document.getElementById("manual-handoff"),
  candidateActions: document.getElementById("candidate-actions"),
  candidateSummary: document.getElementById("candidate-summary"),
  showDiff: document.getElementById("show-diff"),
  apply: document.getElementById("apply"),
  discard: document.getElementById("discard"),
  compileProgress: document.getElementById("compile-progress"),
  compileProgressLabel: document.getElementById("compile-progress-label"),
  compileProgressValue: document.getElementById("compile-progress-value"),
  compileProgressTrack: document.getElementById("compile-progress-track"),
  compileProgressFill: document.getElementById("compile-progress-fill"),
  status: document.getElementById("status")
};

const directEditButton = document.createElement("button");
directEditButton.id = "direct-edit";
directEditButton.className = "icon-button tool-toggle";
directEditButton.type = "button";
directEditButton.title = "直接编辑";
directEditButton.setAttribute("aria-label", "直接编辑 PDF 文字");
directEditButton.setAttribute("aria-pressed", "false");
const directEditIcon = document.createElement("span");
directEditIcon.className = "direct-edit-icon";
directEditIcon.setAttribute("aria-hidden", "true");
directEditButton.append(directEditIcon);
elements.regionSelect.before(directEditButton);

const directEditInput = document.createElement("textarea");
directEditInput.id = "direct-edit-input";
directEditInput.className = "direct-edit-input";
directEditInput.rows = 1;
directEditInput.maxLength = 2_000;
directEditInput.hidden = true;
directEditInput.setAttribute("aria-label", "PDF 直接编辑输入");
document.body.append(directEditInput);
elements.directEdit = directEditButton;
elements.directInput = directEditInput;

const showManualEditsDiffButton = document.createElement("button");
showManualEditsDiffButton.id = "show-manual-edits-diff";
showManualEditsDiffButton.className = "secondary-button";
showManualEditsDiffButton.type = "button";
showManualEditsDiffButton.textContent = "查看改动";
showManualEditsDiffButton.disabled = true;
elements.manualClear.after(showManualEditsDiffButton);
elements.showManualEditsDiff = showManualEditsDiffButton;

const persisted = vscode.getState() ?? {};
const state = {
  document: undefined,
  pageStates: [],
  loadGeneration: 0,
  scale: clamp(Number(persisted.scale) || 1.25, 0.45, 3),
  fitMode: persisted.fitMode !== false,
  currentPage: positivePage(persisted.pageNumber) || 1,
  renderQueue: [],
  queuedPages: new Set(),
  desiredPages: new Set(),
  activeRenders: 0,
  observer: undefined,
  selectedPage: undefined,
  selectionTool: persisted.directEditEnabled === true ? "text" : persisted.selectionTool === "region" ? "region" : "text",
  directEditEnabled: persisted.directEditEnabled === true,
  directDraft: undefined,
  directCaptureSpec: undefined,
  directIgnoreNextSelectionCapture: false,
  directInputComposing: false,
  directQueueRequestId: undefined,
  selectionLabel: "文字选区",
  textSelection: undefined,
  regionDraft: undefined,
  regionSelection: undefined,
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
  scrollFrame: 0,
  saveTimer: undefined,
  resizeTimer: undefined,
  wheelTimer: undefined,
  pendingWheelDelta: 0,
  pendingWheelAnchor: undefined,
  pageInputFocused: false,
  pdfRefreshInProgress: false,
  compileProgressActive: false,
  compileProgressPercent: 0,
  compileProgressHideTimer: undefined
};

async function loadPdf({ preservePosition = true } = {}) {
  state.pdfRefreshInProgress = true;
  try {
    await loadPdfCore({ preservePosition });
  } finally {
    state.pdfRefreshInProgress = false;
  }
}

async function loadPdfCore({ preservePosition = true } = {}) {
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
  setLoading("正在读取 main.pdf……");

  const readStartedAt = performance.now();
  if (state.compileProgressActive) {
    updateCompileProgress({ percent: 94, message: "正在读取新 PDF", indeterminate: true });
  }
  const response = await fetch(config.pdfUri, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`无法读取 main.pdf：${response.status}`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  reportPerformance("PDF 文件读取", readStartedAt);
  const loadingTask = pdfjs.getDocument({
    data,
    cMapUrl: config.cMapUri,
    cMapPacked: true,
    standardFontDataUrl: config.standardFontsUri
  });
  const nextDocument = await loadingTask.promise;
  const metadataStartedAt = performance.now();
  if (state.compileProgressActive) {
    updateCompileProgress({ percent: 96, message: "正在扫描 PDF 页面", indeterminate: true });
  }
  let metadata;
  try {
    metadata = await readPageMetadata(nextDocument, restore.pageNumber);
  } catch (error) {
    await nextDocument.destroy();
    throw error;
  }
  reportPerformance("PDF 页面元数据扫描", metadataStartedAt);

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
  state.scale = state.fitMode ? computeFitScale(metadata) : clamp(restore.scale, 0.45, 3);
  buildPageShells(metadata, false);
  elements.pageCount.textContent = `/ ${nextDocument.numPages}`;
  elements.pageNumber.max = String(nextDocument.numPages);
  elements.zoomValue.textContent = `${Math.round(state.scale * 100)}%`;
  const restorePageNumber = clamp(restore.pageNumber, 1, nextDocument.numPages);
  state.currentPage = restorePageNumber;
  attachPageSnapshot(refreshSnapshot, state.pageStates[restorePageNumber - 1]);
  await nextFrame();
  await nextFrame();
  restoreViewState({ ...restore, pageNumber: restorePageNumber });
  state.desiredPages = new Set([restorePageNumber]);
  const primaryRenderStartedAt = performance.now();
  if (state.compileProgressActive) {
    updateCompileProgress({ percent: 98, message: "正在渲染当前页", indeterminate: true });
  }
  await renderPageRecord(state.pageStates[restorePageNumber - 1]);
  reportPerformance("PDF 当前页渲染", primaryRenderStartedAt);
  for (const record of state.pageStates) {
    state.observer.observe(record.shell);
  }
  hideLoading();
  updateVisiblePages();
  reportPerformance("PDF 刷新总计", loadStartedAt);
  setStatus("PDF 已就绪。", "ready");
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
}

function scheduleVisibleUpdate() {
  if (state.pdfRefreshInProgress || state.scrollFrame) {
    return;
  }
  state.scrollFrame = requestAnimationFrame(() => {
    state.scrollFrame = 0;
    updateVisiblePages();
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
  if (!state.pageInputFocused) {
    elements.pageNumber.value = String(bestPage);
  }
  elements.previousPage.disabled = bestPage <= 1;
  elements.nextPage.disabled = bestPage >= state.pageStates.length;

  const budget = state.scale > 2.1 ? 3 : 5;
  const desired = new Set();
  if (state.selectedPage) {
    desired.add(state.selectedPage);
  }
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
    if (!desired.has(record.number) && (record.status === "rendered" || record.status === "rendering")) {
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
  if (record.status === "rendered" && record.renderedScale === state.scale) {
    return;
  }
  if (record.status === "rendering") {
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

async function renderPageRecord(record) {
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
    surface.className = "page-surface";
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
    const textPromise = page.getTextContent();
    const [, textContent] = await Promise.all([record.renderTask.promise, textPromise]);
    if (isRenderStale(record, documentGeneration, renderGeneration, scale)) {
      return;
    }
    record.textLayer = new pdfjs.TextLayer({
      textContentSource: textContent,
      container: textLayerElement,
      viewport
    });
    await record.textLayer.render();
    if (isRenderStale(record, documentGeneration, renderGeneration, scale)) {
      return;
    }
    record.placeholder.hidden = true;
    record.renderedScale = scale;
    record.status = "rendered";
    record.shell.querySelector(":scope > .page-refresh-snapshot")?.remove();
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
  if (!force && record.number === state.selectedPage) {
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
  record.pageProxy = undefined;
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
    directEditEnabled: state.directEditEnabled
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
  elements.viewer.dataset.directEdit = String(state.directEditEnabled);
  elements.regionSelect.setAttribute("aria-pressed", String(state.selectionTool === "region"));
  elements.directEdit.setAttribute("aria-pressed", String(state.directEditEnabled));
  updateClearSelectionAvailability();
  updateManualEditAvailability();
}

function updateClearSelectionAvailability() {
  elements.clearSelection.disabled = isWriteInteractionBusy() || !(
    state.regionDraft ||
    state.regionSelection ||
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
  state.selectionTool = tool === "region" ? "region" : "text";
  if (state.selectionTool === "region") {
    state.directEditEnabled = false;
    discardDirectDraft();
  }
  if (state.selectionTool !== "region") {
    cancelRegionDraft();
  }
  updateSelectionToolUi();
  scheduleStateSave();
  setStatus(state.selectionTool === "region" ? "区域框选模式。" : "文字拖选模式。", "ready");
}

function setDirectEditEnabled(enabled) {
  if (isWriteInteractionBusy()) {
    return;
  }
  state.directEditEnabled = Boolean(enabled);
  if (state.directEditEnabled) {
    state.selectionTool = "text";
    cancelRegionDraft();
    clearRegionSelection();
  } else {
    discardDirectDraft();
  }
  updateSelectionToolUi();
  scheduleStateSave();
  setStatus(
    state.directEditEnabled
      ? "直接编辑模式：拖选可替换或批量删除；单击光标每个草稿处理一个相邻字素，Ctrl+Enter 提交。"
      : "已退出直接编辑模式。",
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
    if (!extracted.text) {
      updateClearSelectionAvailability();
      setStatus("该区域没有可提取的 PDF 文字。", "warning");
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
    state.selectedPage = record.number;
    const requestId = createId();
    state.selectionRequestId = requestId;
    post("selection", {
      requestId,
      selectionKind: "region",
      text: extracted.text,
      page: record.number,
      start: extracted.start,
      end: extracted.end,
      bounds,
      anchors: extracted.anchors
    });
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
  outline.className = "region-selection-outline";
  applyPdfRectStyle(outline, selection.bounds);
  overlay.append(outline);
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
  const edits = state.pendingManualEdits.filter((edit) => edit.page === record.number);
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
    if (edit.kind === "delete" || edit.kind === "replace") {
      for (const rect of edit.rects) {
        const deletion = document.createElement("div");
        deletion.className = "manual-edit-deletion";
        applyNormalizedRectStyle(deletion, rect);
        group.append(deletion);
      }
    }

    if (edit.kind !== "delete" && edit.insertedText) {
      const anchor = edit.kind === "insertAfter" ? edit.rects.at(-1) : edit.rects[0];
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
  if (!draft || draft.page !== record.number) {
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "direct-edit-draft-overlay";
  overlay.dataset.kind = draft.kind;
  overlay.dataset.pageNumber = String(record.number);
  for (const rect of draft.rects) {
    const target = document.createElement("div");
    target.className = "direct-edit-draft-target";
    applyNormalizedRectStyle(target, rect);
    overlay.append(target);
  }

  const first = draft.rects[0];
  const last = draft.rects.at(-1) ?? first;
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

function updateDirectDraftPresentation() {
  const draft = state.directDraft;
  const overlay = document.querySelector(".direct-edit-draft-overlay");
  if (!draft || !overlay) {
    return;
  }
  overlay.dataset.kind = draft.kind;
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
  const textLines = lines.map((line) => buildRegionLineText(line.units)).filter(Boolean);
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
    highlights: buildRegionHighlights(lines, pageRect, record)
  };
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
      caretRect,
      backwardRects: beforeRects,
      forwardRects: afterRects
    }
  };
}

function handleDirectEditClick(event) {
  if (!state.directEditEnabled || state.selectionTool !== "text" || isWriteInteractionBusy()) {
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
  if (state.selectionTool === "region" || isWriteInteractionBusy()) {
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
  if (startLayer !== endLayer) {
    clearLocalSession(true);
    setStatus("暂不支持跨页选区，请在单页内重新划选。", "warning");
    return;
  }
  const pageNumber = Number(startLayer.dataset.pageNumber);
  const record = state.pageStates[pageNumber - 1];
  if (!record || record.rotation !== 0) {
    clearLocalSession(true);
    setStatus("当前版本暂不支持旋转页面的 SyncTeX 定位。", "error");
    return;
  }
  const rawText = selection.toString();
  const text = rawText.trim();
  if (!text) {
    return;
  }
  const layerRect = startLayer.getBoundingClientRect();
  if (layerRect.width <= 0 || layerRect.height <= 0) {
    return;
  }
  const rects = [...range.getClientRects()].filter((rect) =>
    rect.width > 0 && rect.height > 0 &&
    rect.right > layerRect.left && rect.left < layerRect.right &&
    rect.bottom > layerRect.top && rect.top < layerRect.bottom
  );
  if (rects.length === 0) {
    return;
  }
  const pageRect = record.shell.getBoundingClientRect();
  const normalizedRects = normalizeTextSelectionRects(rects, pageRect);
  if (normalizedRects.length === 0) {
    return;
  }
  const first = rects[0];
  const last = rects.at(-1);
  const toPoint = (rect, useRight) => {
    const inset = Math.min(rect.width * 0.2, 3);
    const rawX = ((useRight ? rect.right - inset : rect.left + inset) - layerRect.left) * record.widthPt / layerRect.width;
    const rawY = (rect.top + rect.height / 2 - layerRect.top) * record.heightPt / layerRect.height;
    return {
      x: clamp(rawX, 0.5, record.widthPt - 0.5),
      y: clamp(rawY, 0.5, record.heightPt - 0.5)
    };
  };

  const directCaptureSpec = state.directCaptureSpec;
  const selectionContext = captureTextSelectionContext(startLayer, range);
  state.directCaptureSpec = undefined;
  discardDirectDraft();
  clearRegionSelection();
  beginLocalSelection(pageNumber, text.length, "文字选区");
  state.textSelection = { pageNumber, rects: normalizedRects };
  state.selectedPage = pageNumber;
  const requestId = createId();
  state.selectionRequestId = requestId;
  post("selection", {
    requestId,
    selectionKind: "text",
    text,
    page: pageNumber,
    start: toPoint(first, false),
    end: toPoint(last, true),
    contextBefore: selectionContext.before,
    contextAfter: selectionContext.after
  });
  if (state.directEditEnabled) {
    const spec = directCaptureSpec;
    const leadingTrimLength = rawText.length - rawText.trimStart().length;
    const caretRawOffset = spec?.caretRawOffset;
    const caretVisibleOffset = Number.isInteger(caretRawOffset)
      ? visibleTextLength(rawText.slice(leadingTrimLength, clamp(caretRawOffset, leadingTrimLength, leadingTrimLength + text.length)))
      : undefined;
    const kind = spec?.kind ?? "replace";
    state.directDraft = {
      page: pageNumber,
      rects: spec?.caretRect ? [spec.caretRect] : normalizedRects,
      selectionRects: normalizedRects,
      caretRect: spec?.caretRect,
      backwardRects: spec?.backwardRects ?? [],
      forwardRects: spec?.forwardRects ?? [],
      caretVisibleOffset,
      baseKind: kind,
      kind,
      text: "",
      selectionRequestId: requestId,
      mapped: false,
      commitRequested: false
    };
    renderDirectDraft(record, true);
    setStatus("直接编辑草稿已建立，输入文字后按 Ctrl+Enter 提交，Esc 取消。", "ready");
  } else {
    state.directCaptureSpec = undefined;
  }
  updateManualEditAvailability();
  updateVisiblePages();
}

function captureTextSelectionContext(layer, range) {
  const startBoundary = normalizeCaretBoundary(range.startContainer, range.startOffset, layer);
  const endBoundary = normalizeCaretBoundary(range.endContainer, range.endOffset, layer);
  if (!startBoundary || !endBoundary) {
    return { before: "", after: "" };
  }
  const nodes = textNodesInLayer(layer);
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
  elements.analyze.disabled = !state.mappingId || !hasInstruction || !confirmed || state.analyzing ||
    state.pendingManualEditCount > 0 || Boolean(state.directDraft) || Boolean(state.candidateId) || isWriteInteractionBusy();
}

function isWriteInteractionBusy() {
  return Boolean(state.manualEditRequestId) || Boolean(state.rangeRequestId) || [
    "analyze",
    "apply",
    "compile",
    "queueManualEdit",
    "undoManualEdit",
    "redoManualEdit",
    "clearManualEdits",
    "showManualEditsDiff",
    "resolveTrackedRevisions"
  ].includes(state.busyAction);
}

function manualEditUnavailableReason(allowDirectDraft = false) {
  if (state.manualEditMode === "direct" && state.hasTrackedRevisions) {
    return "请先接受全部或拒绝全部旧版修订痕迹。";
  }
  if (state.directDraft && !allowDirectDraft) {
    return "请先提交或取消当前直接编辑草稿。";
  }
  if (state.selectionTool === "region" || state.selectionLabel === "区域框选") {
    return "手动修订仅支持普通文字选区，区域框选暂不可用。";
  }
  if (!state.textSelection || !state.sessionId || !state.mappingId) {
    return "请先在 PDF 中划选并定位普通文字。";
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

  elements.manualText.disabled = baseDisabled;
  elements.manualText.placeholder = state.selectionTool === "region" || state.selectionLabel === "区域框选"
    ? "区域框选不支持手动增删改，请使用普通文字选区。"
    : state.mappingId
      ? "输入需要新增或替换的文字。"
      : "请先在 PDF 中划选普通文字。";
  elements.manualInsertBefore.disabled = baseDisabled || !hasText;
  elements.manualInsertAfter.disabled = baseDisabled || !hasText;
  elements.manualReplace.disabled = baseDisabled || !hasText;
  elements.manualDelete.disabled = baseDisabled;
  for (const button of [
    elements.manualInsertBefore,
    elements.manualInsertAfter,
    elements.manualReplace,
    elements.manualDelete
  ]) {
    button.title = reason;
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

  const pendingBlocksAi = pendingCount > 0;
  elements.compile.disabled = historyBusy || Boolean(state.directDraft);
  elements.regionSelect.disabled = historyBusy;
  elements.directEdit.disabled = historyBusy;
  elements.manualHandoff.disabled = pendingBlocksAi || historyBusy;
  elements.adjustRange.disabled = !state.mappingId || Boolean(state.rangeRequestId) || historyBusy;
  elements.apply.disabled = pendingBlocksAi || state.busyAction === "apply" || state.busyAction === "compile";
  elements.showDiff.disabled = state.busyAction === "apply" || state.busyAction === "compile";
  elements.discard.disabled = state.busyAction === "apply" || state.busyAction === "compile";
  updateClearSelectionAvailability();
  updateAnalyzeAvailability();
}

function normalizePendingEdit(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" ||
      !["insertBefore", "insertAfter", "replace", "delete"].includes(raw.kind)) {
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
    return width > 0 && height > 0 ? { x, y, width, height } : undefined;
  }).filter(Boolean);
  if (rects.length === 0) {
    return undefined;
  }
  return {
    id: raw.id,
    kind: raw.kind,
    page,
    rects,
    insertedText: typeof raw.insertedText === "string" ? raw.insertedText : ""
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
  updateManualEditAvailability();
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
  if (draft.caretVisibleOffset !== undefined) {
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
  const record = state.pageStates[draft.page - 1];
  if (record) {
    renderDirectDraft(record, true);
  }
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
  elements.analyze.textContent = `交给 ${name} 分析`;
  elements.manualHandoff.textContent = `复制任务并打开 ${name}`;
}

function setStatus(message, kind = "ready") {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
}

function updateCompileProgress(message) {
  const percent = clamp(Number(message.percent), 0, 100);
  clearTimeout(state.compileProgressHideTimer);
  state.compileProgressActive = true;
  state.compileProgressPercent = percent;
  elements.compileProgress.hidden = false;
  elements.compileProgress.dataset.kind = "active";
  elements.compileProgress.classList.toggle("is-indeterminate", Boolean(message.indeterminate));
  elements.compileProgressLabel.textContent = typeof message.message === "string" ? message.message : "正在编译";
  elements.compileProgressValue.textContent = `${Math.round(percent)}%`;
  elements.compileProgressFill.style.width = `${percent}%`;
  elements.compileProgressTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
}

function finishCompileProgress(message, kind = "success") {
  updateCompileProgress({ percent: kind === "success" ? 100 : state.compileProgressPercent, message, indeterminate: false });
  elements.compileProgress.dataset.kind = kind;
  state.compileProgressActive = false;
  if (kind === "success") {
    state.compileProgressHideTimer = setTimeout(() => {
      elements.compileProgress.hidden = true;
    }, 2_500);
  }
}

function setLoading(message) {
  elements.loading.textContent = message;
  elements.loading.hidden = false;
}

function hideLoading() {
  elements.loading.hidden = true;
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
  elements.selectionSummary.textContent = `第 ${message.page} 页 · ${state.selectionLabel} · ${message.selectionLength} 字`;
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
      ? `${message.confidenceNote ? `${message.confidenceNote} ` : ""}区域框选可用于 AI 分析，但不支持手动增删改。`
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
elements.pages.addEventListener("pointermove", moveRegionDraft);
elements.pages.addEventListener("pointerup", finishRegionDraft);
elements.pages.addEventListener("pointercancel", (event) => {
  if (state.regionDraft?.pointerId === event.pointerId) {
    cancelRegionDraft();
    setStatus("区域框选已取消。", "ready");
  }
});
function scheduleSelectionCaptureFromEvent(event) {
  if (event.target?.closest?.("input, textarea, button, .direct-edit-draft-overlay")) {
    return;
  }
  setTimeout(captureSelection, 0);
}
elements.pages.addEventListener("mouseup", scheduleSelectionCaptureFromEvent);
elements.pages.addEventListener("keyup", scheduleSelectionCaptureFromEvent);
elements.pages.addEventListener("click", handleDirectEditClick);
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
elements.directEdit.addEventListener("click", () => setDirectEditEnabled(!state.directEditEnabled));
elements.regionSelect.addEventListener("click", () => setSelectionTool(state.selectionTool === "region" ? "text" : "region"));
elements.clearSelection.addEventListener("click", () => {
  if (isWriteInteractionBusy()) return;
  clearLocalSession(true);
  setStatus("选区已清除。", "ready");
});
elements.compile.addEventListener("click", () => {
  if (isWriteInteractionBusy()) return;
  state.busyAction = "compile";
  elements.compile.disabled = true;
  updateManualEditAvailability();
  post("compile", { queueVersion: state.manualEditQueueVersion });
});
elements.instruction.addEventListener("input", updateAnalyzeAvailability);
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
  if (!state.sessionId || !state.mappingId || state.pendingManualEditCount > 0) return;
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

window.addEventListener("resize", () => {
  clearTimeout(state.resizeTimer);
  state.resizeTimer = setTimeout(() => {
    if (state.fitMode && state.document) {
      void setScale(computeFitScale(), captureScaleAnchor(), true);
    } else {
      updateVisiblePages();
    }
  }, 180);
});

function isEditableKeyboardTarget(target) {
  const element = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  return Boolean(element?.closest?.("input, textarea, [contenteditable]:not([contenteditable=\"false\"])")) ||
    Boolean(element?.isContentEditable);
}

window.addEventListener("keydown", (event) => {
  const modifier = event.ctrlKey || event.metaKey;
  if (state.directEditEnabled && modifier && !event.altKey && !isEditableKeyboardTarget(event.target)) {
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
        state.manualEditMode === "tracked"
          ? `已加入待提交修订，共 ${state.pendingManualEditCount} 项。`
          : `编辑已暂存，共 ${state.pendingManualEditCount} 项待编译。`,
        "ready"
      );
      break;
    }
    case "manualEditsState":
      updateManualEditQueueVersion(message.queueVersion);
      if (["undoManualEdit", "redoManualEdit", "clearManualEdits"].includes(state.busyAction)) {
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
      setStatus(`已撤销最近一项编辑，剩余 ${state.pendingManualEditCount} 项待编译。`, "ready");
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
        await loadPdf({ preservePosition: true });
        finishCompileProgress("编译完成，PDF 已刷新");
        updateManualEditAvailability();
        setStatus(warningCount ? `编译完成，日志中有 ${warningCount} 项警告。` : "编译完成，PDF 已刷新。", warningCount ? "warning" : "ready");
      } catch (error) {
        finishCompileProgress("PDF 刷新失败", "error");
        setStatus(error.message || String(error), "error");
      }
      break;
    }
    case "notice":
      if (["compile", "undoManualEdit", "redoManualEdit", "clearManualEdits", "showManualEditsDiff", "resolveTrackedRevisions"].includes(state.busyAction)) {
        state.busyAction = undefined;
        updateManualEditAvailability();
      }
      setStatus(message.message, "ready");
      break;
    case "error":
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
      state.analyzing = false;
      if (!message.action || message.action === state.busyAction || [
        "analyze",
        "apply",
        "compile",
        "queueManualEdit",
        "undoManualEdit",
        "redoManualEdit",
        "clearManualEdits",
        "showManualEditsDiff",
        "resolveTrackedRevisions"
      ].includes(message.action)) {
        state.busyAction = undefined;
      }
      elements.compile.disabled = false;
      elements.apply.disabled = false;
      if (message.action === "compile" || state.compileProgressActive) {
        finishCompileProgress("编译失败，请查看错误信息", "error");
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
