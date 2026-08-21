/**
 * Main-thread side of the query worker boundary. Owns a small, fixed-size
 * pool of workers (src/lib/queryWorker/worker.ts), each with its own
 * LocalAdapter connection to the same stack.db, and dispatches
 * ScopedStack.query() calls to them with a per-request deadline.
 *
 * node:sqlite exposes no `sqlite3_interrupt` equivalent (checked against
 * Node 22's DatabaseSync — its prototype has no interrupt method), so a
 * query that outlives its deadline can't be cancelled in place. The only
 * lever is termination: the pool answers the caller with StackTimeoutError
 * the moment the deadline passes, then best-effort terminates the worker
 * that was running it and replaces it, so a stuck query costs one worker
 * slot rather than wedging the pool. Terminating mid-write is safe —
 * SQLite's WAL journaling means an uncommitted transaction is simply
 * absent after the file is reopened (see docs/spec/adapters.md's
 * snapshot-then-mutate recovery, which already assumes a writer can die
 * mid-transaction) — but query() is the only method routed through this
 * pool today; see the module doc in src/routes/records.ts for why writes
 * and by-id reads stay on the main thread.
 */
import { Worker } from 'node:worker_threads';
import type { StackQuery, QueryResult, TokenSession } from '@haverstack/core';
import { StackTimeoutError } from '@haverstack/core';
import { deserializeError } from '@haverstack/wire-types';
import type { Logger } from 'pino';
import type { QueryRequest, QueryResponse, QueryWorkerInit } from './protocol.js';

// import.meta.url ends in .ts under tsx (dev) and vitest (test), and in
// .js once tsc has compiled this file into dist/ — so which worker file
// and loader to use falls out of how *this* module was loaded, with no
// separate NODE_ENV check to keep in sync.
const RUNNING_FROM_SOURCE = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(RUNNING_FROM_SOURCE ? './worker.ts' : './worker.js', import.meta.url);
const WORKER_EXEC_ARGV = RUNNING_FROM_SOURCE ? ['--import', 'tsx'] : [];

type Pending = {
  resolve: (result: QueryResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

type Slot = {
  worker: Worker;
  /** id of the request currently running on this worker, or null if idle. */
  busyWith: number | null;
};

export class QueryWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly pending = new Map<number, Pending>();
  /** FIFO of requests waiting for a slot to free up. */
  private readonly waiting: Array<{ id: number; req: QueryRequest }> = [];
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly init: QueryWorkerInit,
    private readonly poolSize: number,
    private readonly logger: Logger,
  ) {
    for (let i = 0; i < poolSize; i++) this.slots.push(this.spawnSlot());
  }

  private spawnSlot(): Slot {
    const worker = new Worker(WORKER_URL, { workerData: this.init, execArgv: WORKER_EXEC_ARGV });
    const slot: Slot = { worker, busyWith: null };
    worker.on('message', (msg: QueryResponse) => this.handleMessage(slot, msg));
    worker.on('error', (err: Error) => this.handleWorkerDeath(slot, err));
    worker.on('exit', (code) => {
      if (!this.closed && code !== 0) {
        this.handleWorkerDeath(slot, new Error(`query worker exited with code ${code}`));
      }
    });
    return slot;
  }

  private handleMessage(slot: Slot, msg: QueryResponse): void {
    slot.busyWith = null;
    const pending = this.pending.get(msg.id);
    // Already timed out (and rejected) before the worker answered — the
    // late reply just frees the slot, above.
    if (pending) {
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(msg.wire ? deserializeError(msg.wire.body) : new Error(msg.message));
    }
    this.drainWaiting(slot);
  }

  /** A worker crashed or exited unexpectedly — not a deadline timeout, which handles its own replacement. */
  private handleWorkerDeath(slot: Slot, err: Error): void {
    const failedId = slot.busyWith;
    if (failedId !== null) {
      const pending = this.pending.get(failedId);
      if (pending) {
        this.pending.delete(failedId);
        clearTimeout(pending.timer);
        pending.reject(err);
      }
    }
    this.logger.error({ err }, 'Query worker died unexpectedly; replacing it');
    this.replaceSlot(slot);
  }

  private replaceSlot(slot: Slot): void {
    const idx = this.slots.indexOf(slot);
    if (idx === -1) return; // already replaced (e.g. closed)
    slot.worker.removeAllListeners();
    void slot.worker.terminate().catch(() => {});
    this.slots[idx] = this.spawnSlot();
    this.drainWaiting(this.slots[idx]);
  }

  private drainWaiting(slot: Slot): void {
    if (slot.busyWith !== null || this.closed) return;
    const next = this.waiting.shift();
    if (!next) return;
    // The request may have already timed out while queued.
    if (!this.pending.has(next.id)) return this.drainWaiting(slot);
    slot.busyWith = next.id;
    slot.worker.postMessage(next.req);
  }

  private dispatch(req: QueryRequest): void {
    const idle = this.slots.find((s) => s.busyWith === null);
    if (idle) {
      idle.busyWith = req.id;
      idle.worker.postMessage(req);
    } else {
      this.waiting.push({ id: req.id, req });
    }
  }

  /**
   * Run a query on the pool, honoring `deadlineMs` from the moment it's
   * accepted here (queue wait counts against the budget, not just
   * execution) — a request that never reaches a worker before its
   * deadline is answered from the queue, without ever touching one.
   */
  query(
    session: TokenSession | null,
    stackQuery: StackQuery,
    deadlineMs: number,
  ): Promise<QueryResult> {
    if (this.closed) return Promise.reject(new Error('Query worker pool is closed'));
    const id = this.nextId++;
    const req: QueryRequest = { id, session, query: stackQuery };
    return new Promise<QueryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new StackTimeoutError(`Query exceeded the ${deadlineMs}ms deadline`));
        const slot = this.slots.find((s) => s.busyWith === id);
        if (slot) this.replaceSlot(slot);
        else {
          // Still queued, never dispatched — drop it from the waiting list.
          const wIdx = this.waiting.findIndex((w) => w.id === id);
          if (wIdx !== -1) this.waiting.splice(wIdx, 1);
        }
      }, deadlineMs);
      this.pending.set(id, { resolve, reject, timer });
      this.dispatch(req);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Query worker pool is closing'));
    }
    this.pending.clear();
    this.waiting.length = 0;
    await Promise.all(
      this.slots.map((slot) => {
        slot.worker.removeAllListeners();
        return slot.worker.terminate();
      }),
    );
  }
}
