import { PdfRect } from "./types";

export interface PdfImageBoundary extends PdfRect {
  objectName: string;
  pixelWidth?: number;
  pixelHeight?: number;
}

export interface ImageBoundaryMatch {
  boundary: PdfImageBoundary;
  intersectionOverSelection: number;
  intersectionOverImage: number;
  centerInside: boolean;
  score: number;
}

export function selectSnappedImageBoundary(
  selection: PdfRect,
  boundaries: readonly PdfImageBoundary[]
): ImageBoundaryMatch {
  validateRect(selection, "粗选区域");
  const matches = boundaries.map((boundary) => scoreBoundary(selection, boundary))
    .filter((match) => match.intersectionOverSelection >= 0.06 && match.intersectionOverImage >= 0.12)
    .sort((left, right) => right.score - left.score);
  const best = matches[0];
  if (!best || best.score < 0.34) {
    throw new Error("粗选区域没有覆盖可识别的嵌入图片，请扩大选框使其覆盖图片主体。");
  }
  const runnerUp = matches[1];
  if (runnerUp && best.score - runnerUp.score < 0.1 && (
    runnerUp.centerInside === best.centerInside || runnerUp.score >= best.score * 0.86
  )) {
    throw new Error("粗选区域同时覆盖多张图片，无法确定唯一目标。请缩小选框，只覆盖一张图片主体。");
  }
  return best;
}

export function nearlySamePdfRect(left: PdfRect, right: PdfRect, tolerance = 2): boolean {
  return Math.abs(left.x - right.x) <= tolerance &&
    Math.abs(left.y - right.y) <= tolerance &&
    Math.abs(left.width - right.width) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance;
}

function scoreBoundary(selection: PdfRect, boundary: PdfImageBoundary): ImageBoundaryMatch {
  validateRect(boundary, "图片边界");
  const intersection = intersectionArea(selection, boundary);
  const selectionArea = selection.width * selection.height;
  const imageArea = boundary.width * boundary.height;
  const intersectionOverSelection = intersection / selectionArea;
  const intersectionOverImage = intersection / imageArea;
  const selectionCenter = {
    x: selection.x + selection.width / 2,
    y: selection.y + selection.height / 2
  };
  const centerInside = pointInside(selectionCenter, boundary);
  const imageCenter = {
    x: boundary.x + boundary.width / 2,
    y: boundary.y + boundary.height / 2
  };
  const normalizedDistance = Math.hypot(
    selectionCenter.x - imageCenter.x,
    selectionCenter.y - imageCenter.y
  ) / Math.max(1, Math.hypot(selection.width, selection.height));
  const centerScore = Math.max(0, 1 - normalizedDistance);
  const score = intersectionOverSelection * 0.3 +
    intersectionOverImage * 0.45 +
    centerScore * 0.1 +
    (centerInside ? 0.15 : 0);
  return { boundary, intersectionOverSelection, intersectionOverImage, centerInside, score };
}

function intersectionArea(left: PdfRect, right: PdfRect): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function pointInside(point: { x: number; y: number }, rect: PdfRect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width &&
    point.y >= rect.y && point.y <= rect.y + rect.height;
}

function validateRect(rect: PdfRect, name: string): void {
  if (!rect || [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) === false ||
      rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`${name}无效。`);
  }
}
