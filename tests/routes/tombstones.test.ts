/**
 * Soft-delete tombstone projection and mutation refusal. The behavior is
 * core's, pinned at this server's HTTP surface rather than assumed to
 * survive the trip through it. A reader other than the owner gets the
 * tombstone; the owner acting alone reads the record whole.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, TEST_TOKEN, OTHER_ENTITY_ID, type TestApp } from '../setup.js';
import { openChangeFeed } from '../changeFeedClient.js';

const NOTE_TYPE = 'com.example.test/note@1';

async function seedNoteType(ctx: TestApp['ctx']) {
  await ctx.stack.defineType({
    id: NOTE_TYPE,
    name: 'Note',
    schema: {
      title: { kind: 'string' },
      body: { kind: 'text' },
    },
  });
}

const PUBLIC_READ = { permissions: [{ kind: 'anyone' as const, label: 'read' as const }] };

describe('tombstone projection and mutation refusal', () => {
  let t: TestApp;
  let readerToken: string;
  beforeEach(async () => {
    t = await buildTestApp();
    await seedNoteType(t.ctx);
    ({ token: readerToken } = await t.ctx.adapter.createToken({ subjectId: OTHER_ENTITY_ID }));
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('GET on a soft-deleted record answers 404 unless asked to include it', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
    const hidden = await req(t.app, 'GET', `/records/${record.id}`, { token: TEST_TOKEN });
    expect(hidden.status).toBe(404);
    const bad = await req(t.app, 'GET', `/records/${record.id}?includeDeleted=1`, {
      token: TEST_TOKEN,
    });
    expect(bad.status).toBe(400);
  });

  it('GET ?includeDeleted=true projects a tombstone: content emptied, deletedAt set', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' }, PUBLIC_READ);
    await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
    const { status, data } = await req(t.app, 'GET', `/records/${record.id}?includeDeleted=true`, {
      token: readerToken,
    });
    expect(status).toBe(200);
    const d = data as { content: unknown; deletedAt?: string };
    expect(d.content).toEqual({});
    expect(typeof d.deletedAt).toBe('string');
  });

  it('query({ includeDeleted: true }) surfaces the same tombstone projection', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'y' }, PUBLIC_READ);
    await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
    const { status, data } = await req(t.app, 'POST', '/records/query', {
      token: readerToken,
      body: { filter: { typeId: NOTE_TYPE, includeDeleted: true } },
    });
    expect(status).toBe(200);
    const d = data as { records: Array<{ id: string; content: unknown; deletedAt?: string }> };
    const found = d.records.find((r) => r.id === record.id)!;
    expect(found.content).toEqual({});
    expect(typeof found.deletedAt).toBe('string');
  });

  it('the change feed carries the same tombstone projection on delete', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' }, PUBLIC_READ);
    const conn = await openChangeFeed(t.app, '/changes?include=record', { token: readerToken });
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
      const [, frame] = await conn.waitForFrames(2);
      const data = frame.data as unknown as {
        record: { content: unknown; deletedAt?: string };
      };
      expect(data.record.content).toEqual({});
      expect(typeof data.record.deletedAt).toBe('string');
    } finally {
      await conn.close();
    }
  });

  it('the owner acting alone reads it whole on every channel, deletedAt set', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'kept' });
    const conn = await openChangeFeed(t.app, '/changes?include=record', { token: TEST_TOKEN });
    try {
      await conn.waitForFrames(1); // ready
      const deleted = await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
      const [, frame] = await conn.waitForFrames(2);
      const got = await req(t.app, 'GET', `/records/${record.id}?includeDeleted=true`, {
        token: TEST_TOKEN,
      });
      const queried = await req(t.app, 'POST', '/records/query', {
        token: TEST_TOKEN,
        body: { filter: { typeId: NOTE_TYPE, includeDeleted: true } },
      });
      const found = (queried.data as { records: Array<{ id: string }> }).records.find(
        (r) => r.id === record.id,
      );
      const framed = (frame.data as unknown as { record: unknown }).record;
      for (const body of [deleted.data, got.data, found, framed]) {
        const d = body as { content: unknown; deletedAt?: string };
        expect(d.content).toEqual({ title: 'kept' });
        expect(typeof d.deletedAt).toBe('string');
      }
    } finally {
      await conn.close();
    }
  });

  it.each(['associations', 'permissions'])(
    'GET /records/:id/%s answers 404 for a soft-deleted record, as GET /records/:id does',
    async (aspect) => {
      const record = await t.ctx.stack.create(
        NOTE_TYPE,
        { title: 'x' },
        { permissions: [{ kind: 'anyone', label: 'read' }] },
      );
      await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
      const { status } = await req(t.app, 'GET', `/records/${record.id}/${aspect}`, {
        token: TEST_TOKEN,
      });
      expect(status).toBe(404);
    },
  );

  it('mutating a soft-deleted record is refused with 409, not applied to the tombstone', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'z' });
    await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
    const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}/content`, {
      token: TEST_TOKEN,
      body: { title: 'edited' },
    });
    expect(status).toBe(409);
    expect((data as { error: { code: string } }).error.code).toBe('conflict');
  });

  it('version history is exempt from the tombstone projection and still serves content', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'w' });
    await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
    const { status, data } = await req(t.app, 'GET', `/records/${record.id}/versions`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(200);
    const { versions } = data as { versions: Array<{ content: Record<string, unknown> }> };
    expect(versions[0]!.content).toEqual({ title: 'w' });
  });
});
