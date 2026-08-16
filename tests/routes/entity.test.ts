import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildTestApp,
  req,
  TEST_TOKEN,
  TEST_ENTITY_ID,
  OTHER_ENTITY_ID,
  type TestApp,
} from '../setup.js';
import type { StackRecord } from '@haverstack/core';

async function seedEntityRecord(ctx: TestApp['ctx']): Promise<StackRecord> {
  return ctx.adapter.createRecord({
    id: TEST_ENTITY_ID,
    typeId: '_entity@1',
    content: { did: TEST_ENTITY_ID, name: 'Test Entity' },
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    entityId: TEST_ENTITY_ID,
  });
}

// _entity@1 records get an auto-generated id — even the owner's own card
// (see Stack.create()'s ownerProfile bootstrap) — with the binding held in
// content.did rather than the record id. This is the realistic shape.
async function seedEntityRecordWithGeneratedId(ctx: TestApp['ctx']): Promise<StackRecord> {
  return ctx.stack.create('_entity@1', { did: TEST_ENTITY_ID, name: 'Test Entity' });
}

describe('GET /entity', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('returns the owner entity record when authenticated as owner', async () => {
    await seedEntityRecord(t.ctx);
    const { status, data } = await req(t.app, 'GET', '/entity', { token: TEST_TOKEN });
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).id).toBe(TEST_ENTITY_ID);
    expect(((data as Record<string, unknown>).content as Record<string, unknown>).name).toBe(
      'Test Entity',
    );
  });

  it('returns 404 when the entity record does not exist', async () => {
    const { status } = await req(t.app, 'GET', '/entity', { token: TEST_TOKEN });
    expect(status).toBe(404);
  });

  it('finds the owner record by content.did even when its id differs from ownerEntityId', async () => {
    await seedEntityRecordWithGeneratedId(t.ctx);
    const { status, data } = await req(t.app, 'GET', '/entity', { token: TEST_TOKEN });
    expect(status).toBe(200);
    const content = (data as Record<string, unknown>).content as Record<string, unknown>;
    expect(content.did).toBe(TEST_ENTITY_ID);
    expect(content.name).toBe('Test Entity');
  });

  it('returns 403 for a non-owner authenticated entity', async () => {
    await seedEntityRecord(t.ctx);
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const { status } = await req(t.app, 'GET', '/entity', { token });
    expect(status).toBe(403);
  });

  it('returns 401 for an unauthenticated request', async () => {
    const { status } = await req(t.app, 'GET', '/entity');
    expect(status).toBe(401);
  });
});

describe('PATCH /entity', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('merges content and returns the updated record', async () => {
    await seedEntityRecord(t.ctx);
    const { status, data } = await req(t.app, 'PATCH', '/entity', {
      token: TEST_TOKEN,
      body: { content: { name: 'Updated Entity', handle: 'updated' } },
    });
    expect(status).toBe(200);
    const content = (data as Record<string, unknown>).content as Record<string, unknown>;
    expect(content.name).toBe('Updated Entity');
    expect(content.handle).toBe('updated');
  });

  it('returns 404 when the entity record does not exist', async () => {
    const { status } = await req(t.app, 'PATCH', '/entity', {
      token: TEST_TOKEN,
      body: { content: { name: 'X' } },
    });
    expect(status).toBe(404);
  });

  it('updates the owner record found by content.did even when its id differs from ownerEntityId', async () => {
    await seedEntityRecordWithGeneratedId(t.ctx);
    const { status, data } = await req(t.app, 'PATCH', '/entity', {
      token: TEST_TOKEN,
      body: { content: { name: 'Renamed' } },
    });
    expect(status).toBe(200);
    const content = (data as Record<string, unknown>).content as Record<string, unknown>;
    expect(content.name).toBe('Renamed');
    expect(content.did).toBe(TEST_ENTITY_ID);
  });

  it('returns 403 for a non-owner authenticated entity', async () => {
    await seedEntityRecord(t.ctx);
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const { status } = await req(t.app, 'PATCH', '/entity', {
      token,
      body: { content: { name: 'Hacked' } },
    });
    expect(status).toBe(403);
  });

  it('returns 401 for an unauthenticated request', async () => {
    const { status } = await req(t.app, 'PATCH', '/entity', {
      body: { content: { name: 'X' } },
    });
    expect(status).toBe(401);
  });
});
