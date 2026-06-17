import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireAuth } from '../middleware/auth.js';

export function attachmentRoutes(ctx: StackContext, maxAttachmentBytes: number): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { adapter, stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  // POST /attachments — upload raw binary, Content-Type = MIME type
  app.post('/', requireAuth(), async (c) => {
    const contentLength = Number(c.req.header('Content-Length') ?? 0);
    if (contentLength > maxAttachmentBytes) {
      return c.json({ error: 'Attachment too large' }, 413);
    }

    const data = new Uint8Array(await c.req.arrayBuffer());
    if (data.byteLength > maxAttachmentBytes) {
      return c.json({ error: 'Attachment too large' }, 413);
    }

    const filename = parseFilename(c.req.header('Content-Disposition'));
    const mimeType = resolveMimeType(
      c.req.header('Content-Type') ?? 'application/octet-stream',
      filename,
    );

    const fileId = await adapter.putAttachment(data, mimeType, filename);
    return c.json({ fileId }, 201);
  });

  // GET /attachments/:fileId — download
  app.get('/:fileId', async (c) => {
    const fileId = c.req.param('fileId');
    const auth = c.get('auth');

    const accessible = await isAttachmentAccessible(fileId, auth?.entityId ?? null, ctx);
    if (!accessible) return c.json({ error: 'Unauthorized' }, 401);

    const meta = await adapter.getAttachmentMeta(fileId);
    if (!meta) return c.json({ error: 'Attachment not found' }, 404);

    let data: Uint8Array;
    try {
      data = await adapter.getAttachment(fileId);
    } catch {
      return c.json({ error: 'Attachment not found' }, 404);
    }

    const headers: Record<string, string> = {
      'Content-Type': meta.mimeType,
      'Content-Length': String(meta.size),
    };
    if (meta.filename) {
      headers['Content-Disposition'] = `attachment; filename="${meta.filename}"`;
    }

    return c.newResponse(data as unknown as Uint8Array<ArrayBuffer>, 200, headers);
  });

  // DELETE /attachments/:fileId
  app.delete('/:fileId', requireAuth(), async (c) => {
    const fileId = c.req.param('fileId');
    const auth = c.get('auth')!;
    if (!ownerEntityId || auth.entityId !== ownerEntityId)
      return c.json({ error: 'Forbidden' }, 403);

    const meta = await adapter.getAttachmentMeta(fileId);
    if (!meta) return c.json({ error: 'Attachment not found' }, 404);

    await adapter.deleteAttachment(fileId);
    return c.body(null, 204);
  });

  return app;
}

function parseFilename(disposition: string | undefined): string | undefined {
  if (!disposition) return undefined;
  const match = disposition.match(/filename="([^"]+)"/);
  return match?.[1];
}

// Map of common file extensions to MIME types. Used to upgrade
// application/octet-stream when the client omits a specific Content-Type
// but provided a filename with a recognisable extension.
const EXTENSION_MIME: Record<string, string> = {
  // Images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  // Documents
  pdf: 'application/pdf',
  // Text
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  // Archives
  zip: 'application/zip',
  gz: 'application/gzip',
};

function resolveMimeType(declared: string, filename: string | undefined): string {
  if (declared !== 'application/octet-stream' || !filename) return declared;
  const ext = filename.split('.').pop()?.toLowerCase();
  return (ext && EXTENSION_MIME[ext]) || declared;
}

/**
 * An attachment is accessible if the requester can read at least one of the
 * Records that reference it (per spec: permissions are governed by the
 * referencing Record(s), not the attachment itself). Owners always pass,
 * even for attachments not yet referenced by any Record (e.g. just uploaded).
 */
async function isAttachmentAccessible(
  fileId: string,
  requesterEntityId: string | null,
  ctx: StackContext,
): Promise<boolean> {
  const { stack } = ctx;
  // Owner bypass: always accessible even if no record references it yet.
  if (requesterEntityId && requesterEntityId === stack.ownerEntityId) return true;

  const result = await stack.asEntity(requesterEntityId).query({
    filter: { attachmentFileId: fileId },
    limit: 1,
  });
  return result.records.length > 0;
}
