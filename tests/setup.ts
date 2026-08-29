import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { LocalAdapter, NativeTokenStore, defaultTokenStorePath } from '@haverstack/adapter-local';
import { Stack } from '@haverstack/core';
import { authOriginFromUrl } from '@haverstack/core/wire';
import pino from 'pino';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { StackContext } from '../src/stack.js';
import { AuthNonceStore, defaultNonceStorePath } from '../src/lib/nonceStore.js';
import { QueryWorkerPool } from '../src/lib/queryWorker/pool.js';
import { ChangeStreamRegistry } from '../src/lib/changeStreams.js';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/app.js';

export const TEST_ENTITY_ID = 'did:key:test-entity-id-00000001';
export const TEST_TOKEN = 'test-bearer-token';
export const OTHER_ENTITY_ID = 'did:key:other-entity-id-00000002';
// Matches @haverstack/conformance-fixtures' AUTH_FIXTURE_ORIGIN — the auth
// handshake fixtures carry real signatures over this exact origin, so the
// test harness must present itself as it.
export const TEST_BASE_URL = 'https://stack.example.com';

export const logger = pino({ level: 'silent' });

/**
 * Each test gets its own isolated temp directory so the SQLiteAdapter's
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

export type TestApp = {
  app: Hono<AppEnv>;
  ctx: StackContext;
  dbPath: string;
  cleanup: () => Promise<void>;
};

export async function buildTestApp(opts: TestContextOpts = { timezone: 'UTC' }): Promise<TestApp> {
  const dbPath = tempDbPath();
  const ctx = await createTestContext(dbPath, opts);
  const config = testConfig(dbPath, opts);
  const app = createApp(ctx, config, logger);

  const cleanup = async () => {
    await ctx.queryWorker.close();
    await ctx.stack.close();
    await ctx.tokens.close();
    ctx.nonces.close();
    // Remove the whole temp directory (includes the .db file and attachments/).
    await rm(dirname(dbPath), { recursive: true, force: true }).catch(() => {});
  };

  return { app, ctx, dbPath, cleanup };
}

export type ReqOpts = {
  /** Adds Authorization: Bearer <token> header. */
  token?: string;
  /** JSON-serialised as the request body with Content-Type: application/json. */
  body?: unknown;
  /** Additional headers merged after auth/content-type. */
  headers?: Record<string, string>;
};

/**
 * Fire a request at the Hono test app and return status + parsed JSON body.
 */
export async function req(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  opts: ReqOpts = {},
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  Object.assign(headers, opts.headers);

  const res = await app.request(path, {
    method,
    headers,
    ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}
