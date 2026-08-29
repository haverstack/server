/**
 * Per-(session, filter) resume buffers for GET /changes (#84). Sits
 * downstream of each connection's `ScopedStack.subscribe()` — every entry
 * here is a frame that subscription already delivered, i.e. something this
 * session was cleared to see at the moment it happened. Resuming replays
 * this buffer; it needs nothing from core. See the design writeup on
 * issue #84 for why this shape was chosen over a single server-wide buffer.
 *
 * A buffer mints its own cursors (its position is a private counter, not a
 * slice of some global sequence) and is fed independently of any one HTTP
 * connection: it keeps collecting for a bounded window *after* the last
 * connection using it disconnects, which is what lets a reconnect learn
 * about changes made while nobody was listening. Depth-bounded on top of
 * that: a session that stays away long enough to overflow the ring gets
 * `overflow` rather than a silently incomplete replay.
 */
import type { ChangeFilter, RecordChange, Unsubscribe } from '@haverstack/core';
import { serializeChange } from '@haverstack/wire-types';
import type { WireRecordChange } from '@haverstack/wire-types';
import { encodeCursor } from './resumeCursor.js';

export type ResumeEntry = {
  n: number;
  recordId: string;
  isPurge: boolean;
  /** Wire-ready, seq already attached. */
  frame: WireRecordChange;
};

export type EntriesAfterResult =
  | { status: 'ok'; entries: ResumeEntry[] }
  /** The buffer is the right one, but depth eviction already dropped what would be needed. */
  | { status: 'overflow' }
  /** A position this buffer never held, or no longer holds any record of. */
  | { status: 'cursor_expired' };

/** One session+filter's resume buffer. Data and notification only — lifecycle lives in the registry. */
export class ResumeBuffer {
  readonly id: string = crypto.randomUUID();
  private readonly entries: ResumeEntry[] = [];
  private currentN = 0;
  private evictedUpTo = 0;
  private readonly listeners = new Set<(entry: ResumeEntry) => void>();

  /** Connections currently holding this buffer open. Registry-managed. */
  liveCount = 0;
  /** Set by the registry when liveCount drops to 0; cleared on reacquire. */
  disconnectedAt: number | null = null;

  constructor(private readonly depth: number) {}

  /** The cursor naming this buffer's current position — what `ready` reports. */
  headCursor(): string {
    return encodeCursor(this.id, this.currentN);
  }

