import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, '..');

const MAINNET_V2_ADDRESSES = {
  ACP_V2_CONTRACT_ADDRESS: '0xBEf97c569a5b4a82C1e8f53792eC41c988A4316e',
  CIVILIS_COMMERCE_V2_ADDRESS: '0x7bac782C23E72462C96891537C61a4C86E9F086e',
  ERC8004_IDENTITY_V2_ADDRESS: '0xC9C992C0e2B8E1982DddB8750c15399D01CF907a',
  ERC8004_REPUTATION_V2_ADDRESS: '0xD8499b9A516743153EE65382f3E2C389EE693880',
  ERC8004_VALIDATION_V2_ADDRESS: '0x0CC71B9488AA74A8162790b65592792Ba52119fB',
} as const;

const LEGACY_ALIAS_KEYS = [
  'ACP_CONTRACT_ADDRESS',
  'CIVILIS_COMMERCE_ADDRESS',
  'ERC8004_IDENTITY_ADDRESS',
  'ERC8004_REPUTATION_ADDRESS',
  'ERC8004_VALIDATION_ADDRESS',
] as const;

function getArg(name: string): string | null {
  const direct = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) {
    return direct.split('=', 2)[1] ?? null;
  }

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) {
    return process.argv[index + 1] ?? null;
  }

  return null;
}

function parseEnv(content: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }

    const idx = line.indexOf('=');
    values.set(line.slice(0, idx).trim(), line.slice(idx + 1));
  }

  return values;
}

function serializeEnv(values: Map<string, string>): string {
  return `${Array.from(values.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
    .replace(/\n+$/, '')}\n`;
}

function buildReleaseEnv(existing: string): { merged: string; updates: Map<string, string> } {
  const current = parseEnv(existing);
  const merged = new Map(current);
  const updates = new Map<string, string>();

  updates.set('X_LAYER_NETWORK', 'mainnet');
  updates.set('X_LAYER_CHAIN_ID', '196');
  updates.set('X_LAYER_RPC', current.get('X_LAYER_MAINNET_RPC') || 'https://rpc.xlayer.tech');
  updates.set('X402_PAYMENT_MODE', 'direct_wallet');
  updates.set('CIVILIS_STRICT_MODE', 'true');
  updates.set('SOUL_ARCHIVE_MODE', current.get('SOUL_ARCHIVE_MODE') || 'hash_only');

  for (const [key, value] of Object.entries(MAINNET_V2_ADDRESSES)) {
    updates.set(key, value);
  }

  for (const key of LEGACY_ALIAS_KEYS) {
    updates.set(key, '');
  }

  for (const [key, value] of updates.entries()) {
    merged.set(key, value);
  }

  return {
    merged: serializeEnv(merged),
    updates,
  };
}

function main(): void {
  const inputArg = getArg('input');
  const outputArg = getArg('output');
  const inputPath = path.resolve(SRC_ROOT, inputArg || '.env');
  const outputPath = path.resolve(SRC_ROOT, outputArg || '.env.mainnet.release.generated');

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input env not found: ${inputPath}`);
  }

  const source = fs.readFileSync(inputPath, 'utf8');
  const { merged, updates } = buildReleaseEnv(source);
  fs.writeFileSync(outputPath, merged, 'utf8');

  console.log(JSON.stringify({
    ok: true,
    inputPath,
    outputPath,
    applied: Object.fromEntries(updates.entries()),
    notes: [
      'Legacy alias keys were blanked to avoid mixed-state preflight.',
      'Secrets and operator-specific values were preserved from the input env.',
      'SOUL_NFT_ADDRESS and X402_SERVICE_ADDRESS were not auto-filled.',
    ],
  }, null, 2));
}

main();
