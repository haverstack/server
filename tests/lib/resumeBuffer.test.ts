import { describe, it, expect, vi } from 'vitest';
import type { RecordChange, Unsubscribe } from '@haverstack/core';
import { decodeCursor } from '../../src/lib/resumeCursor.js';
import { ResumeBuffer, ResumeBufferRegistry, resumeBufferKey } from '../../src/lib/resumeBuffer.js';

let counter = 0;
function change(overrides: Partial<RecordChange> = {}): RecordChange {
  counter += 1;
  return {
    kind: 'changed',
    op: 'update',
    recordId: `record-${counter}`,
    typeId: 'com.example/note@1',
    version: counter,
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ResumeBuffer', () => {
  it('mints the "nothing yet" head cursor at position 0', () => {
    const buffer = new ResumeBuffer(10);
    const decoded = decodeCursor(buffer.headCursor())!;
    expect(decoded.bufferId).toBe(buffer.id);
    expect(decoded.n).toBe(0);
  });

  it("advances the head cursor and attaches it as each entry's seq", () => {
    const buffer = new ResumeBuffer(10);
    const entry = buffer.append(change());
    expect(entry.n).toBe(1);
    expect(entry.frame.seq).toBe(buffer.headCursor());
    expect(decodeCursor(entry.frame.seq!)!.n).toBe(1);
  });

  it('notifies every attached live listener of each append, and stops once detached', () => {
    const buffer = new ResumeBuffer(10);
    const seen: string[] = [];
    const detach = buffer.subscribeLive((entry) => seen.push(entry.recordId));

    const c1 = change({ recordId: 'r1' });
    buffer.append(c1);
    detach();
    buffer.append(change({ recordId: 'r2' }));

    expect(seen).toEqual(['r1']);
  });

  it('replays everything after a given position, in order', () => {
    const buffer = new ResumeBuffer(10);
    buffer.append(change({ recordId: 'r1' }));
    const e2 = buffer.append(change({ recordId: 'r2' }));
    const e3 = buffer.append(change({ recordId: 'r3' }));

    const result = buffer.entriesAfter(1);
    expect(result).toEqual({ status: 'ok', entries: [e2, e3] });
  });

  it('reports nothing missing when asked to replay from its own current head', () => {
    const buffer = new ResumeBuffer(10);
    buffer.append(change());
    const result = buffer.entriesAfter(1);
    expect(result).toEqual({ status: 'ok', entries: [] });
  });

  it('reports cursor_expired for a position beyond anything it has ever minted', () => {
    const buffer = new ResumeBuffer(10);
    buffer.append(change());
    expect(buffer.entriesAfter(99)).toEqual({ status: 'cursor_expired' });
  });

  it('reports overflow once depth eviction has dropped what would be needed', () => {
    const buffer = new ResumeBuffer(2);
    buffer.append(change()); // n=1, evicted once n=4 lands
    buffer.append(change()); // n=2
    buffer.append(change()); // n=3, evicts n=1
    buffer.append(change()); // n=4, evicts n=2

    // n=1 and n=2 are both gone; only entries after n=2 are retained.
    expect(buffer.entriesAfter(1)).toEqual({ status: 'overflow' });
    expect(buffer.entriesAfter(2).status).toBe('ok');
  });
});

