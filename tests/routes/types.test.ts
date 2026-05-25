import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, auth, json, type TestApp } from '../setup.js';
import { hashSchema } from '@haverstack/core';

describe('Types', () => {
  let t: TestApp;
  beforeEach(async () => { t = await buildTestApp(); });
  afterEach(async () => { await t.cleanup(); });

  const typeId = 'com.example.test/item@1';
  const schema = { name: { kind: 'string' as const, required: true as const } };

  it('POST /types registers a type', async () => {
    const schemaHash = await hashSchema(schema);
    const { status, data } = await req(t.app, 'POST', '/types', {
      ...auth(),
      ...json({
        id: typeId,
        baseId: 'com.example.test/item',
        version: 1,
        name: 'Item',
        schema,
        schemaHash,
        createdAt: new Date().toISOString(),
      }),
    });
    expect(status).toBe(201);
    expect((data as Record<string, unknown>).id).toBe(typeId);
  });

  it('GET /types returns registered types', async () => {
    await t.ctx.stack.defineType(typeId, 'Item', schema);
    const { status, data } = await req(t.app, 'GET', '/types', auth());
    expect(status).toBe(200);
    const types = data as unknown[];
    expect(types.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /types/:id returns one type (URL-encoded)', async () => {
    await t.ctx.stack.defineType(typeId, 'Item', schema);
    const encoded = encodeURIComponent(typeId);
    const { status, data } = await req(t.app, 'GET', `/types/${encoded}`, auth());
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).id).toBe(typeId);
  });

  it('GET /types/:id returns 404 for unknown type', async () => {
    const { status } = await req(t.app, 'GET', '/types/unknown%40999', auth());
    expect(status).toBe(404);
  });
});
