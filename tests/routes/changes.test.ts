import { Hono } from 'hono';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildTestApp,
  req,
  createTestContext,
  testConfig,
  tempDbPath,
  TEST_TOKEN,
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
  app.route('/', changeRoutes(ctx, config, opts));
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
});
