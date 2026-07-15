import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nearlySamePdfRect, selectSnappedImageBoundary } from "../imageBoundary";

describe("PDF 图片边界吸附", () => {
  const left = { x: 80, y: 120, width: 180, height: 120, objectName: "img_left" };
  const right = { x: 330, y: 120, width: 180, height: 120, objectName: "img_right" };

  it("部分覆盖单图时吸附到完整图片盒子", () => {
    const result = selectSnappedImageBoundary(
      { x: 110, y: 140, width: 110, height: 80 },
      [left, right]
    );
    assert.deepEqual(result.boundary, left);
    assert.equal(result.centerInside, true);
  });

  it("粗框包含图注空间时仍按图片绘制对象吸附", () => {
    const result = selectSnappedImageBoundary(
      { x: 60, y: 100, width: 220, height: 190 },
      [left]
    );
    assert.deepEqual(result.boundary, left);
    assert.ok(result.intersectionOverImage > 0.99);
  });

  it("同时覆盖并排图片且得分接近时拒绝猜测", () => {
    assert.throws(() => selectSnappedImageBoundary(
      { x: 60, y: 95, width: 470, height: 170 },
      [left, right]
    ), /同时覆盖多张图片/u);
  });

  it("无交叠图片时提示扩大选框", () => {
    assert.throws(() => selectSnappedImageBoundary(
      { x: 10, y: 10, width: 40, height: 40 },
      [left]
    ), /没有覆盖可识别/u);
  });

  it("允许小幅坐标误差比较 PDF 边界", () => {
    assert.equal(nearlySamePdfRect(left, { x: 81, y: 119, width: 181, height: 121 }, 2), true);
    assert.equal(nearlySamePdfRect(left, { x: 90, y: 120, width: 180, height: 120 }, 2), false);
  });
});
