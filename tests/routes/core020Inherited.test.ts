/**
 * Pins behaviors this server inherits for free from the core 0.13.1 → 0.20.0
 * bump (issue #96) — nothing here is new server code, only tests confirming
 * the inheritance actually holds. Each block cites the core minor that
 * introduced the behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SYSTEM_TYPES } from '@haverstack/core';
import { buildTestApp, req, TEST_TOKEN, OTHER_ENTITY_ID, type TestApp } from '../setup.js';
import { openChangeFeed } from '../changeFeedClient.js';

const NOTE_TYPE = 'com.example.test/note@1';
const GROUP_TYPE = `${SYSTEM_TYPES.GROUP}@1`;
const CONTACT_TYPE = 'com.example.test/contact@1';

async function seedNoteType(ctx: TestApp['ctx']) {
  await ctx.stack.defineType(NOTE_TYPE, 'Note', {
    title: { kind: 'string' },
    body: { kind: 'text' },
  });
}

// -------------------------------------------------------
// Tombstones and mutation refusal (core 0.18)
// -------------------------------------------------------

describe('tombstone projection and mutation refusal (core 0.18)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await seedNoteType(t.ctx);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('GET on a soft-deleted record projects a tombstone: content emptied, deletedAt set', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
    const { status, data } = await req(t.app, 'GET', `/records/${record.id}`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(200);
    const d = data as { content: unknown; deletedAt?: string };
    expect(d.content).toEqual({});
    expect(typeof d.deletedAt).toBe('string');
  });

  it('query({ includeDeleted: true }) surfaces the same tombstone projection', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'y' });
    await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
    const { status, data } = await req(t.app, 'POST', '/records/query', {
      token: TEST_TOKEN,
      body: { filter: { typeId: NOTE_TYPE, includeDeleted: true } },
    });
    expect(status).toBe(200);
    const d = data as { records: Array<{ id: string; content: unknown; deletedAt?: string }> };
    const found = d.records.find((r) => r.id === record.id)!;
    expect(found.content).toEqual({});
    expect(typeof found.deletedAt).toBe('string');
  });

  it('the change feed carries the same tombstone projection on delete', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    const conn = await openChangeFeed(t.app, '/changes?include=record', { token: TEST_TOKEN });
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
      const [, frame] = await conn.waitForFrames(2);
      const data = frame.data as unknown as {
        record: { content: unknown; deletedAt?: string };
      };
      expect(data.record.content).toEqual({});
      expect(typeof data.record.deletedAt).toBe('string');
    } finally {
      await conn.close();
    }
  });

  it('mutating a soft-deleted record is refused with 409, not applied to the tombstone', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'z' });
    await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
    const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: { title: 'edited' },
    });
    expect(status).toBe(409);
    expect((data as { error: { code: string } }).error.code).toBe('conflict');
  });

  it('version history is exempt from the tombstone projection and still serves content', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'w' });
    await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
    const { status, data } = await req(t.app, 'GET', `/records/${record.id}/versions`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(200);
    const versions = data as Array<{ content: Record<string, unknown> }>;
    expect(versions[0]!.content).toEqual({ title: 'w' });
  });
});

// -------------------------------------------------------
// Nested content queries (record-adapter-sqlite's nestedContentQuery)
// -------------------------------------------------------

describe('nested content query (nestedContentQuery capability)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await t.ctx.stack.defineType(CONTACT_TYPE, 'Contact', {
      profile: { kind: 'object', properties: { email: { kind: 'string' } } },
    });
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('a multi-segment content filter key matches a nested field', async () => {
    const matching = await t.ctx.stack.create(CONTACT_TYPE, {
      profile: { email: 'a@example.com' },
    });
    await t.ctx.stack.create(CONTACT_TYPE, { profile: { email: 'b@example.com' } });
    const { status, data } = await req(t.app, 'POST', '/records/query', {
      token: TEST_TOKEN,
      body: {
        filter: { typeId: CONTACT_TYPE, content: { 'profile.email': 'a@example.com' } },
      },
    });
    expect(status).toBe(200);
    const d = data as { records: Array<{ id: string }> };
    expect(d.records.map((r) => r.id)).toEqual([matching.id]);
  });
});

// -------------------------------------------------------
// Full-text search (core 0.20 FTS5 repair)
// -------------------------------------------------------

describe('full-text search (core 0.20 FTS5 repair)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await seedNoteType(t.ctx);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('filter.search finds the record containing the term and excludes others', async () => {
    const matching = await t.ctx.stack.create(NOTE_TYPE, {
      title: 'x',
      body: 'the quick brown fox jumps',
    });
    await t.ctx.stack.create(NOTE_TYPE, { title: 'y', body: 'lorem ipsum dolor sit amet' });
    const { status, data } = await req(t.app, 'POST', '/records/query', {
      token: TEST_TOKEN,
      body: { filter: { typeId: NOTE_TYPE, search: 'fox' } },
    });
    expect(status).toBe(200);
    const d = data as { records: Array<{ id: string }> };
    expect(d.records.map((r) => r.id)).toEqual([matching.id]);
  });
});

// -------------------------------------------------------
// _group ACL (core 0.20 tightening: only a real _group Record is a roster)
// -------------------------------------------------------

describe('_group ACL (core 0.20 tightening)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await seedNoteType(t.ctx);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('an entity added to a real _group roster gains group-scoped read access', async () => {
    const group = await t.ctx.stack.create(GROUP_TYPE, { name: 'Test Group' });
    await t.ctx.stack.associate(group.id, {
      kind: 'relationship',
      label: 'member',
      target: { scope: 'entity', entityId: OTHER_ENTITY_ID },
    });
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'group-visible' },
      { permissions: [{ access: 'group', groupId: group.id, read: true, write: false }] },
    );
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const { status } = await req(t.app, 'GET', `/records/${record.id}`, { token });
    expect(status).toBe(200);
  });

  it('a non-_group record with matching relationship associations is never treated as a roster', async () => {
    // Same association shape a real group roster uses (kind: relationship,
    // label: member, target: entity) — but on an ordinary Note, not a
    // _group Record. Before the 0.20 fix, any record's relationship
    // associations could serve as an ACL; this pins that it can't.
    const notAGroup = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'not a real group' },
      {
        associations: [
          {
            kind: 'relationship',
            label: 'member',
            target: { scope: 'entity', entityId: OTHER_ENTITY_ID },
          },
        ],
      },
    );
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'should stay private' },
      { permissions: [{ access: 'group', groupId: notAGroup.id, read: true, write: false }] },
    );
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const { status } = await req(t.app, 'GET', `/records/${record.id}`, { token });
    // Anti-oracle: unreadable is 404, same as any other record this entity
    // can't reach — never a 403 that would confirm the record exists.
    expect(status).toBe(404);
  });
});
