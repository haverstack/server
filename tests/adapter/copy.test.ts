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
import { runCopyConformance } from '@haverstack/adapter-conformance';
import { APIAdapter } from '@haverstack/adapter-api';
import { LocalAdapter } from '@haverstack/adapter-local';
import type { CreateStore, StackAdapter } from '@haverstack/core/adapter';
import { startTestServer, TEST_TOKEN, type TestServer } from '../../src/testing.js';

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
