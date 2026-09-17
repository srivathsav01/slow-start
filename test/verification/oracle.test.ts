import { loadGoldenConfig, loadGoldenVectors } from "../helpers/golden-vectors.js";
import { describe, it, expect } from "vitest";

describe("golden-vectors", () => {
  it("loads the golden configuration", () => {
    loadGoldenConfig();
  });

  it("loads the golden vectors", () => {
    const vectors = loadGoldenVectors();
    expect(vectors).toHaveLength(12);
    expect(vectors.map((v) => v.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});