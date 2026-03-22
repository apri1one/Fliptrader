import { describe, it, expect } from "vitest";
import { calcOrderSize } from "../order/OrderManager.js";

describe("calcOrderSize", () => {
  it("fixedRatio: 10% of fill size", () => {
    expect(calcOrderSize("fixedRatio", 0.1, 1.0, 50000)).toBeCloseTo(0.1);
  });

  it("equalSize: same as fill", () => {
    expect(calcOrderSize("equalSize", 1, 2.5, 50000)).toBeCloseTo(2.5);
  });

  it("fixedAmount: USD amount / price", () => {
    expect(calcOrderSize("fixedAmount", 500, 1.0, 50000)).toBeCloseTo(0.01);
  });
});
