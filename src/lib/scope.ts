import type { Stack, ScopedStack } from '@haverstack/core';
import type { TokenSession } from '@haverstack/core/wire';

/**
 * The view a session is served through, or the anonymous one. Built here
 * and nowhere else: authMiddleware sets it once per request, and a query
 * worker, which a session reaches only as data, rebuilds it the same way.
 * See docs/spec/access-control.md § Serving requests.
 */
export function scopeForSession(stack: Stack, session: TokenSession | null): ScopedStack {
  return session ? stack.asActor(session) : stack.asEntity(null);
}
