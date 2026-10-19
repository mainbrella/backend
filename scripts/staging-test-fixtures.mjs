import { after } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { IMAGE_CATALOG } from '../containers/image-catalog.js';

// Cross-repository staging tests use checked-in frontend contract fixtures.
// Backend tests must also run when no sibling frontend checkout exists.
export function stagingTestRoot() {
  const temporary = mkdtempSync(join(tmpdir(), 'mainbrella-staging-contracts-'));
  after(() => rmSync(temporary, { recursive: true, force: true }));
  const directory = join(temporary, 'backend');
  const source = fileURLToPath(new URL('../', import.meta.url));
  mkdirSync(directory);
  copyFileSync(join(source, 'package.json'), join(directory, 'package.json'));
  for (const file of readdirSync(source).filter(file => /^wrangler.*\.jsonc$/.test(file))) {
    copyFileSync(join(source, file), join(directory, file));
  }
  for (const folder of ['migrations', 'preview-migrations']) {
    mkdirSync(join(directory, folder));
    for (const file of readdirSync(join(source, folder))) copyFileSync(join(source, folder, file), join(directory, folder, file));
  }
  for (const entry of IMAGE_CATALOG) {
    const target = join(directory, entry.dockerfile);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, entry.dockerfile), target);
  }
  for (const [name, config] of [['web', 'site'], ['web', 'builder'], ['raindrop', 'raindrop']]) {
    const target = join(temporary, name);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'mainbrella-' + name, type: 'module' }));
    copyFileSync(new URL('./fixtures/staging-frontends/' + config + '.jsonc', import.meta.url),
      join(target, config === 'builder' ? 'wrangler.builder.jsonc' : 'wrangler.jsonc'));
  }
  return directory;
}
