import { serve } from '@hono/node-server';
import pino from 'pino';
import { loadConfig } from './config.js';
import { initStack, type StackContext } from './stack.js';
import { createApp } from './app.js';
import { createShutdownHandler } from './shutdown.js';

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

// Set once initStack() resolves, so the fatal-error handler below can flush
// a crash that happens after startup. Undefined before then: nothing to
// flush yet.
let ctx: StackContext | undefined;

async function main() {
  const config = loadConfig();
  ctx = await initStack(config, logger);
  const app = createApp(ctx, config, logger);

  logger.info({ dbPath: config.dbPath }, 'Stack initialized');

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port }, 'Server listening');
  });

  const shutdown = createShutdownHandler(server, ctx, logger, config.shutdownTimeoutMs);
  const onSignal = (signal: string) => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

main().catch(async (err) => {
  logger.error({ err }, 'Fatal startup error');
  if (ctx) {
    await ctx.stack.flush().catch((flushErr) => {
      logger.error({ err: flushErr }, 'Failed to flush during fatal-error shutdown');
    });
  }
  process.exit(1);
});
