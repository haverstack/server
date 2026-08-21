/**
 * Query worker entry point. One of these owns a second (or third, ...)
 * LocalAdapter connection to the same stack.db as the main thread's.
 * That's legal against docs/spec/adapters.md's storage-ownership lock —
 * acquireLock() in @haverstack/sqlite-shared keys purely on process.pid,
 * and worker_threads share process.pid with the thread that spawned
 * them, so every worker's open() sees `ownedBySelf: true` — and legal
 * against SQLite itself, since WAL mode is built for exactly this:
 * multiple connections against one file, coordinated by the engine.
 *
 * Runs Stack.query()/ScopedStack.query() off the request thread per
 * docs/spec/wire-format.md § Bounding query cost, so a slow full-text
 * search blocks only this worker — the main thread stays free to accept
 * and answer other requests, and can terminate this worker outright if
 * the query outlives its deadline (see pool.ts).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { LocalAdapter } from '@haverstack/adapter-local';
import { Stack } from '@haverstack/core';
import { serializeError } from '@haverstack/wire-types';
import type { QueryRequest, QueryResponse, QueryWorkerInit } from './protocol.js';

if (!parentPort) {
  throw new Error('query worker must be run as a worker_thread, not the main thread');
}

const init = workerData as QueryWorkerInit;

// The database already exists — the main thread's initStack() created or
// opened it, and seeded system types, before any worker is spawned (see
// pool.ts). open() (not openOrInitialize()) reflects that: there is no
// first-run path to handle here.
const adapter = await LocalAdapter.open({ path: init.dbPath });
const stack = await Stack.create(adapter);

parentPort.on('message', async (req: QueryRequest) => {
  const port = parentPort!;
  try {
    const scoped = req.session ? stack.forSession(req.session) : stack.asEntity(null);
    const result = await scoped.query(req.query);
    port.postMessage({ id: req.id, ok: true, result } satisfies QueryResponse);
  } catch (err) {
    const wire = serializeError(err);
    port.postMessage({
      id: req.id,
      ok: false,
      wire,
      message: err instanceof Error ? err.message : String(err),
    } satisfies QueryResponse);
  }
});
