import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Explicit --local or --remote is required; this command never migrates or deploys.
const [target, plan, daysText, usesText, expiryText] = process.argv.slice(2);
const days = Number(daysText);
const uses = Number(usesText);
const expiry = Date.parse(expiryText);
if (!['--local', '--remote'].includes(target) || !['builder', 'pro', 'scale'].includes(plan)
  || !Number.isInteger(days) || days < 1 || days > 90 || !Number.isSafeInteger(uses) || uses < 1
  || !Number.isFinite(expiry) || expiry <= Date.now()) {
  console.error('Usage: npm run coupon:create -- --local|--remote builder|pro|scale <trial-days:1-90> <max-uses> <expiry-ISO-date>');
  process.exit(1);
}
const code = randomBytes(12).toString('hex').toUpperCase();
const hash = createHash('sha256').update(code).digest('hex');
const directory = mkdtempSync(join(tmpdir(), 'mainbrella-coupon-'));
try {
  const file = join(directory, 'coupon.sql');
  writeFileSync(file, `INSERT INTO trial_coupons (code_hash, plan, trial_days, max_redemptions, expires_at) VALUES ('${hash}', '${plan}', ${days}, ${uses}, ${expiry});`, { mode: 0o600 });
  const result = spawnSync('npx', ['--no-install', 'wrangler', 'd1', 'execute', 'delta', target, '--file', file], { stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exitCode = result.status || 1;
  else console.log(`Promo code: ${code}\nPlan: ${plan}; trial: ${days} days; maximum uses: ${uses}; redeem before: ${new Date(expiry).toISOString()}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
