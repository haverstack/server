import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildTestApp,
  req,
  testConfig,
  logger,
  TEST_TOKEN,
  OTHER_ENTITY_ID,
  type TestApp,
} from '../setup.js';
import { createApp } from '../../src/app.js';

const NOTE_TYPE_ID = 'com.example.test/note@1';

async function seedType(ctx: TestApp['ctx']) {
  return ctx.stack.defineType(NOTE_TYPE_ID, 'Note', {
    body: { kind: 'text' as const, required: true as const },
  });
}

async function putFile(ctx: TestApp['ctx'], content = 'hello') {
  return ctx.stack.putAttachment(new TextEncoder().encode(content), 'text/plain');
}

describe('GET /attachments/:fileId', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await seedType(t.ctx);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('allows the owner to read an unattached file', async () => {
    const fileId = await putFile(t.ctx);
    const { status, data } = await req(t.app, 'GET', `/attachments/${fileId}`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(200);
    expect(data).toBe('hello');
  });

  it('rejects an anonymous request for an unattached file', async () => {
    const fileId = await putFile(t.ctx);
    const { status } = await req(t.app, 'GET', `/attachments/${fileId}`);
    expect(status).toBe(401);
  });

  it('rejects a non-owner authenticated request for an unattached file', async () => {
    const fileId = await putFile(t.ctx);
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const { status } = await req(t.app, 'GET', `/attachments/${fileId}`, { token });
    expect(status).toBe(401);
  });

  it('allows anonymous access when the referencing record is public', async () => {
    const fileId = await putFile(t.ctx);
    await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'public note' },
      {
        permissions: [{ access: 'public' }],
        associations: [{ kind: 'attachment', label: 'file', fileId, mimeType: 'text/plain' }],
      },
    );

    const { status } = await req(t.app, 'GET', `/attachments/${fileId}`);
    expect(status).toBe(200);
  });

  it('rejects anonymous access when the referencing record is private', async () => {
    const fileId = await putFile(t.ctx);
    await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'private note' },
      {
        associations: [{ kind: 'attachment', label: 'file', fileId, mimeType: 'text/plain' }],
      },
    );

    const { status } = await req(t.app, 'GET', `/attachments/${fileId}`);
    expect(status).toBe(401);
  });

  it('grants access if ANY referencing record is accessible, not just the first', async () => {
    const fileId = await putFile(t.ctx);
    // Private record references the file first...
    await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'private note' },
      {
        associations: [{ kind: 'attachment', label: 'file', fileId, mimeType: 'text/plain' }],
      },
    );
    // ...a second, public record also references it.
    await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'public note' },
      {
        permissions: [{ access: 'public' }],
        associations: [{ kind: 'attachment', label: 'file', fileId, mimeType: 'text/plain' }],
      },
    );

    const { status } = await req(t.app, 'GET', `/attachments/${fileId}`);
    expect(status).toBe(200);
  });

  it('grants a non-owner entity access via an entity-scoped read grant', async () => {
    const fileId = await putFile(t.ctx);
    await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'shared note' },
      {
        permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: false }],
        associations: [{ kind: 'attachment', label: 'file', fileId, mimeType: 'text/plain' }],
      },
    );
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

    const { status } = await req(t.app, 'GET', `/attachments/${fileId}`, { token });
    expect(status).toBe(200);
  });

  it('rejects a non-owner entity without a matching read grant', async () => {
    const fileId = await putFile(t.ctx);
    await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'private note' },
      {
        associations: [{ kind: 'attachment', label: 'file', fileId, mimeType: 'text/plain' }],
      },
    );
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

    const { status } = await req(t.app, 'GET', `/attachments/${fileId}`, { token });
    expect(status).toBe(401);
  });
});

describe('POST /attachments', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('preserves filename from Content-Disposition on upload and returns it on download', async () => {
    const content = new TextEncoder().encode('PDF content');
    const uploadRes = await t.app.request('/attachments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="test.pdf"',
      },
      body: content,
    });
    expect(uploadRes.status).toBe(201);
    const { fileId } = (await uploadRes.json()) as { fileId: string };

    const downloadRes = await t.app.request(`/attachments/${fileId}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('Content-Disposition')).toBe(
      "attachment; filename*=UTF-8''test.pdf",
    );
  });

  it('returns 413 when Content-Length exceeds the limit (pre-check)', async () => {
    const smallConfig = { ...testConfig(t.dbPath), maxAttachmentBytes: 10 };
    const smallApp = createApp(t.ctx, smallConfig, logger);

    const res = await smallApp.request('/attachments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'text/plain',
        'Content-Length': '100',
      },
      body: 'x'.repeat(11),
    });
    expect(res.status).toBe(413);
  });

  it('returns 413 when body byte length exceeds the limit (body check)', async () => {
    const smallConfig = { ...testConfig(t.dbPath), maxAttachmentBytes: 10 };
    const smallApp = createApp(t.ctx, smallConfig, logger);

    const oversized = new Uint8Array(11).fill(65);
    const res = await smallApp.request('/attachments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'text/plain',
      },
      body: oversized,
    });
    expect(res.status).toBe(413);
  });
});

describe('DELETE /attachments/:fileId', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await seedType(t.ctx);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('allows the owner to delete', async () => {
    const fileId = await putFile(t.ctx);
    const { status } = await req(t.app, 'DELETE', `/attachments/${fileId}`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(204);
  });

  it('returns 409 when the file is still referenced by a record', async () => {
    const fileId = await putFile(t.ctx);
    await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'note with attachment' },
      {
        associations: [{ kind: 'attachment', label: 'file', fileId, mimeType: 'text/plain' }],
      },
    );
    const { status } = await req(t.app, 'DELETE', `/attachments/${fileId}`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(409);
  });

  it('rejects a non-owner entity even with a write grant on a referencing record', async () => {
    const fileId = await putFile(t.ctx);
    await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'shared note' },
      {
        permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: true }],
        associations: [{ kind: 'attachment', label: 'file', fileId, mimeType: 'text/plain' }],
      },
    );
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

    const { status } = await req(t.app, 'DELETE', `/attachments/${fileId}`, { token });
    expect(status).toBe(403);
  });
});
