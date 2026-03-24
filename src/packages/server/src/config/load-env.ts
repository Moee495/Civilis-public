import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const explicit = process.env.CIVILIS_ENV_FILE
  ? path.resolve(process.cwd(), process.env.CIVILIS_ENV_FILE)
  : null;
const candidates = [
  ...(explicit ? [explicit] : []),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'src/.env'),
  path.resolve(here, '../../../.env'),
  path.resolve(here, '../../../../.env'),
];

for (const candidate of candidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}
