/**
 * Runs the shared @haverstack/conformance-fixtures suite against this
 * server's real HTTP surface. A companion to the hand-written route tests
 * under tests/routes/, not a replacement: each fixture pins one documented
 * wire-contract point (a status code, an error code, a merge/versioning
 * rule), so a fixture that starts failing here means this server and the
 * documented contract have diverged.
 *
 * Server-generated values (ids left unspecified, timestamps, opaque
 * pagination cursors) are never compared for literal equality against a
 * fixture's illustrative placeholders — @haverstack/adapter-api's own
 * consumption of these same fixtures (packages/adapter-api/tests/
 * conformance.test.ts in haverstack/core) takes the same targeted-field
 * approach rather than deep-equating whole response bodies.
 *
 * Every fixture in each imported array is either dispatched below or
 * named in that describe block's SKIPPED set with a reason. Each block's
 * final "coverage" test fails loudly if core adds, removes, or renames a
 * fixture this file hasn't been told about — that's what makes this an
 * acceptance gate rather than a snapshot of one day's fixture list.
 *
 * Only two fixtures are skipped, and neither is a gap: each states in its
 * own description that it pins a *client* obligation rather than a server
 * one, and neither can be dispatched against a conformant server without
 * forging the response it checks. Everything else — including the cases
 * that need a second principal, a readable attachment reference, an
 * adapter-level write, or a server configured with a deadline no query can
 * meet — is dispatched.
 */
import { Hono } from 'hono';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  discoveryFixtures,
  createRecordFixtures,
  queryRecordsFixtures,
  patchContentFixtures,
  deleteRecordFixtures,
  deleteRecordSequenceFixtures,
  undeleteRecordFixtures,
  associateFixtures,
  dissociateFixtures,
  permissionsChangeFixtures,
  grantAccessFixtures,
  revokeAccessFixtures,
  getJournalFixtures,
  getVersionsFixtures,
  getVersionFixtures,
  getVersionsAfterMutateFixtures,
  restoreVersionFixtures,
  commitMigrationFixtures,
  errorResponseFixtures,
  authChallengeFixtures,
  authTokenFixtures,
  authSequenceFixtures,
  changeFeedFixtures,
  changeFeedSequenceFixtures,
  unlistedChangeFixtures,
  parentChangeFixtures,
  attachmentDownloadFixtures,
  attachmentUploadFixtures,
  AUTH_FIXTURE_DID,
  AUTH_FIXTURE_NONCE,
} from '@haverstack/conformance-fixtures';
import * as conformanceFixtures from '@haverstack/conformance-fixtures';
import type { WireRecord, WireJournalResponse } from '@haverstack/wire-types';
import { generateId, hashSchema } from '@haverstack/core';
import type { DataAssociation } from '@haverstack/core';
import {
  buildTestApp,
  req,
  testConfig,
  TEST_TOKEN,
  TEST_ENTITY_ID,
  logger,
  type TestApp,
} from './setup.js';
import { openChangeFeed, type DecodedFrame } from './changeFeedClient.js';
import { changeRoutes } from '../src/routes/changes.js';
import { authMiddleware } from '../src/middleware/auth.js';
import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/types.js';

/**
 * Fixture ids embed a fixed, long-past timestamp (they were authored once
 * and never touched again); this server's ScopedStack.create() rejects any
 * client-supplied id whose embedded timestamp is outside a clock-skew
 * tolerance of "now" (default 24h — see validateIdTimestampSkew() in
 * @haverstack/core). A literal fixture id would fail that freshness check
 * before ever reaching the behavior the fixture is actually pinning, so
 * every dispatched create swaps in a freshly generated id instead.
 *
 * Fixture bodies carry the same long-past `createdAt`/`updatedAt` (a
 * WireRecord is a whole record). Those are stripped too: an owner-token
 * dispatch backdates for real, so a stale `createdAt` beside the fresh id
 * above would fail the skew check these fixtures aren't testing. A fixture
 * that *is* testing backdating passes its own matching pair instead.
 */
function withFreshId<T extends { id?: string; createdAt?: unknown; updatedAt?: unknown }>(
  body: T,
): Omit<T, 'createdAt' | 'updatedAt'> & { id: string } {
  const rest = { ...body };
  delete rest.createdAt;
  delete rest.updatedAt;
  return { ...rest, id: generateId() };
}

const NOTE_TYPE = 'com.example/note@1';
const NOTE_TYPE_V2 = 'com.example/note@2';
const COMMENT_TYPE = 'com.example/comment@1';
const ATTACHMENT_TYPE = '_attachment@1';
const GROUP_TYPE = '_group@1';
const GRANT_TYPE = '_grant@1';
// Ungrantable, which is what the evaluation-time fixture below is about.
const APP_TYPE = '_app@1';

// Reusing the fixtures' own placeholder identities as real test principals
// where possible — nothing requires DID-shaped entityIds for a record-level
// permission entry or a minted token's principal, so fixture and harness
// agree on more than just shape.
const CONTRIBUTOR_ID = 'entity-contributor-789';
const WRITER_ID = 'entity-writer-101112';
const BLOG_APP_ID = 'com.example.blog';
const BLOG_SUBJECT_ID = 'entity-blog-subject-131415';

async function seedTypes(ctx: TestApp['ctx']) {
  await ctx.stack.defineType(NOTE_TYPE, 'Note', {
    title: { kind: 'string' },
    body: { kind: 'text' },
    pinned: { kind: 'boolean' },
  });
  await ctx.stack.defineType(NOTE_TYPE_V2, 'Note', {
    title: { kind: 'string' },
    pinned: { kind: 'boolean' },
  });
  await ctx.stack.defineType(COMMENT_TYPE, 'Comment', {
    body: { kind: 'text', required: true },
  });
}

let t: TestApp;
beforeEach(async () => {
  t = await buildTestApp();
  await seedTypes(t.ctx);
});
afterEach(async () => {
  await t.cleanup();
});

/**
 * Every fixture name any block claimed, pooled across the file. A block's
 * own coverage test answers "did this block handle its array"; the pooled
 * set is what answers "is there an array no block reads at all", which no
 * per-block check can see. See the whole-package test at the end.
 */
const accountedFor = new Set<string>();

function assertCoverage(names: string[], handled: Set<string>, skipped: Set<string>) {
  // Recorded before the assertions below, not after: a block that fails its
  // own coverage would otherwise report nothing, and the whole-package test
  // at the end would blame it for every fixture it does dispatch.
  for (const name of [...handled, ...skipped]) accountedFor.add(name);
  for (const name of names) {
    expect(handled.has(name) || skipped.has(name)).toBe(true);
  }
  expect(names.length).toBe(handled.size + skipped.size);
}

// -------------------------------------------------------
// Discovery
// -------------------------------------------------------

describe('discovery fixtures', () => {
  const SKIPPED = new Set([
    // Not a requirement this server can fail: the fixture describes a
    // *different* conformant server, one that neither resumes nor includes
    // records. This one does both — src/routes/wellknown.ts writes both
    // flags as literals precisely so discovery can't contradict the route
    // beside it, on a field clients act on without asking again — so the
    // only way to produce this response would be an override that lets it.
    // The obligation the fixture exists to pin is the client's.
    'discovery-advertises-a-feed-that-neither-resumes-nor-includes-records',
  ]);
  const handled = new Set<string>();

  test('discovery-declares-protocol-version-and-capabilities', async () => {
    const fixture = discoveryFixtures.find(
      (f) => f.name === 'discovery-declares-protocol-version-and-capabilities',
    )!;
    handled.add(fixture.name);
    const { status, data } = await req(t.app, fixture.method, fixture.path);
    expect(status).toBe(fixture.responseStatus);
    const d = data as Record<string, unknown>;
    expect(typeof d.version).toBe('string');
    expect((d.version as string).split('.')[0]).toBe(
      (fixture.responseBody!.version as string).split('.')[0],
    );
    expect(typeof d.entityId).toBe('string');
    const capabilities = d.capabilities as { sort: { fields: unknown } };
    expect(Array.isArray(capabilities.sort.fields)).toBe(true);
    for (const field of fixture.responseBody!.capabilities!.sort!.fields!) {
      expect(capabilities.sort.fields).toContain(field);
    }
  });

  test('discovery-omits-absent-timezone', async () => {
    const fixture = discoveryFixtures.find((f) => f.name === 'discovery-omits-absent-timezone')!;
    handled.add(fixture.name);
    const noTzApp = await buildTestApp({ timezone: undefined });
    try {
      const { status, data } = await req(noTzApp.app, fixture.method, fixture.path);
      expect(status).toBe(fixture.responseStatus);
      expect('timezone' in (data as Record<string, unknown>)).toBe(false);
    } finally {
      await noTzApp.cleanup();
    }
  });

  test('discovery-advertises-did-challenge-auth', async () => {
    const fixture = discoveryFixtures.find(
      (f) => f.name === 'discovery-advertises-did-challenge-auth',
    )!;
    handled.add(fixture.name);
    const { status, data } = await req(t.app, fixture.method, fixture.path);
    expect(status).toBe(fixture.responseStatus);
    expect((data as { auth?: { methods: string[] } }).auth).toEqual(fixture.responseBody!.auth);
  });

  test('discovery-advertises-a-change-feed', async () => {
    const fixture = discoveryFixtures.find((f) => f.name === 'discovery-advertises-a-change-feed')!;
    handled.add(fixture.name);
    const { status, data } = await req(t.app, fixture.method, fixture.path);
    expect(status).toBe(fixture.responseStatus);
    const changes = (data as { changes?: Record<string, unknown> }).changes;
    expect(changes).toBeDefined();
    expect(changes!.transports).toEqual(['sse']);
    // Both mirror what GET /changes actually does: it mints cursors and
    // honors Last-Event-ID/?since=, and it honors `?include=record`.
    expect(changes!.resume).toBe(true);
    expect(changes!.records).toBe(true);
  });

  test('coverage', () => {
    assertCoverage(
      discoveryFixtures.map((f) => f.name),
      handled,
      SKIPPED,
    );
  });
});

// -------------------------------------------------------
// Records: create
// -------------------------------------------------------

describe('createRecord fixtures', () => {
  // Every fixture in this block is dispatched — nothing here is skipped.
  const SKIPPED = new Set<string>();
  const handled = new Set<string>();

  test('create-record — owner-authored, echoed back verbatim', async () => {
    const fixture = createRecordFixtures.find((f) => f.name === 'create-record')!;
    handled.add(fixture.name);
    const body = withFreshId(fixture.requestBody as WireRecord);
    const { status, data } = await req(t.app, 'POST', fixture.path, { token: TEST_TOKEN, body });
    expect(status).toBe(fixture.responseStatus);
    const d = data as Record<string, unknown>;
    expect(d.id).toBe(body.id);
    expect(d.typeId).toBe(body.typeId);
    expect(d.content).toEqual(body.content);
    expect(d.version).toBe(1);
    // The owner token acts as the owner entity itself, so entityId is
    // stamped to it — undelegated, so principalId stays absent.
    expect(d.entityId).toBe(TEST_ENTITY_ID);
    expect(d.principalId).toBeUndefined();
  });

  test('create-record-ignores-client-supplied-entity-and-principal', async () => {
    const fixture = createRecordFixtures.find(
      (f) => f.name === 'create-record-ignores-client-supplied-entity-and-principal',
    )!;
    handled.add(fixture.name);
    const body = withFreshId(fixture.requestBody as WireRecord & { appId?: string });
    await t.ctx.stack.grant({ kind: 'entity', entityId: CONTRIBUTOR_ID }, [
      { actions: ['create'], typeId: body.typeId },
    ]);
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const { status, data } = await req(t.app, 'POST', fixture.path, { token, body });
    expect(status).toBe(fixture.responseStatus);
    const d = data as Record<string, unknown>;
    expect(d.content).toEqual(body.content);
    // entityId/principalId are stamped from the session, never the body.
    expect(d.entityId).toBe(CONTRIBUTOR_ID);
    expect(d.principalId).toBeUndefined();
    // appId is the deliberate exception: self-reported, honored verbatim.
    expect(d.appId).toBe(body.appId);
  });

  test('create-record-response-carries-principal-under-delegation', async () => {
    const fixture = createRecordFixtures.find(
      (f) => f.name === 'create-record-response-carries-principal-under-delegation',
    )!;
    handled.add(fixture.name);
    const body = withFreshId(fixture.requestBody as WireRecord & { appId?: string });
    await t.ctx.stack.grant({ kind: 'entity', entityId: BLOG_SUBJECT_ID }, [
      { actions: ['create'], typeId: body.typeId },
    ]);
    await t.ctx.stack.grant({ kind: 'entity', entityId: BLOG_APP_ID }, [
      { actions: ['create'], typeId: body.typeId },
    ]);
    const { token } = await t.ctx.adapter.createToken(BLOG_APP_ID, { onBehalfOf: BLOG_SUBJECT_ID });
    const { status, data } = await req(t.app, 'POST', fixture.path, { token, body });
    expect(status).toBe(fixture.responseStatus);
    const d = data as Record<string, unknown>;
    expect(d.content).toEqual(body.content);
    expect(d.entityId).toBe(BLOG_SUBJECT_ID);
    expect(d.principalId).toBe(BLOG_APP_ID);
    expect(d.appId).toBe(body.appId);
  });

  test('create-attachment-record-matching-mimetype-succeeds', async () => {
    const fixture = createRecordFixtures.find(
      (f) => f.name === 'create-attachment-record-matching-mimetype-succeeds',
    )!;
    handled.add(fixture.name);
    const body = withFreshId(
      fixture.requestBody as WireRecord & {
        content: { fileId: string; mimeType: string };
      },
    );
    await t.ctx.stack.create(ATTACHMENT_TYPE, {
      fileId: body.content.fileId,
      mimeType: body.content.mimeType,
      size: 1,
    });
    const { status, data } = await req(t.app, 'POST', fixture.path, { token: TEST_TOKEN, body });
    expect(status).toBe(fixture.responseStatus);
    expect((data as Record<string, unknown>).content).toEqual(body.content);
  });

  test('create-attachment-record-non-owner-carve-out-succeeds', async () => {
    const fixture = createRecordFixtures.find(
      (f) => f.name === 'create-attachment-record-non-owner-carve-out-succeeds',
    )!;
    handled.add(fixture.name);
    const body = withFreshId(
      fixture.requestBody as WireRecord & { content: { fileId: string; mimeType: string } },
    );
    // The readable reference the carve-out turns on: an owner-authored Note
    // the contributor may read, carrying an attachment association for the
    // same file. The bytes stay the owner's — the contributor never uploads
    // and never proves possession, which is the whole point of the carve-out.
    const uploaded = await t.ctx.stack.putAttachment(
      new Uint8Array([1, 2, 3]),
      body.content.mimeType,
      'owner.png',
    );
    const fileId = (uploaded.content as { fileId: string }).fileId;
    const note = await t.ctx.stack.create(NOTE_TYPE, { title: 'has a cover' });
    await t.ctx.stack.associate(note.id, { kind: 'attachment', label: 'cover', fileId });
    await t.ctx.stack.grant({ kind: 'entity', entityId: CONTRIBUTOR_ID }, [
      { actions: ['read-any'], typeId: NOTE_TYPE },
      { actions: ['create'], typeId: ATTACHMENT_TYPE },
    ]);
    const content = { ...body.content, fileId };
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const { status, data } = await req(t.app, 'POST', fixture.path, {
      token,
      body: { ...body, content },
    });
    expect(status).toBe(fixture.responseStatus);
    const d = data as Record<string, unknown>;
    // Their own record — own id, own filename — not a dedup of the owner's.
    expect(d.id).toBe(body.id);
    expect(d.content).toEqual(content);
    expect(d.entityId).toBe(CONTRIBUTOR_ID);
  });

  test('create-record-unlisted — unlistedAt in the create body suppresses enumeration from create time', async () => {
    const fixture = createRecordFixtures.find((f) => f.name === 'create-record-unlisted')!;
    handled.add(fixture.name);
    const body = withFreshId(fixture.requestBody as WireRecord);
    const { status, data } = await req(t.app, 'POST', fixture.path, { token: TEST_TOKEN, body });
    expect(status).toBe(fixture.responseStatus);
    const d = data as Record<string, unknown>;
    expect(d.id).toBe(body.id);
    expect(d.content).toEqual(body.content);
    expect(d.version).toBe(1);
    // Core stamps unlistedAt to the real create time rather than honoring a
    // backdated value from the body it's echoed alongside — presence is
    // what this fixture pins, not the literal value.
    expect(typeof d.unlistedAt).toBe('string');
  });

  test('create-grant-record-group-grantee — a grant names its grantee affirmatively', async () => {
    const fixture = createRecordFixtures.find(
      (f) => f.name === 'create-grant-record-group-grantee',
    )!;
    handled.add(fixture.name);
    const group = await t.ctx.stack.create(GROUP_TYPE, { name: 'Reviewers' });
    const body = withFreshId(fixture.requestBody as WireRecord);
    const content = body.content as { grantee: { groupId: string } };
    const { status, data } = await req(t.app, 'POST', fixture.path, {
      token: TEST_TOKEN,
      body: {
        ...body,
        content: { ...content, grantee: { ...content.grantee, groupId: group.id } },
      },
    });
    expect(status).toBe(fixture.responseStatus);
    // No tier is reachable by omission, so the grantee travels whole —
    // role included, since admin is the narrower set.
    expect((data as { content: unknown }).content).toEqual({
      ...content,
      grantee: { ...content.grantee, groupId: group.id },
    });
  });

  test('coverage', () => {
    assertCoverage(
      createRecordFixtures.map((f) => f.name),
      handled,
      SKIPPED,
    );
  });
});

