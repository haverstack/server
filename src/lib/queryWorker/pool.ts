/**
 * Main-thread side of the query worker boundary. Owns a small, fixed-size
 * pool of workers (src/lib/queryWorker/worker.ts), each with its own
 * LocalAdapter connection to the same stack.db, and dispatches
 * ScopedStack.query() calls to them. The operator-facing account of why
 * this exists is docs/deployment.md § Bounding query cost.
 *
 * Two bounds, deliberately not one:
 *
 *   - `deadlineMs` bounds **execution**, and its clock starts when a
 *     request reaches a worker, not when it was accepted here. Execution
 *     is the only part that needs bounding: node:sqlite exposes no
 *     `sqlite3_interrupt` equivalent, so a query already inside the engine
 *     cannot be cancelled in place. Queueing makes a request slow, never
 *     failed.
 *
 *   - `queueLimit` bounds **the wait**, so "slow" cannot quietly become
 *     unbounded in latency or retained memory. Past it the pool sheds load
 *     with StackTimeoutError — a retryable 503, which is honest about
 *     overload in a way a silently growing queue is not.
 *
 * Past its deadline the only lever left is termination: the caller is
 * answered at once and the worker is terminated and replaced, so a stuck
 * query costs one slot rather than wedging the pool. That recycle needs no
 * backoff, being rate-limited by construction at `poolSize` terminations
 * per `deadlineMs`.
 *
 * An *unexpected* death is the opposite case and does back off: respawning
 * a worker that can't boot — an unreadable DB_PATH, say — as fast as the
 * loop allows would spin threads and flood logs. After
 * MAX_CONSECUTIVE_SPAWN_FAILURES the pool reports itself unhealthy and
 * fails queries with the underlying spawn error, so a fatal
 * misconfiguration surfaces as itself rather than as a pile of timeouts.
 * Respawns continue at the capped interval, so the pool heals once the
 * cause clears.
 *
 * Terminating mid-write is safe: WAL journaling leaves an uncommitted
 * transaction simply absent once the file is reopened. Only query() routes
 * through this pool — src/routes/records.ts holds the reason writes and
 * by-id reads stay on the main thread.
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

/** Backoff schedule for respawning a worker that died unexpectedly. */
const RESPAWN_BASE_DELAY_MS = 100;
const RESPAWN_MAX_DELAY_MS = 30_000;
/** Consecutive unexpected deaths after which the pool reports itself unhealthy. */
const MAX_CONSECUTIVE_SPAWN_FAILURES = 5;

type Pending = {
  resolve: (result: QueryResult) => void;
  reject: (err: Error) => void;
  deadlineMs: number;
  /** The execution clock. Null while the request is still queued. */
  timer: NodeJS.Timeout | null;
};

type Slot = {
  /** Null while the worker is dead and its respawn is pending. */
  worker: Worker | null;
  /** id of the request currently running on this worker, or null if idle. */
  busyWith: number | null;
  respawnTimer: NodeJS.Timeout | null;
};

export type QueryWorkerPoolOptions = {
  init: QueryWorkerInit;
  poolSize: number;
  /** Maximum requests waiting for a slot before the pool sheds load. */
  queueLimit: number;
  logger: Logger;
  /**
   * Worker entry point. Defaults to this directory's worker; overridable
   * so tests can drive the pool with a fixture worker whose timing they
   * control, rather than inferring pool behavior from real query latency.
   */
  workerUrl?: URL;
};

