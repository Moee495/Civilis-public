import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ValidationReport {
  action: 'validate_dashboard_route_coverage';
  appDir: string;
  discoveredRoutePatterns: string[];
  expectedCoveredRoutePatterns: string[];
  missingCoverage: string[];
  unexpectedRoutes: string[];
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, '../../../../packages/dashboard/src/app');

const EXPECTED_ROUTE_PATTERNS = [
  '/',
  '/agents',
  '/agents/:id',
  '/arena',
  '/commerce',
  '/graveyard',
  '/intel',
  '/world',
];

async function collectPageFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectPageFiles(absolute)));
      continue;
    }
    if (entry.isFile() && entry.name === 'page.tsx') {
      files.push(absolute);
    }
  }
  return files;
}

function toRoutePattern(filePath: string): string {
  const relative = path.relative(APP_DIR, filePath);
  const routePath = relative === 'page.tsx' ? '' : relative.replace(/\/page\.tsx$/, '')
  const routeParts = routePath
    .split(path.sep)
    .filter(Boolean)
    .map((part) => {
      if (/^\[.+\]$/.test(part)) {
        return `:${part.slice(1, -1)}`;
      }
      return part;
    });

  return routeParts.length === 0 ? '/' : `/${routeParts.join('/')}`;
}

async function main(): Promise<void> {
  const pageFiles = await collectPageFiles(APP_DIR);
  const discoveredRoutePatterns = pageFiles.map(toRoutePattern).sort();
  const expectedCoveredRoutePatterns = [...EXPECTED_ROUTE_PATTERNS].sort();
  const missingCoverage = discoveredRoutePatterns.filter(
    (route) => !expectedCoveredRoutePatterns.includes(route),
  );
  const unexpectedRoutes = expectedCoveredRoutePatterns.filter(
    (route) => !discoveredRoutePatterns.includes(route),
  );

  const report: ValidationReport = {
    action: 'validate_dashboard_route_coverage',
    appDir: APP_DIR,
    discoveredRoutePatterns,
    expectedCoveredRoutePatterns,
    missingCoverage,
    unexpectedRoutes,
  };

  console.log(JSON.stringify(report, null, 2));

  if (missingCoverage.length > 0 || unexpectedRoutes.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
