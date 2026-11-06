import type { Stack, ScopedStack } from '@haverstack/core';
import type { TokenSession } from '@haverstack/core/wire';

/**
 * The view a request is served through: the session's, or the anonymous
 * one. ScopedStack decides every request a session makes of the stack, so
 * a route asks it rather than deciding ownership or permission itself.
 * See docs/spec/access-control.md § Serving requests.
 */
export function scopeFor(stack: Stack, auth: TokenSession | null): ScopedStack {
  return auth ? stack.asActor(auth) : stack.asEntity(null);
}