  /**
   * Record one already-permission-filtered change, minting its cursor.
   * Notifies every currently attached live connection with the same frame
   * a replay would later produce.
   */
  append(change: RecordChange): ResumeEntry {
    this.currentN += 1;
    const seq = encodeCursor(this.id, this.currentN);
    const frame = serializeChange({ ...change, seq });
    const entry: ResumeEntry = {
      n: this.currentN,
      recordId: change.recordId,
      isPurge: change.kind === 'purged',
      frame,
    };
    this.entries.push(entry);
    if (this.entries.length > this.depth) {
      const dropped = this.entries.shift();
      if (dropped) this.evictedUpTo = dropped.n;
    }
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  /** Attach a live connection. Returns the detach function. */
  subscribeLive(listener: (entry: ResumeEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Everything after position `n`, or why that can't be answered. `n` is
   * this server's own minted position, already decoded and matched to
   * this buffer's id by the caller.
   */
  entriesAfter(n: number): EntriesAfterResult {
    if (n > this.currentN || n < 0) return { status: 'cursor_expired' };
    if (n < this.evictedUpTo) return { status: 'overflow' };
    return { status: 'ok', entries: this.entries.filter((e) => e.n > n) };
  }
}

export type ResumeBufferKeyParts = {
  /** Both null for an anonymous connection. */
  principalId: string | null;
  subjectId: string | null;
  filter: ChangeFilter;
  includeRecords: boolean;
};

/**
 * Reproducible across a reconnect that re-sends the same query params —
 * order-independent on the parts of `filter` that don't carry order of
 * their own (`typeId`/`kinds` are matched as sets, not sequences, so
 * re-sending them in a different order must key the same buffer).
 */
export function resumeBufferKey(parts: ResumeBufferKeyParts): string {
  const typeId = parts.filter.typeId
    ? [...(Array.isArray(parts.filter.typeId) ? parts.filter.typeId : [parts.filter.typeId])].sort()
    : undefined;
  const kinds = parts.filter.kinds ? [...parts.filter.kinds].sort() : undefined;
  return JSON.stringify([
    parts.principalId,
    parts.subjectId,
    typeId,
    parts.filter.parentId,
    parts.filter.entityId,
    kinds,
    parts.includeRecords,
  ]);
}

export type ResumeBufferRegistryOptions = {
  /** Max entries retained per buffer before the oldest is dropped. */
  depth: number;
  /** How long a buffer keeps being fed after its last connection disconnects, before it's dropped entirely. */
  retentionMs: number;
};

/**
 * Owns every live resume buffer, keyed by (session, filter, includeRecords).
 * A buffer's underlying `ScopedStack.subscribe()` is opened once, when the
 * buffer is first minted, and kept open — including across a gap with zero
 * live connections — until the buffer itself is evicted.
 */
export class ResumeBufferRegistry {
  private readonly buffers = new Map<string, ResumeBuffer>();
  private readonly unsubscribes = new Map<string, Unsubscribe>();
  private readonly evictionTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly opts: ResumeBufferRegistryOptions) {}

  /**
   * Get this key's buffer, creating one and opening its scoped subscription
   * if none is currently retained. `subscribeToStack` is called at most
   * once per buffer instance.
   */
  async acquire(
    key: string,
    subscribeToStack: (onChange: (change: RecordChange) => void) => Promise<Unsubscribe>,
  ): Promise<ResumeBuffer> {
    const existing = this.buffers.get(key);
    if (existing) {
      this.cancelEviction(key);
      existing.liveCount += 1;
      existing.disconnectedAt = null;
      return existing;
    }

    const buffer = new ResumeBuffer(this.opts.depth);
    this.buffers.set(key, buffer);
    buffer.liveCount = 1;
    // Registered before the promise settles is fine either way — the
    // handler closes over `buffer`, not over the unsubscribe function this
    // call eventually returns, so nothing here depends on ordering between
    // the two.
    const unsubscribe = await subscribeToStack((change) => {
      buffer.append(change);
    });
    // A concurrent release() + eviction could in principle have already
    // dropped this key before subscribeToStack() resolved; re-store to be
    // sure the unsubscribe we now hold is reachable for cleanup either way.
    this.unsubscribes.set(key, unsubscribe);
    return buffer;
  }

  /** Detach one connection from this key's buffer, starting its retention countdown once none remain. */
  release(key: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    buffer.liveCount = Math.max(0, buffer.liveCount - 1);
    if (buffer.liveCount > 0) return;
    buffer.disconnectedAt = Date.now();
    const timer = setTimeout(() => this.evict(key, buffer), this.opts.retentionMs);
    timer.unref?.();
    this.evictionTimers.set(key, timer);
  }

  private cancelEviction(key: string): void {
    const timer = this.evictionTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.evictionTimers.delete(key);
    }
  }

  private evict(key: string, buffer: ResumeBuffer): void {
    if (this.buffers.get(key) !== buffer) return; // already replaced
    if (buffer.liveCount > 0) return; // reacquired since the timer was set
    this.buffers.delete(key);
    this.evictionTimers.delete(key);
    this.unsubscribes.get(key)?.();
    this.unsubscribes.delete(key);
  }

  /** Tear down every retained buffer immediately — for shutdown. */
  closeAll(): void {
    for (const timer of this.evictionTimers.values()) clearTimeout(timer);
    this.evictionTimers.clear();
    for (const unsubscribe of this.unsubscribes.values()) unsubscribe();
    this.unsubscribes.clear();
    this.buffers.clear();
  }
}
