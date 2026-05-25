import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { SQLiteAdapter } from '@haverstack/adapter-sqlite';
import { Stack } from '@haverstack/core';
import pino from 'pino';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { StackContext } from '../src/stack.js';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/app.js';

export const TEST_ENTITY_ID = 'test-entity-id-00000001';
export const TEST_TOKEN = 'test-bearer-token';
export const OTHER_TOKEN = 'other-bearer-token';
export const OTHER_ENTITY_ID = 'other-entity-id-00000002';

export const logger = pino({ level: 'silent' });

export function tempDbPath(): string {
  return join(tmpdir(), `haverstack-test-${randomBytes(8).toString('hex')}.db`);
}

export async function createTestContext(dbPath: string): Promise<StackContext> {
  const adapter = await SQLiteAdapter.initialize({
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
    tokens: [
      { token: TEST_TOKEN, entityId: TEST_ENTITY_ID },
      { token: OTHER_TOKEN, entityId: OTHER_ENTITY_ID },
    ],
    corsOrigins: '*',
    baseUrl: null,
    isNewDb: true,
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
    if (existsSync(dbPath)) await unlink(dbPath);
    const attachmentsDir = join(dirname(dbPath), 'attachments');
    await rm(attachmentsDir, { recursive: true, force: true }).catch(() => {});
  };

  return { app, ctx, dbPath, cleanup };
}

export type ReqOpts = {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Set Content-Type to this MIME type and send body as raw string. Used for binary uploads. */
  rawBody?: { data: string; contentType: string };
};

/**
 * Fire a request at the Hono test app and return the status code + parsed response.
 *
 * Pass `token` to add an Authorization header.
 * Pass `body` to JSON-encode and send as application/json.
 */
export async function req(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  opts: ReqOpts = {},
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  } else if (opts.rawBody) {
    headers['Content-Type'] = opts.rawBody.contentType;
    body = opts.rawBody.data;
  }

  const res = await app.request(path, { method, headers, body });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}
