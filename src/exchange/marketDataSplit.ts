// Testnet rehearsal on real prices: decisions read candles and funding from a public market-data
// exchange (Binance mainnet, no API key) while everything that touches the account — orders, stops,
// positions, balance, fills, mark price — stays on the trading exchange (Binance demo).
// Stops therefore keep triggering on the trading exchange's own mark price, where the orders live.
import type { Exchange } from "./types.js";

export class MarketDataSplit implements Exchange {
  readonly name: string;

  constructor(private readonly trading: Exchange, private readonly data: Pick<Exchange, "getClosedCandles" | "getFundingHistory">) {
    this.name = `${trading.name}+market-data`;
  }

  getClosedCandles(symbol: string, interval: string, limit: number) { return this.data.getClosedCandles(symbol, interval, limit); }
  getFundingHistory(symbol: string, startTime: number) { return this.data.getFundingHistory(symbol, startTime); }

  getServerTime() { return this.trading.getServerTime(); }
  getFilters(symbol: string) { return this.trading.getFilters(symbol); }
  getBalance() { return this.trading.getBalance(); }
  getPosition(symbol: string) { return this.trading.getPosition(symbol); }
  prepareSymbol(symbol: string, leverage: number) { return this.trading.prepareSymbol(symbol, leverage); }
  marketOrder(p: Parameters<Exchange["marketOrder"]>[0]) { return this.trading.marketOrder(p); }
  placeStop(p: Parameters<Exchange["placeStop"]>[0]) { return this.trading.placeStop(p); }
  cancelStop(symbol: string, id: string) { return this.trading.cancelStop(symbol, id); }
  getOpenStops(symbol: string) { return this.trading.getOpenStops(symbol); }
  getFills(symbol: string, sinceMs: number) { return this.trading.getFills(symbol, sinceMs); }
}
