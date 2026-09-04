import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SYSTEM_TYPES, generateId } from '@haverstack/core';
import {
  buildTestApp,
  req,
  TEST_TOKEN,
  TEST_ENTITY_ID,
  OTHER_ENTITY_ID,
  type TestApp,
} from '../setup.js';

const NOTE_TYPE_ID = 'com.example.test/note@1';
const GRANT_TYPE_ID = `${SYSTEM_TYPES.GRANT}@1`;

async function seedType(ctx: TestApp['ctx']) {
  return ctx.stack.defineType(NOTE_TYPE_ID, 'Note', {
    title: { kind: 'string' as const },
    body: { kind: 'text' as const, required: true as const },
  });
}

async function seedRecord(ctx: TestApp['ctx'], overrides: Record<string, unknown> = {}) {
  return ctx.stack.create(NOTE_TYPE_ID, { body: 'Hello world', ...overrides });
}

describe('Records', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await seedType(t.ctx);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  describe('POST /records', () => {
    it('creates a record and returns a server-generated id', async () => {
      const { status, data } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: {
          typeId: NOTE_TYPE_ID,
          content: { body: 'Test note' },
          entityId: TEST_ENTITY_ID,
        },
      });
      expect(status).toBe(200);
      const d = data as Record<string, unknown>;
      expect(typeof d.id).toBe('string');
      expect(d.typeId).toBe(NOTE_TYPE_ID);
      expect((d.content as Record<string, unknown>).body).toBe('Test note');
    });

    it('returns 400 when typeId is missing', async () => {
      const { status } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: { content: { body: 'x' } },
      });
      expect(status).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const { status } = await req(t.app, 'POST', '/records', {
        body: { typeId: NOTE_TYPE_ID, content: { body: 'x' } },
      });
      expect(status).toBe(401);
    });

    it('returns 422 for a typeId that has not been defined', async () => {
      const { status, data } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: { typeId: 'com.example.test/article@1', content: { body: 'x' } },
      });
      expect(status).toBe(422);
      const d = data as { error: { code: string; details: unknown[] } };
      expect(d.error.code).toBe('validation');
      expect(d.error.details).toEqual([
        { path: 'typeId', message: 'Unknown type: "com.example.test/article@1"' },
      ]);
    });

    it('returns 422 when a required content field is missing', async () => {
      const { status, data } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: { typeId: NOTE_TYPE_ID, content: {} },
      });
      expect(status).toBe(422);
      const d = data as { error: { code: string; message: string; details: unknown[] } };
      expect(d.error.code).toBe('validation');
      expect(typeof d.error.message).toBe('string');
      expect(Array.isArray(d.error.details)).toBe(true);
      expect(d.error.details.length).toBeGreaterThan(0);
    });
  });

  describe('GET /records/:id', () => {
    it('returns a record by id', async () => {
      const record = await seedRecord(t.ctx);
      const { status, data } = await req(t.app, 'GET', `/records/${record.id}`, {
        token: TEST_TOKEN,
      });
      expect(status).toBe(200);
      expect((data as Record<string, unknown>).id).toBe(record.id);
    });

    it('returns 404 for unknown id', async () => {
      const { status } = await req(t.app, 'GET', '/records/nonexistent', { token: TEST_TOKEN });
      expect(status).toBe(404);
    });

    it('anonymous gets 404 + WWW-Authenticate for a private record, not 403', async () => {
      const record = await seedRecord(t.ctx);
      const res = await t.app.request(`/records/${record.id}`);
      expect(res.status).toBe(404);
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
    });

    it('anonymous can read a public record', async () => {
      const record = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'public content' },
        {
          permissions: [{ access: 'public' }],
        },
      );
      const { status, data } = await req(t.app, 'GET', `/records/${record.id}`);
      expect(status).toBe(200);
      expect((data as Record<string, unknown>).id).toBe(record.id);
    });

    it('entity with a read grant can read the record', async () => {
      const record = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'shared content' },
        {
          permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: false }],
        },
      );
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const { status } = await req(t.app, 'GET', `/records/${record.id}`, { token });
      expect(status).toBe(200);
    });

    it('entity without a grant gets 404, not 403, and no WWW-Authenticate (already authenticated)', async () => {
      const record = await seedRecord(t.ctx);
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const res = await t.app.request(`/records/${record.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('WWW-Authenticate')).toBeNull();
    });
  });

  describe('GET /records', () => {
    it('returns records list', async () => {
      await seedRecord(t.ctx, { body: 'Note 1' });
      await seedRecord(t.ctx, { body: 'Note 2' });
      const { status, data } = await req(t.app, 'GET', '/records', { token: TEST_TOKEN });
      expect(status).toBe(200);
      const d = data as { records: unknown[]; total: null };
      expect(d.total).toBeNull();
      expect(d.records).toHaveLength(2);
    });

    it('filters by typeId query param', async () => {
      await seedRecord(t.ctx);
      const { data } = await req(
        t.app,
        'GET',
        `/records?typeId=${encodeURIComponent(NOTE_TYPE_ID)}`,
        { token: TEST_TOKEN },
      );
      expect((data as { records: unknown[] }).records).toHaveLength(1);
    });

    it('filters by createdBefore/createdAfter query params', async () => {
      await seedRecord(t.ctx);
      const future = new Date(Date.now() + 60_000).toISOString();
      const past = new Date(0).toISOString();

      const { data: before } = await req(
        t.app,
        'GET',
        `/records?createdBefore=${encodeURIComponent(future)}`,
        { token: TEST_TOKEN },
      );
      expect((before as { records: unknown[] }).records).toHaveLength(1);

      const { data: after } = await req(
        t.app,
        'GET',
        `/records?createdAfter=${encodeURIComponent(future)}`,
        { token: TEST_TOKEN },
      );
      expect((after as { records: unknown[] }).records).toHaveLength(0);

      const { data: narrow } = await req(
        t.app,
        'GET',
        `/records?createdAfter=${encodeURIComponent(past)}&createdBefore=${encodeURIComponent(future)}`,
        { token: TEST_TOKEN },
      );
      expect((narrow as { records: unknown[] }).records).toHaveLength(1);
    });

    it('filters by relatedTo, narrowed further by relatedToLabel', async () => {
      const target = await seedRecord(t.ctx, { body: 'target' });
      const child = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'child' },
        {
          associations: [
            {
              kind: 'relationship',
              label: 'child',
              target: { scope: 'record', recordId: target.id },
            },
          ],
        },
      );
      await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'sibling' },
        {
          associations: [
            {
              kind: 'relationship',
              label: 'sibling',
              target: { scope: 'record', recordId: target.id },
            },
          ],
        },
      );

      const { data: unlabeled } = await req(
        t.app,
        'GET',
        `/records?relatedTo=${encodeURIComponent(target.id)}`,
        { token: TEST_TOKEN },
      );
      expect((unlabeled as { records: Array<{ id: string }> }).records).toHaveLength(2);

      const { data: labeled } = await req(
        t.app,
        'GET',
        `/records?relatedTo=${encodeURIComponent(target.id)}&relatedToLabel=child`,
        { token: TEST_TOKEN },
      );
      const labeledRecords = (labeled as { records: Array<{ id: string }> }).records;
      expect(labeledRecords).toHaveLength(1);
      expect(labeledRecords[0]!.id).toBe(child.id);
    });

    it('filters by relatedToEntity, distinct from relatedTo', async () => {
      const entityChild = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'entity-child' },
        {
          associations: [
            {
              kind: 'relationship',
              label: 'author',
              target: { scope: 'entity', entityId: OTHER_ENTITY_ID },
            },
          ],
        },
      );

      const { status, data } = await req(
        t.app,
        'GET',
        `/records?relatedToEntity=${encodeURIComponent(OTHER_ENTITY_ID)}`,
        { token: TEST_TOKEN },
      );
      expect(status).toBe(200);
      const records = (data as { records: Array<{ id: string }> }).records;
      expect(records).toHaveLength(1);
      expect(records[0]!.id).toBe(entityChild.id);
    });

    it('filters by relatedToNs, and relatedToId narrows to one target in the namespace', async () => {
      const syndicated = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'syndicated' },
        {
          associations: [
            {
              kind: 'relationship',
              label: 'syndicated-to',
              target: {
                scope: 'external',
                ns: 'atproto',
                id: 'at://did:plc:abc/app.bsky.feed.post/1',
              },
            },
          ],
        },
      );
      await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'other-namespace' },
        {
          associations: [
            {
              kind: 'relationship',
              label: 'syndicated-to',
              target: { scope: 'external', ns: 'activitypub', id: 'https://example.social/1' },
            },
          ],
        },
      );

      const { data: nsOnly } = await req(t.app, 'GET', '/records?relatedToNs=atproto', {
        token: TEST_TOKEN,
      });
      const nsRecords = (nsOnly as { records: Array<{ id: string }> }).records;
      expect(nsRecords).toHaveLength(1);
      expect(nsRecords[0]!.id).toBe(syndicated.id);

      const { data: nsAndId } = await req(
        t.app,
        'GET',
        `/records?relatedToNs=atproto&relatedToId=${encodeURIComponent('at://did:plc:abc/app.bsky.feed.post/1')}`,
        { token: TEST_TOKEN },
      );
      const nsIdRecords = (nsAndId as { records: Array<{ id: string }> }).records;
      expect(nsIdRecords).toHaveLength(1);
      expect(nsIdRecords[0]!.id).toBe(syndicated.id);
    });

    it('relatedToLabel alone (no target) matches every target under that label', async () => {
      const recordChild = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'record-child' },
        {
          associations: [
            {
              kind: 'relationship',
              label: 'reply-to',
              target: { scope: 'record', recordId: (await seedRecord(t.ctx)).id },
            },
          ],
        },
      );
      const entityChild = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'entity-child' },
        {
          associations: [
            {
              kind: 'relationship',
              label: 'reply-to',
              target: { scope: 'entity', entityId: OTHER_ENTITY_ID },
            },
          ],
        },
      );

      const { status, data } = await req(t.app, 'GET', '/records?relatedToLabel=reply-to', {
        token: TEST_TOKEN,
      });
      expect(status).toBe(200);
      const ids = (data as { records: Array<{ id: string }> }).records.map((r) => r.id).sort();
      expect(ids).toEqual([recordChild.id, entityChild.id].sort());
    });

    it('an absent relatedToStack matches only local record targets', async () => {
      const target = await seedRecord(t.ctx, { body: 'target' });
      const local = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'local' },
        {
          associations: [
            {
              kind: 'relationship',
              label: 'ref',
              target: { scope: 'record', recordId: target.id },
            },
          ],
        },
      );
      await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'remote' },
        {
          associations: [
            {
              kind: 'relationship',
              label: 'ref',
              target: {
                scope: 'record',
                recordId: target.id,
                stackUrl: 'https://other.example/stack',
              },
            },
          ],
        },
      );

      const { data: withoutStack } = await req(
        t.app,
        'GET',
        `/records?relatedTo=${encodeURIComponent(target.id)}`,
        { token: TEST_TOKEN },
      );
      const withoutStackRecords = (withoutStack as { records: Array<{ id: string }> }).records;
      expect(withoutStackRecords).toHaveLength(1);
      expect(withoutStackRecords[0]!.id).toBe(local.id);

      const { data: withStack } = await req(
        t.app,
        'GET',
        `/records?relatedTo=${encodeURIComponent(target.id)}&relatedToStack=${encodeURIComponent('https://other.example/stack')}`,
        { token: TEST_TOKEN },
      );
      const withStackRecords = (withStack as { records: Array<{ id: string }> }).records;
      expect(withStackRecords).toHaveLength(1);
      expect(withStackRecords[0]!.id).not.toBe(local.id);
    });

    it('rejects mixed relatedTo scopes with 400 bad_request', async () => {
      const { status, data } = await req(
        t.app,
        'GET',
        `/records?relatedTo=x&relatedToEntity=${encodeURIComponent(OTHER_ENTITY_ID)}`,
        { token: TEST_TOKEN },
      );
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });

    it('rejects relatedToStack without relatedTo with 400 bad_request', async () => {
      const { status, data } = await req(
        t.app,
        'GET',
        '/records?relatedToStack=https://other.example/stack',
        { token: TEST_TOKEN },
      );
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });

    it('rejects relatedToId without relatedToNs with 400 bad_request', async () => {
      const { status, data } = await req(t.app, 'GET', '/records?relatedToId=at://foo', {
        token: TEST_TOKEN,
      });
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });

    it('rejects an empty relatedToStack with 400 rather than treating it as local or a wildcard', async () => {
      const target = await seedRecord(t.ctx, { body: 'target' });
      const { status, data } = await req(
        t.app,
        'GET',
        `/records?relatedTo=${encodeURIComponent(target.id)}&relatedToStack=`,
        { token: TEST_TOKEN },
      );
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });

    it('rejects an empty relatedToId with 400', async () => {
      const { status, data } = await req(
        t.app,
        'GET',
        '/records?relatedToNs=atproto&relatedToId=',
        {
          token: TEST_TOKEN,
        },
      );
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });

    it('anonymous query returns only public records', async () => {
      await seedRecord(t.ctx, { body: 'private' });
      await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'public' },
        { permissions: [{ access: 'public' }] },
      );
      const { data } = await req(t.app, 'GET', '/records');
      const d = data as { records: Array<{ content: { body: string } }>; total: null };
      expect(d.total).toBeNull();
      expect(d.records).toHaveLength(1);
      expect(d.records[0].content.body).toBe('public');
    });
  });

  describe('POST /records/query', () => {
    it('accepts a full StackQuery body', async () => {
      await seedRecord(t.ctx);
      const { status, data } = await req(t.app, 'POST', '/records/query', {
        token: TEST_TOKEN,
        body: {
          filter: { typeId: NOTE_TYPE_ID },
          sort: { field: 'createdAt', direction: 'desc' },
          limit: 10,
        },
      });
      expect(status).toBe(200);
      const d = data as { records: unknown[]; total: null };
      expect(d.records).toHaveLength(1);
      expect(d.total).toBeNull();
    });

    it('anonymous query returns only public records', async () => {
      await seedRecord(t.ctx, { body: 'private' });
      await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'public' },
        { permissions: [{ access: 'public' }] },
      );
      const { status, data } = await req(t.app, 'POST', '/records/query', {
        body: { filter: { typeId: NOTE_TYPE_ID } },
      });
      expect(status).toBe(200);
      const d = data as { records: Array<{ content: { body: string } }>; total: null };
      expect(d.total).toBeNull();
      expect(d.records).toHaveLength(1);
      expect(d.records[0].content.body).toBe('public');
    });
  });

  describe('PATCH /records/:id', () => {
    it('merges content (does not overwrite unmentioned fields)', async () => {
      const record = await seedRecord(t.ctx, { body: 'original', title: 'My title' });
      const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { body: 'Updated body' },
      });
      expect(status).toBe(200);
      const d = data as Record<string, unknown>;
      const content = d.content as Record<string, unknown>;
      expect(content.body).toBe('Updated body');
      expect(content.title).toBe('My title');
      expect(d.version).toBe(2);
    });

    it('snapshots the previous version on update', async () => {
      const record = await seedRecord(t.ctx);
      await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { body: 'v2' },
      });
      const versions = await t.ctx.adapter.getVersions(record.id);
      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe(1);
    });

    it('returns 403 when requester lacks write access', async () => {
      const record = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'hi' },
        {
          permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: false }],
        },
      );
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const { status } = await req(t.app, 'PATCH', `/records/${record.id}`, {
        token,
        body: { body: 'hacked' },
      });
      expect(status).toBe(403);
    });
  });

  describe('DELETE /records/:id', () => {
    it('soft-deletes by default, answering with the deleted record', async () => {
      const record = await seedRecord(t.ctx);
      const { status, data } = await req(t.app, 'DELETE', `/records/${record.id}`, {
        token: TEST_TOKEN,
      });
      expect(status).toBe(200);
      expect((data as Record<string, unknown>).deletedAt).toBeDefined();
      const after = await t.ctx.adapter.getRecord(record.id);
      expect(after?.deletedAt).toBeDefined();
    });

    it('hard-deletes with ?hard=true (owner)', async () => {
      const record = await seedRecord(t.ctx);
      const { status } = await req(t.app, 'DELETE', `/records/${record.id}?hard=true`, {
        token: TEST_TOKEN,
      });
      expect(status).toBe(204);
      expect(await t.ctx.adapter.getRecord(record.id)).toBeNull();
    });

    it('non-owner with write access can soft-delete', async () => {
      const record = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'shared' },
        {
          permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: true }],
        },
      );
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const { status } = await req(t.app, 'DELETE', `/records/${record.id}`, { token });
      expect(status).toBe(200);
      const after = await t.ctx.adapter.getRecord(record.id);
      expect(after?.deletedAt).toBeDefined();
    });

    it('non-owner gets 403 on hard delete even with write access', async () => {
      const record = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'shared' },
        {
          permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: true }],
        },
      );
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const { status } = await req(t.app, 'DELETE', `/records/${record.id}?hard=true`, { token });
      expect(status).toBe(403);
      expect(await t.ctx.adapter.getRecord(record.id)).not.toBeNull();
    });

    it('succeeds when If-Match names the current version', async () => {
      const record = await seedRecord(t.ctx);
      const { status } = await req(t.app, 'DELETE', `/records/${record.id}`, {
        token: TEST_TOKEN,
        headers: { 'If-Match': `"${record.version}"` },
      });
      expect(status).toBe(200);
    });

    it('returns 412 version_conflict on an If-Match mismatch, leaving the record untouched', async () => {
      const record = await seedRecord(t.ctx);
      const { status, data } = await req(t.app, 'DELETE', `/records/${record.id}`, {
        token: TEST_TOKEN,
        headers: { 'If-Match': `"${record.version + 1}"` },
      });
      expect(status).toBe(412);
      expect((data as { error: { code: string } }).error.code).toBe('version_conflict');
      expect((await t.ctx.adapter.getRecord(record.id))?.deletedAt).toBeUndefined();
    });
  });

  describe('_attachment@1 immutable field protection', () => {
    // Enforced by ScopedStack now (docs/spec/attachments.md § The _attachment
    // record type) — putAttachment() itself returns the created record, so
    // no separate query is needed to find it.
    async function seedAttachment(ctx: TestApp['ctx']) {
      const record = await ctx.stack.putAttachment(
        new TextEncoder().encode('hello'),
        'text/plain',
        'hello.txt',
      );
      return { fileId: (record.content as { fileId: string }).fileId, record };
    }

    function detailPaths(data: unknown): string[] {
      return (data as { error: { details: Array<{ path: string }> } }).error.details.map(
        (d) => d.path,
      );
    }

    it('returns 422 when PATCH attempts to change fileId', async () => {
      const { record } = await seedAttachment(t.ctx);
      const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { fileId: 'tampered-id' },
      });
      expect(status).toBe(422);
      expect(detailPaths(data)).toContain('fileId');
    });

    it('returns 422 when PATCH attempts to change size', async () => {
      const { record } = await seedAttachment(t.ctx);
      const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { size: 9999 },
      });
      expect(status).toBe(422);
      expect(detailPaths(data)).toContain('size');
    });

    it('returns 422 when PATCH attempts to change mimeType', async () => {
      const { record } = await seedAttachment(t.ctx);
      const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { mimeType: 'text/html' },
      });
      expect(status).toBe(422);
      expect(detailPaths(data)).toContain('mimeType');
    });

    it('reports all attempted immutable fields', async () => {
      const { record } = await seedAttachment(t.ctx);
      const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { fileId: 'x', size: 0, mimeType: 'text/html' },
      });
      expect(status).toBe(422);
      const paths = detailPaths(data);
      expect(paths).toContain('fileId');
      expect(paths).toContain('size');
      expect(paths).toContain('mimeType');
    });

    it('allows PATCH to change filename', async () => {
      const { record } = await seedAttachment(t.ctx);
      const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { filename: 'renamed.txt' },
      });
      expect(status).toBe(200);
      const content = (data as { content: Record<string, unknown> }).content;
      expect(content.filename).toBe('renamed.txt');
      expect(content.fileId).toBeDefined();
    });
  });

  describe('_grant@1 write protection', () => {
    it('refuses to grant privileges on _grant/_config/_app (privilege-escalation guard)', async () => {
      // stack.grant() itself forecloses the escalation vector the old test
      // below exercised via a route-level guard: it's no longer possible to
      // hand out a grant that targets _grant, so there is nothing for a
      // non-owner to escalate with in the first place.
      await expect(
        t.ctx.stack.grant(OTHER_ENTITY_ID, [{ actions: ['update-own'], typeId: GRANT_TYPE_ID }]),
      ).rejects.toThrow(/privilege escalation/);
    });

    it('returns 403 when non-owner tries to PATCH a grant record, even with direct write permission on it', async () => {
      // ScopedStack refuses writes to any _grant record unconditionally,
      // "whatever its own permissions say" — set an explicit write grant on
      // this one record (bypassing stack.grant()'s own refusal by creating
      // it directly) to prove the fence holds regardless.
      const grantRecord = await t.ctx.stack.create(
        GRANT_TYPE_ID,
        { typeId: NOTE_TYPE_ID, actions: ['read-own'] },
        {
          permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: true }],
        },
      );
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

      const { status } = await req(t.app, 'PATCH', `/records/${grantRecord.id}`, {
        token,
        body: { actions: ['read-any', 'update-any', 'delete-any'] },
      });
      expect(status).toBe(403);
    });

    it('returns 403 when non-owner tries to soft-DELETE a grant record, even with direct write permission on it', async () => {
      // stack.grant() doesn't give the grantee read access to the grant
      // record itself, only to what it grants — which would now 404 under
      // the anti-oracle rule rather than exercise the write-protection fence
      // this test targets. Set an explicit read+write permission directly on
      // the grant record instead (same approach as the PATCH sibling above)
      // so the requester can read it, and the refusal proven here is really
      // "_grant records refuse deletion" rather than "can't read it".
      const grantRecord = await t.ctx.stack.create(
        GRANT_TYPE_ID,
        { typeId: NOTE_TYPE_ID, actions: ['read-own'] },
        {
          permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: true }],
        },
      );
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

      const { status } = await req(t.app, 'DELETE', `/records/${grantRecord.id}`, { token });
      expect(status).toBe(403);
      expect(await t.ctx.adapter.getRecord(grantRecord.id)).not.toBeNull();
    });

    it('allows the owner to PATCH a grant record', async () => {
      const [grantRecord] = await t.ctx.stack.grant(OTHER_ENTITY_ID, [
        { actions: ['read-own'], typeId: NOTE_TYPE_ID },
      ]);

      const { status, data } = await req(t.app, 'PATCH', `/records/${grantRecord.id}`, {
        token: TEST_TOKEN,
        body: { actions: ['read-own', 'read-any'] },
      });
      expect(status).toBe(200);
      const content = (data as { content: Record<string, unknown> }).content;
      expect(content.actions).toEqual(['read-own', 'read-any']);
    });

    it('allows the owner to soft-DELETE a grant record', async () => {
      const [grantRecord] = await t.ctx.stack.grant(OTHER_ENTITY_ID, [
        { actions: ['read-own'], typeId: NOTE_TYPE_ID },
      ]);

      const { status } = await req(t.app, 'DELETE', `/records/${grantRecord.id}`, {
        token: TEST_TOKEN,
      });
      expect(status).toBe(200);
      const after = await t.ctx.adapter.getRecord(grantRecord.id);
      expect(after?.deletedAt).toBeDefined();
    });

    it('blocks escalation: a write-holder on a grant record cannot expand its actions', async () => {
      // stack.grant() itself now refuses to grant update-own on _grant (see
      // the first test in this block), so the escalation vector this test
      // guards against is reached the only way still possible: a grant
      // record with an explicit record-level write permission on itself.
      const readGrant = await t.ctx.stack.create(
        GRANT_TYPE_ID,
        { typeId: NOTE_TYPE_ID, actions: ['read-own'] },
        {
          permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: true }],
        },
      );
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

      const { status } = await req(t.app, 'PATCH', `/records/${readGrant.id}`, {
        token,
        body: { typeId: NOTE_TYPE_ID, actions: ['read-any', 'update-any', 'delete-any'] },
      });
      expect(status).toBe(403);

      const unchanged = await t.ctx.adapter.getRecord(readGrant.id);
      expect((unchanged?.content as { actions: string[] }).actions).toEqual(['read-own']);
    });
  });

  // All Stack-level invariants (docs/spec.md § The _config record) —
  // inherited for free, so the server's job is only to test them.
  describe('_config protection', () => {
    it('refuses to delete _config, soft or hard', async () => {
      const { status: soft } = await req(t.app, 'DELETE', '/records/_config', {
        token: TEST_TOKEN,
      });
      expect(soft).toBe(409);

      const { status: hard } = await req(t.app, 'DELETE', '/records/_config?hard=true', {
        token: TEST_TOKEN,
      });
      expect(hard).toBe(409);
    });

    it('refuses to change _config.entityId', async () => {
      const { status } = await req(t.app, 'PATCH', '/records/_config', {
        token: TEST_TOKEN,
        body: { entityId: 'someone-else' },
      });
      expect(status).toBe(409);
    });

    it('is invisible to query() regardless of filter', async () => {
      const { data } = await req(t.app, 'GET', '/records', { token: TEST_TOKEN });
      const records = (data as { records: Array<{ typeId: string }> }).records;
      expect(records.some((r) => r.typeId.startsWith('_config'))).toBe(false);

      const { data: filtered } = await req(t.app, 'GET', '/records?typeId=_config@1', {
        token: TEST_TOKEN,
      });
      expect((filtered as { records: unknown[] }).records).toHaveLength(0);
    });

    it('is still addressable directly by id for the owner', async () => {
      const { status, data } = await req(t.app, 'GET', '/records/_config', { token: TEST_TOKEN });
      expect(status).toBe(200);
      expect((data as { id: string }).id).toBe('_config');
    });
  });

  describe('_app binding rules', () => {
    const APP_TYPE_ID = `${SYSTEM_TYPES.APP}@1`;

    it('refuses a non-owner create attempt (owner-only to set)', async () => {
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const { status } = await req(t.app, 'POST', '/records', {
        token,
        body: {
          typeId: APP_TYPE_ID,
          content: { did: 'did:key:zNonOwner', appId: 'app-x', name: 'X' },
        },
      });
      expect(status).toBe(403);
    });

    it('refuses to grant create on _app (privilege-escalation guard, same as _grant/_config)', async () => {
      await expect(
        t.ctx.stack.grant(OTHER_ENTITY_ID, [{ actions: ['create'], typeId: APP_TYPE_ID }]),
      ).rejects.toThrow(/privilege escalation/);
    });

    it('refuses a second binding claiming an already-bound did', async () => {
      await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: {
          typeId: APP_TYPE_ID,
          content: { did: 'did:key:zShared', appId: 'app-1', name: 'One' },
        },
      });
      const { status } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: {
          typeId: APP_TYPE_ID,
          content: { did: 'did:key:zShared', appId: 'app-2', name: 'Two' },
        },
      });
      expect(status).toBe(409);
    });

    it('refuses to change did or appId once set, but allows name', async () => {
      const { data } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: {
          typeId: APP_TYPE_ID,
          content: { did: 'did:key:zImmutable', appId: 'app-immutable', name: 'Original' },
        },
      });
      const id = (data as { id: string }).id;

      const { status: didChange } = await req(t.app, 'PATCH', `/records/${id}`, {
        token: TEST_TOKEN,
        body: { did: 'did:key:zChanged' },
      });
      expect(didChange).toBe(422);

      const { status: appIdChange } = await req(t.app, 'PATCH', `/records/${id}`, {
        token: TEST_TOKEN,
        body: { appId: 'changed' },
      });
      expect(appIdChange).toBe(422);

      const { status: nameChange, data: renamed } = await req(t.app, 'PATCH', `/records/${id}`, {
        token: TEST_TOKEN,
        body: { name: 'Renamed' },
      });
      expect(nameChange).toBe(200);
      expect((renamed as { content: { name: string } }).content.name).toBe('Renamed');
    });
  });

  describe('reserved content keys', () => {
    // A wire body arrives as JSON text; JSON.parse (unlike a JS object
    // literal) creates a genuine own property named "__proto__", which is
    // exactly the shape a malicious request body would take.
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      it(`rejects "${key}" as a content field with 422`, async () => {
        const body = JSON.parse(
          `{"typeId":"${NOTE_TYPE_ID}","content":{"body":"x","${key}":{"evil":true}}}`,
        );
        const { status, data } = await req(t.app, 'POST', '/records', { token: TEST_TOKEN, body });
        expect(status).toBe(422);
        const details = (data as { error: { details: Array<{ path: string }> } }).error.details;
        expect(details.some((d) => d.path === key)).toBe(true);
      });
    }
  });

  describe('non-owner _attachment@1 direct create', () => {
    const ATTACHMENT_TYPE_ID = `${SYSTEM_TYPES.ATTACHMENT}@1`;

    it('refuses a create-grant holder with no readable reference to the fileId', async () => {
      const bytes = new TextEncoder().encode('unreferenced');
      const record = await t.ctx.stack.putAttachment(bytes, 'text/plain');
      const fileId = (record.content as { fileId: string }).fileId;
      await t.ctx.stack.grant(OTHER_ENTITY_ID, [
        { actions: ['create'], typeId: ATTACHMENT_TYPE_ID },
      ]);
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

      const { status } = await req(t.app, 'POST', '/records', {
        token,
        body: {
          typeId: ATTACHMENT_TYPE_ID,
          content: { fileId, mimeType: 'text/plain', size: bytes.byteLength },
        },
      });
      expect(status).toBe(403);
    });

    it('allows a create-grant holder who can already read a record referencing the fileId', async () => {
      const bytes = new TextEncoder().encode('referenced');
      const record = await t.ctx.stack.putAttachment(bytes, 'text/plain');
      const fileId = (record.content as { fileId: string }).fileId;
      await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'ref' },
        {
          permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: false }],
          associations: [{ kind: 'attachment', label: 'file', fileId }],
        },
      );
      await t.ctx.stack.grant(OTHER_ENTITY_ID, [
        { actions: ['create'], typeId: ATTACHMENT_TYPE_ID },
      ]);
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

      const { status } = await req(t.app, 'POST', '/records', {
        token,
        body: {
          typeId: ATTACHMENT_TYPE_ID,
          content: { fileId, mimeType: 'text/plain', size: bytes.byteLength },
        },
      });
      expect(status).toBe(200);
    });
  });

  describe('Delegation (principal/subject)', () => {
    const APP_ID = 'app-entity-id-00000004';
    const SUBJECT_ID = 'subject-entity-id-00000005';

    it('a delegated session stamps principalId and attributes entityId to the subject', async () => {
      // Delegated authority is the intersection of both parties' grants.
      await t.ctx.stack.grant(SUBJECT_ID, [{ actions: ['create'], typeId: NOTE_TYPE_ID }]);
      await t.ctx.stack.grant(APP_ID, [{ actions: ['create'], typeId: NOTE_TYPE_ID }]);
      const { token } = await t.ctx.adapter.createToken(APP_ID, { onBehalfOf: SUBJECT_ID });

      const { status, data } = await req(t.app, 'POST', '/records', {
        token,
        body: { typeId: NOTE_TYPE_ID, content: { body: 'delegated note' } },
      });
      expect(status).toBe(200);
      const d = data as Record<string, unknown>;
      expect(d.entityId).toBe(SUBJECT_ID);
      expect(d.principalId).toBe(APP_ID);
    });

    it('a delegated create is refused when only one party holds the create grant', async () => {
      await t.ctx.stack.grant(SUBJECT_ID, [{ actions: ['create'], typeId: NOTE_TYPE_ID }]);
      // APP_ID (the principal) has no grant of its own.
      const { token } = await t.ctx.adapter.createToken(APP_ID, { onBehalfOf: SUBJECT_ID });

      const { status } = await req(t.app, 'POST', '/records', {
        token,
        body: { typeId: NOTE_TYPE_ID, content: { body: 'should be refused' } },
      });
      expect(status).toBe(403);
    });

    it('filters by ?principalId=', async () => {
      await t.ctx.stack.grant(SUBJECT_ID, [{ actions: ['create'], typeId: NOTE_TYPE_ID }]);
      await t.ctx.stack.grant(APP_ID, [{ actions: ['create'], typeId: NOTE_TYPE_ID }]);
      const { token } = await t.ctx.adapter.createToken(APP_ID, { onBehalfOf: SUBJECT_ID });
      await req(t.app, 'POST', '/records', {
        token,
        body: { typeId: NOTE_TYPE_ID, content: { body: 'delegated note' } },
      });
      await seedRecord(t.ctx); // owner-authored, no principalId

      const { data } = await req(
        t.app,
        'GET',
        `/records?principalId=${encodeURIComponent(APP_ID)}`,
        { token: TEST_TOKEN },
      );
      const records = (data as { records: Array<{ principalId?: string }> }).records;
      expect(records).toHaveLength(1);
      expect(records[0].principalId).toBe(APP_ID);
    });
  });

  describe('POST /records — client-minted id', () => {
    it('accepts a client-supplied id', async () => {
      const id = generateId();
      const { status, data } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: { id, typeId: NOTE_TYPE_ID, content: { body: 'minted' } },
      });
      expect(status).toBe(200);
      expect((data as { id: string }).id).toBe(id);
    });

    it('generates an id when none is supplied', async () => {
      const { data } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: { typeId: NOTE_TYPE_ID, content: { body: 'generated' } },
      });
      expect(typeof (data as { id: string }).id).toBe('string');
      expect((data as { id: string }).id).not.toBe('');
    });

    it('rejects a malformed-charset id with 400 bad_request', async () => {
      const { status, data } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: { id: '1hk153x0000!', typeId: NOTE_TYPE_ID, content: { body: 'x' } },
      });
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });

    it('rejects a wrong-length id with 400 bad_request', async () => {
      const { status, data } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: { id: 'short-id', typeId: NOTE_TYPE_ID, content: { body: 'x' } },
      });
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });

    it('rejects a reserved "_" prefix id with 400 bad_request', async () => {
      const { status, data } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: { id: '_hk153x00001', typeId: NOTE_TYPE_ID, content: { body: 'x' } },
      });
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });

    it('rejects a duplicate id with 409 conflict', async () => {
      const id = generateId();
      await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: { id, typeId: NOTE_TYPE_ID, content: { body: 'first' } },
      });
      const { status, data } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: { id, typeId: NOTE_TYPE_ID, content: { body: 'second' } },
      });
      expect(status).toBe(409);
      expect((data as { error: { code: string } }).error.code).toBe('conflict');
    });
  });

  describe('PATCH /records/:id — If-Match / optimistic concurrency', () => {
    it('succeeds when If-Match names the current version', async () => {
      const record = await seedRecord(t.ctx);
      const { status } = await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { body: 'updated' },
        headers: { 'If-Match': `"${record.version}"` },
      });
      expect(status).toBe(200);
    });

    it('returns 412 version_conflict with the versionConflict payload on a mismatch', async () => {
      const record = await seedRecord(t.ctx);
      const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { body: 'updated' },
        headers: { 'If-Match': `"${record.version + 1}"` },
      });
      expect(status).toBe(412);
      const body = data as {
        error: { code: string; versionConflict: Record<string, unknown> };
      };
      expect(body.error.code).toBe('version_conflict');
      expect(body.error.versionConflict).toMatchObject({
        recordId: record.id,
        expectedVersion: record.version + 1,
        actualVersion: record.version,
      });
    });
  });

  describe('POST /records/:id/undelete', () => {
    it('reverses a soft delete and returns the record with deletedAt absent', async () => {
      const record = await seedRecord(t.ctx);
      await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });

      const { status, data } = await req(t.app, 'POST', `/records/${record.id}/undelete`, {
        token: TEST_TOKEN,
      });
      expect(status).toBe(200);
      const body = data as Record<string, unknown>;
      expect(body.id).toBe(record.id);
      expect(body.deletedAt).toBeUndefined();

      const stored = await t.ctx.adapter.getRecord(record.id);
      expect(stored?.deletedAt).toBeUndefined();
    });

    it('is idempotent — a second call returns the same result', async () => {
      const record = await seedRecord(t.ctx);
      await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });

      const first = await req(t.app, 'POST', `/records/${record.id}/undelete`, {
        token: TEST_TOKEN,
      });
      const second = await req(t.app, 'POST', `/records/${record.id}/undelete`, {
        token: TEST_TOKEN,
      });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });

    it('returns 403 for a non-owner without write access', async () => {
      const record = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'shared' },
        {
          permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: false }],
        },
      );
      await t.ctx.stack.delete(record.id);
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

      const { status } = await req(t.app, 'POST', `/records/${record.id}/undelete`, { token });
      expect(status).toBe(403);
    });

    it('returns 404 for a record that does not exist', async () => {
      const { status } = await req(t.app, 'POST', '/records/nonexistent/undelete', {
        token: TEST_TOKEN,
      });
      expect(status).toBe(404);
    });
  });

  describe('PUT/GET /records/:id/permissions', () => {
    it('PUT replaces permissions and returns the updated record', async () => {
      const record = await seedRecord(t.ctx);
      const res = await t.app.request(`/records/${record.id}/permissions`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: [{ access: 'public' }] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { permissions: unknown[] };
      expect(body.permissions).toEqual([{ access: 'public' }]);

      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const { status: anonStatus } = await req(t.app, 'GET', `/records/${record.id}`);
      expect(anonStatus).toBe(200);
      const { status: otherStatus } = await req(t.app, 'GET', `/records/${record.id}`, { token });
      expect(otherStatus).toBe(200);
    });

    it('an empty permissions array makes the record private', async () => {
      const record = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'was public' },
        { permissions: [{ access: 'public' }] },
      );
      await req(t.app, 'PUT', `/records/${record.id}/permissions`, {
        token: TEST_TOKEN,
        body: { permissions: [] },
      });
      // Anonymous can no longer tell "made private" from "never existed" —
      // the anti-oracle rule (#79) — so this is 404 + WWW-Authenticate, not
      // 403 or a bodyless 401.
      const res = await t.app.request(`/records/${record.id}`);
      expect(res.status).toBe(404);
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
    });

    it('GET returns the current permissions', async () => {
      const record = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'x' },
        { permissions: [{ access: 'public' }] },
      );
      const { status, data } = await req(t.app, 'GET', `/records/${record.id}/permissions`, {
        token: TEST_TOKEN,
      });
      expect(status).toBe(200);
      expect((data as { permissions: unknown[] }).permissions).toEqual([{ access: 'public' }]);
    });

    it('returns 403 when a non-owner without write access tries to PUT', async () => {
      const record = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'x' },
        {
          permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: false }],
        },
      );
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const { status } = await req(t.app, 'PUT', `/records/${record.id}/permissions`, {
        token,
        body: { permissions: [{ access: 'public' }] },
      });
      expect(status).toBe(403);
    });

    it('PUT succeeds when If-Match names the current version', async () => {
      const record = await seedRecord(t.ctx);
      const { status } = await req(t.app, 'PUT', `/records/${record.id}/permissions`, {
        token: TEST_TOKEN,
        body: { permissions: [{ access: 'public' }] },
        headers: { 'If-Match': `"${record.version}"` },
      });
      expect(status).toBe(200);
    });

    it('PUT returns 412 version_conflict on an If-Match mismatch', async () => {
      const record = await seedRecord(t.ctx);
      const { status, data } = await req(t.app, 'PUT', `/records/${record.id}/permissions`, {
        token: TEST_TOKEN,
        body: { permissions: [{ access: 'public' }] },
        headers: { 'If-Match': `"${record.version + 1}"` },
      });
      expect(status).toBe(412);
      expect((data as { error: { code: string } }).error.code).toBe('version_conflict');
    });
  });

  describe('PUT /records/:id/unlisted', () => {
    it('withholds a record from enumeration without changing who may read it', async () => {
      const record = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'x' },
        { permissions: [{ access: 'public' }] },
      );
      const { status, data } = await req(t.app, 'PUT', `/records/${record.id}/unlisted`, {
        token: TEST_TOKEN,
        body: { unlisted: true },
      });
      expect(status).toBe(200);
      expect(typeof (data as { unlistedAt?: string }).unlistedAt).toBe('string');
      // permissions untouched — orthogonal fields.
      expect((data as { version: number }).version).toBe(record.version + 1);

      // Still directly reachable by anyone who could already read it.
      const anon = await req(t.app, 'GET', `/records/${record.id}`);
      expect(anon.status).toBe(200);

      // But absent from an unfiltered query.
      const { data: queried } = await req(t.app, 'GET', '/records', { token: TEST_TOKEN });
      expect(
        (queried as { records: Array<{ id: string }> }).records.some((r) => r.id === record.id),
      ).toBe(false);
    });

    it('{ unlisted: false } relists a record', async () => {
      const record = await seedRecord(t.ctx);
      await req(t.app, 'PUT', `/records/${record.id}/unlisted`, {
        token: TEST_TOKEN,
        body: { unlisted: true },
      });
      const { status, data } = await req(t.app, 'PUT', `/records/${record.id}/unlisted`, {
        token: TEST_TOKEN,
        body: { unlisted: false },
      });
      expect(status).toBe(200);
      expect((data as { unlistedAt?: string }).unlistedAt).toBeUndefined();

      const { data: queried } = await req(t.app, 'GET', '/records', { token: TEST_TOKEN });
      expect(
        (queried as { records: Array<{ id: string }> }).records.some((r) => r.id === record.id),
      ).toBe(true);
    });

    it('rejects a non-boolean unlisted value with 400', async () => {
      const record = await seedRecord(t.ctx);
      const { status } = await req(t.app, 'PUT', `/records/${record.id}/unlisted`, {
        token: TEST_TOKEN,
        body: { unlisted: 'true' },
      });
      expect(status).toBe(400);
    });

    it('returns 403 when a non-owner without write access tries to PUT', async () => {
      const record = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'x' },
        {
          permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: false }],
        },
      );
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
      const { status } = await req(t.app, 'PUT', `/records/${record.id}/unlisted`, {
        token,
        body: { unlisted: true },
      });
      expect(status).toBe(403);
    });

    it('returns 409 on a soft-deleted record', async () => {
      const record = await seedRecord(t.ctx);
      await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
      const { status, data } = await req(t.app, 'PUT', `/records/${record.id}/unlisted`, {
        token: TEST_TOKEN,
        body: { unlisted: true },
      });
      expect(status).toBe(409);
      expect((data as { error: { code: string } }).error.code).toBe('conflict');
    });

    it('PUT succeeds when If-Match names the current version', async () => {
      const record = await seedRecord(t.ctx);
      const { status } = await req(t.app, 'PUT', `/records/${record.id}/unlisted`, {
        token: TEST_TOKEN,
        body: { unlisted: true },
        headers: { 'If-Match': `"${record.version}"` },
      });
      expect(status).toBe(200);
    });

    it('PUT returns 412 version_conflict on an If-Match mismatch', async () => {
      const record = await seedRecord(t.ctx);
      const { status, data } = await req(t.app, 'PUT', `/records/${record.id}/unlisted`, {
        token: TEST_TOKEN,
        body: { unlisted: true },
        headers: { 'If-Match': `"${record.version + 1}"` },
      });
      expect(status).toBe(412);
      expect((data as { error: { code: string } }).error.code).toBe('version_conflict');
    });
  });

  describe('includeUnlisted', () => {
    it('is excluded by default from GET /records and POST /records/query', async () => {
      const record = await seedRecord(t.ctx);
      await t.ctx.stack.setUnlisted(record.id, true);

      const getRes = await req(t.app, 'GET', '/records', { token: TEST_TOKEN });
      expect(
        (getRes.data as { records: Array<{ id: string }> }).records.some((r) => r.id === record.id),
      ).toBe(false);

      const postRes = await req(t.app, 'POST', '/records/query', { token: TEST_TOKEN, body: {} });
      expect(
        (postRes.data as { records: Array<{ id: string }> }).records.some(
          (r) => r.id === record.id,
        ),
      ).toBe(false);
    });

    it('surfaces unlisted records for the owner acting alone', async () => {
      const record = await seedRecord(t.ctx);
      await t.ctx.stack.setUnlisted(record.id, true);

      const { data } = await req(t.app, 'GET', '/records?includeUnlisted=true', {
        token: TEST_TOKEN,
      });
      expect(
        (data as { records: Array<{ id: string }> }).records.some((r) => r.id === record.id),
      ).toBe(true);

      const { data: postData } = await req(t.app, 'POST', '/records/query', {
        token: TEST_TOKEN,
        body: { filter: { includeUnlisted: true } },
      });
      expect(
        (postData as { records: Array<{ id: string }> }).records.some((r) => r.id === record.id),
      ).toBe(true);
    });

    it('is refused with 403 for a non-owner, on both query endpoints', async () => {
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

      const getRes = await req(t.app, 'GET', '/records?includeUnlisted=true', { token });
      expect(getRes.status).toBe(403);

      const postRes = await req(t.app, 'POST', '/records/query', {
        token,
        body: { filter: { includeUnlisted: true } },
      });
      expect(postRes.status).toBe(403);
    });
  });

  describe('reserved content keys — PATCH', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      it(`rejects "${key}" as a patch field with 422`, async () => {
        const record = await seedRecord(t.ctx);
        const body = JSON.parse(`{"${key}":{"evil":true}}`);
        const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
          token: TEST_TOKEN,
          body,
        });
        expect(status).toBe(422);
        const details = (data as { error: { details: Array<{ path: string }> } }).error.details;
        expect(details.some((d) => d.path === key)).toBe(true);
      });
    }
  });

  describe('Pagination defaults', () => {
    it('omits limit -> returns one default-sized page, not everything', async () => {
      for (let i = 0; i < 55; i++) {
        await seedRecord(t.ctx, { body: `note ${i}` });
      }
      const { data } = await req(t.app, 'GET', '/records', { token: TEST_TOKEN });
      const body = data as { records: unknown[]; cursor: string | null };
      expect(body.records.length).toBeLessThan(55);
      expect(body.records.length).toBeGreaterThan(0);
      expect(body.cursor).not.toBeNull();
    });
  });

  describe('Query error shapes', () => {
    it('returns 400 bad_request for a malformed cursor', async () => {
      const { status, data } = await req(t.app, 'POST', '/records/query', {
        token: TEST_TOKEN,
        body: { cursor: 'not-a-valid-cursor' },
      });
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });

    it('returns 400 bad_request for a cursor naming an unknown sort field', async () => {
      const badCursor = Buffer.from('badfield|123|1hk153x00001').toString('base64');
      const { status, data } = await req(t.app, 'POST', '/records/query', {
        token: TEST_TOKEN,
        body: { cursor: badCursor },
      });
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('bad_request');
    });

    function expectBadRequest(result: { status: number; data: unknown }) {
      expect(result.status).toBe(400);
      expect((result.data as { error: { code: string } }).error.code).toBe('bad_request');
    }

    describe('limit', () => {
      it('GET /records?limit=abc does not silently become NaN', async () => {
        expectBadRequest(await req(t.app, 'GET', '/records?limit=abc', { token: TEST_TOKEN }));
      });

      it('GET /records?limit=-5 is rejected, not passed through negative', async () => {
        expectBadRequest(await req(t.app, 'GET', '/records?limit=-5', { token: TEST_TOKEN }));
      });

      it('GET /records?limit=2.7 is rejected, not truncated', async () => {
        expectBadRequest(await req(t.app, 'GET', '/records?limit=2.7', { token: TEST_TOKEN }));
      });

      it('POST /records/query with limit: -5 is rejected', async () => {
        expectBadRequest(
          await req(t.app, 'POST', '/records/query', { token: TEST_TOKEN, body: { limit: -5 } }),
        );
      });

      it('POST /records/query with limit: 2.7 is rejected', async () => {
        expectBadRequest(
          await req(t.app, 'POST', '/records/query', { token: TEST_TOKEN, body: { limit: 2.7 } }),
        );
      });

      it('POST /records/query with a positive integer limit still succeeds', async () => {
        const { status } = await req(t.app, 'POST', '/records/query', {
          token: TEST_TOKEN,
          body: { limit: 10 },
        });
        expect(status).toBe(200);
      });
    });

    describe('date filters', () => {
      it('GET /records?createdBefore=garbage is rejected rather than producing Invalid Date', async () => {
        expectBadRequest(
          await req(t.app, 'GET', '/records?createdBefore=garbage', { token: TEST_TOKEN }),
        );
      });

      it('GET /records?updatedAfter=garbage is rejected', async () => {
        expectBadRequest(
          await req(t.app, 'GET', '/records?updatedAfter=garbage', { token: TEST_TOKEN }),
        );
      });

      it('POST /records/query with an invalid filter.createdAt.before 400s instead of dropping the bound', async () => {
        expectBadRequest(
          await req(t.app, 'POST', '/records/query', {
            token: TEST_TOKEN,
            body: { filter: { createdAt: { before: 'garbage' } } },
          }),
        );
      });

      it('POST /records/query with an invalid filter.updatedAt.after 400s instead of dropping the bound', async () => {
        expectBadRequest(
          await req(t.app, 'POST', '/records/query', {
            token: TEST_TOKEN,
            body: { filter: { updatedAt: { after: 'garbage' } } },
          }),
        );
      });
    });

    describe('sort', () => {
      it('GET /records?sort=bogus rejects an unknown sort field', async () => {
        expectBadRequest(await req(t.app, 'GET', '/records?sort=bogus', { token: TEST_TOKEN }));
      });

      it('GET /records?sort=createdAt&direction=bogus rejects an unknown direction', async () => {
        expectBadRequest(
          await req(t.app, 'GET', '/records?sort=createdAt&direction=bogus', {
            token: TEST_TOKEN,
          }),
        );
      });

      it('POST /records/query with sort.field: "bogus" is rejected', async () => {
        expectBadRequest(
          await req(t.app, 'POST', '/records/query', {
            token: TEST_TOKEN,
            body: { sort: { field: 'bogus' } },
          }),
        );
      });

      it('POST /records/query with sort.direction: "bogus" is rejected', async () => {
        expectBadRequest(
          await req(t.app, 'POST', '/records/query', {
            token: TEST_TOKEN,
            body: { sort: { field: 'createdAt', direction: 'bogus' } },
          }),
        );
      });
    });

    describe('filter shape', () => {
      it('POST /records/query with filter.tags as a non-array is rejected', async () => {
        expectBadRequest(
          await req(t.app, 'POST', '/records/query', {
            token: TEST_TOKEN,
            body: { filter: { tags: 'not-an-array' } },
          }),
        );
      });

      it('POST /records/query with a mixed-type filter.tags array is rejected', async () => {
        expectBadRequest(
          await req(t.app, 'POST', '/records/query', {
            token: TEST_TOKEN,
            body: { filter: { tags: ['ok', 5] } },
          }),
        );
      });

      it('POST /records/query with filter.content as a non-object is rejected', async () => {
        expectBadRequest(
          await req(t.app, 'POST', '/records/query', {
            token: TEST_TOKEN,
            body: { filter: { content: 'not-an-object' } },
          }),
        );
      });

      it('POST /records/query with filter.typeId as a non-string, non-array is rejected', async () => {
        expectBadRequest(
          await req(t.app, 'POST', '/records/query', {
            token: TEST_TOKEN,
            body: { filter: { typeId: 5 } },
          }),
        );
      });
    });
  });

  describe('Payload too large', () => {
    it('returns 413 payload_too_large for an oversized record body', async () => {
      const { status, data } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: { typeId: NOTE_TYPE_ID, content: { body: 'x'.repeat(2 * 1024 * 1024) } },
      });
      expect(status).toBe(413);
      expect((data as { error: { code: string } }).error.code).toBe('payload_too_large');
    });
  });

  describe('POST /records/:id/migrate', () => {
    const NOTE_V2_TYPE_ID = 'com.example.test/note@2';

    async function seedV2Type(ctx: TestApp['ctx']) {
      return ctx.stack.defineType(
        NOTE_V2_TYPE_ID,
        'Note',
        {
          title: { kind: 'string' as const },
          body: { kind: 'text' as const, required: true as const },
        },
        { migratesFrom: NOTE_TYPE_ID },
      );
    }

    it('changes typeId, bumps version, and writes the given content (owner)', async () => {
      await seedV2Type(t.ctx);
      const record = await seedRecord(t.ctx, { body: 'original' });

      const { status, data } = await req(t.app, 'POST', `/records/${record.id}/migrate`, {
        token: TEST_TOKEN,
        body: { toTypeId: NOTE_V2_TYPE_ID, content: { body: 'migrated', title: 'New' } },
      });
      expect(status).toBe(200);
      const body = data as Record<string, unknown>;
      expect(body.typeId).toBe(NOTE_V2_TYPE_ID);
      expect(body.version).toBe(2);
      expect((body.content as Record<string, unknown>).body).toBe('migrated');
    });

    it('returns 403 for a non-owner, even one with write access to the record', async () => {
      await seedV2Type(t.ctx);
      const record = await t.ctx.stack.create(
        NOTE_TYPE_ID,
        { body: 'shared' },
        {
          permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: true }],
        },
      );
      const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

      const { status } = await req(t.app, 'POST', `/records/${record.id}/migrate`, {
        token,
        body: { toTypeId: NOTE_V2_TYPE_ID, content: { body: 'x' } },
      });
      expect(status).toBe(403);
    });

    it('returns 401 for an unauthenticated request', async () => {
      await seedV2Type(t.ctx);
      const record = await seedRecord(t.ctx);
      const { status } = await req(t.app, 'POST', `/records/${record.id}/migrate`, {
        body: { toTypeId: NOTE_V2_TYPE_ID, content: { body: 'x' } },
      });
      expect(status).toBe(401);
    });

    it('returns 422 for an unregistered toTypeId', async () => {
      const record = await seedRecord(t.ctx);
      const { status, data } = await req(t.app, 'POST', `/records/${record.id}/migrate`, {
        token: TEST_TOKEN,
        body: { toTypeId: 'com.example.test/nonexistent@1', content: { body: 'x' } },
      });
      expect(status).toBe(422);
      expect((data as { error: { code: string } }).error.code).toBe('validation');
    });

    it('returns 422 when content fails the target schema', async () => {
      await seedV2Type(t.ctx);
      const record = await seedRecord(t.ctx);
      const { status, data } = await req(t.app, 'POST', `/records/${record.id}/migrate`, {
        token: TEST_TOKEN,
        body: { toTypeId: NOTE_V2_TYPE_ID, content: {} },
      });
      expect(status).toBe(422);
      expect((data as { error: { code: string } }).error.code).toBe('validation');
    });

    it('returns 404 for a record that does not exist', async () => {
      await seedV2Type(t.ctx);
      const { status } = await req(t.app, 'POST', '/records/nonexistent/migrate', {
        token: TEST_TOKEN,
        body: { toTypeId: NOTE_V2_TYPE_ID, content: { body: 'x' } },
      });
      expect(status).toBe(404);
    });

    it('leaves a pre-migration snapshot in version history', async () => {
      await seedV2Type(t.ctx);
      const record = await seedRecord(t.ctx, { body: 'before' });
      await req(t.app, 'POST', `/records/${record.id}/migrate`, {
        token: TEST_TOKEN,
        body: { toTypeId: NOTE_V2_TYPE_ID, content: { body: 'after' } },
      });
      const versions = await t.ctx.adapter.getVersions(record.id);
      expect(versions.some((v) => v.typeId === NOTE_TYPE_ID)).toBe(true);
    });
  });
});
