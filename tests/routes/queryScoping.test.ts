/**
 * What a query returns, and to whom.
 *
 * Both query endpoints run on `QueryWorkerPool` — a worker thread with its
 * own connection to the same database — so a grant's reach is re-derived
 * there rather than inherited from the request thread that accepted the
 * call. Nothing else in this suite crosses that boundary: the route tests
 * beside this one exercise by-id reads and writes, which stay on the main
 * thread, and core's own tests exercise `ScopedStack` in one process. So
 * the assertions here are about two things at once — the access rules, and
 * that the worker resolves them from storage on every call.
 *
 * Revocation is the direction that matters most: a cached grant set on the
 * worker would answer a query the owner has already withdrawn, and no
 * by-id test would notice.
 *
 * See src/lib/queryWorker/pool.ts, docs/spec/access-control.md
 * § Type-level grants and docs/spec/wire-format.md § Bounding query cost.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildTestApp,
  req,
  TEST_TOKEN,
  TEST_ENTITY_ID,
  OTHER_ENTITY_ID,
  type TestApp,
} from '../setup.js';
import type { StackRecord } from '@haverstack/core';

const NOTE_TYPE = 'com.example/note@1';
const GRANT_TYPE = '_grant@1';
const GROUP_TYPE = '_group@1';
/** A third party, so a `-own` grant has someone else's record to not reach. */
const THIRD_ENTITY_ID = 'did:key:third-entity-id-00000003';

let t: TestApp;
beforeEach(async () => {
  t = await buildTestApp();
  await t.ctx.stack.defineType({
    id: NOTE_TYPE,
    name: 'Note',
    schema: {
      title: { kind: 'string', required: true },
    },
  });
});
afterEach(async () => {
  await t.cleanup();
});

/** A token the auth middleware will resolve to an undelegated session for `did`. */
async function tokenFor(did: string): Promise<string> {
  const { token } = await t.ctx.tokens.createToken({ subjectId: did });
  return token;
}

/** The ids a requester's query answers with, via URL params. */
async function queryIds(
  token: string | undefined,
  path = `/records?typeId=${encodeURIComponent(NOTE_TYPE)}`,
) {
  const { status, data } = await req(t.app, 'GET', path, { ...(token && { token }) });
  expect(status).toBe(200);
  return (data as { records: StackRecord[] }).records.map((r) => r.id).sort();
}

/** The same question through the content-filter endpoint, which is a different parser. */
async function postQueryIds(
  token: string | undefined,
  filter: Record<string, unknown> = { typeId: NOTE_TYPE },
) {
  const { status, data } = await req(t.app, 'POST', '/records/query', {
    ...(token && { token }),
    body: { filter },
  });
  expect(status).toBe(200);
  return (data as { records: StackRecord[] }).records.map((r) => r.id).sort();
}

/** One note per author, so every scoping question has a record that must not match. */
async function seedNotes() {
  const owner = await t.ctx.stack.create(
    NOTE_TYPE,
    { title: 'owner' },
    { createdBy: { subjectId: TEST_ENTITY_ID } },
  );
  const other = await t.ctx.stack.create(
    NOTE_TYPE,
    { title: 'other' },
    { createdBy: { subjectId: OTHER_ENTITY_ID } },
  );
  const third = await t.ctx.stack.create(
    NOTE_TYPE,
    { title: 'third' },
    { createdBy: { subjectId: THIRD_ENTITY_ID } },
  );
  return { owner, other, third };
}

