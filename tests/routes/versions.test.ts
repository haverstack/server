import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, auth, json, type TestApp } from '../setup.js';

const TYPE_ID = 'com.example.test/doc@1';

describe('Versions', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await t.ctx.stack.defineType(TYPE_ID, 'Doc', { body: { kind: 'text' as const, required: true as const } });
  });
  afterEach(async () => { await t.cleanup(); });

  async function createAndUpdate() {
    const record = await t.ctx.stack.create(TYPE_ID, { body: 'v1' });
    // Update via HTTP so the server snapshots the version
    await req(t.app, 'PATCH', `/records/${record.id}`, {
      ...auth(),
      ...json({ content: { body: 'v2' }, version: 2, updatedAt: new Date().toISOString() }),
    });
    return record;
  }

  it('GET /records/:id/versions returns version history', async () => {
    const record = await createAndUpdate();
    const { status, data } = await req(t.app, 'GET', `/records/${record.id}/versions`, auth());
    expect(status).toBe(200);
    const versions = data as unknown[];
    expect(versions).toHaveLength(1);
  });

  it('GET /records/:id/versions/:version returns a specific version', async () => {
    const record = await createAndUpdate();
    const { status, data } = await req(t.app, 'GET', `/records/${record.id}/versions/1`, auth());
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).version).toBe(1);
  });

  it('POST /records/:id/restore/:version restores a previous version', async () => {
    const record = await createAndUpdate();
    const { status, data } = await req(t.app, 'POST', `/records/${record.id}/restore/1`, auth());
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect((d.content as Record<string, unknown>).body).toBe('v1');
    expect(d.version).toBe(3);
  });
});
