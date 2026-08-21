import { describe, it, expect, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createApp } from '../../src/app.js';
import type { StackContext } from '../../src/stack.js';
import { createTestContext, testConfig, tempDbPath, logger, req } from '../setup.js';

/**
 * Covers docs/spec/wire-format.md § Bounding query cost: a query that
 * outlives its deadline answers 503 `timeout`, and — the part a shared,
 * synchronous-in-process adapter can't otherwise offer — the server goes
 * on serving other requests afterward rather than staying wedged behind
 * the slow one. See src/lib/queryWorker/pool.ts.
 */
describe('Query worker deadline', () => {
  let dbPath: string;
  let ctx: StackContext;

  afterEach(async () => {
    await ctx.queryWorker.close();
    await ctx.stack.close();
    await ctx.tokens.close();
    ctx.nonces.close();
    await rm(dirname(dbPath), { recursive: true, force: true }).catch(() => {});
  });

  it('answers 503 timeout when the deadline is exceeded, and keeps serving after', async () => {
    dbPath = tempDbPath();
    ctx = await createTestContext(dbPath);

    // A 1ms deadline is exceeded by any real query — spawning/dispatching
    // to a worker alone takes longer — so this is deterministic without
    // needing a slow query to actually construct.
    const impatientApp = createApp(ctx, { ...testConfig(dbPath), queryTimeoutMs: 1 }, logger);
    const timedOut = await req(impatientApp, 'GET', '/records');
    expect(timedOut.status).toBe(503);
    expect((timedOut.data as { error: { code: string } }).error.code).toBe('timeout');

    // Same underlying queryWorker pool, a normal deadline this time: the
    // worker the timeout terminated must have been replaced, not left
    // wedging the pool for every query dispatched after it.
    const patientApp = createApp(ctx, testConfig(dbPath), logger);
    const ok = await req(patientApp, 'GET', '/records');
    expect(ok.status).toBe(200);
    expect((ok.data as { records: unknown[] }).records).toEqual([]);

    // Never routed through the worker at all — just confirms the rest of
    // the app stayed responsive throughout.
    const health = await req(patientApp, 'GET', '/health');
    expect(health.status).toBe(200);
  });

  it('rejects new work once closed, and tolerates being closed twice', async () => {
    dbPath = tempDbPath();
    ctx = await createTestContext(dbPath);
    await ctx.queryWorker.close();
    await expect(ctx.queryWorker.query(null, {}, 1000)).rejects.toThrow(/closed/i);
    // afterEach calls close() again — must be a no-op, not a throw.
  });
});
