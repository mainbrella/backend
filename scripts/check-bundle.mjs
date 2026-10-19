import { bundleTarget } from './release.mjs';

try {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/check-bundle.mjs <target>');
  bundleTarget(process.argv[2]);
} catch (error) {
  console.error(error.status ? 'Worker bundle check failed.' : error.message);
  process.exitCode = 1;
}
