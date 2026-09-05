/**
 * Content filters and search over this server's query routes: the sqlite
 * adapter's path-reach content filtering, and FTS5 full-text search,
 * pinned at the HTTP surface rather than assumed to arrive intact.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, TEST_TOKEN, type TestApp } from '../setup.js';

const NOTE_TYPE = 'com.example.test/note@1';
const CONTACT_TYPE = 'com.example.test/contact@1';

describe('nested content query', () => {
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

describe('full-text search', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await t.ctx.stack.defineType(NOTE_TYPE, 'Note', {
      title: { kind: 'string' },
      body: { kind: 'text' },
    });
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
