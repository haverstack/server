/**
 * Stand-in for src/lib/queryWorker/worker.ts that blocks on command, so
 * pool behavior can be tested against controlled timing rather than
 * inferred from how long a real search happens to take.
 *
 * `filter.search === '__block__'` blocks the thread outright via
 * Atomics.wait — the closest honest simulation of node:sqlite's
 * uncancellable synchronous call, and unlike a spin loop it costs no CPU
 * while the test waits for the deadline to fire.
 */
import { parentPort } from 'node:worker_threads';
import type { QueryRequest, QueryResponse } from '../../src/lib/queryWorker/protocol.js';

if (!parentPort) throw new Error('fixture worker must run as a worker_thread');
const port = parentPort;

port.on('message', (req: QueryRequest) => {
  if ((req.query.filter as { search?: string } | undefined)?.search === '__block__') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return; // unreachable: only terminate() ends the wait
  }
  port.postMessage({
    id: req.id,
    ok: true,
    result: { records: [], cursor: null, total: null },
  } satisfies QueryResponse);
});
