import { PdfPoint, PdfRect, PdfSelection } from "./types";

export function parsePdfSelectionPayload(message: Record<string, unknown>): PdfSelection {
  const text = boundedString(message.text, 1, 10_000, "PDF 选区");
  const page = positiveInteger(message.page, "页码");
  const start = parsePoint(message.start, "起点");
  const end = parsePoint(message.end, "终点");
  if (message.selectionKind === "text") {
    const contextBefore = optionalBoundedString(message.contextBefore, 256, "选区前文");
    const contextAfter = optionalBoundedString(message.contextAfter, 256, "选区后文");
    return {
      kind: "text",
      text,
      page,
      start,
      end,
      ...(contextBefore === undefined ? {} : { contextBefore }),
      ...(contextAfter === undefined ? {} : { contextAfter })
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
    return { kind: "region", text, page, start, end, bounds, anchors };
  }
  throw new Error("PDF 选区类型无效。");
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
