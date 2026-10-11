import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const adminImplementation = ['worker/admin.ts', 'worker/app/admin.ts', 'worker/app/admin-acquisition.ts',
  'worker/app/admin-storage-billing.ts', 'worker/app/accounting.ts', 'worker/lib/accounting-close.ts'];
const marketingImplementation = ['worker/marketing.ts', 'worker/app/marketing-email.ts',
  'worker/lib/marketing-email.ts', 'worker/templates/marketing-email.ts'];
const forbidden = {
  api: [...adminImplementation, ...marketingImplementation],
  admin: ['worker/index.ts', ...marketingImplementation],
  marketing: ['worker/index.ts', ...adminImplementation],
};

export function checkWorkerBoundary(target, metadata) {
  if (!forbidden[target] || !metadata?.inputs || !Object.keys(metadata.inputs).length) {
    throw new Error('Choose api, admin, or marketing and supply a nonempty Wrangler build metafile.');
  }
  const inputs = Object.keys(metadata.inputs).map(path => path.replaceAll('\\', '/'));
  const imported = forbidden[target].filter(file => inputs.some(path => path === file || path.endsWith(`/${file}`)));
  if (imported.length) throw new Error(`${target} bundles another service's implementation: ${imported.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [target, path] = process.argv.slice(2);
    checkWorkerBoundary(target, JSON.parse(readFileSync(path, 'utf8')));
    console.log(`${target} Worker dependency boundary verified.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
