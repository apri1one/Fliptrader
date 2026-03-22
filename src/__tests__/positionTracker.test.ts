import { describe, it, expect } from "vitest";
import { PositionTracker } from "../tracker/PositionTracker.js";

describe("PositionTracker", () => {
  it("tracks new long position", () => {
    const tracker = new PositionTracker();
    tracker.applyFill("whale-1", "BTC", "B", 0.5, 50000);
    const pos = tracker.getPosition("whale-1", "BTC");
    expect(pos).toEqual({ size: 0.5, side: "long", notional: 25000 });
  });

  it("tracks new short position", () => {
    const tracker = new PositionTracker();
    tracker.applyFill("whale-1", "ETH", "A", 10, 3000);
    const pos = tracker.getPosition("whale-1", "ETH");
    expect(pos).toEqual({ size: 10, side: "short", notional: 30000 });
  });

  it("increases existing position", () => {
    const tracker = new PositionTracker();
    tracker.applyFill("whale-1", "BTC", "B", 0.5, 50000);
    tracker.applyFill("whale-1", "BTC", "B", 0.3, 51000);
    const pos = tracker.getPosition("whale-1", "BTC");
    expect(pos!.size).toBeCloseTo(0.8);
    expect(pos!.side).toBe("long");
  });

  it("reduces position on partial close", () => {
    const tracker = new PositionTracker();
    tracker.applyFill("whale-1", "BTC", "B", 1.0, 50000);
    tracker.applyFill("whale-1", "BTC", "A", 0.4, 52000);
    const pos = tracker.getPosition("whale-1", "BTC");
    expect(pos!.size).toBeCloseTo(0.6);
    expect(pos!.side).toBe("long");
  });

  it("removes position on full close", () => {
    const tracker = new PositionTracker();
    tracker.applyFill("whale-1", "BTC", "B", 1.0, 50000);
    tracker.applyFill("whale-1", "BTC", "A", 1.0, 52000);
    const pos = tracker.getPosition("whale-1", "BTC");
    expect(pos).toBeNull();
  });

  it("returns total notional across coins", () => {
    const tracker = new PositionTracker();
    tracker.applyFill("whale-1", "BTC", "B", 1, 50000);
    tracker.applyFill("whale-1", "ETH", "A", 10, 3000);
    expect(tracker.getTotalNotional("whale-1")).toBeCloseTo(80000);
  });

  it("isolates different targets", () => {
    const tracker = new PositionTracker();
    tracker.applyFill("whale-1", "BTC", "B", 1, 50000);
    tracker.applyFill("whale-2", "BTC", "A", 2, 50000);
    expect(tracker.getPosition("whale-1", "BTC")!.side).toBe("long");
    expect(tracker.getPosition("whale-2", "BTC")!.side).toBe("short");
  });
});
