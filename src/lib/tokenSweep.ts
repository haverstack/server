import type { Logger } from 'pino';
import type { StackTokenStore } from '@haverstack/core/wire';

// Once an hour at most. The sweep is O(n) in tokens ever issued — cheap
// relative to that interval, and never on the hot path twice in a row.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Delete tokens past their `expiresAt`.
 *
 * `lookupToken()` already refuses an expired token, so this changes no
 * authorization outcome — it reclaims rows. Nothing else does: the store
 * deletes only on an explicit `revokeToken()`, so before the DID handshake
 * an abandoned token sat there forever and that was tolerable, because only
 * the owner could mint one. `POST /auth/token` is unauthenticated, so the
 * row count is now driven by strangers, and unbounded growth is both a disk
 * cost and a slow read for every `listTokens()` caller.
 *
 * Returns a throttled sweep — call it freely; it runs at most once per
 * interval and never rejects, since failing to reclaim rows must not fail
 * the request that happened to trigger it.
 */
export function createExpiredTokenSweeper(
  tokens: StackTokenStore,
  logger: Logger,
): () => Promise<void> {
  let lastSweptAt = 0;
  return async () => {
    const now = Date.now();
    if (now - lastSweptAt < SWEEP_INTERVAL_MS) return;
    // Claimed before the await, so two concurrent requests can't both start
    // a sweep and race each other's revokeToken() calls.
    lastSweptAt = now;
    try {
      const all = await tokens.listTokens();
      const expired = all.filter((t) => t.expiresAt !== undefined && t.expiresAt.getTime() <= now);
      for (const t of expired) await tokens.revokeToken(t.id);
      if (expired.length > 0) {
        logger.info({ revoked: expired.length }, 'Swept expired tokens');
      }
    } catch (err) {
      logger.warn({ err }, 'Expired-token sweep failed');
    }
  };
}
