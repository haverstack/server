import { describe, it, expect, afterEach, vi } from 'vitest';
import { StackTimeoutError } from '@haverstack/core';
import type { Logger } from 'pino';
import { QueryWorkerPool } from '../../src/lib/queryWorker/pool.js';

/**
 * Pool-level behavior, driven through fixture workers (tests/fixtures/)
 * whose timing the test controls. tests/lib/queryWorker.test.ts covers
 * the same boundary end-to-end over HTTP; this file covers the parts that
 * only show up under contention and failure, where inferring behavior
 * from real query latency would be guesswork.
 */
const blockingWorkerUrl = new URL('../fixtures/blockingWorker.ts', import.meta.url);
const brokenWorkerUrl = new URL('../fixtures/brokenWorker.ts', import.meta.url);

/** A query the fixture worker blocks on forever, until terminated. */
const BLOCKING = { filter: { search: '__block__' } };

function stubLogger(): Logger & { errorCount: () => number } {
  const error = vi.fn();
  const logger = { error, info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger;
  return Object.assign(logger, { errorCount: () => error.mock.calls.length });
}

let pool: QueryWorkerPool | null = null;

afterEach(async () => {
  await pool?.close();
  pool = null;
});

describe('QueryWorkerPool — execution deadline', () => {
  it('terminates a blocked query at the deadline and keeps serving on a fresh worker', async () => {
    pool = new QueryWorkerPool({
      init: { dbPath: '/unused-by-fixture' },
      poolSize: 1,
      queueLimit: 16,
      logger: stubLogger(),
      workerUrl: blockingWorkerUrl,
    });

    await expect(pool.query(null, BLOCKING, 300)).rejects.toBeInstanceOf(StackTimeoutError);

    // The blocked worker was terminated and replaced, not left holding the
    // only slot in the pool.
    await expect(pool.query(null, {}, 2000)).resolves.toMatchObject({ records: [] });
  });
});

describe('QueryWorkerPool — queueing is slow, not fatal', () => {
  it('does not spend a queued deadline while the request waits for a slot', async () => {
    pool = new QueryWorkerPool({
      init: { dbPath: '/unused-by-fixture' },
      poolSize: 1,
      queueLimit: 16,
      logger: stubLogger(),
      workerUrl: blockingWorkerUrl,
    });

    // Occupies the only slot in the pool for a full 400ms deadline.
    const blocked = pool.query(null, BLOCKING, 400);
    // Queued behind it with a 400ms deadline of its own. If that clock ran
    // from acceptance — as it would if queue wait counted against the
    // budget — this would time out at ~400ms having never reached a
    // worker. It must instead wait, then run, then succeed.
    const queued = pool.query(null, {}, 400);

    await expect(blocked).rejects.toBeInstanceOf(StackTimeoutError);
    await expect(queued).resolves.toMatchObject({ records: [] });
  });

  it('sheds load with a retryable timeout once the queue is full', async () => {
    pool = new QueryWorkerPool({
      init: { dbPath: '/unused-by-fixture' },
      poolSize: 1,
      queueLimit: 1,
      logger: stubLogger(),
      workerUrl: blockingWorkerUrl,
    });

    const blocked = pool.query(null, BLOCKING, 400); // takes the slot
    const queued = pool.query(null, {}, 2000); // fills the queue (limit 1)
    // Third request has nowhere to go: rejected up front rather than
    // growing the queue without bound.
    await expect(pool.query(null, {}, 2000)).rejects.toThrow(/queue is full/i);
    await expect(pool.query(null, {}, 2000)).rejects.toBeInstanceOf(StackTimeoutError);

    await expect(blocked).rejects.toBeInstanceOf(StackTimeoutError);
    await expect(queued).resolves.toMatchObject({ records: [] });
  });
});

describe('QueryWorkerPool — a worker that cannot boot', () => {
  it('backs off instead of respawning forever, and reports the real cause', async () => {
    const logger = stubLogger();
    pool = new QueryWorkerPool({
      init: { dbPath: '/unused-by-fixture' },
      poolSize: 1,
      queueLimit: 16,
      logger,
      workerUrl: brokenWorkerUrl,
    });

    // Backoff is 100/200/400/800/1600ms, then the pool marks itself
    // unhealthy and stops hot-respawning. Without it this loop respawned
    // as fast as a thread could be created — ~19 times in 3s, forever.
    await new Promise((r) => setTimeout(r, 1500));
    expect(logger.errorCount()).toBeLessThanOrEqual(6);

    // A standing spawn fault surfaces as itself, not as a pile of
    // deadline timeouts that hide the cause.
    await expect(pool.query(null, {}, 5000)).rejects.toThrow(/__fixture_boot_failure__/);
  });
});

describe('QueryWorkerPool — lifecycle', () => {
  it('rejects new work once closed, and tolerates being closed twice', async () => {
    pool = new QueryWorkerPool({
      init: { dbPath: '/unused-by-fixture' },
      poolSize: 1,
      queueLimit: 16,
      logger: stubLogger(),
      workerUrl: blockingWorkerUrl,
    });
    await pool.close();
    await expect(pool.query(null, {}, 1000)).rejects.toThrow(/closed/i);
    // afterEach closes again — must be a no-op, not a throw.
  });
});