describe('resumeBufferKey', () => {
  it('is stable across a differently-ordered but equivalent filter', () => {
    const a = resumeBufferKey({
      principalId: 'p1',
      subjectId: 's1',
      filter: { typeId: ['b', 'a'], kinds: ['deleted', 'created'] },
      includeRecords: true,
      includeUnlisted: false,
    });
    const b = resumeBufferKey({
      principalId: 'p1',
      subjectId: 's1',
      filter: { typeId: ['a', 'b'], kinds: ['created', 'deleted'] },
      includeRecords: true,
      includeUnlisted: false,
    });
    expect(a).toBe(b);
  });

  it('differs across sessions, filters, the includeRecords choice, or the includeUnlisted choice', () => {
    const base = { filter: {}, includeRecords: false, includeUnlisted: false };
    const anon = resumeBufferKey({ principalId: null, subjectId: null, ...base });
    const authed = resumeBufferKey({ principalId: 'p1', subjectId: 's1', ...base });
    const filtered = resumeBufferKey({
      principalId: null,
      subjectId: null,
      filter: { entityId: 'e1' },
      includeRecords: false,
      includeUnlisted: false,
    });
    const withRecords = resumeBufferKey({
      principalId: null,
      subjectId: null,
      ...base,
      includeRecords: true,
    });
    const withUnlisted = resumeBufferKey({
      principalId: null,
      subjectId: null,
      ...base,
      includeUnlisted: true,
    });

    const keys = new Set([anon, authed, filtered, withRecords, withUnlisted]);
    expect(keys.size).toBe(5);
  });

  // A buffer opens one subscription carrying the filter of whichever
  // connection minted it, so a collision here hands one of the two the
  // other's filter — a silent gap in one direction, frames outside the
  // filter in the other. `parentId` is the case a positional
  // JSON.stringify got wrong: `undefined` renders as `null` inside an
  // array, so "no parentId filter" and `parentId: null` collapsed onto
  // one key.
  it('distinguishes an absent parentId filter from parentId: null', () => {
    const base = {
      principalId: null,
      subjectId: null,
      includeRecords: false,
      includeUnlisted: false,
    };
    const unfiltered = resumeBufferKey({ ...base, filter: {} });
    const rootsOnly = resumeBufferKey({ ...base, filter: { parentId: null } });
    const oneParent = resumeBufferKey({ ...base, filter: { parentId: 'rec-1' } });

    expect(new Set([unfiltered, rootsOnly, oneParent]).size).toBe(3);
  });

  it('distinguishes an absent filter field from every value that field can hold', () => {
    const base = {
      principalId: null,
      subjectId: null,
      includeRecords: false,
      includeUnlisted: false,
    };
    expect(resumeBufferKey({ ...base, filter: {} })).not.toBe(
      resumeBufferKey({ ...base, filter: { entityId: 'e1' } }),
    );
    expect(resumeBufferKey({ ...base, filter: {} })).not.toBe(
      resumeBufferKey({ ...base, filter: { typeId: [] } }),
    );
    expect(resumeBufferKey({ ...base, filter: {} })).not.toBe(
      resumeBufferKey({ ...base, filter: { kinds: [] } }),
    );
  });

  it("does not let one field's value imitate another's", () => {
    const base = {
      principalId: null,
      subjectId: null,
      includeRecords: false,
      includeUnlisted: false,
    };
    expect(resumeBufferKey({ ...base, filter: { parentId: 'x' } })).not.toBe(
      resumeBufferKey({ ...base, filter: { entityId: 'x' } }),
    );
  });
});

