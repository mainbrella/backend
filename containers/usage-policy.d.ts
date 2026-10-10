export interface BillingPeriod { kind?: 'prepaid'; customerId: string; subscriptionId?: string; periodStart: number; periodEnd: number }
export const USAGE_PRICING: Readonly<{ minimumCents: number; centsPerComputeUnitHour: number; defaultSpendLimitCents: number; maxSpendLimitCents: number }>;
export function validSpendLimit(value: unknown): boolean;
export function validBillingPeriod(value: unknown): boolean;
export function billingPeriodKey(period: BillingPeriod): string;
