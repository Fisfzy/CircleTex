import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePdfImageSelectionPayload, parsePdfSelectionPayload } from "../selectionPayload";

describe("PDF 选区负载", () => {
  it("解析普通文字选区", () => {
    assert.deepEqual(parsePdfSelectionPayload({
      selectionKind: "text",
      text: "选区文字",
      page: 2,
      start: { x: 10, y: 20 },
      end: { x: 30, y: 40 },
      caretPoint: { x: 22, y: 30 },
      contextBefore: "选区之前",
      contextAfter: "选区之后"
    }), {
      kind: "text",
      text: "选区文字",
      page: 2,
      start: { x: 10, y: 20 },
      end: { x: 30, y: 40 },
      caretPoint: { x: 22, y: 30 },
      contextBefore: "选区之前",
      contextAfter: "选区之后"
    });
  });

  it("解析有序的跨页文字选区", () => {
    const selection = parsePdfSelectionPayload({
      selectionKind: "text",
      text: "第一页正文\n第二页正文",
      page: 4,
      start: { x: 10, y: 700 },
      end: { x: 30, y: 120 },
      pageFragments: [
        { page: 4, text: "第一页正文", start: { x: 10, y: 700 }, end: { x: 500, y: 760 } },
        { page: 5, text: "第二页正文", start: { x: 40, y: 90 }, end: { x: 30, y: 120 } }
      ]
    });
    assert.equal(selection.kind, "text");
    assert.equal(selection.pageFragments?.length, 2);
    assert.equal(selection.pageFragments?.at(-1)?.page, 5);
  });

  it("解析带矩形和多点锚点的区域选区", () => {
    const selection = parsePdfSelectionPayload({
      selectionKind: "region",
      text: "区域文字",
      page: 3,
      start: { x: 11, y: 21 },
      end: { x: 31, y: 41 },
      bounds: { x: 8, y: 18, width: 30, height: 28 },
      anchors: [{ x: 15, y: 22 }, { x: 16, y: 35 }],
      fragments: [
        { text: "区域", start: { x: 11, y: 21 }, end: { x: 20, y: 21 }, rects: [{ x: 10, y: 20, width: 12, height: 4 }], lineIndex: 0 },
        { text: "文字", start: { x: 11, y: 35 }, end: { x: 20, y: 35 }, rects: [{ x: 10, y: 33, width: 12, height: 4 }], lineIndex: 1 }
      ],
      interactionMode: "direct",
      interactionVersion: 4
    });
    assert.equal(selection.kind, "region");
    assert.equal(selection.anchors.length, 2);
    assert.equal(selection.fragments.length, 2);
    assert.equal(selection.interactionMode, "direct");
    assert.equal(selection.interactionVersion, 4);
    assert.deepEqual(selection.bounds, { x: 8, y: 18, width: 30, height: 28 });
  });

  it("拒绝未知类型、空锚点和非法矩形", () => {
    const base = {
      text: "区域文字",
      page: 3,
      start: { x: 11, y: 21 },
      end: { x: 31, y: 41 },
      bounds: { x: 8, y: 18, width: 30, height: 28 },
      anchors: [{ x: 15, y: 22 }],
      fragments: [{ text: "区域文字", start: { x: 11, y: 21 }, end: { x: 31, y: 41 }, rects: [{ x: 10, y: 20, width: 22, height: 22 }], lineIndex: 0 }]
    };
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "lasso" }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", anchors: [] }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", anchors: Array.from({ length: 17 }, () => ({ x: 1, y: 1 })) }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", anchors: [{ x: 15, y: 22 }, { x: 15, y: 22 }] }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", anchors: [{ x: 50, y: 22 }] }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", bounds: { x: 1, y: 1, width: 0, height: 10 } }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", fragments: [] }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", fragments: [{ ...base.fragments[0], lineIndex: -1 }] }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", fragments: [{ ...base.fragments[0], rects: [{ x: 1, y: 1, width: 3, height: 3 }] }] }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", fragments: [{ ...base.fragments[0], text: "其他文字" }] }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", interactionMode: "other" }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "region", start: { x: -1, y: 2 } }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "text", contextBefore: "x".repeat(257) }));
    assert.throws(() => parsePdfSelectionPayload({ ...base, selectionKind: "text", caretPoint: { x: -1, y: 2 } }));
    const crossPage = {
      selectionKind: "text",
      text: "甲乙",
      page: 2,
      start: { x: 1, y: 2 },
      end: { x: 3, y: 4 },
      pageFragments: [
        { page: 2, text: "甲", start: { x: 1, y: 2 }, end: { x: 2, y: 2 } },
        { page: 3, text: "乙", start: { x: 2, y: 4 }, end: { x: 3, y: 4 } }
      ]
    };
    assert.throws(() => parsePdfSelectionPayload({ ...crossPage, pageFragments: [...crossPage.pageFragments].reverse() }));
    assert.throws(() => parsePdfSelectionPayload({ ...crossPage, pageFragments: [{ ...crossPage.pageFragments[0], text: "丙" }, crossPage.pageFragments[1]] }));
    assert.throws(() => parsePdfSelectionPayload({ ...crossPage, pageFragments: [{ ...crossPage.pageFragments[0], start: { x: 9, y: 9 } }, crossPage.pageFragments[1]] }));
  });
});

describe("PDF 图片区域负载", () => {
  it("解析多点图片区域并拒绝越界或重复点", () => {
    const value = {
      page: 2,
      bounds: { x: 100, y: 200, width: 300, height: 180 },
      roughBounds: { x: 90, y: 190, width: 320, height: 200 },
      imageObjectName: "img_fixture_1",
      pageWidth: 600,
      pageHeight: 800,
      anchors: [
        { x: 250, y: 290 }, { x: 110, y: 210 }, { x: 390, y: 210 },
        { x: 110, y: 370 }, { x: 390, y: 370 }
      ],
      interactionVersion: 4
    };
    const selection = parsePdfImageSelectionPayload(value);
    assert.equal(selection.page, 2);
    assert.equal(selection.anchors.length, 5);
    assert.equal(selection.interactionVersion, 4);
    assert.throws(() => parsePdfImageSelectionPayload({ ...value, bounds: { x: 500, y: 200, width: 300, height: 180 } }));
    assert.throws(() => parsePdfImageSelectionPayload({ ...value, anchors: value.anchors.slice(0, 4) }));
    assert.throws(() => parsePdfImageSelectionPayload({ ...value, anchors: value.anchors.map(() => ({ x: 250, y: 290 })) }));
    assert.throws(() => parsePdfImageSelectionPayload({ ...value, roughBounds: { x: 1, y: 1, width: 20, height: 20 } }));
    assert.throws(() => parsePdfImageSelectionPayload({ ...value, imageObjectName: "img\ninvalid" }));
  });
});
