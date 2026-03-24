import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DEPLOYED_ENV_PATH = path.join(ROOT, 'contracts/.env.deployed');
const TARGET_ENV_PATH = path.join(ROOT, '.env');

function parseEnv(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }

    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    values.set(key, value);
  }
  return values;
}

function mergeEnv(existing: string, updates: Map<string, string>): string {
  const lines = existing.split(/\r?\n/);
  const seen = new Set<string>();

  const nextLines = lines.map((line) => {
    if (!line.trim() || line.trim().startsWith('#') || !line.includes('=')) {
      return line;
    }

    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    if (!updates.has(key)) {
      return line;
    }

    seen.add(key);
    return `${key}=${updates.get(key) ?? ''}`;
  });

  for (const [key, value] of updates.entries()) {
    if (seen.has(key)) {
      continue;
    }
    nextLines.push(`${key}=${value}`);
  }

  return `${nextLines.join('\n').replace(/\n+$/, '')}\n`;
}

function main(): void {
  if (!fs.existsSync(DEPLOYED_ENV_PATH)) {
    throw new Error(`Deployment env not found: ${DEPLOYED_ENV_PATH}`);
  }

  if (!fs.existsSync(TARGET_ENV_PATH)) {
    throw new Error(`Target env not found: ${TARGET_ENV_PATH}`);
  }

  const deployed = fs.readFileSync(DEPLOYED_ENV_PATH, 'utf8');
  const target = fs.readFileSync(TARGET_ENV_PATH, 'utf8');
  const deployedValues = parseEnv(deployed);

  if (deployedValues.size === 0) {
    throw new Error(`No deployment values found in ${DEPLOYED_ENV_PATH}`);
  }

  const merged = mergeEnv(target, deployedValues);
  fs.writeFileSync(TARGET_ENV_PATH, merged, 'utf8');

  console.log('[apply-deployment-env] Applied keys:');
  for (const key of deployedValues.keys()) {
    console.log(`  - ${key}`);
  }
  console.log(`[apply-deployment-env] Updated ${TARGET_ENV_PATH}`);
}

main();
