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
  getOrderStatus(
    symbol: string,
    orderId: string,
  ): Promise<{ filled: number; remaining: number; status: string }>;
  placeChaseLimitOrder?(params: OrderParams): Promise<OrderResult>;
  getPosition(
    symbol: string,
  ): Promise<{ size: number; side: "long" | "short" | "none" }>;
}
