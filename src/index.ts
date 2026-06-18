import { serve } from '@hono/node-server';
import pino from 'pino';
import { loadConfig } from './config.js';
import { initStack } from './stack.js';
import { createApp } from './app.js';

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

async function main() {
  const config = loadConfig();
  const ctx = await initStack(config);
  const app = createApp(ctx, config, logger);

  logger.info({ dbPath: config.dbPath, isNewDb: config.isNewDb }, 'Stack initialized');

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port }, 'Server listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await ctx.stack.flush();
      await ctx.stack.close();
      logger.info('Clean shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
