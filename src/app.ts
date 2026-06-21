import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import type { Logger } from 'pino';
import type { StackContext } from './stack.js';
import type { Config } from './config.js';
import type { AppEnv } from './types.js';
import { authMiddleware } from './middleware/auth.js';
import { errorMiddleware } from './middleware/errors.js';
import { wellknownRoutes } from './routes/wellknown.js';
import { healthRoutes } from './routes/health.js';
import { recordRoutes } from './routes/records.js';
import { typeRoutes } from './routes/types.js';
import { attachmentRoutes } from './routes/attachments.js';
import { entityRoutes } from './routes/entity.js';
import { tokenRoutes } from './routes/tokens.js';

export type { AppEnv };

export function createApp(ctx: StackContext, config: Config, logger: Logger): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Assign a unique request ID to every request for log correlation.
  app.use(async (c, next) => {
    c.set('requestId', crypto.randomUUID());
    await next();
  });

  app.use(
    cors({
      origin: config.corsOrigins === '*' ? '*' : config.corsOrigins.split(',').map((s) => s.trim()),
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowHeaders: ['Authorization', 'Content-Type', 'Content-Disposition'],
      exposeHeaders: ['X-Request-Id', 'Content-Disposition'],
    }),
  );
  app.onError(errorMiddleware(logger));
  app.use(authMiddleware(config.ownerToken, ctx));

  // Cap JSON body size on all routes that accept JSON. Attachment uploads are
  // excluded here — they enforce their own limit via maxAttachmentBytes.
  const jsonBodyLimit = bodyLimit({
    maxSize: 1 * 1024 * 1024,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  });
  app.use('/records/*', jsonBodyLimit);
  app.use('/types/*', jsonBodyLimit);
  app.use('/tokens/*', jsonBodyLimit);
  app.use('/entity/*', jsonBodyLimit);

  app.route('/.well-known', wellknownRoutes(ctx));
  app.route('/health', healthRoutes());
  app.route('/records', recordRoutes(ctx));
  app.route('/types', typeRoutes(ctx));
  app.route('/attachments', attachmentRoutes(ctx, config.maxAttachmentBytes));
  app.route('/entity', entityRoutes(ctx));
  app.route('/tokens', tokenRoutes(ctx));

  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  return app;
}
