import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, TEST_TOKEN, OTHER_ENTITY_ID, type TestApp } from '../setup.js';

const TYPE_ID = 'com.example.test/doc@1';

describe('Versions', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await t.ctx.stack.defineType(TYPE_ID, 'Doc', {
      body: { kind: 'text' as const, required: true as const },
    });
  });
  afterEach(async () => {
    await t.cleanup();
  });

  async function createAndPatch() {
    const record = await t.ctx.stack.create(TYPE_ID, { body: 'v1' });
    await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: { content: { body: 'v2' }, version: 2, updatedAt: new Date().toISOString() },
    });
    return record;
  }

  it('GET /records/:id/versions returns history', async () => {
    const record = await createAndPatch();
    const { status, data } = await req(t.app, 'GET', `/records/${record.id}/versions`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(200);
    expect((data as unknown[]).length).toBe(1);
  });

  it('GET /records/:id/versions/:version returns one version', async () => {
    const record = await createAndPatch();
    const { status, data } = await req(t.app, 'GET', `/records/${record.id}/versions/1`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).version).toBe(1);
  });

  it('POST /records/:id/restore/:version restores content without rewriting history', async () => {
    const record = await createAndPatch();
    const { status, data } = await req(t.app, 'POST', `/records/${record.id}/restore/1`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect((d.content as Record<string, unknown>).body).toBe('v1');
    // version 1 was snapshotted, then v2 was applied, then v2 was snapshotted for restore → new version is 3
    expect(d.version).toBe(3);
  });

  // Version history is now gated at the same level as update() — a
  // write-holder, or owner/creator — not plain read, per
  // docs/spec/versioning.md § History access.
  describe('history access requires write, not read', () => {
    async function seedShared(write: boolean) {
      const record = await t.ctx.stack.create(
        TYPE_ID,
        { body: 'v1' },
        {
          permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write }],
        },
      );
      await t.ctx.stack.update(record.id, { body: 'v2' });
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      return { record, token };
    }

    it('a read-only requester is refused GET /records/:id/versions', async () => {
      const { record, token } = await seedShared(false);
      const { status } = await req(t.app, 'GET', `/records/${record.id}/versions`, { token });
      expect(status).toBe(403);
    });

    it('a read-only requester is refused GET /records/:id/versions/:version', async () => {
      const { record, token } = await seedShared(false);
      const { status } = await req(t.app, 'GET', `/records/${record.id}/versions/1`, { token });
      expect(status).toBe(403);
    });

    it('a write-holder can still read version history', async () => {
      const { record, token } = await seedShared(true);
      const { status, data } = await req(t.app, 'GET', `/records/${record.id}/versions`, {
        token,
      });
      expect(status).toBe(200);
      expect((data as unknown[]).length).toBe(1);
    });
  });

  it('strips permissions from a version snapshot for a non-owner write-holder, but keeps entityId', async () => {
    const record = await t.ctx.stack.create(
      TYPE_ID,
      { body: 'v1' },
      {
        permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: true }],
      },
    );
    await t.ctx.stack.update(record.id, { body: 'v2' });
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

    const { data } = await req(t.app, 'GET', `/records/${record.id}/versions`, { token });
    const versions = data as Array<Record<string, unknown>>;
    expect(versions[0].permissions).toBeUndefined();

    const { data: ownerData } = await req(t.app, 'GET', `/records/${record.id}/versions`, {
      token: TEST_TOKEN,
    });
    const ownerVersions = ownerData as Array<Record<string, unknown>>;
    expect(ownerVersions[0].permissions).toBeDefined();
  });

  it('bumps version on every mutation kind, not just content updates', async () => {
    const record = await t.ctx.stack.create(TYPE_ID, { body: 'v1' });
    expect(record.version).toBe(1);

    await t.ctx.stack.associate(record.id, { kind: 'tag', label: 'starred' });
    expect((await t.ctx.adapter.getRecord(record.id))?.version).toBe(2);

    await t.ctx.stack.setPermissions(record.id, [{ access: 'public' }]);
    expect((await t.ctx.adapter.getRecord(record.id))?.version).toBe(3);

    await t.ctx.stack.delete(record.id);
    expect((await t.ctx.adapter.getRecord(record.id))?.version).toBe(4);

    await t.ctx.stack.undelete(record.id);
    expect((await t.ctx.adapter.getRecord(record.id))?.version).toBe(5);
  });
});
