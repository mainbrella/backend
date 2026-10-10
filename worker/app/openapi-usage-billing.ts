import { z } from 'zod';
import { prepaidBalanceSchema } from './openapi-prepaid-billing';
export const usagePricingSchema = z.object({ minimumCents: z.number(), centsPerComputeUnitHour: z.number(), defaultSpendLimitCents: z.number(), maxSpendLimitCents: z.number() });
export const usageBillingSchema = z.object({ periodStart: z.number(), periodEnd: z.number(), computeUnitHours: z.number(),
  estimatedCents: z.number(), minimumCents: z.number(), spendLimitCents: z.number(), committedCents: z.number(),
  alert: z.union([z.literal(50), z.literal(80), z.literal(100)]).nullable(), overagesEnabled: z.boolean(), invoicingPending: z.boolean() })
  .extend(prepaidBalanceSchema.omit({ spendLimitCents: true }).partial().shape);
