import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePdfSelectionPayload } from "../selectionPayload";

describe("PDF 选区负载", () => {
  it("解析普通文字选区", () => {
    assert.deepEqual(parsePdfSelectionPayload({
      selectionKind: "text",
      text: "选区文字",
      page: 2,
      start: { x: 10, y: 20 },
      end: { x: 30, y: 40 },
      contextBefore: "选区之前",
      contextAfter: "选区之后"
    }), {
      kind: "text",
      text: "选区文字",
      page: 2,
      start: { x: 10, y: 20 },
      end: { x: 30, y: 40 },
      contextBefore: "选区之前",
      contextAfter: "选区之后"
    });
  });

  it("解析带矩形和多点锚点的区域选区", () => {
    const selection = parsePdfSelectionPayload({
      selectionKind: "region",
      text: "区域文字",
      page: 3,
      start: { x: 11, y: 21 },
      end: { x: 31, y: 41 },
      bounds: { x: 8, y: 18, width: 30, height: 28 },
      anchors: [{ x: 15, y: 22 }, { x: 16, y: 35 }]
    });
    assert.equal(selection.kind, "region");
    assert.equal(selection.anchors.length, 2);
    assert.deepEqual(selection.bounds, { x: 8, y: 18, width: 30, height: 28 });
  });

  it("拒绝未知类型、空锚点和非法矩形", () => {
    const base = {
      text: "区域文字",
      page: 3,
      start: { x: 11, y: 21 },
      end: { x: 31, y: 41 },
      bounds: { x: 8, y: 18, width: 30, height: 28 },
      anchors: [{ x: 15, y: 22 }]
    };
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "lasso" }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", anchors: [] }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", anchors: Array.from({ length: 17 }, () => ({ x: 1, y: 1 })) }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", anchors: [{ x: 15, y: 22 }, { x: 15, y: 22 }] }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", anchors: [{ x: 50, y: 22 }] }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", bounds: { x: 1, y: 1, width: 0, height: 10 } }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", start: { x: -1, y: 2 } }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "text", contextBefore: "x".repeat(257) }));
  });
});
