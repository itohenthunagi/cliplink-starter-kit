import { describe, expect, it } from "vitest";
import { cropRectangle } from "../src/client/region";

describe("範囲選択", () => {
  it("縮小表示と逆方向ドラッグを元画像の画素へ変換する", () => {
    expect(cropRectangle({ x: 500, y: 300 }, { x: 100, y: 100 },
      { x: 100, y: 100, width: 800, height: 400 }, 1600, 800))
      .toEqual({ x: 0, y: 0, width: 800, height: 400 });
  });
  it("画像外を切り詰め、小さすぎるドラッグを無視する", () => {
    expect(cropRectangle({ x: 0, y: 0 }, { x: 150, y: 150 },
      { x: 100, y: 100, width: 800, height: 400 }, 1600, 800))
      .toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(cropRectangle({ x: 120, y: 120 }, { x: 122, y: 122 },
      { x: 100, y: 100, width: 800, height: 400 }, 1600, 800))
      .toBeNull();
  });
});
