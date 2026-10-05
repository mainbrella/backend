// Stable public IDs resolve to deployment-controlled image keys, never registry URLs.
export const IMAGE_CATALOG = Object.freeze([
  { id: 'node', key: 'terminal', name: 'Node 24 + TypeScript', dockerfile: 'containers/Dockerfile', repository: 'mainbrella-terminal', smoke: 'node --version; npm --version; tsc --version' },
  { id: 'python', key: 'python', name: 'Python 3.14', dockerfile: 'containers/catalog/python.Dockerfile', repository: 'mainbrella-python', smoke: 'python --version; python -m pip --version' },
  { id: 'rust', key: 'rust', name: 'Rust development', dockerfile: 'containers/catalog/rust.Dockerfile', repository: 'mainbrella-rust', smoke: 'rustc --version; cargo --version; cc --version' },
  { id: 'go', key: 'go', name: 'Go development', dockerfile: 'containers/catalog/go.Dockerfile', repository: 'mainbrella-go', smoke: 'go version' },
  { id: 'devops', key: 'devops', name: 'DevOps · AWS, Terraform, Wrangler', dockerfile: 'containers/catalog/devops.Dockerfile', repository: 'mainbrella-devops', smoke: 'aws --version; terraform version; wrangler --version' },
]);

export const CUSTOM_IMAGE_CAPACITY = 100 - IMAGE_CATALOG.length;

export function availableCatalog(images = {}) {
  return IMAGE_CATALOG.filter(image => Object.hasOwn(images, image.key) && images[image.key])
    .map(({ id, name }) => ({ id, name }));
}
