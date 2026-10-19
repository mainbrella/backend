// Install Chanfana's Zod OpenAPI extension before creating the named schema.
import 'chanfana';
import { z } from 'zod';

export const storageRetentionSchema = z.object({ writesBlocked: z.boolean(), deletionAt: z.number().nullable(), notice: z.string().nullable(),
  warningDeliveredAt: z.number().nullable(), expiredAt: z.number().nullable() }).openapi('StorageRetention');
