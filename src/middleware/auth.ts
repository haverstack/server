import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { StackPermissionError } from '@haverstack/core';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { wireError } from '../wireError.js';

function safeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function authMiddleware(ownerToken: string, ctx: StackContext): MiddlewareHandler<AppEnv> {
  const ownerEntityId = ctx.stack.ownerEntityId;

  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7);
      if (safeCompare(token, ownerToken)) {
        c.set('auth', { principalId: ownerEntityId, subjectId: ownerEntityId });
      } else {
        const session = await ctx.tokens.lookupToken(token);
        c.set('auth', session);
      }
    } else {
      c.set('auth', null);
    }
    await next();
  };
}

export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get('auth')) return wireError(c, 401, 'unauthorized', 'Missing or invalid bearer token');
    await next();
  };
}

/**
 * Gates a route to the owner acting alone. Being the owner is never on its
 * own sufficient under delegation — a delegated session with the owner as
 * principal is still refused, matching `ScopedStack`'s own owner-only gates
 * (e.g. hard delete). See docs/spec/access-control.md § Delegation.
 */
export function requireOwner(ownerEntityId: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return wireError(c, 401, 'unauthorized', 'Missing or invalid bearer token');
    const ownerActingAlone = auth.principalId === ownerEntityId && auth.subjectId === ownerEntityId;
    if (!ownerActingAlone) throw new StackPermissionError('Owner access required');
    await next();
  };
}
