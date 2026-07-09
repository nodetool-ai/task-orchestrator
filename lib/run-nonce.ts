let nonceCounter = 0;

/**
 * Process-local claim nonce with enough entropy to remain unique across
 * container restarts. PID is commonly 1 in containers, so a bare
 * `${pid}-${counter}` would repeat and a stale row's leftover container name
 * could collide with a newly provisioned worker.
 */
export function runNonce(): string {
  nonceCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${process.pid}-${Date.now().toString(36)}-${nonceCounter}-${rand}`;
}
