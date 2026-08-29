import type { Logger } from 'pino';
import type { StackContext } from './stack.js';

/**
 * The subset of node-server's return value shutdown() needs. `close()`
 * mirrors Node's http.Server: it stops accepting new connections and waits
 * for open ones to end before invoking the callback. `closeAllConnections()`
 * (Node >=18.2) destroys every open connection immediately, which is what
 * makes a pending close() callback fire once the grace period expires.
 * Optional because node-server's `ServerType` also covers Http2Server, whose
 * @types/node surface omits it even though the app only ever serves HTTP/1.
 */
export type ShutdownServer = {
  close(callback: () => void): void;
  closeAllConnections?(): void;
};

/**
 * Builds the shutdown sequence: stop the server (bounded by `timeoutMs` so a
 * client holding a keep-alive connection open can't block it indefinitely),
 * then release the stack's resources. Does not call process.exit — callers
 * decide the exit code so this stays unit-testable.
 */
export function createShutdownHandler(
  server: ShutdownServer,
  ctx: StackContext,
  logger: Logger,
  timeoutMs: number,
): (signal: string) => Promise<void> {
  return async (signal: string) => {
    logger.info({ signal }, 'Shutting down');

    // Ends every open GET /changes connection up front — left open, a
    // change-feed stream never drains on its own, so server.close() below
    // would otherwise wait out the full grace period on every shutdown
    // rather than finishing as soon as ordinary requests complete.
    ctx.changeStreams.closeAll();
    // Closing the streams above does not release their buffers: a buffer
    // deliberately outlives its last connection so a reconnect can recover
    // what it missed, which on shutdown just means holding a subscription
    // nobody will ever read. Release them explicitly.
    ctx.resumeBuffers.closeAll();

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn({ timeoutMs }, 'Shutdown grace period exceeded; forcing connections closed');
        server.closeAllConnections?.();
      }, timeoutMs);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    await ctx.queryWorker.close();
    await ctx.stack.flush();
    await ctx.stack.close();
    await ctx.tokens.close();
    ctx.nonces.close();
    logger.info('Clean shutdown complete');
  };
}
