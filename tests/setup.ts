import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { LocalAdapter } from '@haverstack/adapter-local';
import { Stack } from '@haverstack/core';
import pino from 'pino';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { StackContext } from '../src/stack.js';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/app.js';

export const TEST_ENTITY_ID = 'test-entity-id-00000001';
export const TEST_TOKEN = 'test-bearer-token';
export const OTHER_ENTITY_ID = 'other-entity-id-00000002';

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

export async function createTestContext(dbPath: string): Promise<StackContext> {
  const adapter = await LocalAdapter.initialize({
    path: dbPath,
    entityId: TEST_ENTITY_ID,
    timezone: 'UTC',
  });
  const stack = await Stack.create(adapter);
  return { adapter, stack };
}

export function testConfig(dbPath: string): Config {
  return {
    port: 3000,
    dbPath,
    entityId: TEST_ENTITY_ID,
    timezone: 'UTC',
    ownerToken: TEST_TOKEN,
    corsOrigins: '*',
    baseUrl: null,
    isNewDb: true,
    maxAttachmentBytes: 50 * 1024 * 1024,
  };
}

export type TestApp = {
  app: Hono<AppEnv>;
  ctx: StackContext;
  dbPath: string;
  cleanup: () => Promise<void>;
};

export async function buildTestApp(): Promise<TestApp> {
  const dbPath = tempDbPath();
  const ctx = await createTestContext(dbPath);
  const config = testConfig(dbPath);
  const app = createApp(ctx, config, logger);

  const cleanup = async () => {
    await ctx.stack.close();
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