describe('query scoping across the worker boundary', () => {
  it('answers a read-own grantee with their own records and nobody else’s', async () => {
    const { owner, other, third } = await seedNotes();
    await t.ctx.stack.grantType(NOTE_TYPE, {
      actions: ['read-own'],
      grantee: { kind: 'entity', entityId: OTHER_ENTITY_ID },
    });
    const token = await tokenFor(OTHER_ENTITY_ID);

    expect(await queryIds(token)).toEqual([other.id]);
    expect(await queryIds(token)).not.toContain(owner.id);
    expect(await queryIds(token)).not.toContain(third.id);
  });

  it('widens to every record of the type under read-any', async () => {
    const { owner, other, third } = await seedNotes();
    await t.ctx.stack.grantType(NOTE_TYPE, {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: OTHER_ENTITY_ID },
    });
    const token = await tokenFor(OTHER_ENTITY_ID);

    expect(await queryIds(token)).toEqual([owner.id, other.id, third.id].sort());
  });

  it('stops answering on the next query once the grant is withdrawn', async () => {
    const { owner } = await seedNotes();
    const grantRecord = await t.ctx.stack.grantType(NOTE_TYPE, {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: OTHER_ENTITY_ID },
    });
    const token = await tokenFor(OTHER_ENTITY_ID);
    expect(await queryIds(token)).toContain(owner.id);

    // Withdrawn on the request thread; the worker holds its own connection
    // and must see it on the very next call.
    await req(t.app, 'DELETE', `/records/${grantRecord!.id}`, { token: TEST_TOKEN });
    expect(await queryIds(token)).not.toContain(owner.id);
  });

  it('confers again once the withdrawn grant is undeleted', async () => {
    const { owner } = await seedNotes();
    const grantRecord = await t.ctx.stack.grantType(NOTE_TYPE, {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: OTHER_ENTITY_ID },
    });
    const token = await tokenFor(OTHER_ENTITY_ID);
    await req(t.app, 'DELETE', `/records/${grantRecord!.id}`, { token: TEST_TOKEN });
    expect(await queryIds(token)).not.toContain(owner.id);

    await req(t.app, 'POST', `/records/${grantRecord!.id}/undelete`, { token: TEST_TOKEN });
    expect(await queryIds(token)).toContain(owner.id);
  });

  it('withholds a deleted group’s roster from a group-targeted grant', async () => {
    const { owner } = await seedNotes();
    const group = await t.ctx.stack.create(
      GROUP_TYPE,
      { name: 'Editors' },
      {
        associations: [
          {
            kind: 'relationship',
            label: 'admin',
            target: { kind: 'entity', entityId: TEST_ENTITY_ID },
          },
          {
            kind: 'relationship',
            label: 'member',
            target: { kind: 'entity', entityId: OTHER_ENTITY_ID },
          },
        ],
      },
    );
    await t.ctx.stack.grantType(NOTE_TYPE, {
      actions: ['read-any'],
      grantee: { kind: 'group', groupId: group.id, role: 'member' },
    });
    const token = await tokenFor(OTHER_ENTITY_ID);
    expect(await queryIds(token)).toContain(owner.id);

    // Deleting the Group is the withdrawal an admin believes it is, and the
    // roster resolver on the worker has to read the tombstone as naming
    // nobody. See docs/spec/identity.md § Group.
    await req(t.app, 'DELETE', `/records/${group.id}`, { token: TEST_TOKEN });
    expect(await queryIds(token)).not.toContain(owner.id);
  });

  it('narrows immediately when a member leaves the roster', async () => {
    const { owner } = await seedNotes();
    const group = await t.ctx.stack.create(
      GROUP_TYPE,
      { name: 'Editors' },
      {
        associations: [
          {
            kind: 'relationship',
            label: 'admin',
            target: { kind: 'entity', entityId: TEST_ENTITY_ID },
          },
          {
            kind: 'relationship',
            label: 'member',
            target: { kind: 'entity', entityId: OTHER_ENTITY_ID },
          },
        ],
      },
    );
    await t.ctx.stack.grantType(NOTE_TYPE, {
      actions: ['read-any'],
      grantee: { kind: 'group', groupId: group.id, role: 'member' },
    });
    const token = await tokenFor(OTHER_ENTITY_ID);
    expect(await queryIds(token)).toContain(owner.id);

    await req(t.app, 'POST', `/records/${group.id}/associations/delete`, {
      token: TEST_TOKEN,
      body: {
        kind: 'relationship',
        label: 'member',
        target: { kind: 'entity', entityId: OTHER_ENTITY_ID },
      },
    });
    expect(await queryIds(token)).not.toContain(owner.id);
  });

  it('never enumerates a _grant record for a grantee', async () => {
    await seedNotes();
    await t.ctx.stack.grantType(NOTE_TYPE, {
      actions: ['read-any'],
      grantee: { kind: 'entity', entityId: OTHER_ENTITY_ID },
    });
    const token = await tokenFor(OTHER_ENTITY_ID);

    // A _grant carries no entityId and no permissions, so no grant on
    // another type — and no `-own` reading — reaches one.
    expect(await queryIds(token, `/records?typeId=${encodeURIComponent(GRANT_TYPE)}`)).toEqual([]);
    expect(
      (await queryIds(TEST_TOKEN, `/records?typeId=${encodeURIComponent(GRANT_TYPE)}`)).length,
    ).toBeGreaterThan(0);
  });

  it('answers both query encodings with the same set', async () => {
    await seedNotes();
    await t.ctx.stack.grantType(NOTE_TYPE, {
      actions: ['read-own'],
      grantee: { kind: 'entity', entityId: OTHER_ENTITY_ID },
    });
    const token = await tokenFor(OTHER_ENTITY_ID);

    // One scoping rule, two parsers: a content filter must not widen what
    // the URL-param encoding of the same question returns.
    expect(await postQueryIds(token)).toEqual(await queryIds(token));
  });

  it('answers an anonymous requester with world-readable records only', async () => {
    const { owner, other } = await seedNotes();
    await t.ctx.stack.grantAccess(owner.id, { kind: 'anyone', label: 'read' });

    expect(await queryIds(undefined)).toEqual([owner.id]);
    expect(await queryIds(undefined)).not.toContain(other.id);
  });

  it('does not let a default grant reach an anonymous requester', async () => {
    await seedNotes();
    // `{ kind: 'authenticated' }` is every entity that turned up with a DID,
    // which is never the anonymous view.
    await t.ctx.stack.grantType(NOTE_TYPE, {
      actions: ['read-any'],
      grantee: { kind: 'authenticated' },
    });

    expect(await queryIds(undefined)).toEqual([]);
    expect((await queryIds(await tokenFor(THIRD_ENTITY_ID))).length).toBe(3);
  });
});
