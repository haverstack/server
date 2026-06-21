import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';

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
        if (!ownerEntityId) {
          return c.json({ error: 'Server misconfiguration: owner entity not set' }, 500);
        }
        c.set('auth', { entityId: ownerEntityId });
      } else {
        const result = await ctx.adapter.lookupToken(token);
        c.set('auth', result ? { entityId: result.entityId } : null);
      }
    } else {
      c.set('auth', null);
    }
    await next();
  };
}

export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get('auth')) return c.json({ error: 'Unauthorized' }, 401);
    await next();
  };
}

export function requireOwner(ownerEntityId: string | null): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    if (!ownerEntityId || auth.entityId !== ownerEntityId)
      return c.json({ error: 'Forbidden' }, 403);
    await next();
  };
}