describe('ResumeBufferRegistry', () => {
  function subscribeStub(unsubscribe: Unsubscribe = () => {}) {
    return vi.fn(async (_onChange: (c: RecordChange) => void) => unsubscribe);
  }

  it('opens a subscription once per key and reuses the same buffer on a second acquire', async () => {
    const registry = new ResumeBufferRegistry({ depth: 10, retentionMs: 10_000 });
    const subscribe = subscribeStub();

    const first = await registry.acquire('key', subscribe);
    const second = await registry.acquire('key', subscribe);

    expect(second).toBe(first);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('feeds the buffer from the subscription handler', async () => {
    const registry = new ResumeBufferRegistry({ depth: 10, retentionMs: 10_000 });
    let handler!: (c: RecordChange) => void;
    const buffer = await registry.acquire('key', async (onChange) => {
      handler = onChange;
      return () => {};
    });

    handler(change({ recordId: 'live' }));
    expect(buffer.entriesAfter(0)).toEqual({
      status: 'ok',
      entries: [expect.objectContaining({ recordId: 'live' })],
    });
  });

  it('keeps the buffer retained across a release/reacquire within the retention window', async () => {
    const registry = new ResumeBufferRegistry({ depth: 10, retentionMs: 10_000 });
    const subscribe = subscribeStub();
    const first = await registry.acquire('key', subscribe);
    registry.release('key');
    const second = await registry.acquire('key', subscribe);

    expect(second).toBe(first);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('evicts and unsubscribes a buffer once its retention window elapses with no live connections', async () => {
    vi.useFakeTimers();
    try {
      const unsubscribe = vi.fn();
      const registry = new ResumeBufferRegistry({ depth: 10, retentionMs: 1000 });
      const subscribe = subscribeStub(unsubscribe);

      const first = await registry.acquire('key', subscribe);
      registry.release('key');
      await vi.advanceTimersByTimeAsync(1001);

      expect(unsubscribe).toHaveBeenCalledTimes(1);

      const second = await registry.acquire('key', subscribe);
      expect(second).not.toBe(first);
      expect(subscribe).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never evicts while a live connection still holds the buffer', async () => {
    vi.useFakeTimers();
    try {
      const unsubscribe = vi.fn();
      const registry = new ResumeBufferRegistry({ depth: 10, retentionMs: 1000 });
      const subscribe = subscribeStub(unsubscribe);

      await registry.acquire('key', subscribe); // liveCount 1
      await registry.acquire('key', subscribe); // liveCount 2
      registry.release('key'); // liveCount 1 — still live
      await vi.advanceTimersByTimeAsync(2000);

      expect(unsubscribe).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closeAll tears down every retained buffer immediately', async () => {
    const unsubscribeA = vi.fn();
    const unsubscribeB = vi.fn();
    const registry = new ResumeBufferRegistry({ depth: 10, retentionMs: 10_000 });
    await registry.acquire('a', subscribeStub(unsubscribeA));
    await registry.acquire('b', subscribeStub(unsubscribeB));

    registry.closeAll();

    expect(unsubscribeA).toHaveBeenCalledTimes(1);
    expect(unsubscribeB).toHaveBeenCalledTimes(1);
  });

  // Registering a buffer nothing is feeding would answer every later
  // connection on that key with `ready` and then permanent silence — a gap
  // with no `reset` to announce it.
  it('registers nothing when the subscription fails, and retries on the next acquire', async () => {
    const registry = new ResumeBufferRegistry({ depth: 10, retentionMs: 10_000 });
    const failing = vi.fn(async () => {
      throw new Error('adapter unavailable');
    });

    await expect(registry.acquire('k', failing)).rejects.toThrow('adapter unavailable');

    const unsubscribe = vi.fn();
    const healthy = subscribeStub(unsubscribe);
    const buffer = await registry.acquire('k', healthy);

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(buffer.liveCount).toBe(1);

    // And the retried buffer is genuinely fed and genuinely releasable.
    registry.release('k');
    expect(buffer.liveCount).toBe(0);
  });

  it('opens one subscription for two acquires that race on the same key', async () => {
    const registry = new ResumeBufferRegistry({ depth: 10, retentionMs: 10_000 });
    let resolveSubscribe!: (u: Unsubscribe) => void;
    const subscribe = vi.fn(
      () =>
        new Promise<Unsubscribe>((resolve) => {
          resolveSubscribe = resolve;
        }),
    );

    const first = registry.acquire('k', subscribe);
    const second = registry.acquire('k', subscribe);
    resolveSubscribe(() => {});
    const [a, b] = await Promise.all([first, second]);

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a.liveCount).toBe(2);
  });

  it('fails both racing acquires when the shared subscription fails, then retries', async () => {
    const registry = new ResumeBufferRegistry({ depth: 10, retentionMs: 10_000 });
    let rejectSubscribe!: (err: Error) => void;
    const failing = vi.fn(
      () =>
        new Promise<Unsubscribe>((_resolve, reject) => {
          rejectSubscribe = reject;
        }),
    );

    const first = registry.acquire('k', failing);
    const second = registry.acquire('k', failing);
    rejectSubscribe(new Error('adapter unavailable'));
    await expect(first).rejects.toThrow('adapter unavailable');
    await expect(second).rejects.toThrow('adapter unavailable');

    const healthy = subscribeStub();
    await registry.acquire('k', healthy);
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
