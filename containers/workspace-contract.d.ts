export const WORKSPACE_POLICY: Readonly<Record<string, { maxSaved: number; maxReservedBytes: number; retentionMs: number; maxSavesPerMonth: number;
  maxCaptureBytesPerMonth: number; maxRetainedCaptureBytes: number }>>;
export const WORKSPACE_CAPTURE_RETENTION_MS: number;
export const WORKSPACE_OPERATION_RETENTION_MS: number;
export function validWorkspaceId(value: unknown): boolean;
export function validWorkspaceName(value: unknown): boolean;
export function validGeneration(value: unknown): boolean;
