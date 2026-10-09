export const PRODUCTION_LEASE_MS = 5 * 60_000;
export const PRODUCTION_POLL_MS = 30_000;
export const PRODUCTION_INACTIVITY_MS = 6 * 60 * 60_000;
export const validLifecycle = value => value === 'ad_hoc' || value === 'production';
export const validStartupCommand = value => typeof value === 'string' && value.length <= 4096 && !/[\u0000\r\n]/.test(value);

// The command and log path are positional shell arguments, never interpolated
// into shell code. PID 1 supervises a foreground app with bounded backoff.
export function productionEntrypoint(command, logPath = '/tmp/mainbrella-production.log') {
  if (!command) return ['sleep', 'infinity'];
  return ['sh', '-c', `delay=1
trap 'kill -TERM "$child" 2>/dev/null; exit' TERM INT
while :; do
  sh -lc "$1" >>"$2" 2>&1 & child=$!
  wait "$child"
  sleep "$delay" & child=$!
  wait "$child"
  delay=$((delay * 2))
  if [ "$delay" -gt 60 ]; then delay=60; fi
done`, 'mainbrella-production', command, logPath];
}
