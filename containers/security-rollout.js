// Account IDs come from authenticated control-plane ownership, never guest headers.
// An empty or malformed rollout denies access. '*' is an explicit public rollout.
export function securityAccountEnabled(env, userId) {
  const value = env.SECURITY_FEATURE_ACCOUNTS;
  if (typeof value !== 'string' || value.length > 16384) return false;
  const selection = value.trim();
  if (selection === '*') return true;
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return false;
  const accounts = selection.split(',').map(account => account.trim());
  return accounts.length <= 100 && accounts.every(account => /^[A-Za-z0-9_-]{1,128}$/.test(account)) && accounts.includes(userId);
}