export class QueryWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly pending = new Map<number, Pending>();
  /** FIFO of requests waiting for a slot to free up. */
  private readonly waiting: Array<{ id: number; req: QueryRequest }> = [];
  private nextId = 1;
  private closed = false;
  private consecutiveFailures = 0;
  private lastFailure: Error | null = null;

  private readonly init: QueryWorkerInit;
  private readonly queueLimit: number;
  private readonly logger: Logger;
  private readonly workerUrl: URL;

  constructor(opts: QueryWorkerPoolOptions) {
    this.init = opts.init;
    this.queueLimit = opts.queueLimit;
    this.logger = opts.logger;
    this.workerUrl = opts.workerUrl ?? WORKER_URL;
    for (let i = 0; i < opts.poolSize; i++) {
      const slot: Slot = { worker: null, busyWith: null, respawnTimer: null };
      this.slots.push(slot);
      this.startWorker(slot);
    }
  }

  /**
   * True once every recent spawn attempt has failed — a standing fault
   * (bad DB_PATH, unreadable file) rather than one unlucky crash.
   */
  private get unhealthy(): boolean {
    return this.consecutiveFailures >= MAX_CONSECUTIVE_SPAWN_FAILURES;
  }

  private startWorker(slot: Slot): void {
    if (this.closed) return;
    slot.respawnTimer = null;
    const worker = new Worker(this.workerUrl, {
      workerData: this.init,
      execArgv: WORKER_EXEC_ARGV,
    });
    slot.worker = worker;
    slot.busyWith = null;
    worker.on('message', (msg: QueryResponse) => this.handleMessage(slot, msg));
    worker.on('error', (err: Error) => this.handleWorkerDeath(slot, err));
    worker.on('exit', (code) => {
      if (!this.closed && code !== 0) {
        this.handleWorkerDeath(slot, new Error(`query worker exited with code ${code}`));
      }
    });
    // postMessage before a worker finishes booting is fine — worker_threads
    // queues it until the thread installs its listener.
    this.drainWaiting(slot);
  }

  private handleMessage(slot: Slot, msg: QueryResponse): void {
    // A worker that answers is a working worker: clear any standing
    // failure state so an earlier rough patch can't leave the pool
    // permanently marked unhealthy.
    this.consecutiveFailures = 0;
    this.lastFailure = null;
    slot.busyWith = null;
    const pending = this.pending.get(msg.id);
    // Already timed out (and rejected) before the worker answered — the
    // late reply just frees the slot, above.
    if (pending) {
      this.pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(msg.wire ? deserializeError(msg.wire.body) : new Error(msg.message));
    }
    this.drainWaiting(slot);
  }

  /**
   * A worker crashed or exited on its own — not a deadline recycle, which
   * is deliberate and handled by recycleSlot() without backoff.
   */
  private handleWorkerDeath(slot: Slot, err: Error): void {
    const failedId = slot.busyWith;
    if (failedId !== null) {
      const pending = this.pending.get(failedId);
      if (pending) {
        this.pending.delete(failedId);
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(err);
      }
    }
    this.teardown(slot);
    this.consecutiveFailures++;
    this.lastFailure = err;
    const delay = Math.min(
      RESPAWN_BASE_DELAY_MS * 2 ** (this.consecutiveFailures - 1),
      RESPAWN_MAX_DELAY_MS,
    );
    this.logger.error(
      { err, consecutiveFailures: this.consecutiveFailures, retryInMs: delay },
      'Query worker died unexpectedly; respawning after backoff',
    );
    // Nothing is going to serve the queue any time soon — answer it with
    // the real cause instead of letting it wait out a fault that isn't
    // going to clear on its own.
    if (this.unhealthy) this.failQueued(err);
    this.scheduleRespawn(slot, delay);
  }

  /** Deliberate recycle after a deadline: capacity is restored at once, no backoff. */
  private recycleSlot(slot: Slot): void {
    if (this.closed) return;
    this.teardown(slot);
    this.startWorker(slot);
  }

  private teardown(slot: Slot): void {
    const worker = slot.worker;
    slot.worker = null;
    slot.busyWith = null;
    if (!worker) return;
    worker.removeAllListeners();
    void worker.terminate().catch(() => {});
  }

  private scheduleRespawn(slot: Slot, delay: number): void {
    if (this.closed) return;
    if (slot.respawnTimer) clearTimeout(slot.respawnTimer);
    slot.respawnTimer = setTimeout(() => this.startWorker(slot), delay);
    // A pending respawn must not by itself keep the process alive.
    slot.respawnTimer.unref();
  }

  private failQueued(err: Error): void {
    for (const { id } of this.waiting.splice(0)) {
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  private drainWaiting(slot: Slot): void {
    if (this.closed || !slot.worker || slot.busyWith !== null) return;
    // Looped, not recursive: a long run of already-abandoned queue entries
    // shouldn't cost stack depth.
    for (;;) {
      const next = this.waiting.shift();
      if (!next) return;
      const pending = this.pending.get(next.id);
      // Abandoned while queued (pool went unhealthy, or close()).
      if (!pending) continue;
      this.startExecution(slot, next.id, next.req, pending);
      return;
    }
  }

  /** Hand a request to a worker and start its execution clock — see the module doc. */
  private startExecution(slot: Slot, id: number, req: QueryRequest, pending: Pending): void {
    pending.timer = setTimeout(() => this.onDeadline(id), pending.deadlineMs);
    slot.busyWith = id;
    slot.worker!.postMessage(req);
  }

  private onDeadline(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.reject(
      new StackTimeoutError(`Query exceeded the ${pending.deadlineMs}ms execution deadline`),
    );
    const slot = this.slots.find((s) => s.busyWith === id);
    if (slot) this.recycleSlot(slot);
  }

  /**
   * Run a query on the pool. `deadlineMs` bounds execution only; a request
   * that waits for a slot waits without penalty, until the queue itself is
   * full.
   */
  query(
    session: TokenSession | null,
    stackQuery: StackQuery,
    deadlineMs: number,
  ): Promise<QueryResult> {
    if (this.closed) return Promise.reject(new Error('Query worker pool is closed'));
    // A standing spawn fault is a server fault, not a slow query: report
    // the cause rather than making every caller wait out a deadline.
    if (this.unhealthy) {
      return Promise.reject(this.lastFailure ?? new Error('Query worker pool is unavailable'));
    }
    if (this.waiting.length >= this.queueLimit) {
      return Promise.reject(
        new StackTimeoutError(
          `Query queue is full (${this.queueLimit} waiting); the server is shedding load rather than queueing further`,
        ),
      );
    }
    const id = this.nextId++;
    const req: QueryRequest = { id, session, query: stackQuery };
    return new Promise<QueryResult>((resolve, reject) => {
      const pending: Pending = { resolve, reject, deadlineMs, timer: null };
      this.pending.set(id, pending);
      const idle = this.slots.find((s) => s.worker !== null && s.busyWith === null);
      if (idle) this.startExecution(idle, id, req, pending);
      else this.waiting.push({ id, req });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('Query worker pool is closing'));
    }
    this.pending.clear();
    this.waiting.length = 0;
    await Promise.all(
      this.slots.map(async (slot) => {
        if (slot.respawnTimer) {
          clearTimeout(slot.respawnTimer);
          slot.respawnTimer = null;
        }
        const worker = slot.worker;
        slot.worker = null;
        slot.busyWith = null;
        if (!worker) return;
        worker.removeAllListeners();
        await worker.terminate();
      }),
    );
  }
}
