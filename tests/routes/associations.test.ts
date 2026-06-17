import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, TEST_TOKEN, type TestApp } from '../setup.js';

const TYPE_ID = 'com.example.test/post@1';

describe('Associations', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await t.ctx.stack.defineType(TYPE_ID, 'Post', {
      text: { kind: 'text' as const, required: true as const },
    });
  });
  afterEach(async () => { await t.cleanup(); });

  async function seedRecord() {
    return t.ctx.stack.create(TYPE_ID, { text: 'Hello' });
  }

  it('POST adds a tag association', async () => {
    const record = await seedRecord();
    const { status } = await req(t.app, 'POST', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { kind: 'tag', label: 'starred' },
    });
    expect(status).toBe(204);
  });

  it('GET returns all associations', async () => {
    const record = await seedRecord();
    await t.ctx.adapter.associate(record.id, { kind: 'tag', label: 'starred' });
    await t.ctx.adapter.associate(record.id, { kind: 'tag', label: 'archived' });
    const { status, data } = await req(
      t.app, 'GET', `/records/${record.id}/associations`, { token: TEST_TOKEN },
    );
    expect(status).toBe(200);
    expect((data as { associations: unknown[] }).associations).toHaveLength(2);
  });

  it('GET ?kind=tag filters by kind', async () => {
    const record = await seedRecord();
    await t.ctx.adapter.associate(record.id, { kind: 'tag', label: 'starred' });
    const { status, data } = await req(
      t.app, 'GET', `/records/${record.id}/associations?kind=tag`, { token: TEST_TOKEN },
    );
    expect(status).toBe(200);
    const assocs = (data as { associations: Array<{ kind: string }> }).associations;
    expect(assocs.every((a) => a.kind === 'tag')).toBe(true);
  });

  it('DELETE removes an association', async () => {
    const record = await seedRecord();
    await t.ctx.adapter.associate(record.id, { kind: 'tag', label: 'starred' });
    const { status } = await req(t.app, 'DELETE', `/records/${record.id}/associations`, {
      token: TEST_TOKEN,
      body: { kind: 'tag', label: 'starred' },
    });
    expect(status).toBe(204);
    const after = await t.ctx.adapter.getRecord(record.id);
    expect(after?.associations?.some((a) => a.label === 'starred')).toBeFalsy();
  });
});
