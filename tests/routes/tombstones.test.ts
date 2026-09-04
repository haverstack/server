/**
 * Soft-delete tombstone projection and mutation refusal — inherited from
 * the core 0.18 bump (issue #96), pinned here rather than assumed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, TEST_TOKEN, type TestApp } from '../setup.js';
import { openChangeFeed } from '../changeFeedClient.js';

const NOTE_TYPE = 'com.example.test/note@1';

async function seedNoteType(ctx: TestApp['ctx']) {
  await ctx.stack.defineType(NOTE_TYPE, 'Note', {
    title: { kind: 'string' },
    body: { kind: 'text' },
  });
}

describe('tombstone projection and mutation refusal', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await seedNoteType(t.ctx);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('GET on a soft-deleted record projects a tombstone: content emptied, deletedAt set', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
    const { status, data } = await req(t.app, 'GET', `/records/${record.id}`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(200);
    const d = data as { content: unknown; deletedAt?: string };
    expect(d.content).toEqual({});
    expect(typeof d.deletedAt).toBe('string');
  });

  it('query({ includeDeleted: true }) surfaces the same tombstone projection', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'y' });
    await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
    const { status, data } = await req(t.app, 'POST', '/records/query', {
      token: TEST_TOKEN,
      body: { filter: { typeId: NOTE_TYPE, includeDeleted: true } },
    });
    expect(status).toBe(200);
    const d = data as { records: Array<{ id: string; content: unknown; deletedAt?: string }> };
    const found = d.records.find((r) => r.id === record.id)!;
    expect(found.content).toEqual({});
    expect(typeof found.deletedAt).toBe('string');
  });

  it('the change feed carries the same tombstone projection on delete', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    const conn = await openChangeFeed(t.app, '/changes?include=record', { token: TEST_TOKEN });
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

  it('mutating a soft-deleted record is refused with 409, not applied to the tombstone', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'z' });
    await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
    const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
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
    const versions = data as Array<{ content: Record<string, unknown> }>;
    expect(versions[0]!.content).toEqual({ title: 'w' });
  });
});
