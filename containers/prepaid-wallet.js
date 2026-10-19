// Linux supplies compute policy; the shared wallet owns funding and charges.
import { PrepaidWallet as SharedWallet } from './wallet.js';
import { machineSize } from './plan-policy.js';
import { USAGE_PRICING } from './usage-policy.js';
export { UNIT_MS_PER_CENT, MINIMUM_PRODUCTION_RUNTIME_MS, RETAINED_RESOURCE_LIMIT, COMPUTE_LEDGER_INTERVAL_MS, prepaidState, utcPeriod } from './wallet.js';
export class PrepaidWallet extends SharedWallet {
  constructor(account, recharge) { super(account, recharge, { machineSize, centsPerComputeUnitHour: USAGE_PRICING.centsPerComputeUnitHour }); }
}
