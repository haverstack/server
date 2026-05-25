import { Hono } from 'hono';
import type { AppEnv } from '../app.js';

export function healthRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

  return app;
}
