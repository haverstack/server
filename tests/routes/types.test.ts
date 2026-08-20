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

    it('re-POSTing an identical schema is a no-op that preserves createdAt', async () => {
      const schemaHash = await hashSchema(schema);
      const first = await req(t.app, 'POST', '/types', {
        token: TEST_TOKEN,
        body: { id: typeId, name: 'Item', schema, schemaHash },
      });
      expect(first.status).toBe(201);
      const createdAt = (first.data as Record<string, unknown>).createdAt;

      const second = await req(t.app, 'POST', '/types', {
        token: TEST_TOKEN,
        body: { id: typeId, name: 'Item', schema, schemaHash },
      });
      expect(second.status).toBe(201);
      expect((second.data as Record<string, unknown>).createdAt).toBe(createdAt);
    });

    it('re-POSTing an additive-legal schema change is accepted', async () => {
      const schemaHash = await hashSchema(schema);
      await req(t.app, 'POST', '/types', {
        token: TEST_TOKEN,
        body: { id: typeId, name: 'Item', schema, schemaHash },
      });

      const widened = {
        ...schema,
        note: { kind: 'string' as const, required: false as const },
      };
      const widenedHash = await hashSchema(widened);
      const { status, data } = await req(t.app, 'POST', '/types', {
        token: TEST_TOKEN,
        body: { id: typeId, name: 'Item', schema: widened, schemaHash: widenedHash },
      });
      expect(status).toBe(201);
      expect((data as Record<string, unknown>).schema).toEqual(widened);
    });

    it('re-POSTing a non-additive schema change returns 409 schema_drift', async () => {
      const schemaHash = await hashSchema(schema);
      await req(t.app, 'POST', '/types', {
        token: TEST_TOKEN,
        body: { id: typeId, name: 'Item', schema, schemaHash },
      });

      const incompatible = { name: { kind: 'number' as const, required: true as const } };
      const incompatibleHash = await hashSchema(incompatible);
      const { status, data } = await req(t.app, 'POST', '/types', {
        token: TEST_TOKEN,
        body: { id: typeId, name: 'Item', schema: incompatible, schemaHash: incompatibleHash },
      });
      expect(status).toBe(409);
      expect((data as { error: { code: string } }).error.code).toBe('schema_drift');
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
