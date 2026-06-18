import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hashSchema } from '@haverstack/core';
import { buildTestApp, req, TEST_TOKEN, OTHER_ENTITY_ID, type TestApp } from '../setup.js';

describe('Types', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  const typeId = 'com.example.test/item@1';
  const schema = { name: { kind: 'string' as const, required: true as const } };

  describe('POST /types', () => {
    it('registers a type as owner', async () => {
      const schemaHash = await hashSchema(schema);
      const { status, data } = await req(t.app, 'POST', '/types', {
        token: TEST_TOKEN,
        body: {
          id: typeId,
          baseId: 'com.example.test/item',
          version: 1,
          name: 'Item',
          schema,
          schemaHash,
          createdAt: new Date().toISOString(),
        },
      });
      expect(status).toBe(201);
      expect((data as Record<string, unknown>).id).toBe(typeId);
    });

    it('returns 401 without auth', async () => {
      const { status } = await req(t.app, 'POST', '/types', {
        body: { id: typeId, baseId: 'x', version: 1, name: 'x', schema: {}, schemaHash: 'x' },
      });
      expect(status).toBe(401);
    });

    it('returns 403 for a non-owner entity', async () => {
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const { status } = await req(t.app, 'POST', '/types', {
        token,
        body: { id: typeId, baseId: 'x', version: 1, name: 'x', schema: {}, schemaHash: 'x' },
      });
      expect(status).toBe(403);
    });
  });

  describe('GET /types', () => {
    it('returns all registered types (no auth required)', async () => {
      await t.ctx.stack.defineType(typeId, 'Item', schema);
      const { status, data } = await req(t.app, 'GET', '/types');
      expect(status).toBe(200);
      expect((data as unknown[]).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /types/:id', () => {
    it('returns one type (URL-encoded, no auth required)', async () => {
      await t.ctx.stack.defineType(typeId, 'Item', schema);
      const { status, data } = await req(t.app, 'GET', `/types/${encodeURIComponent(typeId)}`);
      expect(status).toBe(200);
      expect((data as Record<string, unknown>).id).toBe(typeId);
    });

    it('returns 404 for unknown type', async () => {
      const { status } = await req(t.app, 'GET', '/types/unknown%40999');
      expect(status).toBe(404);
    });
  });
});
