import { getPool } from '../db/postgres.js';
import { tradeClient } from '../onchainos/trade.js';
import { eventBus } from '../realtime.js';
import { processX402Payment } from '../x402/payment-processor.js';

export interface TradeDecision {
  action: 'buy_okb' | 'sell_okb' | 'hold';
  amount: number;
  reason: string;
}

export async function executeAgentTrade(
  agentId: string,
  decision: TradeDecision,
): Promise<{ success: boolean; txHash?: string; actualAmount?: string }> {
  if (decision.action === 'hold') {
    return { success: true };
  }

  const pool = getPool();
  const agent = await pool.query<{ wallet_address: string }>(
    'SELECT wallet_address FROM agents WHERE agent_id = $1',
    [agentId],
  );

  if (!agent.rows[0]) {
    return { success: false };
  }

  try {
    const fromSymbol = decision.action === 'buy_okb' ? 'USDT' : 'WOKB';
    const toSymbol = decision.action === 'buy_okb' ? 'WOKB' : 'USDT';
    const trade = await tradeClient.executeSwap(
      fromSymbol,
      toSymbol,
      decision.amount.toFixed(6),
      agent.rows[0].wallet_address,
      process.env.TREASURY_PRIVATE_KEY || '',
      false,
    );

    await processX402Payment('trade', agentId, null, 0.001, {
      action: decision.action,
      amount: decision.amount,
      reason: decision.reason,
      swapTxHash: trade.txHash,
      toAmount: trade.toAmount,
    });

    eventBus.emit('agent_trade', {
      agentId,
      action: decision.action,
      amount: decision.amount,
      txHash: trade.txHash,
    });

    return {
      success: true,
      txHash: trade.txHash,
      actualAmount: trade.toAmount,
    };
  } catch (error) {
    console.error(`[AgentTrader] trade failed for ${agentId}:`, error);
    return { success: false };
  }
}
