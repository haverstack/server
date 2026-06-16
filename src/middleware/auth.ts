import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';

export function authMiddleware(ownerToken: string, ctx: StackContext): MiddlewareHandler<AppEnv> {
  const ownerEntityId = ctx.stack.ownerEntityId;

  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7);
      if (token === ownerToken) {
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
