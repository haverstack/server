import type { Stack, ScopedStack } from '@haverstack/core';
import type { TokenSession } from '@haverstack/core/wire';

/**
 * The view every request is served through: a ScopedStack with
 * listBlobs() and head(), which GET /blobs and GET /head call. Optional on
 * ScopedStack, which has each exactly when its Stack does; this server's
 * stack has both, and scopeForSession() checks it.
 */
export type RequestScope = ScopedStack & Required<Pick<ScopedStack, 'listBlobs' | 'head'>>;

/**
 * The view a session is served through, or the anonymous one. Built here
 * and nowhere else: authMiddleware sets it once per request, createApp()
 * builds one at startup so a stack missing a method refuses to boot, and a
 * query worker, which a session reaches only as data, rebuilds it the same
 * way. See docs/spec/access-control.md § Serving requests.
 */
export function scopeForSession(stack: Stack, session: TokenSession | null): RequestScope {
  const scope = session ? stack.asActor(session) : stack.asEntity(null);
  if (!hasCopyOut(scope)) {
    throw new Error('This server needs a stack with listBlobs() and head() to serve a copy out');
  }
  return scope;
}

function hasCopyOut(scope: ScopedStack): scope is RequestScope {
  return typeof scope.listBlobs === 'function' && typeof scope.head === 'function';
}
