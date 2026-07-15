import { ImagePdfSelection, PdfPoint, PdfRect, PdfSelection, RegionTextFragment, TextPdfPageFragment } from "./types";

export function parsePdfSelectionPayload(message: Record<string, unknown>): PdfSelection {
  const text = boundedString(message.text, 1, 10_000, "PDF 选区");
  const page = positiveInteger(message.page, "页码");
  const start = parsePoint(message.start, "起点");
  const end = parsePoint(message.end, "终点");
  const interactionMode = optionalInteractionMode(message.interactionMode);
  const interactionVersion = optionalNonNegativeInteger(message.interactionVersion, "交互状态版本");
  const interaction = {
    ...(interactionMode === undefined ? {} : { interactionMode }),
    ...(interactionVersion === undefined ? {} : { interactionVersion })
  };
  if (message.selectionKind === "text") {
    const contextBefore = optionalBoundedString(message.contextBefore, 256, "选区前文");
    const contextAfter = optionalBoundedString(message.contextAfter, 256, "选区后文");
    const caretPoint = message.caretPoint === undefined ? undefined : parsePoint(message.caretPoint, "光标位置");
    const pageFragments = message.pageFragments === undefined
      ? undefined
      : parseTextPageFragments(message.pageFragments, text, page, start, end);
    return {
      kind: "text",
      text,
      page,
      start,
      end,
      ...interaction,
      ...(pageFragments === undefined ? {} : { pageFragments }),
      ...(contextBefore === undefined ? {} : { contextBefore }),
      ...(contextAfter === undefined ? {} : { contextAfter }),
      ...(caretPoint === undefined ? {} : { caretPoint })
    };
  }
  if (message.selectionKind === "region") {
    const bounds = parseRect(message.bounds, "区域范围");
    if (!Array.isArray(message.anchors) || message.anchors.length < 1 || message.anchors.length > 16) {
      throw new Error("区域锚点数量无效。");
    }
    const anchors = message.anchors.map((value, index) => parsePoint(value, `区域锚点 ${index + 1}`));
    const anchorKeys = new Set(anchors.map((point) => `${point.x.toFixed(3)}:${point.y.toFixed(3)}`));
    if (anchorKeys.size !== anchors.length) {
      throw new Error("区域锚点不能重复。");
    }
    const epsilon = 0.05;
    if ([start, ...anchors, end].some((point) =>
      point.x < bounds.x - epsilon || point.x > bounds.x + bounds.width + epsilon ||
      point.y < bounds.y - epsilon || point.y > bounds.y + bounds.height + epsilon
    )) {
      throw new Error("区域锚点必须位于框选范围内。");
    }
    if (!Array.isArray(message.fragments) || message.fragments.length < 1 || message.fragments.length > 64) {
      throw new Error("区域文字片段数量无效。");
    }
    const fragments = message.fragments.map((value, index) =>
      parseRegionFragment(value, index, bounds)
    );
    if (fragments.some((fragment, index) => index > 0 && fragment.lineIndex < fragments[index - 1].lineIndex)) {
      throw new Error("区域文字片段的视觉行顺序无效。");
    }
    if (fragments.reduce((total, fragment) => total + fragment.text.length, 0) > 10_000) {
      throw new Error("区域文字片段总长度无效。");
    }
    if (normalizedVisibleText(fragments.map((fragment) => fragment.text).join("")) !== normalizedVisibleText(text)) {
      throw new Error("区域文字片段与选区文字不一致。");
    }
    return { kind: "region", text, page, start, end, bounds, anchors, fragments, ...interaction };
  }
  throw new Error("PDF 选区类型无效。");
}

export function parsePdfImageSelectionPayload(message: Record<string, unknown>): ImagePdfSelection {
  const page = positiveInteger(message.page, "图片页码");
  const bounds = parseRect(message.bounds, "图片框选范围");
  const roughBounds = parseRect(message.roughBounds, "图片粗选范围");
  const imageObjectName = boundedString(message.imageObjectName, 1, 200, "PDF 图片对象标识");
  if (!/^[A-Za-z0-9_.:-]+$/u.test(imageObjectName)) {
    throw new Error("PDF 图片对象标识格式无效。");
  }
  const pageWidth = positiveDimension(message.pageWidth, "PDF 页面宽度");
  const pageHeight = positiveDimension(message.pageHeight, "PDF 页面高度");
  if ([bounds, roughBounds].some((rect) => rect.x + rect.width > pageWidth + 0.05 || rect.y + rect.height > pageHeight + 0.05)) {
    throw new Error("图片框选范围超出 PDF 页面边界。");
  }
  if (!rectsOverlap(bounds, roughBounds)) {
    throw new Error("图片吸附边界必须与粗选区域相交。");
  }
  if (!Array.isArray(message.anchors) || message.anchors.length < 5 || message.anchors.length > 12) {
    throw new Error("图片定位点数量无效。");
  }
  const anchors = message.anchors.map((value, index) => parsePoint(value, `图片定位点 ${index + 1}`));
  const epsilon = 0.05;
  if (anchors.some((point) => !pointInsideRect(point, bounds, epsilon))) {
    throw new Error("图片定位点必须位于框选范围内。");
  }
  const anchorKeys = new Set(anchors.map((point) => `${point.x.toFixed(3)}:${point.y.toFixed(3)}`));
  if (anchorKeys.size !== anchors.length) {
    throw new Error("图片定位点不能重复。");
  }
  const interactionVersion = optionalNonNegativeInteger(message.interactionVersion, "交互状态版本");
  return {
    page,
    bounds,
    roughBounds,
    imageObjectName,
    anchors,
    pageWidth,
    pageHeight,
    ...(interactionVersion === undefined ? {} : { interactionVersion })
  };
}

