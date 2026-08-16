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
    expect(d.principalId).toBe(OTHER_ENTITY_ID);
    expect(d.subjectId).toBe(OTHER_ENTITY_ID);
    expect(d.label).toBe('test-label');
  });

  it('owner can assert a delegation via onBehalfOf', async () => {
    const subjectId = 'did:key:subject-entity-id-00000003';
    const { status, data } = await req(t.app, 'POST', '/tokens', {
      token: TEST_TOKEN,
      body: { entityId: OTHER_ENTITY_ID, onBehalfOf: subjectId },
    });
    expect(status).toBe(201);
    const d = data as Record<string, unknown>;
    expect(d.principalId).toBe(OTHER_ENTITY_ID);
    expect(d.subjectId).toBe(subjectId);

    const session = await t.ctx.adapter.lookupToken(d.token as string);
    expect(session).toEqual({ principalId: OTHER_ENTITY_ID, subjectId });
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

  it('rejects a non-DID entityId with 422', async () => {
    const { status, data } = await req(t.app, 'POST', '/tokens', {
      token: TEST_TOKEN,
      body: { entityId: 'not-a-did' },
    });
    expect(status).toBe(422);
    const body = data as { error: { code: string; details: Array<{ path: string }> } };
    expect(body.error.code).toBe('validation');
    expect(body.error.details.some((d) => d.path === 'entityId')).toBe(true);
  });

  it('rejects a non-DID onBehalfOf with 422', async () => {
    const { status, data } = await req(t.app, 'POST', '/tokens', {
      token: TEST_TOKEN,
      body: { entityId: OTHER_ENTITY_ID, onBehalfOf: 'not-a-did' },
    });
    expect(status).toBe(422);
    const body = data as { error: { code: string; details: Array<{ path: string }> } };
    expect(body.error.code).toBe('validation');
    expect(body.error.details.some((d) => d.path === 'onBehalfOf')).toBe(true);
  });

  it('reports the stored createdAt, matching what GET /tokens later reports', async () => {
    const { data } = await req(t.app, 'POST', '/tokens', {
      token: TEST_TOKEN,
      body: { entityId: OTHER_ENTITY_ID },
    });
    const created = data as { id: string; createdAt: string };

    const { data: listed } = await req(t.app, 'GET', '/tokens', { token: TEST_TOKEN });
    const row = (listed as { tokens: Array<{ id: string; createdAt: string }> }).tokens.find(
      (tok) => tok.id === created.id,
    );
    expect(row?.createdAt).toBe(created.createdAt);
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
