import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseSyncTexSpatialCandidate, hasMonotonicSourceOrder, selectionLocations } from "../synctex";

describe("跨页文字选区的 SyncTeX 位置", () => {
  it("为每个分页片段保留独立页码和起止点", () => {
    const locations = selectionLocations({
      kind: "text",
      text: "第一页第二页",
      page: 7,
      start: { x: 10, y: 700 },
      end: { x: 20, y: 100 },
      pageFragments: [
        { page: 7, text: "第一页", start: { x: 10, y: 700 }, end: { x: 500, y: 760 } },
        { page: 8, text: "第二页", start: { x: 40, y: 80 }, end: { x: 20, y: 100 } }
      ]
    });
    assert.deepEqual(locations.map((location) => location.page), [7, 7, 8, 8]);
    assert.deepEqual(locations[2].point, { x: 40, y: 80 });
  });

  it("将区域框选的定位点限制为均匀分布的六个点", () => {
    const anchors = Array.from({ length: 16 }, (_, index) => ({ x: 20 + index * 10, y: 100 + index * 5 }));
    const locations = selectionLocations({
      kind: "region",
      text: "区域文字",
      page: 3,
      start: { x: 10, y: 90 },
      end: { x: 190, y: 190 },
      bounds: { x: 0, y: 0, width: 220, height: 220 },
      anchors,
      fragments: [{ text: "区域文字", start: { x: 10, y: 90 }, end: { x: 190, y: 190 }, rects: [{ x: 10, y: 90, width: 180, height: 20 }], lineIndex: 0 }]
    });
    assert.equal(locations.length, 6);
    assert.deepEqual(locations[0].point, { x: 10, y: 90 });
    assert.deepEqual(locations.at(-1)?.point, { x: 190, y: 190 });
  });
});

describe("区域锚点源码顺序", () => {
  it("接受相同或递增的源码行", () => {
    assert.equal(hasMonotonicSourceOrder([10, 10, 11, 14]), true);
  });

  it("拒绝任意程度的源码行倒退", () => {
    assert.equal(hasMonotonicSourceOrder([10, 9]), false);
    assert.equal(hasMonotonicSourceOrder([20, 22, 21, 24]), false);
  });
});

describe("重复源码的 SyncTeX 空间消歧", () => {
  it("只接受明显更接近 PDF 选区的唯一候选", () => {
    assert.equal(chooseSyncTexSpatialCandidate([
      [{ page: 2, x: 100, y: 100 }],
      [{ page: 2, x: 205, y: 203 }]
    ], { x: 202, y: 200 }), 1);
  });

  it("候选距离并列或全部过远时拒绝", () => {
    assert.equal(chooseSyncTexSpatialCandidate([
      [{ page: 2, x: 100, y: 100 }],
      [{ page: 2, x: 104, y: 100 }]
    ], { x: 102, y: 100 }), undefined);
    assert.equal(chooseSyncTexSpatialCandidate([
      [{ page: 2, x: 0, y: 0 }],
      [{ page: 2, x: 20, y: 20 }]
    ], { x: 300, y: 300 }), undefined);
  });
});
