export interface Position {
  size: number;
  side: "long" | "short";
  notional: number;
}

export class PositionTracker {
  private positions = new Map<string, Map<string, { rawSize: number; lastPrice: number }>>();
  private leverageMap = new Map<string, number>(); // "targetName:coin" -> leverage

  setLeverage(targetName: string, coin: string, leverage: number): void {
    this.leverageMap.set(`${targetName}:${coin}`, leverage);
  }

  getLeverage(targetName: string, coin: string): number | null {
    return this.leverageMap.get(`${targetName}:${coin}`) ?? null;
  }

  applyFill(targetName: string, coin: string, side: "B" | "A", size: number, price: number): void {
    if (!this.positions.has(targetName)) {
      this.positions.set(targetName, new Map());
    }
    const targetPositions = this.positions.get(targetName)!;
    const current = targetPositions.get(coin) ?? { rawSize: 0, lastPrice: price };
    const delta = side === "B" ? size : -size;
    current.rawSize += delta;
    current.lastPrice = price;

    if (Math.abs(current.rawSize) < 1e-12) {
      targetPositions.delete(coin);
    } else {
      targetPositions.set(coin, current);
    }
  }

  getPosition(targetName: string, coin: string): Position | null {
    const targetPositions = this.positions.get(targetName);
    if (!targetPositions) return null;
    const pos = targetPositions.get(coin);
    if (!pos) return null;
    return {
      size: Math.abs(pos.rawSize),
      side: pos.rawSize > 0 ? "long" : "short",
      notional: Math.abs(pos.rawSize) * pos.lastPrice,
    };
  }

  getCoinNotional(targetName: string, coin: string): number {
    const pos = this.getPosition(targetName, coin);
    return pos ? pos.notional : 0;
  }

  getTotalNotional(targetName: string): number {
    const targetPositions = this.positions.get(targetName);
    if (!targetPositions) return 0;
    let total = 0;
    for (const [, pos] of targetPositions) {
      total += Math.abs(pos.rawSize) * pos.lastPrice;
    }
    return total;
  }

  getGlobalNotional(prefix: string): number {
    let total = 0;
    for (const [key, positions] of this.positions) {
      if (key.startsWith(prefix)) {
        for (const [, pos] of positions) {
          total += Math.abs(pos.rawSize) * pos.lastPrice;
        }
      }
    }
    return total;
  }
}
