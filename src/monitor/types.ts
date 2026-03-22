export interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  closedPnl: string;
  fee: string;
  tid: number;
  oid: number;
  cloid?: string;
  startPosition: string;
  dir: string;
  hash: string;
}

export interface FillEvent {
  targetName: string;
  targetAddress: string;
  fill: HlFill;
  isOpen: boolean;
}

export type FillHandler = (event: FillEvent) => void;
