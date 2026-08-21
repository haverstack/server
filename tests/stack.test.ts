import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import { initStack } from '../src/stack.js';
import { testConfig, tempDbPath, logger, OTHER_ENTITY_ID } from './setup.js';

// A minimal stub, so the mock can't silently miss calls to unmocked
// methods that a full pino instance's prototype methods wouldn't survive a
// spread of. initStack() itself only calls logger.warn(), but the context
// it returns owns a QueryWorkerPool that logs errors on its own schedule —
// and an unstubbed method there surfaces as an uncaught TypeError from
// inside a worker event handler, not as a failed assertion.
function spyLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), error: vi.fn() } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
  };
}

// A second server process against the same DB_PATH must fail loudly at
// startup rather than corrupt or silently share the database — the native
// SQLite adapter's own storage-ownership lock (record-adapter-sqlite) is
// what enforces this; this test pins that the failure surfaces cleanly
// through initStack() rather than getting swallowed.
describe('initStack double-open protection', () => {
  let dbPath: string | undefined;
  afterEach(async () => {
    if (dbPath) await rm(dirname(dbPath), { recursive: true, force: true }).catch(() => {});
  });

  it('fails with an operator-legible message when the lock is held by another live process', async () => {
    dbPath = tempDbPath();
    const config = testConfig(dbPath);

    const ctx = await initStack(config, logger);
    await ctx.queryWorker.close();
    await ctx.stack.close();

    // Simulate another still-running process holding the lock: process.ppid
    // is guaranteed alive (it's this test runner's own parent) and is never
    // this process's own pid, so the lock check's same-pid bypass can't mask
    // the scenario being tested.
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: process.ppid }));

    // Second call finds the db already exists (openOrInitialize's open path)
    // and hits the same lock check LocalAdapter.open() always enforced.
    await expect(initStack(config, logger)).rejects.toThrow(/in use by another process/);
  });
});

describe('initStack bootstrap', () => {
  let dbPath: string | undefined;
  afterEach(async () => {
    if (dbPath) await rm(dirname(dbPath), { recursive: true, force: true }).catch(() => {});
  });

  it('fails clearly when initializing a new database without ENTITY_ID', async () => {
    dbPath = tempDbPath();
    const config = { ...testConfig(dbPath), entityId: null };

    await expect(initStack(config, logger)).rejects.toThrow(
      /ENTITY_ID is required when initializing a new database/,
    );
  });

  it('opens an existing database fine without ENTITY_ID set', async () => {
    dbPath = tempDbPath();
    const config = testConfig(dbPath);

    const ctx = await initStack(config, logger);
    await ctx.queryWorker.close();
    await ctx.stack.close();
    await ctx.tokens.close();
    ctx.nonces.close();

    const reopened = await initStack({ ...config, entityId: null }, logger);
    expect(reopened.stack.ownerEntityId).toBe(config.entityId);
    await reopened.queryWorker.close();
    await reopened.stack.close();
    await reopened.tokens.close();
    reopened.nonces.close();
  });

  it('warns but does not fail when ENTITY_ID no longer matches the stored owner', async () => {
    dbPath = tempDbPath();
    const config = testConfig(dbPath);

    const ctx = await initStack(config, logger);
    await ctx.queryWorker.close();
    await ctx.stack.close();
    await ctx.tokens.close();
    ctx.nonces.close();

    const warn = spyLogger();
    const mismatched = await initStack({ ...config, entityId: OTHER_ENTITY_ID }, warn);
    expect(mismatched.stack.ownerEntityId).toBe(config.entityId);
    expect(warn.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredEntityId: OTHER_ENTITY_ID,
        storedOwnerEntityId: config.entityId,
      }),
      expect.stringMatching(/does not match/),
    );
    await mismatched.queryWorker.close();
    await mismatched.stack.close();
    await mismatched.tokens.close();
    mismatched.nonces.close();
  });

  it('creates the owner _entity record when OWNER_NAME is configured', async () => {
    dbPath = tempDbPath();
    const config = { ...testConfig(dbPath), ownerName: 'Jane Owner', ownerHandle: '@jane' };

    const ctx = await initStack(config, logger);
    const { records } = await ctx.stack.query({
      filter: { typeId: '_entity@1', content: { did: ctx.stack.ownerEntityId } },
    });
    expect(records[0]?.content).toMatchObject({ name: 'Jane Owner', handle: '@jane' });
    await ctx.queryWorker.close();
    await ctx.stack.close();
    await ctx.tokens.close();
    ctx.nonces.close();
  });

  it('creates no owner _entity record when OWNER_NAME is unset', async () => {
    dbPath = tempDbPath();
    const config = testConfig(dbPath);

    const ctx = await initStack(config, logger);
    const { records } = await ctx.stack.query({
      filter: { typeId: '_entity@1', content: { did: ctx.stack.ownerEntityId } },
    });
    expect(records).toHaveLength(0);
    await ctx.queryWorker.close();
    await ctx.stack.close();
    await ctx.tokens.close();
    ctx.nonces.close();
  });
});
