import type { MiddlewareHandler } from 'hono';
import type { TokenConfig } from '../config.js';
import type { AppEnv } from '../app.js';

export function authMiddleware(tokens: TokenConfig[]): MiddlewareHandler<AppEnv> {
  const tokenMap = new Map<string, string>(tokens.map((t) => [t.token, t.entityId]));

  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7);
      const entityId = tokenMap.get(token);
      c.set('auth', entityId ? { entityId } : null);
    } else {
      c.set('auth', null);
    }
    await next();
  };
}

export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get('auth')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  };
}
