/**
 * Test-only building blocks for driving a real @haverstack/server. This
 * package's own route tests use `createTestContext`/`testConfig` with
 * `createApp` + Hono's in-process `app.request()` (no socket — see
 * tests/setup.ts's `buildTestApp`/`req`); `startTestServer` goes one step
 * further and actually listens, for a consumer whose client (APIAdapter or
 * otherwise) needs a real URL to fetch against rather than a mocked one.
 * Not for production use: fixed entity/token values, single-worker pool.
 */

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { serve } from '@hono/node-server';
import { LocalAdapter, NativeTokenStore, defaultTokenStorePath } from '@haverstack/adapter-local';
import { Stack } from '@haverstack/core';
import { authOriginFromUrl } from '@haverstack/core/wire';
import pino from 'pino';
import type { Logger } from 'pino';
import { createApp } from './app.js';
import { createShutdownHandler } from './shutdown.js';
import { AuthNonceStore, defaultNonceStorePath } from './lib/nonceStore.js';
import { QueryWorkerPool } from './lib/queryWorker/pool.js';
import { ChangeStreamRegistry } from './lib/changeStreams.js';
import type { Config } from './config.js';
import type { StackContext } from './stack.js';

export const TEST_ENTITY_ID = 'did:key:test-entity-id-00000001';
export const TEST_TOKEN = 'test-bearer-token';
export const OTHER_ENTITY_ID = 'did:key:other-entity-id-00000002';
// Matches @haverstack/conformance-fixtures' AUTH_FIXTURE_ORIGIN — the auth
// handshake fixtures carry real signatures over this exact origin, so
// anything replaying them (createTestContext/testConfig, in-process
// app.request()) must present itself as it. startTestServer, which actually
// listens, uses its own real origin instead — see below.
export const TEST_BASE_URL = 'https://stack.example.com';

export const logger: Logger = pino({ level: 'silent' });

/**
 * Each caller gets its own isolated temp directory so the SQLiteAdapter's
 * sibling `attachments/` folder never collides between parallel test runs.
 */
export function tempDbPath(): string {
  const dir = join(tmpdir(), `haverstack-test-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'stack.db');
}

export type TestContextOpts = {
  /**
   * IANA timezone string, or `undefined` to opt out of one. Note: a plain
   * default parameter can't tell "omitted" from "explicitly undefined"
   * (both trigger the default), so this must be an options bag — pass
   * `{ timezone: undefined }` deliberately, not the bare value.
   */
  timezone?: string;
};

export async function createTestContext(
  dbPath: string,
  opts: TestContextOpts = { timezone: 'UTC' },
): Promise<StackContext> {
  const adapter = await LocalAdapter.initialize({
    path: dbPath,
    entityId: TEST_ENTITY_ID,
    ...(opts.timezone !== undefined && { timezone: opts.timezone }),
  });
  const stack = await Stack.create(adapter);
  const tokens = await NativeTokenStore.open({ path: defaultTokenStorePath(dbPath) });
  const nonces = AuthNonceStore.open(defaultNonceStorePath(dbPath));
  const queryWorker = new QueryWorkerPool({
    init: { dbPath },
    poolSize: 1,
    queueLimit: 64,
    logger,
  });
  return { adapter, stack, tokens, nonces, queryWorker, changeStreams: new ChangeStreamRegistry() };
}

export function testConfig(dbPath: string, opts: TestContextOpts = { timezone: 'UTC' }): Config {
  return {
    port: 3000,
    dbPath,
    entityId: TEST_ENTITY_ID,
    ownerName: null,
    ownerHandle: null,
    timezone: opts.timezone,
    ownerToken: TEST_TOKEN,
    corsOrigins: '*',
    baseUrl: TEST_BASE_URL,
    authOrigin: authOriginFromUrl(TEST_BASE_URL),
    maxAttachmentBytes: 50 * 1024 * 1024,
    maxContentBytes: 1 * 1024 * 1024,
    queryTimeoutMs: 10_000,
    queryWorkerPoolSize: 1,
    queryQueueLimit: 64,
    seedCommonsTypes: false,
    shutdownTimeoutMs: 10_000,
  };
}

/** Asks the OS for a free localhost port, then immediately releases it. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close(() => {
        if (port) resolve(port);
        else reject(new Error('could not allocate a free port'));
      });
    });
  });
}

export type TestServer = {
  /** The real, reachable base URL — pass straight to APIAdapter.open({ url }). */
  url: string;
  ctx: StackContext;
  config: Config;
  /** Stops accepting connections and releases every resource, including the temp db. */
  close(): Promise<void>;
};

/**
 * Spins up a real, listening @haverstack/server on an ephemeral localhost
 * port, backed by a throwaway LocalAdapter file — for exercising an HTTP
 * client against the actual wire protocol rather than a mocked fetch.
 * Owner auth: `Authorization: Bearer ${TEST_TOKEN}`.
 */
export async function startTestServer(
  opts: TestContextOpts = { timezone: 'UTC' },
): Promise<TestServer> {
  const dbPath = tempDbPath();
  const ctx = await createTestContext(dbPath, opts);
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const config: Config = {
    ...testConfig(dbPath, opts),
    port,
    baseUrl: url,
    authOrigin: authOriginFromUrl(url),
  };
  const app = createApp(ctx, config, logger);

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port }, () => resolve(s));
  });

  // Reuses the exact production teardown sequence (see src/shutdown.ts) —
  // a short grace period since a stuck test should fail fast, not hang.
  const shutdown = createShutdownHandler(server, ctx, logger, 2_000);
  const close = async () => {
    await shutdown('test-teardown');
    await rm(dirname(dbPath), { recursive: true, force: true }).catch(() => {});
  };

  return { url, ctx, config, close };
}
