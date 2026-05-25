import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import type { StackContext } from '../stack.js';

export function wellknownRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/stack', (c) => {
    return c.json({
      version: '1.0',
      entityId: ctx.stack.ownerEntityId ?? '',
      timezone: ctx.stack.timezone,
      capabilities: ctx.stack.capabilities,
    });
  });

  return app;
}
