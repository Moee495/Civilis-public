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

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function main(): void {
  const inputArg = getArg('input');
  const targetArg = getArg('target');
  const inputPath = path.resolve(SRC_ROOT, inputArg || '.env.mainnet.release.generated');
  const targetPath = path.resolve(SRC_ROOT, targetArg || '.env');
  const backupPath = path.resolve(
    SRC_ROOT,
    `.env.pre-rerun-${timestamp()}.bak`,
  );

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Release env source not found: ${inputPath}`);
  }

  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target env not found: ${targetPath}`);
  }

  fs.copyFileSync(targetPath, backupPath);
  fs.copyFileSync(inputPath, targetPath);

  console.log(JSON.stringify({
    ok: true,
    inputPath,
    targetPath,
    backupPath,
    notes: [
      'Target env was backed up before activation.',
      'Active env now matches the generated release candidate env.',
    ],
  }, null, 2));
}

main();
