/**
 * POST /records/query's filter.relatedTo — the body-side counterpart to
 * the relatedTo/relatedToEntity/relatedToNs/relatedToId/relatedToStack URL
 * params covered in records.test.ts. Same scoped-target shape, carried as
 * a JSON object instead of query params.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, TEST_TOKEN, OTHER_ENTITY_ID, type TestApp } from '../setup.js';

const NOTE_TYPE_ID = 'com.example.test/note@1';

async function seedType(ctx: TestApp['ctx']) {
  return ctx.stack.defineType(NOTE_TYPE_ID, 'Note', {
    body: { kind: 'text' as const, required: true as const },
  });
}

async function seedRecord(ctx: TestApp['ctx'], overrides: Record<string, unknown> = {}) {
  return ctx.stack.create(NOTE_TYPE_ID, { body: 'Hello world', ...overrides });
}

describe('POST /records/query filter.relatedTo', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await seedType(t.ctx);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('matches a record-scope target, narrowed further by label', async () => {
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

    const { status, data } = await req(t.app, 'POST', '/records/query', {
      token: TEST_TOKEN,
      body: { filter: { relatedTo: { target: { scope: 'record', recordId: target.id } } } },
    });
    expect(status).toBe(200);
    expect((data as { records: Array<{ id: string }> }).records.map((r) => r.id)).toEqual([
      child.id,
    ]);
  });

  it('matches an entity-scope target', async () => {
    const child = await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'child' },
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

    const { status, data } = await req(t.app, 'POST', '/records/query', {
      token: TEST_TOKEN,
      body: {
        filter: { relatedTo: { target: { scope: 'entity', entityId: OTHER_ENTITY_ID } } },
      },
    });
    expect(status).toBe(200);
    expect((data as { records: Array<{ id: string }> }).records.map((r) => r.id)).toEqual([
      child.id,
    ]);
  });

  it('matches an external-scope target, and the whole namespace when id is omitted', async () => {
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

    const { status, data } = await req(t.app, 'POST', '/records/query', {
      token: TEST_TOKEN,
      body: { filter: { relatedTo: { target: { scope: 'external', ns: 'atproto' } } } },
    });
    expect(status).toBe(200);
    expect((data as { records: Array<{ id: string }> }).records.map((r) => r.id)).toEqual([
      syndicated.id,
    ]);
  });

  it('label alone (no target) is valid and matches every target under it', async () => {
    const target = await seedRecord(t.ctx, { body: 'target' });
    const child = await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'child' },
      {
        associations: [
          {
            kind: 'relationship',
            label: 'reply-to',
            target: { scope: 'record', recordId: target.id },
          },
        ],
      },
    );

    const { status, data } = await req(t.app, 'POST', '/records/query', {
      token: TEST_TOKEN,
      body: { filter: { relatedTo: { label: 'reply-to' } } },
    });
    expect(status).toBe(200);
    expect((data as { records: Array<{ id: string }> }).records.map((r) => r.id)).toEqual([
      child.id,
    ]);
  });

  it('rejects filter.relatedTo naming neither a label nor a target with 400', async () => {
    const { status, data } = await req(t.app, 'POST', '/records/query', {
      token: TEST_TOKEN,
      body: { filter: { relatedTo: {} } },
    });
    expect(status).toBe(400);
    expect((data as { error: { code: string } }).error.code).toBe('bad_request');
  });

  // An unrecognized target scope is a parsing rejection, pinned once at the
  // unit level in @haverstack/core's wire-request.test.ts rather than here
  // — see server#114.

  it('rejects a record target with an empty recordId with 400', async () => {
    const { status, data } = await req(t.app, 'POST', '/records/query', {
      token: TEST_TOKEN,
      body: { filter: { relatedTo: { target: { scope: 'record', recordId: '' } } } },
    });
    expect(status).toBe(400);
    expect((data as { error: { code: string } }).error.code).toBe('bad_request');
  });

  it('rejects a record target with an empty stackUrl with 400', async () => {
    const target = await seedRecord(t.ctx, { body: 'target' });
    const { status, data } = await req(t.app, 'POST', '/records/query', {
      token: TEST_TOKEN,
      body: {
        filter: { relatedTo: { target: { scope: 'record', recordId: target.id, stackUrl: '' } } },
      },
    });
    expect(status).toBe(400);
    expect((data as { error: { code: string } }).error.code).toBe('bad_request');
  });

  it('rejects an external target with an empty id with 400', async () => {
    const { status, data } = await req(t.app, 'POST', '/records/query', {
      token: TEST_TOKEN,
      body: { filter: { relatedTo: { target: { scope: 'external', ns: 'atproto', id: '' } } } },
    });
    expect(status).toBe(400);
    expect((data as { error: { code: string } }).error.code).toBe('bad_request');
  });
});
