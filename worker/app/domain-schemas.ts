import { z } from 'zod';
export const contactSchema = z.object({
  firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().min(1).max(100),
  address1: z.string().trim().min(1).max(200), address2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100), state: z.string().trim().min(1).max(100), zip: z.string().trim().min(1).max(30),
  country: z.string().regex(/^[A-Z]{2}$/), email: z.string().email().max(254), phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
}).strict();
export const quoteSchema = z.object({ domainName: z.string().max(253), years: z.number().int().min(1).max(10),
  projectId: z.string().uuid().optional(), kind: z.enum(['registration', 'renewal']).default('registration') }).strict();
export const checkoutSchema = z.object({ orderId: z.string().uuid(), contact: contactSchema.optional(),
  autoRenew: z.boolean(), termsAccepted: z.literal(true) }).strict();
export const settingsSchema = z.object({ domainName: z.string(), autoRenew: z.boolean().optional(),
  privacyEnabled: z.boolean().optional(), locked: z.boolean().optional(), contact: contactSchema.optional() }).strict()
  .refine(value => Object.keys(value).length > 1);
export const recordSchema = z.object({ type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS']),
  host: z.string().max(253).regex(/^[a-zA-Z0-9_.*@-]*$/), answer: z.string().trim().min(1).max(4096),
  ttl: z.number().int().min(300).max(604800), priority: z.number().int().min(0).max(65535).optional(),
}).strict().refine(value => !['MX', 'SRV'].includes(value.type) || value.priority !== undefined);
