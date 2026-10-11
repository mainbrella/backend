import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Only demonstrably service-owned files use the short path. Schemas, auth,
// database migrations, billing primitives, tooling, and unknown paths run all checks.
const adminFiles = new Set([
  'worker/admin.ts', 'wrangler.admin.jsonc', 'worker/app/admin.ts', 'worker/app/admin.test.ts',
  'worker/app/admin-acquisition.ts', 'worker/app/admin-storage-billing.ts',
  'worker/app/accounting.ts', 'worker/app/accounting.test.ts', 'worker/lib/accounting-close.ts',
]);
const marketingFiles = new Set([
  'worker/marketing.ts', 'wrangler.marketing.jsonc', 'worker/app/marketing-email.ts',
  'worker/app/marketing-email.test.ts', 'worker/lib/marketing-email.ts', 'worker/templates/marketing-email.ts',
]);

export function checksForFiles(files) {
  const services = new Set();
  for (const file of files) {
    if (adminFiles.has(file)) services.add('admin');
    else if (marketingFiles.has(file)) services.add('marketing');
    else return { full: true, services: [] };
  }
  return { full: false, services: [...services].sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, head] = process.argv.slice(2);
  let result = { full: true, services: [] };
  try {
    // Missing history (including the first push) takes the full-check path.
    if (/^[a-f0-9]{40}$/.test(base) && !/^0+$/.test(base) && /^[a-f0-9]{40}$/.test(head)) {
      // Disabling rename detection includes both sides of a move across ownership.
      const files = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head], { encoding: 'utf8' })
        .split('\0').filter(Boolean);
      result = checksForFiles(files);
    }
  } catch {
    // Never skip checks because changed-path detection failed.
  }
  console.log(`full=${result.full}`);
  console.log(`services=${JSON.stringify(result.services)}`);
}
