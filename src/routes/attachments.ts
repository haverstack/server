import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { StackPermissionError, StackPayloadTooLargeError } from '@haverstack/core';
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

/**
 * Parse a filename from an upload's Content-Disposition header. Prefers
 * the RFC 5987 extended form (`filename*=UTF-8''name.txt`), which is what
 * clients that carry non-ASCII names use; falls back to the plain quoted
 * form for everyone else.
 */
function parseUploadFilename(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // Malformed percent-encoding — fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(header);
  return plain ? plain[1] : undefined;
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
