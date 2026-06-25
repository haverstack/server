import { Hono } from 'hono';
import { StackPermissionError } from '@haverstack/core';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';

export function attachmentRoutes(ctx: StackContext, maxAttachmentBytes: number): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { adapter, stack } = ctx;
  const { ownerEntityId } = stack;

  // POST /attachments — upload raw binary; stores bytes only.
  // Callers should follow up with POST /records to create the _attachment@1
  // metadata record (mimeType, size, filename). The SDK's ScopedStack.putAttachment()
  // does this automatically.
  app.post('/', requireAuth(), async (c) => {
    const contentLength = Number(c.req.header('Content-Length') ?? 0);
    if (contentLength > maxAttachmentBytes) {
      return c.json({ error: 'Attachment too large' }, 413);
    }

    const data = new Uint8Array(await c.req.arrayBuffer());
    if (data.byteLength > maxAttachmentBytes) {
      return c.json({ error: 'Attachment too large' }, 413);
    }

    const fileId = await adapter.putAttachment(data);
    return c.json({ fileId }, 201);
  });

  // GET /attachments/:fileId — download
  app.get('/:fileId', async (c) => {
    const fileId = c.req.param('fileId');
    const auth = c.get('auth');

    let data: Uint8Array;
    try {
      data = await stack.asEntity(auth?.entityId ?? null).getAttachment(fileId);
    } catch (e) {
      if (e instanceof StackPermissionError) return c.json({ error: 'Unauthorized' }, 401);
      return c.json({ error: 'Attachment not found' }, 404);
    }

    const contentTypeParam = c.req.query('contentType');
    const filenameParam = c.req.query('filename');

    const disposition = filenameParam
      ? `attachment; filename*=UTF-8''${encodeURIComponent(filenameParam)}`
      : 'attachment';

    return c.newResponse(data as unknown as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': sanitizeMimeType(
        contentTypeParam ?? resolveMimeType('application/octet-stream', filenameParam),
      ),
      'Content-Length': String(data.byteLength),
      'Content-Disposition': disposition,
      'X-Content-Type-Options': 'nosniff',
    });
  });

  // DELETE /attachments/:fileId
  app.delete('/:fileId', requireOwner(ownerEntityId), async (c) => {
    const fileId = c.req.param('fileId');
    await stack.deleteAttachment(fileId);
    return c.body(null, 204);
  });

  return app;
}

// MIME types that browsers can use to execute scripts or parse as markup.
// Callers requesting one of these as Content-Type receive application/octet-stream instead.
const BLOCKED_MIME_TYPES = new Set([
  'text/html',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
]);

function sanitizeMimeType(mimeType: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return BLOCKED_MIME_TYPES.has(base) ? 'application/octet-stream' : mimeType;
}

// Extension-to-MIME map used to infer Content-Type from a ?filename param.
// Omits types in BLOCKED_MIME_TYPES — they would be sanitized away regardless.
const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  zip: 'application/zip',
  gz: 'application/gzip',
};

function resolveMimeType(declared: string, filename: string | undefined): string {
  if (declared !== 'application/octet-stream' || !filename) return declared;
  const ext = filename.split('.').pop()?.toLowerCase();
  return (ext && EXTENSION_MIME[ext]) || declared;
}
