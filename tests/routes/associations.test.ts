import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, TEST_TOKEN, type TestApp } from '../setup.js';

const TYPE_ID = 'com.example.test/post@1';

describe('Associations', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await t.ctx.stack.defineType({
      id: TYPE_ID,
      name: 'Post',
      schema: {
        text: { kind: 'text' as const, required: true as const },
      },
    });
  });
  afterEach(async () => {
    await t.cleanup();
  });

  async function seedRecord() {
    return t.ctx.stack.create(TYPE_ID, { text: 'Hello' });
  }

  it('POST adds a tag association and answers with the updated record', async () => {
    const record = await seedRecord();
    const { status, data } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { changes: [{ op: 'add', association: { kind: 'tag', label: 'starred' } }] },
    });
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).associations).toEqual([
      { kind: 'tag', label: 'starred' },
    ]);
  });

  it('POST adds a relationship association with a record target and answers with the updated record', async () => {
    const record = await seedRecord();
    const other = await seedRecord();
    const target = { kind: 'record' as const, recordId: other.id };
    const { status, data } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: {
        changes: [{ op: 'add', association: { kind: 'relationship', label: 'reply-to', target } }],
      },
    });
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).associations).toEqual([
      { kind: 'relationship', label: 'reply-to', target },
    ]);
  });

  it.each([
    ['entity', { kind: 'entity', entityId: 'did:key:z6MkAlice' }],
    ['external', { kind: 'external', ns: 'atproto', id: 'at://did:plc:abc/app.bsky.feed.post/1' }],
  ] as const)(
    'POST adds a relationship association with a %s target and answers with the updated record',
    async (_scope, target) => {
      const record = await seedRecord();
      const { status, data } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: {
          changes: [
            { op: 'add', association: { kind: 'relationship', label: 'reply-to', target } },
          ],
        },
      });
      expect(status).toBe(200);
      expect((data as Record<string, unknown>).associations).toEqual([
        { kind: 'relationship', label: 'reply-to', target },
      ]);
    },
  );

  it('GET returns all associations', async () => {
    const record = await seedRecord();
    await t.ctx.adapter.editAssociations(record.id, [
      { op: 'add', association: { kind: 'tag', label: 'starred' } },
    ]);
    await t.ctx.adapter.editAssociations(record.id, [
      { op: 'add', association: { kind: 'tag', label: 'archived' } },
    ]);
    const { status, data } = await req(t.app, 'GET', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(200);
    expect((data as { associations: unknown[] }).associations).toHaveLength(2);
  });

  it('GET ?kind=tag filters by kind', async () => {
    const record = await seedRecord();
    await t.ctx.adapter.editAssociations(record.id, [
      { op: 'add', association: { kind: 'tag', label: 'starred' } },
    ]);
    const { status, data } = await req(
      t.app,
      'GET',
      `/records/${record.id}/associations?kind=tag`,
      { token: TEST_TOKEN },
    );
    expect(status).toBe(200);
    const assocs = (data as { associations: Array<{ kind: string }> }).associations;
    expect(assocs.every((a) => a.kind === 'tag')).toBe(true);
  });

  it('POST a remove edit removes an association and answers with the updated record', async () => {
    const record = await seedRecord();
    await t.ctx.adapter.editAssociations(record.id, [
      { op: 'add', association: { kind: 'tag', label: 'starred' } },
    ]);
    const { status, data } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { changes: [{ op: 'remove', association: { kind: 'tag', label: 'starred' } }] },
    });
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).associations).toBeUndefined();
    const after = await t.ctx.adapter.getRecord(record.id);
    expect(after?.associations?.some((a) => a.label === 'starred')).toBeFalsy();
  });

  it('POST a remove edit removes a relationship association regardless of target kind', async () => {
    const record = await seedRecord();
    const target = { kind: 'entity' as const, entityId: 'did:key:z6MkAlice' };
    await t.ctx.adapter.editAssociations(record.id, [
      { op: 'add', association: { kind: 'relationship', label: 'author', target } },
    ]);
    const { status, data } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: {
        changes: [{ op: 'remove', association: { kind: 'relationship', label: 'author', target } }],
      },
    });
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).associations).toBeUndefined();
    const after = await t.ctx.adapter.getRecord(record.id);
    expect(after?.associations?.some((a) => a.label === 'author')).toBeFalsy();
  });

  it('PUT replaces the data set and leaves permissions alone', async () => {
    const record = await t.ctx.stack.create(
      TYPE_ID,
      { text: 'Hello' },
      {
        associations: [{ kind: 'tag', label: 'draft' }],
        permissions: [{ kind: 'anyone', label: 'read' }],
      },
    );
    const { status, data } = await req(t.app, 'PUT', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { associations: [{ kind: 'tag', label: 'reviewed' }] },
    });
    expect(status).toBe(200);
    const body = data as { associations?: unknown[]; permissions?: unknown[] };
    expect(body.associations).toEqual([{ kind: 'tag', label: 'reviewed' }]);
    expect(body.permissions).toEqual([{ kind: 'anyone', label: 'read' }]);
  });

  it('GET refuses a kind no association has, rather than answering every kind', async () => {
    const record = await seedRecord();
    const { status } = await req(t.app, 'GET', `/records/${record.id}/associations?kind=tags`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(400);
  });

  describe('no-bump semantics', () => {
    it('leaves version and updatedAt where they stand on both endpoints', async () => {
      const record = await seedRecord();
      const before = await t.ctx.adapter.getRecord(record.id);

      const added = await req(t.app, 'POST', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: { changes: [{ op: 'add', association: { kind: 'tag', label: 'starred' } }] },
      });
      expect(added.status).toBe(200);
      expect((added.data as { version: number }).version).toBe(before!.version);

      const removed = await req(t.app, 'POST', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: { changes: [{ op: 'remove', association: { kind: 'tag', label: 'starred' } }] },
      });
      expect(removed.status).toBe(200);

      const after = await t.ctx.adapter.getRecord(record.id);
      expect(after!.version).toBe(before!.version);
      expect(after!.updatedAt.toISOString()).toBe(before!.updatedAt.toISOString());
    });

    it('writes no version snapshot', async () => {
      const record = await seedRecord();
      await req(t.app, 'POST', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: { changes: [{ op: 'add', association: { kind: 'tag', label: 'starred' } }] },
      });
      const { data } = await req(t.app, 'GET', `/records/${record.id}/versions`, {
        token: TEST_TOKEN,
      });
      expect(data).toEqual({ versions: [], cursor: null });
    });

    it('checks If-Match like every write, though it bumps nothing', async () => {
      const record = await seedRecord();
      const stale = await req(t.app, 'POST', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: { changes: [{ op: 'add', association: { kind: 'tag', label: 'starred' } }] },
        headers: { 'If-Match': `"${record.version + 99}"` },
      });
      expect(stale.status).toBe(412);
      const current = await req(t.app, 'PUT', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: { associations: [{ kind: 'tag', label: 'starred' }] },
        headers: { 'If-Match': `"${record.version}"` },
      });
      expect(current.status).toBe(200);
    });
  });

  describe('authority kinds are refused', () => {
    it('refuses a permission element sent to POST /associations', async () => {
      const record = await seedRecord();
      const { status, data } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: {
          changes: [
            {
              op: 'add',
              association: {
                kind: 'permission',
                label: 'read',
                grantee: { kind: 'entity', entityId: 'entity-other' },
              },
            },
          ],
        },
      });
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });

    it('refuses an anyone element in a remove edit', async () => {
      const record = await seedRecord();
      const { status, data } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: { changes: [{ op: 'remove', association: { kind: 'anyone', label: 'read' } }] },
      });
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });
  });
});
