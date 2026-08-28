import { describe, test, expect } from 'vitest';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { EventEmitter } from 'node:events';
import { SSEDecoder, openChangeFeed } from '../changeFeedClient.js';
import type { AppEnv } from '../../src/app.js';

describe('SSEDecoder', () => {
  test('decodes a single frame delivered in one chunk', () => {
    const decoder = new SSEDecoder();
    const frames = decoder.push('id: AA3f1R\nevent: record\ndata: {"kind":"created"}\n\n');
    expect(frames).toEqual([{ id: 'AA3f1R', event: 'record', data: { kind: 'created' } }]);
  });

  test('decodes multiple frames from one chunk', () => {
    const decoder = new SSEDecoder();
    const frames = decoder.push(
      'event: ready\ndata: {"seq":"AA3f1Q"}\n\nid: AA3f1R\nevent: record\ndata: {"kind":"created"}\n\n',
    );
    expect(frames).toEqual([
      { event: 'ready', data: { seq: 'AA3f1Q' } },
      { id: 'AA3f1R', event: 'record', data: { kind: 'created' } },
    ]);
  });

  test('decodes a frame split across chunks, mid-line', () => {
    const decoder = new SSEDecoder();
    expect(decoder.push('event: rea')).toEqual([]);
    expect(decoder.push('dy\ndata: {"se')).toEqual([]);
    const frames = decoder.push('q":"AA3f1Q"}\n\n');
    expect(frames).toEqual([{ event: 'ready', data: { seq: 'AA3f1Q' } }]);
  });

  test('ignores comment lines (keepalives)', () => {
    const decoder = new SSEDecoder();
    const frames = decoder.push(': keepalive\n\nevent: ready\ndata: {}\n\n');
    expect(frames).toEqual([{ event: 'ready', data: {} }]);
  });

  test('a control frame with no id decodes with id absent, even right after a frame that had one', () => {
    const decoder = new SSEDecoder();
    const frames = decoder.push(
      'id: AA3f1R\nevent: record\ndata: {}\n\nevent: reset\ndata: {"reason":"not_supported"}\n\n',
    );
    expect(frames[0]!.id).toBe('AA3f1R');
    expect(frames[1]!.id).toBeUndefined();
  });

  test('an unrecognized event name is preserved, not dropped', () => {
    const decoder = new SSEDecoder();
    const frames = decoder.push('event: something-new\ndata: {}\n\n');
    expect(frames).toEqual([{ event: 'something-new', data: {} }]);
  });

  test('non-JSON data is preserved as raw text rather than throwing', () => {
    const decoder = new SSEDecoder();
    const frames = decoder.push('event: ready\ndata: not-json\n\n');
    expect(frames).toEqual([{ event: 'ready', data: 'not-json' }]);
  });
});

/**
 * A throwaway SSE server, unrelated to this repo's real change feed
 * endpoint (#82 hasn't landed it), that exists purely to prove
 * openChangeFeed's own mechanics: a connection opens, a mutation dispatched
 * against a *second*, concurrent request reaches the still-open stream, and
 * waitForFrames/close behave correctly around that.
 */
function buildSseTestApp() {
  const emitter = new EventEmitter();
  const app = new Hono<AppEnv>();
  app.get('/sse-test', (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'ready', data: '{}' });
      for (let i = 0; i < 2; i++) {
        const payload = await new Promise<{ id: string; data: unknown }>((resolve) => {
          emitter.once('mutate', resolve);
        });
        await stream.writeSSE({
          event: 'record',
          id: payload.id,
          data: JSON.stringify(payload.data),
        });
      }
    });
  });
  app.post('/mutate', async (c) => {
    const body = await c.req.json();
    emitter.emit('mutate', body);
    return c.json({ ok: true });
  });
  return app;
}

describe('openChangeFeed', () => {
  test('captures the opening frame immediately, then a mutation made while open', async () => {
    const app = buildSseTestApp();
    const conn = await openChangeFeed(app, '/sse-test');
    try {
      expect(conn.status).toBe(200);
      await conn.waitForFrames(1);
      expect(conn.frames[0]).toEqual({ event: 'ready', data: {} });

      await app.request('/mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'AA3f1R', data: { kind: 'created' } }),
      });

      const frames = await conn.waitForFrames(2);
      expect(frames[1]).toEqual({ id: 'AA3f1R', event: 'record', data: { kind: 'created' } });
    } finally {
      await conn.close();
    }
  });

  test('waitForFrames rejects rather than hanging when too few frames arrive', async () => {
    const app = buildSseTestApp();
    const conn = await openChangeFeed(app, '/sse-test');
    try {
      await conn.waitForFrames(1);
      await expect(conn.waitForFrames(5, 50)).rejects.toThrow(/Timed out/);
    } finally {
      await conn.close();
    }
  });
});
