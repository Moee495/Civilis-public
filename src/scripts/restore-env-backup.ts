import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, '..');

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

function findLatestBackup(): string | null {
  const candidates = fs.readdirSync(SRC_ROOT)
    .filter((entry) => /^\.env\.pre-rerun-.*\.bak$/.test(entry))
    .sort();

  const latest = candidates.at(-1);
  return latest ? path.resolve(SRC_ROOT, latest) : null;
}

function main(): void {
  const backupArg = getArg('input');
  const targetArg = getArg('target');
  const backupPath = backupArg
    ? path.resolve(SRC_ROOT, backupArg)
    : findLatestBackup();
  const targetPath = path.resolve(SRC_ROOT, targetArg || '.env');

  if (!backupPath || !fs.existsSync(backupPath)) {
    throw new Error('No env backup found. Provide --input with a backup path.');
  }

  fs.copyFileSync(backupPath, targetPath);

  console.log(JSON.stringify({
    ok: true,
    backupPath,
    targetPath,
    notes: [
      'Target env was restored from backup.',
    ],
  }, null, 2));
}

main();
