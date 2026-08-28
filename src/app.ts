import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { StackPayloadTooLargeError } from '@haverstack/core';
import type { Logger } from 'pino';
import type { StackContext } from './stack.js';
import type { Config } from './config.js';
import type { AppEnv } from './types.js';
import { authMiddleware } from './middleware/auth.js';
import { errorMiddleware } from './middleware/errors.js';
import { wellknownRoutes } from './routes/wellknown.js';
import { healthRoutes } from './routes/health.js';
import { recordRoutes } from './routes/records.js';
import { changeRoutes } from './routes/changes.js';
import { typeRoutes } from './routes/types.js';
import { attachmentRoutes } from './routes/attachments.js';
import { entityRoutes } from './routes/entity.js';
import { tokenRoutes } from './routes/tokens.js';
import { authRoutes } from './routes/auth.js';
import { wireError } from './wireError.js';

export type { AppEnv };

export function createApp(ctx: StackContext, config: Config, logger: Logger): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Assign a unique request ID to every request and expose it on the response.
  app.use(async (c, next) => {
    const id = crypto.randomUUID();
    c.set('requestId', id);
    await next();
    c.header('X-Request-Id', id);
  });

  app.use(
    cors({
      origin:
        config.corsOrigins === '*'
          ? '*'
          : config.corsOrigins
            ? config.corsOrigins.split(',').map((s) => s.trim())
            : [],
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      // Last-Event-ID: a browser client resuming GET /changes sends it as a
      // plain request header (fetch, not EventSource, per the feed's own
      // no-token-in-the-URL rule) — omitted from the preflight allowlist,
      // a cross-origin resume attempt never reaches the route that answers
      // it with `reset`.
      allowHeaders: ['Authorization', 'Content-Type', 'Content-Disposition', 'Last-Event-ID'],
      exposeHeaders: ['X-Request-Id', 'Content-Disposition'],
    }),
  );
  app.onError(errorMiddleware(logger, ctx.stack));
  app.use(authMiddleware(config.ownerToken, ctx));

  // Cap request body size globally — not per-prefix, so a route added later
  // (e.g. auth endpoints) can't silently end up with no limit at all. The
  // one exception is POST /attachments, which enforces its own, larger
  // ceiling via maxAttachmentBytes; running this limit ahead of that one
  // would reject legitimate uploads before the upload-specific check ever
  // runs. Thrown as a StackError, like every other Stack-domain failure,
  // rather than hand-built via wireError() — errorMiddleware/serializeError()
  // produces the conforming { error: { code, message } } body from it.
  const jsonBodyLimit = bodyLimit({
    maxSize: config.maxContentBytes,
    onError: () => {
      throw new StackPayloadTooLargeError(
        `Request body exceeds the ${config.maxContentBytes}-byte limit`,
      );
    },
  });
  app.use('*', async (c, next) => {
    if (c.req.method === 'POST' && c.req.path === '/attachments') return next();
    return jsonBodyLimit(c, next);
  });

  app.route('/.well-known', wellknownRoutes(ctx, config));
  app.route('/health', healthRoutes());
  app.route('/records', recordRoutes(ctx, config.queryTimeoutMs));
  app.route('/changes', changeRoutes(ctx, config));
  app.route('/types', typeRoutes(ctx));
  app.route('/attachments', attachmentRoutes(ctx, config.maxAttachmentBytes));
  app.route('/entity', entityRoutes(ctx));
  app.route('/tokens', tokenRoutes(ctx));
  app.route('/auth', authRoutes(ctx, config.authOrigin, logger));

  app.notFound((c) => wireError(c, 404, 'not_found', 'Not found'));

  return app;
}
