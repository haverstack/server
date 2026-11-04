/**
 * A hosted stack copied out over the wire: @haverstack/adapter-conformance's
 * stack copy suite, with this server's own store as the source and
 * APIAdapter, opened as the owner, as what the copy reads it through. The
 * past is written into the store in process, with the full trust no wire
 * write has, and the copy must arrive as that store holds it: soft-deleted
 * and unlisted Records, every version and journal entry, Types and every
 * blob. See core's docs/spec/portability.md § Copying a stack.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCopyConformance } from '@haverstack/adapter-conformance';
import { APIAdapter } from '@haverstack/adapter-api';
import { LocalAdapter } from '@haverstack/adapter-local';
import { StackConflictError } from '@haverstack/core';
import { copyStack, resolveQuery } from '@haverstack/core/adapter';
import type { CreateStore, StackAdapter } from '@haverstack/core/adapter';
import { MAX_PAGE } from '../../src/lib/page.js';
import {
  startTestServer,
  OTHER_ENTITY_ID,
  TEST_TOKEN,
  type TestServer,
} from '../../src/testing.js';

const servers = new Map<StackAdapter, TestServer>();
const dirs = new Map<StackAdapter, string>();

const hosted: CreateStore = async (seed) => {
  const server = await startTestServer(seed);
  servers.set(server.ctx.adapter, server);
  return server.ctx.adapter;
};

const local: CreateStore = async (seed) => {
  const dir = join(tmpdir(), `haverstack-copy-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  const adapter = await LocalAdapter.open({
    path: join(dir, 'stack.db'),
    seed,
  });
  dirs.set(adapter, dir);
  return adapter;
};

runCopyConformance({
  name: 'a hosted stack, read through APIAdapter, into LocalAdapter',
  create: local,
  source: hosted,
  readThrough: (store) =>
    APIAdapter.open({
      url: servers.get(store)!.url,
      token: TEST_TOKEN,
      ownerEntityId: store.ownerEntityId,
    }),
  close: async (adapter) => {
    const server = servers.get(adapter);
    servers.delete(adapter);
    if (server) return server.close();
    await adapter.close?.();
    const dir = dirs.get(adapter);
    dirs.delete(adapter);
    if (dir) rmSync(dir, { recursive: true, force: true });
  },
});

/**
 * Past what the suite above holds: a copy out of this server refuses when
 * the stack is written while it reads, and follows every cursor when the
 * stack is larger than a page. Each test copies through APIAdapter into a
 * new LocalAdapter, as an owner leaving the host would.
 */
describe('copying a hosted stack out through APIAdapter', () => {
  const NOTE = 'com.example.copy/note@1';
  let server: TestServer;
  let source: APIAdapter;

  beforeEach(async () => {
    server = await startTestServer();
    await server.ctx.stack.defineType({
      id: NOTE,
      name: 'Note',
      schema: { n: { kind: 'number' } },
    });
    source = await APIAdapter.open({ url: server.url, token: TEST_TOKEN });
  });
  afterEach(async () => {
    await server.close();
    for (const dir of dirs.values()) rmSync(dir, { recursive: true, force: true });
    dirs.clear();
  });

  // A member writing over the wire while the copy reads moves the head
  // between the copy's first read and its last, so the copy matches no
  // moment of the stack and is refused. See core's docs/spec/portability.md
  // § Copying a stack.
  it('refuses with StackConflictError when the stack is written mid-copy', async () => {
    const { token: memberToken } = await server.ctx.adapter.createToken({
      subjectId: OTHER_ENTITY_ID,
    });
    await server.ctx.stack.grantType(NOTE.split('@')[0]!, {
      actions: ['create'],
      grantee: { kind: 'entity', entityId: OTHER_ENTITY_ID },
    });
    await server.ctx.stack.create(NOTE, { n: 1 });

    // After the copy's first head read, before its last: listing Types is
    // one of the reads between them.
    const listTypes = source.listTypes.bind(source);
    source.listTypes = async () => {
      const written = await fetch(`${server.url}/records`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ typeId: NOTE, content: { n: 2 } }),
      });
      expect(written.status).toBe(200);
      return listTypes();
    };

    await expect(copyStack(source, local)).rejects.toThrow(StackConflictError);
  });

  // Larger than every page a copy reads through: the copy's own Record and
  // blob pages (100), and this server's bound on a versions, journal or
  // blob page (MAX_PAGE). Totals equal to the store's mean every cursor was
  // followed to its end.
  it('follows every cursor when the stack is larger than a page', { timeout: 60_000 }, async () => {
    const { stack, adapter } = server.ctx;
    const records = 120;
    for (let i = 0; i < records; i++) await stack.create(NOTE, { n: i });
    const edited = await stack.create(NOTE, { n: -1 });
    for (let i = 0; i < MAX_PAGE + 5; i++) await stack.patchContent(edited.id, { n: i });
    for (let i = 0; i < MAX_PAGE + 5; i++) await adapter.putBlob(new Uint8Array([i % 256, i >> 8]));

    // Unbounded, as garbage collection reads it, so this server's bound applies.
    expect(await source.listBlobs!()).toHaveLength(MAX_PAGE + 5);

    const target = await copyStack(source, local);
    try {
      const all = resolveQuery({
        filter: { includeDeleted: true, includeUnlisted: true },
        limit: 1000,
      });
      expect((await target.queryRecords(all)).records.map((r) => r.id).sort()).toEqual(
        (await adapter.queryRecords(all)).records.map((r) => r.id).sort(),
      );
      expect(await target.getVersions(edited.id)).toEqual(await adapter.getVersions(edited.id));
      expect(await target.getJournal(edited.id)).toEqual(await adapter.getJournal(edited.id));
      expect((await target.getVersions(edited.id)).length).toBeGreaterThan(MAX_PAGE);
      expect((await target.listBlobs!()).map((b) => b.fileId)).toEqual(
        (await adapter.listBlobs()).map((b) => b.fileId),
      );
    } finally {
      await target.close?.();
    }
  });
});
