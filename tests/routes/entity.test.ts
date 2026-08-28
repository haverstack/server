import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  it('returns 404, not 403, for a non-owner authenticated entity (anti-oracle rule)', async () => {
    await seedEntityRecord(t.ctx);
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const { status } = await req(t.app, 'GET', '/entity', { token });
    expect(status).toBe(404);
  });

  it("a non-owner's denial does not evict the cached owner record id", async () => {
    await seedEntityRecord(t.ctx);
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const querySpy = vi.spyOn(t.ctx.stack, 'query');

    // Populate the cache, then have a non-owner get denied against it. The
    // denied request may itself run a query internally to evaluate the
    // permission grant — that's unrelated to the id cache this test is
    // pinning down, so only the *delta* across it matters below.
    await req(t.app, 'GET', '/entity', { token: TEST_TOKEN });
    const { status: deniedStatus } = await req(t.app, 'GET', '/entity', { token });
    expect(deniedStatus).toBe(404);
    const countAfterDenial = querySpy.mock.calls.length;

    // The card was never deleted, so a well-behaved cache doesn't re-resolve
    // it on the next request — a non-owner's null read() is ambiguous
    // (denied vs. gone) and must not be trusted to evict a valid entry. A
    // stale eviction would show up here as an extra query call.
    await req(t.app, 'GET', '/entity', { token: TEST_TOKEN });
    expect(querySpy.mock.calls.length).toBe(countAfterDenial);
  });

  it('returns 401 for an unauthenticated request', async () => {
    const { status } = await req(t.app, 'GET', '/entity');
    expect(status).toBe(401);
  });

  it('resolves the owner record id once and reuses it on later requests', async () => {
    await seedEntityRecordWithGeneratedId(t.ctx);
    const querySpy = vi.spyOn(t.ctx.stack, 'query');

    await req(t.app, 'GET', '/entity', { token: TEST_TOKEN });
    await req(t.app, 'GET', '/entity', { token: TEST_TOKEN });
    await req(t.app, 'GET', '/entity', { token: TEST_TOKEN });

    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('re-resolves after the cached record is deleted, and again once it is recreated', async () => {
    const first = await seedEntityRecordWithGeneratedId(t.ctx);

    const populate = await req(t.app, 'GET', '/entity', { token: TEST_TOKEN });
    expect(populate.status).toBe(200);

    await t.ctx.adapter.deleteRecord(first.id, { hard: true });
    const afterDelete = await req(t.app, 'GET', '/entity', { token: TEST_TOKEN });
    expect(afterDelete.status).toBe(404);

    const second = await seedEntityRecordWithGeneratedId(t.ctx);
    expect(second.id).not.toBe(first.id);
    const afterRecreate = await req(t.app, 'GET', '/entity', { token: TEST_TOKEN });
    expect(afterRecreate.status).toBe(200);
    expect((afterRecreate.data as Record<string, unknown>).id).toBe(second.id);
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

  it('reuses the record id cache GET already populated, without re-querying', async () => {
    await seedEntityRecordWithGeneratedId(t.ctx);
    await req(t.app, 'GET', '/entity', { token: TEST_TOKEN });

    const querySpy = vi.spyOn(t.ctx.stack, 'query');
    const { status } = await req(t.app, 'PATCH', '/entity', {
      token: TEST_TOKEN,
      body: { content: { name: 'Renamed' } },
    });
    expect(status).toBe(200);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('re-resolves on the next request after PATCHing a since-deleted cached record', async () => {
    const record = await seedEntityRecordWithGeneratedId(t.ctx);
    await req(t.app, 'GET', '/entity', { token: TEST_TOKEN }); // populate the cache

    await t.ctx.adapter.deleteRecord(record.id, { hard: true });
    const stale = await req(t.app, 'PATCH', '/entity', {
      token: TEST_TOKEN,
      body: { content: { name: 'X' } },
    });
    expect(stale.status).toBe(404);

    await seedEntityRecordWithGeneratedId(t.ctx);
    const recovered = await req(t.app, 'PATCH', '/entity', {
      token: TEST_TOKEN,
      body: { content: { name: 'Recovered' } },
    });
    expect(recovered.status).toBe(200);
  });
});
