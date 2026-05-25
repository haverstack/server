import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import type { Logger } from 'pino';
import type { StackContext } from './stack.js';
import type { Config } from './config.js';
import { authMiddleware } from './middleware/auth.js';
import { errorMiddleware } from './middleware/errors.js';
import { wellknownRoutes } from './routes/wellknown.js';
import { healthRoutes } from './routes/health.js';
import { recordRoutes } from './routes/records.js';
import { typeRoutes } from './routes/types.js';
import { attachmentRoutes } from './routes/attachments.js';
import { entityRoutes } from './routes/entity.js';

export type AppEnv = {
  Variables: {
    auth: { entityId: string } | null;
    requestId: string;
  };
};

export function createApp(ctx: StackContext, config: Config, logger: Logger): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Global middleware
  app.use(requestId());
  app.use(
    cors({
      origin: config.corsOrigins === '*' ? '*' : config.corsOrigins.split(',').map((s) => s.trim()),
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowHeaders: ['Authorization', 'Content-Type'],
      exposeHeaders: ['X-Request-Id'],
    }),
  );
  app.use(errorMiddleware(logger));
  app.use(authMiddleware(config.tokens));

  // Routes
  app.route('/.well-known', wellknownRoutes(ctx));
  app.route('/health', healthRoutes());
  app.route('/records', recordRoutes(ctx));
  app.route('/types', typeRoutes(ctx));
  app.route('/attachments', attachmentRoutes(ctx));
  app.route('/entity', entityRoutes(ctx));

  // 404 fallback
  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  return app;
}
