/**
 * Seed data for The Commons (Public Goods) and The Oracle's Eye (Price Prediction)
 * Run: npx tsx scripts/seed-new-modes.ts
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  const client = await pool.connect();

  try {
    // ── Get all alive agents ──
    const agentsResult = await client.query<{
      agent_id: string; name: string; archetype: string; balance: string;
    }>('SELECT agent_id, name, archetype, balance FROM agents WHERE is_alive = true ORDER BY name');
    const agents = agentsResult.rows;

    if (agents.length < 2) {
      console.error('Need at least 2 alive agents. Run `npm run seed` first.');
      return;
    }

    console.log(`Found ${agents.length} alive agents:`, agents.map(a => `${a.name}(${a.archetype})`).join(', '));

    // ── Ensure new tables exist ──
    // (These should already be created by initDB, but just in case)
    await client.query(`CREATE TABLE IF NOT EXISTS commons_rounds (
      id SERIAL PRIMARY KEY, round_number INTEGER NOT NULL, tick_number INTEGER NOT NULL,
      base_injection DECIMAL(10,4) NOT NULL, prediction_loss_pool DECIMAL(10,4) DEFAULT 0,
      contribute_total DECIMAL(10,4) DEFAULT 0, multiplier DECIMAL(4,2) NOT NULL,
      sabotage_damage DECIMAL(10,4) DEFAULT 0, final_pool DECIMAL(10,4) NOT NULL,
      cooperation_rate DECIMAL(4,3) NOT NULL, participant_count INTEGER NOT NULL,
      contributor_count INTEGER NOT NULL, freerider_count INTEGER NOT NULL,
      hoarder_count INTEGER DEFAULT 0, saboteur_count INTEGER DEFAULT 0,
      economy_phase TEXT DEFAULT 'stable', created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS commons_decisions (
      id SERIAL PRIMARY KEY, round_id INTEGER NOT NULL REFERENCES commons_rounds(id),
      agent_id TEXT NOT NULL REFERENCES agents(agent_id), decision TEXT NOT NULL,
      cost DECIMAL(10,4) DEFAULT 0, weight DECIMAL(6,3) DEFAULT 1.0,
      payout DECIMAL(10,4) DEFAULT 0, net_profit DECIMAL(10,4) DEFAULT 0,
      contribute_streak INTEGER DEFAULT 0, freeriding_streak INTEGER DEFAULT 0,
      sabotage_detected BOOLEAN DEFAULT false, reputation_change INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS price_snapshots (
      id SERIAL PRIMARY KEY, inst_id TEXT NOT NULL, price DECIMAL(20,8) NOT NULL,
      volume_24h DECIMAL(20,4), change_24h DECIMAL(8,4), source TEXT DEFAULT 'okx',
      tick_number INTEGER, fetched_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS prediction_rounds (
      id SERIAL PRIMARY KEY, round_number INTEGER NOT NULL, start_tick INTEGER NOT NULL,
      end_tick INTEGER NOT NULL, phase TEXT DEFAULT 'choosing', coin_a TEXT NOT NULL,
      coin_b TEXT NOT NULL, start_price_a DECIMAL(20,8), start_price_b DECIMAL(20,8),
      end_price_a DECIMAL(20,8), end_price_b DECIMAL(20,8),
      change_pct_a DECIMAL(8,5), change_pct_b DECIMAL(8,5), actual_winner TEXT,
      relative_diff DECIMAL(8,5), prize_pool DECIMAL(10,4) DEFAULT 0,
      treasury_cut DECIMAL(10,4) DEFAULT 0, pg_return DECIMAL(10,4) DEFAULT 0,
      flash_settled BOOLEAN DEFAULT false, flash_tick INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(), settled_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS prediction_positions (
      id SERIAL PRIMARY KEY, round_id INTEGER NOT NULL REFERENCES prediction_rounds(id),
      agent_id TEXT NOT NULL REFERENCES agents(agent_id), chosen_coin TEXT NOT NULL,
      position_type TEXT NOT NULL, entry_fee DECIMAL(10,4) NOT NULL,
      base_odds DECIMAL(4,2) NOT NULL, closed_early BOOLEAN DEFAULT false,
      close_tick INTEGER, close_price_a DECIMAL(20,8), close_price_b DECIMAL(20,8),
      floating_pnl DECIMAL(10,4), final_pnl DECIMAL(10,4), prediction_correct BOOLEAN,
      magnitude_correct BOOLEAN, payout DECIMAL(10,4) DEFAULT 0, reasoning TEXT,
      mechanics_triggered TEXT[], created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── Clean old seed data ──
    await client.query('DELETE FROM commons_decisions');
    await client.query('DELETE FROM commons_rounds');
    await client.query('DELETE FROM prediction_positions');
    await client.query('DELETE FROM prediction_rounds');
    await client.query('DELETE FROM price_snapshots');

    console.log('\n═══ Seeding The Commons (Public Goods) ═══');

    // ── Get current tick ──
    const tickResult = await client.query<{ tick_number: number }>(
      'SELECT COALESCE(MAX(tick_number), 100) as tick_number FROM tick_snapshots'
    );
    let baseTick = tickResult.rows[0].tick_number;

    // Decision templates by archetype
    const ARCHETYPE_DECISIONS: Record<string, () => string> = {
      sage:   () => Math.random() < 0.85 ? 'contribute' : 'hoard',
      monk:   () => Math.random() < 0.70 ? 'contribute' : (Math.random() < 0.5 ? 'hoard' : 'free_ride'),
      oracle: () => Math.random() < 0.40 ? 'contribute' : (Math.random() < 0.6 ? 'free_ride' : 'hoard'),
      fox:    () => Math.random() < 0.25 ? 'contribute' : (Math.random() < 0.7 ? 'free_ride' : 'sabotage'),
      echo:   () => Math.random() < 0.50 ? 'contribute' : 'free_ride',
      whale:  () => Math.random() < 0.15 ? 'contribute' : (Math.random() < 0.6 ? 'free_ride' : 'hoard'),
      hawk:   () => Math.random() < 0.10 ? 'contribute' : (Math.random() < 0.4 ? 'sabotage' : 'free_ride'),
      chaos:  () => ['contribute', 'free_ride', 'hoard', 'sabotage'][Math.floor(Math.random() * 4)],
    };

    // Generate 5 commons rounds
    for (let r = 1; r <= 5; r++) {
      const tick = baseTick - (5 - r) * 5; // 每5个tick一轮
      const participants = agents;
      const decisions: { agentId: string; decision: string; archetype: string }[] = [];

      for (const a of participants) {
        const decFn = ARCHETYPE_DECISIONS[a.archetype] ?? ARCHETYPE_DECISIONS.echo;
        decisions.push({ agentId: a.agent_id, decision: decFn(), archetype: a.archetype });
      }

      const contributors = decisions.filter(d => d.decision === 'contribute');
      const freeriders = decisions.filter(d => d.decision === 'free_ride');
      const hoarders = decisions.filter(d => d.decision === 'hoard');
      const saboteurs = decisions.filter(d => d.decision === 'sabotage');

      const coopRate = contributors.length / participants.length;
      const baseInjection = 0.5;
      const predictionLossPool = r >= 3 ? 0.1 * r : 0; // 模拟预测亏损回流

      // Contribution cost per agent = 0.5 (matches CONTRIBUTE_COST in commons-settlement.ts)
      const contributeCost = 0.5;
      const contributeTotal = contributors.length * contributeCost;

      // Multiplier based on cooperation rate
      let multiplier = 1.1;
      if (coopRate < 0.3) multiplier = 0.8;
      else if (coopRate > 0.9) multiplier = 1.8;
      else if (coopRate > 0.6) multiplier = 1.5;

      // Sabotage damage
      const sabotageDmg = saboteurs.length * 0.3; // matches SABOTAGE_COST in settlement

      // Final pool
      const rawPool = (baseInjection + predictionLossPool + contributeTotal) * multiplier;
      const finalPool = Math.max(0, rawPool - sabotageDmg);

      // Insert round
      const roundInsert = await client.query(
        `INSERT INTO commons_rounds
          (round_number, tick_number, base_injection, prediction_loss_pool, contribute_total,
           multiplier, sabotage_damage, final_pool, cooperation_rate, participant_count,
           contributor_count, freerider_count, hoarder_count, saboteur_count, economy_phase,
           created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 NOW() - INTERVAL '${(5 - r) * 150} seconds')
         RETURNING id`,
        [r, tick, baseInjection, predictionLossPool, contributeTotal,
         multiplier, sabotageDmg, finalPool, coopRate, participants.length,
         contributors.length, freeriders.length, hoarders.length, saboteurs.length,
         r <= 2 ? 'stable' : r === 3 ? 'boom' : r === 4 ? 'stable' : 'recession']
      );
      const roundId = roundInsert.rows[0].id;

      // Calculate weights & payouts
      const totalWeight = decisions.reduce((sum, d) => {
        if (d.decision === 'contribute') return sum + 1.8;
        if (d.decision === 'free_ride') return sum + 0.5;
        if (d.decision === 'hoard') return sum + 0.0;
        return sum + 0.0; // saboteur gets 0
      }, 0);

      let contribStreak = 0;
      let freeStreak = 0;

      for (const d of decisions) {
        let weight = 0;
        let cost = 0;
        let payout = 0;

        if (d.decision === 'contribute') {
          weight = 1.8;
          cost = contributeCost;
          contribStreak++;
        } else if (d.decision === 'free_ride') {
          weight = 0.5;
          freeStreak++;
        } else if (d.decision === 'hoard') {
          weight = 0;
        } else { // sabotage
          weight = 0;
          cost = 0.3; // sabotage cost (matches SABOTAGE_COST in commons-settlement.ts)
        }

        if (totalWeight > 0 && weight > 0) {
          payout = (weight / totalWeight) * finalPool;
        }

        const netProfit = payout - cost;
        const repChange = d.decision === 'contribute' ? 5 :
                          d.decision === 'sabotage' ? -10 :
                          d.decision === 'free_ride' ? -2 : 0;

        await client.query(
          `INSERT INTO commons_decisions
            (round_id, agent_id, decision, cost, weight, payout, net_profit,
             contribute_streak, freeriding_streak, sabotage_detected, reputation_change,
             created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   NOW() - INTERVAL '${(5 - r) * 150} seconds')`,
          [roundId, d.agentId, d.decision, cost, weight, payout, netProfit,
           d.decision === 'contribute' ? contribStreak : 0,
           d.decision === 'free_ride' ? freeStreak : 0,
           d.decision === 'sabotage', repChange]
        );
      }

      console.log(
        `  Round ${r} (tick ${tick}): ` +
        `${contributors.length}C/${freeriders.length}FR/${hoarders.length}H/${saboteurs.length}S ` +
        `| coop=${(coopRate * 100).toFixed(0)}% | mul=${multiplier}x | pool=${finalPool.toFixed(3)}`
      );
    }

    // ═══ Price Snapshots ═══
    console.log('\n═══ Seeding Price Snapshots ═══');

    const basePrices: Record<string, number> = {
      'OKB-USDT': 20.5,
      'BTC-USDT': 84500,
      'ETH-USDT': 2050,
    };

    // Generate 20 ticks of price data
    for (let t = 0; t < 20; t++) {
      const tick = baseTick - (19 - t) * 1;
      for (const [pair, base] of Object.entries(basePrices)) {
        const drift = (Math.random() - 0.48) * 0.008; // slight upward drift
        basePrices[pair] = base * (1 + drift);
        const offsetSeconds = (19 - t) * 30;
        await client.query(
          `INSERT INTO price_snapshots (inst_id, price, tick_number, fetched_at) VALUES ($1, $2, $3, NOW() - INTERVAL '${offsetSeconds} seconds')`,
          [pair, basePrices[pair].toFixed(8), tick]
        );
      }
    }
    console.log('  20 ticks of price data for OKB, BTC, ETH');

    // ═══ Prediction Rounds ═══
    console.log('\n═══ Seeding The Oracle\'s Eye (Price Prediction) ═══');

    const coinPairs: [string, string][] = [
      ['OKB-USDT', 'ETH-USDT'],
      ['BTC-USDT', 'OKB-USDT'],
      ['ETH-USDT', 'BTC-USDT'],
    ];

    const positionTypes = ['long_small', 'long_big', 'short_small', 'short_big', 'hedge'];
    const oddsMap: Record<string, number> = {
      long_small: 1.2, long_big: 2.5, short_small: 1.2, short_big: 2.5, hedge: 0.3,
    };

    const ARCHETYPE_PRED: Record<string, () => string> = {
      sage:   () => 'hedge',
      monk:   () => Math.random() < 0.4 ? 'hedge' : (Math.random() < 0.5 ? 'long_small' : 'short_small'),
      oracle: () => positionTypes[Math.floor(Math.random() * 4)], // not hedge
      fox:    () => Math.random() < 0.3 ? 'long_big' : 'long_small',
      echo:   () => Math.random() < 0.3 ? 'hedge' : 'long_small',
      whale:  () => Math.random() < 0.5 ? 'long_big' : 'short_big',
      hawk:   () => Math.random() < 0.6 ? 'long_big' : 'short_big',
      chaos:  () => positionTypes[Math.floor(Math.random() * 5)],
    };

    for (let pr = 0; pr < 3; pr++) {
      const [coinA, coinB] = coinPairs[pr];
      const isSettled = pr < 2; // First 2 settled, 3rd is active
      const startTick = baseTick - (2 - pr) * 10;
      const endTick = startTick + 10;

      // Simulate start prices
      const startA = basePrices[coinA] * (1 - 0.005 * (2 - pr));
      const startB = basePrices[coinB] * (1 - 0.003 * (2 - pr));

      // Simulate end prices (only for settled)
      const endA = startA * (1 + (Math.random() - 0.45) * 0.02);
      const endB = startB * (1 + (Math.random() - 0.55) * 0.02);
      const changeA = ((endA - startA) / startA) * 100;
      const changeB = ((endB - startB) / startB) * 100;
      const relativeDiff = Math.abs(changeA - changeB);
      const actualWinner = changeA > changeB ? 'coin_a' : 'coin_b';
      const isFlash = isSettled && relativeDiff > 1.0;

      // Pick 3-4 participants
      const participantCount = 3 + Math.floor(Math.random() * 2);
      const shuffled = [...agents].sort(() => Math.random() - 0.5);
      const participants = shuffled.slice(0, Math.min(participantCount, agents.length));

      const entryFee = 0.3;
      const prizePool = participants.length * entryFee;
      const treasuryCut = prizePool * 0.25;

      const roundInsert = await client.query(
        `INSERT INTO prediction_rounds
          (round_number, start_tick, end_tick, phase, coin_a, coin_b,
           start_price_a, start_price_b, end_price_a, end_price_b,
           change_pct_a, change_pct_b, actual_winner, relative_diff,
           prize_pool, treasury_cut, pg_return, flash_settled, flash_tick,
           created_at, settled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
                 NOW() - INTERVAL '${(2 - pr) * 300} seconds',
                 ${isSettled ? "NOW() - INTERVAL '" + ((2 - pr) * 300 - 150) + " seconds'" : 'NULL'})
         RETURNING id`,
        [
          pr + 1,
          startTick, endTick,
          isSettled ? (isFlash ? 'flash_settled' : 'settled') : 'predicting',
          coinA, coinB,
          startA.toFixed(8), startB.toFixed(8),
          isSettled ? endA.toFixed(8) : null,
          isSettled ? endB.toFixed(8) : null,
          isSettled ? changeA.toFixed(5) : null,
          isSettled ? changeB.toFixed(5) : null,
          isSettled ? actualWinner : null,
          isSettled ? relativeDiff.toFixed(5) : null,
          prizePool,
          isSettled ? treasuryCut : 0,
          isSettled ? (prizePool * 0.1) : 0, // pg_return
          isFlash,
          isFlash ? startTick + 7 : null,
        ]
      );
      const roundId = roundInsert.rows[0].id;

      for (const p of participants) {
        const posFn = ARCHETYPE_PRED[p.archetype] ?? ARCHETYPE_PRED.echo;
        const posType = posFn();
        const baseOdds = oddsMap[posType] ?? 1.0;
        const chosenCoin: 'coin_a' | 'coin_b' = Math.random() < 0.5 ? 'coin_a' : 'coin_b';

        // Settlement result (for settled rounds)
        let predictionCorrect: boolean | null = null;
        let magnitudeCorrect: boolean | null = null;
        let finalPnl: number | null = null;
        let payout: number = 0;

        if (isSettled) {
          if (posType === 'hedge') {
            predictionCorrect = null;
            payout = entryFee * 0.3;
            finalPnl = payout - entryFee;
          } else {
            predictionCorrect = actualWinner === chosenCoin;
            const isBig = posType.includes('big');
            magnitudeCorrect = isBig ? relativeDiff >= 1.0 : relativeDiff < 1.0;

            if (predictionCorrect) {
              if (isBig && magnitudeCorrect) payout = entryFee * baseOdds;
              else if (isBig) payout = entryFee * 1.1;
              else if (magnitudeCorrect) payout = entryFee * baseOdds;
              else payout = entryFee * 0.8;
            }
            finalPnl = payout - entryFee;
          }
        }

        const reasoning = `${p.archetype} → ${posType} on ${chosenCoin === 'coin_a' ? coinA : coinB}`;

        await client.query(
          `INSERT INTO prediction_positions
            (round_id, agent_id, chosen_coin, position_type, entry_fee, base_odds,
             prediction_correct, magnitude_correct, final_pnl, payout, reasoning,
             created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   NOW() - INTERVAL '${(2 - pr) * 300} seconds')`,
          [roundId, p.agent_id, chosenCoin, posType, entryFee, baseOdds,
           predictionCorrect, magnitudeCorrect,
           finalPnl?.toFixed(4) ?? null,
           payout.toFixed(4), reasoning]
        );
      }

      const status = isSettled
        ? `${isFlash ? '⚡FLASH ' : ''}settled: ${actualWinner} won (${relativeDiff.toFixed(2)}% diff)`
        : '🔮 ACTIVE — predicting';

      console.log(
        `  Round ${pr + 1}: ${coinA} vs ${coinB} | ${participants.length} agents | ${status}`
      );
    }

    console.log('\n✅ Seed complete! New mode data is ready.');
    console.log('   Start the server with: npm run dev:server');
    console.log('   Start the dashboard with: npm run dev:dashboard');
    console.log('   Then visit http://localhost:3000/arena\n');

  } catch (err) {
    console.error('Seed error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
