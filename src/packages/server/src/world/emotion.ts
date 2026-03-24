import { getPool } from '../db/postgres.js';

export async function spreadEmotion(): Promise<void> {
  const pool = getPool();

  // Single query: join agents with high-trust relations and compute new risk in SQL
  // This replaces the N+1 pattern (load all agents → loop → individual UPDATE per trust)
  const result = await pool.query<{ agent_id: string; new_risk: string }>(`
    WITH influences AS (
      SELECT
        tr.to_agent_id AS agent_id,
        AVG(
          LEAST(0.95, GREATEST(0.05,
            a_to.risk_tolerance + (a_from.risk_tolerance - a_to.risk_tolerance)
              * ((tr.trust_score - 60.0) / 40.0) * 0.02
          ))
        ) AS new_risk
      FROM trust_relations tr
      JOIN agents a_from ON a_from.agent_id = tr.from_agent_id AND a_from.is_alive = true
      JOIN agents a_to ON a_to.agent_id = tr.to_agent_id AND a_to.is_alive = true
      WHERE tr.trust_score > 60
      GROUP BY tr.to_agent_id, a_to.risk_tolerance
      HAVING ABS(AVG(
        LEAST(0.95, GREATEST(0.05,
          a_to.risk_tolerance + (a_from.risk_tolerance - a_to.risk_tolerance)
            * ((tr.trust_score - 60.0) / 40.0) * 0.02
        ))
      ) - a_to.risk_tolerance) > 0.001
    )
    UPDATE agents a
    SET risk_tolerance = ROUND(i.new_risk::numeric, 2)
    FROM influences i
    WHERE a.agent_id = i.agent_id
    RETURNING a.agent_id, i.new_risk::text as new_risk
  `);

  if (result.rowCount && result.rowCount > 0) {
    console.log(`[Emotion] Updated risk tolerance for ${result.rowCount} agents`);
  }
}
