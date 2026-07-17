import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = process.cwd();
const pdfPath = path.resolve(root, "..", "main.pdf");
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const previewJpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=", "base64");
await mkdir(path.join(root, "artifacts"), { recursive: true });
const smokeGraphemeSegmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const smokeGraphemes = (value) => [...smokeGraphemeSegmenter.segment(value)].map(({ segment }) => segment);
const visibleTextLength = (value) => smokeGraphemes(value).reduce((count, sourceGrapheme) => {
  const normalized = sourceGrapheme.normalize("NFKC").replace(/\s/gu, "");
  return count + smokeGraphemes(normalized).filter(Boolean).length;
}, 0);
assert.equal(visibleTextLength("e\u0301"), 1, "组合字必须按 NFKC 后的可见字素计数。");
assert.equal(visibleTextLength("\u1100\u1161"), 1, "Hangul Jamo 必须按完整字素计数。");
assert.equal(visibleTextLength("✈️"), 1, "变体选择符不能拆分为独立偏移。");
assert.equal(visibleTextLength("👩‍🔬"), 1, "ZWJ 序列不能拆分为独立偏移。");
assert.equal(visibleTextLength("ﬁ"), 2, "NFKC 展开的字素必须按规范化结果重新计数。");

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/media/viewer.css"></head><body>
<header class="toolbar"><button id="previous-page" class="icon-button">‹</button><label class="page-control"><input id="page-number" type="number" min="1" value="1"><span id="page-count">/ …</span></label><button id="next-page" class="icon-button">›</button><span class="separator"></span><button id="zoom-out" class="icon-button">−</button><span id="zoom-value" class="zoom-value">125%</span><button id="zoom-in" class="icon-button">＋</button><button id="fit-width" class="toolbar-button">适合宽度</button><span class="separator"></span><button id="region-select" class="icon-button tool-toggle" aria-pressed="false"><span class="region-select-icon"></span></button><button id="clear-selection" class="icon-button" disabled>×</button><span class="toolbar-spacer"></span><button id="compile" class="toolbar-button">编译</button></header>
<main class="layout">
  <section id="viewer" class="viewer"><div id="loading" class="loading"><div class="loading-meta"><span id="loading-label">正在初始化 PDF 审阅……</span><span id="loading-value">0%</span></div><div id="loading-track" class="loading-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="loading-fill" class="loading-fill"></div></div></div><div id="pages" class="pages"></div></section>
  <section class="revision-dock">
    <div class="detail-bands">
      <details id="selection-details" class="detail-band" hidden><summary><span>PDF 选区</span><span id="selection-summary" class="detail-summary"></span></summary><div class="detail-content"><pre id="selection-text"></pre></div></details>
      <details id="source-details" class="detail-band" hidden><summary><span>源码范围</span><span id="source-summary" class="detail-summary"></span></summary><div class="detail-content"><div class="source-tools"><label>起始行<input id="start-line" type="number" min="1"></label><label>结束行<input id="end-line" type="number" min="1"></label><button id="adjust-range" class="secondary-button">更新范围</button><button id="open-source" class="secondary-button">在编辑器中打开</button><button id="confirm-range" class="primary-button" hidden>确认此范围</button></div><div id="confidence-note" class="confidence-note" hidden></div><pre id="source-text"></pre></div></details>
    </div>
    <div id="manual-edit-bar" class="manual-edit-bar">
      <input id="manual-text" type="text" maxlength="2000" disabled>
      <div class="manual-edit-actions"><button id="manual-insert-before" class="secondary-button" disabled>前插</button><button id="manual-insert-after" class="secondary-button" disabled>后插</button><button id="manual-replace" class="secondary-button" disabled>替换</button><button id="manual-delete" class="secondary-button" disabled>删除</button></div>
      <div class="manual-edit-history"><span id="pending-edit-count">0 项待提交</span><button id="manual-undo" class="icon-button" disabled>↶</button><button id="manual-clear" class="icon-button" disabled>×</button><button id="manual-accept-all" class="secondary-button" hidden>接受全部</button><button id="manual-reject-all" class="secondary-button" hidden>拒绝全部</button></div>
    </div>
    <div class="prompt-bar"><div class="task-selector-row"><label for="task-mode">任务</label><select id="task-mode"><option value="revision">局部修订</option></select><span id="task-scope-note">需要 PDF 选区</span></div><div class="analysis-row"><textarea id="instruction" maxlength="4000" disabled></textarea><button id="analyze" class="primary-button" disabled>交给 AI 助手分析</button></div><div class="prompt-actions"><button id="manual-handoff" class="secondary-button" hidden>复制任务并打开 AI 助手</button><div id="candidate-actions" class="candidate-actions" hidden><button id="show-diff" class="secondary-button">查看差异</button><button id="apply" class="primary-button">应用并保存</button><button id="discard" class="secondary-button">放弃</button></div></div></div>
    <section id="skill-progress" class="skill-progress" hidden aria-live="polite" aria-label="Skill 任务进度"><div class="skill-progress-header"><div class="skill-progress-identity"><strong id="skill-progress-name">Skill 任务</strong><span id="skill-progress-state" class="skill-progress-state" data-state="pending">等待</span></div><div class="skill-progress-meta"><span id="skill-progress-elapsed">00:00</span><span id="skill-progress-value">0%</span></div></div><div id="skill-progress-track" class="skill-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="skill-progress-fill" class="skill-progress-fill"></div></div><ol id="skill-progress-stages" class="skill-progress-stages"></ol><div id="skill-progress-message" class="skill-progress-message"></div><details id="skill-progress-details" class="skill-progress-details"><summary>详细信息</summary><div id="skill-progress-events" class="skill-progress-events"></div></details><div id="skill-quality-gates" class="skill-quality-gates" hidden><div class="skill-quality-title">质量门禁</div><div id="skill-quality-list" class="skill-quality-list"></div></div></section>
    <div id="skill-artifacts" class="skill-artifacts" hidden></div>
    <div id="compile-progress" class="compile-progress" hidden><div class="compile-progress-meta"><span id="compile-progress-label">准备编译</span><span id="compile-progress-value">0%</span></div><div id="compile-progress-track" class="compile-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="compile-progress-fill" class="compile-progress-fill"></div></div></div>
    <div class="status-line"><span id="candidate-summary" hidden></span><span id="status"></span></div>
  </section>
