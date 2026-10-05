export type CatalogImage = { id: string; key: string; name: string; dockerfile: string; repository: string; smoke: string };
export const IMAGE_CATALOG: readonly CatalogImage[];
export const CUSTOM_IMAGE_CAPACITY: number;
export function availableCatalog(images?: Record<string, unknown>): { id: string; name: string }[];
