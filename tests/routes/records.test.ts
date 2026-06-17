import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, TEST_TOKEN, TEST_ENTITY_ID, OTHER_ENTITY_ID, type TestApp } from '../setup.js';

const NOTE_TYPE_ID = 'com.example.test/note@1';

async function seedType(ctx: TestApp['ctx']) {
  return ctx.stack.defineType(NOTE_TYPE_ID, 'Note', {
    title: { kind: 'string' as const },
    body: { kind: 'text' as const, required: true as const },
  });
}

async function seedRecord(ctx: TestApp['ctx'], overrides: Record<string, unknown> = {}) {
  return ctx.stack.create(NOTE_TYPE_ID, { body: 'Hello world', ...overrides });
}

describe('Records', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await seedType(t.ctx);
  });
  afterEach(async () => { await t.cleanup(); });

  describe('POST /records', () => {
    it('creates a record and returns a server-generated id', async () => {
      const { status, data } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: {
          typeId: NOTE_TYPE_ID,
          content: { body: 'Test note' },
          entityId: TEST_ENTITY_ID,
        },
      });
      expect(status).toBe(201);
      const d = data as Record<string, unknown>;
      expect(typeof d.id).toBe('string');
      expect(d.typeId).toBe(NOTE_TYPE_ID);
      expect((d.content as Record<string, unknown>).body).toBe('Test note');
    });

    it('returns 400 when typeId is missing', async () => {
      const { status } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: { content: { body: 'x' } },
      });
      expect(status).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const { status } = await req(t.app, 'POST', '/records', {
        body: { typeId: NOTE_TYPE_ID, content: { body: 'x' } },
      });
      expect(status).toBe(401);
    });
  });

  describe('GET /records/:id', () => {
    it('returns a record by id', async () => {
      const record = await seedRecord(t.ctx);
      const { status, data } = await req(t.app, 'GET', `/records/${record.id}`, { token: TEST_TOKEN });
      expect(status).toBe(200);
      expect((data as Record<string, unknown>).id).toBe(record.id);
    });

    it('returns 404 for unknown id', async () => {
      const { status } = await req(t.app, 'GET', '/records/nonexistent', { token: TEST_TOKEN });
      expect(status).toBe(404);
    });

    it('anonymous gets 403 for a private record', async () => {
      const record = await seedRecord(t.ctx);
      const { status } = await req(t.app, 'GET', `/records/${record.id}`);
      expect(status).toBe(403);
    });

    it('anonymous can read a public record', async () => {
      const record = await t.ctx.stack.create(NOTE_TYPE_ID, { body: 'public content' }, {
        permissions: [{ access: 'public' }],
      });
      const { status, data } = await req(t.app, 'GET', `/records/${record.id}`);
      expect(status).toBe(200);
      expect((data as Record<string, unknown>).id).toBe(record.id);
    });

    it('entity with a read grant can read the record', async () => {
      const record = await t.ctx.stack.create(NOTE_TYPE_ID, { body: 'shared content' }, {
        permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: false }],
      });
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const { status } = await req(t.app, 'GET', `/records/${record.id}`, { token });
      expect(status).toBe(200);
    });

    it('entity without a grant gets 403', async () => {
      const record = await seedRecord(t.ctx);
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const { status } = await req(t.app, 'GET', `/records/${record.id}`, { token });
      expect(status).toBe(403);
    });
  });

  describe('GET /records', () => {
    it('returns records list', async () => {
      await seedRecord(t.ctx, { body: 'Note 1' });
      await seedRecord(t.ctx, { body: 'Note 2' });
      const { status, data } = await req(t.app, 'GET', '/records', { token: TEST_TOKEN });
      expect(status).toBe(200);
      const d = data as { records: unknown[]; total: null };
      expect(d.total).toBeNull();
      expect(d.records).toHaveLength(2);
    });

    it('filters by typeId query param', async () => {
      await seedRecord(t.ctx);
      const { data } = await req(t.app, 'GET', `/records?typeId=${encodeURIComponent(NOTE_TYPE_ID)}`, { token: TEST_TOKEN });
      expect((data as { records: unknown[] }).records).toHaveLength(1);
    });

    it('anonymous query returns only public records', async () => {
      await seedRecord(t.ctx, { body: 'private' });
      await t.ctx.stack.create(NOTE_TYPE_ID, { body: 'public' }, { permissions: [{ access: 'public' }] });
      const { data } = await req(t.app, 'GET', '/records');
      const d = data as { records: Array<{ content: { body: string } }>; total: null };
      expect(d.total).toBeNull();
      expect(d.records).toHaveLength(1);
      expect(d.records[0].content.body).toBe('public');
    });
  });

  describe('POST /records/query', () => {
    it('accepts a full StackQuery body', async () => {
      await seedRecord(t.ctx);
      const { status, data } = await req(t.app, 'POST', '/records/query', {
        token: TEST_TOKEN,
        body: {
          filter: { typeId: NOTE_TYPE_ID },
          sort: { field: 'createdAt', direction: 'desc' },
          limit: 10,
        },
      });
      expect(status).toBe(200);
      const d = data as { records: unknown[]; total: null };
      expect(d.records).toHaveLength(1);
      expect(d.total).toBeNull();
    });
  });

  describe('PATCH /records/:id', () => {
    it('merges content (does not overwrite unmentioned fields)', async () => {
      const record = await seedRecord(t.ctx, { body: 'original', title: 'My title' });
      const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { content: { body: 'Updated body' } },
      });
      expect(status).toBe(200);
      const d = data as Record<string, unknown>;
      const content = d.content as Record<string, unknown>;
      expect(content.body).toBe('Updated body');
      expect(content.title).toBe('My title');
      expect(d.version).toBe(2);
    });

    it('snapshots the previous version on update', async () => {
      const record = await seedRecord(t.ctx);
      await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { content: { body: 'v2' } },
      });
      const versions = await t.ctx.adapter.getVersions(record.id);
      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe(1);
    });

    it('returns 403 when requester lacks write access', async () => {
      const record = await t.ctx.stack.create(NOTE_TYPE_ID, { body: 'hi' }, {
        permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: false }],
      });
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const { status } = await req(t.app, 'PATCH', `/records/${record.id}`, {
        token,
        body: { content: { body: 'hacked' } },
      });
      expect(status).toBe(403);
    });
  });

  describe('DELETE /records/:id', () => {
    it('soft-deletes by default', async () => {
      const record = await seedRecord(t.ctx);
      const { status } = await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
      expect(status).toBe(204);
      const after = await t.ctx.adapter.getRecord(record.id);
      expect(after?.deletedAt).toBeDefined();
    });

    it('hard-deletes with ?hard=true (owner)', async () => {
      const record = await seedRecord(t.ctx);
      const { status } = await req(t.app, 'DELETE', `/records/${record.id}?hard=true`, { token: TEST_TOKEN });
      expect(status).toBe(204);
      expect(await t.ctx.adapter.getRecord(record.id)).toBeNull();
    });

    it('non-owner with write access can soft-delete', async () => {
      const record = await t.ctx.stack.create(NOTE_TYPE_ID, { body: 'shared' }, {
        permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: true }],
      });
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const { status } = await req(t.app, 'DELETE', `/records/${record.id}`, { token });
      expect(status).toBe(204);
      const after = await t.ctx.adapter.getRecord(record.id);
      expect(after?.deletedAt).toBeDefined();
    });

    it('non-owner gets 403 on hard delete even with write access', async () => {
      const record = await t.ctx.stack.create(NOTE_TYPE_ID, { body: 'shared' }, {
        permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: true }],
      });
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const { status } = await req(t.app, 'DELETE', `/records/${record.id}?hard=true`, { token });
      expect(status).toBe(403);
      expect(await t.ctx.adapter.getRecord(record.id)).not.toBeNull();
    });
  });
});
