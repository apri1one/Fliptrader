export interface OrderParams {
  symbol: string;
  side: "buy" | "sell";
  size: number;
  leverage: number;
  reduceOnly: boolean;
}

export interface OrderResult {
  orderId: string;
  filledSize: number;
  avgPrice: number;
  status: "filled" | "partial" | "failed";
}

export interface BookTop {
  bid: number;
  ask: number;
}

export interface OrderStatus {
  filled: number;
  remaining: number;
  status: string;
  avgPrice?: number;
}

export interface ExchangeAdapter {
  name: string;
  ensureIsolatedMargin(symbol: string, leverage: number): Promise<void>;
  getBookTop(symbol: string): Promise<BookTop>;
  placePostOnly(
    symbol: string,
    side: "buy" | "sell",
    size: number,
    price: number,
    reduceOnly: boolean,
  ): Promise<string>;
  cancelOrder(symbol: string, orderId: string): Promise<void>;
  getOrderStatus(symbol: string, orderId: string): Promise<OrderStatus>;
  placeChaseLimitOrder?(params: OrderParams): Promise<OrderResult>;
  getPosition(
    symbol: string,
  ): Promise<{ size: number; side: "long" | "short" | "none" }>;
  fetchAllPositions(): Promise<
    Array<{ symbol: string; size: number; side: "long" | "short" }>
  >;
}
