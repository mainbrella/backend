import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGE_CATALOG } from '../containers/image-catalog.js';

export function catalogSourceHash(root, entry) {
  return createHash('sha256').update(readFileSync(join(root, entry.dockerfile))).digest('hex');
}

export function validateCatalogImage(entry, value, accountId, sourceHash) {
  const prefix = `registry.cloudflare.com/${accountId}/${entry.repository}@sha256:`;
  if (typeof value?.image !== 'string' || !value.image.startsWith(prefix)
    || !/^[a-f0-9]{64}$/.test(value.image.slice(prefix.length))) throw new Error(`Invalid ${entry.id} catalog image reference`);
  if (value.dockerfileHash !== sourceHash) throw new Error(`Catalog image ${entry.id} was built from a different Dockerfile. Run the Build MainBrella images workflow first.`);
  return { image: value.image };
}

export function validateCatalogImages(manifest, accountId, root) {
  if (!manifest?.images || typeof manifest.images !== 'object' || Array.isArray(manifest.images)
    || Object.keys(manifest.images).length !== IMAGE_CATALOG.length) throw new Error('Incomplete catalog image manifest. Run the Build MainBrella images workflow first.');
  return Object.fromEntries(IMAGE_CATALOG.map(entry => [entry.key,
    validateCatalogImage(entry, manifest.images[entry.key], accountId, catalogSourceHash(root, entry))]));
}
