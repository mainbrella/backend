// Persisted wallets and accounting checkpoints use this historical scale.
// Changing a product's price must never reinterpret existing wallet balances.
export const UNIT_MS_PER_CENT = 1800000;
export const validSpendLimit = value => Number.isSafeInteger(value) && value >= 500 && value <= 100000;
