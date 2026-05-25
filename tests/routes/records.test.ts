import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, auth, json, TEST_ENTITY_ID, type TestApp } from '../setup.js';
import type { StackType } from '@haverstack/core';
import { hashSchema } from '@haverstack/core';

const NOTE_TYPE_ID = 'com.example.test/note@1';

async function seedType(ctx: TestApp['ctx']): Promise<StackType> {
  const schema = { title: { kind: 'string' as const }, body: { kind: 'text' as const, required: true as const } };
  return ctx.stack.defineType(NOTE_TYPE_ID, 'Note', schema);
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

  // ------------------------------------------------------------------
  describe('POST /records', () => {
    it('creates a record', async () => {
      const { generateId } = await import('@haverstack/core');
      const id = generateId();
      const { status, data } = await req(t.app, 'POST', '/records', {
        ...auth(),
        ...json({
          id,
          typeId: NOTE_TYPE_ID,
          content: { body: 'Test note' },
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          entityId: TEST_ENTITY_ID,
        }),
      });
      expect(status).toBe(201);
      const d = data as Record<string, unknown>;
      expect(d.id).toBe(id);
      expect(d.typeId).toBe(NOTE_TYPE_ID);
      expect((d.content as Record<string, unknown>).body).toBe('Test note');
    });

    it('returns 400 when id is missing', async () => {
      const { status } = await req(t.app, 'POST', '/records', {
        ...auth(),
        ...json({ typeId: NOTE_TYPE_ID, content: { body: 'x' }, version: 1 }),
      });
      expect(status).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const { generateId } = await import('@haverstack/core');
      const { status } = await req(t.app, 'POST', '/records', {
        ...json({ id: generateId(), typeId: NOTE_TYPE_ID, content: { body: 'x' }, version: 1 }),
      });
      expect(status).toBe(401);
    });
  });

  // ------------------------------------------------------------------
  describe('GET /records/:id', () => {
    it('returns a record by id', async () => {
      const record = await seedRecord(t.ctx);
      const { status, data } = await req(t.app, 'GET', `/records/${record.id}`, auth());
      expect(status).toBe(200);
      expect((data as Record<string, unknown>).id).toBe(record.id);
    });

    it('returns 404 for unknown id', async () => {
      const { status } = await req(t.app, 'GET', '/records/nonexistent', auth());
      expect(status).toBe(404);
    });
  });

  // ------------------------------------------------------------------
  describe('GET /records', () => {
    it('returns records list', async () => {
      await seedRecord(t.ctx, { body: 'Note 1' });
      await seedRecord(t.ctx, { body: 'Note 2' });
      const { status, data } = await req(t.app, 'GET', '/records', auth());
      expect(status).toBe(200);
      const d = data as { records: unknown[]; total: number };
      expect(d.total).toBe(2);
      expect(d.records).toHaveLength(2);
    });

    it('filters by typeId', async () => {
      await seedRecord(t.ctx);
      const { data } = await req(t.app, 'GET', `/records?typeId=${NOTE_TYPE_ID}`, auth());
      const d = data as { total: number };
      expect(d.total).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  describe('POST /records/query', () => {
    it('accepts a StackQuery body', async () => {
      await seedRecord(t.ctx);
      const { status, data } = await req(t.app, 'POST', '/records/query', {
        ...auth(),
        ...json({ filter: { typeId: NOTE_TYPE_ID }, sort: { field: 'createdAt', direction: 'desc' }, limit: 10 }),
      });
      expect(status).toBe(200);
      const d = data as { records: unknown[]; total: number };
      expect(d.total).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  describe('PATCH /records/:id', () => {
    it('updates record content', async () => {
      const record = await seedRecord(t.ctx);
      const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
        ...auth(),
        ...json({ content: { body: 'Updated body' }, version: 2, updatedAt: new Date().toISOString() }),
      });
      expect(status).toBe(200);
      const d = data as Record<string, unknown>;
      expect((d.content as Record<string, unknown>).body).toBe('Updated body');
      expect(d.version).toBe(2);
    });

    it('snapshots a version on update', async () => {
      const record = await seedRecord(t.ctx);
      await req(t.app, 'PATCH', `/records/${record.id}`, {
        ...auth(),
        ...json({ content: { body: 'v2' }, version: 2, updatedAt: new Date().toISOString() }),
      });
      const versions = await t.ctx.adapter.getVersions(record.id);
      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  describe('DELETE /records/:id', () => {
    it('soft-deletes by default', async () => {
      const record = await seedRecord(t.ctx);
      const { status } = await req(t.app, 'DELETE', `/records/${record.id}`, auth());
      expect(status).toBe(204);
      const after = await t.ctx.adapter.getRecord(record.id);
      expect(after?.deletedAt).toBeDefined();
    });

    it('hard-deletes with ?hard=true', async () => {
      const record = await seedRecord(t.ctx);
      const { status } = await req(t.app, 'DELETE', `/records/${record.id}?hard=true`, auth());
      expect(status).toBe(204);
      const after = await t.ctx.adapter.getRecord(record.id);
      expect(after).toBeNull();
    });
  });
});
