import { Hono } from 'hono';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildTestApp,
  req,
  createTestContext,
  testConfig,
  tempDbPath,
  TEST_TOKEN,
  logger,
  type TestApp,
} from '../setup.js';
import { changeRoutes, type ChangeRouteOptions } from '../../src/routes/changes.js';
import { authMiddleware } from '../../src/middleware/auth.js';
import { openChangeFeed } from '../changeFeedClient.js';
import type { StackContext } from '../../src/stack.js';
import type { Config } from '../../src/config.js';
import type { AppEnv } from '../../src/types.js';

const NOTE_TYPE = 'com.example/note@1';
const CONTRIBUTOR_ID = 'entity-contributor-789';

/**
 * changeRoutes() alone doesn't run authMiddleware — that's wired up by
 * createApp(), which these tests bypass so they can pass ChangeRouteOptions
 * (keepaliveMs, sessionCheckMs, maxPendingFrames) that createApp() has no
 * way to thread through. Without it, c.get('auth') would stay undefined
 * for every request here regardless of the header sent, silently falling
 * back to the anonymous view.
 */
function testChangesApp(ctx: StackContext, config: Config, opts: ChangeRouteOptions = {}) {
  const app = new Hono<AppEnv>();
  app.use(authMiddleware(config.ownerToken, ctx));
  app.route('/', changeRoutes(ctx, config, logger, opts));
  return app;
}

