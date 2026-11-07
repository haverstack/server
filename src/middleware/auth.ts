import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { StackPermissionError } from '@haverstack/core';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { wireError } from '../wireError.js';
import { scopeForSession } from '../lib/scope.js';
import type { RequestScope } from '../lib/scope.js';

/**
 * Constant-time string equality, for comparing a presented credential
 * against a configured secret. Exported so every comparison of the owner
 * token uses the same one — `GET /changes` re-derives "is this the owner"
 * to decide whether to arm its session re-check.
 */
export function safeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** The one 401 this server answers, for a missing or unusable credential. */
export const unauthorized = (c: Context<AppEnv>) =>
  wireError(c, 401, 'unauthorized', 'Missing or invalid bearer token');

export function authMiddleware(ownerToken: string, ctx: StackContext): MiddlewareHandler<AppEnv> {
  const { stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (header === undefined) {
      c.set('auth', null);
    } else if (!header.startsWith('Bearer ')) {
      // A credential that isn't a bearer token (`Basic ...`, a missing
      // space) is a 401, never a silent downgrade to anonymous.
      return unauthorized(c);
    } else {
      const token = header.slice(7);
      if (safeCompare(token, ownerToken)) {
        c.set('auth', { principalId: ownerEntityId, subjectId: ownerEntityId });
      } else {
        const session = await ctx.tokens.lookupToken(token);
        // Unknown, expired, or revoked is distinct from "none offered",
        // and must not read as anonymous on optional-auth routes.
        if (!session) return unauthorized(c);
        c.set('auth', session);
      }
    }
    c.set('scope', scopeForSession(stack, c.get('auth')));
    await next();
  };
}

/**
 * A route that needs a session: 401 without one, and then `check`, if
 * any, of the session's scope. The one place this server refuses on
 * authentication.
 */
function sessionGate(check?: (scope: RequestScope) => void): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get('auth')) return unauthorized(c);
    check?.(c.get('scope'));
    await next();
  };
}

/** A session is required; what it may do is ScopedStack's to decide. */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  return sessionGate();
}

/**
 * Gates one of this server's own surfaces — token management, the owner's
 * review of install requests — to the owner acting alone. No StackClient
 * verb serves these, so the route acts on core's answer to the standing,
 * ScopedStack.ownerActingAlone, rather than being refused by it. Routes
 * that serve a StackClient verb leave the refusal to ScopedStack.
 * See docs/spec/access-control.md § Serving requests.
 */
export function requireOwner(): MiddlewareHandler<AppEnv> {
  return sessionGate((scope) => {
    if (!scope.ownerActingAlone) throw new StackPermissionError('Owner access required');
  });
}
