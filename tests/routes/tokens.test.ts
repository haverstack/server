import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, TEST_TOKEN, OTHER_ENTITY_ID, type TestApp } from '../setup.js';

describe('POST /tokens', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('owner can create a token and receives the token value', async () => {
    const { status, data } = await req(t.app, 'POST', '/tokens', {
      token: TEST_TOKEN,
      body: { entityId: OTHER_ENTITY_ID, label: 'test-label' },
    });
    expect(status).toBe(201);
    const d = data as Record<string, unknown>;
    expect(typeof d.id).toBe('string');
    expect(typeof d.token).toBe('string');
    expect(d.entityId).toBe(OTHER_ENTITY_ID);
    expect(d.label).toBe('test-label');
  });

  it('returns 403 for a non-owner authenticated entity', async () => {
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const { status } = await req(t.app, 'POST', '/tokens', {
      token,
      body: {},
    });
    expect(status).toBe(403);
  });

  it('returns 401 for an unauthenticated request', async () => {
    const { status } = await req(t.app, 'POST', '/tokens', { body: {} });
    expect(status).toBe(401);
  });
});

describe('GET /tokens', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('owner can list tokens without token values exposed', async () => {
    await t.ctx.adapter.createToken(OTHER_ENTITY_ID, { label: 'tok-a' });
    await t.ctx.adapter.createToken(OTHER_ENTITY_ID, { label: 'tok-b' });

    const { status, data } = await req(t.app, 'GET', '/tokens', { token: TEST_TOKEN });
    expect(status).toBe(200);
    const d = data as { tokens: Array<Record<string, unknown>> };
    expect(d.tokens).toHaveLength(2);
    for (const t of d.tokens) {
      expect(t.token).toBeUndefined();
      expect(typeof t.id).toBe('string');
    }
  });

  it('returns 403 for a non-owner authenticated entity', async () => {
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const { status } = await req(t.app, 'GET', '/tokens', { token });
    expect(status).toBe(403);
  });

  it('returns 401 for an unauthenticated request', async () => {
    const { status } = await req(t.app, 'GET', '/tokens');
    expect(status).toBe(401);
  });
});

describe('DELETE /tokens/:id', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('owner can revoke a token', async () => {
    const { id } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const { status } = await req(t.app, 'DELETE', `/tokens/${id}`, { token: TEST_TOKEN });
    expect(status).toBe(204);

    // Revoked token is no longer usable
    const tokens = await t.ctx.adapter.listTokens();
    expect(tokens.find((tok) => tok.id === id)).toBeUndefined();
  });

  it('returns 403 for a non-owner authenticated entity', async () => {
    const { id, token: otherToken } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const { status } = await req(t.app, 'DELETE', `/tokens/${id}`, { token: otherToken });
    expect(status).toBe(403);
  });

  it('returns 401 for an unauthenticated request', async () => {
    const { id } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const { status } = await req(t.app, 'DELETE', `/tokens/${id}`);
    expect(status).toBe(401);
  });
});
