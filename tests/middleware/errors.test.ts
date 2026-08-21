import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';
import { createApp } from '../../src/app.js';
import {
  createTestContext,
  tempDbPath,
  testConfig,
  req,
  TEST_TOKEN,
  OTHER_ENTITY_ID,
} from '../setup.js';
import type { StackContext } from '../../src/stack.js';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';

function spyLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
  };
}

describe('errorMiddleware — denied-but-verified logging', () => {
  let dbPath: string;
  let ctx: StackContext;

  beforeEach(async () => {
    dbPath = tempDbPath();
    ctx = await createTestContext(dbPath);
  });

  afterEach(async () => {
    await ctx.queryWorker.close();
    await ctx.stack.close();
    await ctx.tokens.close();
    await rm(dirname(dbPath), { recursive: true, force: true }).catch(() => {});
  });

  it('logs the requester DID when a verified token is denied by permission', async () => {
    const { token } = await ctx.adapter.createToken(OTHER_ENTITY_ID);
    const warn = spyLogger();
    const app = createApp(ctx, testConfig(dbPath), warn);

    const { status } = await req(app, 'GET', '/tokens', { token });
    expect(status).toBe(403);
    expect(warn.warn).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: OTHER_ENTITY_ID, subjectId: OTHER_ENTITY_ID }),
      expect.stringMatching(/denied/i),
    );
  });

  it('does not log a requester DID for an anonymous 401', async () => {
    const warn = spyLogger();
    const app = createApp(ctx, testConfig(dbPath), warn);

    const { status } = await req(app, 'GET', '/tokens');
    expect(status).toBe(401);
    expect(warn.warn).not.toHaveBeenCalled();
  });

  it('does not log for the owner token itself', async () => {
    const warn = spyLogger();
    const app = createApp(ctx, testConfig(dbPath), warn);

    const { status } = await req(app, 'GET', '/tokens', { token: TEST_TOKEN });
    expect(status).toBe(200);
    expect(warn.warn).not.toHaveBeenCalled();
  });
});

describe('errorMiddleware — malformed JSON bodies', () => {
  let dbPath: string;
  let ctx: StackContext;

  beforeEach(async () => {
    dbPath = tempDbPath();
    ctx = await createTestContext(dbPath);
  });

  afterEach(async () => {
    await ctx.queryWorker.close();
    await ctx.stack.close();
    await ctx.tokens.close();
    await rm(dirname(dbPath), { recursive: true, force: true }).catch(() => {});
  });

  it('returns 400 bad_request rather than a bare 500', async () => {
    const app = createApp(ctx, testConfig(dbPath), spyLogger());

    const res = await app.request('/records', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
      body: '{ this is not json',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });
});
