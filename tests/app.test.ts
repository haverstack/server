import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app.js';
import { buildTestApp, testConfig, logger, req, TEST_TOKEN, type TestApp } from './setup.js';

const NOTE_TYPE_ID = 'com.example.test/note@1';

describe('request body size limit', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await t.ctx.stack.defineType(NOTE_TYPE_ID, 'Note', {
      body: { kind: 'text' as const, required: false as const },
    });
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('returns a conforming 413 for an oversized POST /records body', async () => {
    const smallApp = createApp(t.ctx, { ...testConfig(t.dbPath), maxContentBytes: 100 }, logger);
    const { status, data } = await req(smallApp, 'POST', '/records', {
      token: TEST_TOKEN,
      body: { typeId: NOTE_TYPE_ID, content: { body: 'x'.repeat(500) } },
    });
    expect(status).toBe(413);
    expect((data as { error: { code: string } }).error.code).toBe('payload_too_large');
  });

  it('returns a conforming 413 for an oversized PATCH body', async () => {
    const smallApp = createApp(t.ctx, { ...testConfig(t.dbPath), maxContentBytes: 5000 }, logger);
    const created = await req(smallApp, 'POST', '/records', {
      token: TEST_TOKEN,
      body: { typeId: NOTE_TYPE_ID, content: { body: 'short' } },
    });
    const id = (created.data as { id: string }).id;

    const { status, data } = await req(smallApp, 'PATCH', `/records/${id}`, {
      token: TEST_TOKEN,
      body: { body: 'x'.repeat(6000) },
    });
    expect(status).toBe(413);
    expect((data as { error: { code: string } }).error.code).toBe('payload_too_large');
  });

  it('succeeds for a body just under the limit', async () => {
    const smallApp = createApp(t.ctx, { ...testConfig(t.dbPath), maxContentBytes: 500 }, logger);
    const { status } = await req(smallApp, 'POST', '/records', {
      token: TEST_TOKEN,
      body: { typeId: NOTE_TYPE_ID, content: { body: 'well under the limit' } },
    });
    expect(status).toBe(200);
  });

  it('fires before JSON parsing, not after', async () => {
    const smallApp = createApp(t.ctx, { ...testConfig(t.dbPath), maxContentBytes: 10 }, logger);
    const res = await smallApp.request('/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
      // Not valid JSON at all — if the limit ran after parsing, this would
      // surface as a parse/bad_request failure instead of a clean 413.
      body: 'not valid json, and also over the 10-byte limit',
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('payload_too_large');
  });

  it('applies to routes outside the original per-prefix list (e.g. POST /attachments/gc)', async () => {
    const smallApp = createApp(t.ctx, { ...testConfig(t.dbPath), maxContentBytes: 10 }, logger);
    const { status } = await req(smallApp, 'POST', '/attachments/gc', {
      token: TEST_TOKEN,
      body: { graceMs: 999999, dryRun: true },
    });
    expect(status).toBe(413);
  });

  it('excludes POST /attachments so its own, larger ceiling still applies', async () => {
    const smallApp = createApp(t.ctx, { ...testConfig(t.dbPath), maxContentBytes: 10 }, logger);
    const res = await smallApp.request('/attachments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'text/plain' },
      body: 'x'.repeat(1000), // well over the 10-byte content limit, under maxAttachmentBytes
    });
    expect(res.status).toBe(200);
  });
});
