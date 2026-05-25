import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';
import type { AppEnv } from '../app.js';

export function errorMiddleware(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      logger.error({ err, requestId: c.get('requestId') }, 'Unhandled request error');
      return c.json({ error: 'Internal server error' }, 500);
    }
  };
}