function rectsOverlap(left: PdfRect, right: PdfRect): boolean {
  return Math.min(left.x + left.width, right.x + right.width) > Math.max(left.x, right.x) &&
    Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y);
}

function parseTextPageFragments(
  value: unknown,
  selectionText: string,
  firstPage: number,
  start: PdfPoint,
  end: PdfPoint
): TextPdfPageFragment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    throw new Error("跨页文字片段数量无效。");
  }
  const fragments = value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`跨页文字片段 ${index + 1} 无效。`);
    }
    const fragment = item as Record<string, unknown>;
    return {
      page: positiveInteger(fragment.page, `跨页文字片段 ${index + 1} 页码`),
      text: boundedString(fragment.text, 1, 10_000, `跨页文字片段 ${index + 1}`),
      start: parsePoint(fragment.start, `跨页文字片段 ${index + 1} 起点`),
      end: parsePoint(fragment.end, `跨页文字片段 ${index + 1} 终点`)
    };
  });
  if (fragments[0].page !== firstPage || fragments.some((fragment, index) =>
    index > 0 && fragment.page <= fragments[index - 1].page
  )) {
    throw new Error("跨页文字片段的页码顺序无效。");
  }
  if (fragments.at(-1)!.page - fragments[0].page > 20) {
    throw new Error("跨页文字选区跨度不能超过 20 页。");
  }
  if (!samePoint(fragments[0].start, start) || !samePoint(fragments.at(-1)!.end, end)) {
    throw new Error("跨页文字片段与选区起止位置不一致。");
  }
  if (normalizedVisibleText(fragments.map((fragment) => fragment.text).join("")) !== normalizedVisibleText(selectionText)) {
    throw new Error("跨页文字片段与选区文字不一致。");
  }
  return fragments;
}

function samePoint(left: PdfPoint, right: PdfPoint): boolean {
  return Math.abs(left.x - right.x) <= 0.05 && Math.abs(left.y - right.y) <= 0.05;
}

function optionalInteractionMode(value: unknown): "direct" | "agent" | undefined {
  if (value === undefined) return undefined;
  if (value !== "direct" && value !== "agent") {
    throw new Error("交互模式无效。");
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new Error(`${name}无效。`);
  }
  return value;
}

function parseRegionFragment(value: unknown, index: number, bounds: PdfRect): RegionTextFragment {
  if (!value || typeof value !== "object") {
    throw new Error(`区域文字片段 ${index + 1} 无效。`);
  }
  const fragment = value as Record<string, unknown>;
  const text = boundedString(fragment.text, 1, 2_000, `区域文字片段 ${index + 1}`);
  const start = parsePoint(fragment.start, `区域文字片段 ${index + 1} 起点`);
  const end = parsePoint(fragment.end, `区域文字片段 ${index + 1} 终点`);
  if (typeof fragment.lineIndex !== "number" || !Number.isInteger(fragment.lineIndex) || fragment.lineIndex < 0 || fragment.lineIndex > 10_000) {
    throw new Error(`区域文字片段 ${index + 1} 行号无效。`);
  }
  if (!Array.isArray(fragment.rects) || fragment.rects.length < 1 || fragment.rects.length > 32) {
    throw new Error(`区域文字片段 ${index + 1} 矩形数量无效。`);
  }
  const rects = fragment.rects.map((rect, rectIndex) =>
    parseRect(rect, `区域文字片段 ${index + 1} 矩形 ${rectIndex + 1}`)
  );
  const epsilon = 0.05;
  const points = [start, end, ...rects.flatMap((rect) => [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height }
  ])];
  if (points.some((point) => !pointInsideRect(point, bounds, epsilon))) {
    throw new Error(`区域文字片段 ${index + 1} 必须位于框选范围内。`);
  }
  return { text, start, end, rects, lineIndex: fragment.lineIndex };
}

function pointInsideRect(point: PdfPoint, rect: PdfRect, epsilon: number): boolean {
  return point.x >= rect.x - epsilon && point.x <= rect.x + rect.width + epsilon &&
    point.y >= rect.y - epsilon && point.y <= rect.y + rect.height + epsilon;
}

function normalizedVisibleText(value: string): string {
  return value.normalize("NFKC").replace(/\s/gu, "");
}

function parseRect(value: unknown, name: string): PdfRect {
  if (!value || typeof value !== "object") {
    throw new Error(`${name}无效。`);
  }
  const rect = value as Record<string, unknown>;
  const x = finiteCoordinate(rect.x, `${name}横坐标`);
  const y = finiteCoordinate(rect.y, `${name}纵坐标`);
  const width = finiteCoordinate(rect.width, `${name}宽度`);
  const height = finiteCoordinate(rect.height, `${name}高度`);
  if (width <= 0 || height <= 0 || x + width > 10_000 || y + height > 10_000) {
    throw new Error(`${name}尺寸无效。`);
  }
  return { x, y, width, height };
}

function parsePoint(value: unknown, name: string): PdfPoint {
  if (!value || typeof value !== "object") {
    throw new Error(`${name}坐标无效。`);
  }
  const point = value as Record<string, unknown>;
  return {
    x: finiteCoordinate(point.x, `${name}横坐标`),
    y: finiteCoordinate(point.y, `${name}纵坐标`)
  };
}

function finiteCoordinate(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10_000) {
    throw new Error(`${name}无效。`);
  }
  return value;
}

function positiveDimension(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 10_000) {
    throw new Error(`${name}无效。`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error(`${name}无效。`);
  }
  return value;
}

function boundedString(value: unknown, minimum: number, maximum: number, name: string): string {
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) {
    throw new Error(`${name}长度无效。`);
  }
  return value;
}

function optionalBoundedString(value: unknown, maximum: number, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw new Error(`${name}格式无效。`);
  }
  return value;
}
