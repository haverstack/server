import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, TEST_TOKEN, OTHER_ENTITY_ID, type TestApp } from '../setup.js';

// A name an endpoint doesn't define is refused, never ignored: ignoring it
// turns a mistaken request into a different one that succeeds.
describe('unrecognized request input', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it.each([
    ['GET', '/health?x=1'],
    ['GET', '/.well-known/stack?x=1'],
    ['GET', '/entity?x=1'],
    ['GET', '/tokens?x=1'],
    ['GET', '/types?x=1'],
    ['GET', '/records/1hk153x00001?x=1'],
    ['DELETE', '/records/1hk153x00001?x=1'],
    ['GET', '/records/1hk153x00001/associations?x=1'],
    ['GET', '/attachments/somefile?x=1'],
  ] as const)('%s %s refuses an unknown query param', async (method, path) => {
    const { status, data } = await req(t.app, method, path, { token: TEST_TOKEN });
    expect(status).toBe(400);
    expect(JSON.stringify(data)).toContain('x');
  });

  it('refuses a purge value other than true or false', async () => {
    const { status } = await req(t.app, 'DELETE', '/records/1hk153x00001?purge=yes', {
      token: TEST_TOKEN,
    });
    expect(status).toBe(400);
  });

  it.each([
    ['/tokens', { principalId: OTHER_ENTITY_ID, extra: true }],
    ['/entity', { content: {}, extra: true }],
    ['/attachments/gc', { dryRun: true, extra: true }],
    ['/auth/challenge', { did: OTHER_ENTITY_ID, extra: true }],
    ['/records/1hk153x00001/migrate', { toTypeId: 'x', content: {}, extra: true }],
  ] as const)('POST/PATCH %s refuses an unknown body key', async (path, body) => {
    const method = path === '/entity' ? 'PATCH' : 'POST';
    const { status, data } = await req(t.app, method, path, { token: TEST_TOKEN, body });
    expect(status).toBe(400);
    expect(JSON.stringify(data)).toContain('extra');
  });

  it.each([
    ['/tokens', { label: 5 }],
    ['/tokens', { expiresAt: 5 }],
    ['/attachments/gc', { graceMs: '10' }],
    ['/attachments/gc', { dryRun: 'true' }],
  ] as const)('POST %s refuses a wrong-typed value with 422', async (path, body) => {
    const { status } = await req(t.app, 'POST', path, { token: TEST_TOKEN, body });
    expect(status).toBe(422);
  });

  it('PATCH /entity requires content', async () => {
    const { status } = await req(t.app, 'PATCH', '/entity', { token: TEST_TOKEN, body: {} });
    expect(status).toBe(400);
  });
});
