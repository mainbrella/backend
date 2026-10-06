export const WORKSPACE_POLICY: Readonly<Record<string, { maxSaved: number; maxReservedBytes: number; retentionMs: number; maxSavesPerMonth: number }>>;
export const WORKSPACE_OPERATION_RETENTION_MS: number;
export function validWorkspaceId(value: unknown): boolean;
export function validWorkspaceName(value: unknown): boolean;
export function validGeneration(value: unknown): boolean;
