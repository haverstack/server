import { dirname } from 'node:path';
import { rm } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import type { StackContext } from '../src/stack.js';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/app.js';
import {
  TEST_ENTITY_ID,
  TEST_TOKEN,
  OTHER_ENTITY_ID,
  TEST_BASE_URL,
  logger,
  tempDbPath,
  createTestContext,
  testConfig,
  type TestContextOpts,
} from '../src/testing.js';

export {
  TEST_ENTITY_ID,
  TEST_TOKEN,
  OTHER_ENTITY_ID,
  TEST_BASE_URL,
  logger,
  tempDbPath,
  createTestContext,
  testConfig,
  type TestContextOpts,
};

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