// -------------------------------------------------------
// Records: query — envelope invariants
// -------------------------------------------------------

describe('queryRecords fixtures', () => {
  // These pin the query *envelope* (records and cursor, and nothing else;
  // cursor, not records.length, signals exhaustion), not the fixtures'
  // literal opaque cursor strings or record ids, which are this server's own
  // pagination implementation detail. Exercised with real seeded data and
  // real returned cursors rather than replayed fixture cursors.

  test('query-envelope-is-records-and-cursor — POST /records/query and GET /records agree', async () => {
    await t.ctx.stack.create(NOTE_TYPE, { title: 'Readable' });
    const post = await req(t.app, 'POST', '/records/query', {
      token: TEST_TOKEN,
      body: { filter: { typeId: NOTE_TYPE } },
    });
    expect(post.status).toBe(200);
    expect(Object.keys(post.data as object).sort()).toEqual(['cursor', 'records']);

    const get = await req(t.app, 'GET', `/records?typeId=${encodeURIComponent(NOTE_TYPE)}`, {
      token: TEST_TOKEN,
    });
    expect(get.status).toBe(200);
    expect(Object.keys(get.data as object).sort()).toEqual(['cursor', 'records']);
  });

  test('query-final-page-closes-the-cursor — paging with limit exhausts to cursor: null', async () => {
    for (let i = 0; i < 3; i++) await t.ctx.stack.create(NOTE_TYPE, { title: `note-${i}` });

    let cursor: string | null | undefined;
    let seen = 0;
    let pages = 0;
    do {
      const { status, data } = await req(t.app, 'POST', '/records/query', {
        token: TEST_TOKEN,
        body: { filter: { typeId: NOTE_TYPE }, limit: 1, ...(cursor && { cursor }) },
      });
      expect(status).toBe(200);
      const page = data as { records: unknown[]; cursor: string | null };
      seen += page.records.length;
      cursor = page.cursor;
      pages++;
    } while (cursor && pages < 10);

    expect(cursor).toBeNull();
    expect(seen).toBe(3);
  });

  test('query-related-to-record-target — relatedTo (+ relatedToLabel) accepts a record-target filter', async () => {
    const fixture = queryRecordsFixtures.find((f) => f.name === 'query-related-to-record-target')!;
    const { status, data } = await req(t.app, fixture.method, fixture.path, { token: TEST_TOKEN });
    expect(status).toBe(fixture.responseStatus);
    const page = data as { records: unknown[]; cursor: unknown };
    expect(page.records).toEqual([]);
    expect(page.cursor).toBeNull();
  });

  test('query-related-to-entity-target — relatedToEntity accepts an entity-target filter', async () => {
    const fixture = queryRecordsFixtures.find((f) => f.name === 'query-related-to-entity-target')!;
    const { status, data } = await req(t.app, fixture.method, fixture.path, { token: TEST_TOKEN });
    expect(status).toBe(fixture.responseStatus);
    const page = data as { records: unknown[]; cursor: unknown };
    expect(page.records).toEqual([]);
    expect(page.cursor).toBeNull();
  });

  test('query-related-to-external-namespace — relatedToNs alone matches the whole namespace', async () => {
    const fixture = queryRecordsFixtures.find(
      (f) => f.name === 'query-related-to-external-namespace',
    )!;
    const { status, data } = await req(t.app, fixture.method, fixture.path, { token: TEST_TOKEN });
    expect(status).toBe(fixture.responseStatus);
    const page = data as { records: unknown[]; cursor: unknown };
    expect(page.records).toEqual([]);
    expect(page.cursor).toBeNull();
  });

  test('query-filters-by-content-presence — filter.contentPresent is accepted', async () => {
    const fixture = queryRecordsFixtures.find(
      (f) => f.name === 'query-filters-by-content-presence',
    )!;
    const { status, data } = await req(t.app, fixture.method, fixture.path, {
      token: TEST_TOKEN,
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    const page = data as { records: unknown[]; cursor: unknown };
    expect(page.records).toEqual([]);
    expect(page.cursor).toBeNull();
  });

  test('query-sorts-by-a-content-field — sort.contentField is accepted on POST', async () => {
    const fixture = queryRecordsFixtures.find((f) => f.name === 'query-sorts-by-a-content-field')!;
    const { status, data } = await req(t.app, fixture.method, fixture.path, {
      token: TEST_TOKEN,
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    const page = data as { records: unknown[]; cursor: unknown };
    expect(page.records).toEqual([]);
    expect(page.cursor).toBeNull();
  });

  test('query-content-sort-folds-case-and-accents — a content-field sort request is accepted', async () => {
    const fixture = queryRecordsFixtures.find(
      (f) => f.name === 'query-content-sort-folds-case-and-accents',
    )!;
    const { status, data } = await req(t.app, fixture.method, fixture.path, {
      token: TEST_TOKEN,
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    const page = data as { records: unknown[]; cursor: unknown };
    expect(page.records).toEqual([]);
    expect(page.cursor).toBeNull();
  });

  test('query-get-sorts-by-a-content-field — ?sortContent= is accepted on GET', async () => {
    const fixture = queryRecordsFixtures.find(
      (f) => f.name === 'query-get-sorts-by-a-content-field',
    )!;
    const { status, data } = await req(t.app, fixture.method, fixture.path, { token: TEST_TOKEN });
    expect(status).toBe(fixture.responseStatus);
    const page = data as { records: unknown[]; cursor: unknown };
    expect(page.records).toEqual([]);
    expect(page.cursor).toBeNull();
  });

  test('coverage', () => {
    // query-empty-page-with-live-cursor and query-get-records-uses-the-same-
    // envelope pin narrower edge cases of the same two invariants (a
    // partial-visibility empty page that isn't exhaustion; GET/POST sharing
    // an envelope) already covered above by construction.
    assertCoverage(
      queryRecordsFixtures.map((f) => f.name),
      new Set([
        'query-envelope-is-records-and-cursor',
        'query-empty-page-with-live-cursor',
        'query-final-page-closes-the-cursor',
        'query-get-records-uses-the-same-envelope',
        'query-related-to-record-target',
        'query-related-to-entity-target',
        'query-related-to-external-namespace',
        'query-filters-by-content-presence',
        'query-sorts-by-a-content-field',
        'query-content-sort-folds-case-and-accents',
        'query-get-sorts-by-a-content-field',
      ]),
      new Set(),
    );
  });
});

// -------------------------------------------------------
// Records: patchContent
// -------------------------------------------------------

describe('patchContent fixtures', () => {
  const handled = new Set<string>();

  test('patch-content-merges-and-adds-fields', async () => {
    const fixture = patchContentFixtures.find(
      (f) => f.name === 'patch-content-merges-and-adds-fields',
    )!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, {
      title: 'original title',
      body: 'original body',
    });
    const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    const d = data as Record<string, unknown>;
    expect(d.content).toEqual(fixture.responseBody!.content);
    expect(d.version).toBe(fixture.responseBody!.version);
  });

  test('patch-content-null-deletes-a-field', async () => {
    const fixture = patchContentFixtures.find(
      (f) => f.name === 'patch-content-null-deletes-a-field',
    )!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, {
      title: 'to be removed',
      body: 'kept',
    });
    const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    const d = data as Record<string, unknown>;
    expect(d.content).toEqual(fixture.responseBody!.content);
    expect(d.version).toBe(fixture.responseBody!.version);
  });

  test('patch-record-restamps-the-actor', async () => {
    const fixture = patchContentFixtures.find((f) => f.name === 'patch-record-restamps-the-actor')!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'original' },
      {
        entityId: TEST_ENTITY_ID,
        permissions: [
          {
            kind: 'permission',
            label: 'read',
            grantee: { scope: 'entity', entityId: CONTRIBUTOR_ID },
          },
          {
            kind: 'permission',
            label: 'write',
            grantee: { scope: 'entity', entityId: CONTRIBUTOR_ID },
          },
        ],
      },
    );
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
      token,
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    const d = data as Record<string, unknown>;
    expect(d.content).toEqual(fixture.responseBody!.content);
    // Authorship (entityId) is untouched by a non-author write; updatedBy
    // moves to the requester who made this edit.
    expect(d.entityId).toBe(TEST_ENTITY_ID);
    expect(d.updatedBy).toBe(CONTRIBUTOR_ID);
  });

  test('coverage', () => {
    assertCoverage(
      patchContentFixtures.map((f) => f.name),
      handled,
      new Set(),
    );
  });
});

// -------------------------------------------------------
// Records: delete / undelete
// -------------------------------------------------------

describe('deleteRecord fixtures', () => {
  const handled = new Set<string>();

  test('delete-record-soft', async () => {
    const fixture = deleteRecordFixtures.find((f) => f.name === 'delete-record-soft')!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    const { status } = await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
    expect(status).toBe(fixture.responseStatus);
    // Soft-deleted: still fetchable directly, history retained.
    const after = await req(t.app, 'GET', `/records/${record.id}`, { token: TEST_TOKEN });
    expect(after.status).toBe(200);
  });

  test('delete-record-hard', async () => {
    const fixture = deleteRecordFixtures.find((f) => f.name === 'delete-record-hard')!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    const { status } = await req(t.app, 'DELETE', `/records/${record.id}?hard=true`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(fixture.responseStatus);
    const after = await req(t.app, 'GET', `/records/${record.id}`, { token: TEST_TOKEN });
    expect(after.status).toBe(404);
  });

  // A write landing immediately before the purge, which the purge's own
  // response must still name: what it pins is that the body is read at
  // destruction time, not from a snapshot taken earlier in the request.
  // Both fileIds are real uploads rather than the fixture's literal ones —
  // an attachment association names a stored file, so the shape of the
  // claim travels and the hashes cannot.
  test('hard-delete-under-concurrent-write', async () => {
    const sequence = deleteRecordSequenceFixtures.find(
      (f) => f.name === 'hard-delete-under-concurrent-write',
    )!;
    handled.add(sequence.name);
    const [cover, late] = await Promise.all([
      t.ctx.stack.putAttachment(new Uint8Array([1, 2, 3]), 'image/png', 'cover.png'),
      t.ctx.stack.putAttachment(new Uint8Array([4, 5, 6]), 'image/png', 'late.png'),
    ]);
    const coverFileId = (cover.content as { fileId: string }).fileId;
    const lateFileId = (late.content as { fileId: string }).fileId;
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'x' },
      {
        associations: [
          { kind: 'attachment', label: 'cover', fileId: coverFileId, attachmentRecordId: cover.id },
        ],
      },
    );

    const [addStep, purgeStep] = sequence.steps;
    const added = await req(t.app, addStep!.method, `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { kind: 'attachment', label: 'late-arrival', fileId: lateFileId },
    });
    expect(added.status).toBe(addStep!.responseStatus);

    const purged = await req(t.app, purgeStep!.method, `/records/${record.id}?hard=true`, {
      token: TEST_TOKEN,
    });
    expect(purged.status).toBe(purgeStep!.responseStatus);
    const associations = (purged.data as { associations?: Array<{ label: string }> }).associations;
    expect(associations?.map((a) => a.label).sort()).toEqual(['cover', 'late-arrival']);
  });

  // Last in the block: the sequence fixture above is dispatched after the
  // single-request ones, so `handled` is only complete here.
  test('coverage: deleteRecordFixtures + deleteRecordSequenceFixtures', () => {
    assertCoverage(
      [...deleteRecordFixtures, ...deleteRecordSequenceFixtures].map((f) => f.name),
      handled,
      new Set(),
    );
  });
});

describe('undeleteRecord fixtures', () => {
  const handled = new Set<string>();

  test('undelete-record — reverses a soft delete and is idempotent', async () => {
    const fixture = undeleteRecordFixtures.find((f) => f.name === 'undelete-record')!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });

    const first = await req(t.app, 'POST', fixture.path.replace('1hk153x00001', record.id), {
      token: TEST_TOKEN,
    });
    expect(first.status).toBe(fixture.responseStatus);
    const firstBody = first.data as Record<string, unknown>;
    expect(firstBody.deletedAt).toBeUndefined();

    const second = await req(t.app, 'POST', fixture.path.replace('1hk153x00001', record.id), {
      token: TEST_TOKEN,
    });
    expect(second.status).toBe(200);
    expect((second.data as Record<string, unknown>).deletedAt).toBeUndefined();
    expect((second.data as Record<string, unknown>).content).toEqual(firstBody.content);
  });

  test('coverage', () => {
    assertCoverage(
      undeleteRecordFixtures.map((f) => f.name),
      handled,
      new Set(),
    );
  });
});

// -------------------------------------------------------
// Associations
// -------------------------------------------------------

describe('associate fixtures', () => {
  const handled = new Set<string>();

  test('associate-tag', async () => {
    const fixture = associateFixtures.find((f) => f.name === 'associate-tag')!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    const { status } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    const { data } = await req(t.app, 'GET', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
    });
    expect((data as { associations: unknown[] }).associations).toEqual([fixture.requestBody]);
  });

  test('associate-relationship-external-target', async () => {
    const fixture = associateFixtures.find(
      (f) => f.name === 'associate-relationship-external-target',
    )!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    const { status } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    const { data } = await req(t.app, 'GET', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
    });
    // The discriminated target travels verbatim — core validates the union,
    // this server neither flattens nor reshapes it.
    expect((data as { associations: unknown[] }).associations).toEqual([fixture.requestBody]);
  });

  test('associate-attachment-record-id', async () => {
    const fixture = associateFixtures.find((f) => f.name === 'associate-attachment-record-id')!;
    handled.add(fixture.name);
    const body = fixture.requestBody as DataAssociation & {
      kind: 'attachment';
      fileId: string;
      attachmentRecordId: string;
    };
    const uploaded = await t.ctx.stack.putAttachment(
      new Uint8Array([1, 2, 3]),
      'image/png',
      'embed.png',
    );
    const fileId = (uploaded.content as { fileId: string }).fileId;
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    const { status } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { ...body, fileId, attachmentRecordId: uploaded.id },
    });
    expect(status).toBe(fixture.responseStatus);
    const { data } = await req(t.app, 'GET', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
    });
    // attachmentRecordId travels verbatim, in both directions — the pointer
    // annotates the reference rather than identifying it.
    expect((data as { associations: unknown[] }).associations).toEqual([
      { ...body, fileId, attachmentRecordId: uploaded.id },
    ]);
  });

  test('coverage', () => {
    assertCoverage(
      associateFixtures.map((f) => f.name),
      handled,
      new Set(),
    );
  });
});

describe('dissociate fixtures', () => {
  const handled = new Set<string>();

  test('dissociate-tag', async () => {
    const fixture = dissociateFixtures.find((f) => f.name === 'dissociate-tag')!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'x' },
      { associations: [fixture.requestBody as DataAssociation] },
    );
    const { status } = await req(t.app, 'POST', `/records/${record.id}/associations/delete`, {
      token: TEST_TOKEN,
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    const { data } = await req(t.app, 'GET', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
    });
    expect((data as { associations: unknown[] }).associations).toEqual([]);
  });

  test('dissociate-attachment-by-identity', async () => {
    const fixture = dissociateFixtures.find((f) => f.name === 'dissociate-attachment-by-identity')!;
    handled.add(fixture.name);
    const body = fixture.requestBody as DataAssociation & { kind: 'attachment'; fileId: string };
    const uploaded = await t.ctx.stack.putAttachment(
      new Uint8Array([1, 2, 3]),
      'image/png',
      'embed.png',
    );
    const fileId = (uploaded.content as { fileId: string }).fileId;
    // The stored association carries an attachmentRecordId, but identity
    // stays (kind, label, fileId) — dissociating without the pointer still
    // matches and removes it.
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'x' },
      { associations: [{ ...body, fileId, attachmentRecordId: uploaded.id }] },
    );
    const { status } = await req(t.app, 'POST', `/records/${record.id}/associations/delete`, {
      token: TEST_TOKEN,
      body: { ...body, fileId },
    });
    expect(status).toBe(fixture.responseStatus);
    const { data } = await req(t.app, 'GET', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
    });
    expect((data as { associations: unknown[] }).associations).toEqual([]);
  });

  test('coverage', () => {
    assertCoverage(
      dissociateFixtures.map((f) => f.name),
      handled,
      new Set(),
    );
  });
});

// -------------------------------------------------------
// Permissions
// -------------------------------------------------------

describe('permissions change fixtures', () => {
  const handled = new Set<string>();

  test('set-permissions-anyone', async () => {
    const fixture = permissionsChangeFixtures.find((f) => f.name === 'set-permissions-anyone')!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'x' },
      { associations: [{ kind: 'tag', label: 'draft' }] },
    );
    const { status, data } = await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    const body = data as { permissions?: unknown[]; associations?: unknown[]; version: number };
    expect(body.permissions).toEqual(fixture.responseBody!.permissions);
    // A separate domain: the key replaces the ACL and leaves the tags where
    // they are, and the write bumps nothing.
    expect(body.associations).toEqual(fixture.responseBody!.associations);
    expect(body.version).toBe(record.version);

    const anon = await req(t.app, 'GET', `/records/${record.id}`);
    expect(anon.status).toBe(200);
  });

  test('set-permissions-empty-is-private', async () => {
    const fixture = permissionsChangeFixtures.find(
      (f) => f.name === 'set-permissions-empty-is-private',
    )!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'x' },
      { permissions: [{ kind: 'anyone', label: 'read' }] },
    );
    const { status } = await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    // Anonymous can't tell "made private" from "never existed" — the
    // anti-oracle rule, so 404 + WWW-Authenticate, not 403.
    const anon = await t.app.request(`/records/${record.id}`);
    expect(anon.status).toBe(404);
    expect(anon.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  test('coverage', () => {
    assertCoverage(
      permissionsChangeFixtures.map((f) => f.name),
      handled,
      new Set(),
    );
  });
});

// -------------------------------------------------------
// Record-level grant/revoke — the amending spelling of the permissions
// key, carrying the reshare gate rather than the write bit.
// -------------------------------------------------------

describe('grantAccess / revokeAccess fixtures', () => {
  const handled = new Set<string>();

  test('grant-access-entity', async () => {
    const fixture = grantAccessFixtures.find((f) => f.name === 'grant-access-entity')!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    const element = {
      ...fixture.requestBody,
      grantee: { scope: 'entity', entityId: CONTRIBUTOR_ID },
    };

    const { status, data } = await req(t.app, 'POST', `/records/${record.id}/permissions`, {
      token: TEST_TOKEN,
      body: element,
    });
    expect(status).toBe(fixture.responseStatus);
    const body = data as { permissions?: unknown[]; version: number };
    expect(body.permissions).toEqual([element]);
    // A permission element is an association: no bump, no snapshot.
    expect(body.version).toBe(record.version);

    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const read = await req(t.app, 'GET', `/records/${record.id}`, { token });
    expect(read.status).toBe(200);
  });

  test('grant-access-group-role', async () => {
    const fixture = grantAccessFixtures.find((f) => f.name === 'grant-access-group-role')!;
    handled.add(fixture.name);
    const group = await t.ctx.stack.create(GROUP_TYPE, { name: 'Editors' });
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    const element = {
      ...fixture.requestBody,
      grantee: { scope: 'group', groupId: group.id, role: 'admin' },
    };

    const { status, data } = await req(t.app, 'POST', `/records/${record.id}/permissions`, {
      token: TEST_TOKEN,
      body: element,
    });
    expect(status).toBe(fixture.responseStatus);
    // The role travels verbatim — there is no absent-role spelling for a
    // group grantee to fall back on.
    expect((data as { permissions?: unknown[] }).permissions).toEqual([element]);
  });

  test('the endpoints amend the set where the change-set key replaces it', async () => {
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    await req(t.app, 'POST', `/records/${record.id}/permissions`, {
      token: TEST_TOKEN,
      body: {
        kind: 'permission',
        label: 'read',
        grantee: { scope: 'entity', entityId: CONTRIBUTOR_ID },
      },
    });
    const { data } = await req(t.app, 'POST', `/records/${record.id}/permissions`, {
      token: TEST_TOKEN,
      body: { kind: 'anyone', label: 'read' },
    });
    expect((data as { permissions?: unknown[] }).permissions).toHaveLength(2);
  });

  test('revoke-access-anyone', async () => {
    const fixture = revokeAccessFixtures.find((f) => f.name === 'revoke-access-anyone')!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'Hello' },
      { permissions: [{ kind: 'anyone', label: 'read' }] },
    );

    const { status, data } = await req(t.app, 'POST', `/records/${record.id}/permissions/delete`, {
      token: TEST_TOKEN,
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    const body = data as { permissions?: unknown[]; version: number };
    // Reach to the world is its own kind, so withdrawing it names that kind
    // and leaves the set empty rather than clearing a field.
    expect(body.permissions ?? []).toEqual([]);
    expect(body.version).toBe(record.version);
  });

  test('carries the reshare gate, not the write bit', async () => {
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'Hello' },
      {
        permissions: [
          {
            kind: 'permission',
            label: 'read',
            grantee: { scope: 'entity', entityId: WRITER_ID },
          },
          {
            kind: 'permission',
            label: 'write',
            grantee: { scope: 'entity', entityId: WRITER_ID },
          },
        ],
      },
    );
    const { token } = await t.ctx.adapter.createToken(WRITER_ID);
    const { status } = await req(t.app, 'POST', `/records/${record.id}/permissions`, {
      token,
      body: { kind: 'anyone', label: 'read' },
    });
    expect(status).toBe(403);
  });

  test('coverage', () => {
    assertCoverage(
      [...grantAccessFixtures.map((f) => f.name), ...revokeAccessFixtures.map((f) => f.name)],
      handled,
      new Set(),
    );
  });
});

// -------------------------------------------------------
// Journal — the second durable tier, and the only place an association's
// prior state survives.
// -------------------------------------------------------

describe('journal fixtures', () => {
  const handled = new Set<string>();

  test('get-journal-reads-the-whole-log-oldest-first', async () => {
    const fixture = getJournalFixtures.find(
      (f) => f.name === 'get-journal-reads-the-whole-log-oldest-first',
    )!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { kind: 'tag', label: 'starred' },
    });

    const { status, data } = await req(t.app, 'GET', `/records/${record.id}/journal`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(fixture.responseStatus);
    const body = data as WireJournalResponse;
    expect(body.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(body.entries.map((e) => e.ops)).toEqual([['create'], ['associate']]);
    // version stands still across the associate, which is why seq is the
    // only ordering the log carries.
    expect(body.entries.every((e) => e.version === 1)).toBe(true);
    expect(body.entries[1]!.associations).toEqual([
      { op: 'add', association: { kind: 'tag', label: 'starred' } },
    ]);
    expect(body.cursor).toBeNull();
  });

  test('get-journal-page-reports-a-cursor-to-resume-from', async () => {
    const fixture = getJournalFixtures.find(
      (f) => f.name === 'get-journal-page-reports-a-cursor-to-resume-from',
    )!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { kind: 'tag', label: 'starred' },
    });

    const page = await req(t.app, 'GET', `/records/${record.id}/journal?sinceSeq=0&limit=1`, {
      token: TEST_TOKEN,
    });
    expect(page.status).toBe(fixture.responseStatus);
    const first = page.data as WireJournalResponse;
    expect(first.entries.map((e) => e.seq)).toEqual([1]);
    // cursor is the only end-of-log signal, and carries the seq to send
    // back as sinceSeq.
    expect(first.cursor).toBe(1);

    const resumed = await req(
      t.app,
      'GET',
      `/records/${record.id}/journal?sinceSeq=${first.cursor}`,
      { token: TEST_TOKEN },
    );
    expect((resumed.data as WireJournalResponse).entries.map((e) => e.seq)).toEqual([2]);
  });

  test('get-journal-entry-keeps-what-an-associate-overwrote', async () => {
    const fixture = getJournalFixtures.find(
      (f) => f.name === 'get-journal-entry-keeps-what-an-associate-overwrote',
    )!;
    handled.add(fixture.name);
    const first = await t.ctx.stack.putAttachment(
      new Uint8Array([1, 2, 3]),
      'image/png',
      'embed.png',
    );
    const fileId = first.content.fileId;
    // A second _attachment record naming the same bytes, which is what a
    // re-point moves the reference to.
    const second = await t.ctx.stack.create(ATTACHMENT_TYPE, {
      fileId,
      mimeType: 'image/png',
      size: 3,
      filename: 'embed.png',
    });

    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    const association = { kind: 'attachment', label: 'embed', fileId };
    await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { ...association, attachmentRecordId: first.id },
    });
    await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { ...association, attachmentRecordId: second.id },
    });

    const { status, data } = await req(t.app, 'GET', `/records/${record.id}/journal?sinceSeq=2`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(fixture.responseStatus);
    const entry = (data as WireJournalResponse).entries[0]!;
    expect(entry.ops).toEqual(['associate']);
    // Both halves ride one element: what stands now, and what it displaced.
    // Nothing else retains the overwritten attachmentRecordId.
    expect(entry.associations).toEqual([
      {
        op: 'repoint',
        association: { ...association, attachmentRecordId: second.id },
        previous: { ...association, attachmentRecordId: first.id },
      },
    ]);
  });

  test('get-journal-entry-keeps-what-a-dissociate-removed', async () => {
    const fixture = getJournalFixtures.find(
      (f) => f.name === 'get-journal-entry-keeps-what-a-dissociate-removed',
    )!;
    handled.add(fixture.name);
    const uploaded = await t.ctx.stack.putAttachment(
      new Uint8Array([1, 2, 3]),
      'image/png',
      'embed.png',
    );
    const association = {
      kind: 'attachment',
      label: 'embed',
      fileId: uploaded.content.fileId,
    };
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { ...association, attachmentRecordId: uploaded.id },
    });
    await req(t.app, 'POST', `/records/${record.id}/associations/delete`, {
      token: TEST_TOKEN,
      body: association,
    });

    const { status, data } = await req(t.app, 'GET', `/records/${record.id}/journal?sinceSeq=2`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(fixture.responseStatus);
    const entry = (data as WireJournalResponse).entries[0]!;
    expect(entry.ops).toEqual(['dissociate']);
    // `previous` is the association in full, annotation included — where
    // the change frame for the same write names identity only.
    expect(entry.associations).toEqual([
      { op: 'remove', previous: { ...association, attachmentRecordId: uploaded.id } },
    ]);
  });

  test('get-journal-reparent-entry-spells-the-root-as-null', async () => {
    const fixture = getJournalFixtures.find(
      (f) => f.name === 'get-journal-reparent-entry-spells-the-root-as-null',
    )!;
    handled.add(fixture.name);
    const container = await t.ctx.stack.create(NOTE_TYPE, { title: 'Container' });
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: { parentId: container.id },
    });

    const { status, data } = await req(t.app, 'GET', `/records/${record.id}/journal?sinceSeq=1`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(fixture.responseStatus);
    const entry = (data as WireJournalResponse).entries[0]!;
    expect(entry.ops).toEqual(['reparent']);
    expect(entry.parentId).toBe(container.id);
    // Present and null: the record moved out of the root. Absent would say
    // the entry is not a reparent at all, so the two cannot collapse.
    expect(entry.previousParentId).toBeNull();
    expect('previousParentId' in entry).toBe(true);
    expect(entry.version).toBe(1);
  });

  test('omits authority elements for a requester who may not reshare', async () => {
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'Hello' },
      {
        permissions: [
          {
            kind: 'permission',
            label: 'read',
            grantee: { scope: 'entity', entityId: WRITER_ID },
          },
          {
            kind: 'permission',
            label: 'write',
            grantee: { scope: 'entity', entityId: WRITER_ID },
          },
        ],
      },
    );
    await req(t.app, 'POST', `/records/${record.id}/permissions`, {
      token: TEST_TOKEN,
      body: { kind: 'anyone', label: 'read' },
    });

    const { token } = await t.ctx.adapter.createToken(WRITER_ID);
    const { data } = await req(t.app, 'GET', `/records/${record.id}/journal`, { token });
    const entries = (data as WireJournalResponse).entries;
    const moved = entries.find((e) => e.ops.includes('permissions'))!;
    // The entry still names that the ACL moved; the elements beneath it are
    // the resharer's, and go with the field when nothing else is in it.
    expect(moved).toBeDefined();
    expect(moved.associations).toBeUndefined();
    // Entries are never dropped, so seq stays dense.
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1));

    const owner = await req(t.app, 'GET', `/records/${record.id}/journal`, { token: TEST_TOKEN });
    const ownerEntry = (owner.data as WireJournalResponse).entries.find((e) =>
      e.ops.includes('permissions'),
    )!;
    expect(ownerEntry.associations).toEqual([
      { op: 'add', association: { kind: 'anyone', label: 'read' } },
    ]);
  });

  test('coverage', () => {
    assertCoverage(
      getJournalFixtures.map((f) => f.name),
      handled,
      new Set(),
    );
  });
});

// -------------------------------------------------------
// Versions: a coordinated lifecycle matching the fixtures' own designed
// story — get-versions-after-restore/migrate explicitly assume the paired
// mutating fixture (restore-version / commit-migration) already ran, so
// this block runs them together against one seeded record rather than in
// independent isolation.
// -------------------------------------------------------

describe('version lifecycle fixtures', () => {
  const handled = new Set<string>();

  test('every requester past the mutate gate sees the same snapshot rows', async () => {
    const ownerFixture = getVersionsFixtures.find((f) => f.name === 'get-versions-owner')!;
    const writerFixture = getVersionsFixtures.find(
      (f) => f.name === 'get-versions-non-owner-write-holder-sees-the-same-rows',
    )!;
    const singleFixture = getVersionFixtures.find((f) => f.name === 'get-version-single')!;
    handled.add(ownerFixture.name);
    handled.add(writerFixture.name);
    handled.add(singleFixture.name);

    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'original title' },
      {
        permissions: [
          { kind: 'permission', label: 'read', grantee: { scope: 'entity', entityId: WRITER_ID } },
          { kind: 'permission', label: 'write', grantee: { scope: 'entity', entityId: WRITER_ID } },
        ],
      },
    );
    // /versions returns historical snapshots, not the current live state —
    // a record still at its original version has no history yet, so bump
    // it once to give version 1 a snapshot to appear in.
    await t.ctx.stack.patchContent(record.id, { title: 'updated title' });

    const owner = await req(t.app, 'GET', `/records/${record.id}/versions`, { token: TEST_TOKEN });
    expect(owner.status).toBe(ownerFixture.responseStatus);
    expect((owner.data as unknown[]).length).toBe(1);

    const { token: writerToken } = await t.ctx.adapter.createToken(WRITER_ID);
    const writer = await req(t.app, 'GET', `/records/${record.id}/versions`, {
      token: writerToken,
    });
    expect(writer.status).toBe(writerFixture.responseStatus);
    expect(writer.data).toEqual(owner.data);

    const single = await req(t.app, 'GET', `/records/${record.id}/versions/1`, {
      token: writerToken,
    });
    expect(single.status).toBe(singleFixture.responseStatus);
    expect(single.data).toEqual((owner.data as unknown[])[0]);
  });

  test('restore auto-snapshots the pre-restore state; migrate auto-snapshots the pre-migration state', async () => {
    const restoreFixture = restoreVersionFixtures.find((f) => f.name === 'restore-version')!;
    const migrateFixture = commitMigrationFixtures.find((f) => f.name === 'commit-migration')!;
    const afterRestoreFixture = getVersionsAfterMutateFixtures.find(
      (f) => f.name === 'get-versions-after-restore-includes-pre-restore-snapshot',
    )!;
    const afterMigrateFixture = getVersionsAfterMutateFixtures.find(
      (f) => f.name === 'get-versions-after-migrate-includes-pre-migration-snapshot',
    )!;
    handled.add(restoreFixture.name);
    handled.add(migrateFixture.name);
    handled.add(afterRestoreFixture.name);
    handled.add(afterMigrateFixture.name);

    // v1
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'original title' });
    // v2 — an intermediate edit, so v3 (below) isn't restore-version's own
    // pre-restore auto-snapshot colliding with the create itself.
    await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: { contentPatch: { title: 'intermediate title' } },
    });
    // v3 — the state restore-version will move away from
    await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: { contentPatch: { title: 'title before restore' } },
    });

    // v3 (auto pre-restore snapshot of v2) + v4 (restored content, from v1)
    const restore = await req(t.app, 'POST', `/records/${record.id}/restore/1`, {
      token: TEST_TOKEN,
    });
    expect(restore.status).toBe(restoreFixture.responseStatus);
    const restored = restore.data as Record<string, unknown>;
    expect(restored.content).toEqual(restoreFixture.responseBody!.content);
    expect(restored.version).toBe(4);

    // v5 (auto pre-migration snapshot of v4 is v4 itself) + new typeId/content
    const migrateBody = migrateFixture.requestBody!;
    const migrate = await req(t.app, 'POST', `/records/${record.id}/migrate`, {
      token: TEST_TOKEN,
      body: migrateBody,
    });
    expect(migrate.status).toBe(migrateFixture.responseStatus);
    const migrated = migrate.data as Record<string, unknown>;
    expect(migrated.typeId).toBe(migrateBody.toTypeId);
    expect(migrated.content).toEqual(migrateBody.content);
    expect(migrated.version).toBe(5);

    const versions = await req(t.app, 'GET', `/records/${record.id}/versions`, {
      token: TEST_TOKEN,
    });
    expect(versions.status).toBe(afterMigrateFixture.responseStatus);
    const versionList = versions.data as Array<{ version: number; typeId: string }>;
    const numbers = versionList.map((v) => v.version);
    // v4 (pre-migration snapshot), v3 (pre-restore snapshot), v1 (original) —
    // matches afterMigrateFixture/afterRestoreFixture's own version lists.
    expect(numbers).toEqual(
      expect.arrayContaining(afterMigrateFixture.responseBody!.map((v) => v.version)),
    );
    expect(numbers).toEqual(
      expect.arrayContaining(afterRestoreFixture.responseBody!.map((v) => v.version)),
    );
    const v4Snapshot = versionList.find((v) => v.version === 4)!;
    expect(v4Snapshot.typeId).toBe(NOTE_TYPE);
  });

  test('get-versions-after-associate-is-unchanged', async () => {
    const fixture = getVersionsAfterMutateFixtures.find(
      (f) => f.name === 'get-versions-after-associate-is-unchanged',
    )!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'original title' });
    await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: { contentPatch: { title: 'updated title' } },
    });
    const before = await req(t.app, 'GET', `/records/${record.id}/versions`, {
      token: TEST_TOKEN,
    });
    expect(before.status).toBe(fixture.responseStatus);

    await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { kind: 'tag', label: 'starred' },
    });

    const after = await req(t.app, 'GET', `/records/${record.id}/versions`, { token: TEST_TOKEN });
    // Exactly the list it answered with before: no new entry, and no entry
    // gains an associations key — a server that snapshots here hands every
    // later restore a stale association set to put back.
    expect(after.data).toEqual(before.data);
    expect(
      (after.data as Array<Record<string, unknown>>).every((v) => v.associations === undefined),
    ).toBe(true);
  });

  test('a snapshot names no container, and a restore leaves the record where it sits', async () => {
    const snapshotFixture = getVersionFixtures.find(
      (f) => f.name === 'get-version-carries-no-containment-listing-or-authority-state',
    )!;
    const restoreFixture = restoreVersionFixtures.find(
      (f) => f.name === 'restore-version-leaves-the-record-where-it-sits',
    )!;
    handled.add(snapshotFixture.name);
    handled.add(restoreFixture.name);

    const container = await t.ctx.stack.create(NOTE_TYPE, { title: 'Container' });
    // v1, at the root
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'original title' });
    // v2 — the state the restore below returns to, still at the root
    await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: { contentPatch: { title: 'title before restore' } },
    });
    // Aspects that take no snapshot of their own, set before the bump that
    // snapshots v2 — so a snapshot capturing any of them would show them.
    await req(t.app, 'POST', `/records/${record.id}/permissions`, {
      token: TEST_TOKEN,
      body: { kind: 'anyone', label: 'read' },
    });
    // v3 — the content bump that writes v2's snapshot
    await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: { contentPatch: { title: 'current title' }, unlisted: true },
    });
    // A move bumps nothing, and is what leaves the record somewhere other
    // than where v2 was taken.
    await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: { parentId: container.id },
    });

    const snapshot = await req(t.app, 'GET', `/records/${record.id}/versions/2`, {
      token: TEST_TOKEN,
    });
    expect(snapshot.status).toBe(snapshotFixture.responseStatus);
    const v2 = snapshot.data as Record<string, unknown>;
    expect(v2.content).toEqual(snapshotFixture.responseBody!.content);
    // None of the four aspects that bump no version is ever snapshotted.
    expect(v2.parentId).toBeUndefined();
    expect(v2.unlistedAt).toBeUndefined();
    expect(v2.permissions).toBeUndefined();
    expect(v2.associations).toBeUndefined();

    const restore = await req(t.app, 'POST', `/records/${record.id}/restore/2`, {
      token: TEST_TOKEN,
    });
    expect(restore.status).toBe(restoreFixture.responseStatus);
    const restored = restore.data as { parentId?: string; content: unknown; version: number };
    expect(restored.content).toEqual(restoreFixture.responseBody!.content);
    // A restore settles content and typeId alone: the record comes back in
    // whatever container it is in now, not the one the snapshot was taken in.
    expect(restored.parentId).toBe(container.id);
    expect(restored.version).toBe(4);
  });

  test('coverage', () => {
    const names = [
      ...getVersionsFixtures.map((f) => f.name),
      ...getVersionFixtures.map((f) => f.name),
      ...getVersionsAfterMutateFixtures.map((f) => f.name),
      ...restoreVersionFixtures.map((f) => f.name),
      ...commitMigrationFixtures.map((f) => f.name),
    ];
    assertCoverage(names, handled, new Set());
  });
});

// -------------------------------------------------------
// Error responses
// -------------------------------------------------------

describe('error response fixtures', () => {
  // Every fixture in this block is dispatched — nothing here is skipped.
  const SKIPPED = new Set<string>();
  const handled = new Set<string>();

  function find(name: string) {
    const fixture = errorResponseFixtures.find((f) => f.name === name)!;
    handled.add(name);
    return fixture;
  }

  async function dispatch(
    fixture: (typeof errorResponseFixtures)[number],
    token: string | undefined,
    pathOverride?: string,
    bodyOverride?: unknown,
  ) {
    const body = bodyOverride !== undefined ? bodyOverride : fixture.requestBody;
    return req(t.app, fixture.method, pathOverride ?? fixture.path, {
      token,
      ...(body !== undefined && { body }),
      ...(fixture.requestHeaders && { headers: fixture.requestHeaders }),
    });
  }

  function expectError(
    status: number,
    data: unknown,
    fixture: (typeof errorResponseFixtures)[number],
  ) {
    expect(status).toBe(fixture.responseStatus);
    if (fixture.responseBody) {
      expect((data as { error: { code: string } }).error.code).toBe(
        (fixture.responseBody as { error: { code: string } }).error.code,
      );
    }
  }

  test('error-permission-denied — can read, no write grant', async () => {
    const fixture = find('error-permission-denied');
    // Readability is what earns the 403 (see error-not-found-record-the-
    // requester-cannot-read below) — a write-only-denied requester still
    // needs an explicit read grant, or this would hit the anti-oracle 404
    // instead of the permission check this fixture pins.
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'x' },
      {
        permissions: [
          {
            kind: 'permission',
            label: 'read',
            grantee: { scope: 'entity', entityId: CONTRIBUTOR_ID },
          },
        ],
      },
    );
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const { status, data } = await dispatch(fixture, token, `/records/${record.id}`);
    expectError(status, data, fixture);
  });

  test('error-not-found-record-the-requester-cannot-read — the anti-oracle rule', async () => {
    const fixture = find('error-not-found-record-the-requester-cannot-read');
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const { status, data } = await dispatch(fixture, token, `/records/${record.id}`);
    expectError(status, data, fixture);
  });

  test('error-validation-permission-write-without-read', async () => {
    const fixture = find('error-validation-permission-write-without-read');
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    const { status, data } = await dispatch(fixture, TEST_TOKEN, `/records/${record.id}`);
    expectError(status, data, fixture);
  });

  test('error-bad-request-malformed-parent-id', async () => {
    const fixture = find('error-bad-request-malformed-parent-id');
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    // Format is checked before existence, so the empty string answers for
    // being malformed rather than for naming nothing. It is not a spelling
    // of the root here — `null` is.
    const { status, data } = await dispatch(fixture, TEST_TOKEN, `/records/${record.id}`);
    expectError(status, data, fixture);
  });

  test('error-conflict-parent-does-not-exist', async () => {
    const fixture = find('error-conflict-parent-does-not-exist');
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    // Well-formed and simply names nothing, which is the conflict. Only the
    // owner sees it: the reference gate exempts them, so the existence check
    // behind it is theirs to reach. Anyone else gets one indistinguishable
    // 403 for a destination they cannot read and one that is not there.
    const { status, data } = await dispatch(fixture, TEST_TOKEN, `/records/${record.id}`);
    expectError(status, data, fixture);
  });

  test('error-permission-denied-versions-read-only — can read, cannot write', async () => {
    const fixture = find('error-permission-denied-versions-read-only');
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'x' },
      {
        permissions: [
          {
            kind: 'permission',
            label: 'read',
            grantee: { scope: 'entity', entityId: CONTRIBUTOR_ID },
          },
        ],
      },
    );
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const { status, data } = await dispatch(fixture, token, `/records/${record.id}/versions`);
    expectError(status, data, fixture);
  });

  test('error-permission-denied-attachment-non-owner-create', async () => {
    const fixture = find('error-permission-denied-attachment-non-owner-create');
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const { status, data } = await dispatch(fixture, token);
    expectError(status, data, fixture);
  });

  test('create-attachment-record-non-owner-without-carve-out-refused', async () => {
    const fixture = find('create-attachment-record-non-owner-without-carve-out-refused');
    await t.ctx.stack.grant({ kind: 'entity', entityId: CONTRIBUTOR_ID }, [
      { actions: ['create'], typeId: ATTACHMENT_TYPE },
    ]);
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    // The contributor uploads the bytes themselves, so they end up holding
    // an _attachment@1 record for this fileId — the "uploaded it themselves"
    // clause of the getAttachment() access rule. That clause is exactly what
    // the create() carve-out excludes: nothing else references the file, so
    // a second metadata record for it is still refused.
    const upload = await t.app.request('/attachments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
      body: new Uint8Array([9, 9, 9]),
    });
    expect(upload.status).toBe(200);
    const own = (await upload.json()) as { content: { fileId: string } };
    const body = withFreshId(fixture.requestBody as WireRecord & { content: { fileId: string } });
    const { status, data } = await dispatch(fixture, token, undefined, {
      ...body,
      content: { ...body.content, fileId: own.content.fileId },
    });
    expectError(status, data, fixture);
  });

  test('error-permission-denied-restore-reference-reconveyance', async () => {
    const fixture = find('error-permission-denied-restore-reference-reconveyance');
    // A file-ref content field is the only reference a snapshot can put
    // back: no snapshot has ever carried an association, so a restore can
    // never introduce one to gate. v1 names the file, v2 drops it, and
    // nothing readable by the writer names it afterwards — an _attachment@1
    // record holds its fileId in a plain string field, not a file-ref one,
    // so the owner's own upload record is not a reference the check sees.
    const PHOTO_NOTE = 'com.example/photo-note@1';
    await t.ctx.stack.defineType(PHOTO_NOTE, 'Photo note', {
      title: { kind: 'string' },
      coverFileId: { kind: 'file-ref' },
    });
    const uploaded = await t.ctx.stack.putAttachment(
      new Uint8Array([4, 5, 6]),
      'image/png',
      'cover.png',
    );
    const fileId = uploaded.content.fileId;
    const record = await t.ctx.stack.create(
      PHOTO_NOTE,
      { title: 'has a cover', coverFileId: fileId },
      {
        permissions: [
          {
            kind: 'permission',
            label: 'read',
            grantee: { scope: 'entity', entityId: WRITER_ID },
          },
          {
            kind: 'permission',
            label: 'write',
            grantee: { scope: 'entity', entityId: WRITER_ID },
          },
        ],
      },
    );
    // v2 drops the reference, which is what leaves it reachable only from
    // the v1 snapshot a restore would put back.
    await t.ctx.stack.patchContent(record.id, { coverFileId: null });

    const { token } = await t.ctx.adapter.createToken(WRITER_ID);
    const { status, data } = await dispatch(fixture, token, `/records/${record.id}/restore/1`);
    expectError(status, data, fixture);

    // The refusal is about the reference, not about write access: give the
    // writer a readable record that carries the same file today and the
    // identical restore goes through.
    const cover = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'still has the cover' },
      {
        permissions: [
          {
            kind: 'permission',
            label: 'read',
            grantee: { scope: 'entity', entityId: WRITER_ID },
          },
        ],
        associations: [{ kind: 'attachment', label: 'cover', fileId }],
      },
    );
    expect(cover.id).toBeDefined();
    const retry = await req(t.app, 'POST', `/records/${record.id}/restore/1`, { token });
    expect(retry.status).toBe(200);
  });

  test('error-validation-failed-restore', async () => {
    const fixture = find('error-validation-failed-restore');
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'original' });
    // Drift can't be reached through the write API — defineType() refuses
    // any in-place schema change that would invalidate stored content, and
    // create()/update() validate everything they write. So the corrupted
    // snapshot is written straight to the adapter, the way core's own
    // restoreVersion test produces one, and the assertion is that restore
    // validates the snapshot against its own stored typeId rather than
    // trusting it. A create leaves no v1 snapshot of its own, so this adds
    // one rather than overwriting — the SQLite adapter refuses to replace
    // an existing version row.
    await t.ctx.adapter.saveVersion(record.id, {
      version: 1,
      typeId: NOTE_TYPE,
      content: { title: 42 },
      updatedAt: new Date(),
    });
    const { status, data } = await dispatch(fixture, TEST_TOKEN, `/records/${record.id}/restore/1`);
    expectError(status, data, fixture);
    // Nothing was applied: the record still holds its pre-restore content.
    const after = await req(t.app, 'GET', `/records/${record.id}`, { token: TEST_TOKEN });
    expect((after.data as { content: unknown }).content).toEqual({ title: 'original' });
  });

  test('error-timeout-search-exceeds-server-bound', async () => {
    const fixture = find('error-timeout-search-exceeds-server-bound');
    // The fixture's own search isn't costly — per its description it stands
    // in for one that outruns whatever bound a server sets, pinning the
    // error shape rather than a particular cost. This server's bound is
    // config.queryTimeoutMs, enforced at the query worker (see
    // src/lib/queryWorker/pool.ts), so this dispatches against a deadline
    // no query can meet — the same substitution
    // attachment-upload-payload-too-large makes with maxAttachmentBytes.
    const impatientApp = createApp(t.ctx, { ...testConfig(t.dbPath), queryTimeoutMs: 1 }, logger);
    const { status, data } = await req(impatientApp, fixture.method, fixture.path, {
      token: TEST_TOKEN,
      body: fixture.requestBody,
    });
    expectError(status, data, fixture);
  });

  test('error-permission-denied-includeUnlisted-non-owner', async () => {
    const fixture = find('error-permission-denied-includeUnlisted-non-owner');
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const { status, data } = await dispatch(fixture, token);
    expectError(status, data, fixture);
    // Same refusal on GET /records — includeUnlisted is owner-only on every
    // route that accepts it, not just the fixture's own POST /records/query.
    const get = await req(t.app, 'GET', '/records?includeUnlisted=true', { token });
    expect(get.status).toBe(403);
  });

  test('error-not-found — write against a nonexistent id', async () => {
    const fixture = find('error-not-found');
    const { status, data } = await dispatch(fixture, TEST_TOKEN);
    expectError(status, data, fixture);
  });

  test('error-permission-denied-journal-read-only', async () => {
    const fixture = find('error-permission-denied-journal-read-only');
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'readable, not writable' },
      {
        permissions: [
          {
            kind: 'permission',
            label: 'read',
            grantee: { scope: 'entity', entityId: CONTRIBUTOR_ID },
          },
        ],
      },
    );
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const { status, data } = await dispatch(fixture, token, `/records/${record.id}/journal`);
    expectError(status, data, fixture);
  });

  test('error-not-found-journal-of-a-record-that-is-gone', async () => {
    const fixture = find('error-not-found-journal-of-a-record-that-is-gone');
    // Never created and hard-deleted are the same answer — never an empty
    // log, which would read as "nothing changed".
    const missing = await dispatch(fixture, TEST_TOKEN);
    expectError(missing.status, missing.data, fixture);

    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'about to be purged' });
    await t.ctx.stack.delete(record.id, { hard: true });
    const purged = await dispatch(fixture, TEST_TOKEN, `/records/${record.id}/journal`);
    expectError(purged.status, purged.data, fixture);
  });

  test('error-validation-grant-without-grantee', async () => {
    const fixture = find('error-validation-grant-without-grantee');
    const body = withFreshId(fixture.requestBody as WireRecord);
    const { status, data } = await dispatch(fixture, TEST_TOKEN, undefined, body);
    expectError(status, data, fixture);
  });

  test('error-validation-grant-group-grantee-without-role', async () => {
    const fixture = find('error-validation-grant-group-grantee-without-role');
    const body = withFreshId(fixture.requestBody as WireRecord);
    const { status, data } = await dispatch(fixture, TEST_TOKEN, undefined, body);
    expectError(status, data, fixture);
  });

  // The grantee arms, each refused at the write. All seven are plain
  // POST /records bodies, so they share one shape: mint a fresh id and
  // dispatch. What differs is which part of the grantee names nobody.
  for (const name of [
    'error-validation-grant-entity-grantee-without-entity-id',
    'error-validation-grant-entity-grantee-with-empty-entity-id',
    'error-validation-grant-group-grantee-without-group-id',
    'error-validation-grant-group-grantee-with-listing-only-role',
    'error-validation-grant-grantee-with-unknown-kind',
    'error-validation-grant-null-grantee',
  ]) {
    test(name, async () => {
      const fixture = find(name);
      const body = withFreshId(fixture.requestBody as WireRecord);
      const { status, data } = await dispatch(fixture, TEST_TOKEN, undefined, body);
      expectError(status, data, fixture);
    });
  }

  test('error-validation-anyone-element-labelled-write', async () => {
    const fixture = find('error-validation-anyone-element-labelled-write');
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    const { status, data } = await dispatch(
      fixture,
      TEST_TOKEN,
      `/records/${record.id}/permissions`,
    );
    expectError(status, data, fixture);
  });

  test('error-permission-grant-on-an-ungrantable-family-confers-nothing', async () => {
    const fixture = find('error-permission-grant-on-an-ungrantable-family-confers-nothing');
    // Written directly, because stack.grant() refuses the family outright —
    // which is the point: this pins the second half of the rule, where a
    // grant that reached storage some other way is read back as conferring
    // nothing rather than trusted.
    await t.ctx.stack.create(GRANT_TYPE, {
      typeId: APP_TYPE,
      actions: ['create', 'read-any'],
      grantee: { kind: 'entity', entityId: CONTRIBUTOR_ID },
    });
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const body = withFreshId(fixture.requestBody as WireRecord);
    const { status, data } = await dispatch(fixture, token, undefined, body);
    expectError(status, data, fixture);

    // The control, without which this test would pass just as well with no
    // grant at all: the same grant shape on a grantable family does confer
    // the create, so the refusal above is the family's and not the absence
    // of any machinery to read.
    await t.ctx.stack.create(GRANT_TYPE, {
      typeId: COMMENT_TYPE,
      actions: ['create', 'read-any'],
      grantee: { kind: 'entity', entityId: CONTRIBUTOR_ID },
    });
    const control = await req(t.app, 'POST', '/records', {
      token,
      body: { id: generateId(), typeId: COMMENT_TYPE, content: { body: 'allowed' } },
    });
    expect(control.status).toBe(200);
  });

  test('error-not-found-mutate-grant-with-no-read-companion', async () => {
    const fixture = find('error-not-found-mutate-grant-with-no-read-companion');
    // update-any with no read-any beside it: the grant conveys neither the
    // write nor a read, so the refusal is the disclosure rule's 404 rather
    // than a 403. Written directly for the same reason as above — the
    // companion rule is enforced where the grant is read, not only where a
    // helper wrote it.
    await t.ctx.stack.create(GRANT_TYPE, {
      typeId: NOTE_TYPE,
      actions: ['create', 'update-any'],
      grantee: { kind: 'entity', entityId: CONTRIBUTOR_ID },
    });
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: "someone else's" });
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const { status, data } = await dispatch(fixture, token, `/records/${record.id}`);
    expectError(status, data, fixture);

    // The control: add the read companion the grant was missing and the very
    // same PATCH succeeds. Without it this test would pass against a server
    // that had no grant for this requester at all, since both answer 404.
    await t.ctx.stack.create(GRANT_TYPE, {
      typeId: NOTE_TYPE,
      actions: ['update-any', 'read-any'],
      grantee: { kind: 'entity', entityId: CONTRIBUTOR_ID },
    });
    const control = await req(t.app, 'PATCH', `/records/${record.id}`, {
      token,
      body: fixture.requestBody,
    });
    expect(control.status).toBe(200);
  });

  test('error-query-permission-kind-in-associations-key', async () => {
    const fixture = find('error-query-permission-kind-in-associations-key');
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    const { status, data } = await dispatch(fixture, TEST_TOKEN, `/records/${record.id}`);
    expectError(status, data, fixture);
  });

  test('error-query-association-kind-in-permissions-key', async () => {
    const fixture = find('error-query-association-kind-in-permissions-key');
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    const { status, data } = await dispatch(fixture, TEST_TOKEN, `/records/${record.id}`);
    expectError(status, data, fixture);
  });

  test('error-conflict-duplicate-id', async () => {
    const fixture = find('error-conflict-duplicate-id');
    const body = withFreshId(fixture.requestBody as WireRecord);
    await t.ctx.stack.create(NOTE_TYPE, { title: 'first' }, { id: body.id });
    const { status, data } = await dispatch(fixture, TEST_TOKEN, undefined, body);
    expectError(status, data, fixture);
  });

  test('error-validation-failed — PATCH content fails the type schema', async () => {
    const fixture = find('error-validation-failed');
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'x' });
    const { status, data } = await dispatch(fixture, TEST_TOKEN, `/records/${record.id}`);
    expectError(status, data, fixture);
  });

  test('error-validation-attachment-mimetype-conflict-on-create', async () => {
    const fixture = find('error-validation-attachment-mimetype-conflict-on-create');
    const body = withFreshId(fixture.requestBody as WireRecord & { content: { fileId: string } });
    await t.ctx.stack.create(ATTACHMENT_TYPE, {
      fileId: body.content.fileId,
      mimeType: 'image/png',
      size: 1,
    });
    const { status, data } = await dispatch(fixture, TEST_TOKEN, undefined, body);
    expectError(status, data, fixture);
  });

  test('error-validation-attachment-mimetype-immutable-on-update', async () => {
    const fixture = find('error-validation-attachment-mimetype-immutable-on-update');
    const id = fixture.path.split('/')[2]!;
    await t.ctx.stack.create(
      ATTACHMENT_TYPE,
      { fileId: 'a'.repeat(64), mimeType: 'image/png', size: 1 },
      { id },
    );
    const { status, data } = await dispatch(fixture, TEST_TOKEN);
    expectError(status, data, fixture);
  });

  test('error-bad-request-malformed-cursor', async () => {
    const fixture = find('error-bad-request-malformed-cursor');
    const { status, data } = await dispatch(fixture, TEST_TOKEN);
    expectError(status, data, fixture);
  });

  test('error-bad-request-unknown-sort-field-cursor', async () => {
    const fixture = find('error-bad-request-unknown-sort-field-cursor');
    const { status, data } = await dispatch(fixture, TEST_TOKEN);
    expectError(status, data, fixture);
  });

  test('error-bad-request-both-sort-parameters', async () => {
    const fixture = find('error-bad-request-both-sort-parameters');
    const { status, data } = await dispatch(fixture, TEST_TOKEN);
    expectError(status, data, fixture);
  });

  test('error-payload-too-large-record-body', async () => {
    const fixture = find('error-payload-too-large-record-body');
    const oversized = {
      ...(fixture.requestBody as WireRecord),
      content: { body: 'x'.repeat(2 * 1024 * 1024) },
    };
    const { status, data } = await req(t.app, fixture.method, fixture.path, {
      token: TEST_TOKEN,
      body: oversized,
    });
    expectError(status, data, fixture);
  });

  test('error-reserved-content-key', async () => {
    const fixture = find('error-reserved-content-key');
    const id = fixture.path.split('/')[2]!;
    await t.ctx.stack.create(NOTE_TYPE, { title: 'x' }, { id });
    const { status, data } = await dispatch(fixture, TEST_TOKEN);
    expectError(status, data, fixture);
  });

  test('error-version-conflict-if-match-mismatch', async () => {
    const fixture = find('error-version-conflict-if-match-mismatch');
    const id = fixture.path.split('/')[2]!;
    await t.ctx.stack.create(NOTE_TYPE, { title: 'x' }, { id });
    const { status, data } = await dispatch(fixture, TEST_TOKEN);
    expectError(status, data, fixture);
  });

  test('error-schema-drift-non-additive-redefinition', async () => {
    const fixture = find('error-schema-drift-non-additive-redefinition');
    // schemaHash is verified server-side against the submitted schema — the
    // fixture's own value is illustrative, not a real hash of its schema.
    const body = fixture.requestBody as { schema: Record<string, unknown> };
    const schemaHash = await hashSchema(body.schema as never);
    const { status, data } = await dispatch(fixture, TEST_TOKEN, undefined, {
      ...body,
      schemaHash,
    });
    expectError(status, data, fixture);
  });

  test.each([
    'error-bad-request-id-invalid-charset',
    'error-bad-request-id-invalid-length',
    'error-bad-request-id-reserved-prefix',
  ])('%s', async (name) => {
    const fixture = find(name);
    const { status, data } = await dispatch(fixture, TEST_TOKEN);
    expectError(status, data, fixture);
  });

  test.each(['error-conflict-delete-config', 'error-conflict-config-entityid-change'])(
    '%s',
    async (name) => {
      const fixture = find(name);
      const { status, data } = await dispatch(fixture, TEST_TOKEN);
      expectError(status, data, fixture);
    },
  );

  test('error-unauthorized-anonymous', async () => {
    const fixture = find('error-unauthorized-anonymous');
    const { status } = await dispatch(fixture, undefined);
    expect(status).toBe(fixture.responseStatus);
  });

  test('coverage', () => {
    assertCoverage(
      errorResponseFixtures.map((f) => f.name),
      handled,
      SKIPPED,
    );
  });
});

// -------------------------------------------------------
// Change feed: a change-feed fixture isn't a request/response pair like
// every other block here — it pins an ordered stream of frames a
// connection sees, optionally across mutations made while it's open.
// tests/changeFeedClient.ts dispatches those against the real GET /changes.
//
// Same targeted-field discipline as every other block: a fixture's `seq`
// and record ids/timestamps are illustrative, not literal. This server
// mints real cursors (`resume: true`), so `ready.data.seq` and
// every `record` frame's SSE `id:` are asserted structurally (base64url
// shaped) below rather than deep-equated against a fixture's placeholder.
// -------------------------------------------------------

function frameData(frame: DecodedFrame): Record<string, unknown> {
  return frame.data as Record<string, unknown>;
}

/** base64url charset — the shape every minted cursor is held to (isValidSeq). */
const SEQ_PATTERN = /^[A-Za-z0-9_-]+$/;

describe('changeFeed fixtures', () => {
  const handled = new Set<string>();
  const SKIPPED = new Set([
    // Pins a client obligation, in the fixture's own words — ignore an
    // unrecognized SSE event name — by injecting a synthetic `type` frame
    // between `ready` and the `record` frame it expects. A server
    // implementing only this version emits no such frame, so there is
    // nothing server-side to exercise until a later minor adds one; the
    // frame would have to be forged to dispatch this at all.
    'change-feed-unknown-frame-names-are-ignored',
  ]);

  test('change-feed-ready-leads-every-connection', async () => {
    const fixture = changeFeedFixtures.find(
      (f) => f.name === 'change-feed-ready-leads-every-connection',
    )!;
    handled.add(fixture.name);
    const conn = await openChangeFeed(t.app, '/changes', { token: TEST_TOKEN });
    try {
      expect(conn.status).toBe(fixture.responseStatus);
      const [ready] = await conn.waitForFrames(1);
      expect(ready.event).toBe('ready');
      // ready never carries an SSE `id:` line — the cursor it reports rides
      // in the JSON body, as `data.seq`.
      expect(ready.id).toBeUndefined();
      expect(frameData(ready).seq).toMatch(SEQ_PATTERN);
    } finally {
      await conn.close();
    }
  });

  test('change-feed-created-frame', async () => {
    const fixture = changeFeedFixtures.find((f) => f.name === 'change-feed-created-frame')!;
    handled.add(fixture.name);
    const conn = await openChangeFeed(t.app, '/changes', { token: TEST_TOKEN });
    try {
      await conn.waitForFrames(1); // ready
      const { data: created } = await req(t.app, 'POST', '/records', {
        token: TEST_TOKEN,
        body: { typeId: NOTE_TYPE, content: { title: 'Hello' } },
      });
      const recordId = (created as { id: string }).id;
      const [, frame] = await conn.waitForFrames(2);
      expect(frame.event).toBe('record');
      // A record frame's SSE `id:` is its resume cursor.
      expect(frame.id).toMatch(SEQ_PATTERN);
      expect(frame.id).toBe((frameData(frame) as { seq?: string }).seq);
      const data = frameData(frame);
      expect(data.kind).toBe('created');
      expect(data.ops).toEqual(['create']);
      expect(data.recordId).toBe(recordId);
      expect(data.typeId).toBe(NOTE_TYPE);
      expect(data.version).toBe(1);
      expect((data.actor as { entityId: string }).entityId).toBe(TEST_ENTITY_ID);
    } finally {
      await conn.close();
    }
  });

  test('change-feed-changed-frame-names-the-verb', async () => {
    const fixture = changeFeedFixtures.find(
      (f) => f.name === 'change-feed-changed-frame-names-the-verb',
    )!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'original' },
      {
        permissions: [
          {
            kind: 'permission',
            label: 'read',
            grantee: { scope: 'entity', entityId: CONTRIBUTOR_ID },
          },
          {
            kind: 'permission',
            label: 'write',
            grantee: { scope: 'entity', entityId: CONTRIBUTOR_ID },
          },
        ],
      },
    );
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const conn = await openChangeFeed(t.app, '/changes', { token: TEST_TOKEN });
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'PATCH', `/records/${record.id}`, {
        token,
        body: { contentPatch: { title: 'edited by a contributor' } },
      });
      const [, frame] = await conn.waitForFrames(2);
      const data = frameData(frame);
      expect(data.kind).toBe('changed');
      expect(data.ops).toEqual(['patch']);
      expect(data.recordId).toBe(record.id);
      expect((data.actor as { entityId: string }).entityId).toBe(CONTRIBUTOR_ID);
    } finally {
      await conn.close();
    }
  });

  test('change-feed-associate-frame-carries-associationsAdded', async () => {
    const fixture = changeFeedFixtures.find(
      (f) => f.name === 'change-feed-associate-frame-carries-associationsAdded',
    )!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    const conn = await openChangeFeed(t.app, '/changes', { token: TEST_TOKEN });
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'POST', `/records/${record.id}/associations`, {
        token: TEST_TOKEN,
        body: { kind: 'tag', label: 'starred' },
      });
      const [, frame] = await conn.waitForFrames(2);
      const data = frameData(frame);
      expect(data.ops).toEqual(['associate']);
      // The frame reports the verb without a bump: version and updatedAt
      // are exactly what the record already held.
      expect(data.version).toBe(record.version);
      expect(data.updatedAt).toBe(record.updatedAt.toISOString());
      // The only record of what the call moved — an association is never
      // snapshotted, so a subscriber has no other way to learn it.
      expect(data.associationsAdded).toEqual([{ kind: 'tag', label: 'starred' }]);
    } finally {
      await conn.close();
    }
  });

  test('change-feed-dissociate-frame-carries-associationsRemoved', async () => {
    const fixture = changeFeedFixtures.find(
      (f) => f.name === 'change-feed-dissociate-frame-carries-associationsRemoved',
    )!;
    handled.add(fixture.name);
    const uploaded = await t.ctx.stack.putAttachment(
      new Uint8Array([1, 2, 3]),
      'image/png',
      'embed.png',
    );
    const association = { kind: 'attachment', label: 'embed', fileId: uploaded.content.fileId };
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { ...association, attachmentRecordId: uploaded.id },
    });

    const conn = await openChangeFeed(t.app, '/changes', { token: TEST_TOKEN });
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'POST', `/records/${record.id}/associations/delete`, {
        token: TEST_TOKEN,
        body: association,
      });
      const [, frame] = await conn.waitForFrames(2);
      const data = frameData(frame);
      expect(data.ops).toEqual(['dissociate']);
      expect(data.version).toBe(record.version);
      // Identity only: the annotation is no longer current, and a frame
      // reports what is true now. The journal is where it survives.
      expect(data.associationsRemoved).toEqual([association]);
    } finally {
      await conn.close();
    }
  });

  test('change-feed-deleted-frame-is-not-terminal', async () => {
    const fixture = changeFeedFixtures.find(
      (f) => f.name === 'change-feed-deleted-frame-is-not-terminal',
    )!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    const conn = await openChangeFeed(t.app, '/changes', { token: TEST_TOKEN });
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'DELETE', `/records/${record.id}`, { token: TEST_TOKEN });
      const [, frame] = await conn.waitForFrames(2);
      const data = frameData(frame);
      expect(data.kind).toBe('deleted');
      expect(data.ops).toEqual(['delete']);
      expect(data.recordId).toBe(record.id);
    } finally {
      await conn.close();
    }
  });

  test('change-feed-purged-frame-carries-nothing-about-the-record', async () => {
    const fixture = changeFeedFixtures.find(
      (f) => f.name === 'change-feed-purged-frame-carries-nothing-about-the-record',
    )!;
    handled.add(fixture.name);
    const parent = await t.ctx.stack.create(NOTE_TYPE, { title: 'parent' });
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'to be purged' },
      { parentId: parent.id, entityId: CONTRIBUTOR_ID },
    );
    const conn = await openChangeFeed(t.app, '/changes?include=record', { token: TEST_TOKEN });
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'DELETE', `/records/${record.id}?hard=true`, { token: TEST_TOKEN });
      const [, frame] = await conn.waitForFrames(2);
      const data = frameData(frame);
      expect(data.kind).toBe('purged');
      expect(data.ops).toEqual(['hard-delete']);
      expect(data.recordId).toBe(record.id);
      expect(data.typeId).toBe(NOTE_TYPE);
      expect('record' in data).toBe(false);
      expect('parentId' in data).toBe(false);
      // Owner-acting-alone is the only way to reach hard delete, and a
      // purge stamps nothing on a record that no longer exists — the actor
      // is the requester, never the record's own author (CONTRIBUTOR_ID).
      expect((data.actor as { entityId: string }).entityId).toBe(TEST_ENTITY_ID);
    } finally {
      await conn.close();
    }
  });

  test('change-feed-include-record-carries-the-body', async () => {
    const fixture = changeFeedFixtures.find(
      (f) => f.name === 'change-feed-include-record-carries-the-body',
    )!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'original' });
    const conn = await openChangeFeed(t.app, '/changes?include=record', { token: TEST_TOKEN });
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { contentPatch: { title: 'Updated title' } },
      });
      const [, frame] = await conn.waitForFrames(2);
      const data = frameData(frame);
      const wireRecord = data.record as { id: string; content: { title: string } };
      expect(wireRecord.id).toBe(record.id);
      expect(wireRecord.content).toEqual({ title: 'Updated title' });
    } finally {
      await conn.close();
    }
  });

  test('change-feed-unreadable-record-produces-no-frame', async () => {
    const fixture = changeFeedFixtures.find(
      (f) => f.name === 'change-feed-unreadable-record-produces-no-frame',
    )!;
    handled.add(fixture.name);
    const privateRecord = await t.ctx.stack.create(NOTE_TYPE, { title: 'private' }); // owner-only
    const sharedRecord = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'shared' },
      {
        permissions: [
          {
            kind: 'permission',
            label: 'read',
            grantee: { scope: 'entity', entityId: CONTRIBUTOR_ID },
          },
        ],
      },
    );
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const conn = await openChangeFeed(t.app, '/changes', { token });
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'PATCH', `/records/${privateRecord.id}`, {
        token: TEST_TOKEN,
        body: { contentPatch: { title: 'still private' } },
      });
      await req(t.app, 'PATCH', `/records/${sharedRecord.id}`, {
        token: TEST_TOKEN,
        body: { contentPatch: { title: 'shared, updated' } },
      });
      // Exactly one more frame — the readable record's — proves the
      // private edit produced none rather than merely arriving later.
      const [, frame] = await conn.waitForFrames(2);
      const data = frameData(frame);
      expect(data.recordId).toBe(sharedRecord.id);
    } finally {
      await conn.close();
    }
  });

  test('change-feed-typeid-filter-matches-by-baseid', async () => {
    const fixture = changeFeedFixtures.find(
      (f) => f.name === 'change-feed-typeid-filter-matches-by-baseid',
    )!;
    handled.add(fixture.name);
    const note = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    const comment = await t.ctx.stack.create(COMMENT_TYPE, { body: 'unrelated' });
    const conn = await openChangeFeed(t.app, `/changes?typeId=${encodeURIComponent(NOTE_TYPE)}`, {
      token: TEST_TOKEN,
    });
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'PATCH', `/records/${comment.id}`, {
        token: TEST_TOKEN,
        body: { contentPatch: { body: 'still unrelated' } },
      });
      await req(t.app, 'POST', `/records/${note.id}/migrate`, {
        token: TEST_TOKEN,
        body: { toTypeId: NOTE_TYPE_V2, content: { title: 'Hello', pinned: false } },
      });
      // Exactly one more frame — the migration — proves the unrelated
      // type's edit was filtered out rather than merely arriving later.
      const [, frame] = await conn.waitForFrames(2);
      const data = frameData(frame);
      expect(data.recordId).toBe(note.id);
      expect(data.typeId).toBe(NOTE_TYPE_V2);
      expect(data.ops).toEqual(['migrate']);
    } finally {
      await conn.close();
    }
  });

  test('change-feed-reset-when-no-cursor-is-honored', async () => {
    const fixture = changeFeedFixtures.find(
      (f) => f.name === 'change-feed-reset-when-no-cursor-is-honored',
    )!;
    handled.add(fixture.name);
    // This fixture pins a server advertising `resume: false`, and this
    // server defaults to true, so it runs against a standalone app built
    // with the matching test-only override.
    const resumeDisabledApp = new Hono<AppEnv>();
    resumeDisabledApp.use(authMiddleware(testConfig(t.dbPath).ownerToken, t.ctx));
    resumeDisabledApp.route(
      '/',
      changeRoutes(t.ctx, testConfig(t.dbPath), logger, { resume: false }),
    );
    const conn = await openChangeFeed(resumeDisabledApp, '/', {
      token: TEST_TOKEN,
      headers: { 'Last-Event-ID': 'AA3f1R' },
    });
    try {
      expect(conn.status).toBe(fixture.responseStatus);
      const [ready, reset] = await conn.waitForFrames(2);
      expect(ready.event).toBe('ready');
      expect(reset.event).toBe('reset');
      expect(frameData(reset).reason).toBe('not_supported');
    } finally {
      await conn.close();
    }
  });

  test('change-feed-unlist-frame-is-a-deleted-kind', async () => {
    const fixture = changeFeedFixtures.find(
      (f) => f.name === 'change-feed-unlist-frame-is-a-deleted-kind',
    )!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    const conn = await openChangeFeed(t.app, '/changes', { token: TEST_TOKEN });
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { unlisted: true },
      });
      const [, frame] = await conn.waitForFrames(2);
      const data = frameData(frame);
      expect(data.kind).toBe('deleted');
      expect(data.ops).toEqual(['unlist']);
      expect(data.recordId).toBe(record.id);
    } finally {
      await conn.close();
    }
  });

  test('change-feed-list-frame-is-a-changed-kind', async () => {
    const fixture = changeFeedFixtures.find(
      (f) => f.name === 'change-feed-list-frame-is-a-changed-kind',
    )!;
    handled.add(fixture.name);
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' });
    await t.ctx.stack.mutate(record.id, { unlisted: true });
    const conn = await openChangeFeed(t.app, '/changes', { token: TEST_TOKEN });
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { unlisted: false },
      });
      const [, frame] = await conn.waitForFrames(2);
      const data = frameData(frame);
      expect(data.kind).toBe('changed');
      expect(data.ops).toEqual(['list']);
      expect(data.recordId).toBe(record.id);
    } finally {
      await conn.close();
    }
  });

  test('change-feed-unlisted-record-produces-no-frame-by-default', async () => {
    const fixture = changeFeedFixtures.find(
      (f) => f.name === 'change-feed-unlisted-record-produces-no-frame-by-default',
    )!;
    handled.add(fixture.name);
    const unlistedRecord = await t.ctx.stack.create(NOTE_TYPE, { title: 'Unlisted' });
    await t.ctx.stack.mutate(unlistedRecord.id, { unlisted: true });
    const visibleRecord = await t.ctx.stack.create(NOTE_TYPE, { title: 'Visible' });
    const conn = await openChangeFeed(t.app, '/changes', { token: TEST_TOKEN });
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'PATCH', `/records/${unlistedRecord.id}`, {
        token: TEST_TOKEN,
        body: { contentPatch: { title: 'Edited while unlisted' } },
      });
      await req(t.app, 'PATCH', `/records/${visibleRecord.id}`, {
        token: TEST_TOKEN,
        body: { contentPatch: { title: 'Edited, visible' } },
      });
      // Exactly one more frame — the visible record's — proves the
      // unlisted edit produced none rather than merely arriving later.
      const [, frame] = await conn.waitForFrames(2);
      const data = frameData(frame);
      expect(data.recordId).toBe(visibleRecord.id);
    } finally {
      await conn.close();
    }
  });

  test('change-feed-reparent-reaches-the-container-a-record-left', async () => {
    const fixture = changeFeedFixtures.find(
      (f) => f.name === 'change-feed-reparent-reaches-the-container-a-record-left',
    )!;
    handled.add(fixture.name);

    const origin = await t.ctx.stack.create(NOTE_TYPE, { title: 'Origin' });
    const destination = await t.ctx.stack.create(NOTE_TYPE, { title: 'Destination' });
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello' }, { parentId: origin.id });

    // Filtered on the container the record is about to leave: the record's
    // post-change state names only the destination, so a subscriber watching
    // the origin hears about the departure only because a reparent is
    // matched against both sides of the move.
    const conn = await openChangeFeed(t.app, `/changes?parentId=${origin.id}`, {
      token: TEST_TOKEN,
    });
    try {
      await conn.waitForFrames(1); // ready
      await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { parentId: destination.id },
      });
      const [, frame] = await conn.waitForFrames(2);
      const data = frameData(frame);
      // Still there and still readable — only its container moved.
      expect(data.kind).toBe('changed');
      expect(data.ops).toEqual(['reparent']);
      expect(data.recordId).toBe(record.id);
      // The frame carries the destination, as every frame carries the
      // record's state at the moment of the change.
      expect(data.parentId).toBe(destination.id);
    } finally {
      await conn.close();
    }
  });

  test('coverage', () => {
    assertCoverage(
      changeFeedFixtures.map((f) => f.name),
      handled,
      SKIPPED,
    );
  });
});

describe('changeFeed sequence fixtures', () => {
  const handled = new Set<string>();

  test('change-feed-resume-delivers-what-was-missed', async () => {
    const fixture = changeFeedSequenceFixtures.find(
      (f) => f.name === 'change-feed-resume-delivers-what-was-missed',
    )!;
    handled.add(fixture.name);

    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'original' });

    // Step 1: connect fresh, see one change, retain the id it carried.
    const first = await openChangeFeed(t.app, fixture.steps[0]!.path, { token: TEST_TOKEN });
    let lastEventId: string;
    try {
      expect(first.status).toBe(fixture.steps[0]!.responseStatus);
      const [ready] = await first.waitForFrames(1);
      expect(ready.event).toBe('ready');
      expect(frameData(ready).seq).toMatch(SEQ_PATTERN);
      await req(t.app, 'PATCH', `/records/${record.id}`, {
        token: TEST_TOKEN,
        body: { contentPatch: { title: 'first' } },
      });
      const [, changeFrame] = await first.waitForFrames(2);
      expect(changeFrame.event).toBe('record');
      expect(changeFrame.id).toMatch(SEQ_PATTERN);
      lastEventId = changeFrame.id!;
    } finally {
      await first.close();
    }

    // A second edit lands with nobody listening — the buffer (retained
    // past disconnect) keeps collecting on its own.
    await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: { contentPatch: { title: 'second' } },
    });

    // Step 2: reconnect presenting the last id seen. ready still leads,
    // and exactly the missed change is replayed — never the frame the
    // first connection already had.
    const second = await openChangeFeed(t.app, fixture.steps[1]!.path, {
      token: TEST_TOKEN,
      headers: { 'Last-Event-ID': lastEventId },
    });
    try {
      expect(second.status).toBe(fixture.steps[1]!.responseStatus);
      const [ready, replayed] = await second.waitForFrames(2);
      expect(ready.event).toBe('ready');
      expect(frameData(ready).seq).toMatch(SEQ_PATTERN);
      expect(replayed.event).toBe('record');
      expect(replayed.id).toMatch(SEQ_PATTERN);
      expect(replayed.id).not.toBe(lastEventId);
      const data = frameData(replayed);
      expect(data.recordId).toBe(record.id);
      expect(data.version).toBe(3);
      // Nothing else arrives — confirms the already-delivered frame from
      // step 1 wasn't replayed a second time.
      await expect(second.waitForFrames(3, 300)).rejects.toThrow();
    } finally {
      await second.close();
    }
  });

  test('change-feed-reset-rather-than-resume-from-wherever-it-can', async () => {
    const fixture = changeFeedSequenceFixtures.find(
      (f) => f.name === 'change-feed-reset-rather-than-resume-from-wherever-it-can',
    )!;
    handled.add(fixture.name);

    // A buffer past its retention window is unrecognized on reconnect —
    // forced deterministically with a near-zero window rather than
    // waiting out the real (5-minute) default.
    const config = testConfig(t.dbPath);
    const resumeApp = new Hono<AppEnv>();
    resumeApp.use(authMiddleware(config.ownerToken, t.ctx));
    resumeApp.route(
      '/changes',
      changeRoutes(t.ctx, config, logger, { resume: true, resumeRetentionMs: 10 }),
    );

    const first = await openChangeFeed(resumeApp, fixture.steps[0]!.path, { token: TEST_TOKEN });
    let headCursor: string;
    try {
      expect(first.status).toBe(fixture.steps[0]!.responseStatus);
      const [ready] = await first.waitForFrames(1);
      expect(ready.event).toBe('ready');
      headCursor = frameData(ready).seq as string;
      expect(headCursor).toMatch(SEQ_PATTERN);
    } finally {
      await first.close();
    }

    // Long enough past the deliberately tiny retention window for the
    // buffer to have been dropped.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await openChangeFeed(resumeApp, fixture.steps[1]!.path, {
      token: TEST_TOKEN,
      headers: { 'Last-Event-ID': headCursor },
    });
    try {
      expect(second.status).toBe(fixture.steps[1]!.responseStatus);
      const [ready, reset] = await second.waitForFrames(2);
      expect(ready.event).toBe('ready');
      // A fresh buffer, so a fresh (different) head cursor.
      expect(frameData(ready).seq).toMatch(SEQ_PATTERN);
      expect(frameData(ready).seq).not.toBe(headCursor);
      expect(reset.event).toBe('reset');
      expect(frameData(reset).reason).toBe('cursor_expired');
    } finally {
      await second.close();
    }
  });

  test('coverage', () => {
    assertCoverage(
      changeFeedSequenceFixtures.map((f) => f.name),
      handled,
      new Set(),
    );
  });
});

// -------------------------------------------------------
// Auth: DID challenge-response handshake
// -------------------------------------------------------

describe('auth handshake fixtures', () => {
  // Fixture-carried signatures are real Ed25519 signatures over one exact,
  // fixed nonce value — this server generates its own random nonces via
  // POST /auth/challenge, so authTokenFixtures/authSequenceFixtures seed
  // that exact value directly into the nonce store rather than going
  // through the challenge endpoint.
  function seedFixtureNonce(ttlMs = 5 * 60 * 1000) {
    t.ctx.nonces.seedForTesting(AUTH_FIXTURE_NONCE, AUTH_FIXTURE_DID, new Date(Date.now() + ttlMs));
  }

  const handled = new Set<string>();

  test('auth-challenge-issues-nonce', async () => {
    const fixture = authChallengeFixtures.find((f) => f.name === 'auth-challenge-issues-nonce')!;
    handled.add(fixture.name);
    const { status, data } = await req(t.app, fixture.method, fixture.path, {
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    const d = data as { nonce: string; expiresAt: string };
    // The nonce itself is server-generated and random — not compared
    // literally — but must be base64url, per the same charset constraint
    // buildAuthChallengePayload enforces on the signed payload.
    expect(d.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(typeof d.expiresAt).toBe('string');
    expect(new Date(d.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  test('auth-challenge-rejects-malformed-did', async () => {
    const fixture = authChallengeFixtures.find(
      (f) => f.name === 'auth-challenge-rejects-malformed-did',
    )!;
    handled.add(fixture.name);
    const { status, data } = await req(t.app, fixture.method, fixture.path, {
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    expect((data as { error: { code: string } }).error.code).toBe('invalid_did');
  });

  test('auth-token-issues-bearer-token', async () => {
    const fixture = authTokenFixtures.find((f) => f.name === 'auth-token-issues-bearer-token')!;
    handled.add(fixture.name);
    seedFixtureNonce();
    const { status, data } = await req(t.app, fixture.method, fixture.path, {
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    const d = data as { token: string; principalId: string; subjectId: string };
    expect(typeof d.token).toBe('string');
    expect(d.principalId).toBe(AUTH_FIXTURE_DID);
    expect(d.subjectId).toBe(AUTH_FIXTURE_DID);
  });

  test('auth-token-rejects-foreign-signature', async () => {
    const fixture = authTokenFixtures.find(
      (f) => f.name === 'auth-token-rejects-foreign-signature',
    )!;
    handled.add(fixture.name);
    seedFixtureNonce();
    const { status, data } = await req(t.app, fixture.method, fixture.path, {
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    expect((data as { error: { code: string } }).error.code).toBe('invalid_signature');
  });

  test('auth-token-rejects-expired-nonce', async () => {
    const fixture = authTokenFixtures.find((f) => f.name === 'auth-token-rejects-expired-nonce')!;
    handled.add(fixture.name);
    seedFixtureNonce(-1000); // already expired
    const { status, data } = await req(t.app, fixture.method, fixture.path, {
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    expect((data as { error: { code: string } }).error.code).toBe('expired_nonce');
  });

  test('auth-token-rejects-nonce-issued-to-another-did', async () => {
    const fixture = authTokenFixtures.find(
      (f) => f.name === 'auth-token-rejects-nonce-issued-to-another-did',
    )!;
    handled.add(fixture.name);
    // Nonce is bound to AUTH_FIXTURE_DID; the request signs as a different,
    // valid DID with its own valid signature — still refused, since the
    // nonce belongs to the DID it was issued for.
    seedFixtureNonce();
    const { status, data } = await req(t.app, fixture.method, fixture.path, {
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    expect((data as { error: { code: string } }).error.code).toBe('unknown_nonce');
  });

  test('auth-token-rejects-unknown-nonce', async () => {
    const fixture = authTokenFixtures.find((f) => f.name === 'auth-token-rejects-unknown-nonce')!;
    handled.add(fixture.name);
    // No seeding — this fixture's nonce was never issued.
    const { status, data } = await req(t.app, fixture.method, fixture.path, {
      body: fixture.requestBody,
    });
    expect(status).toBe(fixture.responseStatus);
    expect((data as { error: { code: string } }).error.code).toBe('unknown_nonce');
  });

  test('auth-nonce-is-single-use', async () => {
    const sequence = authSequenceFixtures.find((f) => f.name === 'auth-nonce-is-single-use')!;
    handled.add(sequence.name);
    seedFixtureNonce();
    for (const step of sequence.steps) {
      const { status, data } = await req(t.app, step.method, step.path, {
        body: step.requestBody,
      });
      expect(status).toBe(step.responseStatus);
      const expected = step.responseBody as { error?: { code: string } } | undefined;
      if (expected?.error) {
        expect((data as { error: { code: string } }).error.code).toBe(expected.error.code);
      }
    }
  });

  // Last in the block: `handled` is only complete once every test above has
  // run, and the sequence fixtures are dispatched at the end.
  test('coverage: authChallengeFixtures + authTokenFixtures + authSequenceFixtures', () => {
    assertCoverage(
      [...authChallengeFixtures, ...authTokenFixtures, ...authSequenceFixtures].map((f) => f.name),
      handled,
      new Set(),
    );
  });
});

// -------------------------------------------------------
// Records: the unlisted change-set key
// -------------------------------------------------------

describe('unlisted change fixtures', () => {
  const handled = new Set<string>();

  // Run together against one seeded record, same as the versions block
  // below — set-unlisted-false-relists assumes set-unlisted-true already
  // ran (its own description says so).
  test('set-unlisted-true then set-unlisted-false-relists', async () => {
    const trueFixture = unlistedChangeFixtures.find((f) => f.name === 'set-unlisted-true')!;
    const falseFixture = unlistedChangeFixtures.find(
      (f) => f.name === 'set-unlisted-false-relists',
    )!;
    handled.add(trueFixture.name);
    handled.add(falseFixture.name);

    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello', body: 'World' });

    const unlisted = await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: trueFixture.requestBody,
    });
    expect(unlisted.status).toBe(trueFixture.responseStatus);
    expect((unlisted.data as WireRecord).unlistedAt).toBeDefined();

    // Excluded from an unfiltered query, same posture as a soft-deleted record.
    const queried = await req(t.app, 'GET', '/records', { token: TEST_TOKEN });
    expect(
      (queried.data as { records: WireRecord[] }).records.some((r) => r.id === record.id),
    ).toBe(false);

    const relisted = await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: falseFixture.requestBody,
    });
    expect(relisted.status).toBe(falseFixture.responseStatus);
    expect((relisted.data as WireRecord).unlistedAt).toBeUndefined();
  });

  test('coverage', () => {
    assertCoverage(
      unlistedChangeFixtures.map((f) => f.name),
      handled,
      new Set(),
    );
  });
});

// -------------------------------------------------------
// Records: the parentId change-set key
// -------------------------------------------------------

describe('parent change fixtures', () => {
  const handled = new Set<string>();

  // Run together against one seeded record: the null fixture moves a
  // record back to the root, which only means anything once something
  // has moved it off the root.
  test('set-parent-moves-a-record-into-a-container then back to the root', async () => {
    const intoFixture = parentChangeFixtures.find(
      (f) => f.name === 'set-parent-moves-a-record-into-a-container',
    )!;
    const rootFixture = parentChangeFixtures.find(
      (f) => f.name === 'set-parent-null-moves-a-record-to-the-root',
    )!;
    handled.add(intoFixture.name);
    handled.add(rootFixture.name);

    // The destination has to exist: a caller-named parentId is checked for
    // format and then for existence, so the fixture's own literal id would
    // answer 409 here rather than moving anything.
    const container = await t.ctx.stack.create(NOTE_TYPE, { title: 'Container' });
    const record = await t.ctx.stack.create(NOTE_TYPE, { title: 'Hello', body: 'World' });

    const moved = await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: { ...intoFixture.requestBody, parentId: container.id },
    });
    expect(moved.status).toBe(intoFixture.responseStatus);
    expect((moved.data as WireRecord).parentId).toBe(container.id);
    // A move touches containment and nothing else.
    expect((moved.data as WireRecord).content).toEqual({ title: 'Hello', body: 'World' });

    const toRoot = await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: rootFixture.requestBody,
    });
    expect(toRoot.status).toBe(rootFixture.responseStatus);
    // State spells the root by omission, where the input spelled it null.
    expect((toRoot.data as WireRecord).parentId).toBeUndefined();
  });

  test('coverage', () => {
    assertCoverage(
      parentChangeFixtures.map((f) => f.name),
      handled,
      new Set(),
    );
  });
});

// -------------------------------------------------------
// Attachments: download
// -------------------------------------------------------

describe('attachmentDownload fixtures', () => {
  const handled = new Set<string>();

  function find(name: string) {
    const fixture = attachmentDownloadFixtures.find((f) => f.name === name)!;
    handled.add(name);
    return fixture;
  }

  // Fixture paths embed the fixture authors' own fileIds — sha256 hashes of
  // bytes this harness never had. Like every other server-generated value
  // in this file (record ids, cursors), they're illustrative rather than
  // literal: each dispatch below uploads its own bytes for a real fileId
  // and checks the fixture's pinned response headers against that, rather
  // than replaying the fixture's path verbatim.
  async function uploadFile(mimeType: string): Promise<string> {
    const record = await t.ctx.stack.putAttachment(
      new TextEncoder().encode(`conformance-fixture-bytes:${mimeType}`),
      mimeType,
    );
    return (record.content as { fileId: string }).fileId;
  }

  function queryFrom(path: string): string {
    const i = path.indexOf('?');
    return i === -1 ? '' : path.slice(i);
  }

  async function dispatch(
    fixture: (typeof attachmentDownloadFixtures)[number],
    fileId: string,
  ): Promise<void> {
    const res = await t.app.request(`/attachments/${fileId}${queryFrom(fixture.path)}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(fixture.responseHeaders)) {
      expect(res.headers.get(name)).toBe(value);
    }
  }

  test('attachment-download-contenttype-param-safe-passes-through', async () => {
    const fixture = find('attachment-download-contenttype-param-safe-passes-through');
    await dispatch(fixture, await uploadFile('application/octet-stream'));
  });

  test('attachment-download-contenttype-param-dangerous-forced', async () => {
    const fixture = find('attachment-download-contenttype-param-dangerous-forced');
    await dispatch(fixture, await uploadFile('application/octet-stream'));
  });

  test('attachment-download-filename-extension-safe-passes-through', async () => {
    const fixture = find('attachment-download-filename-extension-safe-passes-through');
    await dispatch(fixture, await uploadFile('application/octet-stream'));
  });

  test('attachment-download-filename-extension-dangerous-forced', async () => {
    const fixture = find('attachment-download-filename-extension-dangerous-forced');
    await dispatch(fixture, await uploadFile('application/octet-stream'));
  });

  test('attachment-download-stored-mimetype-safe-passes-through', async () => {
    const fixture = find('attachment-download-stored-mimetype-safe-passes-through');
    await dispatch(fixture, await uploadFile('image/png'));
  });

  test('attachment-download-stored-mimetype-dangerous-forced', async () => {
    const fixture = find('attachment-download-stored-mimetype-dangerous-forced');
    await dispatch(fixture, await uploadFile('text/html'));
  });

  test('attachment-download-no-metadata-defaults-to-octet-stream', async () => {
    const fixture = find('attachment-download-no-metadata-defaults-to-octet-stream');
    // Raw bytes with no _attachment@1 record at all — bypasses
    // Stack.putAttachment (which creates the record atomically) by writing
    // straight through the adapter.
    const fileId = await t.ctx.adapter.putAttachment(new TextEncoder().encode('orphan-bytes'));
    await dispatch(fixture, fileId);
  });

  test('coverage', () => {
    assertCoverage(
      attachmentDownloadFixtures.map((f) => f.name),
      handled,
      new Set(),
    );
  });
});

// -------------------------------------------------------
// Attachments: upload
// -------------------------------------------------------

describe('attachmentUpload fixtures', () => {
  const handled = new Set<string>();

  function find(name: string) {
    const fixture = attachmentUploadFixtures.find((f) => f.name === name)!;
    handled.add(name);
    return fixture;
  }

  async function dispatch(
    fixture: (typeof attachmentUploadFixtures)[number],
    opts: { token?: string; app?: TestApp['app'] } = {},
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const path = fixture.appId
      ? `/attachments?appId=${encodeURIComponent(fixture.appId)}`
      : '/attachments';
    const headers: Record<string, string> = { ...fixture.requestHeaders };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    const res = await (opts.app ?? t.app).request(path, {
      method: 'POST',
      headers,
      body: new Uint8Array(fixture.requestBodyBytes),
    });
    const data = JSON.parse(await res.text()) as Record<string, unknown>;
    return { status: res.status, data };
  }

  test('attachment-upload-creates-metadata-record', async () => {
    const fixture = find('attachment-upload-creates-metadata-record');
    const { status, data } = await dispatch(fixture, { token: TEST_TOKEN });
    expect(status).toBe(fixture.responseStatus);
    const expected = fixture.responseBody as { content: Record<string, unknown>; version: number };
    expect(data.content).toEqual(expected.content);
    expect(data.typeId).toBe('_attachment@1');
    expect(data.version).toBe(expected.version);
  });

  test('attachment-upload-carries-appid-query-param', async () => {
    const fixture = find('attachment-upload-carries-appid-query-param');
    const { status, data } = await dispatch(fixture, { token: TEST_TOKEN });
    expect(status).toBe(fixture.responseStatus);
    const expected = fixture.responseBody as { content: Record<string, unknown>; version: number };
    expect(data.content).toEqual(expected.content);
    expect(data.appId).toBe(fixture.appId);
    expect(data.version).toBe(expected.version);
  });

  test('attachment-upload-no-content-type-defaults-to-octet-stream', async () => {
    const fixture = find('attachment-upload-no-content-type-defaults-to-octet-stream');
    const { status, data } = await dispatch(fixture, { token: TEST_TOKEN });
    expect(status).toBe(fixture.responseStatus);
    const expected = fixture.responseBody as { content: Record<string, unknown>; version: number };
    expect(data.content).toEqual(expected.content);
    expect(data.version).toBe(expected.version);
  });

  test('attachment-upload-non-owner-without-create-grant-forbidden', async () => {
    const fixture = find('attachment-upload-non-owner-without-create-grant-forbidden');
    const { token } = await t.ctx.adapter.createToken(CONTRIBUTOR_ID);
    const { status, data } = await dispatch(fixture, { token });
    expect(status).toBe(fixture.responseStatus);
    const expected = fixture.responseBody as { error: { code: string } };
    expect((data as { error: { code: string } }).error.code).toBe(expected.error.code);
  });

  test('attachment-upload-payload-too-large', async () => {
    const fixture = find('attachment-upload-payload-too-large');
    // The fixture's own body doesn't exceed any real limit — per its own
    // description it stands in for one that does, pinning the error shape
    // rather than a specific size — so this dispatches against a server
    // configured with a ceiling below the fixture's body length instead.
    const smallConfig = { ...testConfig(t.dbPath), maxAttachmentBytes: 2 };
    const smallApp = createApp(t.ctx, smallConfig, logger);
    const { status, data } = await dispatch(fixture, { token: TEST_TOKEN, app: smallApp });
    expect(status).toBe(fixture.responseStatus);
    const expected = fixture.responseBody as { error: { code: string } };
    expect((data as { error: { code: string } }).error.code).toBe(expected.error.code);
  });

  test('coverage', () => {
    assertCoverage(
      attachmentUploadFixtures.map((f) => f.name),
      handled,
      new Set(),
    );
  });
});

// -------------------------------------------------------
// The whole package
// -------------------------------------------------------

/**
 * Every fixture the package exports reaches a block above.
 *
 * Each block's own coverage test pins its own array, which leaves one gap
 * open by construction: an array this file never imports is guarded by
 * nothing, so core can add a whole block and every test here still passes.
 * This closes it by discovering the arrays rather than listing them —
 * anything shaped like a fixture set is found whether or not a block reads
 * it, and an unhandled one names itself in the failure.
 */
describe('fixture package coverage', () => {
  /** An exported array of fixtures, told from the package's other exports by shape. */
  function isFixtureArray(value: unknown): value is Array<{ name: string }> {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { name?: unknown }).name === 'string' &&
          ('method' in entry || 'steps' in entry),
      )
    );
  }

  test('every exported fixture array is dispatched by a block above', () => {
    const missing: string[] = [];
    for (const [exportName, value] of Object.entries(conformanceFixtures)) {
      // A union of the arrays beside it: every name in it is already
      // reported under the export that owns it.
      if (exportName === 'allConformanceFixtures') continue;
      if (!isFixtureArray(value)) continue;
      for (const fixture of value) {
        if (!accountedFor.has(fixture.name)) missing.push(`${exportName}: ${fixture.name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