</main>
<script>
window.__messages=[];window.__startupPreviewEvents=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__messages.push(m),getState:()=>({pageNumber:1,fitMode:true}),setState:s=>window.__savedState=s});
new MutationObserver(()=>{const immediate=document.querySelector(".startup-preview-overlay");if(immediate&&!window.__startupPreviewShown){window.__startupPreviewShown=true;window.__startupPreviewEvents.push({type:"shown",pageShells:document.querySelectorAll(".pdf-page").length});}if(window.__startupPreviewShown&&!immediate&&!window.__startupPreviewRemoved){window.__startupPreviewRemoved=true;window.__startupPreviewEvents.push({type:"immediateRemoved"});}if(window.__startupPreviewShown&&document.querySelector(".pdf-page canvas")&&!document.querySelector(".page-refresh-snapshot")&&!window.__startupSnapshotRemoved){window.__startupSnapshotRemoved=true;window.__startupPreviewEvents.push({type:"snapshotRemoved"});}}).observe(document.documentElement,{childList:true,subtree:true});
</script>
<script id="circletex-config" type="application/json">${JSON.stringify({pdfUri:"/main.pdf",pdfJsUri:"/media/pdfjs/pdf.min.mjs",workerUri:"/media/pdfjs/pdf.worker.min.mjs",cMapUri:"/media/pdfjs/cmaps/",standardFontsUri:"/media/pdfjs/standard_fonts/",pdfFingerprint:"smoke",previewKey:"0123456789abcdef0123456789abcdef01234567",preview:{uri:"/preview.jpg",page:1,widthPt:595,heightPt:842},extensionCreatedAt:Date.now()})}</script><script type="module" src="/media/viewer.js"></script></body></html>`;

async function findVisibleTextBox(page) {
  return page.evaluate(() => {
    const viewerRect = document.getElementById("viewer").getBoundingClientRect();
    const candidates = [];
    for (const layer of document.querySelectorAll(".textLayer")) {
      const shell = layer.closest(".pdf-page");
      const shellRect = shell.getBoundingClientRect();
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.textContent.trim().length < 6) continue;
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          const relativeY = (rect.top + rect.height / 2 - shellRect.top) / shellRect.height;
          const left = Math.max(rect.left - 3, viewerRect.left + 16, shellRect.left + 2);
          const right = Math.min(rect.right + 3, viewerRect.right - 16, shellRect.right - 2);
          const top = Math.max(rect.top - 3, viewerRect.top + 8, shellRect.top + 2);
          const bottom = Math.min(rect.bottom + 3, viewerRect.bottom - 8, shellRect.bottom - 2);
          if (right - left > 45 && bottom - top > 10 && bottom - top < 45 && relativeY > 0.15 && relativeY < 0.88) {
            candidates.push({ left, right, top, bottom, page: Number(shell.dataset.pageNumber), text: node.textContent });
          }
        }
      }
    }
    candidates
      .sort((left, right) => Math.abs((left.top + left.bottom) / 2 - (viewerRect.top + viewerRect.bottom) / 2) -
        Math.abs((right.top + right.bottom) / 2 - (viewerRect.top + viewerRect.bottom) / 2));
    if (candidates.length === 0) {
      const layers = [...document.querySelectorAll(".textLayer")].map((layer) => ({
        page: layer.closest(".pdf-page")?.dataset.pageNumber,
        textLength: layer.textContent.length,
        childCount: layer.childElementCount,
        visible: Boolean(layer.getClientRects().length)
      }));
      throw new Error(`没有找到可用于区域框选的可见文字行：${JSON.stringify({
        layers,
        snapshots: document.querySelectorAll(".page-refresh-snapshot").length,
        canvases: document.querySelectorAll(".pdf-page canvas").length,
        loading: document.getElementById("loading").hidden,
        status: document.getElementById("status").textContent
      })}`);
    }
    return candidates[0];
  });
}

async function dragRegion(page, box) {
  await page.mouse.move(box.left, box.top);
  await page.mouse.down();
  await page.mouse.move((box.left + box.right) / 2, (box.top + box.bottom) / 2, { steps: 3 });
  assert.equal(await page.locator(".region-selection-draft").count(), 1);
  await page.mouse.move(box.right, box.bottom, { steps: 4 });
  await page.mouse.up();
}

async function selectVisibleTextForDirectEdit(page, length = 6) {
  const before = await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length);
  await page.evaluate((wantedLength) => {
    const viewerRect = document.getElementById("viewer").getBoundingClientRect();
    for (const layer of document.querySelectorAll(".textLayer")) {
      const layerRect = layer.getBoundingClientRect();
      if (layerRect.right <= viewerRect.left || layerRect.left >= viewerRect.right ||
          layerRect.bottom <= viewerRect.top || layerRect.top >= viewerRect.bottom) continue;
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const first = node.textContent.search(/\S/u);
        if (first < 0 || node.textContent.length - first < 2) continue;
        const range = document.createRange();
        range.setStart(node, first);
        range.setEnd(node, Math.min(node.textContent.length, first + wantedLength));
        if (![...range.getClientRects()].some((rect) => rect.width > 2 && rect.height > 2)) continue;
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.getElementById("pages").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
    }
    throw new Error("没有找到可用于直接编辑的可见文字。 ");
  }, length);
  await page.waitForFunction((count) => window.__messages.filter((message) => message.type === "selection").length > count, before);
  return page.evaluate(() => window.__messages.findLast((message) => message.type === "selection"));
}

async function selectAcrossRenderedPages(page) {
  const before = await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length);
  const pages = await page.evaluate(() => {
    const records = [...document.querySelectorAll(".pdf-page")];
    const textNodes = (layer, order) => {
      const shellRect = layer.closest(".pdf-page").getBoundingClientRect();
      const values = [];
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const first = node.textContent.search(/\S/u);
        if (first < 0) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        const center = (rect.top + rect.height / 2 - shellRect.top) / Math.max(1, shellRect.height);
        if (rect.width > 2 && rect.height > 2 && center >= 0.12 && center <= 0.88) {
          values.push({ node, first });
        }
      }
      return order === "last" ? values.at(-1) : values[0];
    };
    for (let index = 0; index < records.length - 1; index += 1) {
      const firstLayer = records[index].querySelector(".textLayer");
      const secondLayer = records[index + 1].querySelector(".textLayer");
      if (!firstLayer || !secondLayer) continue;
      const start = textNodes(firstLayer, "last");
      const end = textNodes(secondLayer, "first");
      if (!start || !end) continue;
      const range = document.createRange();
      range.setStart(start.node, start.first);
      range.setEnd(end.node, Math.min(end.node.textContent.length, end.first + 6));
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.getElementById("pages").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return [Number(records[index].dataset.pageNumber), Number(records[index + 1].dataset.pageNumber)];
    }
    throw new Error("没有找到两个已渲染的相邻页面用于跨页选区烟测。");
  });
  await page.waitForFunction((count) => window.__messages.filter((message) => message.type === "selection").length > count, before);
  return {
    pages,
    selection: await page.evaluate(() => window.__messages.findLast((message) => message.type === "selection"))
  };
}

async function clickVisibleTextForDirectEdit(page) {
  const before = await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length);
  const point = await page.evaluate(() => {
    const viewerRect = document.getElementById("viewer").getBoundingClientRect();
    for (const layer of document.querySelectorAll(".textLayer")) {
      const layerRect = layer.getBoundingClientRect();
      if (layerRect.right <= viewerRect.left || layerRect.left >= viewerRect.right ||
          layerRect.bottom <= viewerRect.top || layerRect.top >= viewerRect.bottom) continue;
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const first = node.textContent.search(/\S/u);
        if (first < 0 || node.textContent.length - first < 4) continue;
        const offset = Math.min(node.textContent.length - 1, first + 2);
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect();
        if (rect.width > 2 && rect.height > 2 && rect.left >= viewerRect.left && rect.right <= viewerRect.right &&
            rect.top >= viewerRect.top && rect.bottom <= viewerRect.bottom) {
          return { x: rect.left + rect.width * 0.45, y: rect.top + rect.height / 2 };
        }
      }
    }
    throw new Error("没有找到可用于光标编辑的可见文字。 ");
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction((count) => window.__messages.filter((message) => message.type === "selection").length > count, before);
  return page.evaluate(() => window.__messages.findLast((message) => message.type === "selection"));
}

async function clickVisualLineStart(page) {
  const before = await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length);
  const geometry = await page.evaluate(() => {
    const viewerRect = document.getElementById("viewer").getBoundingClientRect();
    for (const layer of document.querySelectorAll(".textLayer")) {
      const layerRect = layer.getBoundingClientRect();
      if (layerRect.bottom <= viewerRect.top || layerRect.top >= viewerRect.bottom) continue;
      let previous;
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const first = node.textContent.search(/\S/u);
        if (first < 0) continue;
        const last = Math.max(first, node.textContent.search(/\s*$/u) - 1);
        const firstRange = document.createRange();
        firstRange.setStart(node, first);
        firstRange.setEnd(node, first + 1);
        const lastRange = document.createRange();
        lastRange.setStart(node, last);
        lastRange.setEnd(node, last + 1);
        const currentRect = firstRange.getBoundingClientRect();
        const lastRect = lastRange.getBoundingClientRect();
        const currentVisible = currentRect.width > 1 && currentRect.height > 1 &&
          currentRect.left >= viewerRect.left && currentRect.right <= viewerRect.right &&
          currentRect.top >= viewerRect.top && currentRect.bottom <= viewerRect.bottom;
        if (previous && currentVisible && currentRect.top > previous.rect.top + Math.min(previous.rect.height, currentRect.height) * 0.65) {
          return {
            x: currentRect.left + Math.min(1, currentRect.width * 0.08),
            y: currentRect.top + currentRect.height / 2,
            previousY: previous.rect.top + previous.rect.height / 2,
            currentY: currentRect.top + currentRect.height / 2
          };
        }
        if (lastRect.width > 1 && lastRect.height > 1) {
          previous = { rect: lastRect };
        }
      }
    }
    throw new Error("没有找到可用于行首光标烟测的相邻视觉行。");
  });
  await page.mouse.click(geometry.x, geometry.y);
  await page.waitForFunction((count) => window.__messages.filter((message) => message.type === "selection").length > count, before);
  return geometry;
}

async function mapSmokeSelection(page, selection, suffix, requiresConfirmation = false) {
  await page.evaluate(({ selection, suffix, requiresConfirmation }) => {
    const sessionId = `session_direct_${suffix}`;
    const mappingId = `mapping_direct_${suffix}`;
    window.dispatchEvent(new MessageEvent("message", { data: {
      type: "busy",
      action: "mapping",
      requestId: selection.requestId,
      sessionId,
      message: "正在定位直接编辑位置"
    } }));
    window.dispatchEvent(new MessageEvent("message", { data: {
      type: "mapping",
      requestId: selection.requestId,
      sessionId,
      mappingId,
      selectionKind: selection.selectionKind,
      interactionMode: selection.interactionMode,
      interactionVersion: selection.interactionVersion,
      page: selection.page,
      endPage: selection.pageFragments?.at(-1)?.page ?? selection.page,
      selectionLength: selection.text.length,
      startLine: 300,
      endLine: 302,
      requiresConfirmation,
      confidenceNote: requiresConfirmation ? "需要核对" : ""
    } }));
  }, { selection, suffix, requiresConfirmation });
  await page.waitForFunction((mappingId) => document.getElementById("source-summary").textContent.includes("300") &&
    window.__messages.some((message) => message.type === "selection") && mappingId.length > 0, `mapping_direct_${suffix}`);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    let file;
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (url.pathname === "/main.pdf") {
      file = pdfPath;
    } else if (url.pathname === "/preview.jpg") {
      response.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
      response.end(previewJpeg);
      return;
    } else if (url.pathname.startsWith("/media/")) {
      file = path.join(root, url.pathname.slice(1));
      if (!path.resolve(file).startsWith(path.join(root, "media"))) {
        throw new Error("资源路径越界。");
      }
    } else {
      response.writeHead(404).end();
      return;
    }
    const extension = path.extname(file);
    const contentType = extension === ".mjs" || extension === ".js" ? "text/javascript" :
      extension === ".css" ? "text/css" : extension === ".pdf" ? "application/pdf" : "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    response.end(await readFile(file));
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error.message);
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const browser = await chromium.launch({ executablePath: edgePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    const total = Number(document.getElementById("page-count")?.textContent?.match(/\d+/)?.[0]);
    return total >= 2 && document.querySelectorAll(".pdf-page").length === total;
  });
  assert.ok(Number(await page.locator("#loading-track").getAttribute("aria-valuenow")) >= 75);
  await page.waitForFunction(() => document.querySelectorAll(".pdf-page canvas").length >= 1);
  await page.waitForFunction(() => document.querySelector('.pdf-page[data-render-stage="text"]'));
  await page.waitForFunction(() => window.__startupPreviewEvents.some((event) => event.type === "snapshotRemoved"));
  const startupPreviewEvents = await page.evaluate(() => window.__startupPreviewEvents);
  assert.deepEqual(startupPreviewEvents.map((event) => event.type), ["shown", "immediateRemoved", "snapshotRemoved"]);
  assert.equal(startupPreviewEvents[0].pageShells, 0, "缓存预览必须先于 PDF 页面壳体显示。");
  assert.equal(await page.locator(".startup-preview-overlay, .page-refresh-snapshot").count(), 0, "高清 Canvas 完成后必须移除缓存预览。");
  await page.waitForFunction(() => window.__messages.some((message) =>
    message.type === "cachePdfPreview" &&
    typeof message.dataUrl === "string" &&
    message.dataUrl.startsWith("data:image/jpeg;base64,") &&
    message.dataUrl.length < 1_500_000
  ));
  const totalPages = await page.locator(".pdf-page").count();
  assert.ok(totalPages >= 2);
  assert.ok((await page.locator(".pdf-page canvas").count()) <= 5);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
    data: { type: "assistantChanged", assistantName: "Snow CLI" }
  })));
  assert.equal(await page.locator("#analyze").textContent(), "交给 Snow CLI 分析");
  assert.equal(await page.locator("#manual-handoff").textContent(), "复制任务并打开 Snow CLI");
  assert.equal(await page.locator("#interaction-mode").count(), 1);
  assert.equal(await page.locator("#mode-agent").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#mode-direct").getAttribute("aria-pressed"), "false");
  assert.equal(await page.locator("#direct-edit").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#region-select").getAttribute("aria-pressed"), "false");
  await page.locator("#direct-edit").click();
  assert.equal(await page.locator("#direct-edit").getAttribute("aria-pressed"), "false");
  assert.equal(await page.locator("#region-select").getAttribute("aria-pressed"), "false");
  const disabledToolSelectionCount = await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length);
  await page.evaluate(() => {
    const node = [...document.querySelectorAll(".textLayer")].flatMap((layer) => {
      const values = [];
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) values.push(walker.currentNode);
      return values;
    }).find((item) => item.textContent.trim().length >= 4);
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(4, node.textContent.length));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.getElementById("pages").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.waitForTimeout(40);
  assert.equal(await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length), disabledToolSelectionCount);
  assert.ok((await page.evaluate(() => getSelection().toString())).length > 0, "工具关闭后应保留原生文字复制选择。");
  await page.locator("#direct-edit").click();
  assert.equal(await page.locator("#direct-edit").getAttribute("aria-pressed"), "true");
  await page.locator("#region-select").click();
  assert.equal(await page.locator("#region-select").getAttribute("aria-pressed"), "true");
  await page.locator("#region-select").click();
  assert.equal(await page.locator("#region-select").getAttribute("aria-pressed"), "false");
  assert.equal(await page.locator("#direct-edit").getAttribute("aria-pressed"), "false");
  await page.locator("#direct-edit").click();
  assert.equal(await page.locator(".prompt-bar").isHidden(), false);
  assert.equal(await page.locator("#manual-edit-bar").isHidden(), true);
  const desktopAnalysisLayout = await page.locator(".analysis-row").evaluate((row) => {
    const input = row.querySelector("#instruction").getBoundingClientRect();
    const button = row.querySelector("#analyze").getBoundingClientRect();
    return {
      inputRight: input.right,
      inputTop: input.top,
      inputBottom: input.bottom,
      buttonLeft: button.left,
      buttonTop: button.top
    };
  });
  assert.ok(desktopAnalysisLayout.buttonLeft > desktopAnalysisLayout.inputRight);
  assert.ok(
    desktopAnalysisLayout.buttonTop >= desktopAnalysisLayout.inputTop - 1 &&
    desktopAnalysisLayout.buttonTop < desktopAnalysisLayout.inputBottom
  );
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: "skillsChanged",
      skills: [{ id: "tex-to-mathtype-word", name: "无底稿 MathType Word 导出", scope: "document", taskType: "artifact" }]
    }
  })));
  await page.locator("#task-mode").selectOption("skill:tex-to-mathtype-word");
  await page.locator("#instruction").fill("生成论文导出产物");
  assert.equal(await page.locator("#task-scope-note").textContent(), "整篇论文");
  assert.equal(await page.locator("#analyze").textContent(), "交给 Snow CLI 执行");
  assert.equal(await page.locator("#analyze").isEnabled(), true);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "skillTaskStarted",
    skillId: "tex-to-mathtype-word",
    skillName: "无底稿 MathType Word 导出",
    message: "正在准备 Word 导出任务"
  } })));
  assert.equal(await page.locator("#skill-progress").isHidden(), false);
  assert.equal(await page.locator("#skill-progress-name").textContent(), "无底稿 MathType Word 导出");
  assert.equal(await page.locator("#skill-progress-state").textContent(), "运行");
  assert.equal(await page.locator("#skill-progress-stages > li").count(), 8);
  assert.ok(await page.locator('#skill-progress-stages > li[data-state="pending"]').count() > 0);
  assert.equal(await page.locator("#compile-progress").isHidden(), true);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "skillTaskProgress",
    stage: "running",
    percent: 24,
    message: "正在执行旧格式 Skill 进度",
    indeterminate: true
  } })));
  assert.equal(await page.locator("#skill-progress-value").textContent(), "24%");
  assert.equal(await page.locator("#skill-progress").evaluate((element) => element.classList.contains("is-indeterminate")), true);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "skillTaskProgress",
    stage: "running",
    percent: 42,
    message: "正在解析论文公式",
    detail: { id: "parse-formulas", label: "解析公式", state: "running", current: 138, total: 278, unit: "个不同公式" }
  } })));
  assert.equal(await page.locator('#skill-progress-stages > li[data-state="running"] .skill-stage-count').textContent(), "138/278 个不同公式");
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "skillTaskFailed",
    message: "测试 Skill 失败"
  } })));
  assert.equal(await page.locator("#skill-progress").getAttribute("data-state"), "failed");
  assert.equal(await page.locator("#skill-progress-message").textContent(), "测试 Skill 失败");
  assert.equal(await page.locator("#skill-progress").isHidden(), false);
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data: {
      type: "skillTaskStarted",
      skillId: "tex-to-mathtype-word",
      skillName: "无底稿 MathType Word 导出",
      message: "正在重新执行 Word 导出任务"
    } }));
    window.dispatchEvent(new MessageEvent("message", { data: {
      type: "skillTaskProgress",
      stage: "running",
      percent: 68,
      message: "正在回填 MathType 可编辑对象",
      detail: { id: "assemble-formulas", label: "装配公式", state: "running", current: 325, total: 477, unit: "个公式位置" }
    } }));
    window.dispatchEvent(new MessageEvent("message", { data: {
      type: "skillTaskCompleted",
      summary: "Word 导出完成",
      warnings: [],
      artifacts: [],
      qualityGates: [
        { id: "mathtype-objects", label: "MathType 对象", status: "passed", value: "477/477" },
        { id: "omml", label: "OMML", status: "passed", value: "0" },
        { id: "placeholders", label: "残留占位符", status: "passed", value: "0" },
        { id: "fallbacks", label: "公式降级", status: "passed", value: "0" },
        { id: "reopen", label: "Word 重开校验", status: "passed", value: "通过" }
      ]
    } }));
  });
  assert.equal(await page.locator("#skill-progress-value").textContent(), "100%");
  assert.equal(await page.locator("#skill-progress-state").textContent(), "完成");
  assert.equal(await page.locator('#skill-progress-stages > li[data-state="completed"]').count(), 8);
  assert.equal(await page.locator("#skill-quality-list .skill-quality-item").count(), 5);
  assert.equal(await page.locator("#skill-quality-gates").isHidden(), false);
  await page.locator("#skill-progress-details > summary").click();
  assert.ok(await page.locator("#skill-progress-events .skill-progress-event").count() >= 2);
  await page.locator("#skill-progress-details > summary").click();
  await page.locator("#instruction").fill("");
  await page.locator("#task-mode").selectOption("revision");
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "manualEditsState", edits: [], count: 0, queueVersion: 7 } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "trackedRevisionsState", hasTrackedRevisions: false } }));
  });
  assert.equal(await page.locator("#pending-edit-count").textContent(), "0 项待编译");
  assert.equal(await page.locator("#manual-accept-all").isHidden(), true);

  const zoomBeforeScroll = await page.locator("#zoom-value").textContent();
  const scrollBefore = await page.locator("#viewer").evaluate((viewer) => viewer.scrollTop);
  await page.locator("#viewer").hover({ position: { x: 640, y: 300 } });
  await page.mouse.wheel(0, 2_200);
  await page.waitForFunction((before) => document.getElementById("viewer").scrollTop > before + 500, scrollBefore);
  assert.equal(await page.locator("#zoom-value").textContent(), zoomBeforeScroll);
  assert.ok(Number(await page.locator("#page-number").inputValue()) > 1);
  assert.ok((await page.locator(".pdf-page canvas").count()) <= 5);

  await page.waitForFunction(() => {
    const viewerRect = document.getElementById("viewer").getBoundingClientRect();
    return [...document.querySelectorAll(".textLayer")].some((layer) => {
      const rect = layer.getBoundingClientRect();
      const pageElement = layer.closest(".pdf-page");
      return rect.right > viewerRect.left && rect.left < viewerRect.right &&
        rect.bottom > viewerRect.top && rect.top < viewerRect.bottom &&
        pageElement.querySelector(".page-placeholder").hidden &&
        layer.querySelectorAll("span").length > 3;
    });
  }, undefined, { timeout: 15_000 });

  const crossPageAgent = await selectAcrossRenderedPages(page);
  assert.equal(crossPageAgent.selection.selectionKind, "text");
  assert.deepEqual(crossPageAgent.selection.pageFragments.map((fragment) => fragment.page), crossPageAgent.pages);
  assert.equal(crossPageAgent.selection.page, crossPageAgent.pages[0]);
  assert.equal(crossPageAgent.selection.end.page, undefined);
  assert.ok(crossPageAgent.selection.pageFragments.every((fragment) => fragment.text.trim().length > 0));
  assert.ok((await page.locator("#selection-summary").textContent()).includes("跨页文字选区"));
  await page.locator("#clear-selection").click();

  await page.evaluate(() => {
    const viewerRect = document.getElementById("viewer").getBoundingClientRect();
    const layer = [...document.querySelectorAll(".textLayer")].find((item) => {
      const rect = item.getBoundingClientRect();
      return rect.right > viewerRect.left && rect.left < viewerRect.right &&
        rect.bottom > viewerRect.top && rect.top < viewerRect.bottom &&
        item.closest(".pdf-page").querySelector(".page-placeholder").hidden &&
        item.querySelectorAll("span").length > 3;
    });
    const textNodes = [];
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.textContent.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    while (textNodes.length < 4 && walker.nextNode()) textNodes.push(walker.currentNode);
    if (textNodes.length < 2) throw new Error("可见文字层没有足够的文本节点。");
    const range = document.createRange();
    range.setStart(textNodes[0], 0);
    const endNode = textNodes.at(-1);
    range.setEnd(endNode, endNode.textContent.length);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.getElementById("pages").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.waitForFunction(() => window.__messages.some((message) => message.type === "selection"));
  const selectionMessage = await page.evaluate(() => window.__messages.findLast((message) => message.type === "selection"));
  assert.ok(selectionMessage.text.length > 0);
  assert.ok(selectionMessage.page > 1);
  assert.equal(typeof selectionMessage.contextBefore, "string");
  assert.equal(typeof selectionMessage.contextAfter, "string");
  assert.ok(selectionMessage.contextBefore.length <= 256 && selectionMessage.contextAfter.length <= 256);
  assert.ok(selectionMessage.contextBefore.length + selectionMessage.contextAfter.length > 0);

  await page.evaluate(({ requestId, pageNumber }) => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "busy", action: "mapping", requestId, sessionId: "session_test", message: "定位中" } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "mapping", requestId, sessionId: "session_test", mappingId: "mapping_test", page: pageNumber, selectionLength: 12, startLine: 100, endLine: 102, requiresConfirmation: true, confidenceNote: "需要核对" } }));
  }, { requestId: selectionMessage.requestId, pageNumber: selectionMessage.page });
  assert.equal(await page.locator("#selection-details").evaluate((node) => node.open), false);
  assert.equal(await page.locator("#source-details").evaluate((node) => node.open), false);
  assert.equal(await page.evaluate(() => window.__messages.some((message) => message.type === "requestSelectionDetail" || message.type === "requestSourceDetail")), false);
  await page.locator("#instruction").fill("压缩表述并保留引用。");
  assert.equal(await page.locator("#analyze").isDisabled(), true);

  await page.locator("#selection-details summary").click();
  await page.waitForFunction(() => window.__messages.some((message) => message.type === "requestSelectionDetail"));
  const selectionDetailRequest = await page.evaluate(() => window.__messages.findLast((message) => message.type === "requestSelectionDetail"));
  await page.evaluate((request) => window.dispatchEvent(new MessageEvent("message", { data: { ...request, type: "selectionDetail", text: "仅在展开时显示的选区文字" } })), selectionDetailRequest);
  assert.equal(await page.locator("#selection-text").textContent(), "仅在展开时显示的选区文字");
  await page.locator("#selection-details summary").click();
  await page.waitForFunction(() => document.getElementById("selection-text").textContent === "");
  assert.equal(await page.locator("#selection-text").textContent(), "");
  await page.evaluate((request) => window.dispatchEvent(new MessageEvent("message", { data: { ...request, type: "selectionDetail", text: "不应显示的迟到选区文字" } })), selectionDetailRequest);
  await page.waitForTimeout(30);
  assert.equal(await page.locator("#selection-text").textContent(), "");

  await page.locator("#source-details summary").click();
  await page.waitForFunction(() => window.__messages.some((message) => message.type === "requestSourceDetail"));
  const sourceRequest = await page.evaluate(() => window.__messages.findLast((message) => message.type === "requestSourceDetail"));
  await page.evaluate((request) => window.dispatchEvent(new MessageEvent("message", { data: { ...request, type: "sourceDetail", startLine: 100, endLine: 102, sourceText: "后端按需返回的源码", requiresConfirmation: true, confidenceNote: "需要核对" } })), sourceRequest);
  assert.equal(await page.locator("#source-text").textContent(), "后端按需返回的源码");
  await page.locator("#confirm-range").click();
  await page.waitForFunction(() => window.__messages.some((message) => message.type === "confirmRange"));
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "rangeConfirmed", sessionId: "session_test", mappingId: "mapping_test" } })));
  assert.equal(await page.locator("#analyze").isDisabled(), false);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "busy", action: "analyze", sessionId: "session_old", mappingId: "mapping_old", message: "过期分析" } })));
  assert.equal(await page.locator("#analyze").isDisabled(), false);
  await page.locator("#mode-direct").click();
  assert.equal(await page.locator("#mode-direct").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#direct-edit").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".prompt-bar").isHidden(), true);
  assert.equal(await page.locator("#manual-edit-bar").isHidden(), false);
  assert.equal(await page.locator("#manual-text").isDisabled(), false);

  await page.locator("#manual-text").fill("竞态恢复检查");
  await page.locator("#manual-insert-before").click();
  const failedQueue = await page.evaluate(() => window.__messages.findLast((message) => message.type === "queueManualEdit"));
  assert.equal(await page.locator("#compile").isDisabled(), true);
  assert.equal(await page.locator("#region-select").isDisabled(), true);
  await page.evaluate((requestId) => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "error",
    action: "queueManualEdit",
    requestId,
    sessionId: "session_old",
    message: "旧会话请求已取消"
  } })), failedQueue.requestId);
  await page.waitForFunction(() => !document.getElementById("compile").disabled);
  assert.equal(await page.locator("#manual-insert-before").isDisabled(), false);
  assert.equal(await page.locator("#region-select").isDisabled(), false);

  const manualCases = [
    { kind: "insertBefore", button: "#manual-insert-before", text: "前插文字", id: "manual_before" },
    { kind: "insertAfter", button: "#manual-insert-after", text: "后插文字", id: "manual_after" },
    { kind: "replace", button: "#manual-replace", text: "替换文字", id: "manual_replace" },
    { kind: "delete", button: "#manual-delete", text: "", id: "manual_delete" }
  ];
  let manualQueueVersion = 7;
  const queuedEdits = [];
  for (const [index, item] of manualCases.entries()) {
    if (item.text) await page.locator("#manual-text").fill(item.text);
    const messageCount = await page.evaluate(() => window.__messages.filter((message) => message.type === "queueManualEdit").length);
    await page.locator(item.button).click();
    await page.waitForFunction((count) => window.__messages.filter((message) => message.type === "queueManualEdit").length > count, messageCount);
    const queued = await page.evaluate(() => window.__messages.findLast((message) => message.type === "queueManualEdit"));
    assert.equal(queued.kind, item.kind);
    assert.equal(queued.text, item.text);
    assert.equal(queued.sessionId, "session_test");
    assert.equal(queued.mappingId, "mapping_test");
    assert.equal(queued.queueVersion, manualQueueVersion);
    assert.ok(queued.rects.length >= 1 && queued.rects.length <= 64);
    assert.ok(queued.rects.every((rect) => rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 &&
      rect.x + rect.width <= 1.000001 && rect.y + rect.height <= 1.000001));
    const edit = {
      id: item.id,
      kind: item.kind,
      page: selectionMessage.page,
      rects: queued.rects,
      insertedText: item.text
    };
    queuedEdits.push(edit);
    manualQueueVersion += 1;
    await page.evaluate(({ queued, edit, edits, queueVersion, count }) => {
      window.dispatchEvent(new MessageEvent("message", { data: {
        type: "manualEditQueued",
        requestId: queued.requestId,
        edit,
        edits,
        count,
        queueVersion
      } }));
    }, { queued, edit, edits: queuedEdits, queueVersion: manualQueueVersion, count: index + 1 });
    await page.waitForFunction((count) => document.getElementById("pending-edit-count").textContent.includes(String(count)), index + 1);
  }
  assert.equal(await page.locator("#compile").textContent(), "应用 4 项并编译");
  assert.equal(await page.locator("#analyze").isDisabled(), true);
  assert.equal(await page.locator("#adjust-range").isDisabled(), false);
  assert.equal(await page.locator(".manual-edit-overlay").count(), 1);
  assert.equal(await page.locator(".manual-edit-insertion").count(), 3);
  assert.equal(await page.locator(".manual-edit-insertion-marker").count(), 3);
  assert.equal(await page.locator(".manual-edit-insertion-lead").count(), 3);
  assert.ok((await page.locator(".manual-edit-deletion").count()) >= 2);
  assert.ok((await page.locator(".manual-edit-insertion").allTextContents()).includes("替换文字"));
  const strikeColor = await page.locator(".manual-edit-deletion").first().evaluate((element) =>
    getComputedStyle(element, "::after").backgroundColor
  );
  assert.ok(strikeColor.includes("209") && strikeColor.includes("36"), "删除中划线没有使用红色。 ");
  await page.locator(".manual-edit-deletion").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, "artifacts", "viewer-manual-edits-smoke.png"), fullPage: false });

  await page.locator("#manual-undo").click();
  await page.waitForFunction(() => window.__messages.some((message) => message.type === "undoManualEdit"));
  const undoMessage = await page.evaluate(() => window.__messages.findLast((message) => message.type === "undoManualEdit"));
  assert.equal(undoMessage.queueVersion, manualQueueVersion);
  manualQueueVersion += 1;
  queuedEdits.pop();
  await page.evaluate(({ edits, queueVersion }) => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "manualEditRemoved",
    editId: "manual_delete",
    edits,
    count: edits.length,
    queueVersion
  } })), { edits: queuedEdits, queueVersion: manualQueueVersion });
  await page.waitForFunction(() => document.getElementById("compile").textContent === "应用 3 项并编译");

  const compileMessageCount = await page.evaluate(() => window.__messages.filter((message) => message.type === "compile").length);
  await page.locator("#compile").click();
  await page.waitForFunction((count) => window.__messages.filter((message) => message.type === "compile").length > count, compileMessageCount);
  const pendingCompile = await page.evaluate(() => window.__messages.findLast((message) => message.type === "compile"));
  assert.equal(pendingCompile.queueVersion, manualQueueVersion);
  assert.equal(await page.locator("#compile").isDisabled(), true);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "notice",
    message: "已取消写入，待提交手动修订仍保留。"
  } })));
  await page.waitForFunction(() => !document.getElementById("compile").disabled);
  assert.equal(await page.locator("#compile").textContent(), "应用 3 项并编译");

  const manualOverlayBeforeZoom = await page.locator(".manual-edit-deletion").first().evaluate((element) => {
    const shell = element.closest(".pdf-page").getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
      page: Number(element.closest(".pdf-page").dataset.pageNumber),
      x: (rect.left - shell.left) / shell.width,
      y: (rect.top - shell.top) / shell.height,
      width: rect.width / shell.width,
      height: rect.height / shell.height
    };
  });
  const zoomBefore = await page.locator("#zoom-value").textContent();
  const zoomAnchorBefore = await page.evaluate(() => {
    const x = 500;
    const y = 350;
    const shell = document.elementFromPoint(x, y).closest(".pdf-page");
    const rect = shell.getBoundingClientRect();
    return { page: Number(shell.dataset.pageNumber), xRatio: (x - rect.left) / rect.width, yRatio: (y - rect.top) / rect.height };
  });
  await page.locator("#viewer").dispatchEvent("wheel", { ctrlKey: true, deltaY: -100, clientX: 500, clientY: 350 });
  await page.waitForFunction((before) => document.getElementById("zoom-value").textContent !== before, zoomBefore);
  await page.waitForFunction(() => {
    const viewerRect = document.getElementById("viewer").getBoundingClientRect();
    return [...document.querySelectorAll(".pdf-page")].some((pdfPage) => {
      const rect = pdfPage.getBoundingClientRect();
      const visible = rect.right > viewerRect.left && rect.left < viewerRect.right &&
        rect.bottom > viewerRect.top && rect.top < viewerRect.bottom;
      return visible && pdfPage.querySelector("canvas") && pdfPage.querySelector(".page-placeholder").hidden;
    });
  }, undefined, { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll(".pdf-page canvas").length <= 3);
  assert.ok((await page.locator(".pdf-page canvas").count()) <= 3);
  const manualOverlayAfterZoom = await page.locator(".manual-edit-deletion").first().evaluate((element) => {
    const shell = element.closest(".pdf-page").getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
      page: Number(element.closest(".pdf-page").dataset.pageNumber),
      x: (rect.left - shell.left) / shell.width,
      y: (rect.top - shell.top) / shell.height,
      width: rect.width / shell.width,
      height: rect.height / shell.height
    };
  });
  assert.equal(manualOverlayAfterZoom.page, manualOverlayBeforeZoom.page);
  for (const key of ["x", "y", "width", "height"]) {
    assert.ok(Math.abs(manualOverlayAfterZoom[key] - manualOverlayBeforeZoom[key]) < 0.003);
  }
  const zoomAnchorAfter = await page.evaluate(() => {
    const x = 500;
    const y = 350;
    const shell = document.elementFromPoint(x, y).closest(".pdf-page");
    const rect = shell.getBoundingClientRect();
    return { page: Number(shell.dataset.pageNumber), xRatio: (x - rect.left) / rect.width, yRatio: (y - rect.top) / rect.height };
  });
  assert.equal(zoomAnchorAfter.page, zoomAnchorBefore.page);
  assert.ok(Math.abs(zoomAnchorAfter.xRatio - zoomAnchorBefore.xRatio) < 0.03);
  assert.ok(Math.abs(zoomAnchorAfter.yRatio - zoomAnchorBefore.yRatio) < 0.03);

  const pixels = await page.evaluate(() => {
    const viewerRect = document.getElementById("viewer").getBoundingClientRect();
    const pdfPage = [...document.querySelectorAll(".pdf-page")].find((item) => {
      const rect = item.getBoundingClientRect();
      return rect.right > viewerRect.left && rect.left < viewerRect.right &&
        rect.bottom > viewerRect.top && rect.top < viewerRect.bottom &&
        item.querySelector("canvas") && item.querySelector(".page-placeholder").hidden;
    });
    const canvas = pdfPage.querySelector("canvas");
    const context = canvas.getContext("2d");
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    let light = 0;
    let dark = 0;
    for (let y = 0; y < canvas.height; y += 7) {
      for (let x = 0; x < canvas.width; x += 7) {
        const offset = (y * canvas.width + x) * 4;
        const brightness = image.data[offset] + image.data[offset + 1] + image.data[offset + 2];
        if (brightness > 735) light += 1;
        if (brightness < 690) dark += 1;
      }
    }
    return { light, dark };
  });
  assert.ok(pixels.light > 0, "可见 PDF 页面缺少纸张亮色像素。");
  assert.ok(pixels.dark > 0, "可见 PDF 页面缺少正文暗色像素。");

  await page.locator("#mode-agent").click();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "candidate", sessionId: "session_test", mappingId: "mapping_test", candidateId: "candidate_test", summary: "已生成局部建议" } })));
  assert.equal(await page.locator("#candidate-actions").isHidden(), false);
  assert.equal((await page.locator("body").textContent()).includes("replacement"), false);
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "candidateCleared", sessionId: "session_old", mappingId: "mapping_old", candidateId: "candidate_test" } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "sessionCleared", sessionId: "session_old", mappingId: "mapping_old" } }));
  });
  assert.equal(await page.locator("#candidate-actions").isHidden(), false);
  assert.equal(await page.locator("#selection-details").isHidden(), false);
  await page.locator("#source-details summary").click();
  await page.waitForFunction(() => document.getElementById("source-text").textContent === "");
  await page.evaluate((request) => window.dispatchEvent(new MessageEvent("message", { data: { ...request, type: "sourceDetail", sourceText: "不应显示的迟到源码" } })), sourceRequest);
  await page.waitForTimeout(30);
  assert.equal(await page.locator("#source-text").textContent(), "");

  const reloadAnchorBefore = await page.evaluate(() => {
    const viewer = document.getElementById("viewer");
    const viewerRect = viewer.getBoundingClientRect();
    const x = viewerRect.left + viewerRect.width / 2;
    const y = viewerRect.top + viewerRect.height / 2;
    const shell = document.elementFromPoint(x, y).closest(".pdf-page");
    const rect = shell.getBoundingClientRect();
    window.__oldFirstPage = document.querySelector(".pdf-page");
    return { page: Number(shell.dataset.pageNumber), xRatio: (x - rect.left) / rect.width, yRatio: (y - rect.top) / rect.height };
  });
  await page.locator("#compile").click();
  await page.waitForFunction(() => window.__messages.some((message) => message.type === "compile"));
  const compileMessage = await page.evaluate(() => window.__messages.findLast((message) => message.type === "compile"));
  assert.equal(compileMessage.queueVersion, manualQueueVersion);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "compileProgress",
    percent: 15,
    message: "正在执行第 1 遍 XeLaTeX",
    indeterminate: true
  } })));
  assert.equal(await page.locator("#compile-progress").isHidden(), false);
  assert.equal(await page.locator("#compile-progress-value").textContent(), "15%");
  assert.equal(await page.locator("#compile-progress-label").textContent(), "正在执行第 1 遍 XeLaTeX");
  assert.equal(await page.locator("#compile-progress").evaluate((element) => element.classList.contains("is-indeterminate")), true);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "compiled", token: Date.now(), warnings: [] } })));
  await page.waitForFunction(() => window.__oldFirstPage && !window.__oldFirstPage.isConnected, undefined, { timeout: 15_000 });
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".pdf-page").length === expected,
    totalPages
  );
  await page.waitForFunction(() =>
    document.getElementById("loading").hidden &&
    document.getElementById("status").textContent.includes("PDF 已刷新"),
  undefined, { timeout: 15_000 });
  assert.equal(await page.locator("#compile-progress-value").textContent(), "100%");
  assert.equal(await page.locator("#compile-progress").getAttribute("data-kind"), "success");
  await page.waitForFunction(() => {
    const viewerRect = document.getElementById("viewer").getBoundingClientRect();
    return [...document.querySelectorAll(".pdf-page")].some((item) => {
      const rect = item.getBoundingClientRect();
      return rect.right > viewerRect.left && rect.left < viewerRect.right &&
        rect.bottom > viewerRect.top && rect.top < viewerRect.bottom &&
        item.querySelector("canvas") && item.querySelector(".page-placeholder").hidden;
    });
  }, undefined, { timeout: 15_000 });
  const reloadAnchorAfter = await page.evaluate(() => {
    const viewerRect = document.getElementById("viewer").getBoundingClientRect();
    const x = viewerRect.left + viewerRect.width / 2;
    const y = viewerRect.top + viewerRect.height / 2;
    const shell = document.elementFromPoint(x, y).closest(".pdf-page");
    const rect = shell.getBoundingClientRect();
    return { page: Number(shell.dataset.pageNumber), xRatio: (x - rect.left) / rect.width, yRatio: (y - rect.top) / rect.height };
  });
  assert.equal(reloadAnchorAfter.page, reloadAnchorBefore.page);
  assert.ok(Math.abs(reloadAnchorAfter.xRatio - reloadAnchorBefore.xRatio) < 0.03);
  assert.ok(Math.abs(reloadAnchorAfter.yRatio - reloadAnchorBefore.yRatio) < 0.03);
  assert.ok((await page.locator(".pdf-page canvas").count()) <= 3);
  assert.equal(await page.locator(".manual-edit-overlay").count(), 1);
  assert.equal(await page.locator("#compile").textContent(), "应用 3 项并编译");

  await page.locator("#mode-direct").click();
  await page.locator("#manual-clear").click();
  await page.waitForFunction(() => window.__messages.some((message) => message.type === "clearManualEdits"));
  const clearMessage = await page.evaluate(() => window.__messages.findLast((message) => message.type === "clearManualEdits"));
  assert.equal(clearMessage.queueVersion, manualQueueVersion);
  manualQueueVersion += 1;
  await page.evaluate((queueVersion) => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "manualEditsCleared",
    count: 0,
    queueVersion
  } })), manualQueueVersion);
  await page.waitForFunction(() => document.querySelectorAll(".manual-edit-overlay").length === 0);
  assert.equal(await page.locator("#compile").textContent(), "编译");

  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "trackedRevisionsState", hasTrackedRevisions: true } })));
  assert.equal(await page.locator("#manual-accept-all").isHidden(), false);
  await page.locator("#manual-accept-all").click();
  await page.waitForFunction(() => window.__messages.some((message) => message.type === "resolveTrackedRevisions" && message.mode === "accept"));
  assert.equal(await page.locator("#manual-reject-all").isDisabled(), true);
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "notice", message: "已接受全部修订。" } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "trackedRevisionsState", hasTrackedRevisions: false } }));
  });
  assert.equal(await page.locator("#manual-accept-all").isHidden(), true);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "trackedRevisionsState", hasTrackedRevisions: true } })));
  await page.locator("#manual-reject-all").click();
  await page.waitForFunction(() => window.__messages.some((message) => message.type === "resolveTrackedRevisions" && message.mode === "reject"));
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "trackedRevisionsState", hasTrackedRevisions: false } })));
  assert.equal(await page.locator("#manual-reject-all").isHidden(), true);

  await page.locator("#mode-agent").click();
  assert.equal(await page.locator("#mode-agent").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#direct-edit").getAttribute("aria-pressed"), "true");
  await page.locator("#page-number").fill("6");
  await page.locator("#page-number").dispatchEvent("change");
  await page.waitForFunction(() => {
    const pageElement = document.querySelector('.pdf-page[data-page-number="6"]');
    const viewerRect = document.getElementById("viewer").getBoundingClientRect();
    const rect = pageElement.getBoundingClientRect();
    return rect.bottom > viewerRect.top && rect.top < viewerRect.bottom &&
      pageElement.querySelector(".page-placeholder").hidden;
  }, undefined, { timeout: 15_000 });
  await page.locator('.pdf-page[data-page-number="6"]').evaluate((pageElement) => {
    pageElement.scrollIntoView({ block: "center" });
  });
  await page.waitForFunction(() => {
    const pageElement = document.querySelector('.pdf-page[data-page-number="6"]');
    const viewerRect = document.getElementById("viewer").getBoundingClientRect();
    const rect = pageElement.getBoundingClientRect();
    const viewerCenter = (viewerRect.top + viewerRect.bottom) / 2;
    return rect.top < viewerCenter && rect.bottom > viewerCenter;
  });

  const selectionCountBeforeRegion = await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length);
  await page.locator("#region-select").click();
  assert.equal(await page.locator("#region-select").getAttribute("aria-pressed"), "true");
  const regionBox = await findVisibleTextBox(page);
  await dragRegion(page, regionBox);
  await page.waitForFunction(
    (count) => window.__messages.filter((message) => message.type === "selection").length > count,
    selectionCountBeforeRegion,
    { timeout: 10_000 }
  ).catch(async (error) => {
    const diagnostic = await page.evaluate(() => ({
      status: document.getElementById("status").textContent,
      selectionTool: document.getElementById("viewer").dataset.selectionTool,
      drafts: document.querySelectorAll(".region-selection-draft").length,
      overlays: document.querySelectorAll(".region-selection-overlay").length
    }));
    throw new Error(`区域框选未产生选择消息：${JSON.stringify(diagnostic)}`, { cause: error });
  });
  const regionMessage = await page.evaluate(() => window.__messages.findLast((message) => message.type === "selection"));
  assert.equal(regionMessage.selectionKind, "region");
  assert.equal(regionMessage.page, regionBox.page);
  assert.ok(regionMessage.text.trim().length >= 4);
  assert.ok(regionMessage.bounds.width > 0 && regionMessage.bounds.height > 0);
  assert.ok(regionMessage.anchors.length >= 1 && regionMessage.anchors.length <= 16);
  assert.ok(regionMessage.fragments.length >= 1 && regionMessage.fragments.length <= 64);
  assert.equal(regionMessage.interactionMode, "agent");
  assert.ok(Number.isInteger(regionMessage.interactionVersion));
  assert.ok(regionMessage.fragments.every((fragment, index) =>
    fragment.text.trim().length > 0 && fragment.rects.length >= 1 &&
    (index === 0 || fragment.lineIndex >= regionMessage.fragments[index - 1].lineIndex)
  ));
  const regionPoints = [regionMessage.start, ...regionMessage.anchors, regionMessage.end];
  assert.ok(regionPoints.every((point) =>
    point.x >= regionMessage.bounds.x && point.x <= regionMessage.bounds.x + regionMessage.bounds.width &&
    point.y >= regionMessage.bounds.y && point.y <= regionMessage.bounds.y + regionMessage.bounds.height
  ));
  assert.ok(regionMessage.anchors.every((point, index) => index === 0 || point.y >= regionMessage.anchors[index - 1].y));
  assert.equal(await page.locator(".region-selection-overlay").count(), 1);
  assert.ok((await page.locator(".region-selection-hit").count()) >= 1);
  assert.equal(await page.evaluate(() => {
    const outline = document.querySelector(".region-selection-outline").getBoundingClientRect();
    return [...document.querySelectorAll(".region-selection-hit")].every((hit) => {
      const rect = hit.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      return centerX >= outline.left - 1 && centerX <= outline.right + 1 &&
        centerY >= outline.top - 1 && centerY <= outline.bottom + 1;
    });
  }), true);
  assert.equal(await page.locator("#clear-selection").isDisabled(), false);
  assert.ok((await page.locator("#selection-summary").textContent()).includes("区域框选"));

  const { SyncTexLocator } = await import(pathToFileURL(path.join(root, "out", "synctex.js")).href);
  const projectRoot = path.resolve(root, "..");
  const regionMapping = await new SyncTexLocator().mapSelection({
    root: projectRoot,
    tex: path.join(projectRoot, "main.tex"),
    pdf: path.join(projectRoot, "main.pdf"),
    syncTex: path.join(projectRoot, "main.synctex.gz")
  }, {
    kind: "region",
    text: regionMessage.text,
    page: regionMessage.page,
    start: regionMessage.start,
    end: regionMessage.end,
    bounds: regionMessage.bounds,
    anchors: regionMessage.anchors,
    fragments: regionMessage.fragments
  }, 20);
  assert.equal(regionMapping.requiresConfirmation, true);
  assert.ok(regionMapping.startLine >= 1 && regionMapping.endLine >= regionMapping.startLine);

  await page.evaluate(({ requestId, pageNumber, selectionLength }) => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "busy", action: "mapping", requestId, sessionId: "session_region", message: "定位中" } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "mapping", requestId, sessionId: "session_region", mappingId: "mapping_region", selectionKind: "region", page: pageNumber, selectionLength, startLine: 200, endLine: 204, requiresConfirmation: true, confidenceNote: "区域框选需要核对" } }));
  }, { requestId: regionMessage.requestId, pageNumber: regionMessage.page, selectionLength: regionMessage.text.length });
  await page.locator("#instruction").fill("压缩区域内表述。");
  assert.equal(await page.locator("#analyze").isDisabled(), true);
  assert.equal(await page.locator("#source-details").evaluate((node) => node.open), false);

  const normalizedRegionBefore = await page.evaluate(() => {
    const outline = document.querySelector(".region-selection-outline");
    const shell = outline.closest(".pdf-page");
    const outlineRect = outline.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    return {
      page: Number(shell.dataset.pageNumber),
      x: (outlineRect.left - shellRect.left) / shellRect.width,
      y: (outlineRect.top - shellRect.top) / shellRect.height,
      width: outlineRect.width / shellRect.width,
      height: outlineRect.height / shellRect.height
    };
  });
  const regionZoomBefore = await page.locator("#zoom-value").textContent();
  await page.locator("#zoom-out").click();
  await page.waitForFunction((before) => document.getElementById("zoom-value").textContent !== before, regionZoomBefore);
  await page.waitForFunction(() => document.querySelectorAll(".region-selection-overlay").length === 1);
  const normalizedRegionAfter = await page.evaluate(() => {
    const outline = document.querySelector(".region-selection-outline");
    const shell = outline.closest(".pdf-page");
    const outlineRect = outline.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    return {
      page: Number(shell.dataset.pageNumber),
      x: (outlineRect.left - shellRect.left) / shellRect.width,
      y: (outlineRect.top - shellRect.top) / shellRect.height,
      width: outlineRect.width / shellRect.width,
      height: outlineRect.height / shellRect.height
    };
  });
  assert.equal(normalizedRegionAfter.page, normalizedRegionBefore.page);
  for (const key of ["x", "y", "width", "height"]) {
    assert.ok(Math.abs(normalizedRegionAfter[key] - normalizedRegionBefore[key]) < 0.003);
  }

  const regionScrollBefore = await page.locator("#viewer").evaluate((viewer) => viewer.scrollTop);
  const regionWheelZoom = await page.locator("#zoom-value").textContent();
  const stableRegionSelectionCount = await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length);
  await page.locator("#viewer").hover({ position: { x: 900, y: 280 } });
  await page.mouse.wheel(0, 650);
  await page.waitForFunction((before) => document.getElementById("viewer").scrollTop > before + 100, regionScrollBefore);
  assert.equal(await page.locator("#zoom-value").textContent(), regionWheelZoom);
  assert.equal(await page.locator(".region-selection-overlay").count(), 1);
  await page.locator("#page-number").fill(String(regionMessage.page));
  await page.locator("#page-number").dispatchEvent("change");
  await page.waitForFunction((pageNumber) => {
    const overlay = document.querySelector(".region-selection-overlay");
    const viewerRect = document.getElementById("viewer").getBoundingClientRect();
    const rect = overlay.getBoundingClientRect();
    return overlay.closest(".pdf-page").dataset.pageNumber === String(pageNumber) &&
      rect.bottom > viewerRect.top && rect.top < viewerRect.bottom;
  }, regionMessage.page);

  await page.evaluate(() => {
    window.__oldRegionOverlay = document.querySelector(".region-selection-overlay");
    window.dispatchEvent(new MessageEvent("message", { data: { type: "compiled", token: Date.now(), warnings: [] } }));
  });
  await page.waitForFunction(() => window.__oldRegionOverlay && !window.__oldRegionOverlay.isConnected, undefined, { timeout: 15_000 });
  await page.waitForFunction(() =>
    document.getElementById("loading").hidden &&
    document.getElementById("status").textContent.includes("PDF 已刷新") &&
    document.querySelectorAll(".region-selection-overlay").length === 1,
  undefined, { timeout: 15_000 });
  const normalizedRegionAfterReload = await page.evaluate(() => {
    const outline = document.querySelector(".region-selection-outline");
    const shell = outline.closest(".pdf-page");
    const outlineRect = outline.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    return {
      page: Number(shell.dataset.pageNumber),
      x: (outlineRect.left - shellRect.left) / shellRect.width,
      y: (outlineRect.top - shellRect.top) / shellRect.height,
      width: outlineRect.width / shellRect.width,
      height: outlineRect.height / shellRect.height
    };
  });
  assert.equal(normalizedRegionAfterReload.page, normalizedRegionBefore.page);
  for (const key of ["x", "y", "width", "height"]) {
    assert.ok(Math.abs(normalizedRegionAfterReload[key] - normalizedRegionBefore[key]) < 0.003);
  }
  assert.equal(await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length), stableRegionSelectionCount);
  await page.screenshot({ path: path.join(root, "artifacts", "viewer-region-smoke.png"), fullPage: false });

  await page.locator("#clear-selection").click();
  await page.waitForFunction(() => document.querySelectorAll(".region-selection-overlay").length === 0);
  assert.equal(await page.locator("#selection-details").isHidden(), true);
  assert.equal(await page.locator("#clear-selection").isDisabled(), true);
  const regionClearMessage = await page.evaluate(() => window.__messages.findLast((message) => message.type === "clearSession"));
  assert.equal(regionClearMessage.sessionId, "session_region");

  const selectionCountBeforeEscape = await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length);
  const secondRegionBox = await findVisibleTextBox(page);
  await dragRegion(page, secondRegionBox);
  await page.waitForFunction((count) => window.__messages.filter((message) => message.type === "selection").length > count, selectionCountBeforeEscape);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll(".region-selection-overlay").length === 0);
  assert.equal(await page.locator("#selection-details").isHidden(), true);
  assert.equal(await page.locator("#region-select").getAttribute("aria-pressed"), "true");

  assert.equal(await page.locator("#direct-edit").count(), 1);
  await page.locator("#mode-direct").click();
  assert.equal(await page.locator("#mode-direct").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#region-select").getAttribute("aria-pressed"), "true");
  await page.locator("#direct-edit").click();
  assert.equal(await page.locator("#direct-edit").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#region-select").getAttribute("aria-pressed"), "false");

  const visualLineStart = await clickVisualLineStart(page);
  const visualCaretY = await page.locator(".direct-edit-caret").evaluate((caret) => {
    const rect = caret.getBoundingClientRect();
    return rect.top + rect.height / 2;
  });
  assert.ok(Math.abs(visualCaretY - visualLineStart.currentY) < Math.abs(visualCaretY - visualLineStart.previousY));
  assert.ok(Math.abs(visualCaretY - visualLineStart.currentY) < 6, "行首光标没有落在点击的当前视觉行。");
  await page.locator("#direct-edit-input").press("Escape");
  assert.equal(await page.locator(".direct-edit-draft-overlay").count(), 0);

  const directEdits = [];
  await page.locator("#region-select").click();
  assert.equal(await page.locator("#region-select").getAttribute("aria-pressed"), "true");
  await page.locator("#page-number").fill("9");
  await page.locator("#page-number").press("Enter");
  await page.waitForFunction(() => Number(document.querySelector('.pdf-page[data-page-number="9"]')?.dataset.imageCount) >= 1);
  const imageBox = await page.locator('.pdf-page[data-page-number="9"]').evaluate((shell) => {
    const boundary = JSON.parse(shell.dataset.imageBoundaries)[0];
    const shellRect = shell.getBoundingClientRect();
    const scaleX = shellRect.width / Number.parseFloat(shell.style.width) * (Number.parseFloat(shell.style.width) / 595.28);
    const scaleY = shellRect.height / Number.parseFloat(shell.style.height) * (Number.parseFloat(shell.style.height) / 841.89);
    return {
      page: 9,
      left: shellRect.left + (boundary.x + boundary.width * 0.1) * scaleX,
      right: shellRect.left + (boundary.x + boundary.width * 0.9) * scaleX,
      top: shellRect.top + (boundary.y + boundary.height * 0.1) * scaleY,
      bottom: shellRect.top + (boundary.y + boundary.height * 0.9) * scaleY,
      boundary
    };
  });
  const locateImageCount = await page.evaluate(() => window.__messages.filter((message) => message.type === "locateImage").length);
  await page.evaluate((pageNumber) => {
    const layer = document.querySelector(`.pdf-page[data-page-number="${pageNumber}"] .textLayer`);
    window.__imageSmokeTextLayer = layer.cloneNode(true);
    layer.replaceChildren();
  }, imageBox.page);
  await page.mouse.move(imageBox.left, imageBox.top);
  await page.mouse.down();
  await page.mouse.move(imageBox.right, imageBox.bottom, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction((count) => window.__messages.filter((message) => message.type === "locateImage").length > count, locateImageCount);
  const locateImage = await page.evaluate(() => window.__messages.findLast((message) => message.type === "locateImage"));
  await page.evaluate((pageNumber) => {
    const layer = document.querySelector(`.pdf-page[data-page-number="${pageNumber}"] .textLayer`);
    layer.replaceChildren(...window.__imageSmokeTextLayer.cloneNode(true).childNodes);
    delete window.__imageSmokeTextLayer;
  }, imageBox.page);
  assert.equal(locateImage.anchors.length, 9);
  assert.ok(locateImage.bounds.width > 0 && locateImage.bounds.height > 0);
  assert.equal(locateImage.imageObjectName, imageBox.boundary.objectName);
  assert.deepEqual(locateImage.bounds, imageBox.boundary);
  assert.notDeepEqual(locateImage.roughBounds, locateImage.bounds);
  assert.equal(await page.locator(".region-selection-outline-image").count(), 1);
  assert.equal(await page.locator(".region-selection-rough").count(), 1);
  await page.evaluate(({ requestId, pageNumber, bounds, roughBounds, pageWidth, pageHeight, imageObjectName }) => {
    window.dispatchEvent(new MessageEvent("message", { data: {
      type: "imageEditTarget",
      requestId,
      targetId: "image-target-smoke",
      page: pageNumber,
      rects: [{ page: pageNumber, x: bounds.x / pageWidth, y: bounds.y / pageHeight, width: bounds.width / pageWidth, height: bounds.height / pageHeight }],
      imagePath: "figures/Fig01.png",
      originalValue: "width=0.58\\textwidth",
      roughBounds,
      snappedBounds: bounds,
      pageWidth,
      pageHeight,
      imageObjectName,
      factor: 1
    } }));
  }, { requestId: locateImage.requestId, pageNumber: locateImage.page, bounds: locateImage.bounds, roughBounds: locateImage.roughBounds, pageWidth: locateImage.pageWidth, pageHeight: locateImage.pageHeight, imageObjectName: locateImage.imageObjectName });
  assert.equal(await page.locator(".region-selection-overlay").count(), 0);
  assert.equal(await page.locator(".image-edit-controls").count(), 1);
  assert.equal(await page.locator(".image-edit-original").count(), 1);
  assert.equal(await page.locator(".image-edit-preview").count(), 1);
  assert.equal(await page.locator('.image-edit-controls button[aria-label="图片放大 5%"]').count(), 1);
  await page.locator('.image-edit-controls button[aria-label="图片放大 5%"]').click();
  assert.match(await page.locator(".image-edit-value").textContent(), /105%/u);
  await page.locator(".image-edit-controls button", { hasText: "确认" }).click();
  const queueImage = await page.evaluate(() => window.__messages.findLast((message) => message.type === "queueImageEdit"));
  assert.equal(queueImage.targetId, "image-target-smoke");
  assert.equal(queueImage.factor, 1.05);
  assert.equal(queueImage.queueVersion, manualQueueVersion);
  const imageEdit = {
    editType: "image",
    id: "image-edit-smoke",
    kind: "imageResize",
    page: locateImage.page,
    rects: [{ page: locateImage.page, x: locateImage.bounds.x / locateImage.pageWidth, y: locateImage.bounds.y / locateImage.pageHeight, width: locateImage.bounds.width / locateImage.pageWidth, height: locateImage.bounds.height / locateImage.pageHeight }],
    imagePath: "figures/Fig01.png",
    originalValue: "width=0.58\\textwidth",
    candidateValue: "width=0.609\\textwidth",
    factor: 1.05
  };
  directEdits.push(imageEdit);
  manualQueueVersion += 1;
  await page.evaluate(({ requestId, edit, edits, queueVersion }) => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "imageEditQueued",
    requestId,
    edit,
    edits,
    count: edits.length,
    queueVersion,
    canUndo: true,
    canRedo: false,
    manualEditMode: "direct"
  } })), { requestId: queueImage.requestId, edit: imageEdit, edits: directEdits, queueVersion: manualQueueVersion });
  assert.equal(await page.locator(".image-edit-controls").count(), 0);
  assert.ok((await page.locator(".manual-edit-image").count()) >= 1);
  assert.equal(await page.locator("#compile").textContent(), `应用 ${directEdits.length} 项并编译`);
  await page.locator("#direct-edit").click();
  await page.locator("#page-number").fill("2");
  await page.locator("#page-number").press("Enter");
  await page.waitForFunction(() => document.querySelector('.pdf-page[data-page-number="2"][data-render-stage="text"]'));

  const acknowledgeDirectEdit = async (queued, id) => {
    const edit = {
      id,
      kind: queued.kind,
      page: queued.rects.length > 0 ? Number((await page.locator(".direct-edit-draft-overlay").first().getAttribute("data-page-number")) || 1) : 1,
      rects: queued.rects,
      insertedText: queued.text
    };
    directEdits.push(edit);
    manualQueueVersion += 1;
    await page.evaluate(({ queued, edit, edits, queueVersion }) => {
      window.dispatchEvent(new MessageEvent("message", { data: {
        type: "manualEditQueued",
        requestId: queued.requestId,
        edit,
        edits,
        count: edits.length,
        queueVersion,
        canUndo: true,
        canRedo: false,
        manualEditMode: "direct"
      } }));
    }, { queued, edit, edits: directEdits, queueVersion: manualQueueVersion });
    await page.waitForFunction(() => document.getElementById("direct-edit-input").hidden);
  };

  const replacementSelection = await selectVisibleTextForDirectEdit(page, 7);
  await page.waitForFunction(() => !document.getElementById("direct-edit-input").hidden);
  const selectionCountBeforeInput = await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length);
  const queueCountBeforeComposition = await page.evaluate(() => window.__messages.filter((message) => message.type === "queueManualEdit").length);
  await page.locator("#direct-edit-input").click();
  await page.evaluate(() => {
    const input = document.getElementById("direct-edit-input");
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中" }));
    for (const init of [
      { key: "Escape" },
      { key: "Backspace" },
      { key: "Delete" },
      { key: "Enter", ctrlKey: true }
    ]) {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, isComposing: true, ...init }));
    }
    input.value = "中文替换";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "中文替换", inputType: "insertCompositionText", isComposing: true }));
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文替换" }));
    const processKey = new KeyboardEvent("keydown", { bubbles: true, key: "Escape" });
    Object.defineProperty(processKey, "keyCode", { value: 229 });
    input.dispatchEvent(processKey);
  });
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length), selectionCountBeforeInput);
  assert.equal(await page.evaluate(() => window.__messages.filter((message) => message.type === "queueManualEdit").length), queueCountBeforeComposition);
  assert.equal(await page.locator(".direct-edit-draft-overlay").count(), 1);
  assert.equal(await page.locator(".direct-edit-draft-overlay").getAttribute("data-kind"), "replace");
  const queueCountBeforeReplacement = await page.evaluate(() => window.__messages.filter((message) => message.type === "queueManualEdit").length);
  await page.keyboard.press("Control+Enter");
  assert.equal(await page.evaluate(() => window.__messages.filter((message) => message.type === "queueManualEdit").length), queueCountBeforeReplacement);
  await mapSmokeSelection(page, replacementSelection, "replace");
  await page.waitForFunction((count) => window.__messages.filter((message) => message.type === "queueManualEdit").length > count, queueCountBeforeReplacement);
  const directReplace = await page.evaluate(() => window.__messages.findLast((message) => message.type === "queueManualEdit"));
  assert.equal(directReplace.kind, "replace");
  assert.equal(directReplace.text, "中文替换");
  assert.equal("caretVisibleOffset" in directReplace, false);
  await acknowledgeDirectEdit(directReplace, "direct_replace");

  const deleteSelection = await selectVisibleTextForDirectEdit(page, 5);
  await mapSmokeSelection(page, deleteSelection, "delete");
  await page.locator("#direct-edit-input").press("Backspace");
  assert.equal(await page.locator(".direct-edit-draft-overlay").getAttribute("data-kind"), "delete");
  await page.locator("#direct-edit-input").press("Control+Enter");
  const directDelete = await page.evaluate(() => window.__messages.findLast((message) => message.type === "queueManualEdit"));
  assert.equal(directDelete.kind, "delete");
  assert.equal(directDelete.text, "");
  assert.equal("caretVisibleOffset" in directDelete, false);
  await acknowledgeDirectEdit(directDelete, "direct_delete");

  const crossPageDirect = await selectAcrossRenderedPages(page);
  assert.equal(crossPageDirect.selection.pageFragments.length, 2);
  assert.equal(await page.locator(".direct-edit-draft-overlay").count(), 2);
  await mapSmokeSelection(page, crossPageDirect.selection, "cross_page_replace");
  await page.locator("#direct-edit-input").fill("跨页整体替换");
  await page.locator("#direct-edit-input").press("Control+Enter");
  const directCrossPageReplace = await page.evaluate(() => window.__messages.findLast((message) => message.type === "queueManualEdit"));
  assert.equal(directCrossPageReplace.kind, "replace");
  assert.equal(directCrossPageReplace.text, "跨页整体替换");
  assert.deepEqual([...new Set(directCrossPageReplace.rects.map((rect) => rect.page))], crossPageDirect.pages);
  await acknowledgeDirectEdit(directCrossPageReplace, "direct_cross_page_replace");
  assert.ok((await page.locator(".manual-edit-overlay").count()) >= 2);

  await page.locator("#region-select").click();
  assert.equal(await page.locator("#mode-direct").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#region-select").getAttribute("aria-pressed"), "true");
  const regionReplaceCount = await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length);
  await dragRegion(page, await findVisibleTextBox(page));
  await page.waitForFunction((count) => window.__messages.filter((message) => message.type === "selection").length > count, regionReplaceCount);
  const directRegionReplaceSelection = await page.evaluate(() => window.__messages.findLast((message) => message.type === "selection"));
  assert.equal(directRegionReplaceSelection.selectionKind, "region");
  assert.equal(directRegionReplaceSelection.interactionMode, "direct");
  assert.ok(directRegionReplaceSelection.fragments.length >= 1);
  await mapSmokeSelection(page, directRegionReplaceSelection, "region_replace");
  await page.locator("#direct-edit-input").fill("区域整体替换");
  await page.locator("#mode-agent").click();
  assert.equal(await page.locator("#mode-direct").getAttribute("aria-pressed"), "true", "非空草稿不能被模式切换丢弃。");
  await page.locator("#direct-edit-input").press("Control+Enter");
  const directRegionReplace = await page.evaluate(() => window.__messages.findLast((message) => message.type === "queueManualEdit"));
  assert.equal(directRegionReplace.kind, "replace");
  assert.equal(directRegionReplace.text, "区域整体替换");
  assert.equal("caretVisibleOffset" in directRegionReplace, false);
  await acknowledgeDirectEdit(directRegionReplace, "direct_region_replace");

  const regionDeleteCount = await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length);
  await dragRegion(page, await findVisibleTextBox(page));
  await page.waitForFunction((count) => window.__messages.filter((message) => message.type === "selection").length > count, regionDeleteCount);
  const directRegionDeleteSelection = await page.evaluate(() => window.__messages.findLast((message) => message.type === "selection"));
  await mapSmokeSelection(page, directRegionDeleteSelection, "region_delete");
  await page.locator("#direct-edit-input").press("Delete");
  assert.equal(await page.locator(".direct-edit-draft-overlay").getAttribute("data-kind"), "delete");
  await page.locator("#direct-edit-input").press("Control+Enter");
  const directRegionDelete = await page.evaluate(() => window.__messages.findLast((message) => message.type === "queueManualEdit"));
  assert.equal(directRegionDelete.kind, "delete");
  assert.equal(directRegionDelete.text, "");
  assert.equal("caretDeleteDirection" in directRegionDelete, false);
  await acknowledgeDirectEdit(directRegionDelete, "direct_region_delete");

  await page.locator("#direct-edit").click();
  assert.equal(await page.locator("#mode-direct").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#direct-edit").getAttribute("aria-pressed"), "true");

  const insertionSelection = await clickVisibleTextForDirectEdit(page);
  assert.ok(insertionSelection.text.length >= 4);
  await mapSmokeSelection(page, insertionSelection, "insert");
  const insertionSelectionCount = await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length);
  const historyCountsBeforePromptKeys = await page.evaluate(() => ({
    undo: window.__messages.filter((message) => message.type === "undoManualEdit").length,
    redo: window.__messages.filter((message) => message.type === "redoManualEdit").length
  }));
  await page.locator("#direct-edit-input").fill("输入框编辑不应操作编辑队列");
  await page.locator("#direct-edit-input").press("Control+z");
  await page.locator("#direct-edit-input").press("Control+y");
  await page.locator("#direct-edit-input").press("Control+Shift+z");
  assert.deepEqual(await page.evaluate(() => ({
    undo: window.__messages.filter((message) => message.type === "undoManualEdit").length,
    redo: window.__messages.filter((message) => message.type === "redoManualEdit").length
  })), historyCountsBeforePromptKeys);
  await page.locator("#direct-edit-input").click();
  await page.locator("#direct-edit-input").fill("光标插入");
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => window.__messages.filter((message) => message.type === "selection").length), insertionSelectionCount);
  await page.screenshot({ path: path.join(root, "artifacts", "viewer-direct-edit-smoke.png"), fullPage: false });
  await page.locator("#direct-edit-input").press("Control+Enter");
  const directInsert = await page.evaluate(() => window.__messages.findLast((message) => message.type === "queueManualEdit"));
  const anchorVisibleLength = visibleTextLength(insertionSelection.text);
  assert.ok(["insertBefore", "insertAfter"].includes(directInsert.kind));
  assert.equal(directInsert.text, "光标插入");
  assert.ok(Number.isInteger(directInsert.caretVisibleOffset));
  assert.ok(directInsert.caretVisibleOffset >= 0 && directInsert.caretVisibleOffset <= anchorVisibleLength);
  assert.ok(Number.isFinite(insertionSelection.caretPoint?.x) && Number.isFinite(insertionSelection.caretPoint?.y));
  assert.ok(insertionSelection.caretPoint.x >= 0 && insertionSelection.caretPoint.y >= 0);
  assert.equal("caretDeleteDirection" in directInsert, false);
  await acknowledgeDirectEdit(directInsert, "direct_insert");

  const caretDeleteSelection = await clickVisibleTextForDirectEdit(page);
  await mapSmokeSelection(page, caretDeleteSelection, "caret_delete");
  await page.locator("#direct-edit-input").press("Delete");
  assert.equal(await page.locator(".direct-edit-draft-overlay").getAttribute("data-kind"), "delete");
  await page.locator("#direct-edit-input").press("Control+Enter");
  const directCaretDelete = await page.evaluate(() => window.__messages.findLast((message) => message.type === "queueManualEdit"));
  assert.equal(directCaretDelete.kind, "delete");
  assert.equal(directCaretDelete.caretDeleteDirection, "forward");
  assert.ok(Number.isInteger(directCaretDelete.caretVisibleOffset));
  await acknowledgeDirectEdit(directCaretDelete, "direct_caret_delete");

  const cancelledSelection = await selectVisibleTextForDirectEdit(page, 4);
  const queuesBeforeCancel = await page.evaluate(() => window.__messages.filter((message) => message.type === "queueManualEdit").length);
  await page.locator("#direct-edit-input").fill("不会提交");
  await page.locator("#direct-edit-input").press("Escape");
  assert.equal(await page.locator(".direct-edit-draft-overlay").count(), 0);
  assert.equal(await page.locator("#direct-edit-input").isHidden(), true);
  await mapSmokeSelection(page, cancelledSelection, "cancelled");
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => window.__messages.filter((message) => message.type === "queueManualEdit").length), queuesBeforeCancel);
  assert.equal(await page.locator("#direct-edit").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#compile").isDisabled(), false);

  assert.equal(await page.locator("#show-manual-edits-diff").isDisabled(), false);
  await page.locator("#show-manual-edits-diff").click();
  const showManualDiff = await page.evaluate(() => window.__messages.findLast((message) => message.type === "showManualEditsDiff"));
  assert.equal(showManualDiff.queueVersion, manualQueueVersion);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "notice", message: "已打开待编译改动。" } })));
  assert.equal(await page.locator("#show-manual-edits-diff").isDisabled(), false);

  await page.keyboard.press("Control+z");
  const directUndo = await page.evaluate(() => window.__messages.findLast((message) => message.type === "undoManualEdit"));
  assert.equal(directUndo.queueVersion, manualQueueVersion);
  const removedDirectEdit = directEdits.pop();
  manualQueueVersion += 1;
  await page.evaluate(({ edits, removed, queueVersion }) => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "manualEditRemoved",
    editId: removed.id,
    edits,
    count: edits.length,
    queueVersion,
    canUndo: edits.length > 0,
    canRedo: true,
    manualEditMode: "direct"
  } })), { edits: directEdits, removed: removedDirectEdit, queueVersion: manualQueueVersion });
  await page.keyboard.press("Control+y");
  const directRedo = await page.evaluate(() => window.__messages.findLast((message) => message.type === "redoManualEdit"));
  assert.equal(directRedo.queueVersion, manualQueueVersion);
  directEdits.push(removedDirectEdit);
  manualQueueVersion += 1;
  await page.evaluate(({ edits, queueVersion }) => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "manualEditRestored",
    edit: edits.at(-1),
    edits,
    count: edits.length,
    queueVersion,
    canUndo: true,
    canRedo: false,
    manualEditMode: "direct"
  } })), { edits: directEdits, queueVersion: manualQueueVersion });
  assert.equal(await page.locator("#compile").textContent(), `应用 ${directEdits.length} 项并编译`);

  manualQueueVersion += 1;
  await page.evaluate((queueVersion) => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "manualEditsState",
    edits: [],
    count: 0,
    queueVersion,
    canUndo: false,
    canRedo: true,
    manualEditMode: "direct"
  } })), manualQueueVersion);
  assert.equal(await page.locator("#manual-clear").isDisabled(), false);
  await page.locator("#manual-clear").click();
  const clearRedoOnly = await page.evaluate(() => window.__messages.findLast((message) => message.type === "clearManualEdits"));
  assert.equal(clearRedoOnly.queueVersion, manualQueueVersion);
  manualQueueVersion += 1;
  await page.evaluate((queueVersion) => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "manualEditsCleared",
    edits: [],
    count: 0,
    queueVersion,
    canUndo: false,
    canRedo: false,
    manualEditMode: "direct"
  } })), manualQueueVersion);
  assert.equal(await page.locator("#manual-clear").isDisabled(), true);

  await page.setViewportSize({ width: 360, height: 760 });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "compileProgress",
    percent: 60,
    message: "辅助文件仍需更新，将继续第 2 遍 XeLaTeX",
    indeterminate: false
  } })));
  const narrowProgress = await page.locator("#compile-progress").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewportWidth: innerWidth };
  });
  assert.ok(narrowProgress.left >= 0 && narrowProgress.right <= narrowProgress.viewportWidth);
  const narrowSkillLayout = await page.locator("#skill-progress").evaluate((panel) => {
    panel.scrollIntoView({ block: "nearest" });
    const panelRect = panel.getBoundingClientRect();
    const stages = [...panel.querySelectorAll(".skill-progress-stage")].map((item) => {
      const rect = item.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    const gates = [...panel.querySelectorAll(".skill-quality-item")].map((item) => {
      const rect = item.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
    return { panel: { left: panelRect.left, right: panelRect.right }, stages, gates, viewportWidth: innerWidth };
  });
  assert.ok(narrowSkillLayout.panel.left >= 0 && narrowSkillLayout.panel.right <= narrowSkillLayout.viewportWidth);
  assert.ok(narrowSkillLayout.stages.every((item) => item.left >= narrowSkillLayout.panel.left && item.right <= narrowSkillLayout.panel.right));
  assert.ok(narrowSkillLayout.stages.slice(1).every((item, index) => item.top >= narrowSkillLayout.stages[index].bottom - 1));
  assert.ok(narrowSkillLayout.gates.every((item) => item.left >= narrowSkillLayout.panel.left && item.right <= narrowSkillLayout.panel.right));
  await page.locator("#mode-agent").click();
  const narrowAnalysisLayout = await page.locator(".analysis-row").evaluate((row) => {
    const input = row.querySelector("#instruction").getBoundingClientRect();
    const button = row.querySelector("#analyze").getBoundingClientRect();
    return {
      inputBottom: input.bottom,
      buttonLeft: button.left,
      buttonRight: button.right,
      buttonTop: button.top,
      viewportWidth: innerWidth
    };
  });
  assert.ok(narrowAnalysisLayout.buttonTop >= narrowAnalysisLayout.inputBottom);
  assert.ok(
    narrowAnalysisLayout.buttonLeft >= 8 &&
    narrowAnalysisLayout.buttonRight <= narrowAnalysisLayout.viewportWidth - 8
  );
  const narrowToolbar = await page.locator(".toolbar").evaluate((toolbar) => {
    toolbar.scrollLeft = toolbar.scrollWidth;
    return {
      overflowX: getComputedStyle(toolbar).overflowX,
      clientWidth: toolbar.clientWidth,
      scrollWidth: toolbar.scrollWidth
    };
  });
  assert.equal(narrowToolbar.overflowX, "auto");
  assert.ok(narrowToolbar.scrollWidth >= narrowToolbar.clientWidth);
  assert.equal(await page.locator("#compile").evaluate((button) => {
    const toolbar = button.closest(".toolbar").getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    return rect.left >= toolbar.left - 1 && rect.right <= toolbar.right + 1;
  }), true);
  const narrowModeSwitch = await page.locator("#interaction-mode").evaluate((element) => {
    const toolbar = element.closest(".toolbar").getBoundingClientRect();
    element.scrollIntoView({ inline: "nearest", block: "nearest" });
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, toolbarLeft: toolbar.left, toolbarRight: toolbar.right };
  });
  assert.ok(narrowModeSwitch.left >= narrowModeSwitch.toolbarLeft - 1 && narrowModeSwitch.right <= narrowModeSwitch.toolbarRight + 1);
  await page.locator("#mode-direct").click();
  await clickVisibleTextForDirectEdit(page);
  await page.locator("#direct-edit-input").fill("窄屏直接编辑输入框边界检查");
  const narrowDraftRect = await page.locator("#direct-edit-input").evaluate((input) => {
    const rect = input.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  assert.ok(narrowDraftRect.left >= 8, "窄屏直接编辑输入框越出视口左侧。");
  assert.ok(narrowDraftRect.right <= narrowDraftRect.viewportWidth - 8, "窄屏直接编辑输入框越出视口右侧。");
  assert.ok(narrowDraftRect.top >= 42, "窄屏直接编辑输入框遮挡工具栏或越出视口顶部。");
  assert.ok(narrowDraftRect.bottom <= narrowDraftRect.viewportHeight - 8, "窄屏直接编辑输入框越出视口底部。");
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: path.join(root, "artifacts", "viewer-direct-edit-narrow-smoke.png"), fullPage: false });
  await page.locator("#direct-edit-input").press("Escape");
  await page.screenshot({ path: path.join(root, "artifacts", "viewer-narrow-smoke.png"), fullPage: false });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(root, "artifacts", "viewer-smoke.png"), fullPage: false });
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data: {
      type: "compileProgress",
      percent: 55,
      message: "第 1 遍 XeLaTeX 完成"
    } }));
    window.dispatchEvent(new MessageEvent("message", { data: {
      type: "error",
      action: "compile",
      message: "测试编译失败"
    } }));
  });
  assert.equal(await page.locator("#compile-progress").getAttribute("data-kind"), "error");
  assert.equal(await page.locator("#compile-progress-label").textContent(), "编译失败，请查看错误信息");
  console.log("连续 PDF Webview 烟测通过：直接键盘编辑、输入法、撤销重做、手动编辑、滚轮缩放、区域框选和编译刷新正常。");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
