import { Router, Request, Response } from 'express';
import { marketClient } from '../onchainos/market.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router: Router = Router();

// Get ticker for a token pair
router.get('/market/ticker/:instId', asyncHandler(async (req: Request, res: Response) => {
  const { instId } = req.params;
  const ticker = await marketClient.getTicker(instId);

  if (!ticker) {
    res.status(404).json({ error: `Ticker not found for ${instId}` });
    return;
  }

  res.json({
    instId: ticker.instId,
    last: ticker.last,
    lastPrice: ticker.last.toString(),
    price: ticker.last.toString(),
    open24h: ticker.open24h.toString(),
    high24h: ticker.high24h.toString(),
    low24h: ticker.low24h.toString(),
    volume24h: ticker.vol24h.toString(),
    change24h: ((ticker.last - ticker.open24h) / ticker.open24h * 100).toFixed(2),
    timestamp: ticker.timestamp,
  });
}));

// Get multiple tickers
router.get('/market/tickers', asyncHandler(async (req: Request, res: Response) => {
  const tokens = (req.query.tokens as string)?.split(',') || ['BTC-USDT', 'ETH-USDT', 'OKB-USDT'];
  const tickers = await marketClient.getTickers(tokens);

  res.json(tickers.map(t => ({
    instId: t.instId,
    last: t.last,
    lastPrice: t.last.toString(),
    open24h: t.open24h.toString(),
    high24h: t.high24h.toString(),
    low24h: t.low24h.toString(),
    volume24h: t.vol24h.toString(),
    change24h: ((t.last - t.open24h) / t.open24h * 100).toFixed(2),
    timestamp: t.timestamp,
  })));
}));

// Get candle data
router.get('/market/candles/:instId', asyncHandler(async (req: Request, res: Response) => {
  const { instId } = req.params;
  const bar = (req.query.bar as string) || '1H';
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 300);

  const candles = await marketClient.getCandles(instId, bar, limit);
  res.json(candles);
}));

export default router;
