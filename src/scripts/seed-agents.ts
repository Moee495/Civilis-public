import { Pool } from 'pg';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

interface AgentPersonality {
  style: string;
  catchphrase: string;
  roleName: string;
  onPurchased?: string;
}

interface AgentConfig {
  tokens?: string[];
  scanInterval?: number;
  threshold?: number;
  buySignalInterval?: number;
  confidenceThreshold?: number;
  buyAdviceInterval?: number;
  maxTradeSize?: number;
  strategyPrompt: string;
}

interface Agent {
  agent_id: string;
  name: string;
  type: 'scout' | 'analyst' | 'executor';
  personality: AgentPersonality;
  config: AgentConfig;
  wallet_address: string;
  private_key: string;
}

const agents: Agent[] = [
  {
    agent_id: 'scout-alpha',
    name: 'Scout-Alpha',
    type: 'scout',
    personality: {
      style: '沉稳自信',
      catchphrase: '数据不会说谎。',
      roleName: 'Hawk Eye',
      onPurchased: '识货的人总会来。',
    },
    config: {
      tokens: ['BTC-USDT', 'ETH-USDT'],
      scanInterval: 60000,
      threshold: 2.5,
      strategyPrompt:
        'You are Hawk Eye, a steady and confident scout. Analyze market signals with precision and identify opportunities that matter. Data does not lie.',
    },
    wallet_address: '',
    private_key: '',
  },
  {
    agent_id: 'scout-beta',
    name: 'Scout-Beta',
    type: 'scout',
    personality: {
      style: '急躁兴奋',
      catchphrase: '快！机会不等人！',
      roleName: 'Flashbang',
    },
    config: {
      tokens: ['OKB-USDT', 'ETH-USDT', 'MATIC-USDT'],
      scanInterval: 45000,
      threshold: 1.5,
      strategyPrompt:
        'You are Flashbang, an eager and excited scout. Move fast to catch fleeting opportunities. Speed is key—opportunities do not wait!',
    },
    wallet_address: '',
    private_key: '',
  },
  {
    agent_id: 'analyst-pro',
    name: 'Analyst-Pro',
    type: 'analyst',
    personality: {
      style: '果断激进',
      catchphrase: '犹豫就会败北。',
      roleName: 'Gambler',
    },
    config: {
      buySignalInterval: 90000,
      confidenceThreshold: 60,
      strategyPrompt:
        'You are Gambler, a decisive and aggressive analyst. Take calculated risks and commit boldly. Hesitation leads to defeat.',
    },
    wallet_address: '',
    private_key: '',
  },
  {
    agent_id: 'analyst-safe',
    name: 'Analyst-Safe',
    type: 'analyst',
    personality: {
      style: '谨慎数据控',
      catchphrase: '让数据说话，不要让情绪做决定。',
      roleName: 'Professor',
    },
    config: {
      buySignalInterval: 120000,
      confidenceThreshold: 75,
      strategyPrompt:
        'You are Professor, a cautious data-driven analyst. Let the numbers guide you. Do not let emotions make your decisions—trust the data.',
    },
    wallet_address: '',
    private_key: '',
  },
  {
    agent_id: 'executor-v1',
    name: 'Executor-V1',
    type: 'executor',
    personality: {
      style: '简洁干脆',
      catchphrase: 'Talk is cheap, show me the tx hash.',
      roleName: 'Trigger',
    },
    config: {
      buyAdviceInterval: 120000,
      confidenceThreshold: 70,
      maxTradeSize: 1.0,
      strategyPrompt:
        'You are Trigger, a concise and direct executor. No talk, only action. Show results with transaction hashes, not words.',
    },
    wallet_address: '',
    private_key: '',
  },
];

async function generateWallets() {
  console.log('\n🔑 Generating wallets for agents...\n');

  for (const agent of agents) {
    // Check for env var override
    const envPrivateKey = process.env[`${agent.agent_id.toUpperCase()}_PRIVATE_KEY`];

    if (envPrivateKey) {
      const wallet = new ethers.Wallet(envPrivateKey);
      agent.private_key = envPrivateKey;
      agent.wallet_address = wallet.address;
      console.log(`✓ ${agent.name} (${agent.agent_id})`);
      console.log(`  Address: ${wallet.address}`);
      console.log(`  Private Key: [from env variable]\n`);
    } else {
      const wallet = ethers.Wallet.createRandom();
      agent.private_key = wallet.privateKey;
      agent.wallet_address = wallet.address;
      console.log(`✓ ${agent.name} (${agent.agent_id})`);
      console.log(`  Address: ${wallet.address}`);
      console.log(`  Private Key: ${wallet.privateKey}\n`);
    }
  }
}

async function seedAgents() {
  const client = await pool.connect();

  try {
    console.log('📦 Upserting agents into database...\n');

    for (const agent of agents) {
      const query = `
        INSERT INTO agents (
          agent_id,
          name,
          type,
          personality,
          config,
          wallet_address,
          private_key,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        ON CONFLICT (agent_id) DO UPDATE SET
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          personality = EXCLUDED.personality,
          config = EXCLUDED.config,
          wallet_address = EXCLUDED.wallet_address,
          private_key = EXCLUDED.private_key,
          updated_at = NOW()
        RETURNING agent_id, name, wallet_address;
      `;

      const result = await client.query(query, [
        agent.agent_id,
        agent.name,
        agent.type,
        JSON.stringify(agent.personality),
        JSON.stringify(agent.config),
        agent.wallet_address,
        agent.private_key,
      ]);

      const row = result.rows[0];
      console.log(`✓ Upserted: ${row.name}`);
      console.log(`  Address: ${row.wallet_address}\n`);
    }

    console.log('✅ All agents seeded successfully!\n');
  } catch (error) {
    console.error('❌ Error seeding agents:', error);
    throw error;
  } finally {
    await client.release();
  }
}

async function main() {
  try {
    console.log('╔════════════════════════════════════════╗');
    console.log('║     AgentVerse Seed Script Started     ║');
    console.log('╚════════════════════════════════════════╝');

    await generateWallets();
    await seedAgents();

    console.log('╔════════════════════════════════════════╗');
    console.log('║        Seed Script Complete! ✨        ║');
    console.log('╚════════════════════════════════════════╝\n');
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
