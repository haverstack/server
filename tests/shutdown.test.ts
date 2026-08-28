import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';
import type { StackContext } from '../src/stack.js';
import { createShutdownHandler, type ShutdownServer } from '../src/shutdown.js';
import { ChangeStreamRegistry } from '../src/lib/changeStreams.js';

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function fakeCtx(): StackContext {
  return {
    adapter: {} as StackContext['adapter'],
    stack: {
      flush: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as StackContext['stack'],
    tokens: { close: vi.fn().mockResolvedValue(undefined) } as unknown as StackContext['tokens'],
    nonces: { close: vi.fn() } as unknown as StackContext['nonces'],
    queryWorker: {
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as StackContext['queryWorker'],
    changeStreams: new ChangeStreamRegistry(),
  };
}

describe('createShutdownHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the full cleanup sequence once close() finishes on its own', async () => {
    const closeAllConnections = vi.fn();
    const server: ShutdownServer = { close: (cb) => cb(), closeAllConnections };
    const ctx = fakeCtx();

    await createShutdownHandler(server, ctx, fakeLogger(), 10_000)('SIGTERM');

    expect(closeAllConnections).not.toHaveBeenCalled();
    expect(ctx.queryWorker.close).toHaveBeenCalled();
    expect(ctx.stack.flush).toHaveBeenCalled();
    expect(ctx.stack.close).toHaveBeenCalled();
    expect(ctx.tokens.close).toHaveBeenCalled();
    expect(ctx.nonces.close).toHaveBeenCalled();
  });

  it('does not force connections closed if close() finishes just under the deadline', async () => {
    const closeAllConnections = vi.fn();
    let closeCallback: (() => void) | undefined;
    const server: ShutdownServer = {
      close: (cb) => {
        closeCallback = cb;
      },
      closeAllConnections,
    };
    const ctx = fakeCtx();

    const done = createShutdownHandler(server, ctx, fakeLogger(), 10_000)('SIGTERM');
    closeCallback?.();
    await done;

    expect(closeAllConnections).not.toHaveBeenCalled();
    expect(ctx.queryWorker.close).toHaveBeenCalled();
  });

  it('forces connections closed once the deadline elapses, then still finishes cleanup', async () => {
    // Simulates a real server: destroying the sockets is what lets the
    // pending close() callback finally fire.
    let closeCallback: (() => void) | undefined;
    const closeAllConnections = vi.fn(() => closeCallback?.());
    const server: ShutdownServer = {
      close: (cb) => {
        closeCallback = cb;
      },
      closeAllConnections,
    };
    const ctx = fakeCtx();
    const logger = fakeLogger();

    const done = createShutdownHandler(server, ctx, logger, 10_000)('SIGTERM');
    await vi.advanceTimersByTimeAsync(10_000);
    await done;

    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
    expect(ctx.queryWorker.close).toHaveBeenCalled();
    expect(ctx.stack.flush).toHaveBeenCalled();
  });

  it('closes every open change-feed stream before waiting on server.close()', async () => {
    const server: ShutdownServer = { close: (cb) => cb() };
    const ctx = fakeCtx();
    const closeStream = vi.fn();
    ctx.changeStreams.add(closeStream);

    await createShutdownHandler(server, ctx, fakeLogger(), 10_000)('SIGTERM');

    expect(closeStream).toHaveBeenCalled();
  });

  it('tolerates a server with no closeAllConnections (e.g. Http2Server typings)', async () => {
    let closeCallback: (() => void) | undefined;
    const server: ShutdownServer = {
      close: (cb) => {
        closeCallback = cb;
      },
    };
    const ctx = fakeCtx();

    const done = createShutdownHandler(server, ctx, fakeLogger(), 10_000)('SIGTERM');
    await vi.advanceTimersByTimeAsync(10_000);
    closeCallback?.();
    await done;

    expect(ctx.queryWorker.close).toHaveBeenCalled();
  });
});
