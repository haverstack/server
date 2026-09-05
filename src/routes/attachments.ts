import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { StackPermissionError, StackPayloadTooLargeError } from '@haverstack/core';
import {
  resolveAttachmentDownloadContentType,
  firstRecordedAttachment,
  parseUploadFilename,
  NOSNIFF_HEADER_NAME,
  NOSNIFF_HEADER_VALUE,
} from '@haverstack/core/wire';
import { serializeRecord } from '@haverstack/wire-types';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';

export function attachmentRoutes(ctx: StackContext, maxAttachmentBytes: number): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { stack } = ctx;
  const { ownerEntityId } = stack;

  // Aborts while reading the body, the moment the byte count passes the
  // limit — no full-body buffer for an oversized upload, chunked or not.
  const attachmentBodyLimit = bodyLimit({
    maxSize: maxAttachmentBytes,
    onError: () => {
      throw new StackPayloadTooLargeError(
        `Attachment exceeds the ${maxAttachmentBytes}-byte limit`,
      );
    },
  });

  // POST /attachments — stores the bytes and creates the _attachment@1
  // metadata record in the same request, returning that record. Routed
  // through ScopedStack.putAttachment() so the create-grant check on
  // _attachment@1 runs before a single byte is written: an authenticated
  // requester with no grant is refused, not merely denied a metadata
  // record afterward. See docs/spec/wire-format.md § Upload.
  app.post('/', attachmentBodyLimit, requireAuth(), async (c) => {
    const auth = c.get('auth')!;
    const mimeType = c.req.header('Content-Type') || 'application/octet-stream';
    const filename = parseUploadFilename(c.req.header('Content-Disposition'));
    const appId = c.req.query('appId') || undefined;

    const data = new Uint8Array(await c.req.arrayBuffer());
    const record = await stack.forSession(auth).putAttachment(data, mimeType, filename, appId);
    return c.json(serializeRecord(record), 200);
  });

  // GET /attachments/:fileId — download
  app.get('/:fileId', async (c) => {
    const fileId = c.req.param('fileId');
    const auth = c.get('auth');

    let data: Uint8Array;
    try {
      data = await (auth ? stack.forSession(auth) : stack.asEntity(null)).getAttachment(fileId);
    } catch (e) {
      // Anonymous and denied is a transport-auth failure, distinct from an
      // authenticated requester lacking access; everything else belongs to
      // errorMiddleware. ScopedStack.getAttachment() already throws alike
      // for missing and forbidden, so this handler owes no anti-oracle
      // logic of its own — only to leave that answer intact.
      if (!auth && e instanceof StackPermissionError) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      throw e;
    }

    const metaRecords = await stack.getAttachmentRecords(fileId);
    const firstRecord = firstRecordedAttachment(metaRecords);
    const ownRecord = auth
      ? firstRecordedAttachment(metaRecords.filter((r) => r.entityId === auth.subjectId))
      : undefined;

    const contentTypeParam = c.req.query('contentType');
    const filenameParam = c.req.query('filename');

    const { contentType, forced } = resolveAttachmentDownloadContentType({
      contentTypeParam,
      filenameParam,
      storedMimeType: firstRecord?.content.mimeType,
    });
    // When the dangerous-type policy overrides the candidate, the filename
    // goes too: forcing Content-Type alone won't stop a browser sniffing
    // the body back into the original type without both nosniff and a
    // non-inline disposition.
    const filename = forced
      ? undefined
      : (filenameParam ?? ownRecord?.content.filename ?? firstRecord?.content.filename);

    const disposition = filename
      ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
      : 'attachment';

    return c.newResponse(data as unknown as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': contentType,
      'Content-Length': String(data.byteLength),
      'Content-Disposition': disposition,
      [NOSNIFF_HEADER_NAME]: NOSNIFF_HEADER_VALUE,
    });
  });

  // DELETE /attachments/:fileId
  app.delete('/:fileId', requireOwner(ownerEntityId), async (c) => {
    const fileId = c.req.param('fileId');
    await stack.deleteAttachment(fileId);
    return c.body(null, 204);
  });

  // POST /attachments/gc — sweep and delete orphaned attachment bytes.
  // Owner-only, invoke-only (no built-in scheduling): dryRun makes a
  // cron-from-outside workflow safe. Body is entirely optional — every
  // field defaults inside ScopedStack.collectAttachmentGarbage().
  app.post('/gc', requireOwner(ownerEntityId), async (c) => {
    const auth = c.get('auth')!;
    const raw = await c.req.text();
    const body = raw ? (JSON.parse(raw) as { graceMs?: number; dryRun?: boolean }) : {};
    const result = await stack.forSession(auth).collectAttachmentGarbage({
      ...(typeof body.graceMs === 'number' && { graceMs: body.graceMs }),
      ...(body.dryRun === true && { dryRun: true }),
    });
    return c.json(result, 200);
  });

  return app;
}
