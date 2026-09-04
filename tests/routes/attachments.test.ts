import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildTestApp,
  req,
  testConfig,
  logger,
  TEST_TOKEN,
  TEST_ENTITY_ID,
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

/** Seeds bytes via the unscoped Stack (bypasses the wire route entirely). */
async function putFile(ctx: TestApp['ctx'], content = 'hello') {
  const record = await ctx.stack.putAttachment(new TextEncoder().encode(content), 'text/plain');
  return (record.content as { fileId: string }).fileId;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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
    expect(status).toBe(403);
  });

  it('allows anonymous access when the referencing record is public', async () => {
    const fileId = await putFile(t.ctx);
    await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'public note' },
      {
        permissions: [{ access: 'public' }],
        associations: [{ kind: 'attachment', label: 'file', fileId }],
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
        associations: [{ kind: 'attachment', label: 'file', fileId }],
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
        associations: [{ kind: 'attachment', label: 'file', fileId }],
      },
    );
    // ...a second, public record also references it.
    await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'public note' },
      {
        permissions: [{ access: 'public' }],
        associations: [{ kind: 'attachment', label: 'file', fileId }],
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
        associations: [{ kind: 'attachment', label: 'file', fileId }],
      },
    );
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

    const { status } = await req(t.app, 'GET', `/attachments/${fileId}`, { token });
    expect(status).toBe(200);
  });

  it('a readable unlisted record still conveys access to its attachment (core 0.18)', async () => {
    // ScopedStack.getAttachment() scans referencing records with
    // includeUnlisted itself — enumeration standing (unlisted) and read
    // access (permissions) are orthogonal, so an unlisted-but-shared
    // record still unlocks its attachment for a reader who holds a grant.
    const fileId = await putFile(t.ctx);
    await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'unlisted but shared' },
      {
        unlisted: true,
        permissions: [{ access: 'entity', entityId: OTHER_ENTITY_ID, read: true, write: false }],
        associations: [{ kind: 'attachment', label: 'file', fileId }],
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
        associations: [{ kind: 'attachment', label: 'file', fileId }],
      },
    );
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

    const { status } = await req(t.app, 'GET', `/attachments/${fileId}`, { token });
    expect(status).toBe(403);
  });

  it('gives an identical response for a missing file and an inaccessible file, for a non-owner', async () => {
    const fileId = await putFile(t.ctx);
    await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'private note' },
      {
        associations: [{ kind: 'attachment', label: 'file', fileId }],
      },
    );
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

    const inaccessible = await req(t.app, 'GET', `/attachments/${fileId}`, { token });
    const missing = await req(
      t.app,
      'GET',
      '/attachments/0000000000000000000000000000000000000000000000000000000000000000',
      { token },
    );
    expect(inaccessible.status).toBe(missing.status);
    expect(inaccessible.data).toEqual(missing.data);
  });

  it('uses ?contentType param as Content-Type without a metadata record', async () => {
    const fileId = await putFile(t.ctx);
    const res = await t.app.request(`/attachments/${fileId}?contentType=image/png`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
  });

  it('uses ?filename param in Content-Disposition without a metadata record', async () => {
    const fileId = await putFile(t.ctx);
    const res = await t.app.request(`/attachments/${fileId}?filename=photo.png`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''photo.png");
  });

  it('infers Content-Type from ?filename extension when no ?contentType is given', async () => {
    const fileId = await putFile(t.ctx);
    const res = await t.app.request(`/attachments/${fileId}?filename=photo.png`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
  });

  it('sanitizes a blocked ?contentType param to application/octet-stream', async () => {
    const fileId = await putFile(t.ctx);
    const res = await t.app.request(`/attachments/${fileId}?contentType=text/html`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('drops a dangerous ?filename from Content-Disposition once its extension forces the type', async () => {
    // The filename itself is what makes the type dangerous here — letting it
    // through unchanged would leave a browser a filename-based sniffing hint
    // even with Content-Type neutralized (core's AttachmentDownloadContentType.forced).
    const fileId = await putFile(t.ctx);
    const res = await t.app.request(`/attachments/${fileId}?filename=payload.html`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toBe('attachment');
  });

  it('always sets X-Content-Type-Options: nosniff', async () => {
    const fileId = await putFile(t.ctx);
    const res = await t.app.request(`/attachments/${fileId}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('resolves Content-Type from the stored metadata record when no param is given', async () => {
    const fileId = await putFile(t.ctx, 'stored-type content');
    const res = await t.app.request(`/attachments/${fileId}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
  });

  it('falls back to the first-recorded filename when the requester has no own record', async () => {
    const bytes = new TextEncoder().encode('shared content');
    await t.ctx.stack.putAttachment(bytes, 'text/plain', 'first.txt');
    const second = await t.ctx.stack.putAttachment(bytes, 'text/plain', 'second.txt');
    const fileId = (second.content as { fileId: string }).fileId;

    const res = await t.app.request(`/attachments/${fileId}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''first.txt");
  });

  it("prefers the requester's own record for filename over the first-recorded record", async () => {
    const bytes = new TextEncoder().encode('shared content 2');
    await t.ctx.stack.grant(OTHER_ENTITY_ID, [{ actions: ['create'], typeId: '_attachment@1' }]);
    const first = await t.ctx.stack
      .forSession({ principalId: OTHER_ENTITY_ID, subjectId: OTHER_ENTITY_ID })
      .putAttachment(bytes, 'text/plain', 'first.txt');
    const fileId = (first.content as { fileId: string }).fileId;
    await t.ctx.stack
      .forSession({ principalId: TEST_ENTITY_ID, subjectId: TEST_ENTITY_ID })
      .putAttachment(bytes, 'text/plain', 'mine.txt');

    const res = await t.app.request(`/attachments/${fileId}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(res.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''mine.txt");
  });

  it('forces a dangerous stored mimeType to application/octet-stream', async () => {
    const record = await t.ctx.stack.putAttachment(
      new TextEncoder().encode('<script>alert(1)</script>'),
      'text/html',
      'evil.html',
    );
    const fileId = (record.content as { fileId: string }).fileId;

    const res = await t.app.request(`/attachments/${fileId}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });
});

describe('POST /attachments', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await seedType(t.ctx);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('stores bytes and creates the _attachment@1 record atomically, returning it', async () => {
    const bytes = new TextEncoder().encode('file content');
    const res = await t.app.request('/attachments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'text/plain',
      },
      body: bytes,
    });
    expect(res.status).toBe(200);
    const record = (await res.json()) as Record<string, unknown>;
    expect(record.typeId).toBe('_attachment@1');
    const content = record.content as Record<string, unknown>;
    expect(content.fileId).toBe(sha256Hex(bytes));
    expect(content.mimeType).toBe('text/plain');
    expect(content.size).toBe(bytes.byteLength);

    const stored = await t.ctx.stack.query({
      filter: { typeId: '_attachment@1', content: { fileId: content.fileId } },
    });
    expect(stored.records).toHaveLength(1);
  });

  it('defaults mimeType to application/octet-stream when Content-Type is omitted', async () => {
    const res = await t.app.request('/attachments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: new TextEncoder().encode('raw bytes'),
    });
    expect(res.status).toBe(200);
    const record = (await res.json()) as { content: Record<string, unknown> };
    expect(record.content.mimeType).toBe('application/octet-stream');
  });

  it('parses filename from the RFC 5987 Content-Disposition form', async () => {
    const res = await t.app.request('/attachments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'text/plain',
        'Content-Disposition': "attachment; filename*=UTF-8''caf%C3%A9.txt",
      },
      body: new TextEncoder().encode('content'),
    });
    expect(res.status).toBe(200);
    const record = (await res.json()) as { content: Record<string, unknown> };
    expect(record.content.filename).toBe('café.txt');
  });

  it('passes ?appId= through to the created record', async () => {
    const res = await t.app.request('/attachments?appId=my-app-id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'text/plain' },
      body: new TextEncoder().encode('content'),
    });
    expect(res.status).toBe(200);
    const record = (await res.json()) as Record<string, unknown>;
    expect(record.appId).toBe('my-app-id');
  });

  it('rejects an anonymous upload with 401', async () => {
    const res = await t.app.request('/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: new TextEncoder().encode('content'),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a token holder with no create grant on _attachment@1 with 403', async () => {
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const res = await t.app.request('/attachments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: new TextEncoder().encode('content'),
    });
    expect(res.status).toBe(403);
  });

  it('allows an entity with a create grant on _attachment@1 to upload', async () => {
    await t.ctx.stack.grant(OTHER_ENTITY_ID, [{ actions: ['create'], typeId: '_attachment@1' }]);
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const res = await t.app.request('/attachments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: new TextEncoder().encode('content'),
    });
    expect(res.status).toBe(200);
    const record = (await res.json()) as Record<string, unknown>;
    expect(record.entityId).toBe(OTHER_ENTITY_ID);
  });

  it('identical bytes uploaded twice produce the same fileId but two distinct records', async () => {
    const bytes = new TextEncoder().encode('same content');
    const upload = () =>
      t.app.request('/attachments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'text/plain' },
        body: bytes,
      });

    const first = (await (await upload()).json()) as { id: string; content: { fileId: string } };
    const second = (await (await upload()).json()) as { id: string; content: { fileId: string } };

    expect(second.content.fileId).toBe(first.content.fileId);
    expect(second.id).not.toBe(first.id);
  });

  it('rejects a second upload with a conflicting mimeType with 422', async () => {
    const bytes = new TextEncoder().encode('same content');
    await t.app.request('/attachments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'text/plain' },
      body: bytes,
    });

    const res = await t.app.request('/attachments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'image/png' },
      body: bytes,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; details: Array<{ path: string }> };
    };
    expect(body.error.code).toBe('validation');
    expect(body.error.details.some((d) => d.path === 'mimeType')).toBe(true);
    // Anti-oracle: the established mimeType must never be named in the error.
    expect(JSON.stringify(body)).not.toContain('text/plain');
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

  it('returns 413 for a chunked upload without Content-Length, aborting before the stream drains', async () => {
    const smallConfig = { ...testConfig(t.dbPath), maxAttachmentBytes: 10 };
    const smallApp = createApp(t.ctx, smallConfig, logger);

    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 3) {
          controller.error(new Error('body was read past where the limit should have aborted it'));
          return;
        }
        controller.enqueue(new Uint8Array(20).fill(65)); // 20 bytes, already over the 10-byte limit
      },
    });

    const res = await smallApp.request('/attachments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'text/plain' },
      duplex: 'half',
      body: stream,
    });
    expect(res.status).toBe(413);
    expect(pulls).toBeLessThanOrEqual(3);
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
        associations: [{ kind: 'attachment', label: 'file', fileId }],
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
        associations: [{ kind: 'attachment', label: 'file', fileId }],
      },
    );
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);

    const { status } = await req(t.app, 'DELETE', `/attachments/${fileId}`, { token });
    expect(status).toBe(403);
  });
});

describe('POST /attachments/gc', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await seedType(t.ctx);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('rejects an anonymous request with 401', async () => {
    const { status } = await req(t.app, 'POST', '/attachments/gc');
    expect(status).toBe(401);
  });

  it('rejects a non-owner request with 403', async () => {
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const { status } = await req(t.app, 'POST', '/attachments/gc', { token });
    expect(status).toBe(403);
  });

  it('accepts an empty body', async () => {
    const { status } = await req(t.app, 'POST', '/attachments/gc', { token: TEST_TOKEN });
    expect(status).toBe(200);
  });

  it('dry-run reports what would be deleted without deleting it', async () => {
    const fileId = await putFile(t.ctx);
    const { status, data } = await req(t.app, 'POST', '/attachments/gc', {
      token: TEST_TOKEN,
      body: { graceMs: 0, dryRun: true },
    });
    expect(status).toBe(200);
    const result = data as { deleted: string[]; reclaimedBytes: number };
    expect(result.deleted).toContain(fileId);

    const after = await req(t.app, 'GET', `/attachments/${fileId}`, { token: TEST_TOKEN });
    expect(after.status).toBe(200);
  });

  it('honors the grace period, skipping a recently uploaded unreferenced file', async () => {
    const fileId = await putFile(t.ctx);
    const { status, data } = await req(t.app, 'POST', '/attachments/gc', { token: TEST_TOKEN });
    expect(status).toBe(200);
    const result = data as { deleted: string[] };
    expect(result.deleted).not.toContain(fileId);
  });

  it('deletes unreferenced files past the grace period and reclaims their bytes', async () => {
    const fileId = await putFile(t.ctx);
    const { status, data } = await req(t.app, 'POST', '/attachments/gc', {
      token: TEST_TOKEN,
      body: { graceMs: 0 },
    });
    expect(status).toBe(200);
    const result = data as { deleted: string[]; reclaimedBytes: number };
    expect(result.deleted).toContain(fileId);
    expect(result.reclaimedBytes).toBeGreaterThan(0);

    const after = await req(t.app, 'GET', `/attachments/${fileId}`, { token: TEST_TOKEN });
    expect(after.status).toBe(404);
  });

  it('does not delete a file still referenced by a record', async () => {
    const fileId = await putFile(t.ctx);
    await t.ctx.stack.create(
      NOTE_TYPE_ID,
      { body: 'note with attachment' },
      {
        associations: [{ kind: 'attachment', label: 'file', fileId }],
      },
    );
    const { status, data } = await req(t.app, 'POST', '/attachments/gc', {
      token: TEST_TOKEN,
      body: { graceMs: 0 },
    });
    expect(status).toBe(200);
    const result = data as { deleted: string[] };
    expect(result.deleted).not.toContain(fileId);
  });
});
