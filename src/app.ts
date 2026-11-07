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
import { blobRoutes } from './routes/blobs.js';
import { headRoutes } from './routes/head.js';
import { entityRoutes } from './routes/entity.js';
import { tokenRoutes } from './routes/tokens.js';
import { authRoutes } from './routes/auth.js';
import { installRoutes } from './routes/installs.js';
import { wireError } from './wireError.js';

export type { AppEnv };

export function createApp(ctx: StackContext, config: Config, logger: Logger): Hono<AppEnv> {
  // GET /blobs and GET /head are always served, and advertised, as installs
  // and the change feed are: the stack this server builds has both methods,
  // and this is the one place that is checked. Each request's ScopedStack
  // has each exactly when this Stack does, so the routes call it with `!`.
  // See docs/spec/wire-format.md § Blobs and § Head.
  if (!ctx.stack.listBlobs || !ctx.stack.head) {
    throw new Error('This server needs a stack with listBlobs() and head() to serve a copy out');
  }
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
      // Last-Event-ID: a browser resuming GET /changes sends it as a plain
      // header (fetch, not EventSource, per the feed's no-token-in-the-URL
      // rule). Omitted here, a cross-origin resume never reaches the route
      // that would answer it with `reset`.
      allowHeaders: ['Authorization', 'Content-Type', 'Content-Disposition', 'Last-Event-ID'],
      exposeHeaders: ['X-Request-Id', 'Content-Disposition'],
    }),
  );
  app.onError(errorMiddleware(logger, ctx.stack));
  app.use(authMiddleware(config.ownerToken, ctx));

  // Global rather than per-prefix, so a route added later can't end up with
  // no limit at all. POST /attachments is the one exception: it enforces its
  // own, larger ceiling, and running this one first would reject legitimate
  // uploads before that check ran. Thrown as a StackError so
  // errorMiddleware produces the conforming body, like any other failure.
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
  app.route('/changes', changeRoutes(ctx, config, logger));
  app.route('/types', typeRoutes());
  app.route('/attachments', attachmentRoutes(ctx, config.maxAttachmentBytes));
  app.route('/blobs', blobRoutes());
  app.route('/head', headRoutes());
  app.route('/entity', entityRoutes());
  app.route('/tokens', tokenRoutes(ctx));
  app.route('/auth', authRoutes(ctx, config.authOrigin, logger));
  app.route('/installs', installRoutes(ctx));

  app.notFound((c) => wireError(c, 404, 'not_found', 'Not found'));

  return app;
}
