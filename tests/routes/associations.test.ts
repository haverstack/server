import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, TEST_TOKEN, type TestApp } from '../setup.js';

const TYPE_ID = 'com.example.test/post@1';

describe('Associations', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await t.ctx.stack.defineType(TYPE_ID, 'Post', {
      text: { kind: 'text' as const, required: true as const },
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
      body: { kind: 'tag', label: 'starred' },
    });
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).associations).toEqual([
      { kind: 'tag', label: 'starred' },
    ]);
  });

  it('POST adds a relationship association with a record-scope target and answers with the updated record', async () => {
    const record = await seedRecord();
    const other = await seedRecord();
    const target = { scope: 'record' as const, recordId: other.id };
    const { status, data } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { kind: 'relationship', label: 'reply-to', target },
    });
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).associations).toEqual([
      { kind: 'relationship', label: 'reply-to', target },
    ]);
  });

  it.each([
    ['entity', { scope: 'entity', entityId: 'did:key:z6MkAlice' }],
    ['external', { scope: 'external', ns: 'atproto', id: 'at://did:plc:abc/app.bsky.feed.post/1' }],
  ] as const)(
    'POST adds a relationship association with a %s-scope target and answers with the updated record',
    async (_scope, target) => {
      const record = await seedRecord();
      const { status, data } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: { kind: 'relationship', label: 'reply-to', target },
      });
      expect(status).toBe(200);
      expect((data as Record<string, unknown>).associations).toEqual([
        { kind: 'relationship', label: 'reply-to', target },
      ]);
    },
  );

  it('GET returns all associations', async () => {
    const record = await seedRecord();
    await t.ctx.adapter.associate(record.id, { kind: 'tag', label: 'starred' });
    await t.ctx.adapter.associate(record.id, { kind: 'tag', label: 'archived' });
    const { status, data } = await req(t.app, 'GET', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(200);
    expect((data as { associations: unknown[] }).associations).toHaveLength(2);
  });

  it('GET ?kind=tag filters by kind', async () => {
    const record = await seedRecord();
    await t.ctx.adapter.associate(record.id, { kind: 'tag', label: 'starred' });
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

  it('POST .../associations/delete removes an association and answers with the updated record', async () => {
    const record = await seedRecord();
    await t.ctx.adapter.associate(record.id, { kind: 'tag', label: 'starred' });
    const { status, data } = await req(t.app, 'POST', `/records/${record.id}/associations/delete`, {
      token: TEST_TOKEN,
      body: { kind: 'tag', label: 'starred' },
    });
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).associations).toBeUndefined();
    const after = await t.ctx.adapter.getRecord(record.id);
    expect(after?.associations?.some((a) => a.label === 'starred')).toBeFalsy();
  });

  it('POST .../associations/delete removes a relationship association regardless of target scope', async () => {
    const record = await seedRecord();
    const target = { scope: 'entity' as const, entityId: 'did:key:z6MkAlice' };
    await t.ctx.adapter.associate(record.id, { kind: 'relationship', label: 'author', target });
    const { status, data } = await req(t.app, 'POST', `/records/${record.id}/associations/delete`, {
      token: TEST_TOKEN,
      body: { kind: 'relationship', label: 'author', target },
    });
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).associations).toBeUndefined();
    const after = await t.ctx.adapter.getRecord(record.id);
    expect(after?.associations?.some((a) => a.label === 'author')).toBeFalsy();
  });

  describe('no-bump semantics', () => {
    it('leaves version and updatedAt where they stand on both endpoints', async () => {
      const record = await seedRecord();
      const before = await t.ctx.adapter.getRecord(record.id);

      const added = await req(t.app, 'POST', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: { kind: 'tag', label: 'starred' },
      });
      expect(added.status).toBe(200);
      expect((added.data as { version: number }).version).toBe(before!.version);

      const removed = await req(t.app, 'POST', `/records/${record.id}/associations/delete`, {
        token: TEST_TOKEN,
        body: { kind: 'tag', label: 'starred' },
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
        body: { kind: 'tag', label: 'starred' },
      });
      const { data } = await req(t.app, 'GET', `/records/${record.id}/versions`, {
        token: TEST_TOKEN,
      });
      expect(data).toEqual([]);
    });

    it('ignores an If-Match that names a stale version rather than refusing it', async () => {
      const record = await seedRecord();
      const { status } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: { kind: 'tag', label: 'starred' },
        headers: { 'If-Match': `"${record.version + 99}"` },
      });
      expect(status).toBe(200);
    });
  });

  describe('authority kinds are refused', () => {
    it('refuses a permission element sent to POST /associations', async () => {
      const record = await seedRecord();
      const { status, data } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: {
          kind: 'permission',
          label: 'read',
          grantee: { scope: 'entity', entityId: 'entity-other' },
        },
      });
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });

    it('refuses an anyone element sent to POST /associations/delete', async () => {
      const record = await seedRecord();
      const { status, data } = await req(
        t.app,
        'POST',
        `/records/${record.id}/associations/delete`,
        {
          token: TEST_TOKEN,
          body: { kind: 'anyone', label: 'read' },
        },
      );
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });
  });
});
