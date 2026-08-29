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
 *
 * Two filters that mean different things must never key the same buffer.
 * A buffer opens exactly one `ScopedStack.subscribe()`, carrying the
 * filter of whichever connection minted it, so a collision hands one of
 * the two colliding connections the *other's* filter: either a silent gap
 * (events it asked for and never hears about, with no `reset` to tell it
 * so) or frames outside its filter, which "filtering is exact, not
 * advisory" forbids. See docs/spec/wire-format.md § Change feed.
 *
 * Hence an object rather than a positional array: `JSON.stringify` drops
 * an undefined *property* but renders an undefined *array element* as
 * `null`, which collapsed "no parentId filter" onto `parentId: null`
 * ("root records only" — a filter the wire format defines) when both were
 * array slots. Absent is now encoded as an absent key, which no present
 * value can imitate. Key order is fixed by construction below.
 */
export function resumeBufferKey(parts: ResumeBufferKeyParts): string {
  const { filter } = parts;
  const typeId = filter.typeId
    ? [...(Array.isArray(filter.typeId) ? filter.typeId : [filter.typeId])].sort()
    : undefined;
  const kinds = filter.kinds ? [...filter.kinds].sort() : undefined;
  return JSON.stringify({
    principalId: parts.principalId,
    subjectId: parts.subjectId,
    includeRecords: parts.includeRecords,
    ...(typeId !== undefined && { typeId }),
    ...(filter.parentId !== undefined && { parentId: filter.parentId }),
    ...(filter.entityId !== undefined && { entityId: filter.entityId }),
    ...(kinds !== undefined && { kinds }),
  });
}

export type ResumeBufferRegistryOptions = {
  /** Max entries retained per buffer before the oldest is dropped. */
  depth: number;
  /** How long a buffer keeps being fed after its last connection disconnects, before it's dropped entirely. */
  retentionMs: number;
  /**
   * Max buffers retained at once. Past it, the longest-disconnected ones
   * are dropped early — see `enforceLimit()`. Counts every buffer, but
   * only ones with no live connection are eligible for eviction.
   */
  maxBuffers: number;
};

/**
 * Owns every live resume buffer, keyed by (session, filter, includeRecords).
 * A buffer's underlying `ScopedStack.subscribe()` is opened once, when the
 * buffer is first minted, and kept open — including across a gap with zero
 * live connections — until the buffer itself is evicted.
 *
 * That retention is what makes a reconnect able to recover changes made
 * while nobody was listening, and it is also what makes the registry a
 * cost worth bounding: the key includes the connection's filter, which
 * comes from client-supplied query params on a route that serves
 * anonymous callers, so without a ceiling one caller can leave arbitrarily
 * many buffers — each holding an open `ScopedStack.subscribe()` that every
 * write in the stack then fans out through — collecting for the whole
 * retention window after it has gone. `maxBuffers` is that ceiling.
 */
export class ResumeBufferRegistry {
  private readonly buffers = new Map<string, ResumeBuffer>();
  private readonly unsubscribes = new Map<string, Unsubscribe>();
  private readonly evictionTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Buffers whose subscription is still opening. A key lands in `buffers`
   * only once its `ScopedStack.subscribe()` has resolved, so this is what
   * keeps two connections arriving in the same tick from opening two
   * subscriptions for one key — they await the same attempt and share
   * whichever way it settles.
   */
  private readonly acquiring = new Map<string, Promise<ResumeBuffer>>();

  constructor(private readonly opts: ResumeBufferRegistryOptions) {}

  /**
   * Get this key's buffer, creating one and opening its scoped subscription
   * if none is currently retained. `subscribeToStack` is called at most
   * once per buffer instance.
   *
   * A failed subscription registers nothing: the next connection on this
   * key retries it. Registering a buffer that nothing is feeding would
   * hand every later connection on that key a `ready` frame followed by
   * permanent silence — a gap with no `reset` to announce it, which is
   * the one failure the feed contract calls untrustworthy.
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

    const inFlight = this.acquiring.get(key);
    if (inFlight) {
      const buffer = await inFlight;
      buffer.liveCount += 1;
      return buffer;
    }

    const attempt = (async () => {
      const buffer = new ResumeBuffer(this.opts.depth);
      // Awaited before either map is touched — the handler closes over
      // `buffer`, so anything the stack emits while this is in flight is
      // already being recorded by the time the buffer becomes reachable.
      const unsubscribe = await subscribeToStack((change) => {
        buffer.append(change);
      });
      this.buffers.set(key, buffer);
      this.unsubscribes.set(key, unsubscribe);
      return buffer;
    })();
    this.acquiring.set(key, attempt);

    try {
      const buffer = await attempt;
      buffer.liveCount += 1;
      this.enforceLimit();
      return buffer;
    } finally {
      this.acquiring.delete(key);
    }
  }

  /**
   * Drop the longest-disconnected buffers once the registry is over its
   * ceiling. They are the ones whose retention window is closest to
   * expiring anyway, so they are the cheapest to lose — and losing one is
   * a documented outcome rather than a failure: the reconnect that
   * presents its cursor gets `cursor_expired` and reconciles by query,
   * exactly as it would have a moment later.
   *
   * A buffer with a live connection is never evicted here. It has a client
   * actively reading it, and closing that stream to reclaim memory would
   * trade a bounded cost for a broken one. Bounding *concurrent*
   * connections is the reverse proxy's job (`limit_conn`) — see
   * docs/deployment.md § Bounding change-feed cost.
   */
  private enforceLimit(): void {
    let excess = this.buffers.size - this.opts.maxBuffers;
    if (excess <= 0) return;

    const idle = [...this.buffers.entries()]
      .filter(([, buffer]) => buffer.liveCount === 0 && buffer.disconnectedAt !== null)
      .sort((a, b) => a[1].disconnectedAt! - b[1].disconnectedAt!);

    for (const [key, buffer] of idle) {
      if (excess <= 0) return;
      this.cancelEviction(key);
      this.evict(key, buffer);
      excess -= 1;
    }
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
    this.acquiring.clear();
    for (const unsubscribe of this.unsubscribes.values()) unsubscribe();
    this.unsubscribes.clear();
    this.buffers.clear();
  }
}