describe('GET /changes', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await t.ctx.stack.defineType(NOTE_TYPE, 'Note', { title: { kind: 'string' } });
  });
  afterEach(async () => {
    await t.cleanup();
  });

  describe('query param validation', () => {
    it('rejects an unrecognized kind before streaming starts', async () => {
      const { status, data } = await req(t.app, 'GET', '/changes?kind=bogus', {
        token: TEST_TOKEN,
      });
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBeDefined();
    });

    it('rejects an unrecognized include value', async () => {
      const { status } = await req(t.app, 'GET', '/changes?include=everything', {
        token: TEST_TOKEN,
      });
      expect(status).toBe(400);
    });

    it('rejects a charset-invalid cursor locally, as a 400, rather than as a reset frame', async () => {
      // isValidSeq() only ever allows base64url — a space is never in that
      // alphabet. Refused before the SSE stream even opens, not treated as
      // a resumable-but-unrecognized cursor (#84).
      const { status, data } = await req(t.app, 'GET', '/changes', {
        token: TEST_TOKEN,
        headers: { 'Last-Event-ID': 'not a valid cursor' },
      });
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBeDefined();
    });
  });

  it('never honors a bearer token passed as a query parameter', async () => {
    // A private, owner-only record. A connection presenting the owner's
    // token via ?token= rather than Authorization must still be treated as
    // anonymous — it must not see this change.
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'private' });
    const conn = await openChangeFeed(t.app, `/changes?token=${TEST_TOKEN}`);
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { title: 'still private' },
      });
      // Prove the connection is otherwise live (so a missing frame above
      // isn't just a dead connection) by making a public edit land.
      const publicRecord = await t.ctx.stack.create(
        NOTE_TYPE,
        { title: 'public' },
        { permissions: [{ access: 'public' }] },
      );
      await req(t.app, 'PATCH', `/records/${publicRecord.id}`, {
        token: TEST_TOKEN,
        body: { title: 'still public' },
      });
      const [, frame] = await conn.waitForFrames(2);
      expect((frame.data as { recordId: string }).recordId).toBe(publicRecord.id);
    } finally {
      await conn.close();
    }
  });

  it('sends periodic keepalive comments on an otherwise-idle connection', async () => {
    const dbPath = tempDbPath();
    const ctx = await createTestContext(dbPath);
    await ctx.stack.defineType(NOTE_TYPE, 'Note', { title: { kind: 'string' } });
    const config = testConfig(dbPath);
    const app = testChangesApp(ctx, config, { keepaliveMs: 20, sessionCheckMs: 60_000 });
    try {
      const res = await app.request('/', {
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const start = Date.now();
      while (!text.includes(': keepalive') && Date.now() - start < 2000) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      expect(text).toContain(': keepalive');
      await reader.cancel().catch(() => {});
    } finally {
      await ctx.queryWorker.close();
      await ctx.stack.close();
      await ctx.tokens.close();
      ctx.nonces.close();
    }
  });

  it('closes the connection once a revoked token is re-checked', async () => {
    const dbPath = tempDbPath();
    const ctx = await createTestContext(dbPath);
    await ctx.stack.defineType(NOTE_TYPE, 'Note', { title: { kind: 'string' } });
    const config = testConfig(dbPath);
    const app = testChangesApp(ctx, config, { sessionCheckMs: 20, keepaliveMs: 60_000 });
    const { id, token } = await ctx.adapter.createToken(CONTRIBUTOR_ID);
    try {
      const res = await app.request('/', {
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      await ctx.tokens.revokeToken(id);

      const reader = res.body!.getReader();
      const drained = await Promise.race([
        (async () => {
          while (true) {
            const { done } = await reader.read();
            if (done) return true;
          }
        })(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      expect(drained).toBe(true);
    } finally {
      await ctx.queryWorker.close();
      await ctx.stack.close();
      await ctx.tokens.close();
      ctx.nonces.close();
    }
  });

  // Buffer-overflow behavior (close rather than queue indefinitely on a
  // slow/stalled client) is covered by tests/lib/frameGate.test.ts against
  // FrameGate directly, with deterministic control over when a "write"
  // settles. An HTTP-level version of that test isn't reliable here: this
  // test app's Response/ReadableStream plumbing appears to drain writes
  // internally regardless of whether the test itself ever reads the body,
  // so the backpressure an integration test would need to simulate a
  // stalled client never actually reaches the route.

  describe('resume (#84)', () => {
    // The changeFeedSequenceFixtures dispatch in tests/conformance.test.ts
    // covers the documented resume/reset contract itself (what a missed
    // change and an expired cursor look like on the wire). These cover
    // scenarios the shared fixtures don't reach: a grant revoked during the
    // gap, a purge in the gap (not re-checkable, by design), overflow, and
    // a cursor whose buffer doesn't match the reconnect's own filter.

    it('drops a backlog frame whose grant was revoked during the gap, but still replays an unrelated one', async () => {
      const recordA = await t.ctx.stack.create(
        NOTE_TYPE,
        { title: 'a' },
        { permissions: [{ access: 'entity', entityId: CONTRIBUTOR_ID, read: true, write: false }] },
      );
      const recordB = await t.ctx.stack.create(
        NOTE_TYPE,
        { title: 'b' },
        { permissions: [{ access: 'entity', entityId: CONTRIBUTOR_ID, read: true, write: false }] },
      );
      const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);

      const conn = await openChangeFeed(t.app, '/changes', { token });
      let cursor: string;
      try {
        const [ready] = await conn.waitForFrames(1);
        cursor = (ready.data as { seq: string }).seq;
      } finally {
        await conn.close();
      }

      // While disconnected: edit recordA (still readable at that moment,
      // so it's buffered), then revoke recordA's grant, then edit recordB
      // (still readable throughout).
      await t.ctx.stack.update(recordA.id, { title: 'a, edited' });
      await t.ctx.stack.setPermissions(recordA.id, []);
      await t.ctx.stack.update(recordB.id, { title: 'b, edited' });

      const resumed = await openChangeFeed(t.app, '/changes', {
        token,
        headers: { 'Last-Event-ID': cursor },
      });
      try {
        const [ready, frame] = await resumed.waitForFrames(2);
        expect(ready.event).toBe('ready');
        expect(frame.event).toBe('record');
        // recordA's edit is missing from the replay — only recordB's
        // arrives — proving it was dropped rather than merely reordered.
        expect((frame.data as { recordId: string }).recordId).toBe(recordB.id);
        await expect(resumed.waitForFrames(3, 300)).rejects.toThrow();
      } finally {
        await resumed.close();
      }
    });

    it('replays a purge from the gap unconditionally — not re-checkable, so never dropped', async () => {
      const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'to be purged' });

      const conn = await openChangeFeed(t.app, '/changes', { token: TEST_TOKEN });
      let cursor: string;
      try {
        const [ready] = await conn.waitForFrames(1);
        cursor = (ready.data as { seq: string }).seq;
      } finally {
        await conn.close();
      }

      await req(t.app, 'DELETE', `/records/${record.id}?hard=true`, { token: TEST_TOKEN });

      const resumed = await openChangeFeed(t.app, '/changes', {
        token: TEST_TOKEN,
        headers: { 'Last-Event-ID': cursor },
      });
      try {
        const [, frame] = await resumed.waitForFrames(2);
        const data = frame.data as Record<string, unknown>;
        expect(data.kind).toBe('purged');
        expect(data.recordId).toBe(record.id);
      } finally {
        await resumed.close();
      }
    });

    it('answers overflow once depth eviction has dropped what a reconnect would need', async () => {
      const app = testChangesApp(t.ctx, testConfig(t.dbPath), { resumeBufferDepth: 2 });
      const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'original' });

      const conn = await openChangeFeed(app, '/', { token: TEST_TOKEN });
      let cursor: string;
      try {
        const [ready] = await conn.waitForFrames(1);
        cursor = (ready.data as { seq: string }).seq;
      } finally {
        await conn.close();
      }

      // Three edits while disconnected against a depth-2 buffer: the first
      // is evicted before the reconnect ever asks for it. The buffer's own
      // subscription delivers asynchronously (core serializes a scoped
      // delivery through its own permission-check chain), so give each
      // append a moment to land before relying on the eviction it causes.
      for (const title of ['v2', 'v3', 'v4']) {
        await t.ctx.stack.update(record.id, { title });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const resumed = await openChangeFeed(app, '/', {
        token: TEST_TOKEN,
        headers: { 'Last-Event-ID': cursor },
      });
      try {
        const [, reset] = await resumed.waitForFrames(2);
        expect(reset.event).toBe('reset');
        expect((reset.data as { reason: string }).reason).toBe('overflow');
      } finally {
        await resumed.close();
      }
    });

    it('resets rather than resumes when a cursor names a buffer for a different filter', async () => {
      const conn = await openChangeFeed(t.app, `/changes?typeId=${encodeURIComponent(NOTE_TYPE)}`, {
        token: TEST_TOKEN,
      });
      let cursor: string;
      try {
        const [ready] = await conn.waitForFrames(1);
        cursor = (ready.data as { seq: string }).seq;
      } finally {
        await conn.close();
      }

      // Same session, same cursor value, but no typeId filter this time —
      // a different key, so a different buffer. The cursor's embedded
      // buffer id can't match it.
      const resumed = await openChangeFeed(t.app, '/changes', {
        token: TEST_TOKEN,
        headers: { 'Last-Event-ID': cursor },
      });
      try {
        const [, reset] = await resumed.waitForFrames(2);
        expect(reset.event).toBe('reset');
        expect((reset.data as { reason: string }).reason).toBe('cursor_expired');
      } finally {
        await resumed.close();
      }
    });
  });

  // Two connections sharing a resume buffer share its single subscription,
  // and so its single filter. `?parentId=null` ("root records only") and no
  // parentId filter at all mean different things and must never share one:
  // whichever connected first would otherwise decide what the other
  // receives — a silent gap in one direction, frames outside the filter in
  // the other, and no `reset` either way to announce it.
  describe('buffer keying across distinct filters', () => {
    async function childWrite(): Promise<string> {
      const parent = await t.ctx.stack.create(NOTE_TYPE, { title: 'parent' });
      const child = await t.ctx.stack.create(
        NOTE_TYPE,
        { title: 'child' },
        { parentId: parent.id },
      );
      return child.id;
    }

    it('delivers a child change to an unfiltered connection opened after a ?parentId=null one', async () => {
      const rootsOnly = await openChangeFeed(t.app, '/changes?parentId=null', {
        token: TEST_TOKEN,
      });
      await rootsOnly.waitForFrames(1);
      const unfiltered = await openChangeFeed(t.app, '/changes', { token: TEST_TOKEN });
      await unfiltered.waitForFrames(1);

      try {
        const childId = await childWrite();
        const frames = await unfiltered.waitForFrames(3);
        const child = frames.find(
          (f) => f.event === 'record' && (f.data as { recordId: string }).recordId === childId,
        );
        expect(child).toBeDefined();
        expect(unfiltered.frames.some((f) => f.event === 'reset')).toBe(false);
      } finally {
        await unfiltered.close();
        await rootsOnly.close();
      }
    });

    it('withholds a child change from a ?parentId=null connection opened after an unfiltered one', async () => {
      const unfiltered = await openChangeFeed(t.app, '/changes', { token: TEST_TOKEN });
      await unfiltered.waitForFrames(1);
      const rootsOnly = await openChangeFeed(t.app, '/changes?parentId=null', {
        token: TEST_TOKEN,
      });
      await rootsOnly.waitForFrames(1);

      try {
        const childId = await childWrite();
        // The parent is a root record, so it does arrive — waiting on it
        // proves the connection is live and that the child's absence below
        // is a filter decision rather than a race.
        await rootsOnly.waitForFrames(2);
        const leaked = rootsOnly.frames.filter(
          (f) => f.event === 'record' && (f.data as { recordId: string }).recordId === childId,
        );
        expect(leaked).toHaveLength(0);
      } finally {
        await rootsOnly.close();
        await unfiltered.close();
      }
    });
  });

  it('closes the connection when the token store cannot answer a session re-check', async () => {
    const dbPath = tempDbPath();
    const ctx = await createTestContext(dbPath);
    await ctx.stack.defineType(NOTE_TYPE, 'Note', { title: { kind: 'string' } });
    const config = testConfig(dbPath);
    const { token } = await ctx.adapter.createToken(CONTRIBUTOR_ID);
    const app = testChangesApp(ctx, config, { sessionCheckMs: 20, keepaliveMs: 60_000 });

    // The store is reachable at connect (auth succeeds) and unreachable by
    // the time the re-check runs. Closing is the honest answer: the client
    // reconnects through the path that already handles a 401. Left
    // unhandled, the rejection would take the process down instead.
    const lookupToken = ctx.tokens.lookupToken.bind(ctx.tokens);
    let authenticated = false;
    ctx.tokens.lookupToken = async (t: string) => {
      if (authenticated) throw new Error('token store unavailable');
      authenticated = true;
      return lookupToken(t);
    };

    try {
      const res = await app.request('/', {
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const drained = await Promise.race([
        (async () => {
          while (true) {
            const { done } = await reader.read();
            if (done) return true;
          }
        })(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      expect(drained).toBe(true);
    } finally {
      ctx.tokens.lookupToken = lookupToken;
      await ctx.queryWorker.close();
      await ctx.stack.close();
      await ctx.tokens.close();
      ctx.nonces.close();
    }
  });
});
