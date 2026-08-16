import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { initStack } from '../src/stack.js';
import { testConfig, tempDbPath } from './setup.js';

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

    const ctx = await initStack(config);
    await ctx.stack.close();

    // Simulate another still-running process holding the lock: process.ppid
    // is guaranteed alive (it's this test runner's own parent) and is never
    // this process's own pid, so the lock check's same-pid bypass can't mask
    // the scenario being tested.
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: process.ppid }));

    await expect(initStack({ ...config, isNewDb: false })).rejects.toThrow(
      /in use by another process/,
    );
  });
});
