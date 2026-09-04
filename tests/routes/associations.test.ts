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

  describe('If-Match / optimistic concurrency', () => {
    it('POST /associations succeeds when If-Match names the current version', async () => {
      const record = await seedRecord();
      const { status } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: { kind: 'tag', label: 'starred' },
        headers: { 'If-Match': `"${record.version}"` },
      });
      expect(status).toBe(200);
    });

    it('POST /associations returns 412 version_conflict on an If-Match mismatch', async () => {
      const record = await seedRecord();
      const { status, data } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: { kind: 'tag', label: 'starred' },
        headers: { 'If-Match': `"${record.version + 1}"` },
      });
      expect(status).toBe(412);
      expect((data as { error: { code: string } }).error.code).toBe('version_conflict');
    });

    it('POST /associations/delete succeeds when If-Match names the current version', async () => {
      const record = await seedRecord();
      await t.ctx.adapter.associate(record.id, { kind: 'tag', label: 'starred' });
      const current = await t.ctx.adapter.getRecord(record.id);
      const { status } = await req(t.app, 'POST', `/records/${record.id}/associations/delete`, {
        token: TEST_TOKEN,
        body: { kind: 'tag', label: 'starred' },
        headers: { 'If-Match': `"${current!.version}"` },
      });
      expect(status).toBe(200);
    });

    it('POST /associations/delete returns 412 version_conflict on an If-Match mismatch', async () => {
      const record = await seedRecord();
      await t.ctx.adapter.associate(record.id, { kind: 'tag', label: 'starred' });
      const current = await t.ctx.adapter.getRecord(record.id);
      const { status, data } = await req(
        t.app,
        'POST',
        `/records/${record.id}/associations/delete`,
        {
          token: TEST_TOKEN,
          body: { kind: 'tag', label: 'starred' },
          headers: { 'If-Match': `"${current!.version + 1}"` },
        },
      );
      expect(status).toBe(412);
      expect((data as { error: { code: string } }).error.code).toBe('version_conflict');
    });
  });
});
