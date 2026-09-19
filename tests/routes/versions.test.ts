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
      body: { contentPatch: { body: 'v2' } },
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

  describe('malformed :version path param', () => {
    it('GET /records/:id/versions/1abc is rejected rather than silently served as version 1', async () => {
      const record = await createAndPatch();
      const { status, data } = await req(t.app, 'GET', `/records/${record.id}/versions/1abc`, {
        token: TEST_TOKEN,
      });
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });

    it('POST /records/:id/restore/1abc is rejected rather than silently restoring version 1', async () => {
      const record = await createAndPatch();
      const { status, data } = await req(t.app, 'POST', `/records/${record.id}/restore/1abc`, {
        token: TEST_TOKEN,
      });
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });
  });

  describe('POST /records/:id/restore/:version — If-Match / optimistic concurrency', () => {
    it('succeeds when If-Match names the current version', async () => {
      const record = await createAndPatch();
      const current = await t.ctx.adapter.getRecord(record.id);
      const { status } = await req(t.app, 'POST', `/records/${record.id}/restore/1`, {
        token: TEST_TOKEN,
        headers: { 'If-Match': `"${current!.version}"` },
      });
      expect(status).toBe(200);
    });

    it('returns 412 version_conflict on an If-Match mismatch', async () => {
      const record = await createAndPatch();
      const current = await t.ctx.adapter.getRecord(record.id);
      const { status, data } = await req(t.app, 'POST', `/records/${record.id}/restore/1`, {
        token: TEST_TOKEN,
        headers: { 'If-Match': `"${current!.version + 1}"` },
      });
      expect(status).toBe(412);
      expect((data as { error: { code: string } }).error.code).toBe('version_conflict');
    });
  });

  // Version history is gated at the same level as update() — a
  // write-holder, or owner/creator — not plain read, per
  // docs/spec/versioning.md § History access.
  describe('history access requires write, not read', () => {
    async function seedShared(write: boolean) {
      const record = await t.ctx.stack.create(
        TYPE_ID,
        { body: 'v1' },
        {
          permissions: write
            ? [
                {
                  kind: 'permission',
                  label: 'read',
                  grantee: { scope: 'entity', entityId: OTHER_ENTITY_ID },
                },
                {
                  kind: 'permission',
                  label: 'write',
                  grantee: { scope: 'entity', entityId: OTHER_ENTITY_ID },
                },
              ]
            : [
                {
                  kind: 'permission',
                  label: 'read',
                  grantee: { scope: 'entity', entityId: OTHER_ENTITY_ID },
                },
              ],
        },
      );
      await t.ctx.stack.patchContent(record.id, { body: 'v2' });
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

  it('carries no containment, listing or authority state on a snapshot', async () => {
    const container = await t.ctx.stack.create(TYPE_ID, { body: 'container' });
    const record = await t.ctx.stack.create(
      TYPE_ID,
      { body: 'v1' },
      {
        parentId: container.id,
        unlisted: true,
        permissions: [
          {
            kind: 'permission',
            label: 'read',
            grantee: { scope: 'entity', entityId: OTHER_ENTITY_ID },
          },
        ],
      },
    );
    await t.ctx.stack.patchContent(record.id, { body: 'v2' });

    const { data } = await req(t.app, 'GET', `/records/${record.id}/versions`, {
      token: TEST_TOKEN,
    });
    const snapshot = (data as Array<Record<string, unknown>>)[0];
    expect(snapshot.content).toEqual({ body: 'v1' });
    expect(snapshot.parentId).toBeUndefined();
    expect(snapshot.unlistedAt).toBeUndefined();
    expect(snapshot.permissions).toBeUndefined();
  });

  it('bumps version for a content mutation and for nothing else', async () => {
    const record = await t.ctx.stack.create(TYPE_ID, { body: 'v1' });
    expect(record.version).toBe(1);

    // Associations, the ACL and listing state are all no-bump tiers: their
    // inverse is the same shape as the forward operation, so none of them
    // needs a snapshot to be recoverable from.
    await t.ctx.stack.associate(record.id, { kind: 'tag', label: 'starred' });
    expect((await t.ctx.adapter.getRecord(record.id))?.version).toBe(1);

    await t.ctx.stack.mutate(record.id, { permissions: [{ kind: 'anyone', label: 'read' }] });
    expect((await t.ctx.adapter.getRecord(record.id))?.version).toBe(1);

    await t.ctx.stack.mutate(record.id, { unlisted: true });
    expect((await t.ctx.adapter.getRecord(record.id))?.version).toBe(1);

    await t.ctx.stack.patchContent(record.id, { body: 'v2' });
    expect((await t.ctx.adapter.getRecord(record.id))?.version).toBe(2);

    await t.ctx.stack.delete(record.id);
    expect((await t.ctx.adapter.getRecord(record.id))?.version).toBe(3);

    await t.ctx.stack.undelete(record.id);
    expect((await t.ctx.adapter.getRecord(record.id))?.version).toBe(4);
  });
});
