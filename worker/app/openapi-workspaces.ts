import { z } from 'zod';
import { sizeSchema } from './openapi-containers';
import { MAX_WORKSPACE_EXPORT_BYTES } from '../../containers/workspace-export.js';
import { containerSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

const identity=z.object({id:z.string(),createdAt:z.string().datetime()});
export const workspaceSchema=z.object({id:z.string().uuid(),name:z.string().min(1).max(80),createdAt:z.string().datetime(),expiresAt:z.number().int(),source:identity,
  size:sizeSchema,internet:z.boolean(),imageDigest:z.string(),imageId:z.string().optional(),imageName:z.string().optional(),catalogId:z.string().optional(),bytes:z.number().int().nonnegative().nullable(),
  archived:z.boolean(),status:z.enum(['saving','ready','failed','expired','deleted']),stopRequested:z.boolean(),stopCompleted:z.boolean()}).openapi('Workspace');
const headers=z.object({Origin:z.string().optional()});
const responseErrors=errors(400,401,402,403,404,405,409,410,429,503);
export function registerWorkspaceRoutes(api:OpenAPIApi,handler:LegacyHandler):void {
  register(api,'get','/containers/export',{operationId:'exportWorkspaceFiles',tags:['Containers'],summary:'Download a portable gzip tar archive of /workspace',security:containerSecurity,
    description:`Requires owned running generation and paid access. Export is limited to ${MAX_WORKSPACE_EXPORT_BYTES} compressed bytes and 60 seconds. Quiesce writers first; concurrent writes may fail the export. Mounted filesystems are excluded. Restore a saved workspace before exporting it. Archives preserve file permissions and symlinks; the provider snapshot handle is never exported.`,
    request:{query:identity},responses:{200:{description:'Portable workspace backup.',content:{'application/gzip':{schema:z.string().openapi({format:'binary'})}}},...errors(400,401,402,403,409,413,429,503)}},handler);
  register(api,'get','/workspaces',{operationId:'listWorkspaces',tags:['Containers'],summary:'List account-owned saved filesystem workspaces',security:containerSecurity,
    description:'Available when persistence issuance is disabled or billing is unavailable. Metadata only; provider handles remain private. Expired metadata remains for up to 24 hours.',
    responses:{200:jsonResponse(z.object({workspaces:z.array(workspaceSchema),limits:z.object({maxSaved:z.number(),maxReservedBytes:z.number(),retentionMs:z.number(),maxSavesPerMonth:z.number()}).nullable(),usage:z.object({saved:z.number(),reservedBytes:z.number()})})),...responseErrors}},handler);
  register(api,'post','/workspaces',{operationId:'saveWorkspace',tags:['Containers'],summary:'Snapshot an owned running generation and optionally stop it',security:containerSecurity,
    description:'Requires persistence.snapshots and paid access. Idempotency-Key is required; identical retries recover capture receipts for 24 hours. Snapshot commit precedes stop. Immutable full root-filesystem snapshot; no RAM/process state or separately mounted filesystems. Stop:false leaves the source running. Stop:true destroys it only after save. Concurrent guest writes are not application-consistent; quiesce applications before saving. Retention is fixed at save and restores do not extend it. Quotas reserve the source disk capacity, including archived workspaces.',
    request:{headers:headers.extend({'Idempotency-Key':z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)}),...requestBody(identity.extend({name:z.string().min(1).max(80),stop:z.boolean().optional()}))},
    responses:{200:jsonResponse(workspaceSchema),201:jsonResponse(workspaceSchema),...responseErrors}},handler);
  register(api,'get','/workspaces/{workspaceId}',{operationId:'getWorkspace',tags:['Containers'],summary:'Read owned workspace metadata',security:containerSecurity,
    request:{params:z.object({workspaceId:z.string().uuid()})},responses:{200:jsonResponse(workspaceSchema),...responseErrors}},handler);
  register(api,'patch','/workspaces/{workspaceId}',{operationId:'updateWorkspace',tags:['Containers'],summary:'Rename or archive an owned workspace',security:containerSecurity,
    description:'Archiving prevents restore until unarchived. Does not stop an already restored machine, extend expiry or release storage quota. Does not require active billing.',
    request:{params:z.object({workspaceId:z.string().uuid()}),headers,...requestBody(z.object({name:z.string().min(1).max(80).optional(),archived:z.boolean().optional()}))},responses:{200:jsonResponse(workspaceSchema),...responseErrors}},handler);
  register(api,'delete','/workspaces/{workspaceId}',{operationId:'deleteWorkspace',tags:['Containers'],summary:'Revoke future restores and release saved-workspace quota',security:containerSecurity,
    description:'Idempotent for 24 hours. Removes the private handle; already admitted restores/running machines continue. Cloudflare has no Worker snapshot deletion primitive; provider data expires according to its TTL, which refreshes on restore. This does not promise immediate physical erasure.',
    request:{params:z.object({workspaceId:z.string().uuid()}),headers},responses:{200:jsonResponse(z.object({deleted:z.literal(true)})),...responseErrors}},handler);
}
