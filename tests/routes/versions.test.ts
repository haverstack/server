import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, TEST_TOKEN, type TestApp } from '../setup.js';

const TYPE_ID = 'com.example.test/doc@1';

describe('Versions', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await t.ctx.stack.defineType(TYPE_ID, 'Doc', {
      body: { kind: 'text' as const, required: true as const },
    });
  });
  afterEach(async () => {
    await t.cleanup();
  });

  async function createAndPatch() {
    const record = await t.ctx.stack.create(TYPE_ID, { body: 'v1' });
    await req(t.app, 'PATCH', `/records/${record.id}`, {
      token: TEST_TOKEN,
      body: { content: { body: 'v2' }, version: 2, updatedAt: new Date().toISOString() },
    });
    return record;
  }

  it('GET /records/:id/versions returns history', async () => {
    const record = await createAndPatch();
    const { status, data } = await req(t.app, 'GET', `/records/${record.id}/versions`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(200);
    expect((data as unknown[]).length).toBe(1);
  });

  it('GET /records/:id/versions/:version returns one version', async () => {
    const record = await createAndPatch();
    const { status, data } = await req(t.app, 'GET', `/records/${record.id}/versions/1`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).version).toBe(1);
  });

  it('POST /records/:id/restore/:version restores content without rewriting history', async () => {
    const record = await createAndPatch();
    const { status, data } = await req(t.app, 'POST', `/records/${record.id}/restore/1`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect((d.content as Record<string, unknown>).body).toBe('v1');
    // version 1 was snapshotted, then v2 was applied, then v2 was snapshotted for restore → new version is 3
    expect(d.version).toBe(3);
  });
});
